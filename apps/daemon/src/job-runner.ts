import type { DbHandle } from "./db";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { writeAudit } from "./audit";
import { writeEvent } from "./events";
import { getJobById } from "./jobs";
import { createApproval } from "./approvals";
import { evaluatePolicy, type PolicyFile } from "./policy";
import { executeTool } from "./tool-runner";
import { findTool } from "./tools";
import { validateToolInput, type ToolRegistry } from "./tool-registry";
import { jobsScriptsRoot } from "./paths";
import { createScriptDbSession } from "./script-db-sessions";
import { getScriptExecutionMode, type ScriptExecutionMode } from "./script-security";

export type JobRunRow = {
  id: number;
  job_id: number;
  ts: string;
  status: string;
  output_json: string | null;
  error: string | null;
};

type JobStep = {
  tool: string;
  with?: Record<string, unknown>;
  args?: Record<string, unknown>;
};

function toCanonicalToolName(name: string) {
  return name.trim().toLowerCase().replace(/[_.-]+/g, ".");
}

function toCamelKey(key: string) {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function normalizeStepInput(input?: Record<string, unknown>) {
  if (!input || typeof input !== "object") return input;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    normalized[toCamelKey(key)] = value;
  }
  return normalized;
}

function normalizeJobStep(step: JobStep): JobStep {
  const rawInput =
    step.with && typeof step.with === "object"
      ? step.with
      : step.args && typeof step.args === "object"
        ? step.args
        : undefined;
  return {
    tool: toCanonicalToolName(step.tool),
    with: normalizeStepInput(rawInput)
  };
}

