import { streamText, convertToModelMessages, type UIMessage, stepCountIs } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentContext, AgentReply } from "./agent";
import { buildAgentTools } from "./agent-tools";
import type { DbHandle } from "./db";
import { getSecretValue } from "./secrets";

const DEFAULT_GATEWAY_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_OPENAI_MODEL = "gpt-5.2-chat-latest";

const BASE_SYSTEM_PROMPT = `You are OpenCorpo, a self-configuring business operating system. You help users manage approvals, jobs, audit logs, tools, and plugins. You can also propose changes to add new tools, jobs, and workflows.

IMPORTANT: You must use tools to get any operational data. Do NOT guess or make up data. When the user asks about approvals, jobs, audit, status, plugins, or tools, call the appropriate tool first and then summarize the results in natural language.

Available tools:
- get_status: Overview of current state
- get_approvals: List pending or all approvals
- approve, deny: Act on approvals by ID
- list_jobs, list_job_runs, run_job, enable_job, disable_job: Job management
- list_audit, get_audit_detail: Audit log
- list_tools, get_tool_detail: Registered tools
- list_plugins: Loaded plugins
- get_help: Example prompts
- http_get, web_search: Public web and HTTP lookup tools
- list_available_handlers: Tool names with plugin handlers (use before adding tools)
- get_tool_schema: JSON schema for tool definitions
- get_ui_schema: JSON schema for UI config
- get_control_plane_json: Read current control-plane JSON before editing
- propose_config_change: Add/update tools, jobs, workflows, UI (config/tools/*.json, jobs/*.json, ui/*.json)
- propose_code_change: Propose workspace code changes (requires approval)
- list_control_plane_changes, apply_control_plane_change: Manage proposals

When asked to add/update sidebar items or pages, first read ui/desktop.json and get_ui_schema, then apply a valid full-file JSON update via propose_config_change.

For greetings and casual chat, respond conversationally. For any request about data or actions, use tools first.`;

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
  if (!profile) return BASE_SYSTEM_PROMPT;
  const lines = [
    profile.name ? `- Name: ${profile.name}` : null,
    profile.role ? `- Role: ${profile.role}` : null,
    profile.jobTitle ? `- Job Title: ${profile.jobTitle}` : null,
    profile.about ? `- Additional Context: ${profile.about}` : null
  ].filter(Boolean) as string[];
  if (lines.length === 0) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}

User profile context:
${lines.join("\n")}
`;
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
    const tools = buildAgentTools(context);
    const model = createModel(context.db, apiKey, options);
    const systemPrompt = buildSystemPrompt(context.db);

    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(5),
      abortSignal: undefined
    });

    let text = "";
    for await (const part of result.textStream) {
      text += part;
    }

    const fullText =
      text.trim() ||
      "Done. I executed the request, but I do not have a text summary for this step.";
    return {
      text: fullText,
      metadata: { source: "llm" }
    };
  } catch (err) {
    console.error("[agent-llm] Error:", err);
    return null;
  }
}

/** Ensure every message has a `parts` array so convertToModelMessages doesn't crash. */
function normalizeUIMessages(raw: UIMessage[]): UIMessage[] {
  return raw.map((m) => ({
    ...m,
    id: m.id ?? crypto.randomUUID(),
    parts: m.parts ?? [{ type: "text" as const, text: m.content ?? "" }]
  })) as UIMessage[];
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
      stopWhen: stepCountIs(5)
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
