import { Elysia } from "elysia";
import { TextEncoder } from "node:util";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { ensureSchema, openDb } from "./db";
import {
  getAuditById,
  listAudit,
  listAuditFiltered,
  repairAuditIntegrity,
  writeAudit
} from "./audit";
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
import {
  addMessage,
  createSession,
  deleteSession,
  getSession,
  listMessages,
  listSessions,
  updateSession
} from "./chat";
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
import { loadUiConfig } from "./ui-config";
import {
  listAiMemory,
  listAiUserNotes,
  listDbTables,
  runReadOnlyQuery,
  upsertAiMemory,
  upsertAiUserNote
} from "./agent-memory";
import { getScriptDbSession } from "./script-db-sessions";
import {
  getScriptExecutionMode,
  normalizeScriptExecutionMode,
  setScriptExecutionMode
} from "./script-security";
import { extractUserMemoryNotes } from "./user-memory";
import {
  CODEX_DEFAULT_REDIRECT_URI,
  consumeCodexOauthVerifier,
  createCodexOauthStart,
  exchangeCodexAuthorizationCode,
  extractCodexAccountId,
  startCodexCallbackServer
} from "./codex-auth";

const dbPath = process.env.OPENCORPO_DB_PATH;
const db = openDb(dbPath);
const migrations = ensureSchema(db);
const auditRepair = repairAuditIntegrity(db);
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
const existingOpenAiApiKey = getSecretValue(db, "ai.api_key.openai");
if (existingOpenAiApiKey) {
  process.env.OPENAI_API_KEY = existingOpenAiApiKey;
}
const existingAnthropicApiKey = getSecretValue(db, "ai.api_key.anthropic");
if (existingAnthropicApiKey) {
  process.env.ANTHROPIC_API_KEY = existingAnthropicApiKey;
}
const existingAiProvider = getSecretValue(db, "ai.provider");
if (existingAiProvider) {
  process.env.OPENCORPO_AI_PROVIDER = existingAiProvider.trim().toLowerCase();
}
const existingCodexAccessToken = getSecretValue(db, "ai.codex.access_token");
if (existingCodexAccessToken) {
  process.env.OPENCORPO_CODEX_ACCESS_TOKEN = existingCodexAccessToken.trim();
}
const existingCodexAccountId = getSecretValue(db, "ai.codex.account_id");
if (existingCodexAccountId) {
  process.env.OPENCORPO_CODEX_ACCOUNT_ID = existingCodexAccountId.trim();
}

const auth = getAuthState();
let controlPlane = loadControlPlane();
let toolsConfig = loadToolsConfig(controlPlane.root);
let policy = loadPolicy(controlPlane.root);
let uiConfig = loadUiConfig(controlPlane.root);
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
const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-oc-session"
};

type TerminalEvent = {
  cursor: number;
  stream: "stdout" | "stderr" | "status";
  data: string;
  ts: string;
};

type TerminalSession = {
  id: string;
  createdAt: string;
  command: string;
  cwd: string;
  allowInput: boolean;
  process: ChildProcessWithoutNullStreams;
  events: TerminalEvent[];
  nextCursor: number;
  closed: boolean;
  exitCode: number | null;
};

const terminalSessions = new Map<string, TerminalSession>();
const MAX_TERMINAL_SESSIONS = 20;
const MAX_TERMINAL_EVENTS = 3000;
const MAX_TERMINAL_INPUT = 8192;
const MAX_TERMINAL_COMMAND = 2000;
const MAX_TERMINAL_CWD = 512;

