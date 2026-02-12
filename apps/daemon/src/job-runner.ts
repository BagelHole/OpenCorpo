import type { DbHandle } from "./db";
import { writeAudit } from "./audit";
import { writeEvent } from "./events";
import { getJobById } from "./jobs";
import { createApproval } from "./approvals";
import { evaluatePolicy, type PolicyFile } from "./policy";
import { executeTool } from "./tool-runner";
import { findTool } from "./tools";
import { validateToolInput, type ToolRegistry } from "./tool-registry";

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
};

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

    const outputs: Array<Record<string, unknown>> = state.outputs ?? [];
    let blocked = false;
    let stepIndex = state.stepIndex ?? 0;

    for (let i = stepIndex; i < steps.length; i += 1) {
      const step = steps[i];
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
