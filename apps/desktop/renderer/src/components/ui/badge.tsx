import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Badge({
  children,
  tone = "default",
  className,
}: {
  children: ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
  className?: string;
}) {
  const toneClass =
    tone === "success"
      ? "bg-[var(--oc-success-bg)] text-[var(--oc-success)]"
      : tone === "warning"
        ? "bg-[var(--oc-warning-bg)] text-[var(--oc-warning)]"
        : tone === "danger"
          ? "bg-[var(--oc-danger-bg)] text-[var(--oc-danger)]"
          : "bg-[var(--oc-border)] text-[var(--oc-ink-muted)]";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        toneClass,
        className
      )}
    >
      {children}
    </span>
  );
}
