import { Elysia } from "elysia";
import { TextEncoder } from "node:util";
import { ensureSchema, openDb } from "./db";
import { getAuditById, listAudit, listAuditFiltered, writeAudit } from "./audit";
import { getAuthState, requireAuth } from "./auth";
import { loadControlPlane } from "./config";
import { createApproval, getApprovalById, listApprovals, updateApprovalStatus } from "./approvals";
import { createJob, getJobById, listJobs, listRunnableJobs, recordJobRun, setJobEnabled } from "./jobs";
import { loadToolsConfig, findTool } from "./tools";
import { evaluatePolicy, loadPolicy } from "./policy";
import { loadPluginDefinitions } from "./plugins";
import { listEvents, writeEvent } from "./events";
import {
  getJobRunById,
  listJobRuns,
  parseRunState,
  processQueuedRuns,
  updateJobRunStatus
} from "./job-runner";
import { getToolRunById, listToolRuns } from "./tool-runs";
import { executeTool } from "./tool-runner";
import { listApprovedApprovals, markApprovalExecuted, markApprovalFailed } from "./approval-exec";
import { attachEventBroadcast, registerClient, unregisterClient } from "./stream";
import { buildToolRegistry, validateToolInput } from "./tool-registry";
import { seedJobsFromConfig } from "./job-config";
import { addMessage, createSession, getSession, listMessages, listSessions } from "./chat";
import { runAgent } from "./agent";
import { runAgentWithLLM, streamAgentWithLLM } from "./agent-llm";
import { pluginsRoot, workspaceRoot } from "./paths";
import {
  createCapabilityGrant,
  getGrantByToken,
  isGrantActive,
  listCapabilityGrants,
  revokeGrant
} from "./capability-grants";
import {
  applyControlPlaneChange,
  listControlPlaneChanges,
  proposeControlPlaneChange,
  rejectControlPlaneChange
} from "./control-plane-changes";
import {
  applyCodeChangeProposal,
  listCodeChangeProposals,
  proposeCodeChange,
  setCodeChangeProposalStatus
} from "./code-change-proposals";
import { runDiagnostics, listDiagnosticsRuns } from "./diagnostics";
import { getSecretRef, getSecretValue, listSecrets, setSecretRef } from "./secrets";

const dbPath = process.env.OPENCORPO_DB_PATH;
const db = openDb(dbPath);
const migrations = ensureSchema(db);
const existingGmailAccessToken = getSecretValue(db, "gmail.access_token");
if (existingGmailAccessToken) {
  process.env.OPENCORPO_GMAIL_ACCESS_TOKEN = existingGmailAccessToken;
}
const existingGmailRefreshToken = getSecretValue(db, "gmail.refresh_token");
if (existingGmailRefreshToken) {
  process.env.OPENCORPO_GMAIL_REFRESH_TOKEN = existingGmailRefreshToken;
}
const existingAiGatewayApiKey = getSecretValue(db, "ai.api_key");
if (existingAiGatewayApiKey) {
  process.env.AI_GATEWAY_API_KEY = existingAiGatewayApiKey;
  process.env.VERCEL_AI_API_KEY = existingAiGatewayApiKey;
}
const existingAiProvider = getSecretValue(db, "ai.provider");
if (existingAiProvider) {
  process.env.OPENCORPO_AI_PROVIDER = existingAiProvider.trim().toLowerCase();
}

const auth = getAuthState();
let controlPlane = loadControlPlane();
let toolsConfig = loadToolsConfig(controlPlane.root);
let policy = loadPolicy(controlPlane.root);
let pluginLoadResults = await loadPluginDefinitions(pluginsRoot);
let plugins = pluginLoadResults.map((entry) => ({
  ...entry.manifest,
  loaded: entry.loaded,
  error: entry.error ?? null
}));
let pluginTools = pluginLoadResults
  .filter((entry) => entry.loaded && entry.definition)
  .flatMap((entry) => entry.definition?.tools ?? []);
let toolRegistry = buildToolRegistry(toolsConfig, pluginTools);
seedJobsFromConfig(db, controlPlane.root);
attachEventBroadcast(db);

const app = new Elysia();
const daemonPort = Number(process.env.OPENCORPO_PORT || 3555);

function allCapabilities() {
  return Array.from(
    new Set(
      toolRegistry.definitions
        .flatMap((tool) => tool.capabilities)
        .filter((capability) => capability.trim().length > 0)
    )
  );
}

