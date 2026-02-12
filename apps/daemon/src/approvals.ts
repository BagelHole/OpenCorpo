import type { DbHandle } from "./db";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "executed"
  | "failed";

export type ApprovalRequest = {
  requestedBy: string;
  tool?: string;
  action?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export function createApproval(db: DbHandle, req: ApprovalRequest) {
  const stmt = db.prepare(
    `INSERT INTO approvals (ts, status, reason, requested_by, tool, action, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    new Date().toISOString(),
    "pending",
    req.reason ?? null,
    req.requestedBy,
    req.tool ?? null,
    req.action ?? null,
    req.metadata ? JSON.stringify(req.metadata) : null
  );
  return Number(info.lastInsertRowid);
}

export function listApprovals(db: DbHandle, limit = 100) {
  const stmt = db.prepare(
    `SELECT id, ts, status, reason, requested_by, tool, action, metadata_json
     FROM approvals
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(limit).map((row) => ({
    ...row,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
  }));
}

export function getApprovalById(db: DbHandle, id: number) {
  const stmt = db.prepare(
    `SELECT id, ts, status, reason, requested_by, tool, action, metadata_json
     FROM approvals
     WHERE id = ?`
  );
  const row = stmt.get(id) as
    | {
        id: number;
        ts: string;
        status: string;
        reason: string | null;
        requested_by: string;
        tool: string | null;
        action: string | null;
        metadata_json: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
  };
}

export function updateApprovalStatus(
  db: DbHandle,
  id: number,
  status: ApprovalStatus
) {
  const stmt = db.prepare(
    `UPDATE approvals SET status = ? WHERE id = ?`
  );
  const info = stmt.run(status, id);
  return info.changes > 0;
}