function isPathInside(base: string, target: string) {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveTerminalCwd(input: string | undefined) {
  if (!input) return workspaceRoot;
  const trimmed = input.trim();
  if (!trimmed) return workspaceRoot;
  if (trimmed.length > MAX_TERMINAL_CWD) return null;
  const absolute = isAbsolute(trimmed) ? trimmed : resolvePath(workspaceRoot, trimmed);
  if (!isPathInside(workspaceRoot, absolute)) return null;
  return absolute;
}

function appendTerminalEvent(session: TerminalSession, stream: TerminalEvent["stream"], data: string) {
  const text = typeof data === "string" ? data : String(data ?? "");
  if (!text) return;
  session.events.push({
    cursor: session.nextCursor,
    stream,
    data: text,
    ts: new Date().toISOString()
  });
  session.nextCursor += 1;
  if (session.events.length > MAX_TERMINAL_EVENTS) {
    session.events.splice(0, session.events.length - MAX_TERMINAL_EVENTS);
  }
}

function closeTerminalSession(session: TerminalSession, exitCode: number | null) {
  if (session.closed) return;
  session.closed = true;
  session.exitCode = exitCode;
  appendTerminalEvent(
    session,
    "status",
    exitCode == null ? "terminal session closed" : `terminal exited with code ${exitCode}`
  );
}

function pruneTerminalSessions() {
  while (terminalSessions.size >= MAX_TERMINAL_SESSIONS) {
    const oldestKey = terminalSessions.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = terminalSessions.get(oldestKey);
    if (oldest && !oldest.closed) {
      oldest.process.kill("SIGTERM");
      closeTerminalSession(oldest, oldest.exitCode);
    }
    terminalSessions.delete(oldestKey);
  }
}

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
  uiConfig = loadUiConfig(controlPlane.root);
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

function normalizeSecretInput(value: string) {
  return value
    // Remove zero-width chars sometimes introduced by clipboard/HTML copy.
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    // Drop surrounding single/double quotes if present.
    .replace(/^['"]+|['"]+$/g, "");
}

function normalizeScriptSecretName(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^script\./, "")
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^\.+|\.+$/g, "");
  return normalized;
}

type WidgetPropsResolveResult =
  | { ok: true; value: unknown; resolvedSecrets: Set<string> }
  | { ok: false; error: string };

function resolveWidgetSecretPlaceholders(
  value: unknown,
  depth: number,
  resolvedSecrets: Set<string>
): WidgetPropsResolveResult {
  if (depth > 12) {
    return { ok: false, error: "widget_props_too_deep" };
  }
  if (value === null || value === undefined) {
    return { ok: true, value, resolvedSecrets };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const result = resolveWidgetSecretPlaceholders(item, depth + 1, resolvedSecrets);
      if (!result.ok) return result;
      out.push(result.value);
    }
    return { ok: true, value: out, resolvedSecrets };
  }
  if (typeof value !== "object") {
    return { ok: true, value, resolvedSecrets };
  }

  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length === 1 && keys[0] === "$secret") {
    const secretName = typeof row.$secret === "string" ? row.$secret.trim() : "";
    if (!secretName) return { ok: false, error: "widget_secret_name_required" };
    if (!secretName.startsWith("script.")) {
      return { ok: false, error: `widget_secret_not_allowed:${secretName}` };
    }
    const secretValue = getSecretValue(db, secretName);
    if (secretValue == null) {
      return { ok: false, error: `widget_secret_not_found:${secretName}` };
    }
    resolvedSecrets.add(secretName);
    return { ok: true, value: secretValue.trim(), resolvedSecrets };
  }

  const out: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(row)) {
    const result = resolveWidgetSecretPlaceholders(nestedValue, depth + 1, resolvedSecrets);
    if (!result.ok) return result;
    out[key] = result.value;
  }
  return { ok: true, value: out, resolvedSecrets };
}

type AiModelDefaults = {
  anthropic: string;
  openai: string;
  local: string;
  codex: string;
};

function readAiModelDefaults(): AiModelDefaults {
  const raw = getSecretValue(db, "ai.model_defaults");
  if (!raw) {
    return {
      anthropic: "",
      openai: "",
      local: "",
      codex: ""
    };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      anthropic: typeof parsed.anthropic === "string" ? parsed.anthropic.trim() : "",
      openai: typeof parsed.openai === "string" ? parsed.openai.trim() : "",
      local: typeof parsed.local === "string" ? parsed.local.trim() : "",
      codex: typeof parsed.codex === "string" ? parsed.codex.trim() : ""
    };
  } catch {
    return {
      anthropic: "",
      openai: "",
      local: "",
      codex: ""
    };
  }
}

function normalizeProviderName(value: string | null | undefined): string | null {
  const next = (value ?? "").trim().toLowerCase();
  if (!next) return null;
  if (
    next === "openai" ||
    next === "anthropic" ||
    next === "local" ||
    next === "gateway" ||
    next === "codex"
  ) {
    return next;
  }
  return null;
}

function dedupeModels(models: string[], defaultModel: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  push(defaultModel);
  for (const model of models) push(model);
  return out;
}

function getProviderApiKey(
  provider: "openai" | "anthropic" | "gateway",
  preferredProvider: string | null,
  legacyKey: string
) {
  const inferredLegacyProvider = legacyKey.startsWith("sk-ant-")
    ? "anthropic"
    : legacyKey.startsWith("sk-")
      ? "openai"
      : legacyKey
        ? "gateway"
        : null;
  if (provider === "openai") {
    return (
      process.env.OPENAI_API_KEY ??
      getSecretValue(db, "ai.api_key.openai") ??
      (preferredProvider === "openai" || inferredLegacyProvider === "openai" ? legacyKey : "")
    );
  }
  if (provider === "anthropic") {
    return (
      process.env.ANTHROPIC_API_KEY ??
      getSecretValue(db, "ai.api_key.anthropic") ??
      (preferredProvider === "anthropic" || inferredLegacyProvider === "anthropic"
        ? legacyKey
        : "")
    );
  }
  return (
    process.env.AI_GATEWAY_API_KEY ??
    process.env.VERCEL_AI_API_KEY ??
    getSecretValue(db, "ai.api_key.gateway") ??
    (preferredProvider !== "openai" &&
    preferredProvider !== "anthropic" &&
    inferredLegacyProvider !== "openai" &&
    inferredLegacyProvider !== "anthropic"
      ? legacyKey
      : "")
  );
}

async function listOpenAiModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as {
      data?: Array<{ id?: string }>;
    };
    if (!Array.isArray(payload.data)) return [];
    return payload.data
      .map((item) => (typeof item.id === "string" ? item.id.trim() : ""))
      .filter((id) => id.length > 0)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function listAnthropicModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as {
      data?: Array<{ id?: string }>;
    };
    if (!Array.isArray(payload.data)) return [];
    return payload.data
      .map((item) => (typeof item.id === "string" ? item.id.trim() : ""))
      .filter((id) => id.length > 0)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

const CODEX_MODELS = [
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1"
];

