import { streamText, convertToModelMessages, type UIMessage, stepCountIs } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentContext, AgentReply, AgentToolEvent } from "./agent";
import { buildAgentTools } from "./agent-tools";
import type { DbHandle } from "./db";
import { getSecretValue, listSecrets } from "./secrets";
import { getScriptExecutionMode } from "./script-security";

const DEFAULT_GATEWAY_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_OPENAI_MODEL = "gpt-5.2-chat-latest";

const BASE_SYSTEM_PROMPT = `You are OpenCorpo, a self-configuring business operating system. You help users manage approvals, jobs, audit logs, tools, and plugins. You can also propose changes to add new tools, jobs, and workflows.

Response style:
- Be friendly, respectful, and clear.
- Use concise plain language and avoid robotic phrasing.

IMPORTANT: You must use tools to get any operational data. Do NOT guess or make up data. When the user asks about approvals, jobs, audit, status, plugins, or tools, call the appropriate tool first and then summarize the results in natural language.
User preference/profile notes may be auto-captured into ai_user_notes (subject: "primary_user"). Use list_user_notes when personalization matters.

Available tools:
- get_status: Overview of current state
- get_approvals: List pending or all approvals
- approve, deny: Act on approvals by ID
- list_jobs, list_job_runs, run_job, enable_job, disable_job: Job management
- list_audit, get_audit_detail: Audit log
- list_tools, get_tool_detail: Registered tools
- list_plugins: Loaded plugins
- get_help: Example prompts
- db_list_tables, db_read_query: Direct read-only SQLite access (including old conversation history)
- upsert_user_note, list_user_notes: Persistent user notes
- upsert_memory_record, list_memory_records: Persistent AI/job/page data storage
- http_get, web_search: Public web and HTTP lookup tools
- list_available_handlers: Tool names with plugin handlers (use before adding tools)
- get_tool_schema: JSON schema for tool definitions
- get_ui_schema: JSON schema for UI config
- get_control_plane_json: Read current control-plane JSON before editing
- propose_config_change: Add/update tools, jobs, workflows, UI (config/tools/*.json, jobs/*.json, ui/*.json)
- propose_code_change: Propose workspace code changes (requires approval)
- list_control_plane_changes, apply_control_plane_change: Manage proposals

When asked to add/update sidebar items or pages, first read ui/desktop.json and get_ui_schema, then apply a valid full-file JSON update via propose_config_change.
For dynamic dashboards from job outputs, use:
- "job_results" for list-style output (jobName, title, maxItems, emptyText, source)
- "job_table" for table-style output (jobName, title, maxRows, columns, emptyText, source)
This is generic and should be used for any job/page where live runtime data must appear.
If creating a job intended to power a page, ensure the job tool output is displayable (non-empty arrays/rows when possible) and avoid overly restrictive search queries that commonly return empty results.
When proposing jobs, use step objects shaped like { "tool": "...", "with": { ... } } and use canonical dot tool names (example: "web.search", "http.get").
For script jobs, do NOT use steps with tool "script.run". Use top-level:
{ "type": "script", "script": { "path": "<file>.ts", "timeout_ms": 120000 } }
and place the script under userland/jobs.
Tool-specific guardrails:
- Use db_read_query for SQL reads only; never attempt writes through SQL.
- For persistence, write only via upsert_user_note or upsert_memory_record.
- For runtime script DB access, use only these endpoints:
  - POST /script-db/query (read-only SQL)
  - POST /script-db/notes/upsert
  - POST /script-db/memory/upsert
  - GET /script-db/notes
  - GET /script-db/memory
- Never use /script-db/execute (unsupported).
- For web.search, do not set with.max_results unless the user explicitly asks for a specific count.
- If the user asks for a count, keep with.max_results between 1 and 10.
Use only the minimum number of tool calls needed to complete the request end-to-end.
Do not stop after discovery checks if the user asked you to create/update something; execute the creation/update in the same turn.
Run validation/verification checks when helpful, but prioritize actually applying the requested changes first.

For greetings and casual chat, respond conversationally. For any request about data or actions, use tools first.`;

