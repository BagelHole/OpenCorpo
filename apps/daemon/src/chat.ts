import type { DbHandle } from "./db";

export type ChatSession = {
  id: number;
  ts: string;
  title: string | null;
  metadata_json: string | null;
};

export type ChatMessage = {
  id: number;
  session_id: number;
  ts: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata_json: string | null;
};

export function createSession(
  db: DbHandle,
  title?: string,
  metadata?: Record<string, unknown>
) {
  const stmt = db.prepare(
    `INSERT INTO chat_sessions (ts, title, metadata_json)
     VALUES (?, ?, ?)`
  );
  const info = stmt.run(
    new Date().toISOString(),
    title ?? null,
    metadata ? JSON.stringify(metadata) : null
  );
  return Number(info.lastInsertRowid);
}

export function listSessions(db: DbHandle, limit = 50) {
  const stmt = db.prepare(
    `SELECT id, ts, title, metadata_json
     FROM chat_sessions
     ORDER BY id DESC
     LIMIT ?`
  );
  const rows = stmt.all(limit).map((row) => ({
    ...row,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
  }));
  return rows.sort((a, b) => {
    const aOrder =
      typeof a.metadata?.order === "number" && Number.isFinite(a.metadata.order)
        ? Number(a.metadata.order)
        : null;
    const bOrder =
      typeof b.metadata?.order === "number" && Number.isFinite(b.metadata.order)
        ? Number(b.metadata.order)
        : null;
    if (aOrder !== null && bOrder !== null) return aOrder - bOrder;
    if (aOrder !== null) return -1;
    if (bOrder !== null) return 1;
    return b.id - a.id;
  });
}

export function getSession(db: DbHandle, id: number) {
  const stmt = db.prepare(
    `SELECT id, ts, title, metadata_json
     FROM chat_sessions
     WHERE id = ?`
  );
  const row = stmt.get(id) as ChatSession | undefined;
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
  };
}

export function updateSession(
  db: DbHandle,
  id: number,
  input: { title?: string | null; metadata?: Record<string, unknown> | null }
) {
  const current = getSession(db, id);
  if (!current) return null;
  const nextTitle =
    input.title === undefined ? current.title : input.title ?? null;
  const nextMetadata =
    input.metadata === undefined ? current.metadata ?? null : input.metadata ?? null;
  const stmt = db.prepare(
    `UPDATE chat_sessions
     SET title = ?, metadata_json = ?
     WHERE id = ?`
  );
  const info = stmt.run(
    nextTitle,
    nextMetadata ? JSON.stringify(nextMetadata) : null,
    id
  );
  if (info.changes < 1) return null;
  return getSession(db, id);
}

export function deleteSession(db: DbHandle, id: number) {
  const deleteMessages = db.prepare(
    `DELETE FROM chat_messages
     WHERE session_id = ?`
  );
  const deleteSessionStmt = db.prepare(
    `DELETE FROM chat_sessions
     WHERE id = ?`
  );
  let deleted = false;
  db.transaction(() => {
    deleteMessages.run(id);
    const info = deleteSessionStmt.run(id);
    deleted = info.changes > 0;
  })();
  return deleted;
}

export function addMessage(
  db: DbHandle,
  sessionId: number,
  role: ChatMessage["role"],
  content: string,
  metadata?: Record<string, unknown>
) {
  const stmt = db.prepare(
    `INSERT INTO chat_messages (session_id, ts, role, content, metadata_json)
     VALUES (?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    sessionId,
    new Date().toISOString(),
    role,
    content,
    metadata ? JSON.stringify(metadata) : null
  );
  return Number(info.lastInsertRowid);
}

export function listMessages(db: DbHandle, sessionId: number, limit = 200) {
  const stmt = db.prepare(
    `SELECT id, session_id, ts, role, content, metadata_json
     FROM chat_messages
     WHERE session_id = ?
     ORDER BY id ASC
     LIMIT ?`
  );
  return stmt.all(sessionId, limit).map((row) => ({
    ...row,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
  }));
}