function getCodexTokenState() {
  const accessToken =
    (process.env.OPENCORPO_CODEX_ACCESS_TOKEN ??
      getSecretValue(db, "ai.codex.access_token") ??
      "").trim();
  const refreshToken = (getSecretValue(db, "ai.codex.refresh_token") ?? "").trim();
  const accountId =
    (process.env.OPENCORPO_CODEX_ACCOUNT_ID ??
      getSecretValue(db, "ai.codex.account_id") ??
      "").trim();
  const expiresAtRaw = (getSecretValue(db, "ai.codex.expires_at") ?? "").trim();
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null;
  return {
    accessToken,
    refreshToken,
    accountId,
    expiresAt: expiresAt && expiresAt !== "Invalid Date" ? expiresAt : null
  };
}

function parseApprovalMetadata(raw: string | null) {
  if (!raw) return {};
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveScriptDbToken(request: Request) {
  const headerToken = request.headers.get("x-oc-script-db-token")?.trim();
  if (headerToken) return headerToken;
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }
  const queryToken = new URL(request.url).searchParams.get("token")?.trim();
  return queryToken || "";
}

function getScriptDbSessionFromRequest(request: Request) {
  const token = resolveScriptDbToken(request);
  return getScriptDbSession(token);
}

function isBypassPath(pathname: string) {
  return (
    pathname.startsWith("/oauth/google/callback") ||
    pathname.startsWith("/oauth/openai/callback") ||
    pathname.startsWith("/script-db/")
  );
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

async function completeCodexOauth(
  code: string,
  state: string,
  redirectUri: string
): Promise<{ ok: true; expiresAt: string } | { ok: false; error: string }> {
  const verifier = consumeCodexOauthVerifier(state);
  if (!verifier) {
    return { ok: false, error: "invalid_or_expired_oauth_state" };
  }
  const exchanged = await exchangeCodexAuthorizationCode(code, verifier, redirectUri);
  if (!exchanged.ok) {
    return exchanged;
  }
  const accountId = extractCodexAccountId(exchanged.accessToken);
  if (!accountId) {
    return { ok: false, error: "codex_account_id_missing" };
  }
  const expiresAt = new Date(Date.now() + exchanged.expiresIn * 1000).toISOString();
  setSecretRef(db, {
    name: "ai.codex.access_token",
    value: exchanged.accessToken,
    provider: "openai_oauth_codex"
  });
  setSecretRef(db, {
    name: "ai.codex.refresh_token",
    value: exchanged.refreshToken,
    provider: "openai_oauth_codex"
  });
  setSecretRef(db, {
    name: "ai.codex.expires_at",
    value: expiresAt,
    provider: "openai_oauth_codex"
  });
  setSecretRef(db, {
    name: "ai.codex.account_id",
    value: accountId,
    provider: "openai_oauth_codex"
  });
  setSecretRef(db, {
    name: "ai.provider",
    value: "codex",
    provider: "local_file"
  });
  process.env.OPENCORPO_AI_PROVIDER = "codex";
  process.env.OPENCORPO_CODEX_ACCESS_TOKEN = exchanged.accessToken;
  process.env.OPENCORPO_CODEX_ACCOUNT_ID = accountId;
  writeAudit(db, { actor: "user", action: "codex_oauth_connected" });
  writeEvent(db, {
    type: "connector.codex.connected",
    data: { provider: "openai_oauth_codex", expiresAt }
  });
  return { ok: true, expiresAt };
}

app.options("/*", ({ set }) => {
  for (const [key, value] of Object.entries(corsHeaders)) {
    set.headers[key] = value;
  }
  set.status = 204;
  return "";
});

app.onRequest((ctx) => {
  for (const [key, value] of Object.entries(corsHeaders)) {
    ctx.set.headers[key] = value;
  }
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
  const metadata =
    payload.metadata && typeof payload.metadata === "object"
      ? (payload.metadata as Record<string, unknown>)
      : undefined;
  const id = createSession(db, title, metadata);
  writeEvent(db, { type: "chat.session.created", data: { id } });
  return { ok: true, id };
});
app.post("/chat/sessions/:id", ({ params, body }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid session id" };
  const payload = asObject(body);
  const title =
    payload.title === undefined ? undefined : payload.title === null ? null : String(payload.title);
  const metadata =
    payload.metadata === undefined
      ? undefined
      : payload.metadata === null
        ? null
        : typeof payload.metadata === "object"
          ? (payload.metadata as Record<string, unknown>)
          : undefined;
  const session = updateSession(db, id, { title, metadata });
  if (!session) return { ok: false, error: "not_found" };
  writeEvent(db, { type: "chat.session.updated", data: { id } });
  return { ok: true, item: session };
});
app.post("/chat/sessions/:id/delete", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid session id" };
  const ok = deleteSession(db, id);
  if (!ok) return { ok: false, error: "not_found" };
  writeEvent(db, { type: "chat.session.deleted", data: { id } });
  return { ok: true };
});
app.delete("/chat/sessions/:id", ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid session id" };
  const ok = deleteSession(db, id);
  if (!ok) return { ok: false, error: "not_found" };
  writeEvent(db, { type: "chat.session.deleted", data: { id } });
  return { ok: true };
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
  const requestId =
    typeof payload.requestId === "string" && payload.requestId.trim()
      ? payload.requestId.trim()
      : undefined;
  const role =
    payload.role === "assistant" || payload.role === "system" ? payload.role : "user";
  const skipAgent = payload.skipAgent === true;
  if (!Number.isFinite(sessionId)) return { ok: false, error: "invalid session id" };
  if (!content.trim()) return { ok: false, error: "empty_message" };
  const session = getSession(db, sessionId);
  if (!session) return { ok: false, error: "session_not_found" };

  const messageId = addMessage(db, sessionId, role, content);
  writeEvent(db, {
    type: "chat.message.created",
    data: { id: messageId, sessionId, requestId: requestId ?? null }
  });

  if (role === "user") {
    const notes = extractUserMemoryNotes(content);
    for (const note of notes) {
      upsertAiUserNote(db, {
        subject: "primary_user",
        noteKey: note.noteKey,
        content: note.content,
        tags: note.tags,
        source: "auto_chat_memory"
      });
    }
    if (notes.length > 0) {
      writeEvent(db, {
        type: "user.memory.notes_upserted",
        data: {
          sessionId,
          messageId,
          count: notes.length,
          keys: notes.map((note) => note.noteKey)
        }
      });
    }
  }

  if (skipAgent || role !== "user") {
    return { ok: true, messageId };
  }

  const agentContext = {
    db,
    tools: toolRegistry.definitions,
    plugins,
    controlPlaneRoot: controlPlane.root,
    workspaceRoot,
    chatSessionId: sessionId,
    chatRequestId: requestId,
    handlerNames: Array.from(toolRegistry.handlers.keys()),
    onControlPlaneChanged: async () => {
      await rebuildRuntimeState();
    }
  };

  const history = listMessages(db, sessionId, 200);
  const messages = history.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content
  }));

  const modelOverride =
    payload.model && typeof payload.model === "string"
      ? payload.model
      : typeof session.metadata?.model === "string"
        ? session.metadata.model
        : undefined;
  const providerOverride =
    payload.provider && typeof payload.provider === "string"
      ? payload.provider
      : typeof session.metadata?.provider === "string"
        ? session.metadata.provider
        : undefined;
  let reply = await runAgentWithLLM(messages, agentContext, {
    model: modelOverride,
    provider: providerOverride
  });
  if (!reply) {
    reply = await runAgent(content, agentContext);
  }
  const assistantId = addMessage(db, sessionId, "assistant", reply.text, reply.metadata);
  writeEvent(db, {
    type: "chat.response.created",
    data: { id: assistantId, sessionId, requestId: requestId ?? null }
  });

  return {
    ok: true,
    messageId,
    assistantMessageId: assistantId,
    reply: reply.text
  };
});

