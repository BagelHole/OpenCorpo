import type { DbHandle } from "./db";
import { updateApprovalStatus } from "./approvals";
import { writeAudit } from "./audit";
import { writeEvent } from "./events";

export type ApprovalRow = {
  id: number;
  ts: string;
  status: string;
  reason: string | null;
  requested_by: string;
  tool: string | null;
  action: string | null;
  metadata_json: string | null;
};

export function listApprovedApprovals(db: DbHandle, limit = 10) {
  const stmt = db.prepare(
    `SELECT id, ts, status, reason, requested_by, tool, action, metadata_json
     FROM approvals
     WHERE status = 'approved'
     ORDER BY id ASC
     LIMIT ?`
  );
  return stmt.all(limit) as ApprovalRow[];
}

export function markApprovalExecuted(db: DbHandle, id: number) {
  updateApprovalStatus(db, id, "executed");
  writeAudit(db, { actor: "system", action: "approval_executed", metadata: { id } });
  writeEvent(db, { type: "approval.executed", data: { id } });
}

export function markApprovalFailed(db: DbHandle, id: number, error: string) {
  updateApprovalStatus(db, id, "failed");
  writeAudit(db, {
    actor: "system",
    action: "approval_failed",
    metadata: { id, error }
  });
  writeEvent(db, { type: "approval.failed", data: { id, error } });
}
