import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type UiSidebarItem = {
  id: string;
  label: string;
  path: string;
  pageId: string;
  showWhen?: "always" | "advanced";
};

export type UiThemeTokens = Partial<{
  bg: string;
  bgElevated: string;
  ink: string;
  inkMuted: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentHover: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
  radius: string;
  radiusSm: string;
  shadow: string;
  shadowLg: string;
  fontSans: string;
  fontMono: string;
}>;

export type UiThemeConfig = {
  light?: UiThemeTokens;
  dark?: UiThemeTokens;
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
    }
  | {
      type: "actions";
      title?: string;
      description?: string;
      buttons: Array<{
        label: string;
        style?: "primary" | "secondary" | "outline";
        action:
          | {
              type: "run_job";
              jobName: string;
              confirm?: string;
            }
          | {
              type: "open_url";
              url: string;
            };
      }>;
    }
  | {
      type: "react_widget";
      title?: string;
      description?: string;
      package: string;
      exportName?: string;
      props?: Record<string, unknown>;
      height?: number;
    }
  | {
      type: "terminal_widget";
      title?: string;
      description?: string;
      command: string;
      cwd?: string;
      height?: number;
      allowInput?: boolean;
    }
  | {
      type: "web_embed";
      title?: string;
      description?: string;
      url: string;
      height?: number;
    }
  | {
      type: "html_embed";
      title?: string;
      description?: string;
      html: string;
      height?: number;
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
  theme?: UiThemeConfig;
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

const THEME_TOKEN_KEYS: Array<keyof UiThemeTokens> = [
  "bg",
  "bgElevated",
  "ink",
  "inkMuted",
  "border",
  "borderStrong",
  "accent",
  "accentHover",
  "success",
  "successBg",
  "warning",
  "warningBg",
  "danger",
  "dangerBg",
  "radius",
  "radiusSm",
  "shadow",
  "shadowLg",
  "fontSans",
  "fontMono"
];

function sanitizeThemeTokens(value: unknown): UiThemeTokens | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const out: UiThemeTokens = {};
  for (const key of THEME_TOKEN_KEYS) {
    const raw = row[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    out[key] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeThemeConfig(value: unknown): UiThemeConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const light = sanitizeThemeTokens(row.light);
  const dark = sanitizeThemeTokens(row.dark);
  if (!light && !dark) return undefined;
  return { light, dark };
}

function sanitizeUiConfig(config: UiConfig): UiConfig {
  const pages = Array.isArray(config.pages) ? config.pages : [];
  const sidebarItems = Array.isArray(config.sidebar?.items) ? config.sidebar.items : [];
  const pageIds = new Set<string>();
  const cleanPages: UiPage[] = [];
  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    const id = typeof page.id === "string" ? page.id.trim() : "";
    if (!id || pageIds.has(id)) continue;
    pageIds.add(id);
    cleanPages.push(page);
  }

  const seenSidebarId = new Set<string>();
  const seenSidebarPath = new Set<string>();
  const cleanSidebar: UiSidebarItem[] = [];
  for (const item of sidebarItems) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const path = typeof item.path === "string" ? item.path.trim() : "";
    const pageId = typeof item.pageId === "string" ? item.pageId.trim() : "";
    if (!id || !path || !pageId) continue;
    if (!pageIds.has(pageId)) continue;
    if (seenSidebarId.has(id) || seenSidebarPath.has(path)) continue;
    seenSidebarId.add(id);
    seenSidebarPath.add(path);
    cleanSidebar.push(item);
  }

  if (cleanPages.length === 0 || cleanSidebar.length === 0) {
    return FALLBACK_UI_CONFIG;
  }

  return {
    name: typeof config.name === "string" && config.name.trim() ? config.name : "desktop-default",
    theme: sanitizeThemeConfig(config.theme),
    sidebar: {
      collapsible: Boolean(config.sidebar?.collapsible),
      defaultCollapsed: Boolean(config.sidebar?.defaultCollapsed),
      items: cleanSidebar
    },
    pages: cleanPages
  };
}

export function loadUiConfig(configRoot: string): UiConfig {
  const uiDir = resolve(configRoot, "ui");
  try {
    const files = readdirSync(uiDir)
      .filter((entry) => entry.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
    if (files.length === 0) return FALLBACK_UI_CONFIG;
    const preferred = files.includes("desktop.json") ? "desktop.json" : files[0];
    const raw = readFileSync(join(uiDir, preferred), "utf-8");
    return sanitizeUiConfig(JSON.parse(raw) as UiConfig);
  } catch {
    return FALLBACK_UI_CONFIG;
  }
}
