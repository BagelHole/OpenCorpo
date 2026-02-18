import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useOpenCorpo } from "@/context/OpenCorpoContext";
import { OnboardingWizard } from "@/views/OnboardingWizard";
import { ChatView } from "@/views/ChatView";
import { InboxView } from "@/views/InboxView";
import { SettingsView } from "@/views/SettingsView";
import { AuditView } from "@/views/AuditView";
import { BaseUiPageView } from "@/views/BaseUiPageView";
import { cn } from "@/lib/utils";
import type { UiPage, UiSidebarItem } from "@/lib/api";

const THEME_TOKEN_TO_CSS_SUFFIX: Record<string, string> = {
  bg: "bg",
  bgElevated: "bg-elevated",
  ink: "ink",
  inkMuted: "ink-muted",
  border: "border",
  borderStrong: "border-strong",
  accent: "accent",
  accentHover: "accent-hover",
  success: "success",
  successBg: "success-bg",
  warning: "warning",
  warningBg: "warning-bg",
  danger: "danger",
  dangerBg: "danger-bg",
  radius: "radius",
  radiusSm: "radius-sm",
  shadow: "shadow",
  shadowLg: "shadow-lg",
  fontSans: "font-sans",
  fontMono: "font-mono"
};

function shouldShowNavItem(item: UiSidebarItem, advancedMode: boolean) {
  if (item.showWhen === "advanced") return advancedMode;
  return true;
}