export function listJobRuns(db: DbHandle, limit = 100) {
  const stmt = db.prepare(
    `SELECT id, job_id, ts, status, output_json, error
     FROM job_runs
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(limit).map((row) => ({
    ...row,
    output: row.output_json ? JSON.parse(String(row.output_json)) : null
  }));
}

export function getJobRunById(db: DbHandle, id: number) {
  const stmt = db.prepare(
    `SELECT id, job_id, ts, status, output_json, error
     FROM job_runs
     WHERE id = ?`
  );
  const row = stmt.get(id) as JobRunRow | undefined;
  if (!row) return null;
  return row;
}

export function claimQueuedRuns(db: DbHandle, limit = 5) {
  const stmt = db.prepare(
    `SELECT id, job_id, ts, status, output_json
     FROM job_runs
     WHERE status = 'queued'
     ORDER BY id ASC
     LIMIT ?`
  );
  return stmt.all(limit) as JobRunRow[];
}

export function updateJobRunStatus(
  db: DbHandle,
  runId: number,
  status: "queued" | "running" | "completed" | "failed" | "waiting_approval",
  output?: Record<string, unknown>
) {
  const stmt = db.prepare(
    `UPDATE job_runs SET status = ?, output_json = ?, error = ? WHERE id = ?`
  );
  const error = output && typeof output.error === "string" ? output.error : null;
  stmt.run(status, output ? JSON.stringify(output) : null, error, runId);
}

export async function processQueuedRuns(
  db: DbHandle,
  registry: ToolRegistry,
  policy: PolicyFile | null
) {
  const runs = claimQueuedRuns(db, 5);
  for (const run of runs) {
    const state = parseRunState(run.output_json);
    updateJobRunStatus(db, run.id, "running", state);
    writeAudit(db, {
      actor: "system",
      action: "job_run_started",
      metadata: { jobRunId: run.id, jobId: run.job_id }
    });
    writeEvent(db, {
      type: "job.run.started",
      data: { jobRunId: run.id, jobId: run.job_id }
    });

    const job = getJobById(db, run.job_id);
    if (!job || !job.definition) {
      updateJobRunStatus(db, run.id, "failed", { error: "missing_job_definition" });
      writeAudit(db, {
        actor: "system",
        action: "job_run_failed",
        metadata: { jobRunId: run.id, jobId: run.job_id }
      });
      writeEvent(db, {
        type: "job.run.failed",
        data: { jobRunId: run.id, jobId: run.job_id }
      });
      continue;
    }

    const steps = Array.isArray(job.definition.steps)
      ? (job.definition.steps as JobStep[])
      : [];
    const scriptConfig =
      job.definition &&
      typeof job.definition === "object" &&
      job.definition.script &&
      typeof job.definition.script === "object"
        ? (job.definition.script as Record<string, unknown>)
        : null;

    if (scriptConfig) {
      const scriptResult = await runScriptJob(scriptConfig, {
        db,
        jobId: run.job_id,
        jobRunId: run.id
      });
      if (!scriptResult.ok) {
        updateJobRunStatus(db, run.id, "failed", {
          error: "script_failed",
          script: scriptResult
        });
        writeAudit(db, {
          actor: "system",
          action: "job_run_failed",
          metadata: { jobRunId: run.id, jobId: run.job_id, reason: "script_failed" }
        });
        writeEvent(db, {
          type: "job.run.failed",
          data: { jobRunId: run.id, jobId: run.job_id }
        });
        continue;
      }
      updateJobRunStatus(db, run.id, "completed", {
        ok: true,
        script: scriptResult
      });
      writeAudit(db, {
        actor: "system",
        action: "job_run_completed",
        metadata: { jobRunId: run.id, jobId: run.job_id, mode: "script" }
      });
      writeEvent(db, {
        type: "job.run.completed",
        data: { jobRunId: run.id, jobId: run.job_id }
      });
      continue;
    }

    const outputs: Array<Record<string, unknown>> = state.outputs ?? [];
    let blocked = false;
    let stepIndex = state.stepIndex ?? 0;

    for (let i = stepIndex; i < steps.length; i += 1) {
      const step = normalizeJobStep(steps[i]);
      const tool = findTool(registry.definitions, step.tool);
      if (!tool) {
        outputs.push({ error: "tool_not_found", tool: step.tool });
        updateJobRunStatus(db, run.id, "failed", {
          stepIndex: i,
          outputs,
          error: "tool_not_found"
        });
        blocked = true;
        break;
      }

      const validation = validateToolInput(
        registry,
        tool.name,
        (step.with ?? null) as Record<string, unknown> | null
      );
      if (!validation.valid) {
        outputs.push({ error: "invalid_input", tool: tool.name, details: validation.errors });
        updateJobRunStatus(db, run.id, "failed", {
          stepIndex: i,
          outputs,
          error: "invalid_input"
        });
        blocked = true;
        break;
      }

      const policyResult = evaluatePolicy(policy, {
        risk: tool.risk,
        tool: tool.name,
        action: "invoke",
        actor: "job"
      });

      if (policyResult.decision === "deny") {
        updateJobRunStatus(db, run.id, "failed", {
          stepIndex: i,
          outputs,
          error: "policy_denied"
        });
        blocked = true;
        break;
      }

      if (policyResult.decision === "approve" || tool.risk === "high") {
        const approvalId = createApproval(db, {
          requestedBy: "job",
          tool: tool.name,
          action: "invoke",
          reason: policyResult.reason ?? "Job step requires approval.",
          metadata: { input: step.with ?? null, jobRunId: run.id, stepIndex: i }
        });
        writeAudit(db, {
          actor: "system",
          action: "job_step_approval_requested",
          metadata: { jobRunId: run.id, approvalId, tool: tool.name }
        });
        updateJobRunStatus(db, run.id, "waiting_approval", {
          stepIndex: i,
          outputs,
          waitingApproval: { approvalId, tool: tool.name, stepIndex: i }
        });
        writeEvent(db, {
          type: "job.run.waiting_approval",
          data: { jobRunId: run.id, approvalId }
        });
        blocked = true;
        break;
      }

      const result = await executeTool(
        db,
        {
          tool,
          input: step.with ?? null,
          context: { actor: "job", jobId: run.job_id, jobRunId: run.id }
        },
        registry
      );
      outputs.push({ tool: tool.name, result });
      stepIndex = i + 1;
      if (!result.ok) {
        updateJobRunStatus(db, run.id, "failed", {
          stepIndex,
          outputs,
          error: "tool_failed"
        });
        blocked = true;
        break;
      }
    }

    if (!blocked) {
      updateJobRunStatus(db, run.id, "completed", { stepIndex, outputs, ok: true });
      writeAudit(db, {
        actor: "system",
        action: "job_run_completed",
        metadata: { jobRunId: run.id, jobId: run.job_id }
      });
      writeEvent(db, {
        type: "job.run.completed",
        data: { jobRunId: run.id, jobId: run.job_id }
      });
    }
  }
}

type RunState = {
  stepIndex: number;
  outputs: Array<Record<string, unknown>>;
  waitingApproval?: {
    approvalId: number;
    tool: string;
    stepIndex: number;
  };
};

export function parseRunState(raw: string | null): RunState {
  if (!raw) return { stepIndex: 0, outputs: [] };
  try {
    const parsed = JSON.parse(String(raw)) as Partial<RunState>;
    return {
      stepIndex: typeof parsed.stepIndex === "number" ? parsed.stepIndex : 0,
      outputs: Array.isArray(parsed.outputs) ? parsed.outputs : [],
      waitingApproval: parsed.waitingApproval
    };
  } catch {
    return { stepIndex: 0, outputs: [] };
  }
}

type ScriptRunResult =
  | {
      ok: true;
      command: string;
      args: string[];
      stdout: string;
      stderr: string;
      exitCode: number;
      elapsedMs: number;
    }
  | {
      ok: false;
      error: string;
      command?: string;
      args?: string[];
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      elapsedMs?: number;
    };

function resolveBunBinary() {
  if (process.env.BUN_BINARY && process.env.BUN_BINARY.trim()) {
    return process.env.BUN_BINARY.trim();
  }
  if (process.execPath && /bun(\.exe)?$/i.test(process.execPath)) {
    return process.execPath;
  }
  return "bun";
}

function resolveScriptPath(scriptPath: string) {
  if (!scriptPath.trim()) return null;
  if (isAbsolute(scriptPath)) return null;
  const absolutePath = resolve(jobsScriptsRoot, scriptPath);
  const rel = relative(jobsScriptsRoot, absolutePath);
  if (rel.startsWith("..") || rel.includes(":")) return null;
  return absolutePath;
}

async function runScriptJob(
  script: Record<string, unknown>,
  runContext: { db: DbHandle; jobId: number; jobRunId: number }
): Promise<ScriptRunResult> {
  const scriptPath = typeof script.path === "string" ? script.path : "";
  const absolutePath = resolveScriptPath(scriptPath);
  if (!absolutePath) return { ok: false, error: "invalid_script_path" };
  if (!existsSync(absolutePath)) return { ok: false, error: "script_not_found" };

  const args = Array.isArray(script.args)
    ? script.args.map((arg) => String(arg))
    : [];
  const timeoutMs =
    typeof script.timeout_ms === "number" && Number.isFinite(script.timeout_ms)
      ? Math.max(1000, Number(script.timeout_ms))
      : 120000;
  const envInput =
    script.env && typeof script.env === "object"
      ? (script.env as Record<string, unknown>)
      : {};
  const scriptDbSession = createScriptDbSession({
    jobId: runContext.jobId,
    jobRunId: runContext.jobRunId
  });
  const executionMode = getScriptExecutionMode(runContext.db);
  const daemonPort = Number(process.env.OPENCORPO_PORT || 3555);

  if (executionMode === "safe") {
    const source = readFileSync(absolutePath, "utf-8");
    const violation = detectSafeModeViolation(source);
    if (violation) {
      return {
        ok: false,
        error: `script_blocked_in_safe_mode:${violation}`
      };
    }
  }

  const env = Object.fromEntries(
    Object.entries(envInput).map(([key, value]) => [key, String(value)])
  );
  const command = resolveBunBinary();
  const commandArgs = ["run", absolutePath, ...args];
  const childEnv = buildScriptEnv(executionMode, env, {
    daemonPort,
    scriptDbToken: scriptDbSession.token,
    writableTables: scriptDbSession.writableTables
  });

  return await new Promise<ScriptRunResult>((resolveResult) => {
    const started = Date.now();
    const child = spawn(command, commandArgs, {
      cwd: jobsScriptsRoot,
      env: childEnv,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({
        ok: false,
        error: error.message,
        command,
        args: commandArgs,
        stdout,
        stderr,
        exitCode: null,
        elapsedMs: Date.now() - started
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - started;
      if (timedOut) {
        resolveResult({
          ok: false,
          error: `script_timeout_${timeoutMs}ms`,
          command,
          args: commandArgs,
          stdout,
          stderr,
          exitCode: code,
          elapsedMs
        });
        return;
      }
      if (code !== 0) {
        resolveResult({
          ok: false,
          error: `script_exit_${code ?? "unknown"}`,
          command,
          args: commandArgs,
          stdout,
          stderr,
          exitCode: code,
          elapsedMs
        });
        return;
      }
      resolveResult({
        ok: true,
        command,
        args: commandArgs,
        stdout,
        stderr,
        exitCode: code ?? 0,
        elapsedMs
      });
    });
  });
}

function detectSafeModeViolation(source: string): string | null {
  const checks: Array<{ name: string; pattern: RegExp }> = [
    { name: "bun:sqlite", pattern: /\bbun:sqlite\b/i },
    { name: "node:child_process", pattern: /\bnode:child_process\b/i },
    { name: "child_process", pattern: /\bchild_process\b/i }
  ];
  for (const check of checks) {
    if (check.pattern.test(source)) return check.name;
  }
  return null;
}

function buildScriptEnv(
  mode: ScriptExecutionMode,
  scriptEnv: Record<string, string>,
  context: { daemonPort: number; scriptDbToken: string; writableTables: string[] }
) {
  const base: Record<string, string | undefined> =
    mode === "trusted"
      ? { ...process.env }
      : {
          PATH: process.env.PATH,
          Path: process.env.Path,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          WINDIR: process.env.WINDIR,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          HOMEDRIVE: process.env.HOMEDRIVE,
          HOMEPATH: process.env.HOMEPATH,
          NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
          OS: process.env.OS
        };

  return {
    ...base,
    ...scriptEnv,
    OPENCORPO_SCRIPT_EXECUTION_MODE: mode,
    OPENCORPO_SCRIPT_DB_URL: `http://127.0.0.1:${context.daemonPort}/script-db`,
    OPENCORPO_SCRIPT_DB_TOKEN: context.scriptDbToken,
    OPENCORPO_SCRIPT_DB_WRITABLE_TABLES: context.writableTables.join(",")
  };
}
