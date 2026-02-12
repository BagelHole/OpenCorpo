import { useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useOpenCorpoState } from "@/hooks/useOpenCorpoState";
import { OnboardingWizard } from "@/views/OnboardingWizard";
import { ChatView } from "@/views/ChatView";
import { InboxView } from "@/views/InboxView";
import { SettingsView } from "@/views/SettingsView";
import { AuditView } from "@/views/AuditView";

type NavItem = {
  path: string;
  label: string;
  always?: boolean;
};

export function App() {
  const state = useOpenCorpoState();
  const [advancedMode, setAdvancedMode] = useState(() => {
    const value = localStorage.getItem("opencorpo_advanced_mode");
    return value === "true";
  });

  const navItems = useMemo<NavItem[]>(
    () => [
      { path: "/", label: "Home Chat", always: true },
      { path: "/inbox", label: "Inbox", always: true },
      { path: "/settings", label: "Settings", always: true },
      { path: "/audit", label: "Audit", always: advancedMode }
    ],
    [advancedMode]
  );

  const setAdvancedAndPersist = (next: boolean) => {
    setAdvancedMode(next);
    localStorage.setItem("opencorpo_advanced_mode", String(next));
  };

  if (!state.onboarding.completed) {
    return (
      <OnboardingWizard
        onboarding={state.onboarding}
        gmailConnected={state.gmailStatus.connected}
        persistOnboarding={state.persistOnboarding}
        completeOnboarding={state.completeOnboarding}
        saveGmailToken={state.saveGmailToken}
        getGmailOauthStart={state.getGmailOauthStart}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-6 py-6">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              OpenCorpo
            </div>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">
              Simple, safe self-editing operations
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Desktop-first AI operations for non-technical teams.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={state.daemonStatus.ready ? "success" : "warning"}>
              {state.daemonStatus.ready ? "Daemon healthy" : "Daemon needs attention"}
            </Badge>
            <Badge>{state.pendingApprovals.length} pending approvals</Badge>
            <Button variant="secondary" onClick={() => void state.refreshData()}>
              Refresh
            </Button>
          </div>
        </header>

        {state.apiError && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
            {state.apiError}
          </div>
        )}

        <div className="grid flex-1 gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            {navItems
              .filter((item) => item.always)
              .map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) =>
                    `block rounded-xl px-3 py-2 text-sm font-medium transition ${
                      isActive
                        ? "bg-slate-900 text-white"
                        : "text-slate-700 hover:bg-slate-100"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
          </aside>

          <main className="min-w-0">
            <Routes>
              <Route
                path="/"
                element={
                  <ChatView
                    messages={state.messages}
                    pendingApprovals={state.pendingApprovals.length}
                    sendMessage={state.sendMessage}
                    isSending={state.isSending}
                  />
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
                    onRestartDaemon={state.restartDaemon}
                    onRunDiagnostics={state.runDiagnosticsNow}
                    onRunRepair={state.runRepair}
                    onGetOauthStart={state.getGmailOauthStart}
                    onSaveGmailToken={state.saveGmailToken}
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
      </div>
    </div>
  );
}
