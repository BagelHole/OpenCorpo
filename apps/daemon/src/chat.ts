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

export function createSession(db: DbHandle, title?: string) {
  const stmt = db.prepare(
    `INSERT INTO chat_sessions (ts, title, metadata_json)
     VALUES (?, ?, ?)`
  );
  const info = stmt.run(new Date().toISOString(), title ?? null, null);
  return Number(info.lastInsertRowid);
}

export function listSessions(db: DbHandle, limit = 50) {
  const stmt = db.prepare(
    `SELECT id, ts, title, metadata_json
     FROM chat_sessions
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(limit).map((row) => ({
    ...row,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null
  }));
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
