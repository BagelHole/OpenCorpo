import "dotenv/config";
import { streamText } from "ai";
import { gateway } from "@ai-sdk/gateway";

const defaultModel = "anthropic/claude-sonnet-4.5";

export async function runAiChat(messages) {
  const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_API_KEY;
  if (!apiKey) {
    return {
      text:
        "AI is not configured. Set AI_GATEWAY_API_KEY or VERCEL_AI_API_KEY to enable responses.",
      error: "missing_api_key"
    };
  }

  try {
    const result = await streamText({
      model: gateway(defaultModel),
      messages
    });

    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
    }

    return { text };
  } catch (error) {
    return {
      text: "AI call failed. Check your API key and model configuration.",
      error: error instanceof Error ? error.message : "unknown_error"
    };
  }
}
