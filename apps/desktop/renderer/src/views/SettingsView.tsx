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
  onRestartDaemon,
  onRunDiagnostics,
  onRunRepair,
  onGetOauthStart,
  onSaveGmailToken,
  onSaveAiKey,
  checkAiKeyConfigured,
  onToggleAdvanced,
  advancedMode,
  apiBase
}: {
  daemonStatus: DaemonStatus;
  diagnostics: DiagnosticsReport | null;
  plugins: PluginInfo[];
  gmailStatus: GmailStatus;
  onboarding: OnboardingData;
  persistOnboarding: (next: OnboardingData) => void;
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
  const pluginFailures = useMemo(() => plugins.filter((item) => !item.loaded), [plugins]);

  useEffect(() => {
    void checkAiKeyConfigured().then(setAiKeyConfigured);
  }, [checkAiKeyConfigured]);

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
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="border border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>System Health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <HealthRow label="Daemon process" ok={daemonStatus.running} value={daemonStatus.running ? "Running" : "Stopped"} />
          <HealthRow label="Daemon readiness" ok={daemonStatus.ready} value={daemonStatus.ready ? "Healthy" : "Not ready"} />
          <HealthRow label="API endpoint" ok={daemonStatus.ready} value={apiBase} />
          <HealthRow label="Secure launch token" ok={daemonStatus.hasToken} value={daemonStatus.hasToken ? "Configured" : "Missing"} />
          {daemonStatus.lastError && (
            <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {daemonStatus.lastError}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void onRestartDaemon()}>Restart daemon</Button>
            <Button variant="secondary" onClick={() => void onRunDiagnostics()}>
              Run diagnostics
            </Button>
            <Button variant="secondary" onClick={() => void onRunRepair()}>
              Repair now
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>AI Provider</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-600">
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
            <span>Provider</span>
            <span className="text-xs text-slate-500">
              {onboarding.aiProvider === "anthropic" ? "Anthropic" : onboarding.aiProvider === "openai" ? "OpenAI" : "Local / BYOK"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["anthropic", "openai", "local"] as const).map((value) => (
              <button
                key={value}
                onClick={() => persistOnboarding({ ...onboarding, aiProvider: value })}
                className={`rounded-xl border px-3 py-1.5 text-sm transition ${
                  onboarding.aiProvider === value
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
                }`}
              >
                {value === "anthropic" ? "Anthropic" : value === "openai" ? "OpenAI" : "Local"}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
            <span>API key</span>
            <Badge tone={aiKeyConfigured ? "success" : "warning"}>
              {aiKeyConfigured ? "Configured" : "Not configured"}
            </Badge>
          </div>
          <div className="space-y-2">
            <input
              type="password"
              value={aiKeyInput}
              onChange={(e) => setAiKeyInput(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
              placeholder="Paste API key"
            />
            <Button onClick={() => void saveAiKey()}>Save API key</Button>
          </div>
          {aiKeyMessage && (
            <div className="rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-700">
              {aiKeyMessage}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>Connector Setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-600">
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
            <span>Gmail</span>
            <Badge tone={gmailStatus.connected ? "success" : "warning"}>
              {gmailStatus.connected ? "Connected" : "Not connected"}
            </Badge>
          </div>
          <div className="text-xs text-slate-500">
            Source: {gmailStatus.tokenSource ?? "none"} • Refresh token:{" "}
            {gmailStatus.refreshConfigured ? "yes" : "no"}
          </div>
          <div className="space-y-2">
            <input
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
              placeholder="Paste Gmail access token"
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void saveToken()}>Save token</Button>
              <Button variant="secondary" onClick={() => void connectOAuth()}>
                Connect via OAuth
              </Button>
            </div>
          </div>
          {localMessage && (
            <div className="rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-700">
              {localMessage}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border border-slate-200 shadow-sm xl:col-span-2">
        <CardHeader>
          <CardTitle>Diagnostics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!diagnostics && (
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-500">
              Run diagnostics to generate a report.
            </div>
          )}
          {diagnostics && (
            <>
              <div className="flex items-center justify-between">
                <Badge tone={diagnostics.status === "ok" ? "success" : "warning"}>
                  {diagnostics.status === "ok" ? "Healthy" : "Needs attention"}
                </Badge>
                <span className="text-xs text-slate-500">
                  {new Date(diagnostics.generatedAt).toLocaleString()}
                </span>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {diagnostics.checks.map((check) => (
                  <div
                    key={check.id}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold text-slate-800">{check.label}</div>
                      <Badge tone={check.ok ? "success" : "warning"}>
                        {check.ok ? "OK" : "Warn"}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{check.detail}</div>
                  </div>
                ))}
              </div>
              {diagnostics.recommendations.length > 0 && (
                <div className="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-600">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
                    Recommendations
                  </div>
                  <ul className="space-y-1">
                    {diagnostics.recommendations.map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border border-slate-200 shadow-sm xl:col-span-2">
        <CardHeader>
          <CardTitle>Advanced Mode</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div className="text-sm text-slate-600">
            Show technical surfaces like Audit and low-level metadata.
          </div>
          <button
            onClick={() => onToggleAdvanced(!advancedMode)}
            className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${
              advancedMode
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {advancedMode ? "Enabled" : "Disabled"}
          </button>
        </CardContent>
      </Card>

      {pluginFailures.length > 0 && (
        <Card className="border border-amber-200 bg-amber-50 shadow-sm xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-amber-800">Plugin issues detected</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-amber-800">
            {pluginFailures.map((plugin) => (
              <div key={plugin.name}>
                - {plugin.name}: {plugin.error || "failed to load"}
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
  value
}: {
  label: string;
  ok: boolean;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-slate-700">{label}</div>
      <div className="flex items-center gap-2">
        <Badge tone={ok ? "success" : "warning"}>{ok ? "OK" : "Check"}</Badge>
        <span className="text-xs text-slate-500">{value}</span>
      </div>
    </div>
  );
}
