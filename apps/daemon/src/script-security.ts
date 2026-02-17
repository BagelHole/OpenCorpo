import type { DbHandle } from "./db";
import { getSecretValue, setSecretRef } from "./secrets";

export type ScriptExecutionMode = "safe" | "trusted";

const SCRIPT_EXECUTION_MODE_SECRET = "script.execution_mode";

export function normalizeScriptExecutionMode(value: unknown): ScriptExecutionMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "trusted") return "trusted";
  return "safe";
}

export function getScriptExecutionMode(db: DbHandle): ScriptExecutionMode {
  const raw = getSecretValue(db, SCRIPT_EXECUTION_MODE_SECRET);
  return normalizeScriptExecutionMode(raw);
}

export function setScriptExecutionMode(db: DbHandle, mode: ScriptExecutionMode) {
  setSecretRef(db, {
    name: SCRIPT_EXECUTION_MODE_SECRET,
    value: mode,
    provider: "local_file",
    metadata: { scope: "script_execution_mode" }
  });
}