const EXECUTION_SUMMARY_REQUIREMENT = `
Response quality requirements:
- After taking actions, always include a concrete execution summary.
- Mention what you checked/searched, what you changed, and the result status.
- If a step failed, name the failing tool or action and the exact error string when available.
- When work is incomplete, end with "Blocked by:" and one concrete next action.
`;
const SCRIPT_SECRET_REQUIREMENTS = `
Secret handling requirements:
- Never ask users to hardcode API keys/tokens in scripts.
- For any script requiring credentials, instruct the user to add them in Settings -> Script Secrets.
- Refer to secrets only by secret name (for example: script.stripe.api_key) and storage location path.
- Never reveal or invent secret values.
- Do NOT ask users to configure OPENCORPO_SCRIPT_DB_URL or OPENCORPO_SCRIPT_DB_TOKEN as Script Secrets.
- For script DB access, use runtime-provided env vars OPENCORPO_SCRIPT_DB_URL and OPENCORPO_SCRIPT_DB_TOKEN directly.
`;
const SAFE_SCRIPT_MODE_REQUIREMENTS = `
Script execution mode: SAFE (default).
- Scripts run with restricted environment variables.
- Do not import or use bun:sqlite or child_process APIs.
- For durable storage, use OPENCORPO_SCRIPT_DB_URL + OPENCORPO_SCRIPT_DB_TOKEN against /script-db/* endpoints.
`;
const TRUSTED_SCRIPT_MODE_REQUIREMENTS = `
Script execution mode: TRUSTED.
- Scripts run with full process environment and fewer runtime restrictions.
- This mode is less secure and intended only for advanced/trusted scripts.
- Prefer /script-db/* APIs for structured persistence even in trusted mode.
`;

type UserProfile = {
  name?: string;
  role?: string;
  jobTitle?: string;
  about?: string;
};

type ModelDefaults = {
  anthropic?: string;
  openai?: string;
  local?: string;
  gateway?: string;
};

type ModelOptions = {
  provider?: string;
  model?: string;
};

function getApiKey(db: DbHandle): string | null {
  return (
    process.env.AI_GATEWAY_API_KEY ??
    process.env.VERCEL_AI_API_KEY ??
    getSecretValue(db, "ai.api_key") ??
    null
  );
}

function getAiProvider(db: DbHandle): string {
  const configured =
    process.env.OPENCORPO_AI_PROVIDER ??
    getSecretValue(db, "ai.provider") ??
    "";
  return configured.trim().toLowerCase();
}

function inferProviderFromKey(apiKey: string): "openai" | "gateway" {
  const key = apiKey.trim();
  if (key.startsWith("sk-ant-")) return "gateway";
  if (key.startsWith("sk-")) return "openai";
  return "gateway";
}

function getModelDefaults(db: DbHandle): ModelDefaults {
  const raw = getSecretValue(db, "ai.model_defaults");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ModelDefaults;
    return {
      anthropic:
        typeof parsed.anthropic === "string" ? parsed.anthropic.trim() : undefined,
      openai: typeof parsed.openai === "string" ? parsed.openai.trim() : undefined,
      local: typeof parsed.local === "string" ? parsed.local.trim() : undefined,
      gateway: typeof parsed.gateway === "string" ? parsed.gateway.trim() : undefined
    };
  } catch {
    return {};
  }
}

function getUserProfile(db: DbHandle): UserProfile | null {
  const raw = getSecretValue(db, "user.profile");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UserProfile;
    return {
      name: typeof parsed.name === "string" ? parsed.name.trim() : undefined,
      role: typeof parsed.role === "string" ? parsed.role.trim() : undefined,
      jobTitle: typeof parsed.jobTitle === "string" ? parsed.jobTitle.trim() : undefined,
      about: typeof parsed.about === "string" ? parsed.about.trim() : undefined
    };
  } catch {
    return null;
  }
}

function buildSystemPrompt(db: DbHandle): string {
  const profile = getUserProfile(db);
  const scriptExecutionMode = getScriptExecutionMode(db);
  const scriptSecrets = listSecrets(db, 500)
    .filter((item: any) => typeof item.name === "string" && item.name.startsWith("script."))
    .map((item: any) => {
      const metadata =
        item.metadata && typeof item.metadata === "object"
          ? (item.metadata as Record<string, unknown>)
          : {};
      const description =
        typeof metadata.description === "string" ? metadata.description.trim() : "";
      return {
        name: item.name,
        ref: item.ref,
        description
      };
    })
    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
    .slice(0, 50);

  const scriptSecretLines =
    scriptSecrets.length > 0
      ? scriptSecrets.map((secret: { name: string; ref: string; description: string }) =>
          `- ${secret.name} -> ${secret.ref}${secret.description ? ` (${secret.description})` : ""}`
        )
      : ["- None configured yet. Ask user to add required keys in Settings -> Script Secrets."];

  const scriptSecretContext = `
Script secret catalog (names + locations only; values are never exposed):
${scriptSecretLines.join("\n")}
`.trim();
  const scriptModeContext =
    scriptExecutionMode === "trusted"
      ? TRUSTED_SCRIPT_MODE_REQUIREMENTS
      : SAFE_SCRIPT_MODE_REQUIREMENTS;

  if (!profile) {
    return `${BASE_SYSTEM_PROMPT}
${EXECUTION_SUMMARY_REQUIREMENT}
${SCRIPT_SECRET_REQUIREMENTS}
${scriptModeContext}

${scriptSecretContext}`.trim();
  }
  const lines = [
    profile.name ? `- Name: ${profile.name}` : null,
    profile.role ? `- Role: ${profile.role}` : null,
    profile.jobTitle ? `- Job Title: ${profile.jobTitle}` : null,
    profile.about ? `- Additional Context: ${profile.about}` : null
  ].filter(Boolean) as string[];
  if (lines.length === 0) {
    return `${BASE_SYSTEM_PROMPT}
${EXECUTION_SUMMARY_REQUIREMENT}
${SCRIPT_SECRET_REQUIREMENTS}
${scriptModeContext}

${scriptSecretContext}`.trim();
  }
  return `${BASE_SYSTEM_PROMPT}
${EXECUTION_SUMMARY_REQUIREMENT}
${SCRIPT_SECRET_REQUIREMENTS}
${scriptModeContext}

${scriptSecretContext}

User profile context:
${lines.join("\n")}
`;
}

