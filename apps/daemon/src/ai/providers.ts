/**
 * Pluggable AI provider layer for OpenCorpo.
 * Supports OpenAI, Anthropic, and Vercel AI Gateway (BYOK).
 */
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createVercel } from "@ai-sdk/vercel";
import type { LanguageModelV1 } from "ai";

export type AiProviderId = "openai" | "anthropic" | "vercel";

export type AiConfig = {
  provider: AiProviderId;
  apiKey: string;
};

const DEFAULT_MODELS: Record<AiProviderId, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-20241022",
  vercel: "anthropic/claude-sonnet-4"
};

export function createAiModel(config: AiConfig | null): LanguageModelV1 | null {
  if (!config?.apiKey?.trim()) return null;

  const key = config.apiKey.trim();

  switch (config.provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey: key });
      return openai(DEFAULT_MODELS.openai);
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: key });
      return anthropic(DEFAULT_MODELS.anthropic);
    }
    case "vercel": {
      const vercel = createVercel({ apiKey: key });
      return vercel(DEFAULT_MODELS.vercel);
    }
    default:
      return null;
  }
}

export function getProviderDisplayName(provider: AiProviderId): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "vercel":
      return "Vercel AI (BYOK)";
    default:
      return String(provider);
  }
}
