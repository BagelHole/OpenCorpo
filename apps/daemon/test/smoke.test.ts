import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
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
});