app.post("/chat/stream", async ({ body }) => {
  const payload = asObject(body);
  const requestId =
    typeof payload.requestId === "string" && payload.requestId.trim()
      ? payload.requestId.trim()
      : undefined;
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
    chatSessionId: undefined as number | undefined,
    chatRequestId: requestId,
    handlerNames: Array.from(toolRegistry.handlers.keys()),
    onControlPlaneChanged: async () => {
      await rebuildRuntimeState();
    }
  };

  const sessionId = Number(payload.sessionId);
  const session = Number.isFinite(sessionId) ? getSession(db, sessionId) : null;
  if (session) agentContext.chatSessionId = session.id;
  const modelOverride =
    payload.model && typeof payload.model === "string"
      ? payload.model
      : typeof session?.metadata?.model === "string"
        ? session.metadata.model
        : undefined;
  const providerOverride =
    payload.provider && typeof payload.provider === "string"
      ? payload.provider
      : typeof session?.metadata?.provider === "string"
        ? session.metadata.provider
        : undefined;
  const result = await streamAgentWithLLM(messages, agentContext, {
    model: modelOverride,
    provider: providerOverride
  });
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

app.get("/script-db/tables", ({ request, set }) => {
  const session = getScriptDbSessionFromRequest(request);
  if (!session) {
    set.status = 401;
    return { ok: false, error: "invalid_or_expired_script_db_token" };
  }
  return {
    ok: true,
    readableTables: listDbTables(db),
    writableTables: session.writableTables
  };
});

app.post("/script-db/query", ({ body, request, set }) => {
  const session = getScriptDbSessionFromRequest(request);
  if (!session) {
    set.status = 401;
    return { ok: false, error: "invalid_or_expired_script_db_token" };
  }
  const payload = asObject(body);
  const sql = typeof payload.sql === "string" ? payload.sql : "";
  const params = Array.isArray(payload.params) ? payload.params : [];
  const maxRows =
    typeof payload.maxRows === "number" && Number.isFinite(payload.maxRows)
      ? Number(payload.maxRows)
      : undefined;
  const result = runReadOnlyQuery(db, sql, params, maxRows);
  if (!result.ok) {
    set.status = 400;
    return result;
  }
  writeAudit(db, {
    actor: "script",
    action: "script_db_read",
    metadata: {
      jobId: session.jobId,
      jobRunId: session.jobRunId,
      rowCount: result.rowCount
    }
  });
  return result;
});

app.post("/script-db/notes/upsert", ({ body, request, set }) => {
  const session = getScriptDbSessionFromRequest(request);
  if (!session) {
    set.status = 401;
    return { ok: false, error: "invalid_or_expired_script_db_token" };
  }
  if (!session.writableTables.includes("ai_user_notes")) {
    set.status = 403;
    return { ok: false, error: "write_not_allowed_for_table_ai_user_notes" };
  }
  const payload = asObject(body);
  const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
  const noteKey = typeof payload.noteKey === "string" ? payload.noteKey.trim() : "";
  const content = typeof payload.content === "string" ? payload.content : "";
  if (!subject || !noteKey || !content.trim()) {
    set.status = 400;
    return { ok: false, error: "subject_noteKey_content_required" };
  }
  const tags = Array.isArray(payload.tags) ? payload.tags.map((item) => String(item)) : undefined;
  const source = typeof payload.source === "string" ? payload.source : undefined;
  upsertAiUserNote(db, { subject, noteKey, content, tags, source });
  writeAudit(db, {
    actor: "script",
    action: "script_db_write_user_note",
    metadata: {
      jobId: session.jobId,
      jobRunId: session.jobRunId,
      subject,
      noteKey
    }
  });
  return { ok: true };
});

app.get("/script-db/notes", ({ query, request, set }) => {
  const session = getScriptDbSessionFromRequest(request);
  if (!session) {
    set.status = 401;
    return { ok: false, error: "invalid_or_expired_script_db_token" };
  }
  const subject = typeof query?.subject === "string" ? query.subject : undefined;
  const limit =
    typeof query?.limit === "string" && Number.isFinite(Number(query.limit))
      ? Number(query.limit)
      : 100;
  return {
    ok: true,
    items: listAiUserNotes(db, subject, limit)
  };
});

app.post("/script-db/memory/upsert", ({ body, request, set }) => {
  const session = getScriptDbSessionFromRequest(request);
  if (!session) {
    set.status = 401;
    return { ok: false, error: "invalid_or_expired_script_db_token" };
  }
  if (!session.writableTables.includes("ai_memory_store")) {
    set.status = 403;
    return { ok: false, error: "write_not_allowed_for_table_ai_memory_store" };
  }
  const payload = asObject(body);
  const ownerType = typeof payload.ownerType === "string" ? payload.ownerType.trim() : "";
  const ownerId = typeof payload.ownerId === "string" ? payload.ownerId.trim() : "";
  const namespace = typeof payload.namespace === "string" ? payload.namespace.trim() : "";
  const dataKey = typeof payload.dataKey === "string" ? payload.dataKey.trim() : "";
  if (!ownerType || !ownerId || !namespace || !dataKey) {
    set.status = 400;
    return { ok: false, error: "ownerType_ownerId_namespace_dataKey_required" };
  }
  upsertAiMemory(db, {
    ownerType,
    ownerId,
    namespace,
    dataKey,
    value: payload.value ?? null
  });
  writeAudit(db, {
    actor: "script",
    action: "script_db_write_memory",
    metadata: {
      jobId: session.jobId,
      jobRunId: session.jobRunId,
      ownerType,
      ownerId,
      namespace,
      dataKey
    }
  });
  return { ok: true };
});

app.get("/script-db/memory", ({ query, request, set }) => {
  const session = getScriptDbSessionFromRequest(request);
  if (!session) {
    set.status = 401;
    return { ok: false, error: "invalid_or_expired_script_db_token" };
  }
  const limit =
    typeof query?.limit === "string" && Number.isFinite(Number(query.limit))
      ? Number(query.limit)
      : 100;
  return {
    ok: true,
    items: listAiMemory(db, {
      ownerType: typeof query?.ownerType === "string" ? query.ownerType : undefined,
      ownerId: typeof query?.ownerId === "string" ? query.ownerId : undefined,
      namespace: typeof query?.namespace === "string" ? query.namespace : undefined,
      dataKey: typeof query?.dataKey === "string" ? query.dataKey : undefined,
      limit
    })
  };
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
  const audit = repairAuditIntegrity(db);
  await rebuildRuntimeState();
  writeAudit(db, {
    actor: "system",
    action: "diagnostics_repair_executed"
  });
  return {
    ok: true,
    repaired: [
      "runtime_reloaded",
      "jobs_seeded",
      ...(audit.repaired > 0 ? [`audit_rehashed:${audit.repaired}`] : [])
    ]
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
app.get("/ui/config", () => ({ ok: true, config: uiConfig }));
app.post("/widgets/resolve-props", ({ body }) => {
  const payload = asObject(body);
  const props =
    payload.props && typeof payload.props === "object"
      ? (payload.props as Record<string, unknown>)
      : null;
  if (!props) return { ok: false, error: "props_required" };

  const resolvedSecrets = new Set<string>();
  const resolved = resolveWidgetSecretPlaceholders(props, 0, resolvedSecrets);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  if (resolvedSecrets.size > 0) {
    writeAudit(db, {
      actor: "user",
      action: "widget_props_secret_resolved",
      metadata: {
        secretCount: resolvedSecrets.size,
        secrets: Array.from(resolvedSecrets).sort()
      }
    });
  }

  return {
    ok: true,
    props: resolved.value,
    resolvedSecrets: Array.from(resolvedSecrets).sort()
  };
});

app.post("/terminal/sessions", ({ body, set }) => {
  const payload = asObject(body);
  const command = typeof payload.command === "string" ? payload.command.trim() : "";
  if (!command) return { ok: false, error: "command_required" };
  if (command.length > MAX_TERMINAL_COMMAND) return { ok: false, error: "command_too_long" };
  if (/[\r\n\0]/.test(command)) return { ok: false, error: "invalid_command" };

  const cwdInput = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const cwd = resolveTerminalCwd(cwdInput);
  if (!cwd) return { ok: false, error: "invalid_cwd" };

  const allowInput = payload.allowInput === true;
  pruneTerminalSessions();
  const sessionId = randomUUID();
  const createdAt = new Date().toISOString();
  try {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        FORCE_COLOR: "0"
      }
    });
    const session: TerminalSession = {
      id: sessionId,
      createdAt,
      command,
      cwd,
      allowInput,
      process: child,
      events: [],
      nextCursor: 0,
      closed: false,
      exitCode: null
    };
    terminalSessions.set(sessionId, session);

    appendTerminalEvent(session, "status", `$ ${command}`);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      appendTerminalEvent(session, "stdout", typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      appendTerminalEvent(session, "stderr", typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      appendTerminalEvent(session, "stderr", `spawn_failed: ${error.message}`);
      closeTerminalSession(session, null);
    });
    child.on("exit", (code) => {
      closeTerminalSession(session, typeof code === "number" ? code : null);
    });

    writeAudit(db, {
      actor: "user",
      action: "terminal_session_started",
      metadata: { sessionId, command, cwd, allowInput }
    });
    writeEvent(db, {
      type: "terminal.session.started",
      data: { sessionId, command, cwd, allowInput }
    });
    return { ok: true, sessionId, createdAt };
  } catch (error) {
    set.status = 400;
    return {
      ok: false,
      error: error instanceof Error ? error.message : "terminal_spawn_failed"
    };
  }
});

app.get("/terminal/sessions/:id/events", ({ params, query }) => {
  const id = String(params.id ?? "");
  const session = terminalSessions.get(id);
  if (!session) return { ok: false, error: "session_not_found" };
  const cursorInput = Number(query?.cursor ?? 0);
  const cursor = Number.isFinite(cursorInput) && cursorInput >= 0 ? Math.floor(cursorInput) : 0;
  const events = session.events.filter((event) => event.cursor >= cursor);
  return {
    ok: true,
    sessionId: session.id,
    events,
    nextCursor: session.nextCursor,
    closed: session.closed,
    exitCode: session.exitCode
  };
});

app.post("/terminal/sessions/:id/input", ({ params, body }) => {
  const id = String(params.id ?? "");
  const session = terminalSessions.get(id);
  if (!session) return { ok: false, error: "session_not_found" };
  if (!session.allowInput) return { ok: false, error: "input_not_allowed" };
  if (session.closed) return { ok: false, error: "session_closed" };

  const payload = asObject(body);
  const data = typeof payload.data === "string" ? payload.data : "";
  if (!data) return { ok: false, error: "input_required" };
  if (data.length > MAX_TERMINAL_INPUT) return { ok: false, error: "input_too_large" };
  session.process.stdin.write(data);
  return { ok: true };
});

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

app.get("/connectors/codex/status", () => {
  const codex = getCodexTokenState();
  return {
    ok: true,
    connected: Boolean(codex.accessToken && codex.accountId),
    provider: codex.accessToken ? "openai_oauth_codex" : null,
    accountId: codex.accountId || null,
    expiresAt: codex.expiresAt,
    refreshConfigured: Boolean(codex.refreshToken)
  };
});

app.get("/connectors/codex/oauth/start", async ({ set }) => {
  const redirectUri =
    process.env.OPENCORPO_CODEX_REDIRECT_URI ??
    CODEX_DEFAULT_REDIRECT_URI;
  const started = createCodexOauthStart(redirectUri);
  if (redirectUri === CODEX_DEFAULT_REDIRECT_URI) {
    const callbackServer = await startCodexCallbackServer({
      state: started.state,
      onCallback: async ({ code, state }) => {
        const completed = await completeCodexOauth(code, state, redirectUri);
        return completed.ok ? { ok: true } : completed;
      }
    }).catch((err) => {
      const code = (err as { code?: string } | null)?.code ?? "";
      const suffix = code ? `:${code}` : "";
      return { error: `codex_callback_server_start_failed${suffix}` };
    });
    if ("error" in callbackServer) {
      set.status = 500;
      return { ok: false, error: callbackServer.error };
    }
    if (callbackServer.redirectUri !== redirectUri) {
      set.status = 500;
      return { ok: false, error: "codex_callback_redirect_mismatch" };
    }
  }
  return {
    ok: true,
    authUrl: started.authUrl,
    redirectUri
  };
});

app.get("/oauth/openai/callback", async ({ query, set }) => {
  const code = typeof query?.code === "string" ? query.code.trim() : "";
  const state = typeof query?.state === "string" ? query.state.trim() : "";
  const redirectUri =
    process.env.OPENCORPO_CODEX_REDIRECT_URI ??
    `http://127.0.0.1:${daemonPort}/oauth/openai/callback`;
  if (!code) {
    set.status = 400;
    return { ok: false, error: "missing_oauth_code" };
  }
  if (!state) {
    set.status = 400;
    return { ok: false, error: "missing_oauth_state" };
  }
  const result = await completeCodexOauth(code, state, redirectUri);
  if (!result.ok) {
    set.status = 400;
    return result;
  }
  return {
    ok: true,
    message: "ChatGPT subscription connected. You can return to OpenCorpo."
  };
});

app.post("/connectors/codex/disconnect", () => {
  setSecretRef(db, { name: "ai.codex.access_token", value: "", provider: "local_file" });
  setSecretRef(db, { name: "ai.codex.refresh_token", value: "", provider: "local_file" });
  setSecretRef(db, { name: "ai.codex.expires_at", value: "", provider: "local_file" });
  setSecretRef(db, { name: "ai.codex.account_id", value: "", provider: "local_file" });
  if ((process.env.OPENCORPO_AI_PROVIDER ?? "").trim().toLowerCase() === "codex") {
    setSecretRef(db, { name: "ai.provider", value: "local", provider: "local_file" });
    process.env.OPENCORPO_AI_PROVIDER = "local";
  }
  process.env.OPENCORPO_CODEX_ACCESS_TOKEN = "";
  process.env.OPENCORPO_CODEX_ACCOUNT_ID = "";
  writeAudit(db, { actor: "user", action: "codex_oauth_disconnected" });
  writeEvent(db, { type: "connector.codex.disconnected", data: {} });
  return { ok: true };
});

app.get("/secrets", ({ query }) => {
  const limit = query?.limit ? Number(query.limit) : 100;
  return {
    ok: true,
    items: listSecrets(db, limit)
  };
});

app.get("/secrets/script", () => {
  const items = listSecrets(db, 500)
    .filter((item: any) => typeof item.name === "string" && item.name.startsWith("script."))
    .map((item: any) => {
      const metadata =
        item.metadata && typeof item.metadata === "object"
          ? (item.metadata as Record<string, unknown>)
          : {};
      return {
        name: String(item.name),
        ref: String(item.ref),
        provider: String(item.provider),
        updatedAt: String(item.updated_at),
        description:
          typeof metadata.description === "string" ? metadata.description : ""
      };
    })
    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
  return { ok: true, items };
});

app.post("/secrets/script", ({ body }) => {
  const payload = asObject(body);
  const rawName = typeof payload.name === "string" ? payload.name : "";
  const value =
    typeof payload.value === "string" ? normalizeSecretInput(payload.value) : "";
  const description =
    typeof payload.description === "string" ? payload.description.trim() : "";
  if (!rawName.trim()) return { ok: false, error: "name_required" };
  if (!value) return { ok: false, error: "value_required" };
  const normalizedName = normalizeScriptSecretName(rawName);
  if (!normalizedName) return { ok: false, error: "invalid_name" };
  const name = `script.${normalizedName}`;
  const saved = setSecretRef(db, {
    name,
    value,
    provider: "local_file",
    metadata: {
      description,
      scope: "script_secret"
    }
  });
  writeAudit(db, {
    actor: "user",
    action: "script_secret_saved",
    metadata: { name }
  });
  return {
    ok: true,
    item: {
      name,
      ref: saved.ref,
      description
    }
  };
});

app.get("/settings/script-execution-mode", () => {
  return {
    ok: true,
    mode: getScriptExecutionMode(db)
  };
});

app.post("/settings/script-execution-mode", ({ body }) => {
  const payload = asObject(body);
  const mode = normalizeScriptExecutionMode(payload.mode);
  const previous = getScriptExecutionMode(db);
  setScriptExecutionMode(db, mode);
  writeAudit(db, {
    actor: "user",
    action: "script_execution_mode_updated",
    metadata: { previous, next: mode }
  });
  writeEvent(db, {
    type: "settings.script_execution_mode.updated",
    data: { previous, next: mode }
  });
  return { ok: true, mode };
});

app.get("/secrets/ai-key/status", () => {
  const codex = getCodexTokenState();
  const hasKey = Boolean(
    process.env.AI_GATEWAY_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.ANTHROPIC_API_KEY ??
      process.env.VERCEL_AI_API_KEY ??
      getSecretValue(db, "ai.api_key") ??
      getSecretValue(db, "ai.api_key.openai") ??
      getSecretValue(db, "ai.api_key.anthropic") ??
      getSecretValue(db, "ai.api_key.gateway") ??
      (codex.accessToken && codex.accountId ? "codex" : "")
  );
  const provider =
    process.env.OPENCORPO_AI_PROVIDER ??
    getSecretValue(db, "ai.provider") ??
    null;
  return { ok: true, configured: hasKey, provider };
});

app.get("/secrets/ai/providers", async () => {
  const defaults = readAiModelDefaults();
  const preferredProvider = normalizeProviderName(
    process.env.OPENCORPO_AI_PROVIDER ?? getSecretValue(db, "ai.provider")
  );
  const legacyKey = (
    process.env.AI_GATEWAY_API_KEY ??
    process.env.VERCEL_AI_API_KEY ??
    getSecretValue(db, "ai.api_key") ??
    ""
  ).trim();
  const openAiKey = getProviderApiKey("openai", preferredProvider, legacyKey).trim();
  const anthropicKey = getProviderApiKey("anthropic", preferredProvider, legacyKey).trim();
  const gatewayKey = getProviderApiKey("gateway", preferredProvider, legacyKey).trim();
  const codex = getCodexTokenState();
  const codexConfigured = Boolean(codex.accessToken && codex.accountId);

  const [openAiModels, anthropicModels] = await Promise.all([
    openAiKey ? listOpenAiModels(openAiKey) : Promise.resolve([]),
    anthropicKey ? listAnthropicModels(anthropicKey) : Promise.resolve([])
  ]);

  const providers = [
    {
      id: "openai",
      label: "OpenAI",
      configured: Boolean(openAiKey),
      defaultModel: defaults.openai,
      models: dedupeModels(openAiModels, defaults.openai)
    },
    {
      id: "anthropic",
      label: "Anthropic",
      configured: Boolean(anthropicKey),
      defaultModel: defaults.anthropic,
      models: dedupeModels(anthropicModels, defaults.anthropic)
    },
    {
      id: "local",
      label: "Local / BYOK",
      configured:
        preferredProvider === "local" || Boolean(defaults.local) || Boolean(gatewayKey),
      defaultModel: defaults.local,
      models: dedupeModels(
        (process.env.OPENCORPO_LOCAL_MODELS ?? "")
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean),
        defaults.local
      )
    },
    {
      id: "codex",
      label: "Codex (ChatGPT Subscription)",
      configured: codexConfigured,
      defaultModel: defaults.codex,
      models: dedupeModels(CODEX_MODELS, defaults.codex)
    },
    {
      id: "gateway",
      label: "Gateway",
      configured: Boolean(gatewayKey),
      defaultModel: "",
      models: []
    }
  ].filter((provider) => provider.configured);

  const defaultProvider =
    preferredProvider && providers.some((provider) => provider.id === preferredProvider)
      ? preferredProvider
      : providers[0]?.id ?? null;

  return {
    ok: true,
    defaultProvider,
    providers: providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      defaultModel:
        provider.defaultModel ||
        provider.models[0] ||
        (provider.id === "openai"
          ? "gpt-5.2-chat-latest"
          : provider.id === "codex"
            ? "gpt-5.2-codex"
          : provider.id === "local"
            ? "anthropic/claude-sonnet-4.5"
            : ""),
      models: provider.models
    }))
  };
});

