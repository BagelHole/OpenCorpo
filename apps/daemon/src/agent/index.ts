/**
 * AI-powered agent with tool calling.
 * Uses Vercel AI SDK with pluggable providers.
 */
import { generateText, tool } from "ai";
import { z } from "zod";
import type { DbHandle } from "../db";
import { createAiModel } from "../ai";
import { getAiConfig } from "../services/ai-config";
import { requestToolExecution } from "../services/tool-request";
import type { ToolDefinition } from "../tools";
import type { ToolRegistry } from "../tool-registry";
import { listMessages } from "../chat";
import type { PolicyFile } from "../policy";
import type { PluginSummary } from "./types";

export type AgentContext = {
  db: DbHandle;
  toolRegistry: ToolRegistry;
  policy: PolicyFile | null;
  plugins: PluginSummary[];
  controlPlaneRoot: string;
  workspaceRoot: string;
};

export type AgentReply = {
  text: string;
  metadata?: Record<string, unknown>;
};

const SYSTEM_PROMPT = `You are OpenCorpo, a local-first business operations assistant. You help users manage their workflow through a secure, audited system.

You have access to tools. Use them when the user asks you to:
- Search or read Gmail (gmail.search, gmail.read)
- Create drafts or send email (gmail.draft, gmail.send - high risk, needs approval)
- Run jobs, enable/disable jobs
- View approvals, audit log, tools, plugins
- Propose config changes (self-edit) or code changes (requires approval)

When the user asks for status, list pending approvals, jobs, or recent activity - use the appropriate tools.
For "approve #N" or "deny #N" - use the approval tools.
For "run job #N" - use the job run tool.

Be concise and actionable. If a tool requires approval, tell the user to check the Inbox.`;

export async function runAgent(
  sessionId: number,
  userMessage: string,
  context: AgentContext
): Promise<AgentReply> {
  const config = getAiConfig(context.db);
  const model = config ? createAiModel(config) : null;

  if (!model) {
    return {
      text: "AI is not configured. Go to Settings to add your API key (OpenAI, Anthropic, or Vercel).",
      metadata: { error: "ai_not_configured" }
    };
  }

  const history = listMessages(context.db, sessionId, 20);
  const messages = history.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content
  }));

  const tools = buildTools(context);

  try {
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      messages: [...messages, { role: "user" as const, content: userMessage }],
      tools,
      maxSteps: 5
    });

    return {
      text: result.text,
      metadata: {
        steps: result.steps?.length,
        toolCalls: result.steps?.flatMap((s) => s.toolCalls ?? [])
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      text: `AI request failed: ${message}. Check your API key and try again.`,
      metadata: { error: "ai_request_failed" }
    };
  }
}

function buildTools(context: AgentContext) {
  const tools: Record<string, ReturnType<typeof tool>> = {};

  for (const def of context.toolRegistry.definitions) {
    const handler = context.toolRegistry.handlers.get(def.name);
    if (!handler) continue;

    tools[def.name] = tool({
      description: buildToolDescription(def),
      parameters: z.record(z.unknown()),
      execute: async (args) => {
        const result = await requestToolExecution(
          context.db,
          def.name,
          args as Record<string, unknown>,
          { actor: "agent" },
          context.toolRegistry,
          context.policy
        );
        if (result.ok) return result.result;
        if (result.approvalId) {
          return {
            ok: false,
            error: "approval_required",
            message: `Approval #${result.approvalId} created. User must approve in Inbox.`
          };
        }
        return { ok: false, error: result.error };
      }
    });
  }

  return tools;
}

function buildToolDescription(def: ToolDefinition): string {
  const parts: string[] = [def.name, `(risk: ${def.risk})`];
  if (def.inputs && typeof def.inputs === "object") {
    const props = (def.inputs as { properties?: Record<string, unknown> }).properties;
    if (props && typeof props === "object") {
      const keys = Object.keys(props);
      if (keys.length > 0) parts.push(`Inputs: ${keys.join(", ")}`);
    }
  }
  return parts.join(" ");
}