async function rebuildRuntimeState() {
  controlPlane = loadControlPlane();
  toolsConfig = loadToolsConfig(controlPlane.root);
  policy = loadPolicy(controlPlane.root);
  pluginLoadResults = await loadPluginDefinitions(pluginsRoot);
  plugins = pluginLoadResults.map((entry) => ({
    ...entry.manifest,
    loaded: entry.loaded,
    error: entry.error ?? null
  }));
  pluginTools = pluginLoadResults
    .filter((entry) => entry.loaded && entry.definition)
    .flatMap((entry) => entry.definition?.tools ?? []);
  toolRegistry = buildToolRegistry(toolsConfig, pluginTools);
  seedJobsFromConfig(db, controlPlane.root);
}

function asObject(body: unknown) {
  return typeof body === "object" && body ? (body as Record<string, unknown>) : {};
}

function parseApprovalMetadata(raw: string | null) {
  if (!raw) return {};
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isBypassPath(pathname: string) {
  return pathname.startsWith("/oauth/google/callback");
}

async function exchangeGoogleCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    return { ok: false, error: "google_oauth_not_configured" };
  }
  const payload = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: payload.toString()
  });
  if (!response.ok) {
    return { ok: false, error: `google_token_exchange_failed:${response.status}` };
  }
  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    return { ok: false, error: "google_access_token_missing" };
  }
  setSecretRef(db, {
    name: "gmail.access_token",
    value: data.access_token,
    provider: "google_oauth",
    metadata: {
      expiresInSeconds: data.expires_in ?? null
    }
  });
  process.env.OPENCORPO_GMAIL_ACCESS_TOKEN = data.access_token;
  if (data.refresh_token) {
    setSecretRef(db, {
      name: "gmail.refresh_token",
      value: data.refresh_token,
      provider: "google_oauth"
    });
    process.env.OPENCORPO_GMAIL_REFRESH_TOKEN = data.refresh_token;
  }
  writeAudit(db, {
    actor: "user",
    action: "gmail_oauth_connected"
  });
  writeEvent(db, { type: "connector.gmail.connected", data: { source: "oauth" } });
  return { ok: true };
}

app.onBeforeHandle((ctx) => {
  ctx.set.headers["access-control-allow-origin"] = "*";
  ctx.set.headers["access-control-allow-methods"] = "GET,POST,PUT,DELETE,OPTIONS";
  ctx.set.headers["access-control-allow-headers"] =
    "authorization,content-type,x-oc-session";
  if (ctx.request.method === "OPTIONS") {
    ctx.set.status = 204;
    return "";
  }
  const path = new URL(ctx.request.url).pathname;
  if (isBypassPath(path)) return undefined;
  const denied = requireAuth(ctx, auth);
  if (denied) return denied;
  return undefined;
});

app.get("/health", () => ({
  ok: true,
  ts: new Date().toISOString(),
  version: "0.0.2",
  migrations
}));

app.post("/auth/session", ({ body }) => {
  const payload = asObject(body);
  const actor = payload.actor ? String(payload.actor) : "desktop";
  const requestedCaps = Array.isArray(payload.capabilities)
    ? payload.capabilities.map((item) => String(item))
    : allCapabilities();
  const ttlSeconds =
    typeof payload.ttlSeconds === "number" && Number.isFinite(payload.ttlSeconds)
      ? Number(payload.ttlSeconds)
      : 60 * 60 * 8;
  const grant = createCapabilityGrant(db, {
    actor,
    capabilities: requestedCaps,
    ttlSeconds
  });
  writeAudit(db, {
    actor,
    action: "capability_grant_created",
    metadata: {
      grantId: grant.id,
      expiresAt: grant.expiresAt
    }
  });
  return {
    ok: true,
    token: grant.token,
    expiresAt: grant.expiresAt,
    capabilities: requestedCaps
  };
});

app.get("/auth/grants", ({ query }) => {
  const limit = query?.limit ? Number(query.limit) : 50;
  return {
    ok: true,
    items: listCapabilityGrants(db, limit)
  };
});

app.post("/auth/grants/:id/revoke", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid_grant_id" };
  const ok = revokeGrant(db, id);
  return { ok };
});

