import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DbHandle } from "./db";

type ProposeCodeInput = {
  actor: string;
  targetPath: string;
  afterContent: string;
  summary?: string;
  reason?: string;
};

function normalizeRelativePath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.includes("..")) {
    throw new Error("Path traversal is not allowed.");
  }
  return normalized;
}

export function listCodeChangeProposals(db: DbHandle, limit = 100) {
  const stmt = db.prepare(
    `SELECT id, status, actor, target_path, summary, reason, before_content, after_content, approval_id, created_at, applied_at
     FROM code_change_proposals
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(limit);
}

export function proposeCodeChange(
  db: DbHandle,
  workspaceRoot: string,
  input: ProposeCodeInput
) {
  const relativeTarget = normalizeRelativePath(input.targetPath);
  const absoluteTarget = resolve(workspaceRoot, relativeTarget);
  const absoluteWorkspace = resolve(workspaceRoot);
  if (!absoluteTarget.startsWith(absoluteWorkspace)) {
    throw new Error("Code change target must stay inside userland workspace.");
  }
  if (!relativeTarget.match(/\.(ts|tsx|js|jsx|json|md|txt)$/i)) {
    throw new Error("Tier B code edits are limited to workspace source/config files.");
  }
  if (input.afterContent.length > 300_000) {
    throw new Error("Proposed content is too large.");
  }

  const beforeContent = existsSync(absoluteTarget)
    ? readFileSync(absoluteTarget, "utf-8")
    : null;

  const stmt = db.prepare(
    `INSERT INTO code_change_proposals (status, actor, target_path, summary, reason, before_content, after_content, approval_id, created_at, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    "proposed",
    input.actor,
    relativeTarget,
    input.summary ?? `Update ${relativeTarget}`,
    input.reason ?? null,
    beforeContent,
    input.afterContent,
    null,
    new Date().toISOString(),
    null
  );
  return {
    id: Number(info.lastInsertRowid),
    targetPath: relativeTarget
  };
}

export function attachCodeChangeApproval(db: DbHandle, proposalId: number, approvalId: number) {
  const info = db
    .prepare(
      `UPDATE code_change_proposals
       SET approval_id = ?
       WHERE id = ?`
    )
    .run(approvalId, proposalId);
  return info.changes > 0;
}

export function getCodeChangeProposalById(db: DbHandle, id: number) {
  const row = db
    .query(
      `SELECT id, status, actor, target_path, summary, reason, before_content, after_content, approval_id, created_at, applied_at
       FROM code_change_proposals
       WHERE id = ?`
    )
    .get(id) as
    | {
        id: number;
        status: string;
        actor: string;
        target_path: string;
        summary: string | null;
        reason: string | null;
        before_content: string | null;
        after_content: string;
        approval_id: number | null;
        created_at: string;
        applied_at: string | null;
      }
    | undefined;
  return row ?? null;
}

export function applyCodeChangeProposal(
  db: DbHandle,
  workspaceRoot: string,
  id: number
) {
  const proposal = getCodeChangeProposalById(db, id);
  if (!proposal) return { ok: false as const, error: "not_found" };
  if (proposal.status !== "approved") {
    return { ok: false as const, error: "proposal_not_approved" };
  }

  const target = resolve(workspaceRoot, proposal.target_path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, proposal.after_content, "utf-8");

  db.prepare(
    `UPDATE code_change_proposals
     SET status = ?, applied_at = ?
     WHERE id = ?`
  ).run("applied", new Date().toISOString(), id);
  return { ok: true as const, path: proposal.target_path };
}

export function setCodeChangeProposalStatus(
  db: DbHandle,
  id: number,
  status: "approved" | "rejected"
) {
  const info = db
    .prepare(
      `UPDATE code_change_proposals
       SET status = ?
       WHERE id = ? AND status = 'proposed'`
    )
    .run(status, id);
  return info.changes > 0;
}
