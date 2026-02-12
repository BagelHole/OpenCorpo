import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configRoot } from "./paths";

export type RedactionPolicy = {
  version: string;
  audit?: {
    redactKeys?: string[];
    mask?: string;
  };
};

const defaultPolicy: RedactionPolicy = {
  version: "0.0.1",
  audit: {
    redactKeys: ["token", "password", "secret", "authorization", "apiKey", "refreshToken"],
    mask: "[REDACTED]"
  }
};

let cachedPolicy: RedactionPolicy | null = null;
let cachedPath = "";

export function loadRedactionPolicy(root = configRoot): RedactionPolicy {
  const path = resolve(root, "redaction.json");
  if (cachedPolicy && cachedPath === path) return cachedPolicy;
  if (!existsSync(path)) {
    cachedPolicy = defaultPolicy;
    cachedPath = path;
    return cachedPolicy;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as RedactionPolicy;
    cachedPolicy = {
      ...defaultPolicy,
      ...parsed,
      audit: {
        ...defaultPolicy.audit,
        ...(parsed.audit ?? {})
      }
    };
    cachedPath = path;
    return cachedPolicy;
  } catch {
    cachedPolicy = defaultPolicy;
    cachedPath = path;
    return cachedPolicy;
  }
}

function shouldRedactKey(key: string, configured: string[]) {
  const lowered = key.toLowerCase();
  return configured.some((item) => lowered.includes(item.toLowerCase()));
}

export function redactMetadata(
  metadata: Record<string, unknown> | undefined,
  policy: RedactionPolicy
) {
  if (!metadata) return undefined;
  const keys = policy.audit?.redactKeys ?? defaultPolicy.audit?.redactKeys ?? [];
  const mask = policy.audit?.mask ?? defaultPolicy.audit?.mask ?? "[REDACTED]";

  function walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (!value || typeof value !== "object") return value;
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (shouldRedactKey(key, keys)) {
        next[key] = mask;
      } else {
        next[key] = walk(nested);
      }
    }
    return next;
  }

  return walk(metadata) as Record<string, unknown>;
}