app.get("/audit", ({ query }) => {
  const limit = query?.limit ? Number(query.limit) : 100;
  const actor = typeof query?.actor === "string" ? query.actor : undefined;
  const action = typeof query?.action === "string" ? query.action : undefined;
  const tool = typeof query?.tool === "string" ? query.tool : undefined;

  if (actor || action || tool || query?.limit) {
    return {
      ok: true,
      items: listAuditFiltered(db, { actor, action, tool, limit })
    };
  }

  return { ok: true, items: listAudit(db, 100) };
});

app.get("/audit/:id", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid audit id" };
  const item = getAuditById(db, id);
  if (!item) return { ok: false, error: "not_found" };
  return { ok: true, item };
});

app.get("/events", () => ({ ok: true, items: listEvents(db, 100) }));

app.get("/chat/sessions", () => ({ ok: true, items: listSessions(db, 50) }));
app.get("/chat/sessions/:id", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid session id" };
  const session = getSession(db, id);
  if (!session) return { ok: false, error: "not_found" };
  return { ok: true, item: session };
});
app.post("/chat/sessions", ({ body }) => {
  const payload =
    typeof body === "object" && body ? (body as Record<string, unknown>) : {};
  const title = payload.title ? String(payload.title) : undefined;
  const id = createSession(db, title);
  writeEvent(db, { type: "chat.session.created", data: { id } });
  return { ok: true, id };
});
app.get("/chat/messages", ({ query }) => {
  const sessionId = query?.sessionId ? Number(query.sessionId) : NaN;
  if (!Number.isFinite(sessionId)) return { ok: false, error: "invalid session id" };
  return { ok: true, items: listMessages(db, sessionId, 200) };
});
app.post("/chat/messages", async ({ body }) => {
  const payload = asObject(body);
  const sessionId = Number(payload.sessionId);
  const content = typeof payload.content === "string" ? payload.content : "";
  const role =
    payload.role === "assistant" || payload.role === "system" ? payload.role : "user";
  const skipAgent = payload.skipAgent === true;
  if (!Number.isFinite(sessionId)) return { ok: false, error: "invalid session id" };
  if (!content.trim()) return { ok: false, error: "empty_message" };

  const messageId = addMessage(db, sessionId, role, content);
  writeEvent(db, { type: "chat.message.created", data: { id: messageId } });

  if (skipAgent || role !== "user") {
    return { ok: true, messageId };
  }

  const agentContext = {
    db,
    tools: toolRegistry.definitions,
    plugins,
    controlPlaneRoot: controlPlane.root,
    workspaceRoot,
    handlerNames: Array.from(toolRegistry.handlers.keys())
  };

  const history = listMessages(db, sessionId, 200);
  const messages = history.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content
  }));

  let reply = await runAgentWithLLM(messages, agentContext);
  if (!reply) {
    reply = await runAgent(content, agentContext);
  }
  const assistantId = addMessage(db, sessionId, "assistant", reply.text, reply.metadata);
  writeEvent(db, { type: "chat.response.created", data: { id: assistantId } });

  return {
    ok: true,
    messageId,
    assistantMessageId: assistantId,
    reply: reply.text
  };
});

app.post("/chat/stream", async ({ body }) => {
  const payload = asObject(body);
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  // Pass through as UIMessage[] — the AI SDK's convertToModelMessages handles the conversion
  const messages = rawMessages as Array<{
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
    parts?: Array<{ type: string; text?: string }>;
  }>;

  const agentContext = {
    db,
    tools: toolRegistry.definitions,
    plugins,
    controlPlaneRoot: controlPlane.root,
    workspaceRoot,
    handlerNames: Array.from(toolRegistry.handlers.keys())
  };

  const corsHeaders: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-oc-session"
  };

  const result = await streamAgentWithLLM(messages, agentContext);
  if (!result.ok) {
    return new Response(JSON.stringify({ ok: false, error: result.error }), {
      status: 400,
      headers: { "content-type": "application/json", ...corsHeaders }
    });
  }

  // Clone the response with CORS headers so cross-origin fetch works.
  // Elysia's onBeforeHandle headers don't apply to raw Response objects.
  const origHeaders = new Headers(result.response.headers);
  for (const [k, v] of Object.entries(corsHeaders)) origHeaders.set(k, v);
  return new Response(result.response.body, {
    status: result.response.status,
    statusText: result.response.statusText,
    headers: origHeaders
  });
});

