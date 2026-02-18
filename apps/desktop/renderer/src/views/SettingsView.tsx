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

type ScriptSecretItem = {
  name: string;
  ref: string;
  provider: string;
  updatedAt: string;
  description: string;
};

type ScriptExecutionMode = "safe" | "trusted";

type OnboardingData = {
  completed: boolean;
  aiProvider: "anthropic" | "openai" | "local" | "codex";
  aiKey: string;
  gmailAccessToken: string;
  profile: {
    name: string;
    role: string;
    jobTitle: string;
    about: string;
  };
};

type CodexStatus = {
  connected: boolean;
  provider: string | null;
  accountId: string | null;
  expiresAt: string | null;
  refreshConfigured: boolean;
};

function normalizeProfile(profile: {
  name?: string;
  role?: string;
  jobTitle?: string;
  about?: string;
} | null | undefined) {
  return {
    name: profile?.name ?? "",
    role: profile?.role ?? "",
    jobTitle: profile?.jobTitle ?? "",
    about: profile?.about ?? ""
  };
}

function normalizeModelDefaults(defaults: {
  anthropic?: string;
  openai?: string;
  local?: string;
  codex?: string;
} | null | undefined) {
  return {
    anthropic: defaults?.anthropic ?? "",
    openai: defaults?.openai ?? "",
    local: defaults?.local ?? "",
    codex: defaults?.codex ?? ""
  };
}

