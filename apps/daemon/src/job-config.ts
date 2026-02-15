import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DbHandle } from "./db";
import { createJob, getJobByName } from "./jobs";

function pruneLegacyHeartbeat(db: DbHandle, jobsDir: string) {
  const heartbeatPath = join(jobsDir, "heartbeat.job.json");
  if (existsSync(heartbeatPath)) return;
  const rows = db
    .query(
      `SELECT id, definition_json
       FROM jobs
       WHERE name = 'Heartbeat'`
    )
    .all() as Array<{ id: number; definition_json: string | null }>;
  for (const row of rows) {
    const def = row.definition_json ? JSON.parse(String(row.definition_json)) : null;
    const steps = Array.isArray(def?.steps) ? def.steps : [];
    const first = steps[0] as { tool?: string; with?: Record<string, unknown> } | undefined;
    const isLegacy =
      first?.tool === "system.ping" &&
      (typeof first.with?.message !== "string" || first.with?.message === "heartbeat");
    if (!isLegacy) continue;
    db.prepare(`DELETE FROM job_runs WHERE job_id = ?`).run(row.id);
    db.prepare(`DELETE FROM jobs WHERE id = ?`).run(row.id);
  }
}

export function seedJobsFromConfig(db: DbHandle, configRoot: string) {
  const jobsDir = resolve(configRoot, "jobs");
  pruneLegacyHeartbeat(db, jobsDir);
  try {
    for (const entry of readdirSync(jobsDir)) {
      if (!entry.endsWith(".json")) continue;
      const raw = readFileSync(join(jobsDir, entry), "utf-8");
      const job = JSON.parse(raw) as Record<string, unknown>;
      const name = typeof job.name === "string" ? job.name : entry;
      const existing = getJobByName(db, name);
      if (existing) continue;
      createJob(db, {
        name,
        enabled: job.enabled !== false,
        schedule: typeof job.schedule === "object" ? (job.schedule as Record<string, unknown>) : undefined,
        capabilities: Array.isArray(job.capabilities_required)
          ? job.capabilities_required.map((cap) => String(cap))
          : undefined,
        definition: job
      });
    }
  } catch {
    return;
  }
}
