import { randomBytes } from "node:crypto";
import type { DbHandle } from "./db";

export type CapabilityGrant = {
  id: number;
  token: string;
  actor: string;
  capabilities: string[];
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export function createCapabilityGrant(
  db: DbHandle,
  input: {
    actor: string;
    capabilities: string[];
    ttlSeconds?: number;
  }
) {
  const token = randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt =
    typeof input.ttlSeconds === "number" && input.ttlSeconds > 0
      ? new Date(now.getTime() + input.ttlSeconds * 1000).toISOString()
      : null;

  const stmt = db.prepare(
    `INSERT INTO capability_grants (token, actor, capabilities_json, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    token,
    input.actor,
    JSON.stringify(input.capabilities),
    expiresAt,
    null,
    now.toISOString()
  );
  return {
    id: Number(info.lastInsertRowid),
    token,
    expiresAt
  };
}

export function getGrantByToken(db: DbHandle, token: string): CapabilityGrant | null {
  const stmt = db.prepare(
    `SELECT id, token, actor, capabilities_json, expires_at, revoked_at, created_at
     FROM capability_grants
     WHERE token = ?
     LIMIT 1`
  );
  const row = stmt.get(token) as
    | {
        id: number;
        token: string;
        actor: string;
        capabilities_json: string;
        expires_at: string | null;
        revoked_at: string | null;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    token: row.token,
    actor: row.actor,
    capabilities: JSON.parse(String(row.capabilities_json)),
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at
  };
}

export function listCapabilityGrants(db: DbHandle, limit = 50) {
  const stmt = db.prepare(
    `SELECT id, token, actor, capabilities_json, expires_at, revoked_at, created_at
     FROM capability_grants
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(limit).map((row) => ({
    ...row,
    capabilities: row.capabilities_json
      ? JSON.parse(String(row.capabilities_json))
      : []
  }));
}

export function revokeGrant(db: DbHandle, id: number) {
  const stmt = db.prepare(
    `UPDATE capability_grants
     SET revoked_at = ?
     WHERE id = ?`
  );
  const info = stmt.run(new Date().toISOString(), id);
  return info.changes > 0;
}

export function isGrantActive(grant: CapabilityGrant | null, at = new Date()) {
  if (!grant) return false;
  if (grant.revoked_at) return false;
  if (!grant.expires_at) return true;
  return Date.parse(grant.expires_at) > at.getTime();
}
