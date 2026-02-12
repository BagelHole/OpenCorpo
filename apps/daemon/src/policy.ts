import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type PolicyDecision = "allow" | "deny" | "approve";

export type PolicyRule = {
  id: string;
  match: Record<string, unknown>;
  decision: PolicyDecision;
  reason?: string;
};

export type PolicyFile = {
  version: string;
  rules: PolicyRule[];
};

export type PolicyContext = {
  risk: string;
  tool?: string;
  action?: string;
  actor?: string;
};

export type PolicyResult = {
  decision: PolicyDecision;
  ruleId?: string;
  reason?: string;
};

export function loadPolicy(configRoot: string): PolicyFile | null {
  try {
    const policyPath = resolve(configRoot, "policy.json");
    const raw = readFileSync(policyPath, "utf-8");
    return JSON.parse(raw) as PolicyFile;
  } catch {
    return null;
  }
}

export function evaluatePolicy(
  policy: PolicyFile | null,
  ctx: PolicyContext
): PolicyResult {
  if (!policy) return { decision: "allow" };
  for (const rule of policy.rules) {
    if (matches(rule.match, ctx)) {
      return { decision: rule.decision, ruleId: rule.id, reason: rule.reason };
    }
  }
  return { decision: "allow" };
}

function matches(match: Record<string, unknown>, ctx: PolicyContext) {
  for (const [key, value] of Object.entries(match)) {
    if ((ctx as Record<string, unknown>)[key] !== value) return false;
  }
  return true;
}
