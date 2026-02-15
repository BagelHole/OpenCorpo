import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type DaemonStatus = {
  running: boolean;
  ready: boolean;
  pid: number | null;
  port: number;
  apiBase: string;
  hasToken: boolean;
  lastError: string | null;
};

type DiagnosticsReport = {
  status: "ok" | "warn";
  generatedAt: string;
  checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  recommendations: string[];
};

type PluginInfo = {
  name: string;
  version: string;
  loaded: boolean;
  error?: string | null;
};

type GmailStatus = {
  connected: boolean;
  tokenSource: string | null;
  refreshConfigured: boolean;
};

type OnboardingData = {
  completed: boolean;
  aiProvider: "anthropic" | "openai" | "local";
  aiKey: string;
  gmailAccessToken: string;
};

export function SettingsView({
  daemonStatus,
  diagnostics,
  plugins,
  gmailStatus,
  onboarding,
  persistOnboarding,
  saveAiProvider,
  onRestartDaemon,
  onRunDiagnostics,
  onRunRepair,
  onGetOauthStart,
  onSaveGmailToken,
  onSaveAiKey,
  checkAiKeyConfigured,
  onToggleAdvanced,
  advancedMode,
  apiBase,
}: {
  daemonStatus: DaemonStatus;
  diagnostics: DiagnosticsReport | null;
  plugins: PluginInfo[];
  gmailStatus: GmailStatus;
  onboarding: OnboardingData;
  persistOnboarding: (next: OnboardingData) => void;
  saveAiProvider: (provider: string) => Promise<void>;
  onRestartDaemon: () => Promise<void>;
  onRunDiagnostics: () => Promise<void>;
  onRunRepair: () => Promise<void>;
  onGetOauthStart: () => Promise<{ ok: boolean; authUrl?: string; error?: string }>;
  onSaveGmailToken: (token: string) => Promise<void>;
  onSaveAiKey: (key: string) => Promise<void>;
  checkAiKeyConfigured: () => Promise<boolean>;
  onToggleAdvanced: (next: boolean) => void;
  advancedMode: boolean;
  apiBase: string;
}) {
  const [tokenInput, setTokenInput] = useState("");
  const [aiKeyInput, setAiKeyInput] = useState("");
  const [aiKeyConfigured, setAiKeyConfigured] = useState<boolean | null>(null);
  const [aiKeyMessage, setAiKeyMessage] = useState<string | null>(null);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const pluginFailures = useMemo(() => plugins.filter((p) => !p.loaded), [plugins]);

  useEffect(() => {
    void checkAiKeyConfigured().then(setAiKeyConfigured);
  }, [checkAiKeyConfigured]);

  const handleProviderChange = async (provider: OnboardingData["aiProvider"]) => {
    persistOnboarding({ ...onboarding, aiProvider: provider });
    try {
      await saveAiProvider(provider);
    } catch (e) {
      setAiKeyMessage(e instanceof Error ? e.message : "Failed to update provider");
    }
  };

  const saveAiKey = async () => {
    if (!aiKeyInput.trim()) {
      setAiKeyMessage("Enter an API key first.");
      return;
    }
    try {
      await onSaveAiKey(aiKeyInput.trim());
      setAiKeyInput("");
      setAiKeyConfigured(true);
      setAiKeyMessage("API key saved.");
    } catch (error) {
      setAiKeyMessage(error instanceof Error ? error.message : "Failed to save API key.");
    }
  };

  const connectOAuth = async () => {
    const start = await onGetOauthStart();
    if (!start.ok || !start.authUrl) {
      setLocalMessage(start.error ?? "Failed to start OAuth.");
      return;
    }
    window.open(start.authUrl, "_blank", "noopener,noreferrer");
    setLocalMessage("Complete sign-in in your browser, then run diagnostics here.");
  };

  const saveToken = async () => {
    if (!tokenInput.trim()) {
      setLocalMessage("Paste an access token first.");
      return;
    }
    await onSaveGmailToken(tokenInput.trim());
    setTokenInput("");
    setLocalMessage("Token saved.");
  };

  return (
    <div className="grid gap-4 sm:gap-5 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>System Health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <HealthRow label="Daemon" ok={daemonStatus.running} value={daemonStatus.running ? "Running" : "Stopped"} />
          <HealthRow label="Ready" ok={daemonStatus.ready} value={daemonStatus.ready ? "Yes" : "No"} />
          <HealthRow
            label="API"
            ok={daemonStatus.ready}
            value={daemonStatus.apiBase || apiBase || "—"}
          />
          <HealthRow label="Token" ok={daemonStatus.hasToken} value={daemonStatus.hasToken ? "Set" : "Missing"} />
          {daemonStatus.lastError && (
            <div className="rounded-lg bg-[var(--oc-danger-bg)] px-3 py-2 text-xs text-[var(--oc-danger)]">
              {daemonStatus.lastError}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void onRestartDaemon()}>
              Restart daemon
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void onRunDiagnostics()}>
              Diagnostics
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void onRunRepair()}>
              Repair
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI Provider</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2">
            <span className="text-[var(--oc-ink-muted)]">Provider</span>
            <span className="text-xs">
              {onboarding.aiProvider === "anthropic" ? "Anthropic" : onboarding.aiProvider === "openai" ? "OpenAI" : "Local / BYOK"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["anthropic", "openai", "local"] as const).map((value) => (
              <button
                key={value}
                onClick={() => void handleProviderChange(value)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  onboarding.aiProvider === value
                    ? "border-[var(--oc-accent)] bg-[var(--oc-accent)] text-[var(--oc-bg)]"
                    : "border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] text-[var(--oc-ink)] hover:border-[var(--oc-border-strong)]"
                }`}
              >
                {value === "anthropic" ? "Anthropic" : value === "openai" ? "OpenAI" : "Local"}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2">
            <span className="text-[var(--oc-ink-muted)]">API key</span>
            <Badge tone={aiKeyConfigured ? "success" : "warning"}>
              {aiKeyConfigured ? "Configured" : "Not configured"}
            </Badge>
          </div>
          <div className="space-y-2">
            <input
              type="password"
              value={aiKeyInput}
              onChange={(e) => setAiKeyInput(e.target.value)}
              className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--oc-border-strong)]"
              placeholder="Paste API key"
            />
            <Button size="sm" onClick={() => void saveAiKey()}>
              Save API key
            </Button>
          </div>
          {aiKeyMessage && (
            <div className="rounded-lg bg-[var(--oc-bg-elevated)] px-3 py-2 text-xs text-[var(--oc-ink-muted)]">
              {aiKeyMessage}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gmail</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2">
            <span className="text-[var(--oc-ink-muted)]">Status</span>
            <Badge tone={gmailStatus.connected ? "success" : "warning"}>
              {gmailStatus.connected ? "Connected" : "Not connected"}
            </Badge>
          </div>
          <div className="text-xs text-[var(--oc-ink-muted)]">
            Source: {gmailStatus.tokenSource ?? "none"} • Refresh: {gmailStatus.refreshConfigured ? "yes" : "no"}
          </div>
          <div className="space-y-2">
            <input
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--oc-border-strong)]"
              placeholder="Paste Gmail access token"
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void saveToken()}>
                Save token
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void connectOAuth()}>
                Connect via OAuth
              </Button>
            </div>
          </div>
          {localMessage && (
            <div className="rounded-lg bg-[var(--oc-bg-elevated)] px-3 py-2 text-xs text-[var(--oc-ink-muted)]">
              {localMessage}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>Diagnostics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!diagnostics && (
            <div className="rounded-lg bg-[var(--oc-bg)] px-3 py-2 text-sm text-[var(--oc-ink-muted)]">
              Run diagnostics to generate a report.
            </div>
          )}
          {diagnostics && (
            <>
              <div className="flex items-center justify-between">
                <Badge tone={diagnostics.status === "ok" ? "success" : "warning"}>
                  {diagnostics.status === "ok" ? "Healthy" : "Needs attention"}
                </Badge>
                <span className="text-xs text-[var(--oc-ink-muted)]">
                  {new Date(diagnostics.generatedAt).toLocaleString()}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {diagnostics.checks.map((check) => (
                  <div
                    key={check.id}
                    className="rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium text-[var(--oc-ink)]">{check.label}</div>
                      <Badge tone={check.ok ? "success" : "warning"}>{check.ok ? "OK" : "Warn"}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-[var(--oc-ink-muted)]">{check.detail}</div>
                  </div>
                ))}
              </div>
              {diagnostics.recommendations.length > 0 && (
                <div className="rounded-lg bg-[var(--oc-bg)] px-3 py-3 text-sm text-[var(--oc-ink-muted)]">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wider">
                    Recommendations
                  </div>
                  <ul className="space-y-1">
                    {diagnostics.recommendations.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>Advanced Mode</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-[var(--oc-ink-muted)]">
            Show technical surfaces like Audit and low-level metadata.
          </div>
          <button
            onClick={() => onToggleAdvanced(!advancedMode)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              advancedMode
                ? "bg-[var(--oc-accent)] text-[var(--oc-bg)]"
                : "bg-[var(--oc-border)] text-[var(--oc-ink-muted)] hover:bg-[var(--oc-border-strong)]"
            }`}
          >
            {advancedMode ? "Enabled" : "Disabled"}
          </button>
        </CardContent>
      </Card>

      {pluginFailures.length > 0 && (
        <Card className="border-[var(--oc-warning)]/50 bg-[var(--oc-warning-bg)] xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-[var(--oc-warning)]">Plugin issues</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-[var(--oc-warning)]">
            {pluginFailures.map((plugin) => (
              <div key={plugin.name}>
                • {plugin.name}: {plugin.error || "failed to load"}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function HealthRow({
  label,
  ok,
  value,
}: {
  label: string;
  ok: boolean;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2">
      <div className="text-[var(--oc-ink-muted)]">{label}</div>
      <div className="flex items-center gap-2">
        <Badge tone={ok ? "success" : "warning"}>{ok ? "OK" : "Check"}</Badge>
        <span className="text-xs text-[var(--oc-ink-muted)]">{value}</span>
      </div>
    </div>
  );
}
