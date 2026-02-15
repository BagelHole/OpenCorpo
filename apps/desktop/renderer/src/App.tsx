import { useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useOpenCorpo } from "@/context/OpenCorpoContext";
import { OnboardingWizard } from "@/views/OnboardingWizard";
import { ChatView } from "@/views/ChatView";
import { InboxView } from "@/views/InboxView";
import { SettingsView } from "@/views/SettingsView";
import { AuditView } from "@/views/AuditView";
import { cn } from "@/lib/utils";

type NavItem = {
  path: string;
  label: string;
  show?: boolean;
};

export function App() {
  const state = useOpenCorpo();
  const [advancedMode, setAdvancedMode] = useState(() => {
    try {
      return localStorage.getItem("opencorpo_advanced_mode") === "true";
    } catch {
      return false;
    }
  });

  const navItems: NavItem[] = [
    { path: "/", label: "Chat", show: true },
    { path: "/inbox", label: "Inbox", show: true },
    { path: "/settings", label: "Settings", show: true },
    { path: "/audit", label: "Audit", show: advancedMode },
  ];

  const setAdvancedAndPersist = (next: boolean) => {
    setAdvancedMode(next);
    localStorage.setItem("opencorpo_advanced_mode", String(next));
  };

  if (!state.onboarding.completed) {
    return (
      <div className="min-h-screen bg-[var(--oc-bg)] flex items-center justify-center p-4">
        <OnboardingWizard
          onboarding={state.onboarding}
          gmailConnected={state.gmailStatus.connected}
          persistOnboarding={state.persistOnboarding}
          completeOnboarding={state.completeOnboarding}
          saveGmailToken={state.saveGmailToken}
          saveAiKey={state.saveAiKey}
          saveProfile={state.saveProfile}
          saveAiProvider={state.saveAiProvider}
          checkAiKeyConfigured={state.checkAiKeyConfigured}
          getGmailOauthStart={state.getGmailOauthStart}
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
        <aside className="hidden w-52 flex-shrink-0 lg:block">
          <nav className="sticky top-24 space-y-1 rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] p-2">
            {navItems
              .filter((item) => item.show !== false)
              .map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) =>
                    cn(
                      "block rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-[var(--oc-accent)] text-[var(--oc-bg)]"
                        : "text-[var(--oc-ink-muted)] hover:bg-[var(--oc-border)] hover:text-[var(--oc-ink)]"
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            {advancedMode && (
              <div className="mt-4 border-t border-[var(--oc-border)] pt-2">
                <button
                  onClick={() => setAdvancedAndPersist(false)}
                  className="w-full rounded-md px-3 py-2 text-left text-xs text-[var(--oc-ink-muted)] hover:bg-[var(--oc-border)]"
                >
                  Hide advanced
                </button>
              </div>
            )}
          </nav>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Routes>
            <Route
              path="/"
              element={
                <div className="min-h-0 flex-1 overflow-hidden">
                  <ChatView />
                </div>
              }
            />
            <Route
              path="/inbox"
              element={
                <InboxView
                  approvals={state.approvals}
                  jobs={state.jobs}
                  jobRuns={state.jobRuns}
                  onApproval={state.updateApproval}
                  onRunJob={state.runJob}
                  onToggleJob={state.toggleJob}
                />
              }
            />
            <Route
              path="/settings"
              element={
                <SettingsView
                  daemonStatus={state.daemonStatus}
                  diagnostics={state.diagnostics}
                  plugins={state.plugins}
                  gmailStatus={state.gmailStatus}
                  onboarding={state.onboarding}
                  profile={state.profile}
                  aiModelDefaults={state.aiModelDefaults}
                  persistOnboarding={state.persistOnboarding}
                  onSaveProfile={state.saveProfile}
                  onSaveAiModelDefaults={state.saveAiModelDefaults}
                  saveAiProvider={state.saveAiProvider}
                  onRestartDaemon={state.restartDaemon}
                  onRunDiagnostics={state.runDiagnosticsNow}
                  onRunRepair={state.runRepair}
                  onGetOauthStart={state.getGmailOauthStart}
                  onSaveGmailToken={state.saveGmailToken}
                  onSaveAiKey={state.saveAiKey}
                  checkAiKeyConfigured={state.checkAiKeyConfigured}
                  onToggleAdvanced={setAdvancedAndPersist}
                  advancedMode={advancedMode}
                  apiBase={state.apiBase}
                />
              }
            />
            {advancedMode && (
              <Route path="/audit" element={<AuditView audit={state.audit} />} />
            )}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      {/* Mobile nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-10 flex border-t border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] lg:hidden">
        <div className="mx-auto flex w-full max-w-lg justify-around py-2">
          {navItems
            .filter((item) => item.show !== false)
            .map((item) => (
              <NavLink
                key={item.path}
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
