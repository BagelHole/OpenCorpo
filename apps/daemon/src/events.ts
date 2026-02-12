import type { DbHandle } from "./db";

export type EventInput = {
  type: string;
  data?: Record<string, unknown>;
};

export function writeEvent(db: DbHandle, event: EventInput) {
  const stmt = db.prepare(
    `INSERT INTO events (ts, type, data_json)
     VALUES (?, ?, ?)`
  );
  stmt.run(
    new Date().toISOString(),
    event.type,
    event.data ? JSON.stringify(event.data) : null
  );
}

export function listEvents(db: DbHandle, limit = 100) {
  const stmt = db.prepare(
    `SELECT id, ts, type, data_json
     FROM events
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(limit).map((row) => ({
    ...row,
    data: row.data_json ? JSON.parse(String(row.data_json)) : null
  }));
}
