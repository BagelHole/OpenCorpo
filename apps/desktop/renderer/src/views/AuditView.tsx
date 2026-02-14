import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type AuditEntry = {
  id: number;
  ts: string;
  actor: string;
  action: string;
  tool: string | null;
  policy: string | null;
  entry_hash?: string | null;
};

export function AuditView({ audit }: { audit: AuditEntry[] }) {
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const grouped = useMemo(() => audit.slice(0, 40), [audit]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader>
          <CardTitle>Audit Timeline</CardTitle>
          <p className="text-sm text-[var(--oc-ink-muted)]">
            Every meaningful action is tracked with actor, action, policy, and integrity hash.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {grouped.length === 0 && (
            <div className="rounded-lg bg-[var(--oc-bg)] px-3 py-3 text-sm text-[var(--oc-ink-muted)]">
              No audit entries yet.
            </div>
          )}
          {grouped.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSelected(entry)}
              className="flex w-full flex-col gap-1 rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] px-3 py-3 text-left transition hover:border-[var(--oc-border-strong)] sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="text-sm font-medium text-[var(--oc-ink)]">{entry.action}</div>
                <div className="text-xs text-[var(--oc-ink-muted)]">
                  Actor: {entry.actor}
                  {entry.tool ? ` • Tool: ${entry.tool}` : ""}
                </div>
              </div>
              <Badge>{entry.id}</Badge>
            </button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entry Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!selected && (
            <div className="rounded-lg bg-[var(--oc-bg)] px-3 py-3 text-[var(--oc-ink-muted)]">
              Select an entry to inspect detail.
            </div>
          )}
          {selected && (
            <>
              <Row label="Action" value={selected.action} />
              <Row label="Actor" value={selected.actor} />
              <Row label="Tool" value={selected.tool ?? "None"} />
              <Row label="Policy" value={selected.policy ?? "None"} />
              <Row label="Timestamp" value={selected.ts} />
              <Row
                label="Integrity hash"
                value={selected.entry_hash ?? "Not available"}
                mono
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] px-3 py-2">
      <div className="text-xs font-medium uppercase tracking-wider text-[var(--oc-ink-muted)]">
        {label}
      </div>
      <div
        className={`mt-1 ${mono ? "break-all font-mono text-xs" : ""} text-[var(--oc-ink)]`}
      >
        {value}
      </div>
    </div>
  );
}
