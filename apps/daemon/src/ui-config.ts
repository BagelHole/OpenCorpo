import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type UiSidebarItem = {
  id: string;
  label: string;
  path: string;
  pageId: string;
  showWhen?: "always" | "advanced";
};

export type UiBuiltinPage = {
  id: string;
  kind: "builtin";
  builtin: "chat" | "jobs" | "settings" | "audit";
  title?: string;
  description?: string;
};

export type UiBaseBlock =
  | {
      type: "markdown";
      markdown: string;
    }
  | {
      type: "stats";
      items: Array<{ label: string; value: string; tone?: "default" | "success" | "warning" | "danger" }>;
    }
  | {
      type: "list";
      title?: string;
      items: string[];
    }
  | {
      type: "note";
      tone?: "default" | "success" | "warning" | "danger";
      text: string;
    }
  | {
      type: "key_value";
      title?: string;
      rows: Array<{ label: string; value: string }>;
    }
  | {
      type: "job_results";
      jobName: string;
      title?: string;
      maxItems?: number;
      emptyText?: string;
      source?: "auto" | "output" | "outputs";
    }
  | {
      type: "job_table";
      jobName: string;
      title?: string;
      maxRows?: number;
      columns?: string[];
      emptyText?: string;
      source?: "auto" | "output" | "outputs";
    };

export type UiBasePage = {
  id: string;
  kind: "base";
  title: string;
  description?: string;
  blocks: UiBaseBlock[];
};

export type UiPage = UiBuiltinPage | UiBasePage;

export type UiConfig = {
  name: string;
  sidebar: {
    collapsible: boolean;
    defaultCollapsed?: boolean;
    items: UiSidebarItem[];
  };
  pages: UiPage[];
};

const FALLBACK_UI_CONFIG: UiConfig = {
  name: "fallback",
  sidebar: {
    collapsible: true,
    defaultCollapsed: false,
    items: [
      { id: "chat", label: "Chat", path: "/", pageId: "chat" },
      { id: "jobs", label: "Jobs", path: "/jobs", pageId: "jobs" },
      { id: "settings", label: "Settings", path: "/settings", pageId: "settings" },
      {
        id: "audit",
        label: "Audit",
        path: "/audit",
        pageId: "audit",
        showWhen: "advanced"
      }
    ]
  },
  pages: [
    { id: "chat", kind: "builtin", builtin: "chat" },
    { id: "jobs", kind: "builtin", builtin: "jobs" },
    { id: "settings", kind: "builtin", builtin: "settings" },
    { id: "audit", kind: "builtin", builtin: "audit" }
  ]
};

export function loadUiConfig(configRoot: string): UiConfig {
  const uiDir = resolve(configRoot, "ui");
  try {
    const files = readdirSync(uiDir)
      .filter((entry) => entry.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
    if (files.length === 0) return FALLBACK_UI_CONFIG;
    const preferred = files.includes("desktop.json") ? "desktop.json" : files[0];
    const raw = readFileSync(join(uiDir, preferred), "utf-8");
    return JSON.parse(raw) as UiConfig;
  } catch {
    return FALLBACK_UI_CONFIG;
  }
}
