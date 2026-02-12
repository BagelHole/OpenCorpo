import type { DbHandle } from "./db";

export type ToolRunStatus = "running" | "completed" | "failed";

export type ToolRunInput = {
  tool: string;
  actor: string;
  status: ToolRunStatus;
  approvalId?: number;
  jobId?: number;
  jobRunId?: number;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  error?: string | null;
};

export function createToolRun(db: DbHandle, input: ToolRunInput) {
  const stmt = db.prepare(
    `INSERT INTO tool_runs (ts, tool, actor, status, approval_id, job_id, job_run_id, input_json, output_json, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    new Date().toISOString(),
    input.tool,
    input.actor,
    input.status,
    input.approvalId ?? null,
    input.jobId ?? null,
    input.jobRunId ?? null,
    input.input ? JSON.stringify(input.input) : null,
    input.output ? JSON.stringify(input.output) : null,
    input.error ?? null
  );
  return Number(info.lastInsertRowid);
}

export function updateToolRun(
  db: DbHandle,
  id: number,
  status: ToolRunStatus,
  output?: Record<string, unknown> | null,
  error?: string | null
) {
  const stmt = db.prepare(
    `UPDATE tool_runs SET status = ?, output_json = ?, error = ? WHERE id = ?`
  );
  stmt.run(status, output ? JSON.stringify(output) : null, error ?? null, id);
}

export function listToolRuns(db: DbHandle, limit = 100) {
  const stmt = db.prepare(
    `SELECT id, ts, tool, actor, status, approval_id, job_id, job_run_id, input_json, output_json, error
     FROM tool_runs
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(limit).map((row) => ({
    ...row,
    input: row.input_json ? JSON.parse(String(row.input_json)) : null,
    output: row.output_json ? JSON.parse(String(row.output_json)) : null
  }));
}

export function getToolRunById(db: DbHandle, id: number) {
  const stmt = db.prepare(
    `SELECT id, ts, tool, actor, status, approval_id, job_id, job_run_id, input_json, output_json, error
     FROM tool_runs
     WHERE id = ?`
  );
  const row = stmt.get(id) as
    | {
        id: number;
        ts: string;
        tool: string;
        actor: string;
        status: string;
        approval_id: number | null;
        job_id: number | null;
        job_run_id: number | null;
        input_json: string | null;
        output_json: string | null;
        error: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    ...row,
    input: row.input_json ? JSON.parse(String(row.input_json)) : null,
    output: row.output_json ? JSON.parse(String(row.output_json)) : null
  };
}
