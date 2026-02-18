import type { DbHandle } from "./db";
import { getAuditById, listAudit, writeAudit } from "./audit";
import {
  createApproval,
  getApprovalById,
  listApprovals,
  updateApprovalStatus
} from "./approvals";
import { writeEvent } from "./events";
import { getJobRunById, listJobRuns } from "./job-runner";
import {
  getJobById,
  listJobs,
  recordJobRun,
  setJobEnabled,
  summarizeSchedule
} from "./jobs";
import { getToolRunById, listToolRuns } from "./tool-runs";
import type { ToolDefinition } from "./tools";
import {
  applyControlPlaneChange,
  proposeControlPlaneChange
} from "./control-plane-changes";
import {
  attachCodeChangeApproval,
  proposeCodeChange
} from "./code-change-proposals";

export type AgentReply = {
  text: string;
  metadata?: Record<string, unknown>;
};

export type AgentToolEvent = {
  phase: "started" | "completed" | "failed";
  tool: string;
  at: string;
  requestId?: string;
  sessionId?: number;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
};

export type PluginSummary = {
  name: string;
  version: string;
  loaded: boolean;
  error?: string | null;
};

export type AgentContext = {
  db: DbHandle;
  tools: ToolDefinition[];
  plugins: PluginSummary[];
  controlPlaneRoot: string;
  workspaceRoot: string;
  /** Chat session id for tool execution telemetry. */
  chatSessionId?: number;
  /** Client-provided request id for correlating tool execution telemetry. */
  chatRequestId?: string;
  /** Optional callback for tool execution events emitted while the LLM runs. */
  onAgentToolEvent?: (event: AgentToolEvent) => void;
  /** Tool names that have plugin handlers (for list_available_handlers) */
  handlerNames?: string[];
  /** Called after control-plane changes are applied so runtime caches are refreshed. */
  onControlPlaneChanged?: () => Promise<void>;
  /** Execute a registered runtime tool by name with full policy/approval enforcement. */
  invokeRuntimeTool?: (
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<
    | { ok: true; result: unknown }
    | { ok: false; error: string; approvalRequired?: boolean; approvalId?: number }
  >;
};

const LIST_LIMIT = 8;

export async function runAgent(
  prompt: string,
  context: AgentContext
): Promise<AgentReply> {
  const trimmed = prompt.trim();
  if (!trimmed) return { text: "Tell me what you want done." };

  const plan = buildPlan(trimmed);
  const stepOutput: string[] = [];
  for (const step of plan.steps) {
    const result = await executePlanStep(step, trimmed, context);
    stepOutput.push(result.text);
    if (result.stop) {
      return {
        text: result.text,
        metadata: {
          planner: plan,
          step
        }
      };
    }
  }

  return {
    text: stepOutput.filter(Boolean).join("\n\n"),
    metadata: {
      planner: plan
    }
  };
}

type PlanStep =
  | "help"
  | "status"
  | "approvals"
  | "jobs"
  | "audit"
  | "tools"
  | "plugins"
  | "detail"
  | "approval_action"
  | "job_action"
  | "self_edit_config"
  | "self_edit_code";

type AgentPlan = {
  intent: string;
  confidence: "low" | "medium" | "high";
  steps: PlanStep[];
};

function buildPlan(prompt: string): AgentPlan {
  const normalized = prompt.toLowerCase();
  if (matchesAny(normalized, ["help", "what can you do", "commands"])) {
    return { intent: "help", confidence: "high", steps: ["help"] };
  }

  if (matchesAny(normalized, ["self-edit config", "control plane change", "update control plane"])) {
    return {
      intent: "self_edit_config",
      confidence: "high",
      steps: ["self_edit_config", "status"]
    };
  }

  if (matchesAny(normalized, ["self-edit code", "workspace patch", "change code file"])) {
    return {
      intent: "self_edit_code",
      confidence: "high",
      steps: ["self_edit_code", "status"]
    };
  }

  if (matchId(normalized, /\bapprove\s+#?(\d+)\b/) !== null || matchId(normalized, /\bdeny\s+#?(\d+)\b/) !== null) {
    return { intent: "approval_action", confidence: "high", steps: ["approval_action"] };
  }

  if (matchesAny(normalized, ["run job", "enable job", "disable job"])) {
    return { intent: "job_action", confidence: "high", steps: ["job_action"] };
  }

  if (matchesAny(normalized, ["approval #", "job #", "job run #", "audit #", "tool run #", "tool "])) {
    return { intent: "detail", confidence: "medium", steps: ["detail"] };
  }

  if (matchesAny(normalized, ["approvals", "approval queue"])) {
    return { intent: "approvals", confidence: "high", steps: ["approvals"] };
  }
  if (matchesAny(normalized, ["jobs", "job queue", "job runs"])) {
    return { intent: "jobs", confidence: "high", steps: ["jobs"] };
  }
  if (matchesAny(normalized, ["audit", "audit log"])) {
    return { intent: "audit", confidence: "high", steps: ["audit"] };
  }
  if (matchesAny(normalized, ["tools", "capabilities"])) {
    return { intent: "tools", confidence: "high", steps: ["tools"] };
  }
  if (matchesAny(normalized, ["plugins", "integrations", "connectors"])) {
    return { intent: "plugins", confidence: "high", steps: ["plugins"] };
  }
  return { intent: "status", confidence: "low", steps: ["status"] };
}

function matchesAny(text: string, tokens: string[]) {
  return tokens.some((token) => text.includes(token));
}

export function buildHelpText() {
  return [
    "Try asking in plain language:",
    "- \"show me pending approvals\"",
    "- \"run job 3 now\"",
    "- \"summarize recent audit entries\"",
    "- \"what connectors are active\"",
    "- \"self-edit config file jobs/heartbeat.job.json with { ...json... }\"",
    "- \"self-edit code file notes.ts with ```...```\""
  ].join("\n");
}

export function buildStatusSummary(context: AgentContext) {
  const approvals = listApprovals(context.db, 200);
  const pendingApprovals = approvals.filter((item) => item.status === "pending");
  const jobs = listJobs(context.db, 200);
  const enabledJobs = jobs.filter((job) => job.enabled === 1);
  const runs = listJobRuns(context.db, 10);
  const latestRun = runs[0];
  const audit = listAudit(context.db, 5);
  const tools = context.tools.length;
  const plugins = context.plugins.length;

  const lines = [
    "Local data snapshot:",
    `- Pending approvals: ${pendingApprovals.length}`,
    `- Jobs: ${jobs.length} (${enabledJobs.length} enabled)`,
    `- Recent job runs: ${runs.length}${
      latestRun ? ` (latest #${latestRun.id} ${latestRun.status})` : ""
    }`,
    `- Tools loaded: ${tools}`,
    `- Plugins loaded: ${plugins}`
  ];

  if (audit.length > 0) {
    lines.push(`- Latest audit: #${audit[0].id} ${audit[0].action}`);
  }

  return lines.join("\n");
}

export function buildApprovalsList(db: DbHandle, pendingOnly: boolean) {
  const approvals = listApprovals(db, 100);
  const filtered = pendingOnly
    ? approvals.filter((item) => item.status === "pending")
    : approvals;

  if (filtered.length === 0) {
    return pendingOnly
      ? "No pending approvals."
      : "No approvals yet. Try again once tools request approval.";
  }

  const lines = filtered.slice(0, LIST_LIMIT).map((item) => {
    const reason = item.reason ? ` • ${item.reason}` : "";
    return `- #${item.id} ${item.tool ?? "unknown"} (${item.status})${reason}`;
  });

  return [
    `${pendingOnly ? "Pending approvals" : "Approvals"} (${filtered.length}):`,
    ...lines,
    "Say \"approve <id>\" or \"deny <id>\" to act."
  ].join("\n");
}

export function buildJobsList(db: DbHandle) {
  const jobs = listJobs(db, 100);
  if (jobs.length === 0) {
    return "No jobs yet. Create one in the control plane to get started.";
  }

  const lines = jobs.slice(0, LIST_LIMIT).map((job) => {
    const schedule = summarizeSchedule(job.schedule ?? null);
    return `- #${job.id} ${job.name} (${job.enabled ? "enabled" : "disabled"}) • ${schedule}`;
  });

  return [`Jobs (${jobs.length}):`, ...lines, "Say \"run job <id>\" to queue a run."].join(
    "\n"
  );
}

export function buildJobRunsList(db: DbHandle) {
  const runs = listJobRuns(db, 10);
  if (runs.length === 0) {
    return "No job runs yet.";
  }
  const lines = runs.slice(0, LIST_LIMIT).map((run) => {
    return `- Run #${run.id} for job #${run.job_id} (${run.status})`;
  });
  return [`Recent job runs:`, ...lines].join("\n");
}

export function buildAuditList(db: DbHandle) {
  const audit = listAudit(db, 10);
  if (audit.length === 0) {
    return "No audit entries yet.";
  }
  const lines = audit.slice(0, LIST_LIMIT).map((entry) => {
    return `- #${entry.id} ${entry.action} by ${entry.actor}`;
  });
  return ["Latest audit entries:", ...lines].join("\n");
}

function buildToolRunsList(db: DbHandle) {
  const runs = listToolRuns(db, 10);
  if (runs.length === 0) {
    return "No tool runs yet.";
  }
  const lines = runs.slice(0, LIST_LIMIT).map((run) => {
    return `- #${run.id} ${run.tool} (${run.status})`;
  });
  return ["Latest tool runs:", ...lines].join("\n");
}

export function buildToolsList(tools: ToolDefinition[]) {
  if (tools.length === 0) {
    return "No tools registered yet.";
  }
  const lines = tools.slice(0, LIST_LIMIT).map((tool) => {
    return `- ${tool.name} (${tool.risk}) • ${tool.capabilities.join(", ") || "no caps"}`;
  });
  return ["Tools loaded:", ...lines, "Say \"tool <name>\" for a specific tool."].join("\n");
}

export function handleToolDetail(tools: ToolDefinition[], name: string) {
  const tool = tools.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!tool) {
    return { text: `Tool "${name}" not found.` };
  }
  const inputSchema = tool.inputs && typeof tool.inputs === "object" ? tool.inputs : null;
  const outputSchema = tool.outputs && typeof tool.outputs === "object" ? tool.outputs : null;
  const inputProps =
    inputSchema && typeof (inputSchema as { properties?: unknown }).properties === "object"
      ? Object.keys((inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
      : [];
  const outputProps =
    outputSchema && typeof (outputSchema as { properties?: unknown }).properties === "object"
      ? Object.keys((outputSchema as { properties?: Record<string, unknown> }).properties ?? {})
      : [];
  const requiredInputs =
    inputSchema && Array.isArray((inputSchema as { required?: unknown }).required)
      ? ((inputSchema as { required?: string[] }).required ?? [])
      : [];
  const lines = [
    `Tool ${tool.name}`,
    `- Version: ${tool.version}`,
    `- Risk: ${tool.risk}`,
    `- Capabilities: ${tool.capabilities.join(", ") || "none"}`
  ];
  if (inputProps.length > 0) {
    lines.push(`- Inputs: ${inputProps.join(", ")}`);
  }
  if (requiredInputs.length > 0) {
    lines.push(`- Required: ${requiredInputs.join(", ")}`);
  }
  if (outputProps.length > 0) {
    lines.push(`- Outputs: ${outputProps.join(", ")}`);
  }
  return { text: lines.join("\n") };
}

export function buildPluginsList(plugins: PluginSummary[]) {
  if (plugins.length === 0) {
    return "No plugins loaded yet.";
  }
  const lines = plugins.map((plugin) => {
    const status = plugin.loaded ? "connected" : "error";
    const error = plugin.error ? ` • ${plugin.error}` : "";
    return `- ${plugin.name} v${plugin.version} (${status})${error}`;
  });
  return ["Plugins:", ...lines].join("\n");
}

export function buildDataSourceHint(plugins: PluginSummary[], tools: ToolDefinition[]) {
  const toolNames = tools.map((tool) => tool.name);
  const lines = [
    "Data sources are powered by plugins and tools."
  ];
  const mcpTools = toolNames.filter((name) => name.startsWith("mcp."));
  if (mcpTools.length > 0) {
    lines.push(`- MCP tools available: ${mcpTools.slice(0, 10).join(", ")}`);
  }
  lines.push("Say \"plugins\" or \"tools\" to see what is loaded.");
  return lines.join("\n");
}

export function handleApprovalAction(db: DbHandle, id: number, status: "approved" | "denied") {
  const approval = getApprovalById(db, id);
  if (!approval) {
    return { text: `Approval #${id} not found.` };
  }
  if (approval.status !== "pending") {
    return { text: `Approval #${id} is already ${approval.status}.` };
  }

  const ok = updateApprovalStatus(db, id, status);
  if (!ok) {
    return { text: `Failed to update approval #${id}.` };
  }

  writeAudit(db, {
    actor: "user",
    action: status === "approved" ? "approval_approved" : "approval_denied",
    metadata: { id }
  });
  writeEvent(db, { type: `approval.${status}`, data: { id } });

  return {
    text: `Approval #${id} ${status}.`
  };
}

export function handleApprovalDetail(db: DbHandle, id: number) {
  const approval = getApprovalById(db, id);
  if (!approval) {
    return { text: `Approval #${id} not found.` };
  }
  const lines = [
    `Approval #${approval.id}`,
    `- Status: ${approval.status}`,
    `- Tool: ${approval.tool ?? "unknown"}`,
    `- Reason: ${approval.reason ?? "none"}`
  ];
  return { text: lines.join("\n") };
}

export function handleJobDetail(db: DbHandle, id: number) {
  const job = getJobById(db, id);
  if (!job) {
    return { text: `Job #${id} not found.` };
  }
  const schedule = summarizeSchedule(job.schedule ?? null);
  const lines = [
    `Job #${job.id} — ${job.name}`,
    `- Enabled: ${job.enabled ? "yes" : "no"}`,
    `- Schedule: ${schedule}`,
    `- Capabilities: ${Array.isArray(job.capabilities) ? job.capabilities.join(", ") : "none"}`
  ];
  return { text: lines.join("\n") };
}

export function handleJobRun(db: DbHandle, id: number) {
  const job = getJobById(db, id);
  if (!job) {
    return { text: `Job #${id} not found.` };
  }
  const runId = recordJobRun(db, job.id, "queued");
  writeAudit(db, {
    actor: "agent",
    action: "job_run_requested",
    metadata: { jobId: job.id, jobRunId: runId }
  });
  writeEvent(db, { type: "job.run.queued", data: { jobId: job.id, jobRunId: runId } });
  return { text: `Queued job #${job.id} (${job.name}) as run #${runId}.` };
}

export function handleJobRunByName(db: DbHandle, name: string) {
  const jobs = listJobs(db, 200);
  const match = jobs.find((job) => job.name.toLowerCase() === name.toLowerCase());
  if (!match) {
    return { text: `No job named "${name}" found.` };
  }
  return handleJobRun(db, match.id);
}

export function handleJobToggle(db: DbHandle, id: number, enabled: boolean) {
  const job = getJobById(db, id);
  if (!job) {
    return { text: `Job #${id} not found.` };
  }
  const ok = setJobEnabled(db, id, enabled);
  if (!ok) {
    return { text: `Failed to update job #${id}.` };
  }
  writeAudit(db, {
    actor: "user",
    action: enabled ? "job_enabled" : "job_disabled",
    metadata: { jobId: id }
  });
  writeEvent(db, { type: enabled ? "job.enabled" : "job.disabled", data: { jobId: id } });
  return {
    text: `Job #${id} ${enabled ? "enabled" : "disabled"}.`
  };
}

export function handleJobRunDetail(db: DbHandle, id: number) {
  const run = getJobRunById(db, id);
  if (!run) {
    return { text: `Job run #${id} not found.` };
  }
  const lines = [
    `Job run #${run.id}`,
    `- Job: #${run.job_id}`,
    `- Status: ${run.status}`,
    `- Started: ${run.ts}`
  ];
  if (run.error) {
    lines.push(`- Error: ${run.error}`);
  }
  return { text: lines.join("\n") };
}

export function handleAuditDetail(db: DbHandle, id: number) {
  const entry = getAuditById(db, id);
  if (!entry) {
    return { text: `Audit entry #${id} not found.` };
  }
  const lines = [
    `Audit #${entry.id}`,
    `- Action: ${entry.action}`,
    `- Actor: ${entry.actor}`,
    `- Tool: ${entry.tool ?? "none"}`,
    `- Timestamp: ${entry.ts}`
  ];
  return { text: lines.join("\n") };
}

export function handleToolRunDetail(db: DbHandle, id: number) {
  const run = getToolRunById(db, id);
  if (!run) {
    return { text: `Tool run #${id} not found.` };
  }
  const lines = [
    `Tool run #${run.id}`,
    `- Tool: ${run.tool}`,
    `- Status: ${run.status}`,
    `- Actor: ${run.actor}`,
    `- Timestamp: ${run.ts}`
  ];
  if (run.error) {
    lines.push(`- Error: ${run.error}`);
  }
  return { text: lines.join("\n") };
}

function extractJsonBlock(prompt: string) {
  const block = prompt.match(/```json\s*([\s\S]*?)```/i);
  if (block) {
    try {
      return JSON.parse(block[1]);
    } catch {
      return null;
    }
  }
  const fallback = prompt.match(/\{[\s\S]*\}/);
  if (!fallback) return null;
  try {
    return JSON.parse(fallback[0]);
  } catch {
    return null;
  }
}

function extractCodeBlock(prompt: string) {
  const block = prompt.match(/```(?:[a-zA-Z0-9]+)?\s*([\s\S]*?)```/);
  return block ? block[1] : null;
}

function extractPath(prompt: string) {
  const fileMatch = prompt.match(/\bfile\s+([a-zA-Z0-9_./-]+\.json)\b/i);
  if (fileMatch) return fileMatch[1];
  const fallback = prompt.match(/\b([a-zA-Z0-9_./-]+\.json)\b/);
  return fallback ? fallback[1] : null;
}

function extractWorkspacePath(prompt: string) {
  const fileMatch = prompt.match(/\bfile\s+([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)\b/i);
  if (fileMatch) return fileMatch[1];
  const fallback = prompt.match(/\b([a-zA-Z0-9_./-]+\.(ts|tsx|js|jsx|json|md|txt))\b/);
  return fallback ? fallback[1] : null;
}

function matchId(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

async function executePlanStep(
  step: PlanStep,
  prompt: string,
  context: AgentContext
): Promise<{ text: string; stop?: boolean }> {
  const normalized = prompt.toLowerCase();

  if (step === "help") return { text: buildHelpText(), stop: true };
  if (step === "status") return { text: buildStatusSummary(context) };
  if (step === "approvals")
    return { text: buildApprovalsList(context.db, normalized.includes("pending")) };
  if (step === "jobs") {
    if (normalized.includes("job run")) {
      return { text: buildJobRunsList(context.db) };
    }
    return { text: buildJobsList(context.db) };
  }
  if (step === "audit") return { text: buildAuditList(context.db) };
  if (step === "tools") return { text: buildToolsList(context.tools) };
  if (step === "plugins") {
    if (matchesAny(normalized, ["connectors", "integrations", "mcp"])) {
      return { text: buildDataSourceHint(context.plugins, context.tools) };
    }
    return { text: buildPluginsList(context.plugins) };
  }

  if (step === "approval_action") {
    const approvalAction = matchId(normalized, /\bapprove\s+#?(\d+)\b/);
    if (approvalAction !== null) {
      return { text: handleApprovalAction(context.db, approvalAction, "approved").text, stop: true };
    }
    const denialAction = matchId(normalized, /\bdeny\s+#?(\d+)\b/);
    if (denialAction !== null) {
      return { text: handleApprovalAction(context.db, denialAction, "denied").text, stop: true };
    }
    return { text: "I could not find an approval id in your request.", stop: true };
  }

  if (step === "job_action") {
    const runId = matchId(normalized, /\brun\s+job\s+#?(\d+)\b/);
    if (runId !== null) return { text: handleJobRun(context.db, runId).text, stop: true };
    const enableId = matchId(normalized, /\benable\s+job\s+#?(\d+)\b/);
    if (enableId !== null) return { text: handleJobToggle(context.db, enableId, true).text, stop: true };
    const disableId = matchId(normalized, /\bdisable\s+job\s+#?(\d+)\b/);
    if (disableId !== null) return { text: handleJobToggle(context.db, disableId, false).text, stop: true };
    const runByName = prompt.match(/\brun\s+job\s+(.+)/i);
    if (runByName) return { text: handleJobRunByName(context.db, runByName[1].trim()).text, stop: true };
    return { text: "I could not determine which job to run or toggle.", stop: true };
  }

  if (step === "detail") {
    const approvalId = matchId(normalized, /\bapproval\s+#?(\d+)\b/);
    if (approvalId !== null) return { text: handleApprovalDetail(context.db, approvalId).text, stop: true };
    const jobRunId = matchId(normalized, /\bjob\s+run\s+#?(\d+)\b/);
    if (jobRunId !== null) return { text: handleJobRunDetail(context.db, jobRunId).text, stop: true };
    const jobId = matchId(normalized, /\bjob\s+#?(\d+)\b/);
    if (jobId !== null && !normalized.includes("run job")) {
      return { text: handleJobDetail(context.db, jobId).text, stop: true };
    }
    const auditId = matchId(normalized, /\baudit\s+#?(\d+)\b/);
    if (auditId !== null) return { text: handleAuditDetail(context.db, auditId).text, stop: true };
    const toolRunId = matchId(normalized, /\btool\s+run\s+#?(\d+)\b/);
    if (toolRunId !== null) return { text: handleToolRunDetail(context.db, toolRunId).text, stop: true };
    const toolDetailMatch = normalized.match(/\btool\s+([a-z0-9_.-]+)\b/);
    if (toolDetailMatch) return { text: handleToolDetail(context.tools, toolDetailMatch[1]).text, stop: true };
    return { text: "I could not find a matching detail target.", stop: true };
  }

  if (step === "self_edit_config") {
    const relativePath = extractPath(prompt);
    const payload = extractJsonBlock(prompt);
    if (!relativePath || !payload) {
      return {
        text:
          "To self-edit config, include a target JSON file and JSON body. Example: self-edit config file jobs/heartbeat.job.json with ```json ... ```",
        stop: true
      };
    }
    const proposed = proposeControlPlaneChange(context.db, context.controlPlaneRoot, {
      actor: "agent",
      relativePath,
      afterJson: payload
    });
    if (!proposed.ok) {
      return { text: `Config change rejected: ${proposed.details.join("; ")}`, stop: true };
    }

    const isHighRisk = proposed.risk === "high";
    if (isHighRisk) {
      const approvalId = createApproval(context.db, {
        requestedBy: "agent",
        tool: "control-plane.change",
        action: "apply",
        reason: `High-risk Control Plane change for ${relativePath}`,
        metadata: { changeId: proposed.id }
      });
      writeAudit(context.db, {
        actor: "agent",
        action: "control_plane_change_proposed",
        metadata: { changeId: proposed.id, approvalId: approvalId, path: relativePath }
      });
      return {
        text: `Proposed control-plane change #${proposed.id} for ${relativePath}. Approval #${approvalId} is required before apply.`,
        stop: true
      };
    }

    const applied = applyControlPlaneChange(context.db, context.controlPlaneRoot, proposed.id);
    if (applied.ok && context.onControlPlaneChanged) {
      await context.onControlPlaneChanged();
    }
    writeAudit(context.db, {
      actor: "agent",
      action: applied.ok ? "control_plane_change_applied" : "control_plane_change_failed",
      metadata: { changeId: proposed.id, path: relativePath }
    });
    return {
      text: applied.ok
        ? `Applied control-plane change #${proposed.id} (${relativePath}).`
        : `Change #${proposed.id} was proposed but not applied: ${applied.error}.`,
      stop: true
    };
  }

  if (step === "self_edit_code") {
    const workspacePath = extractWorkspacePath(prompt);
    const content = extractCodeBlock(prompt);
    if (!workspacePath || content === null) {
      return {
        text:
          "To self-edit code, include a workspace file path and a fenced code block with new content.",
        stop: true
      };
    }
    const proposal = proposeCodeChange(context.db, context.workspaceRoot, {
      actor: "agent",
      targetPath: workspacePath,
      afterContent: content,
      reason: "Agent requested workspace change."
    });
    const approvalId = createApproval(context.db, {
      requestedBy: "agent",
      tool: "workspace.patch",
      action: "apply",
      reason: `Tier B code change requires approval (${workspacePath}).`,
      metadata: { codeChangeProposalId: proposal.id, targetPath: workspacePath }
    });
    attachCodeChangeApproval(context.db, proposal.id, approvalId);
    writeAudit(context.db, {
      actor: "agent",
      action: "code_change_proposed",
      metadata: { proposalId: proposal.id, approvalId, path: workspacePath }
    });
    return {
      text: `Proposed workspace code change #${proposal.id} for ${workspacePath}. Approval #${approvalId} is required.`,
      stop: true
    };
  }

  return {
    text:
      "I can plan and execute operations for approvals, jobs, audit, tools, plugins, and self-edit proposals."
  };
}
