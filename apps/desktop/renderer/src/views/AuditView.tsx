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
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="border border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>Audit Timeline</CardTitle>
          <p className="text-sm text-slate-500">
            Every meaningful action is tracked with actor, action, policy, and integrity hash.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {grouped.length === 0 && (
            <div className="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-500">
              No audit entries yet.
            </div>
          )}
          {grouped.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSelected(entry)}
              className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-slate-400"
            >
              <div className="space-y-1">
                <div className="text-sm font-semibold text-slate-800">{entry.action}</div>
                <div className="text-xs text-slate-500">
                  Actor: {entry.actor}
                  {entry.tool ? ` • Tool: ${entry.tool}` : ""}
                </div>
              </div>
              <Badge>{entry.id}</Badge>
            </button>
          ))}
        </CardContent>
      </Card>

      <Card className="border border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>Entry Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-600">
          {!selected && (
            <div className="rounded-xl bg-slate-50 px-3 py-3">
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
  mono
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
        {label}
      </div>
      <div className={`mt-1 ${mono ? "break-all font-mono text-xs" : "text-sm"} text-slate-700`}>
        {value}
      </div>
    </div>
  );
}
