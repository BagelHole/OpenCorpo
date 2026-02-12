import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DbHandle } from "./db";
import { detectKind, validateControlPlaneDocument } from "./control-plane";

type ProposedChangeInput = {
  actor: string;
  relativePath: string;
  afterJson: unknown;
  summary?: string;
};

function resolveRisk(relativePath: string) {
  if (relativePath === "policy.json") return "high";
  if (relativePath.startsWith("tools/")) return "high";
  if (relativePath.startsWith("jobs/")) return "medium";
  if (relativePath.startsWith("workflows/")) return "medium";
  return "low";
}

function safeRelativePath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized.endsWith(".json")) {
    throw new Error("Control Plane changes must target JSON files.");
  }
  if (normalized.includes("..")) {
    throw new Error("Path traversal is not allowed.");
  }
  return normalized;
}

export function listControlPlaneChanges(db: DbHandle, limit = 100) {
  const stmt = db.prepare(
    `SELECT id, kind, file_path, status, actor, summary, before_json, after_json, risk, created_at, applied_at
     FROM control_plane_changes
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(limit).map((row) => ({
    ...row,
    before: row.before_json ? JSON.parse(String(row.before_json)) : null,
    after: row.after_json ? JSON.parse(String(row.after_json)) : null
  }));
}

export function proposeControlPlaneChange(
  db: DbHandle,
  controlPlaneRoot: string,
  input: ProposedChangeInput
) {
  const relativePath = safeRelativePath(input.relativePath);
  const kind = detectKind(relativePath);
  if (!kind) {
    throw new Error("Unsupported Control Plane file path.");
  }

  const absolutePath = resolve(controlPlaneRoot, relativePath);
  const beforeRaw = existsSync(absolutePath)
    ? readFileSync(absolutePath, "utf-8")
    : null;
  const beforeJson = beforeRaw ? JSON.parse(beforeRaw) : null;

  const { valid, errors } = validateControlPlaneDocument(kind, input.afterJson);
  if (!valid) {
    return {
      ok: false as const,
      error: "invalid_control_plane_change",
      details: errors
    };
  }

  const summary =
    input.summary ??
    `Update ${relativePath} (${beforeJson ? "modify" : "create"})`;
  const risk = resolveRisk(relativePath);
  const createdAt = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO control_plane_changes (kind, file_path, status, actor, summary, before_json, after_json, risk, created_at, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    kind,
    relativePath,
    "proposed",
    input.actor,
    summary,
    beforeJson ? JSON.stringify(beforeJson) : null,
    JSON.stringify(input.afterJson),
    risk,
    createdAt,
    null
  );
  return {
    ok: true as const,
    id: Number(info.lastInsertRowid),
    kind,
    relativePath,
    risk
  };
}

export function applyControlPlaneChange(
  db: DbHandle,
  controlPlaneRoot: string,
  id: number
) {
  const row = db
    .query(
      `SELECT id, file_path, status, after_json
       FROM control_plane_changes
       WHERE id = ?`
    )
    .get(id) as
    | {
        id: number;
        file_path: string;
        status: string;
        after_json: string;
      }
    | undefined;
  if (!row) return { ok: false as const, error: "not_found" };
  if (row.status !== "proposed") {
    return { ok: false as const, error: "change_not_proposed" };
  }

  const absolutePath = resolve(controlPlaneRoot, row.file_path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(
    absolutePath,
    `${JSON.stringify(JSON.parse(row.after_json), null, 2)}\n`,
    "utf-8"
  );

  db.prepare(
    `UPDATE control_plane_changes
     SET status = ?, applied_at = ?
     WHERE id = ?`
  ).run("applied", new Date().toISOString(), id);

  return { ok: true as const, id };
}

export function rejectControlPlaneChange(db: DbHandle, id: number) {
  const info = db
    .prepare(
      `UPDATE control_plane_changes
       SET status = ?
       WHERE id = ? AND status = 'proposed'`
    )
    .run("rejected", id);
  return info.changes > 0;
}
