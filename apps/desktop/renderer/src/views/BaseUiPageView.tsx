import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function BaseBlock({ block }: { block: UiBaseBlock }) {
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