export function SettingsView({
  daemonStatus,
  diagnostics,
  plugins,
  gmailStatus,
  codexStatus,
  onboarding,
  profile,
  aiModelDefaults,
  scriptSecrets,
  scriptExecutionMode,
  persistOnboarding,
  onSaveProfile,
  onSaveAiModelDefaults,
  onSaveScriptSecret,
  onSaveScriptExecutionMode,
  saveAiProvider,
  onRestartDaemon,
  onRunDiagnostics,
  onRunRepair,
  onGetOauthStart,
  onGetCodexOauthStart,
  onDisconnectCodex,
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
  codexStatus: CodexStatus;
  onboarding: OnboardingData;
  profile: {
    name: string;
    role: string;
    jobTitle: string;
    about: string;
  };
  aiModelDefaults: {
    anthropic: string;
    openai: string;
    local: string;
    codex: string;
  };
  scriptSecrets: ScriptSecretItem[];
  scriptExecutionMode: ScriptExecutionMode;
  persistOnboarding: (next: OnboardingData) => void;
  onSaveProfile: (profile: {
    name: string;
    role: string;
    jobTitle: string;
    about: string;
  }) => Promise<void>;
  onSaveAiModelDefaults: (defaults: {
    anthropic: string;
    openai: string;
    local: string;
    codex: string;
  }) => Promise<void>;
  onSaveScriptSecret: (input: {
    name: string;
    value: string;
    description?: string;
  }) => Promise<void>;
  onSaveScriptExecutionMode: (mode: ScriptExecutionMode) => Promise<void>;
  saveAiProvider: (provider: string) => Promise<void>;
  onRestartDaemon: () => Promise<void>;
  onRunDiagnostics: () => Promise<void>;
  onRunRepair: () => Promise<void>;
  onGetOauthStart: () => Promise<{ ok: boolean; authUrl?: string; error?: string }>;
  onGetCodexOauthStart: () => Promise<{ ok: boolean; authUrl?: string; error?: string }>;
  onDisconnectCodex: () => Promise<void>;
  onSaveGmailToken: (token: string) => Promise<void>;
  onSaveAiKey: (key: string) => Promise<void>;
  checkAiKeyConfigured: () => Promise<boolean>;
  onToggleAdvanced: (next: boolean) => void;
  advancedMode: boolean;
  apiBase: string;
}) {
  const editableFieldClass =
    "w-full rounded-lg border border-[var(--oc-border-strong)] bg-[var(--oc-bg-elevated)] px-3 py-2 text-sm text-[var(--oc-ink)] shadow-[inset_0_1px_0_rgba(0,0,0,0.04)] outline-none transition placeholder:text-[var(--oc-ink-muted)] focus:border-[var(--oc-accent)] focus:shadow-[0_0_0_2px_var(--oc-bg-elevated),0_0_0_3px_var(--oc-border-strong)]";
  const [tokenInput, setTokenInput] = useState("");
  const [aiKeyInput, setAiKeyInput] = useState("");
  const [aiKeyConfigured, setAiKeyConfigured] = useState<boolean | null>(null);
  const [aiKeyMessage, setAiKeyMessage] = useState<string | null>(null);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [scriptSecretMessage, setScriptSecretMessage] = useState<string | null>(null);
  const [scriptModeMessage, setScriptModeMessage] = useState<string | null>(null);
  const [scriptSecretNameInput, setScriptSecretNameInput] = useState("");
  const [scriptSecretDescriptionInput, setScriptSecretDescriptionInput] = useState("");
  const [scriptSecretValueInput, setScriptSecretValueInput] = useState("");
  const [profileInput, setProfileInput] = useState(() => normalizeProfile(profile));
  const [modelDefaultsInput, setModelDefaultsInput] = useState(() =>
    normalizeModelDefaults(aiModelDefaults)
  );
  const pluginFailures = useMemo(() => plugins.filter((p) => !p.loaded), [plugins]);

  useEffect(() => {
    setProfileInput(normalizeProfile(profile));
  }, [profile]);

  useEffect(() => {
    setModelDefaultsInput(normalizeModelDefaults(aiModelDefaults));
  }, [aiModelDefaults]);

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

  const connectCodexOAuth = async () => {
    const start = await onGetCodexOauthStart();
    if (!start.ok || !start.authUrl) {
      setAiKeyMessage(start.error ?? "Failed to start Codex OAuth.");
      return;
    }
    window.open(start.authUrl, "_blank", "noopener,noreferrer");
    setAiKeyMessage("Complete ChatGPT sign-in in your browser, then reopen this page.");
  };

  const disconnectCodex = async () => {
    try {
      await onDisconnectCodex();
      setAiKeyMessage("Codex subscription disconnected.");
    } catch (error) {
      setAiKeyMessage(error instanceof Error ? error.message : "Failed to disconnect Codex.");
    }
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

  const saveProfile = async () => {
    try {
      await onSaveProfile(profileInput);
      persistOnboarding({
        ...onboarding,
        profile: profileInput
      });
      setLocalMessage("Profile saved.");
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Failed to save profile.");
    }
  };

  const saveModelDefaults = async () => {
    try {
      await onSaveAiModelDefaults(modelDefaultsInput);
      setAiKeyMessage("Default models saved.");
    } catch (error) {
      setAiKeyMessage(error instanceof Error ? error.message : "Failed to save model defaults.");
    }
  };

  const saveScriptSecret = async () => {
    const name = scriptSecretNameInput.trim();
    const value = scriptSecretValueInput.trim();
    if (!name) {
      setScriptSecretMessage("Enter a secret name first.");
      return;
    }
    if (!value) {
      setScriptSecretMessage("Enter a secret value first.");
      return;
    }
    try {
      await onSaveScriptSecret({
        name,
        value,
        description: scriptSecretDescriptionInput.trim()
      });
      setScriptSecretValueInput("");
      setScriptSecretNameInput("");
      setScriptSecretDescriptionInput("");
      setScriptSecretMessage("Script secret saved.");
    } catch (error) {
      setScriptSecretMessage(
        error instanceof Error ? error.message : "Failed to save script secret."
      );
    }
  };

  const saveScriptMode = async (nextMode: ScriptExecutionMode) => {
    if (nextMode === scriptExecutionMode) return;
    if (nextMode === "trusted") {
      const confirmed = window.confirm(
        "Enable Trusted Script Mode? This reduces protections and allows broader script access."
      );
      if (!confirmed) return;
    }
    try {
      await onSaveScriptExecutionMode(nextMode);
      setScriptModeMessage(
        nextMode === "safe"
          ? "Script mode set to Safe."
          : "Trusted mode enabled. Use only with trusted scripts."
      );
    } catch (error) {
      setScriptModeMessage(
        error instanceof Error ? error.message : "Failed to update script mode."
      );
    }
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
              {onboarding.aiProvider === "anthropic"
                ? "Anthropic"
                : onboarding.aiProvider === "openai"
                  ? "OpenAI"
                  : onboarding.aiProvider === "codex"
                    ? "Codex (ChatGPT)"
                    : "Local / BYOK"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["anthropic", "openai", "local", "codex"] as const).map((value) => (
              <button
                key={value}
                onClick={() => void handleProviderChange(value)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  onboarding.aiProvider === value
                    ? "border-[var(--oc-accent)] bg-[var(--oc-accent)] text-[var(--oc-bg)]"
                    : "border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] text-[var(--oc-ink)] hover:border-[var(--oc-border-strong)]"
                }`}
              >
                {value === "anthropic"
                  ? "Anthropic"
                  : value === "openai"
                    ? "OpenAI"
                    : value === "codex"
                      ? "Codex"
                      : "Local"}
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
            {onboarding.aiProvider === "codex" ? (
              <>
                <div className="rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-xs text-[var(--oc-ink-muted)]">
                  Codex status: {codexStatus.connected ? "Connected" : "Not connected"}
                  {codexStatus.accountId ? ` • Account: ${codexStatus.accountId}` : ""}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void connectCodexOAuth()}>
                    {codexStatus.connected ? "Reconnect ChatGPT" : "Connect ChatGPT"}
                  </Button>
                  {codexStatus.connected && (
                    <Button size="sm" variant="secondary" onClick={() => void disconnectCodex()}>
                      Disconnect Codex
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <>
                <input
                  type="password"
                  value={aiKeyInput}
                  onChange={(e) => setAiKeyInput(e.target.value)}
                  className={editableFieldClass}
                  placeholder="Paste API key"
                />
                <Button size="sm" onClick={() => void saveAiKey()}>
                  Save API key
                </Button>
              </>
            )}
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
          <CardTitle>Model Defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-[var(--oc-ink-muted)]">
            Choose default model per provider. Chat tabs can override these.
          </p>
          <input
            value={modelDefaultsInput.anthropic}
            onChange={(event) =>
              setModelDefaultsInput((current) => ({ ...current, anthropic: event.target.value }))
            }
            className={editableFieldClass}
            placeholder="Anthropic default model (e.g. anthropic/claude-sonnet-4.5)"
          />
          <input
            value={modelDefaultsInput.openai}
            onChange={(event) =>
              setModelDefaultsInput((current) => ({ ...current, openai: event.target.value }))
            }
            className={editableFieldClass}
            placeholder="OpenAI default model (e.g. gpt-5.2-chat-latest)"
          />
          <input
            value={modelDefaultsInput.local}
            onChange={(event) =>
              setModelDefaultsInput((current) => ({ ...current, local: event.target.value }))
            }
            className={editableFieldClass}
            placeholder="Local/BYOK default model"
          />
          <input
            value={modelDefaultsInput.codex}
            onChange={(event) =>
              setModelDefaultsInput((current) => ({ ...current, codex: event.target.value }))
            }
            className={editableFieldClass}
            placeholder="Codex default model (e.g. gpt-5.2-codex)"
          />
          <Button size="sm" onClick={() => void saveModelDefaults()}>
            Save model defaults
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Script Security Mode</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-[var(--oc-ink-muted)]">
            Safe mode is recommended. Trusted mode allows more script power but lowers security.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void saveScriptMode("safe")}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                scriptExecutionMode === "safe"
                  ? "border-[var(--oc-accent)] bg-[var(--oc-accent)] text-[var(--oc-bg)]"
                  : "border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] text-[var(--oc-ink)] hover:border-[var(--oc-border-strong)]"
              }`}
            >
              Safe (Recommended)
            </button>
            <button
              onClick={() => void saveScriptMode("trusted")}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                scriptExecutionMode === "trusted"
                  ? "border-[var(--oc-warning)] bg-[var(--oc-warning-bg)] text-[var(--oc-warning)]"
                  : "border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] text-[var(--oc-ink)] hover:border-[var(--oc-border-strong)]"
              }`}
            >
              Trusted (Less secure)
            </button>
          </div>
          {scriptExecutionMode === "safe" ? (
            <div className="rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-xs text-[var(--oc-ink-muted)]">
              Scripts run with restricted environment and safe-mode import checks.
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--oc-warning)]/50 bg-[var(--oc-warning-bg)] px-3 py-2 text-xs text-[var(--oc-warning)]">
              Trusted mode is enabled. Scripts have broader access and can do more damage if compromised.
            </div>
          )}
          {scriptModeMessage && (
            <div className="rounded-lg bg-[var(--oc-bg-elevated)] px-3 py-2 text-xs text-[var(--oc-ink-muted)]">
              {scriptModeMessage}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Script Secrets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-[var(--oc-ink-muted)]">
            Add credentials for generated scripts. The AI can reference secret names and file
            locations, but not values.
          </p>
          <input
            value={scriptSecretNameInput}
            onChange={(event) => setScriptSecretNameInput(event.target.value)}
            className={editableFieldClass}
            placeholder="Secret name (example: stripe.api_key)"
          />
          <input
            value={scriptSecretDescriptionInput}
            onChange={(event) => setScriptSecretDescriptionInput(event.target.value)}
            className={editableFieldClass}
            placeholder="Description (optional)"
          />
          <input
            type="password"
            value={scriptSecretValueInput}
            onChange={(event) => setScriptSecretValueInput(event.target.value)}
            className={editableFieldClass}
            placeholder="Secret value"
          />
          <Button size="sm" onClick={() => void saveScriptSecret()}>
            Save script secret
          </Button>
          {scriptSecretMessage && (
            <div className="rounded-lg bg-[var(--oc-bg-elevated)] px-3 py-2 text-xs text-[var(--oc-ink-muted)]">
              {scriptSecretMessage}
            </div>
          )}
          <div className="space-y-2">
            {scriptSecrets.length === 0 && (
              <div className="rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-xs text-[var(--oc-ink-muted)]">
                No script secrets saved yet.
              </div>
            )}
            {scriptSecrets.map((secret) => (
              <div
                key={secret.name}
                className="overflow-hidden rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2"
              >
                <div className="break-all text-xs font-semibold text-[var(--oc-ink)]">{secret.name}</div>
                {secret.description && (
                  <div className="mt-0.5 text-xs text-[var(--oc-ink-muted)]">{secret.description}</div>
                )}
                <div className="mt-1 break-all text-[11px] leading-4 text-[var(--oc-ink-muted)]">
                  {secret.ref}
                </div>
              </div>
            ))}
          </div>
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
              className={editableFieldClass}
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

      <Card>
        <CardHeader>
          <CardTitle>User Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <input
            value={profileInput.name}
            onChange={(event) =>
              setProfileInput((current) => ({ ...current, name: event.target.value }))
            }
            className={editableFieldClass}
            placeholder="Name"
          />
          <input
            value={profileInput.role}
            onChange={(event) =>
              setProfileInput((current) => ({ ...current, role: event.target.value }))
            }
            className={editableFieldClass}
            placeholder="Role"
          />
          <input
            value={profileInput.jobTitle}
            onChange={(event) =>
              setProfileInput((current) => ({ ...current, jobTitle: event.target.value }))
            }
            className={editableFieldClass}
            placeholder="Job title"
          />
          <textarea
            value={profileInput.about}
            onChange={(event) =>
              setProfileInput((current) => ({ ...current, about: event.target.value }))
            }
            rows={3}
            className={editableFieldClass}
            placeholder="Anything else the AI should know..."
          />
          <Button size="sm" onClick={() => void saveProfile()}>
            Save profile
          </Button>
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