app.get("/approvals", () => ({ ok: true, items: listApprovals(db, 100) }));
app.get("/approvals/:id", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid approval id" };
  const approval = getApprovalById(db, id);
  if (!approval) return { ok: false, error: "not_found" };
  const tool = approval.tool ? findTool(toolRegistry.definitions, approval.tool) : null;
  const metadata = approval.metadata ?? null;
  const jobRunId = metadata && typeof metadata.jobRunId === "number" ? metadata.jobRunId : null;
  const jobRun = jobRunId ? getJobRunById(db, jobRunId) : null;
  const job = jobRun ? getJobById(db, jobRun.job_id) : null;
  const jobRunOutput = jobRun?.output_json ? JSON.parse(String(jobRun.output_json)) : null;
  return {
    ok: true,
    item: {
      ...approval,
      tool_definition: tool,
      tool_risk: tool?.risk ?? null,
      job_run: jobRun
        ? {
            id: jobRun.id,
            job_id: jobRun.job_id,
            status: jobRun.status,
            error: jobRun.error,
            output: jobRunOutput
          }
        : null,
      job: job ? { id: job.id, name: job.name } : null
    }
  };
});

app.post("/approvals", ({ body }) => {
  const payload = asObject(body);
  const id = createApproval(db, {
    requestedBy: String(payload.requestedBy ?? "agent"),
    tool: payload.tool ? String(payload.tool) : undefined,
    action: payload.action ? String(payload.action) : undefined,
    reason: payload.reason ? String(payload.reason) : undefined,
    metadata:
      payload.metadata && typeof payload.metadata === "object"
        ? (payload.metadata as Record<string, unknown>)
        : undefined
  });
  writeAudit(db, {
    actor: "agent",
    action: "approval_requested",
    metadata: { approvalId: id }
  });
  writeEvent(db, { type: "approval.requested", data: { id } });
  return { ok: true, id };
});

app.post("/approvals/:id/approve", ({ params }) => {
  const id = Number(params.id);
  const ok = Number.isFinite(id) && updateApprovalStatus(db, id, "approved");
  if (ok) {
    writeAudit(db, { actor: "user", action: "approval_approved", metadata: { id } });
    writeEvent(db, { type: "approval.approved", data: { id } });
  }
  return { ok };
});

app.post("/approvals/:id/deny", ({ params }) => {
  const id = Number(params.id);
  const ok = Number.isFinite(id) && updateApprovalStatus(db, id, "denied");
  if (ok) {
    writeAudit(db, { actor: "user", action: "approval_denied", metadata: { id } });
    writeEvent(db, { type: "approval.denied", data: { id } });
  }
  return { ok };
});

app.get("/jobs", () => ({ ok: true, items: listJobs(db, 100) }));
app.get("/jobs/:id", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid job id" };
  const job = getJobById(db, id);
  if (!job) return { ok: false, error: "not_found" };
  const steps = Array.isArray(job.definition?.steps) ? job.definition.steps : [];
  return { ok: true, item: { ...job, step_count: steps.length } };
});
app.get("/jobs/runs", () => ({ ok: true, items: listJobRuns(db, 100) }));
app.get("/jobs/runs/:id", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid job run id" };
  const run = getJobRunById(db, id);
  if (!run) return { ok: false, error: "not_found" };
  const job = getJobById(db, run.job_id);
  return {
    ok: true,
    item: {
      ...run,
      output: run.output_json ? JSON.parse(String(run.output_json)) : null,
      job: job ? { id: job.id, name: job.name } : null
    }
  };
});

app.get("/tools/runs", () => ({ ok: true, items: listToolRuns(db, 100) }));
app.get("/tools/runs/:id", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid tool run id" };
  const run = getToolRunById(db, id);
  if (!run) return { ok: false, error: "not_found" };
  const tool = findTool(toolRegistry.definitions, run.tool);
  return {
    ok: true,
    item: {
      ...run,
      tool_definition: tool,
      tool_risk: tool?.risk ?? null
    }
  };
});

app.get("/diagnostics", () => {
  const report = runDiagnostics(db, {
    controlPlaneValidation: controlPlane.validation,
    plugins,
    migrations
  });
  return { ok: true, report };
});

app.get("/diagnostics/runs", ({ query }) => {
  const limit = query?.limit ? Number(query.limit) : 20;
  return {
    ok: true,
    items: listDiagnosticsRuns(db, limit)
  };
});

app.post("/diagnostics/repair", async () => {
  await rebuildRuntimeState();
  writeAudit(db, {
    actor: "system",
    action: "diagnostics_repair_executed"
  });
  return {
    ok: true,
    repaired: ["runtime_reloaded", "jobs_seeded"]
  };
});

