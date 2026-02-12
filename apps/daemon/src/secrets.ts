import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DbHandle } from "./db";
import { secretsRoot } from "./paths";

function secretFilePath(name: string) {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return resolve(secretsRoot, `${safeName}.secret`);
}

export function setSecretRef(
  db: DbHandle,
  input: {
    name: string;
    value: string;
    provider?: string;
    metadata?: Record<string, unknown>;
  }
) {
  mkdirSync(secretsRoot, { recursive: true });
  const refPath = secretFilePath(input.name);
  writeFileSync(refPath, input.value, { encoding: "utf-8", mode: 0o600 });
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO secret_refs (name, provider, ref, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       provider = excluded.provider,
       ref = excluded.ref,
       metadata_json = excluded.metadata_json,
       updated_at = excluded.updated_at`
  ).run(
    input.name,
    input.provider ?? "local_file",
    refPath,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now,
    now
  );
  return { name: input.name, ref: refPath };
}

export function getSecretRef(db: DbHandle, name: string) {
  const row = db
    .query(
      `SELECT id, name, provider, ref, metadata_json, created_at, updated_at
       FROM secret_refs
       WHERE name = ?`
    )
    .get(name) as
    | {
        id: number;
        name: string;
        provider: string;
        ref: string;
        metadata_json: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
  };
}

export function getSecretValue(db: DbHandle, name: string) {
  const ref = getSecretRef(db, name);
  if (!ref) return null;
  if (!existsSync(ref.ref)) return null;
  return readFileSync(ref.ref, "utf-8");
}

export function listSecrets(db: DbHandle, limit = 100) {
  return db
    .query(
      `SELECT id, name, provider, ref, metadata_json, created_at, updated_at
       FROM secret_refs
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit)
    .map((row) => ({
      ...row,
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
    }));
}