app.get("/profile", () => {
  const raw = getSecretValue(db, "user.profile");
  if (!raw) {
    return {
      ok: true,
      profile: {
        name: "",
        role: "",
        jobTitle: "",
        about: ""
      }
    };
  }
  try {
    const profile = JSON.parse(raw) as Record<string, unknown>;
    return {
      ok: true,
      profile: {
        name: typeof profile.name === "string" ? profile.name : "",
        role: typeof profile.role === "string" ? profile.role : "",
        jobTitle: typeof profile.jobTitle === "string" ? profile.jobTitle : "",
        about: typeof profile.about === "string" ? profile.about : ""
      }
    };
  } catch {
    return {
      ok: true,
      profile: {
        name: "",
        role: "",
        jobTitle: "",
        about: ""
      }
    };
  }
});

app.post("/profile", ({ body }) => {
  const payload = asObject(body);
  const profile = {
    name: typeof payload.name === "string" ? payload.name.trim() : "",
    role: typeof payload.role === "string" ? payload.role.trim() : "",
    jobTitle: typeof payload.jobTitle === "string" ? payload.jobTitle.trim() : "",
    about: typeof payload.about === "string" ? payload.about.trim() : ""
  };
  setSecretRef(db, {
    name: "user.profile",
    value: JSON.stringify(profile),
    provider: "local_file"
  });
  writeAudit(db, { actor: "user", action: "user_profile_saved" });
  return { ok: true, profile };
});

