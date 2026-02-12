import type { DbHandle } from "./db";
import { writeAudit } from "./audit";
import { writeEvent } from "./events";
import type { ToolDefinition } from "./tools";
import type { ToolExecutionContext, ToolHandler } from "./tool-types";
import { createToolRun, updateToolRun } from "./tool-runs";
import type { ToolRegistry } from "./tool-registry";
import { validateToolOutput } from "./tool-registry";

export type ToolInvocation = {
  tool: ToolDefinition;
  input: Record<string, unknown> | null;
  approvalId?: number;
  context: ToolExecutionContext;
};

export async function executeTool(
  db: DbHandle,
  invocation: ToolInvocation,
  registry: ToolRegistry
) {
  const toolRunId = createToolRun(db, {
    tool: invocation.tool.name,
    actor: invocation.context.actor,
    status: "running",
    approvalId: invocation.approvalId,
    jobId: invocation.context.jobId,
    jobRunId: invocation.context.jobRunId,
    input: invocation.input ?? null
  });
  writeEvent(db, {
    type: "tool.run.started",
    data: { tool: invocation.tool.name, toolRunId }
  });
  const handler = registry.handlers.get(invocation.tool.name);
  if (!handler) {
    updateToolRun(db, toolRunId, "failed", null, "handler_missing");
    writeEvent(db, {
      type: "tool.run.failed",
      data: { tool: invocation.tool.name, toolRunId, error: "handler_missing" }
    });
    writeAudit(db, {
      actor: "system",
      action: "tool_handler_missing",
      tool: invocation.tool.name,
      metadata: { approvalId: invocation.approvalId ?? null }
    });
    writeEvent(db, {
      type: "tool.handler.missing",
      data: { tool: invocation.tool.name, approvalId: invocation.approvalId ?? null }
    });
    return { ok: false, error: "handler_missing" } as const;
  }

  try {
    const result = await handler.run(invocation.input ?? {}, invocation.context);
    const outputValidation = validateToolOutput(
      registry,
      invocation.tool.name,
      result as Record<string, unknown>
    );
    if (!outputValidation.valid) {
      updateToolRun(db, toolRunId, "failed", result as Record<string, unknown>, "invalid_output");
      writeAudit(db, {
        actor: "system",
        action: "tool_output_invalid",
        tool: invocation.tool.name,
        metadata: { errors: outputValidation.errors }
      });
      writeEvent(db, {
        type: "tool.output.invalid",
        data: { tool: invocation.tool.name, errors: outputValidation.errors }
      });
      writeEvent(db, {
        type: "tool.run.failed",
        data: { tool: invocation.tool.name, toolRunId, error: "invalid_output" }
      });
      return { ok: false, error: "invalid_output", details: outputValidation.errors } as const;
    }
    updateToolRun(db, toolRunId, "completed", result as Record<string, unknown>, null);
    writeEvent(db, {
      type: "tool.run.completed",
      data: { tool: invocation.tool.name, toolRunId }
    });
    writeAudit(db, {
      actor: "system",
      action: "tool_executed",
      tool: invocation.tool.name,
      metadata: { approvalId: invocation.approvalId ?? null }
    });
    writeEvent(db, {
      type: "tool.executed",
      data: { tool: invocation.tool.name, approvalId: invocation.approvalId ?? null }
    });
    return { ok: true, result } as const;
  } catch (error) {
    updateToolRun(
      db,
      toolRunId,
      "failed",
      null,
      error instanceof Error ? error.message : "unknown"
    );
    writeEvent(db, {
      type: "tool.run.failed",
      data: {
        tool: invocation.tool.name,
        toolRunId,
        error: error instanceof Error ? error.message : "unknown"
      }
    });
    writeAudit(db, {
      actor: "system",
      action: "tool_failed",
      tool: invocation.tool.name,
      metadata: {
        approvalId: invocation.approvalId ?? null,
        error: error instanceof Error ? error.message : "unknown"
      }
    });
    writeEvent(db, {
      type: "tool.failed",
      data: { tool: invocation.tool.name }
    });
    return { ok: false, error: "execution_failed" } as const;
  }
}
