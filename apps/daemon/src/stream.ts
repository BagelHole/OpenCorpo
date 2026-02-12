import type { DbHandle } from "./db";

export type StreamClient = {
  id: number;
  send: (payload: string) => void;
};

const clients = new Map<number, StreamClient>();
let nextId = 1;

export function registerClient(send: (payload: string) => void) {
  const id = nextId++;
  clients.set(id, { id, send });
  return id;
}

export function unregisterClient(id: number) {
  clients.delete(id);
}

export function broadcast(event: string, data: unknown) {
  const payload = JSON.stringify({ event, data });
  const message = `data: ${payload}\n\n`;
  for (const client of clients.values()) {
    client.send(message);
  }
}

export function attachEventBroadcast(db: DbHandle) {
  const emit = db.prepare(
    `SELECT id, ts, type, data_json
     FROM events
     WHERE id > ?
     ORDER BY id ASC`
  );

  let lastId = 0;
  setInterval(() => {
    const rows = emit.all(lastId) as Array<{
      id: number;
      ts: string;
      type: string;
      data_json: string | null;
    }>;
    for (const row of rows) {
      lastId = row.id;
      broadcast(row.type, {
        id: row.id,
        ts: row.ts,
        data: row.data_json ? JSON.parse(String(row.data_json)) : null
      });
    }
  }, 1000);
}
