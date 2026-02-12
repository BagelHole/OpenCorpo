import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Approval = {
  id: number;
  status: string;
  tool: string | null;
  reason: string | null;
  requested_by: string;
};

type Job = {
  id: number;
  name: string;
  enabled: number;
  schedule_summary?: string | null;
};

type JobRun = {
  id: number;
  job_id: number;
  status: string;
  ts: string;
  error?: string | null;
};

export function InboxView({
  approvals,
  jobs,
  jobRuns,
  onApproval,
  onRunJob,
  onToggleJob
}: {
  approvals: Approval[];
  jobs: Job[];
  jobRuns: JobRun[];
  onApproval: (id: number, action: "approve" | "deny") => Promise<void>;
  onRunJob: (id: number) => Promise<void>;
  onToggleJob: (id: number, enabled: boolean) => Promise<void>;
}) {
  const pendingApprovals = approvals.filter((item) => item.status === "pending");
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="border border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>Approvals Inbox</CardTitle>
          <p className="text-sm text-slate-500">
            High-risk actions are queued here for human review.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {approvals.length === 0 && (
            <div className="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-500">
              No approval items yet.
            </div>
          )}
          {approvals.map((item) => (
            <div
              key={item.id}
              className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-800">
                    {item.tool ?? "Unknown action"}
                  </div>
                  <div className="text-xs text-slate-500">
                    Requested by {item.requested_by}
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    {item.reason || "No reason provided."}
                  </div>
                </div>
                <Badge
                  tone={
                    item.status === "pending"
                      ? "warning"
                      : item.status === "approved" || item.status === "executed"
                      ? "success"
                      : item.status === "denied" || item.status === "failed"
                      ? "danger"
                      : "default"
                  }
                >
                  {item.status}
                </Badge>
              </div>
              {item.status === "pending" && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void onApproval(item.id, "approve")}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void onApproval(item.id, "deny")}
                  >
                    Deny
                  </Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="space-y-5">
        <Card className="border border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Automation Jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {jobs.length === 0 && (
              <div className="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-500">
                No jobs configured.
              </div>
            )}
            {jobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-3"
              >
                <div>
                  <div className="text-sm font-semibold text-slate-800">{job.name}</div>
                  <div className="text-xs text-slate-500">
                    {job.schedule_summary || "unscheduled"}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void onRunJob(job.id)}>
                    Run
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void onToggleJob(job.id, Boolean(job.enabled))}
                  >
                    {job.enabled ? "Disable" : "Enable"}
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Recent Job Runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {jobRuns.length === 0 && (
              <div className="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-500">
                No runs yet.
              </div>
            )}
            {jobRuns.slice(0, 10).map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2"
              >
                <div className="text-sm text-slate-700">
                  Run #{run.id} on job #{run.job_id}
                </div>
                <Badge
                  tone={
                    run.status === "completed"
                      ? "success"
                      : run.status === "failed"
                      ? "danger"
                      : run.status === "waiting_approval"
                      ? "warning"
                      : "default"
                  }
                >
                  {run.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Inbox Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm text-slate-600">
            <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
              <span>Pending approvals</span>
              <Badge tone={pendingApprovals.length > 0 ? "warning" : "success"}>
                {pendingApprovals.length}
              </Badge>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
              <span>Total jobs</span>
              <Badge>{jobs.length}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
