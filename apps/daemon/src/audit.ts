import type { DbHandle } from "./db";
import { createHash } from "node:crypto";
import { loadRedactionPolicy, redactMetadata } from "./redaction";

export type AuditEntryInput = {
  actor: string;
  action: string;
  tool?: string;
  policy?: string;
  metadata?: Record<string, unknown>;
};

export type AuditFilter = {
  actor?: string;
  action?: string;
  tool?: string;
  limit?: number;
};

export function writeAudit(db: DbHandle, entry: AuditEntryInput) {
  const redactionPolicy = loadRedactionPolicy();
  const metadata = redactMetadata(entry.metadata, redactionPolicy);
  const ts = new Date().toISOString();
  const prevHashRow = db
    .query(`SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1`)
    .get() as { entry_hash?: string | null } | null;
  const prevHash = prevHashRow?.entry_hash ?? null;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        ts,
        actor: entry.actor,
        action: entry.action,
        tool: entry.tool ?? null,
        policy: entry.policy ?? null,
        metadata: metadata ?? null,
        prevHash
      })
    )
    .digest("hex");

  const stmt = db.prepare(
    `INSERT INTO audit_log (ts, actor, action, tool, policy, metadata_json, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    ts,
    entry.actor,
    entry.action,
    entry.tool ?? null,
    entry.policy ?? null,
    metadata ? JSON.stringify(metadata) : null,
    prevHash,
    digest
  );
}

export function listAudit(db: DbHandle, limit = 100) {
  const stmt = db.prepare(
    `SELECT id, ts, actor, action, tool, policy, metadata_json, prev_hash, entry_hash
     FROM audit_log
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(limit).map((row) => ({
    ...row,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
  }));
}

export function listAuditFiltered(db: DbHandle, filter: AuditFilter) {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filter.actor) {
    where.push("actor = ?");
    params.push(filter.actor);
  }
  if (filter.action) {
    where.push("action = ?");
    params.push(filter.action);
  }
  if (filter.tool) {
    where.push("tool = ?");
    params.push(filter.tool);
  }

  const limit = Number.isFinite(filter.limit) ? Number(filter.limit) : 100;
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const stmt = db.prepare(
    `SELECT id, ts, actor, action, tool, policy, metadata_json, prev_hash, entry_hash
     FROM audit_log
     ${clause}
     ORDER BY id DESC
     LIMIT ?`
  );

  return stmt.all(...params, limit).map((row) => ({
    ...row,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
  }));
}

export function getAuditById(db: DbHandle, id: number) {
  const stmt = db.prepare(
    `SELECT id, ts, actor, action, tool, policy, metadata_json, prev_hash, entry_hash
     FROM audit_log
     WHERE id = ?`
  );
  const row = stmt.get(id) as
    | {
        id: number;
        ts: string;
        actor: string;
        action: string;
        tool: string | null;
        policy: string | null;
        metadata_json: string | null;
        prev_hash: string | null;
        entry_hash: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
  };
}

export function verifyAuditIntegrity(db: DbHandle) {
  const rows = db
    .query(
      `SELECT id, ts, actor, action, tool, policy, metadata_json, prev_hash, entry_hash
       FROM audit_log
       ORDER BY id ASC`
    )
    .all() as Array<{
    id: number;
    ts: string;
    actor: string;
    action: string;
    tool: string | null;
    policy: string | null;
    metadata_json: string | null;
    prev_hash: string | null;
    entry_hash: string | null;
  }>;
  let previousHash: string | null = null;
  for (const row of rows) {
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          ts: row.ts,
          actor: row.actor,
          action: row.action,
          tool: row.tool ?? null,
          policy: row.policy ?? null,
          metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null,
          prevHash: previousHash
        })
      )
      .digest("hex");
    if (row.prev_hash !== previousHash || row.entry_hash !== expected) {
      return {
        ok: false as const,
        badEntryId: row.id,
        expected,
        found: row.entry_hash
      };
    }
    previousHash = row.entry_hash;
  }
  return { ok: true as const, count: rows.length };
}
