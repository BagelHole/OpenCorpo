import { tool } from "ai";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentContext, AgentToolEvent } from "./agent";
import { schemaRoot } from "./paths";
import {
  buildApprovalsList,
  buildAuditList,
  buildDataSourceHint,
  buildHelpText,
  buildJobRunsList,
  buildJobsList,
  buildPluginsList,
  buildStatusSummary,
  buildToolsList,
  handleApprovalAction,
  handleApprovalDetail,
  handleAuditDetail,
  handleJobDetail,
  handleJobRun,
  handleJobRunByName,
  handleJobRunDetail,
  handleJobToggle,
  handleToolDetail,
  handleToolRunDetail
} from "./agent";
import { createApproval } from "./approvals";
import { writeAudit } from "./audit";
import { attachCodeChangeApproval, proposeCodeChange } from "./code-change-proposals";
import {
  applyControlPlaneChange,
  listControlPlaneChanges,
  proposeControlPlaneChange
} from "./control-plane-changes";
import { writeEvent } from "./events";
import {
  listAiMemory,
  listAiUserNotes,
  listDbTables,
  runReadOnlyQuery,
  upsertAiMemory,
  upsertAiUserNote
} from "./agent-memory";
import { runHttpGet, runWebSearch } from "./web-tools";

const TOOL_SCHEMA_JSON = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["name", "version", "risk", "capabilities"],
  "properties": {
    "name": { "type": "string" },
    "version": { "type": "string" },
    "risk": { "type": "string", "enum": ["low", "medium", "high"] },
    "capabilities": { "type": "array", "items": { "type": "string" } },
    "inputs": { "type": "object" },
    "outputs": { "type": "object" }
  },
  "additionalProperties": true
}`;

function normalizeControlPlanePath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized.endsWith(".json")) return null;
  if (normalized.includes("..")) return null;
  return normalized;
}

function isSafeWidgetPackageSpec(value: string) {
  const spec = value.trim();
  if (!spec || spec.length > 160) return false;
  if (/\s/.test(spec)) return false;
  if (
    spec.includes(":") ||
    spec.includes("#") ||
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("\\")
  ) {
    return false;
  }
  return /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:@[A-Za-z0-9*^~<>=|.-]+)?$/.test(spec);
}

function parseWidgetPackageSpec(spec: string) {
  const trimmed = spec.trim();
  if (!trimmed) return { name: "", version: "" };
  if (trimmed.startsWith("@")) {
    const secondAt = trimmed.indexOf("@", 1);
    return secondAt > 0
      ? { name: trimmed.slice(0, secondAt), version: trimmed.slice(secondAt + 1) }
      : { name: trimmed, version: "" };
  }
  const at = trimmed.indexOf("@");
  return at > 0
    ? { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) }
    : { name: trimmed, version: "" };
}

async function npmPackageExists(spec: string) {
  if (!isSafeWidgetPackageSpec(spec)) {
    return { ok: false as const, error: `invalid package spec: ${spec}` };
  }
  const { name, version } = parseWidgetPackageSpec(spec);
  if (!name) return { ok: false as const, error: `invalid package name in spec: ${spec}` };
  const encodedName = encodeURIComponent(name);
  const encodedVersion = version ? `/${encodeURIComponent(version)}` : "";
  const url = `https://registry.npmjs.org/${encodedName}${encodedVersion}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.ok) return { ok: true as const };
    if (response.status === 404) {
      return { ok: false as const, error: `npm package not found: ${spec}` };
    }
    return { ok: false as const, error: `npm registry lookup failed for ${spec} (${response.status})` };
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof Error
          ? `npm registry lookup failed for ${spec}: ${error.message}`
          : `npm registry lookup failed for ${spec}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

type NpmPackageMetadataResult =
  | { ok: true; metadata: Record<string, unknown> }
  | { ok: false; error: string };

async function fetchNpmPackageMetadata(spec: string): Promise<NpmPackageMetadataResult> {
  if (!isSafeWidgetPackageSpec(spec)) {
    return { ok: false, error: `invalid package spec: ${spec}` };
  }
  const { name, version } = parseWidgetPackageSpec(spec);
  if (!name) return { ok: false, error: `invalid package name in spec: ${spec}` };
  const encodedName = encodeURIComponent(name);
  const encodedVersion = version ? `/${encodeURIComponent(version)}` : "";
  const url = `https://registry.npmjs.org/${encodedName}${encodedVersion}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      if (response.status === 404) return { ok: false, error: `npm package not found: ${spec}` };
      return { ok: false, error: `npm registry lookup failed for ${spec} (${response.status})` };
    }
    const metadata = (await response.json()) as Record<string, unknown>;
    return { ok: true, metadata };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `npm registry lookup failed for ${spec}: ${error.message}`
          : `npm registry lookup failed for ${spec}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function tokenizeShellCommand(command: string) {
  return command
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseNpxPackageFromCommand(command: string) {
  const tokens = tokenizeShellCommand(command);
  if (tokens.length < 2) return null;
  const head = tokens[0]?.toLowerCase();
  if (head !== "npx" && head !== "npm") return null;
  if (head === "npm") {
    if (tokens[1]?.toLowerCase() !== "exec") return null;
    let index = 2;
    while (index < tokens.length) {
      const token = tokens[index];
      if (!token) break;
      if (token === "--") {
        index += 1;
        break;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
    const spec = tokens[index];
    return spec && isSafeWidgetPackageSpec(spec) ? spec : null;
  }
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const spec = tokens[index];
  return spec && isSafeWidgetPackageSpec(spec) ? spec : null;
}

async function validateWidgetPackageBrowserCompatibility(spec: string) {
  if (!isSafeWidgetPackageSpec(spec)) {
    return { ok: false as const, error: `invalid package spec: ${spec}` };
  }
  const url = `https://esm.sh/${spec}?target=es2022&external=react,react-dom`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false as const,
        error: `could not inspect widget package runtime for ${spec} (${response.status})`
      };
    }
    const source = await response.text();
    const terminalSignals = [
      "/node/process.mjs",
      "__Process$.stdin",
      "process.stdin",
      "stdin.setRawMode",
      "TerminalRenderer",
      "console.clear()",
      "SIGINT"
    ];
    const matched = terminalSignals.filter((signal) => source.includes(signal));
    if (matched.length > 0) {
      return {
        ok: false as const,
        error: `package is not browser-widget compatible (node/terminal runtime detected): ${spec}`
      };
    }
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof Error
          ? `failed to inspect widget package runtime for ${spec}: ${error.message}`
          : `failed to inspect widget package runtime for ${spec}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function collectUiReactWidgetPackageSpecs(doc: Record<string, unknown>) {
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  const packageSpecs = new Set<string>();
  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    const blocks = Array.isArray((page as Record<string, unknown>).blocks)
      ? ((page as Record<string, unknown>).blocks as Array<Record<string, unknown>>)
      : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type !== "react_widget") continue;
      const pkg = typeof block.package === "string" ? block.package.trim() : "";
      if (pkg) packageSpecs.add(pkg);
    }
  }
  return packageSpecs;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mergeUiWithExisting(
  afterJson: Record<string, unknown>,
  beforeJson: Record<string, unknown> | null
) {
  if (!beforeJson) return afterJson;

  const merged: Record<string, unknown> = { ...beforeJson, ...afterJson };

  const beforeTheme = asRecord(beforeJson.theme);
  const afterTheme = asRecord(afterJson.theme);
  if (beforeTheme || afterTheme) {
    const mergedTheme: Record<string, unknown> = { ...(beforeTheme ?? {}), ...(afterTheme ?? {}) };
    const beforeLight = asRecord(beforeTheme?.light);
    const afterLight = asRecord(afterTheme?.light);
    if (beforeLight || afterLight) {
      mergedTheme.light = { ...(beforeLight ?? {}), ...(afterLight ?? {}) };
    }
    const beforeDark = asRecord(beforeTheme?.dark);
    const afterDark = asRecord(afterTheme?.dark);
    if (beforeDark || afterDark) {
      mergedTheme.dark = { ...(beforeDark ?? {}), ...(afterDark ?? {}) };
    }
    merged.theme = mergedTheme;
  }

  const beforeSidebar = asRecord(beforeJson.sidebar);
  const afterSidebar = asRecord(afterJson.sidebar);
  if (beforeSidebar || afterSidebar) {
    const mergedSidebar: Record<string, unknown> = { ...(beforeSidebar ?? {}), ...(afterSidebar ?? {}) };
    const beforeItems = Array.isArray(beforeSidebar?.items)
      ? (beforeSidebar!.items as unknown[])
      : [];
    const afterItems = Array.isArray(afterSidebar?.items) ? (afterSidebar!.items as unknown[]) : [];
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    const mergedItems: unknown[] = [];

    const addItem = (value: unknown) => {
      const row = asRecord(value);
      if (!row) return;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const path = typeof row.path === "string" ? row.path.trim() : "";
      if (!id || !path) return;
      if (seenIds.has(id) || seenPaths.has(path)) return;
      seenIds.add(id);
      seenPaths.add(path);
      mergedItems.push(row);
    };

    for (const item of afterItems) addItem(item);
    for (const item of beforeItems) addItem(item);
    mergedSidebar.items = mergedItems;
    merged.sidebar = mergedSidebar;
  }

  const beforePages = Array.isArray(beforeJson.pages) ? (beforeJson.pages as unknown[]) : [];
  const afterPages = Array.isArray(afterJson.pages) ? (afterJson.pages as unknown[]) : [];
  const mergedPages: unknown[] = [];
  const seenPageIds = new Set<string>();

  const addPage = (value: unknown) => {
    const row = asRecord(value);
    if (!row) return;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || seenPageIds.has(id)) return;
    seenPageIds.add(id);
    mergedPages.push(row);
  };

  for (const page of afterPages) addPage(page);
  for (const page of beforePages) addPage(page);
  merged.pages = mergedPages;

  return merged;
}

async function validateUiReactWidgetPackages(
  afterJson: Record<string, unknown>,
  beforeJson?: Record<string, unknown> | null
) {
  const packageSpecs = collectUiReactWidgetPackageSpecs(afterJson);
  const beforeSpecs = beforeJson ? collectUiReactWidgetPackageSpecs(beforeJson) : new Set<string>();
  const specsToValidate = Array.from(packageSpecs).filter((spec) => !beforeSpecs.has(spec));

  if (specsToValidate.length === 0) return [] as string[];
  if (packageSpecs.size === 0) return [] as string[];
  const errors: string[] = [];
  for (const spec of specsToValidate) {
    const found = await npmPackageExists(spec);
    if (!found.ok) {
      errors.push(found.error);
      continue;
    }
    const compatibility = await validateWidgetPackageBrowserCompatibility(spec);
    if (!compatibility.ok) errors.push(compatibility.error);
  }
  return errors;
}

function collectUiTerminalWidgetNpxSpecs(doc: Record<string, unknown>) {
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  const out = new Set<string>();
  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    const blocks = Array.isArray((page as Record<string, unknown>).blocks)
      ? ((page as Record<string, unknown>).blocks as Array<Record<string, unknown>>)
      : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type !== "terminal_widget") continue;
      const command = typeof block.command === "string" ? block.command.trim() : "";
      if (!command) continue;
      const npxSpec = parseNpxPackageFromCommand(command);
      if (npxSpec) out.add(npxSpec);
    }
  }
  return out;
}

async function validateUiTerminalWidgetCommands(
  afterJson: Record<string, unknown>,
  beforeJson?: Record<string, unknown> | null
) {
  const specs = collectUiTerminalWidgetNpxSpecs(afterJson);
  if (specs.size === 0) return [] as string[];
  const beforeSpecs = beforeJson ? collectUiTerminalWidgetNpxSpecs(beforeJson) : new Set<string>();
  const specsToValidate = Array.from(specs).filter((spec) => !beforeSpecs.has(spec));
  if (specsToValidate.length === 0) return [] as string[];

  const errors: string[] = [];
  for (const spec of specsToValidate) {
    const metadata = await fetchNpmPackageMetadata(spec);
    if (!metadata.ok) {
      errors.push(metadata.error);
      continue;
    }
    const bin = metadata.metadata.bin;
    const hasBin =
      typeof bin === "string" ||
      (bin && typeof bin === "object" && Object.keys(bin as Record<string, unknown>).length > 0);
    if (!hasBin) {
      errors.push(
        `terminal_widget command uses npx package without executable bin: ${spec}. Choose a CLI package (with bin) or use react_widget for browser components.`
      );
    }
  }
  return errors;
}

function toPreview(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value.slice(0, 220);
  try {
    return JSON.stringify(value).slice(0, 220);
  } catch {
    return String(value).slice(0, 220);
  }
}

function emitToolEvent(context: AgentContext, event: AgentToolEvent) {
  context.onAgentToolEvent?.(event);
  writeEvent(context.db, {
    type: `agent.tool.${event.phase}`,
    data: {
      phase: event.phase,
      tool: event.tool,
      at: event.at,
      requestId: event.requestId ?? null,
      sessionId: event.sessionId ?? null,
      inputPreview: event.inputPreview ?? null,
      outputPreview: event.outputPreview ?? null,
      error: event.error ?? null
    }
  });
}

function withToolTelemetry<TInput, TResult>(
  context: AgentContext,
  toolName: string,
  execute: (input: TInput) => Promise<TResult> | TResult
) {
  return async (input: TInput): Promise<TResult> => {
    const startedAt = new Date().toISOString();
    emitToolEvent(context, {
      phase: "started",
      tool: toolName,
      at: startedAt,
      requestId: context.chatRequestId,
      sessionId: context.chatSessionId,
      inputPreview: toPreview(input)
    });
    try {
      const output = await execute(input);
      emitToolEvent(context, {
        phase: "completed",
        tool: toolName,
        at: new Date().toISOString(),
        requestId: context.chatRequestId,
        sessionId: context.chatSessionId,
        outputPreview: toPreview(output)
      });
      return output;
    } catch (error) {
      emitToolEvent(context, {
        phase: "failed",
        tool: toolName,
        at: new Date().toISOString(),
        requestId: context.chatRequestId,
        sessionId: context.chatSessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };
}

function formatUiValidationHelp(details: string[] | undefined) {
  const base = (details ?? []).join("; ");
  const hasOneOf = (details ?? []).some((line) => line.includes("oneOf"));
  if (!hasOneOf) return base;
  const help = [
    "UI block validation hint:",
    'Top-level theme shape: {"theme":{"light":{"accent":"#111"},"dark":{"accent":"#fafafa"}}}.',
    "Supported block types: markdown, stats, list, note, key_value, job_results, job_table, actions, react_widget, terminal_widget, web_embed, html_embed.",
    'Valid actions block shape: {"type":"actions","buttons":[{"label":"Run","action":{"type":"run_job","jobName":"my-job"}}]}',
    'Valid open_url button shape: {"label":"Docs","action":{"type":"open_url","url":"https://example.com"}}',
    'Valid react_widget shape: {"type":"react_widget","package":"pkg@1.2.3","exportName":"Widget","props":{},"height":420}',
    'Valid terminal_widget shape: {"type":"terminal_widget","command":"npx -y pkg","cwd":"userland","height":320,"allowInput":true}',
    'Valid web_embed shape: {"type":"web_embed","url":"https://example.com/embed","height":700}',
    'Valid html_embed shape: {"type":"html_embed","title":"Custom","html":"<!doctype html><html><body><h1>Hello</h1></body></html>","height":700}'
  ].join(" ");
  return base ? `${base} ${help}` : help;
}

export function buildAgentTools(context: AgentContext) {
  return {
    get_status: tool({
      description: "Get a summary of OpenCorpo's current state (approvals, jobs, tools, plugins, latest audit). Use this when the user asks about status, what's going on, or needs an overview.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "get_status", async () => buildStatusSummary(context))
    }),

    get_approvals: tool({
      description: "List pending or all approvals. Use when user asks about approvals, pending items, or what needs attention.",
      inputSchema: z.object({
        pending_only: z.boolean().optional().describe("If true, only show pending approvals")
      }),
      execute: withToolTelemetry(context, "get_approvals", async ({ pending_only }) =>
        buildApprovalsList(context.db, pending_only ?? true))
    }),

    approve: tool({
      description: "Approve a pending approval by ID. Use when user says to approve something.",
      inputSchema: z.object({
        approval_id: z.number().describe("The approval ID to approve")
      }),
      execute: withToolTelemetry(context, "approve", async ({ approval_id }) =>
        handleApprovalAction(context.db, approval_id, "approved").text)
    }),

    deny: tool({
      description: "Deny a pending approval by ID. Use when user says to deny something.",
      inputSchema: z.object({
        approval_id: z.number().describe("The approval ID to deny")
      }),
      execute: withToolTelemetry(context, "deny", async ({ approval_id }) =>
        handleApprovalAction(context.db, approval_id, "denied").text)
    }),

    list_jobs: tool({
      description: "List all jobs. Use when user asks about jobs, schedules, or automations.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "list_jobs", async () => buildJobsList(context.db))
    }),

    list_job_runs: tool({
      description: "List recent job runs. Use when user asks about job runs, execution history.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "list_job_runs", async () => buildJobRunsList(context.db))
    }),

    run_job: tool({
      description: "Run a job by ID or name. Use when user wants to run/execute a job.",
      inputSchema: z.object({
        job_id: z.number().optional().describe("Job ID to run"),
        job_name: z.string().optional().describe("Job name to run (e.g. heartbeat)")
      }),
      execute: withToolTelemetry(context, "run_job", async ({ job_id, job_name }) => {
        if (job_id != null) return handleJobRun(context.db, job_id).text;
        if (job_name) return handleJobRunByName(context.db, job_name).text;
        return "Specify job_id or job_name to run a job.";
      })
    }),

    enable_job: tool({
      description: "Enable a job by ID.",
      inputSchema: z.object({ job_id: z.number() }),
      execute: withToolTelemetry(context, "enable_job", async ({ job_id }) =>
        handleJobToggle(context.db, job_id, true).text)
    }),

    disable_job: tool({
      description: "Disable a job by ID.",
      inputSchema: z.object({ job_id: z.number() }),
      execute: withToolTelemetry(context, "disable_job", async ({ job_id }) =>
        handleJobToggle(context.db, job_id, false).text)
    }),

    list_audit: tool({
      description: "List recent audit log entries. Use when user asks about audit, history, or what happened.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "list_audit", async () => buildAuditList(context.db))
    }),

    get_audit_detail: tool({
      description: "Get details of a specific audit entry by ID.",
      inputSchema: z.object({ audit_id: z.number() }),
      execute: withToolTelemetry(context, "get_audit_detail", async ({ audit_id }) =>
        handleAuditDetail(context.db, audit_id).text)
    }),

    get_job_run_detail: tool({
      description: "Get details of a specific job run by ID.",
      inputSchema: z.object({ job_run_id: z.number() }),
      execute: withToolTelemetry(context, "get_job_run_detail", async ({ job_run_id }) =>
        handleJobRunDetail(context.db, job_run_id).text)
    }),

    get_tool_run_detail: tool({
      description: "Get details of a specific tool run by ID.",
      inputSchema: z.object({ tool_run_id: z.number() }),
      execute: withToolTelemetry(context, "get_tool_run_detail", async ({ tool_run_id }) =>
        handleToolRunDetail(context.db, tool_run_id).text)
    }),

    list_tools: tool({
      description: "List registered tools. Use when user asks about capabilities or what tools are available.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "list_tools", async () => buildToolsList(context.tools))
    }),

    get_tool_detail: tool({
      description: "Get details of a specific tool by name.",
      inputSchema: z.object({ tool_name: z.string() }),
      execute: async ({ tool_name }) => {
        const telemetryTool = tool_name?.trim() || "get_tool_detail";
        const startedAt = new Date().toISOString();
        emitToolEvent(context, {
          phase: "started",
          tool: telemetryTool,
          at: startedAt,
          requestId: context.chatRequestId,
          sessionId: context.chatSessionId,
          inputPreview: toPreview({ tool_name })
        });
        try {
          const output = handleToolDetail(context.tools, tool_name).text;
          emitToolEvent(context, {
            phase: "completed",
            tool: telemetryTool,
            at: new Date().toISOString(),
            requestId: context.chatRequestId,
            sessionId: context.chatSessionId,
            outputPreview: toPreview(output)
          });
          return output;
        } catch (error) {
          emitToolEvent(context, {
            phase: "failed",
            tool: telemetryTool,
            at: new Date().toISOString(),
            requestId: context.chatRequestId,
            sessionId: context.chatSessionId,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      }
    }),

    invoke_registered_tool: tool({
      description:
        "Invoke any registered runtime tool by exact name (including MCP tools like mcp.<serverId>.<toolName>). Pass params either in `input` object or as inline fields.",
      inputSchema: z.object({
        tool_name: z.string().min(1),
        input: z.record(z.unknown()).optional()
      }).passthrough(),
      execute: async (rawArgs) => {
        const args = rawArgs as {
          tool_name: string;
          input?: Record<string, unknown>;
          [key: string]: unknown;
        };
        const toolName = args.tool_name?.trim();
        const telemetryTool = toolName || "invoke_registered_tool";
        const inlineInput = Object.fromEntries(
          Object.entries(args).filter(([key]) => key !== "tool_name" && key !== "input")
        ) as Record<string, unknown>;
        const explicitInput =
          args.input && typeof args.input === "object" && !Array.isArray(args.input)
            ? args.input
            : {};
        const mergedInput = { ...inlineInput, ...explicitInput };

        emitToolEvent(context, {
          phase: "started",
          tool: telemetryTool,
          at: new Date().toISOString(),
          requestId: context.chatRequestId,
          sessionId: context.chatSessionId,
          inputPreview: toPreview(mergedInput)
        });
        try {
          if (!context.invokeRuntimeTool) {
            const unavailable = {
              ok: false,
              error: "runtime_tool_invocation_unavailable"
            };
            emitToolEvent(context, {
              phase: "failed",
              tool: telemetryTool,
              at: new Date().toISOString(),
              requestId: context.chatRequestId,
              sessionId: context.chatSessionId,
              error: unavailable.error
            });
            return unavailable;
          }
          if (!toolName) {
            const missing = {
              ok: false,
              error: "tool_name_required"
            };
            emitToolEvent(context, {
              phase: "failed",
              tool: telemetryTool,
              at: new Date().toISOString(),
              requestId: context.chatRequestId,
              sessionId: context.chatSessionId,
              error: missing.error
            });
            return missing;
          }
          const result = await context.invokeRuntimeTool(toolName, mergedInput);
          const output = result.ok
            ? {
                ok: true,
                tool: toolName,
                result: result.result
              }
            : {
                ok: false,
                tool: toolName,
                error: result.error,
                approvalRequired: result.approvalRequired ?? false,
                approvalId: result.approvalId ?? null
              };
          emitToolEvent(context, {
            phase: result.ok ? "completed" : "failed",
            tool: telemetryTool,
            at: new Date().toISOString(),
            requestId: context.chatRequestId,
            sessionId: context.chatSessionId,
            outputPreview: result.ok ? toPreview(output) : undefined,
            error: result.ok ? undefined : result.error
          });
          return output;
        } catch (error) {
          emitToolEvent(context, {
            phase: "failed",
            tool: telemetryTool,
            at: new Date().toISOString(),
            requestId: context.chatRequestId,
            sessionId: context.chatSessionId,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      }
    }),

    list_plugins: tool({
      description: "List loaded plugins. Use when user asks about plugins, integrations, or connectors.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "list_plugins", async () => buildPluginsList(context.plugins))
    }),

    get_help: tool({
      description: "Get help on what OpenCorpo can do and example prompts.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "get_help", async () => buildHelpText())
    }),

    db_list_tables: tool({
      description: "List all database tables. Use before custom DB reads.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "db_list_tables", async () => listDbTables(context.db))
    }),

    db_read_query: tool({
      description:
        "Run a read-only SQL query against SQLite to inspect existing data (including historical conversations). Allowed statements: SELECT/PRAGMA/EXPLAIN/CTE.",
      inputSchema: z.object({
        sql: z.string().min(1),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional(),
        max_rows: z.number().min(1).max(500).optional()
      }),
      execute: withToolTelemetry(context, "db_read_query", async ({ sql, params, max_rows }) =>
        runReadOnlyQuery(context.db, sql, params ?? [], max_rows))
    }),

    upsert_user_note: tool({
      description:
        "Create/update a user note in ai_user_notes. Use for persistent user-specific notes.",
      inputSchema: z.object({
        subject: z.string().min(1).describe("User/person/entity key, e.g. primary_user"),
        note_key: z.string().min(1).describe("Stable key for this note"),
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
        source: z.string().optional()
      }),
      execute: withToolTelemetry(
        context,
        "upsert_user_note",
        async ({ subject, note_key, content, tags, source }) => {
          upsertAiUserNote(context.db, {
            subject,
            noteKey: note_key,
            content,
            tags,
            source
          });
          return { ok: true };
        }
      )
    }),

    list_user_notes: tool({
      description: "List user notes from ai_user_notes, optionally filtered by subject.",
      inputSchema: z.object({
        subject: z.string().optional(),
        limit: z.number().min(1).max(500).optional()
      }),
      execute: withToolTelemetry(context, "list_user_notes", async ({ subject, limit }) =>
        listAiUserNotes(context.db, subject, limit ?? 100))
    }),

    upsert_memory_record: tool({
      description:
        "Write persistent AI/job/page data into ai_memory_store. This is the allowed long-term write table for automation output.",
      inputSchema: z.object({
        owner_type: z.string().min(1).describe("Scope type, e.g. page, job, agent"),
        owner_id: z.string().min(1).describe("Scope id/name"),
        namespace: z.string().min(1).describe("Logical group, e.g. dashboard"),
        data_key: z.string().min(1),
        value: z.unknown()
      }),
      execute: withToolTelemetry(
        context,
        "upsert_memory_record",
        async ({ owner_type, owner_id, namespace, data_key, value }) => {
          upsertAiMemory(context.db, {
            ownerType: owner_type,
            ownerId: owner_id,
            namespace,
            dataKey: data_key,
            value
          });
          return { ok: true };
        }
      )
    }),

    list_memory_records: tool({
      description: "Read records from ai_memory_store with optional filters.",
      inputSchema: z.object({
        owner_type: z.string().optional(),
        owner_id: z.string().optional(),
        namespace: z.string().optional(),
        data_key: z.string().optional(),
        limit: z.number().min(1).max(500).optional()
      }),
      execute: withToolTelemetry(
        context,
        "list_memory_records",
        async ({ owner_type, owner_id, namespace, data_key, limit }) =>
          listAiMemory(context.db, {
            ownerType: owner_type,
            ownerId: owner_id,
            namespace,
            dataKey: data_key,
            limit: limit ?? 100
          })
      )
    }),

    http_get: tool({
      description:
        "Fetch a public HTTP(S) URL. Use for docs pages and API responses. Private/local hosts are blocked.",
      inputSchema: z.object({
        url: z.string().url(),
        timeout_ms: z.number().min(1000).max(20000).optional(),
        max_bytes: z.number().min(512).max(100000).optional()
      }),
      execute: withToolTelemetry(context, "http_get", async ({ url, timeout_ms, max_bytes }) =>
        runHttpGet({ url, timeoutMs: timeout_ms, maxBytes: max_bytes }))
    }),

    web_search: tool({
      description:
        "Search the public web for a query and return top links/snippets. Use when user asks to look something up.",
      inputSchema: z.object({
        query: z.string().min(1),
        max_results: z.number().min(1).max(10).optional()
      }),
      execute: withToolTelemetry(context, "web_search", async ({ query, max_results }) =>
        runWebSearch({ query, maxResults: max_results }))
    }),

    list_available_handlers: tool({
      description:
        "List tool names that have plugin handlers. Use before adding a new tool to see which names can be used. Agent can add config for tools that match these handlers.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "list_available_handlers", async () => {
        const names = context.handlerNames ?? [];
        if (names.length === 0) return "No plugin handlers loaded. Install plugins to add tools.";
        return `Available handler names: ${names.join(", ")}. You can add tool definitions (tools/*.json) for these names.`;
      })
    }),

    get_tool_schema: tool({
      description:
        "Get the JSON schema for tool definitions. Use when creating a new tool via propose_config_change.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "get_tool_schema", async () => TOOL_SCHEMA_JSON)
    }),

    get_ui_schema: tool({
      description:
        "Get the JSON schema for UI config files. Use before proposing ui/*.json changes.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "get_ui_schema", async () => {
        try {
          const schemaPath = resolve(schemaRoot, "ui.schema.json");
          return readFileSync(schemaPath, "utf-8");
        } catch {
          return "UI schema not found.";
        }
      })
    }),

    get_control_plane_json: tool({
      description:
        "Read an existing control-plane JSON file (e.g. ui/desktop.json, tools/x.json, jobs/x.json) before editing.",
      inputSchema: z.object({
        relative_path: z
          .string()
          .describe("Path under config root, e.g. ui/desktop.json")
      }),
      execute: withToolTelemetry(context, "get_control_plane_json", async ({ relative_path }) => {
        const normalized = normalizeControlPlanePath(relative_path);
        if (!normalized) return "Invalid control-plane path. Must be a safe .json relative path.";
        const absolutePath = resolve(context.controlPlaneRoot, normalized);
        if (!absolutePath.startsWith(resolve(context.controlPlaneRoot))) {
          return "Path traversal not allowed.";
        }
        if (!existsSync(absolutePath)) {
          return `File not found: ${normalized}`;
        }
        try {
          return readFileSync(absolutePath, "utf-8");
        } catch (err) {
          return `Failed to read ${normalized}: ${err instanceof Error ? err.message : "unknown_error"}`;
        }
      })
    }),

    list_control_plane_changes: tool({
      description: "List proposed/applied control plane changes. Use to check status of proposals.",
      inputSchema: z.object({}),
      execute: withToolTelemetry(context, "list_control_plane_changes", async () => {
        const changes = listControlPlaneChanges(context.db, 15);
        if (changes.length === 0) return "No control plane changes.";
        return changes
          .map(
            (c: { id: number; file_path: string; status: string; risk: string; summary?: string | null }) =>
              `#${c.id} ${c.file_path} (${c.status}) ${c.risk} - ${c.summary ?? ""}`
          )
          .join("\n");
      })
    }),

    propose_config_change: tool({
      description:
        "Propose a change to control plane config (tools, jobs, workflows, ui, policy). Target: tools/*.json, jobs/*.json, workflows/*.json, ui/*.json, policy.json. For script jobs use top-level script.path (not steps.tool=script.run). High-risk requires approval.",
      inputSchema: z.object({
        relative_path: z
          .string()
          .describe("e.g. tools/mytool.json, jobs/daily.job.json"),
        after_json: z.record(z.unknown()).describe("The full JSON content for the file")
      }),
      execute: withToolTelemetry(context, "propose_config_change", async ({ relative_path, after_json }) => {
        const normalized = relative_path.replaceAll("\\", "/").replace(/^\/+/, "");
        if (!normalized.endsWith(".json")) {
          return "Control plane changes must target .json files.";
        }
        if (normalized.includes("..")) return "Path traversal not allowed.";
        try {
          let nextJson: Record<string, unknown> = after_json;
          if (normalized.startsWith("ui/")) {
            const absolutePath = resolve(context.controlPlaneRoot, normalized);
            let beforeJson: Record<string, unknown> | null = null;
            if (existsSync(absolutePath)) {
              try {
                const raw = JSON.parse(readFileSync(absolutePath, "utf-8"));
                if (raw && typeof raw === "object") beforeJson = raw as Record<string, unknown>;
              } catch {
                beforeJson = null;
              }
            }
            nextJson = mergeUiWithExisting(after_json, beforeJson);
            const packageErrors = await validateUiReactWidgetPackages(nextJson, beforeJson);
            if (packageErrors.length > 0) {
              return `Config change rejected: ${packageErrors.join("; ")}`;
            }
            const terminalErrors = await validateUiTerminalWidgetCommands(nextJson, beforeJson);
            if (terminalErrors.length > 0) {
              return `Config change rejected: ${terminalErrors.join("; ")}`;
            }
          }
          const proposed = proposeControlPlaneChange(context.db, context.controlPlaneRoot, {
            actor: "agent",
            relativePath: normalized,
            afterJson: nextJson
          });
          if (!proposed.ok) {
            const details = (proposed as { details?: string[] }).details;
            const rendered =
              normalized.startsWith("ui/")
                ? formatUiValidationHelp(details)
                : details?.join("; ");
            return `Config change rejected: ${rendered ?? proposed.error}`;
          }
          const isHighRisk = proposed.risk === "high";
          if (isHighRisk) {
            const approvalId = createApproval(context.db, {
              requestedBy: "agent",
              tool: "control-plane.change",
              action: "apply",
              reason: `High-risk Control Plane change for ${normalized}`,
              metadata: { changeId: proposed.id }
            });
            writeAudit(context.db, {
              actor: "agent",
              action: "control_plane_change_proposed",
              metadata: { changeId: proposed.id, approvalId, path: normalized }
            });
            return `Proposed control-plane change #${proposed.id} for ${normalized}. Approval #${approvalId} is required before apply.`;
          }
          const applied = applyControlPlaneChange(context.db, context.controlPlaneRoot, proposed.id);
          if (applied.ok && context.onControlPlaneChanged) {
            await context.onControlPlaneChanged();
          }
          writeAudit(context.db, {
            actor: "agent",
            action: applied.ok ? "control_plane_change_applied" : "control_plane_change_failed",
            metadata: { changeId: proposed.id, path: normalized }
          });
          return applied.ok
            ? `Applied control-plane change #${proposed.id} (${normalized}).`
            : `Change #${proposed.id} was not applied: ${applied.error}.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      })
    }),

    propose_code_change: tool({
      description:
        "Propose a Tier B code change to userland workspace. Requires user approval. Target: .ts, .tsx, .js, .json, .md, .txt in workspace.",
      inputSchema: z.object({
        target_path: z.string().describe("Relative path in workspace, e.g. notes.ts"),
        after_content: z.string().describe("The new file content")
      }),
      execute: withToolTelemetry(context, "propose_code_change", async ({ target_path, after_content }) => {
        try {
          const proposal = proposeCodeChange(context.db, context.workspaceRoot, {
            actor: "agent",
            targetPath: target_path,
            afterContent: after_content,
            reason: "Agent requested workspace change."
          });
          const approvalId = createApproval(context.db, {
            requestedBy: "agent",
            tool: "workspace.patch",
            action: "apply",
            reason: `Tier B code change requires approval (${target_path}).`,
            metadata: { codeChangeProposalId: proposal.id, targetPath: target_path }
          });
          attachCodeChangeApproval(context.db, proposal.id, approvalId);
          writeAudit(context.db, {
            actor: "agent",
            action: "code_change_proposed",
            metadata: { proposalId: proposal.id, approvalId, path: target_path }
          });
          writeEvent(context.db, {
            type: "code_change.proposed",
            data: { proposalId: proposal.id, approvalId }
          });
          return `Proposed workspace code change #${proposal.id} for ${target_path}. Approval #${approvalId} is required.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      })
    }),

    apply_control_plane_change: tool({
      description:
        "Apply a proposed control plane change by ID. Only works for changes that are approved or low-risk.",
      inputSchema: z.object({
        change_id: z.number().describe("The control plane change ID to apply")
      }),
      execute: withToolTelemetry(context, "apply_control_plane_change", async ({ change_id }) => {
        const applied = applyControlPlaneChange(context.db, context.controlPlaneRoot, change_id);
        if (!applied.ok) return `Failed: ${applied.error}`;
        if (context.onControlPlaneChanged) {
          await context.onControlPlaneChanged();
        }
        return `Applied change #${change_id}.`;
      })
    })
  };
}
