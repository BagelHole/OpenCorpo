import { randomBytes } from "node:crypto";

type ScriptDbSessionInput = {
  jobId: number;
  jobRunId: number;
  ttlMs?: number;
};

export type ScriptDbSession = {
  token: string;
  jobId: number;
  jobRunId: number;
  createdAt: string;
  expiresAt: string;
  writableTables: string[];
};

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 4;
const MAX_TTL_MS = 1000 * 60 * 60 * 24;
const WRITABLE_TABLES = ["ai_user_notes", "ai_memory_store"] as const;
const sessions = new Map<string, ScriptDbSession>();

export function createScriptDbSession(input: ScriptDbSessionInput): ScriptDbSession {
  cleanupExpiredSessions();
  const ttlMs = Math.max(60_000, Math.min(MAX_TTL_MS, input.ttlMs ?? DEFAULT_TTL_MS));
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const token = randomBytes(24).toString("hex");

  const session: ScriptDbSession = {
    token,
    jobId: input.jobId,
    jobRunId: input.jobRunId,
    createdAt,
    expiresAt,
    writableTables: [...WRITABLE_TABLES]
  };
  sessions.set(token, session);
  return session;
}

export function getScriptDbSession(token: string): ScriptDbSession | null {
  if (!token) return null;
  cleanupExpiredSessions();
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (Date.parse(session.expiresAt) <= now) {
      sessions.delete(token);
    }
  }
}