app.post("/jobs", ({ body }) => {
  const payload = asObject(body);
  const id = createJob(db, {
    name: String(payload.name ?? "unnamed-job"),
    enabled: payload.enabled === false ? false : true,
    schedule:
      payload.schedule && typeof payload.schedule === "object"
        ? (payload.schedule as Record<string, unknown>)
        : undefined,
    capabilities: Array.isArray(payload.capabilities_required)
      ? payload.capabilities_required.map((cap) => String(cap))
      : undefined,
    definition:
      payload.definition && typeof payload.definition === "object"
        ? (payload.definition as Record<string, unknown>)
        : undefined
  });
  writeAudit(db, {
    actor: "agent",
    action: "job_created",
    metadata: { jobId: id }
  });
  writeEvent(db, { type: "job.created", data: { jobId: id } });
  return { ok: true, id };
});

app.post("/jobs/run/:id", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid job id" };
  const runId = recordJobRun(db, id, "queued");
  writeAudit(db, {
    actor: "agent",
    action: "job_run_requested",
    metadata: { jobId: id, jobRunId: runId }
  });
  writeEvent(db, { type: "job.run.queued", data: { jobId: id, jobRunId: runId } });
  return { ok: true, jobRunId: runId };
});

app.post("/jobs/:id/enable", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid job id" };
  const ok = setJobEnabled(db, id, true);
  if (ok) {
    writeAudit(db, { actor: "user", action: "job_enabled", metadata: { jobId: id } });
    writeEvent(db, { type: "job.enabled", data: { jobId: id } });
  }
  return { ok };
});

app.post("/jobs/:id/disable", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid job id" };
  const ok = setJobEnabled(db, id, false);
  if (ok) {
    writeAudit(db, { actor: "user", action: "job_disabled", metadata: { jobId: id } });
    writeEvent(db, { type: "job.disabled", data: { jobId: id } });
  }
  return { ok };
});

app.get("/control-plane", () => ({ ok: true, ...controlPlane }));
app.post("/control-plane/reload", async () => {
  await rebuildRuntimeState();
  writeAudit(db, {
    actor: "system",
    action: "control_plane_reloaded"
  });
  return { ok: true, validation: controlPlane.validation };
});

app.get("/control-plane/changes", ({ query }) => {
  const limit = query?.limit ? Number(query.limit) : 100;
  return {
    ok: true,
    items: listControlPlaneChanges(db, limit)
  };
});

app.post("/control-plane/changes/propose", ({ body }) => {
  const payload = asObject(body);
  const relativePath =
    typeof payload.relativePath === "string" ? payload.relativePath : "";
  const afterJson =
    payload.afterJson && typeof payload.afterJson === "object" ? payload.afterJson : null;
  if (!relativePath || !afterJson) {
    return { ok: false, error: "relativePath_and_afterJson_required" };
  }
  try {
    const proposed = proposeControlPlaneChange(db, controlPlane.root, {
      actor: payload.actor ? String(payload.actor) : "user",
      relativePath,
      afterJson,
      summary: payload.summary ? String(payload.summary) : undefined
    });
    if (!proposed.ok) return proposed;
    return { ok: true, item: proposed };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "propose_failed"
    };
  }
});

app.post("/control-plane/changes/:id/apply", async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid_change_id" };
  const result = applyControlPlaneChange(db, controlPlane.root, id);
  if (!result.ok) return result;
  await rebuildRuntimeState();
  writeAudit(db, {
    actor: "user",
    action: "control_plane_change_applied",
    metadata: { changeId: id }
  });
  writeEvent(db, {
    type: "control_plane.change.applied",
    data: { changeId: id }
  });
  return { ok: true };
});

app.post("/control-plane/changes/:id/reject", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid_change_id" };
  const ok = rejectControlPlaneChange(db, id);
  return { ok };
});

app.get("/code/changes", ({ query }) => {
  const limit = query?.limit ? Number(query.limit) : 100;
  return {
    ok: true,
    items: listCodeChangeProposals(db, limit)
  };
});

