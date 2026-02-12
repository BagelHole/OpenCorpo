import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DbHandle } from "./db";
import { createJob, getJobByName } from "./jobs";

export function seedJobsFromConfig(db: DbHandle, configRoot: string) {
  const jobsDir = resolve(configRoot, "jobs");
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