app.get("/secrets/ai-model-defaults", () => {
  return { ok: true, defaults: readAiModelDefaults() };
});

app.post("/secrets/ai-model-defaults", ({ body }) => {
  const payload = asObject(body);
  const defaults = {
    anthropic: typeof payload.anthropic === "string" ? payload.anthropic.trim() : "",
    openai: typeof payload.openai === "string" ? payload.openai.trim() : "",
    local: typeof payload.local === "string" ? payload.local.trim() : "",
    codex: typeof payload.codex === "string" ? payload.codex.trim() : ""
  };
  setSecretRef(db, {
    name: "ai.model_defaults",
    value: JSON.stringify(defaults),
    provider: "local_file"
  });
  writeAudit(db, { actor: "user", action: "ai_model_defaults_saved" });
  return { ok: true, defaults };
});

app.post("/secrets/ai-key", ({ body }) => {
  const payload = asObject(body);
  const value =
    typeof payload.value === "string" ? normalizeSecretInput(payload.value) : "";
  const provider = normalizeProviderName(
    typeof payload.provider === "string" ? payload.provider : ""
  );
  if (!value) return { ok: false, error: "value_required" };
  setSecretRef(db, { name: "ai.api_key", value });
  if (provider) {
    if (provider === "openai" || provider === "anthropic" || provider === "gateway") {
      setSecretRef(db, { name: `ai.api_key.${provider}`, value });
    }
    setSecretRef(db, { name: "ai.provider", value: provider });
    process.env.OPENCORPO_AI_PROVIDER = provider;
  }
  // Make key available immediately for this daemon process.
  process.env.AI_GATEWAY_API_KEY = value;
  process.env.VERCEL_AI_API_KEY = value;
  if (provider === "openai") {
    process.env.OPENAI_API_KEY = value;
  }
  if (provider === "anthropic") {
    process.env.ANTHROPIC_API_KEY = value;
  }
  return { ok: true };
});

app.post("/secrets/ai-provider", ({ body }) => {
  const payload = asObject(body);
  const provider = typeof payload.provider === "string" ? payload.provider.trim().toLowerCase() : "";
  if (!provider) return { ok: false, error: "provider_required" };
  const valid = ["openai", "anthropic", "local", "gateway", "codex"];
  if (!valid.includes(provider)) return { ok: false, error: "invalid_provider" };
  setSecretRef(db, { name: "ai.provider", value: provider, provider: "local_file" });
  process.env.OPENCORPO_AI_PROVIDER = provider;
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
    migrationVersion: migrations.currentVersion,
    auditRepaired: auditRepair.repaired
  }
});

console.log(
  `OpenCorpo daemon running on http://127.0.0.1:${daemonPort}`
);