function cleanPreview(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  return trimmed.replace(/\s+/g, " ");
}

function summarizeToolAction(event: AgentToolEvent): string | null {
  const output = cleanPreview(event.outputPreview);
  if (output) {
    const appliedConfig = output.match(/^Applied control-plane change #(\d+) \(([^)]+)\)\.?$/i);
    if (appliedConfig) {
      return `Updated \`${appliedConfig[2]}\` (change #${appliedConfig[1]}).`;
    }
    const proposedConfig = output.match(
      /^Proposed control-plane change #(\d+) for ([^.]+)\. Approval #(\d+) is required/i
    );
    if (proposedConfig) {
      return `Prepared config update for \`${proposedConfig[2]}\` (approval #${proposedConfig[3]} required).`;
    }
    const queuedJob = output.match(/^Queued job #(\d+) \(([^)]+)\) as run #(\d+)\.?$/i);
    if (queuedJob) {
      return `Queued job **${queuedJob[2]}** (run #${queuedJob[3]}).`;
    }
    const appliedChange = output.match(/^Applied change #(\d+)\.?$/i);
    if (appliedChange) {
      return `Applied approved change #${appliedChange[1]}.`;
    }
    if (output.length <= 180) return output.endsWith(".") ? output : `${output}.`;
  }

  const fallbackByTool: Record<string, string> = {
    get_control_plane_json: "Read existing control-plane config before editing.",
    get_ui_schema: "Checked UI schema for valid page/sidebar structure.",
    get_tool_schema: "Checked tool schema for valid tool config.",
    list_available_handlers: "Checked available tool handlers before creating config.",
    propose_config_change: "Applied control-plane config updates.",
    run_job: "Queued the requested job run."
  };
  return fallbackByTool[event.tool] ?? null;
}

function buildFallbackSummary(events: AgentToolEvent[]): string {
  const completed = events.filter((event) => event.phase === "completed");
  const failed = events.filter((event) => event.phase === "failed");
  if (completed.length === 0 && failed.length === 0) {
    return "Done. I completed the request, but I couldn't generate a readable summary.";
  }

  const actionLines = Array.from(
    new Set(
      completed
        .map((event) => summarizeToolAction(event))
        .filter((line): line is string => Boolean(line))
    )
  ).slice(0, 6);

  const lines: string[] = [];
  lines.push("Done. Here's what I changed:");
  if (actionLines.length > 0) {
    for (const line of actionLines) {
      lines.push(`- ${line}`);
    }
  } else {
    lines.push("- Completed the requested setup actions successfully.");
  }

  if (failed.length > 0) {
    const firstFailure = failed[0];
    lines.push("");
    lines.push("Blocked by:");
    lines.push(
      `- ${firstFailure.error ? firstFailure.error : `A failure occurred while running ${firstFailure.tool}.`}`
    );
  } else {
    lines.push("");
    lines.push("Result:");
    lines.push("- The requested changes were applied.");
  }

  return lines.join("\n");
}

async function synthesizeSummaryWithLLM(
  model: ReturnType<typeof createModel>,
  events: AgentToolEvent[]
) {
  const compactEvents = events.map((event) => ({
    phase: event.phase,
    tool: event.tool,
    input: cleanPreview(event.inputPreview) ?? undefined,
    output: cleanPreview(event.outputPreview) ?? undefined,
    error: event.error ?? undefined
  }));

  const summarySystemPrompt = `You summarize completed automation work for end users.
- Write naturally and clearly.
- Focus on what was created/changed and the result.
- Do not list tool names unless needed for clarity.
- If any failure exists, include "Blocked by:" and one concrete next action.
- Keep it concise.`;

  const summaryUserPrompt = `Summarize this completed execution for the user:\n${JSON.stringify(
    compactEvents
  )}`;

  const summaryResult = streamText({
    model,
    system: summarySystemPrompt,
    messages: [{ role: "user", content: summaryUserPrompt }],
    stopWhen: stepCountIs(1)
  });

  let summaryText = "";
  for await (const part of summaryResult.textStream) {
    summaryText += part;
  }
  return summaryText.trim();
}

function normalizeProvider(provider: string | undefined): "openai" | "gateway" {
  const value = (provider ?? "").trim().toLowerCase();
  if (value === "openai") return "openai";
  if (value === "anthropic" || value === "local" || value === "gateway") {
    return "gateway";
  }
  return "gateway";
}

function createModel(db: DbHandle, apiKey: string, options?: ModelOptions) {
  const modelDefaults = getModelDefaults(db);
  const configuredProvider = getAiProvider(db);
  const overrideProvider = options?.provider?.trim().toLowerCase();
  const selectedProvider = overrideProvider
    ? normalizeProvider(overrideProvider)
    : configuredProvider
      ? normalizeProvider(configuredProvider)
      : inferProviderFromKey(apiKey);
  const providerKey = (overrideProvider || configuredProvider || "").trim().toLowerCase();
  const fallbackDefault =
    selectedProvider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_GATEWAY_MODEL;
  const providerDefaultFromKey =
    providerKey === "openai"
      ? modelDefaults.openai
      : providerKey === "anthropic"
        ? modelDefaults.anthropic
        : providerKey === "local"
          ? modelDefaults.local
          : modelDefaults.gateway;
  const modelName =
    options?.model?.trim() || providerDefaultFromKey || modelDefaults.gateway || fallbackDefault;

  if (selectedProvider === "openai") {
    const openai = createOpenAI({ apiKey });
    return openai(modelName);
  }

  const gateway = createGateway({ apiKey });
  return gateway(modelName);
}

export async function runAgentWithLLM(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  context: AgentContext,
  options?: ModelOptions
): Promise<AgentReply | null> {
  const apiKey = getApiKey(context.db);
  if (!apiKey || !apiKey.trim()) {
    return null;
  }

  try {
    const toolEvents: AgentToolEvent[] = [];
    const tools = buildAgentTools({
      ...context,
      onAgentToolEvent: (event) => {
        toolEvents.push(event);
        context.onAgentToolEvent?.(event);
      }
    });
    const model = createModel(context.db, apiKey, options);
    const systemPrompt = buildSystemPrompt(context.db);

    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(10),
      abortSignal: undefined
    });

    let text = "";
    for await (const part of result.textStream) {
      text += part;
    }

    let fullText = text.trim();
    if (!fullText) {
      const synthesized = await synthesizeSummaryWithLLM(model, toolEvents);
      fullText = synthesized || buildFallbackSummary(toolEvents);
    }
    return {
      text: fullText,
      metadata: { source: "llm", toolEvents }
    };
  } catch (err) {
    console.error("[agent-llm] Error:", err);
    return null;
  }
}

/** Ensure every message has a `parts` array so convertToModelMessages doesn't crash. */
function normalizeUIMessages(raw: UIMessage[]): UIMessage[] {
  return raw.map((m) => {
    const legacyContent =
      typeof (m as { content?: unknown }).content === "string"
        ? ((m as { content?: string }).content ?? "")
        : "";
    const existingText =
      m.parts?.find(
        (part): part is typeof part & { type: "text"; text?: string } =>
          part.type === "text" && "text" in part && typeof part.text === "string"
      )?.text ?? "";

    return {
      ...m,
      id: m.id ?? crypto.randomUUID(),
      parts: m.parts ?? [{ type: "text" as const, text: existingText || legacyContent }]
    };
  }) as UIMessage[];
}

export async function streamAgentWithLLM(
  messages: UIMessage[],
  context: AgentContext,
  options?: ModelOptions
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  const apiKey = getApiKey(context.db);
  if (!apiKey || !apiKey.trim()) {
    return {
      ok: false,
      error: "AI is not configured. Set API key in Settings to enable conversational responses."
    };
  }

  try {
    const tools = buildAgentTools(context);
    const model = createModel(context.db, apiKey, options);
    const systemPrompt = buildSystemPrompt(context.db);

    const normalized = normalizeUIMessages(messages);
    const modelMessages = await convertToModelMessages(normalized);

    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(10)
    });

    return {
      ok: true,
      response: result.toUIMessageStreamResponse()
    };
  } catch (err) {
    console.error("[agent-llm] stream error:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "AI request failed"
    };
  }
}
