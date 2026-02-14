/**
 * Internal OpenCorpo tools - approvals, jobs, audit.
 * These are always available to the agent.
 */
import type { ToolHandler } from "./tool-types";
import type { DbHandle } from "./db";
import {
  listApprovals,
  updateApprovalStatus,
  getApprovalById
} from "./approvals";
import {
  listJobs,
  getJobById,
  recordJobRun,
  setJobEnabled,
  summarizeSchedule
} from "./jobs";
import { listJobRuns } from "./job-runner";
import { listAudit, writeAudit } from "./audit";
import { writeEvent } from "./events";

export function createInternalToolHandlers(db: DbHandle): ToolHandler[] {
  return [
    {
      name: "opencorpo.list_approvals",
      version: "0.0.1",
      risk: "low",
      capabilities: ["opencorpo.read"],
      async run(input, _execCtx) {
        const pending = (input as { pendingOnly?: boolean }).pendingOnly !== false;
        const items = listApprovals(db, 50);
        const filtered = pending
          ? items.filter((a) => a.status === "pending")
          : items;
        return {
          ok: true,
          approvals: filtered.slice(0, 10).map((a) => ({
            id: a.id,
            tool: a.tool,
            status: a.status,
            reason: a.reason
          }))
        };
      }
    },
    {
      name: "opencorpo.list_jobs",
      version: "0.0.1",
      risk: "low",
      capabilities: ["opencorpo.read"],
      async run(input, _execCtx) {
        const items = listJobs(db, 50);
        return {
          ok: true,
          jobs: items.slice(0, 10).map((j) => ({
            id: j.id,
            name: j.name,
            enabled: Boolean(j.enabled),
            schedule: summarizeSchedule(j.schedule ?? null)
          }))
        };
      }
    },
    {
      name: "opencorpo.run_job",
      version: "0.0.1",
      risk: "low",
      capabilities: ["opencorpo.jobs"],
      async run(input, _execCtx) {
        const id = Number((input as { jobId?: number }).jobId);
        if (!Number.isFinite(id)) {
          return { ok: false, error: "jobId required" };
        }
        const job = getJobById(db, id);
        if (!job) return { ok: false, error: "job_not_found" };
        const runId = recordJobRun(db, id, "queued");
        writeAudit(db, {
          actor: "agent",
          action: "job_run_requested",
          metadata: { jobId: id, jobRunId: runId }
        });
        writeEvent(db, {
          type: "job.run.queued",
          data: { jobId: id, jobRunId: runId }
        });
        return { ok: true, jobRunId: runId, jobName: job.name };
      }
    },
    {
      name: "opencorpo.approve",
      version: "0.0.1",
      risk: "medium",
      capabilities: ["opencorpo.approve"],
      async run(input, _execCtx) {
        const id = Number((input as { approvalId?: number }).approvalId);
        if (!Number.isFinite(id)) {
          return { ok: false, error: "approvalId required" };
        }
        const approval = getApprovalById(db, id);
        if (!approval) return { ok: false, error: "approval_not_found" };
        if (approval.status !== "pending") {
          return { ok: false, error: `approval already ${approval.status}` };
        }
        const ok = updateApprovalStatus(db, id, "approved");
        if (ok) {
          writeAudit(db, {
            actor: "agent",
            action: "approval_approved",
            metadata: { id }
          });
          writeEvent(db, { type: "approval.approved", data: { id } });
        }
        return { ok, approvalId: id };
      }
    },
    {
      name: "opencorpo.deny",
      version: "0.0.1",
      risk: "medium",
      capabilities: ["opencorpo.approve"],
      async run(input, _execCtx) {
        const id = Number((input as { approvalId?: number }).approvalId);
        if (!Number.isFinite(id)) {
          return { ok: false, error: "approvalId required" };
        }
        const approval = getApprovalById(db, id);
        if (!approval) return { ok: false, error: "approval_not_found" };
        if (approval.status !== "pending") {
          return { ok: false, error: `approval already ${approval.status}` };
        }
        const ok = updateApprovalStatus(db, id, "denied");
        if (ok) {
          writeAudit(db, {
            actor: "agent",
            action: "approval_denied",
            metadata: { id }
          });
          writeEvent(db, { type: "approval.denied", data: { id } });
        }
        return { ok, approvalId: id };
      }
    },
    {
      name: "opencorpo.list_audit",
      version: "0.0.1",
      risk: "low",
      capabilities: ["opencorpo.read"],
      async run(input, _execCtx) {
        const limit = Number((input as { limit?: number }).limit) || 10;
        const items = listAudit(db, limit);
        return {
          ok: true,
          entries: items.map((e) => ({
            id: e.id,
            action: e.action,
            actor: e.actor,
            tool: e.tool,
            ts: e.ts
          }))
        };
      }
    }
  ];
}