app.post("/code/changes/propose", ({ body }) => {
  const payload = asObject(body);
  const targetPath =
    typeof payload.targetPath === "string" ? payload.targetPath : "";
  const afterContent =
    typeof payload.afterContent === "string" ? payload.afterContent : "";
  if (!targetPath || !afterContent) {
    return { ok: false, error: "targetPath_and_afterContent_required" };
  }
  try {
    const item = proposeCodeChange(db, workspaceRoot, {
      actor: payload.actor ? String(payload.actor) : "user",
      targetPath,
      afterContent,
      summary: payload.summary ? String(payload.summary) : undefined,
      reason: payload.reason ? String(payload.reason) : undefined
    });
    const approvalId = createApproval(db, {
      requestedBy: "user",
      tool: "workspace.patch",
      action: "apply",
      reason: `Tier B code change proposal #${item.id}`,
      metadata: { codeChangeProposalId: item.id, targetPath }
    });
    db.prepare(
      `UPDATE code_change_proposals SET approval_id = ? WHERE id = ?`
    ).run(approvalId, item.id);
    return {
      ok: true,
      item: {
        ...item,
        approvalId
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "propose_failed"
    };
  }
});

app.post("/code/changes/:id/reject", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid_proposal_id" };
  const ok = setCodeChangeProposalStatus(db, id, "rejected");
  return { ok };
});

app.post("/code/changes/:id/apply", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid_proposal_id" };
  const result = applyCodeChangeProposal(db, workspaceRoot, id);
  return result;
});

app.get("/plugins", () => ({ ok: true, items: plugins }));
app.get("/tools", () => ({ ok: true, items: toolRegistry.definitions }));
app.get("/tools/registry", () => ({
  ok: true,
  items: toolRegistry.definitions,
  handlers: Array.from(toolRegistry.handlers.values()).map((handler) => ({
    name: handler.name,
    version: handler.version,
    risk: handler.risk,
    capabilities: handler.capabilities
  })),
  warnings: toolRegistry.warnings
}));

app.get("/connectors/gmail/status", () => {
  const accessToken = getSecretRef(db, "gmail.access_token");
  const refreshToken = getSecretRef(db, "gmail.refresh_token");
  return {
    ok: true,
    connected: Boolean(accessToken),
    tokenSource: accessToken ? accessToken.provider : null,
    refreshConfigured: Boolean(refreshToken)
  };
});

app.post("/connectors/gmail/token", ({ body }) => {
  const payload = asObject(body);
  const accessToken =
    typeof payload.accessToken === "string" ? payload.accessToken.trim() : "";
  if (!accessToken) return { ok: false, error: "accessToken_required" };
  setSecretRef(db, {
    name: "gmail.access_token",
    value: accessToken,
    provider: "manual"
  });
  process.env.OPENCORPO_GMAIL_ACCESS_TOKEN = accessToken;
  if (typeof payload.refreshToken === "string" && payload.refreshToken.trim()) {
    setSecretRef(db, {
      name: "gmail.refresh_token",
      value: payload.refreshToken.trim(),
      provider: "manual"
    });
    process.env.OPENCORPO_GMAIL_REFRESH_TOKEN = payload.refreshToken.trim();
  }
  writeAudit(db, { actor: "user", action: "gmail_token_saved" });
  writeEvent(db, { type: "connector.gmail.connected", data: { source: "manual" } });
  return { ok: true };
});

app.get("/connectors/gmail/oauth/start", () => {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  if (!clientId) {
    return { ok: false, error: "google_client_id_missing" };
  }
  const redirectUri =
    process.env.OPENCORPO_GMAIL_REDIRECT_URI ??
    `http://127.0.0.1:${daemonPort}/oauth/google/callback`;
  const scope = encodeURIComponent(
    [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.send"
    ].join(" ")
  );
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&scope=${scope}`;
  return {
    ok: true,
    authUrl,
    redirectUri
  };
});

app.get("/oauth/google/callback", async ({ query, set }) => {
  const code = typeof query?.code === "string" ? query.code : "";
  const redirectUri =
    process.env.OPENCORPO_GMAIL_REDIRECT_URI ??
    `http://127.0.0.1:${daemonPort}/oauth/google/callback`;
  if (!code) {
    set.status = 400;
    return {
      ok: false,
      error: "missing_oauth_code"
    };
  }
  const result = await exchangeGoogleCodeForToken(code, redirectUri);
  if (!result.ok) {
    set.status = 400;
    return result;
  }
  return {
    ok: true,
    message: "Gmail connected. You can return to OpenCorpo."
  };
});

