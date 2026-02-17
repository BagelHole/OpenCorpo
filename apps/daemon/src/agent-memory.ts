import type { DbHandle } from "./db";

const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 500;
const MAX_SQL_LENGTH = 8000;

const WRITE_SQL_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "replace",
  "drop",
  "alter",
  "create",
  "truncate",
  "attach",
  "detach",
  "vacuum",
  "reindex",
  "analyze",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release"
];

type SqlParam = string | number | null;

export type ReadQueryResult =
  | {
      ok: true;
      rowCount: number;
      rows: Array<Record<string, unknown>>;
      maxRows: number;
      truncated: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type UpsertUserNoteInput = {
  subject: string;
  noteKey: string;
  content: string;
  tags?: string[];
  source?: string;
};

export type UpsertMemoryInput = {
  ownerType: string;
  ownerId: string;
  namespace: string;
  dataKey: string;
  value: unknown;
};

export function listDbTables(db: DbHandle) {
  const rows = db
    .query(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
       ORDER BY name ASC`
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function runReadOnlyQuery(
  db: DbHandle,
  sql: string,
  paramsInput: unknown[] = [],
  maxRowsInput?: number
): ReadQueryResult {
  const normalizedSql = normalizeSql(sql);
  if (!normalizedSql) return { ok: false, error: "sql_required" };
  if (normalizedSql.length > MAX_SQL_LENGTH) return { ok: false, error: "sql_too_long" };
  if (!isReadOnlySql(normalizedSql)) return { ok: false, error: "read_only_queries_only" };
  if (!Array.isArray(paramsInput)) return { ok: false, error: "params_must_be_array" };

  const maxRows = clampMaxRows(maxRowsInput);
  const params = toSqlParams(paramsInput);
  if (!params.ok) return { ok: false, error: params.error };

  try {
    const stmt = db.prepare(normalizedSql);
    const allRows = stmt.all(...params.values) as Array<Record<string, unknown>>;
    const rows = allRows.slice(0, maxRows);
    return {
      ok: true,
      rowCount: rows.length,
      rows,
      maxRows,
      truncated: allRows.length > rows.length
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "query_failed"
    };
  }
}

export function upsertAiUserNote(db: DbHandle, input: UpsertUserNoteInput) {
  const now = new Date().toISOString();
  const tags = Array.isArray(input.tags) ? input.tags.filter((item) => item.trim()) : [];
  db.prepare(
    `INSERT INTO ai_user_notes (subject, note_key, content, tags_json, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject, note_key) DO UPDATE SET
       content = excluded.content,
       tags_json = excluded.tags_json,
       source = excluded.source,
       updated_at = excluded.updated_at`
  ).run(
    input.subject.trim(),
    input.noteKey.trim(),
    input.content.trim(),
    tags.length > 0 ? JSON.stringify(tags) : null,
    input.source?.trim() || null,
    now,
    now
  );
}

export function listAiUserNotes(db: DbHandle, subject?: string, limit = 100) {
  const normalizedLimit = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 100));
  if (subject && subject.trim()) {
    return db
      .prepare(
        `SELECT id, subject, note_key, content, tags_json, source, created_at, updated_at
         FROM ai_user_notes
         WHERE subject = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(subject.trim(), normalizedLimit)
      .map(mapUserNoteRow);
  }
  return db
    .prepare(
      `SELECT id, subject, note_key, content, tags_json, source, created_at, updated_at
       FROM ai_user_notes
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(normalizedLimit)
    .map(mapUserNoteRow);
}

export function upsertAiMemory(db: DbHandle, input: UpsertMemoryInput) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ai_memory_store (owner_type, owner_id, namespace, data_key, value_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_type, owner_id, namespace, data_key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`
  ).run(
    input.ownerType.trim(),
    input.ownerId.trim(),
    input.namespace.trim(),
    input.dataKey.trim(),
    JSON.stringify(input.value ?? null),
    now,
    now
  );
}

export function listAiMemory(
  db: DbHandle,
  input: {
    ownerType?: string;
    ownerId?: string;
    namespace?: string;
    dataKey?: string;
    limit?: number;
  }
) {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (input.ownerType?.trim()) {
    where.push("owner_type = ?");
    values.push(input.ownerType.trim());
  }
  if (input.ownerId?.trim()) {
    where.push("owner_id = ?");
    values.push(input.ownerId.trim());
  }
  if (input.namespace?.trim()) {
    where.push("namespace = ?");
    values.push(input.namespace.trim());
  }
  if (input.dataKey?.trim()) {
    where.push("data_key = ?");
    values.push(input.dataKey.trim());
  }
  const normalizedLimit = Math.max(
    1,
    Math.min(500, Number.isFinite(input.limit) ? Math.floor(Number(input.limit)) : 100)
  );
  values.push(normalizedLimit);

  const sql = `SELECT id, owner_type, owner_id, namespace, data_key, value_json, created_at, updated_at
    FROM ai_memory_store
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC
    LIMIT ?`;
  return db
    .prepare(sql)
    .all(...values)
    .map((row: any) => ({
      ...row,
      value: parseJson(row.value_json)
    }));
}

function mapUserNoteRow(row: any) {
  return {
    ...row,
    tags: parseJson(row.tags_json)
  };
}

function parseJson(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeSql(sql: string) {
  return sql.replaceAll("\u0000", "").trim();
}

function clampMaxRows(value?: number) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ROWS;
  return Math.max(1, Math.min(HARD_MAX_ROWS, Math.floor(Number(value))));
}

function isReadOnlySql(sql: string) {
  const strippedComments = sql
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  if (!strippedComments) return false;
  if (strippedComments.includes(";")) return false;

  const firstToken = strippedComments.split(/\s+/)[0]?.toLowerCase();
  if (!firstToken) return false;
  if (!["select", "with", "pragma", "explain"].includes(firstToken)) return false;

  const lowered = strippedComments.toLowerCase();
  for (const keyword of WRITE_SQL_KEYWORDS) {
    const matcher = new RegExp(`\\b${keyword}\\b`, "i");
    if (matcher.test(lowered)) return false;
  }
  return true;
}

function toSqlParams(params: unknown[]):
  | { ok: true; values: SqlParam[] }
  | { ok: false; error: string } {
  const values: SqlParam[] = [];
  for (const item of params) {
    if (item === null || typeof item === "string" || typeof item === "number") {
      values.push(item);
      continue;
    }
    if (typeof item === "boolean") {
      values.push(item ? 1 : 0);
      continue;
    }
    return { ok: false, error: "unsupported_sql_param_type" };
  }
  return { ok: true, values };
}