export function App() {
  const state = useOpenCorpo();
  const location = useLocation();
  const navigate = useNavigate();
  const LAST_PAGE_PATH_KEY = "opencorpo_last_page_path_v1";
  const [advancedMode, setAdvancedMode] = useState(() => {
    try {
      return localStorage.getItem("opencorpo_advanced_mode") === "true";
    } catch {
      return false;
    }
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem("opencorpo_sidebar_collapsed");
      if (stored !== null) return stored === "true";
      return Boolean(state.uiConfig?.sidebar?.defaultCollapsed);
    } catch {
      return Boolean(state.uiConfig?.sidebar?.defaultCollapsed);
    }
  });

  const navItems = useMemo(
    () => state.uiConfig.sidebar.items.filter((item) => shouldShowNavItem(item, advancedMode)),
    [advancedMode, state.uiConfig.sidebar.items]
  );
  const pageById = useMemo(() => {
    const map = new Map<string, UiPage>();
    for (const page of state.uiConfig.pages) map.set(page.id, page);
    return map;
  }, [state.uiConfig.pages]);
  const defaultPath = useMemo(() => {
    const firstPath = navItems[0]?.path ?? "/";
    try {
      const stored = localStorage.getItem(LAST_PAGE_PATH_KEY);
      if (stored && navItems.some((item) => item.path === stored)) return stored;
    } catch {
      // ignore storage read errors
    }
    return firstPath;
  }, [navItems]);

  useEffect(() => {
    const root = document.documentElement;
    const theme = state.uiConfig.theme;
    for (const suffix of Object.values(THEME_TOKEN_TO_CSS_SUFFIX)) {
      root.style.removeProperty(`--oc-light-${suffix}`);
      root.style.removeProperty(`--oc-dark-${suffix}`);
    }

    if (theme?.light) {
      for (const [token, value] of Object.entries(theme.light)) {
        const suffix = THEME_TOKEN_TO_CSS_SUFFIX[token];
        if (!suffix || typeof value !== "string" || !value.trim()) continue;
        root.style.setProperty(`--oc-light-${suffix}`, value);
      }
    }
    if (theme?.dark) {
      for (const [token, value] of Object.entries(theme.dark)) {
        const suffix = THEME_TOKEN_TO_CSS_SUFFIX[token];
        if (!suffix || typeof value !== "string" || !value.trim()) continue;
        root.style.setProperty(`--oc-dark-${suffix}`, value);
      }
    }
  }, [state.uiConfig.theme]);

  useEffect(() => {
    if (!navItems.some((item) => item.path === location.pathname)) return;
    try {
      localStorage.setItem(LAST_PAGE_PATH_KEY, location.pathname);
    } catch {
      // ignore storage write errors
    }
  }, [location.pathname, navItems]);

  const setAdvancedAndPersist = (next: boolean) => {
    setAdvancedMode(next);
    localStorage.setItem("opencorpo_advanced_mode", String(next));
  };

  const toggleSidebarCollapsed = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem("opencorpo_sidebar_collapsed", String(next));
  };

  const deleteSidebarItem = async (item: UiSidebarItem) => {
    if (!state.api) return;
    const page = pageById.get(item.pageId);
    if (!page || page.kind !== "base") return;
    const ok = window.confirm(`Delete "${item.label}" from the sidebar and remove its page?`);
    if (!ok) return;

    const nextSidebarItems = state.uiConfig.sidebar.items.filter((row) => row.id !== item.id);
    if (nextSidebarItems.length === 0) {
      window.alert("Cannot delete the last sidebar item.");
      return;
    }
    const pageStillReferenced = nextSidebarItems.some((row) => row.pageId === item.pageId);
    const nextPages = pageStillReferenced
      ? state.uiConfig.pages
      : state.uiConfig.pages.filter((row) => row.id !== item.pageId);
    const afterJson = {
      ...state.uiConfig,
      sidebar: {
        ...state.uiConfig.sidebar,
        items: nextSidebarItems,
      },
      pages: nextPages,
    };

    const proposeRes = await state.api.post<{
      ok: boolean;
      error?: string;
      details?: string[];
      item?: { id: number };
    }>("/control-plane/changes/propose", {
      actor: "user",
      relativePath: "ui/desktop.json",
      summary: `Delete sidebar item ${item.label}`,
      afterJson,
    });
    if (!proposeRes.ok || !proposeRes.data.ok || !proposeRes.data.item?.id) {
      const error = proposeRes.ok
        ? proposeRes.data.error ?? "Failed to propose UI delete change."
        : proposeRes.error;
      const details = proposeRes.ok ? proposeRes.data.details?.join("\n") : "";
      window.alert(details ? `${error}\n\n${details}` : error);
      return;
    }

    const applyRes = await state.api.post<{ ok: boolean; error?: string }>(
      `/control-plane/changes/${proposeRes.data.item.id}/apply`
    );
    if (!applyRes.ok || !applyRes.data.ok) {
      const error = applyRes.ok ? applyRes.data.error ?? "Failed to apply UI delete change." : applyRes.error;
      window.alert(error);
      return;
    }

    await state.refreshData();
    if (location.pathname === item.path) {
      const nextPath =
        nextSidebarItems.find((row) => shouldShowNavItem(row, advancedMode))?.path ??
        nextSidebarItems[0]?.path ??
        "/";
      navigate(nextPath, { replace: true });
    }
  };

  const renderPage = (pageId: string) => {
    const page = pageById.get(pageId);
    if (!page) {
      return (
        <div className="rounded-lg border border-[var(--oc-warning)]/50 bg-[var(--oc-warning-bg)] px-4 py-3 text-sm text-[var(--oc-warning)]">
          Missing page config for <code>{pageId}</code>.
        </div>
      );
    }

    const inScrollableShell = (content: ReactNode) => (
      <div className="oc-scrollbar-subtle min-h-0 flex-1 overflow-y-auto pr-1">
        {content}
      </div>
    );

    if (page.kind === "base") {
      return inScrollableShell(<BaseUiPageView page={page} />);
    }

    if (page.builtin === "chat") {
      return (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatView />
        </div>
      );
    }

    if (page.builtin === "jobs") {
      return inScrollableShell(
        <InboxView
          approvals={state.approvals}
          jobs={state.jobs}
          jobRuns={state.jobRuns}
          onApproval={state.updateApproval}
          onRunJob={state.runJob}
          onToggleJob={state.toggleJob}
        />
      );
    }

    if (page.builtin === "settings") {
      return inScrollableShell(
        <SettingsView
          daemonStatus={state.daemonStatus}
          diagnostics={state.diagnostics}
          plugins={state.plugins}
          codexStatus={state.codexStatus}
          onboarding={state.onboarding}
          profile={state.profile}
          aiModelDefaults={state.aiModelDefaults}
          scriptSecrets={state.scriptSecrets}
          scriptExecutionMode={state.scriptExecutionMode}
          mcpSettings={state.mcpSettings}
          persistOnboarding={state.persistOnboarding}
          onSaveProfile={state.saveProfile}
          onSaveAiModelDefaults={state.saveAiModelDefaults}
          onSaveScriptSecret={state.saveScriptSecret}
          onSaveScriptExecutionMode={state.saveScriptExecutionMode}
          onSaveMcpSettings={state.saveMcpSettings}
          saveAiProvider={state.saveAiProvider}
          onRestartDaemon={state.restartDaemon}
          onRunDiagnostics={state.runDiagnosticsNow}
          onRunRepair={state.runRepair}
          onGetCodexOauthStart={state.getCodexOauthStart}
          onDisconnectCodex={state.disconnectCodex}
          onSaveAiKey={state.saveAiKey}
          checkAiKeyConfigured={state.checkAiKeyConfigured}
          onToggleAdvanced={setAdvancedAndPersist}
          advancedMode={advancedMode}
          apiBase={state.apiBase}
        />
      );
    }

    return advancedMode
      ? inScrollableShell(<AuditView audit={state.audit} />)
      : <Navigate to={defaultPath} replace />;
  };

  if (!state.onboarding.completed) {
    return (
      <div className="min-h-screen bg-[var(--oc-bg)] flex items-center justify-center p-4">
        <OnboardingWizard
          onboarding={state.onboarding}
          persistOnboarding={state.persistOnboarding}
          completeOnboarding={state.completeOnboarding}
          saveAiKey={state.saveAiKey}
          saveProfile={state.saveProfile}
          saveAiProvider={state.saveAiProvider}
          checkAiKeyConfigured={state.checkAiKeyConfigured}
          getCodexOauthStart={state.getCodexOauthStart}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--oc-bg)]">
      <header className="sticky top-0 z-10 flex-shrink-0 border-b border-[var(--oc-border)] bg-[var(--oc-bg-elevated)]/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-widest text-[var(--oc-ink-muted)]">
              OpenCorpo
            </span>
            <div className="hidden sm:flex items-center gap-2">
              {state.pendingApprovals.length > 0 && (
                <Badge tone="warning">{state.pendingApprovals.length} pending</Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
          </div>
        </div>

        {state.apiError && (
          <div className="mx-auto max-w-7xl px-4 pb-2 sm:px-6">
            <div className="rounded-lg border border-[var(--oc-warning)]/50 bg-[var(--oc-warning-bg)] px-4 py-2 text-sm text-[var(--oc-warning)]">
              {state.apiError}
            </div>
          </div>
        )}
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 gap-4 overflow-hidden px-4 py-4 sm:px-6 lg:gap-6">
        <aside
          className={cn(
            "hidden min-h-0 flex-shrink-0 lg:block",
            sidebarCollapsed ? "w-16" : "w-52"
          )}
        >
          <nav className="oc-scrollbar-subtle sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto space-y-1 rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] p-2">
            {state.uiConfig.sidebar.collapsible && (
              <button
                onClick={toggleSidebarCollapsed}
                className="mb-1 w-full rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg)] px-2 py-1 text-xs text-[var(--oc-ink-muted)] hover:border-[var(--oc-border-strong)] hover:text-[var(--oc-ink)]"
              >
                {sidebarCollapsed ? ">" : "<"}
              </button>
            )}
            {navItems.map((item) => {
              const page = pageById.get(item.pageId);
              const canDelete = !sidebarCollapsed && page?.kind === "base";
              return (
                <div key={item.id} className="group relative">
                  <NavLink
                    to={item.path}
                    className={({ isActive }) =>
                      cn(
                        "block rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        sidebarCollapsed && "px-2 text-center",
                        canDelete && "pr-9",
                        isActive
                          ? "bg-[var(--oc-accent)] text-[var(--oc-bg)]"
                          : "text-[var(--oc-ink-muted)] hover:bg-[var(--oc-border)] hover:text-[var(--oc-ink)]"
                      )
                    }
                    title={item.label}
                  >
                    {sidebarCollapsed ? item.label.slice(0, 1) : item.label}
                  </NavLink>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void deleteSidebarItem(item);
                      }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-[var(--oc-ink-muted)] opacity-0 transition-opacity hover:bg-[var(--oc-danger-bg)] hover:text-[var(--oc-danger)] group-hover:opacity-100"
                      title={`Delete ${item.label}`}
                      aria-label={`Delete ${item.label}`}
                    >
                      X
                    </button>
                  )}
                </div>
              );
            })}
          </nav>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Routes>
            <Route path="/inbox" element={<Navigate to="/jobs" replace />} />
            {state.uiConfig.sidebar.items.map((item) => (
              <Route
                key={`${item.id}:${item.path}`}
                path={item.path}
                element={
                  shouldShowNavItem(item, advancedMode)
                    ? renderPage(item.pageId)
                    : <Navigate to={defaultPath} replace />
                }
              />
            ))}
            <Route path="*" element={<Navigate to={defaultPath} replace />} />
          </Routes>
        </main>
      </div>

      <nav className="fixed bottom-0 left-0 right-0 z-10 flex border-t border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] lg:hidden">
        <div className="mx-auto flex w-full max-w-lg justify-around py-2">
          {navItems.map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              className={({ isActive }) =>
                cn(
                  "flex flex-col items-center gap-0.5 rounded-lg px-4 py-2 text-xs font-medium transition-colors",
                  isActive
                    ? "text-[var(--oc-accent)]"
                    : "text-[var(--oc-ink-muted)]"
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>
      <div className="h-16 lg:hidden" aria-hidden />
    </div>
  );
}