app.get("/secrets", ({ query }) => {
  const limit = query?.limit ? Number(query.limit) : 100;
  return {
    ok: true,
    items: listSecrets(db, limit)
  };
});
app.get("/secrets/ai-key/status", () => {
  const hasKey = Boolean(
    process.env.AI_GATEWAY_API_KEY ??
      process.env.VERCEL_AI_API_KEY ??
      getSecretValue(db, "ai.api_key")
  );
  const provider =
    process.env.OPENCORPO_AI_PROVIDER ??
    getSecretValue(db, "ai.provider") ??
    null;
  return { ok: true, configured: hasKey, provider };
});
app.post("/secrets/ai-key", ({ body }) => {
  const payload = asObject(body);
  const value = typeof payload.value === "string" ? payload.value.trim() : "";
  const provider = typeof payload.provider === "string" ? payload.provider.trim().toLowerCase() : "";
  if (!value) return { ok: false, error: "value_required" };
  setSecretRef(db, { name: "ai.api_key", value });
  if (provider) {
    setSecretRef(db, { name: "ai.provider", value: provider });
    process.env.OPENCORPO_AI_PROVIDER = provider;
  }
  // Make key available immediately for this daemon process.
  process.env.AI_GATEWAY_API_KEY = value;
  process.env.VERCEL_AI_API_KEY = value;
  return { ok: true };
});
app.get("/stream", ({ request, set }) => {
  set.headers["content-type"] = "text/event-stream";
  set.headers["cache-control"] = "no-cache";
  set.headers["connection"] = "keep-alive";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const clientId = registerClient((payload) => {
        controller.enqueue(encoder.encode(payload));
      });

      controller.enqueue(encoder.encode(`: connected\\n\\n`));

      request.signal.addEventListener("abort", () => {
        unregisterClient(clientId);
        controller.close();
      });
    }
  });

  return new Response(stream);
});

const schedulerIntervalMs = 5000;
setInterval(() => {
  const now = new Date();
  const runnable = listRunnableJobs(db, now);
  for (const job of runnable) {
    const runId = recordJobRun(db, job.id, "queued");
    writeAudit(db, {
      actor: "system",
      action: "job_scheduled",
      metadata: { jobId: job.id, jobRunId: runId }
    });
    writeEvent(db, { type: "job.run.scheduled", data: { jobId: job.id, jobRunId: runId } });
  }
}, schedulerIntervalMs);

const runnerIntervalMs = 2000;
setInterval(() => {
  void processQueuedRuns(db, toolRegistry, policy);
}, runnerIntervalMs);

app.post("/tools/:toolName", async ({ params, body, request }) => {
  const toolName = params.toolName;
  const tool = findTool(toolRegistry.definitions, toolName);
  if (!tool) return { ok: false, error: "tool_not_found" };

  const sessionToken = request.headers.get("x-oc-session") ?? "";
  const grant = getGrantByToken(db, sessionToken);
  if (!grant || !isGrantActive(grant)) {
    writeAudit(db, {
      actor: "agent",
      action: "capability_session_invalid",
      tool: tool.name
    });
    return { ok: false, error: "invalid_or_expired_capability_session" };
  }
  const providedCaps = grant.capabilities;

  const missingCaps = tool.capabilities.filter(
    (cap) => !providedCaps.includes(cap)
  );
  if (missingCaps.length > 0) {
    writeAudit(db, {
      actor: "agent",
      action: "capability_denied",
      tool: tool.name,
      metadata: { missingCaps }
    });
    return { ok: false, error: "capability_missing", missingCaps };
  }

  const inputValidation = validateToolInput(
    toolRegistry,
    tool.name,
    (body ?? null) as Record<string, unknown> | null
  );
  if (!inputValidation.valid) {
    writeAudit(db, {
      actor: "agent",
      action: "tool_input_invalid",
      tool: tool.name,
      metadata: { errors: inputValidation.errors }
    });
    return { ok: false, error: "invalid_input", details: inputValidation.errors };
  }

  const policyResult = evaluatePolicy(policy, {
    risk: tool.risk,
    tool: tool.name,
    action: "invoke",
    actor: "agent"
  });

  if (policyResult.decision === "deny") {
    writeAudit(db, {
      actor: "policy",
      action: "tool_denied",
      tool: tool.name,
      policy: policyResult.ruleId,
      metadata: { reason: policyResult.reason }
    });
    return { ok: false, error: "policy_denied", reason: policyResult.reason };
  }

  if (policyResult.decision === "approve" || tool.risk === "high") {
    const approvalId = createApproval(db, {
      requestedBy: "agent",
      tool: tool.name,
      action: "invoke",
      reason: policyResult.reason ?? "High-risk tool requires approval.",
      metadata: { input: body ?? null }
    });
    writeAudit(db, {
      actor: "agent",
      action: "tool_approval_requested",
      tool: tool.name,
      metadata: { approvalId }
    });
    writeEvent(db, { type: "tool.approval.requested", data: { approvalId } });
    return { ok: true, approvalRequired: true, approvalId };
  }

  const result = await executeTool(
    db,
    {
      tool,
      input: (body ?? null) as Record<string, unknown> | null,
      context: { actor: "agent" }
    },
    toolRegistry
  );
  writeAudit(db, {
    actor: "agent",
    action: "tool_invoked",
    tool: tool.name,
    metadata: { input: body ?? null }
  });
  writeEvent(db, { type: "tool.invoked", data: { tool: tool.name } });

  return { ok: true, result };
});

