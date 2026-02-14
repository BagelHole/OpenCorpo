import { streamText, convertToModelMessages, type UIMessage, stepCountIs } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentContext, AgentReply } from "./agent";
import { buildAgentTools } from "./agent-tools";
import type { DbHandle } from "./db";
import { getSecretValue } from "./secrets";

const DEFAULT_GATEWAY_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = `You are OpenCorpo, a self-configuring business operating system. You help users manage approvals, jobs, audit logs, tools, and plugins. You can also propose changes to add new tools, jobs, and workflows.

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
- list_available_handlers: Tool names with plugin handlers (use before adding tools)
- get_tool_schema: JSON schema for tool definitions
- propose_config_change: Add/update tools, jobs, workflows (config/tools/*.json, jobs/*.json)
- propose_code_change: Propose workspace code changes (requires approval)
- list_control_plane_changes, apply_control_plane_change: Manage proposals

For greetings and casual chat, respond conversationally. For any request about data or actions, use tools first.`;

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

function createModel(db: DbHandle, apiKey: string) {
  const configuredProvider = getAiProvider(db);
  const resolvedProvider =
    configuredProvider === "openai"
      ? "openai"
      : ["anthropic", "local", "gateway"].includes(configuredProvider)
        ? "gateway"
        : inferProviderFromKey(apiKey);

  if (resolvedProvider === "openai") {
    const openai = createOpenAI({ apiKey });
    return openai(DEFAULT_OPENAI_MODEL);
  }

  const gateway = createGateway({ apiKey });
  return gateway(DEFAULT_GATEWAY_MODEL);
}

export async function runAgentWithLLM(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  context: AgentContext
): Promise<AgentReply | null> {
  const apiKey = getApiKey(context.db);
  if (!apiKey || !apiKey.trim()) {
    return null;
  }

  try {
    const tools = buildAgentTools(context);
    const model = createModel(context.db, apiKey);

    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
      messages,
      tools,
      stopWhen: stepCountIs(5),
      abortSignal: undefined
    });

    let text = "";
    for await (const part of result.textStream) {
      text += part;
    }

    const fullText = text.trim() || "I don't have a response for that.";
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
  context: AgentContext
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
    const model = createModel(context.db, apiKey);

    const normalized = normalizeUIMessages(messages);
    const modelMessages = await convertToModelMessages(normalized);

    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
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
