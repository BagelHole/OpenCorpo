import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOpenCorpo } from "@/context/OpenCorpoContext";
import type { UiBaseBlock, UiBasePage } from "@/lib/api";

function toneToBadgeTone(tone: "default" | "success" | "warning" | "danger" | undefined) {
  if (tone === "success" || tone === "warning" || tone === "danger") return tone;
  return "default";
}

function toneToNoteClass(tone: "default" | "success" | "warning" | "danger" | undefined) {
  if (tone === "success") return "border-[var(--oc-success)]/40 bg-[var(--oc-success-bg)] text-[var(--oc-success)]";
  if (tone === "warning") return "border-[var(--oc-warning)]/40 bg-[var(--oc-warning-bg)] text-[var(--oc-warning)]";
  if (tone === "danger") return "border-[var(--oc-danger)]/40 bg-[var(--oc-danger-bg)] text-[var(--oc-danger)]";
  return "border-[var(--oc-border)] bg-[var(--oc-bg)] text-[var(--oc-ink-muted)]";
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveJobSource(
  output: Record<string, unknown> | null | undefined,
  source: "auto" | "output" | "outputs" | undefined
) {
  if (source === "output") return output;
  if (source === "outputs") return Array.isArray(output?.outputs) ? output.outputs : [];
  return Array.isArray(output?.outputs) ? output.outputs : output;
}

function compactObjectLine(row: Record<string, unknown>): string | null {
  const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : "";
  const label = typeof row.label === "string" && row.label.trim() ? row.label.trim() : "";
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "";
  const url = typeof row.url === "string" && row.url.trim() ? row.url.trim() : "";
  const value = typeof row.value === "string" && row.value.trim() ? row.value.trim() : "";

  const head = title || label || name;
  if (head && url) return `${head} - ${url}`;
  if (head && value) return `${head}: ${value}`;
  if (head) return head;
  if (url) return url;
  if (value) return value;

  const entries = Object.entries(row).slice(0, 4);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${stringifyValue(v)}`).join(" | ");
}

function collectLines(value: unknown, out: string[], maxItems: number) {
  if (out.length >= maxItems || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLines(item, out, maxItems);
      if (out.length >= maxItems) break;
    }
    return;
  }

  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.results)) {
      collectLines(row.results, out, maxItems);
      return;
    }
    if (Array.isArray(row.outputs)) {
      collectLines(row.outputs, out, maxItems);
      return;
    }
    if ("result" in row) {
      collectLines(row.result, out, maxItems);
      return;
    }
    const line = compactObjectLine(row);
    if (line) out.push(line);
    return;
  }

  const line = stringifyValue(value).trim();
  if (line) out.push(line);
}

function collectRecords(
  value: unknown,
  out: Array<Record<string, string>>,
  maxRows: number
) {
  if (out.length >= maxRows || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectRecords(item, out, maxRows);
      if (out.length >= maxRows) break;
    }
    return;
  }

  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.results)) {
      collectRecords(row.results, out, maxRows);
      return;
    }
    if (Array.isArray(row.outputs)) {
      collectRecords(row.outputs, out, maxRows);
      return;
    }
    if ("result" in row) {
      collectRecords(row.result, out, maxRows);
      return;
    }
    const flat: Record<string, string> = {};
    for (const [key, cell] of Object.entries(row)) {
      const text = stringifyValue(cell).trim();
      if (text) flat[key] = text;
    }
    if (Object.keys(flat).length > 0) out.push(flat);
    return;
  }

  const text = stringifyValue(value).trim();
  if (text) out.push({ value: text });
}

function BaseBlock({ block }: { block: UiBaseBlock }) {
  const state = useOpenCorpo();

  if (block.type === "markdown") {
    return (
      <Card>
        <CardContent className="pt-4">
          <div className="oc-markdown text-sm text-[var(--oc-ink)]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.markdown}</ReactMarkdown>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (block.type === "stats") {
    return (
      <Card>
        <CardContent className="grid gap-2 pt-4 sm:grid-cols-2 lg:grid-cols-3">
          {block.items.map((item) => (
            <div
              key={`${item.label}:${item.value}`}
              className="rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2"
            >
              <div className="text-xs text-[var(--oc-ink-muted)]">{item.label}</div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-[var(--oc-ink)]">{item.value}</div>
                <Badge tone={toneToBadgeTone(item.tone)}>{item.tone ?? "default"}</Badge>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (block.type === "list") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{block.title || "List"}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-[var(--oc-ink-muted)]">
            {block.items.map((item) => (
              <li key={item} className="rounded-lg bg-[var(--oc-bg)] px-3 py-2">
                {item}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    );
  }

  if (block.type === "note") {
    return (
      <div className={`rounded-lg border px-4 py-3 text-sm ${toneToNoteClass(block.tone)}`}>
        {block.text}
      </div>
    );
  }

  if (block.type === "job_results") {
    const maxItems = Math.max(1, Math.min(25, block.maxItems ?? 5));
    const job = state.jobs.find((row) => row.name === block.jobName);
    const latestCompleted = job
      ? state.jobRuns.find((run) => run.job_id === job.id && run.status === "completed")
      : undefined;
    const output = latestCompleted?.output ?? null;
    const source = resolveJobSource(output, block.source);
    const lines: string[] = [];
    collectLines(source, lines, maxItems);

    return (
      <Card>
        <CardHeader>
          <CardTitle>{block.title || "Latest Results"}</CardTitle>
        </CardHeader>
        <CardContent>
          {lines.length > 0 ? (
            <ul className="space-y-2 text-sm text-[var(--oc-ink-muted)]">
              {lines.map((line) => (
                <li key={line} className="rounded-lg bg-[var(--oc-bg)] px-3 py-2">
                  {line}
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-lg bg-[var(--oc-bg)] px-3 py-2 text-sm text-[var(--oc-ink-muted)]">
              {block.emptyText || "No results yet. Run the job to populate this section."}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  if (block.type === "job_table") {
    const maxRows = Math.max(1, Math.min(50, block.maxRows ?? 10));
    const job = state.jobs.find((row) => row.name === block.jobName);
    const latestCompleted = job
      ? state.jobRuns.find((run) => run.job_id === job.id && run.status === "completed")
      : undefined;
    const output = latestCompleted?.output ?? null;
    const source = resolveJobSource(output, block.source);
    const records: Array<Record<string, string>> = [];
    collectRecords(source, records, maxRows);

    const columns =
      Array.isArray(block.columns) && block.columns.length > 0
        ? block.columns
        : Array.from(new Set(records.flatMap((row) => Object.keys(row)))).slice(0, 8);

    return (
      <Card>
        <CardHeader>
          <CardTitle>{block.title || "Latest Table"}</CardTitle>
        </CardHeader>
        <CardContent>
          {records.length > 0 && columns.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--oc-border)]">
                    {columns.map((column) => (
                      <th
                        key={column}
                        className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--oc-ink-muted)]"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.map((row, index) => (
                    <tr key={`${index}:${columns.map((column) => row[column] ?? "").join("|")}`} className="border-b border-[var(--oc-border)]/60">
                      {columns.map((column) => (
                        <td key={column} className="px-2 py-2 align-top text-[var(--oc-ink)]">
                          {row[column] || "-"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg bg-[var(--oc-bg)] px-3 py-2 text-sm text-[var(--oc-ink-muted)]">
              {block.emptyText || "No table rows yet. Run the job to populate this section."}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{block.title || "Details"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {block.rows.map((row) => (
          <div
            key={`${row.label}:${row.value}`}
            className="flex items-center justify-between rounded-lg bg-[var(--oc-bg)] px-3 py-2"
          >
            <span className="text-[var(--oc-ink-muted)]">{row.label}</span>
            <span className="font-medium text-[var(--oc-ink)]">{row.value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function BaseUiPageView({ page }: { page: UiBasePage }) {
  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-[var(--oc-ink)]">{page.title}</h1>
        {page.description && (
          <p className="mt-1 text-sm text-[var(--oc-ink-muted)]">{page.description}</p>
        )}
      </div>
      {page.blocks.map((block, index) => (
        <BaseBlock key={`${block.type}:${index}`} block={block} />
      ))}
    </div>
  );
}
