/**
 * AI configuration service - reads provider and API key from secrets.
 */
import type { DbHandle } from "../db";
import { getSecretValue, setSecretRef } from "../secrets";
import type { AiConfig, AiProviderId } from "../ai";

const PROVIDER_KEY = "opencorpo.ai.provider";
const API_KEY_NAME = "opencorpo.ai.api_key";

const VALID_PROVIDERS: AiProviderId[] = ["openai", "anthropic", "vercel"];

export function getAiConfig(db: DbHandle): AiConfig | null {
  const providerRaw = getSecretValue(db, PROVIDER_KEY);
  const apiKey = getSecretValue(db, API_KEY_NAME);

  if (!apiKey?.trim()) return null;

  const provider = (providerRaw?.trim() ?? "openai") as AiProviderId;
  if (!VALID_PROVIDERS.includes(provider)) return null;

  return { provider, apiKey: apiKey.trim() };
}

export function setAiConfig(
  db: DbHandle,
  config: { provider: AiProviderId; apiKey: string }
) {
  setSecretRef(db, {
    name: PROVIDER_KEY,
    value: config.provider,
    provider: "opencorpo_settings"
  });
  setSecretRef(db, {
    name: API_KEY_NAME,
    value: config.apiKey.trim(),
    provider: "opencorpo_settings"
  });
}

export function getAiConfigStatus(db: DbHandle): {
  configured: boolean;
  provider: AiProviderId | null;
} {
  const config = getAiConfig(db);
  return {
    configured: config !== null,
    provider: config?.provider ?? null
  };
}