const approvalExecIntervalMs = 2000;
setInterval(async () => {
  const approved = listApprovedApprovals(db, 5);
  for (const approval of approved) {
    const metadata = parseApprovalMetadata(approval.metadata_json);
    if (approval.tool === "control-plane.change") {
      const changeId = Number(metadata.changeId ?? NaN);
      if (!Number.isFinite(changeId)) {
        markApprovalFailed(db, approval.id, "missing_change_id");
        continue;
      }
      const result = applyControlPlaneChange(db, controlPlane.root, changeId);
      if (result.ok) {
        markApprovalExecuted(db, approval.id);
        await rebuildRuntimeState();
      } else {
        markApprovalFailed(db, approval.id, result.error);
      }
      continue;
    }
    if (approval.tool === "workspace.patch") {
      const proposalId = Number(metadata.codeChangeProposalId ?? NaN);
      if (!Number.isFinite(proposalId)) {
        markApprovalFailed(db, approval.id, "missing_code_change_proposal_id");
        continue;
      }
      const approvedStatus = setCodeChangeProposalStatus(db, proposalId, "approved");
      if (!approvedStatus) {
        markApprovalFailed(db, approval.id, "proposal_not_in_proposed_state");
        continue;
      }
      const result = applyCodeChangeProposal(db, workspaceRoot, proposalId);
      if (!result.ok) {
        markApprovalFailed(db, approval.id, result.error);
        continue;
      }
      markApprovalExecuted(db, approval.id);
      continue;
    }
    if (!approval.tool) continue;
    const tool = findTool(toolRegistry.definitions, approval.tool);
    if (!tool) continue;
    const toolMetadata = metadata as {
      input?: Record<string, unknown>;
      jobRunId?: number;
      stepIndex?: number;
    };
    const input = toolMetadata.input ?? null;
    const result = await executeTool(
      db,
      {
        tool,
        input,
        approvalId: approval.id,
        context: { actor: "approval", approvalId: approval.id }
      },
      toolRegistry
    );
    if (result.ok) {
      markApprovalExecuted(db, approval.id);
    } else {
      markApprovalFailed(db, approval.id, result.error);
    }

    const jobRunId = Number(toolMetadata.jobRunId ?? NaN);
    if (Number.isFinite(jobRunId)) {
      const run = getJobRunById(db, jobRunId);
      if (run) {
        const state = parseRunState(run.output_json);
        const outputs = Array.isArray(state.outputs) ? state.outputs : [];
        outputs.push({ tool: tool.name, result });
        const nextStepIndex = Number.isFinite(toolMetadata.stepIndex)
          ? Number(toolMetadata.stepIndex) + 1
          : state.stepIndex + 1;
        if (result.ok) {
          updateJobRunStatus(db, jobRunId, "queued", {
            stepIndex: nextStepIndex,
            outputs
          });
          writeEvent(db, { type: "job.run.resumed", data: { jobRunId } });
        } else {
          updateJobRunStatus(db, jobRunId, "failed", {
            stepIndex: nextStepIndex,
            outputs,
            error: "tool_failed"
          });
          writeEvent(db, { type: "job.run.failed", data: { jobRunId } });
        }
      }
    }
  }
}, approvalExecIntervalMs);

app.listen({
  hostname: "127.0.0.1",
  port: daemonPort
});

writeAudit(db, {
  actor: "system",
  action: "daemon_start",
  metadata: {
    port: Number(process.env.OPENCORPO_PORT || 3555),
    configRoot: controlPlane.root,
    migrationVersion: migrations.currentVersion
  }
});

console.log(
  `OpenCorpo daemon running on http://127.0.0.1:${daemonPort}`
);
