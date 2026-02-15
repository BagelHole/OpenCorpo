import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../../../packages/core/src/migrations";
import {
  createCapabilityGrant,
  getGrantByToken,
  isGrantActive
} from "../src/capability-grants";
import {
  applyControlPlaneChange,
  proposeControlPlaneChange
} from "../src/control-plane-changes";

describe("daemon smoke", () => {
  test("runs migrations and creates grant", () => {
    const db = new Database(":memory:");
    const result = runMigrations(db);
    expect(result.currentVersion).toBeTruthy();

    const grant = createCapabilityGrant(db, {
      actor: "test",
      capabilities: ["gmail.read"],
      ttlSeconds: 30
    });
    const found = getGrantByToken(db, grant.token);
    expect(found?.actor).toBe("test");
    expect(isGrantActive(found)).toBe(true);
  });

  test("proposes and applies control plane change", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const tempRoot = mkdtempSync(join(tmpdir(), "oc-control-plane-"));
    mkdirSync(join(tempRoot, "jobs"), { recursive: true });

    const proposal = proposeControlPlaneChange(db, tempRoot, {
      actor: "test",
      relativePath: "jobs/heartbeat.job.json",
      afterJson: {
        name: "Heartbeat",
        enabled: true,
        schedule: { interval_seconds: 45 },
        capabilities_required: ["system.ping"],
        steps: [{ tool: "system.ping", with: { message: "ok" } }]
      }
    });

    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const applied = applyControlPlaneChange(db, tempRoot, proposal.id);
    expect(applied.ok).toBe(true);

    const saved = JSON.parse(
      readFileSync(join(tempRoot, "jobs/heartbeat.job.json"), "utf-8")
    ) as { schedule: { interval_seconds: number } };
    expect(saved.schedule.interval_seconds).toBe(45);
  });

  test("runs script jobs from userland/jobs", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const { jobsScriptsRoot } = await import("../src/paths");
    mkdirSync(jobsScriptsRoot, { recursive: true });
    const scriptName = `hello-smoke-${Date.now()}.js`;
    const scriptPath = join(jobsScriptsRoot, scriptName);
    writeFileSync(scriptPath, `console.log("hello-from-script-job");`, "utf-8");
    try {
      const { createJob, recordJobRun } = await import("../src/jobs");
      const { listJobRuns, processQueuedRuns } = await import("../src/job-runner");
      const jobId = createJob(db, {
        name: "Script smoke",
        enabled: true,
        definition: {
          name: "Script smoke",
          enabled: true,
          script: {
            path: scriptName,
            timeout_ms: 20000
          }
        }
      });
      const runId = recordJobRun(db, jobId, "queued");

      await processQueuedRuns(
        db,
        {
          definitions: [],
          handlers: new Map(),
          warnings: [],
          validators: new Map()
        },
        null
      );

      const run = listJobRuns(db, 20).find((item) => item.id === runId);
      expect(run?.status).toBe("completed");
      const output = run?.output as { script?: { stdout?: string } } | null;
      expect(output?.script?.stdout?.includes("hello-from-script-job")).toBe(true);
    } finally {
      rmSync(scriptPath, { force: true });
    }
  });
});
