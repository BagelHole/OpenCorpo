/**
 * Tool execution request - handles policy, approvals, and execution.
 * Used by both HTTP API and agent.
 */
import type { DbHandle } from "../db";
import { writeAudit } from "../audit";
import { writeEvent } from "../events";
import { createApproval } from "../approvals";
import { evaluatePolicy } from "../policy";
import { executeTool } from "../tool-runner";
import type { ToolDefinition } from "../tools";
import type { ToolRegistry } from "../tool-registry";
import { findTool } from "../tools";
import { validateToolInput } from "../tool-registry";
import type { PolicyFile } from "../policy";

export type ToolRequestContext = {
  actor: string;
  skipApproval?: boolean; // For agent: when we create approval, we skip execution
};

export type ToolRequestResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; approvalId?: number };

export function requestToolExecution(
  db: DbHandle,
  toolName: string,
  input: Record<string, unknown> | null,
  context: ToolRequestContext,
  toolRegistry: ToolRegistry,
  policy: PolicyFile | null
): Promise<ToolRequestResult> {
  const tool = findTool(toolRegistry.definitions, toolName);
  if (!tool) {
    return Promise.resolve({ ok: false, error: "tool_not_found" });
  }

  const validation = validateToolInput(toolRegistry, toolName, input);
  if (!validation.valid) {
    writeAudit(db, {
      actor: context.actor,
      action: "tool_input_invalid",
      tool: toolName,
      metadata: { errors: validation.errors }
    });
    return Promise.resolve({
      ok: false,
      error: "invalid_input",
      details: validation.errors
    } as ToolRequestResult);
  }

  const policyResult = evaluatePolicy(policy, {
    risk: tool.risk,
    tool: toolName,
    action: "invoke",
    actor: context.actor
  });

  if (policyResult.decision === "deny") {
    writeAudit(db, {
      actor: "policy",
      action: "tool_denied",
      tool: toolName,
      policy: policyResult.ruleId,
      metadata: { reason: policyResult.reason }
    });
    return Promise.resolve({
      ok: false,
      error: policyResult.reason ?? "policy_denied"
    });
  }

  const needsApproval =
    policyResult.decision === "approve" || tool.risk === "high";

  if (needsApproval && !context.skipApproval) {
    const approvalId = createApproval(db, {
      requestedBy: context.actor,
      tool: toolName,
      action: "invoke",
      reason: policyResult.reason ?? "High-risk tool requires approval.",
      metadata: { input: input ?? null }
    });
    writeAudit(db, {
      actor: context.actor,
      action: "tool_approval_requested",
      tool: toolName,
      metadata: { approvalId }
    });
    writeEvent(db, { type: "tool.approval.requested", data: { approvalId } });
    return Promise.resolve({
      ok: false,
      error: "approval_required",
      approvalId
    });
  }

  return executeTool(
    db,
    {
      tool,
      input: input ?? {},
      context: {
        actor: context.actor
      }
    },
    toolRegistry
  ).then((r) =>
    r.ok ? { ok: true as const, result: r.result } : { ok: false as const, error: r.error }
  );
}
