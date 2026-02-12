import type { DbHandle } from "./db";
import { verifyAuditIntegrity } from "./audit";
import { getSecretRef } from "./secrets";

export type DiagnosticsContext = {
  controlPlaneValidation: Array<{ path: string; valid: boolean; errors: string[] }>;
  plugins: Array<{ name: string; loaded: boolean; error?: string | null }>;
  migrations: { currentVersion: string | null; applied: string[] };
};

export function runDiagnostics(db: DbHandle, context: DiagnosticsContext) {
  const invalidControlPlane = context.controlPlaneValidation.filter((item) => !item.valid);
  const pluginErrors = context.plugins.filter((plugin) => !plugin.loaded);
  const pendingApprovals = (
    db.query(`SELECT COUNT(*) as count FROM approvals WHERE status = 'pending'`).get() as {
      count: number;
    } | null
  )?.count ?? 0;
  const waitingJobRuns = (
    db
      .query(
        `SELECT COUNT(*) as count FROM job_runs WHERE status = 'waiting_approval'`
      )
      .get() as { count: number } | null
  )?.count ?? 0;
  const auditIntegrity = verifyAuditIntegrity(db);
  const gmailRef = getSecretRef(db, "gmail.access_token");

  const checks = [
    {
      id: "control_plane_valid",
      label: "Control Plane validation",
      ok: invalidControlPlane.length === 0,
      detail:
        invalidControlPlane.length === 0
          ? "All config files passed schema validation."
          : `${invalidControlPlane.length} files failed validation.`
    },
    {
      id: "audit_integrity",
      label: "Audit integrity chain",
      ok: auditIntegrity.ok,
      detail: auditIntegrity.ok
        ? `Verified ${auditIntegrity.count} audit entries.`
        : `Hash mismatch at audit entry #${auditIntegrity.badEntryId}.`
    },
    {
      id: "plugin_health",
      label: "Plugin health",
      ok: pluginErrors.length === 0,
      detail:
        pluginErrors.length === 0
          ? "All plugins loaded."
          : `${pluginErrors.length} plugins failed to load.`
    },
    {
      id: "approvals_queue",
      label: "Approval backlog",
      ok: pendingApprovals < 20,
      detail: `${pendingApprovals} approvals pending.`
    },
    {
      id: "job_waiting_approval",
      label: "Jobs waiting for approval",
      ok: waitingJobRuns === 0,
      detail: `${waitingJobRuns} job runs are waiting for approval.`
    },
    {
      id: "gmail_connector_secret",
      label: "Gmail connector auth",
      ok: Boolean(gmailRef),
      detail: gmailRef
        ? "Gmail access token reference is configured."
        : "Gmail access token is not configured."
    },
    {
      id: "schema_migrations",
      label: "Database schema migration",
      ok: Boolean(context.migrations.currentVersion),
      detail: context.migrations.currentVersion
        ? `Current version: ${context.migrations.currentVersion}`
        : "No schema migration version found."
    }
  ];

  const status = checks.every((check) => check.ok) ? "ok" : "warn";
  const report = {
    status,
    generatedAt: new Date().toISOString(),
    checks,
    recommendations: [
      ...(!checks.find((item) => item.id === "control_plane_valid")?.ok
        ? ["Fix schema errors in Control Plane before applying AI edits."]
        : []),
      ...(!checks.find((item) => item.id === "gmail_connector_secret")?.ok
        ? ["Connect Gmail in settings to enable email automation."]
        : []),
      ...(pluginErrors.length > 0
        ? ["Review plugin errors and restart daemon after fixes."]
        : [])
    ]
  };

  db.prepare(
    `INSERT INTO diagnostics_runs (ts, status, report_json)
     VALUES (?, ?, ?)`
  ).run(report.generatedAt, report.status, JSON.stringify(report));

  return report;
}

export function listDiagnosticsRuns(db: DbHandle, limit = 20) {
  return db
    .query(
      `SELECT id, ts, status, report_json
       FROM diagnostics_runs
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit)
    .map((row) => ({
      ...row,
      report: row.report_json ? JSON.parse(String(row.report_json)) : null
    }));
}
