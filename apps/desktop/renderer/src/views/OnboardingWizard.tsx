import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type OnboardingData = {
  completed: boolean;
  aiProvider: "anthropic" | "openai" | "vercel";
  aiKey: string;
  gmailAccessToken: string;
};

type Props = {
  onboarding: OnboardingData;
  gmailConnected: boolean;
  persistOnboarding: (next: OnboardingData) => void;
  completeOnboarding: () => void;
  saveGmailToken: (token: string) => Promise<void>;
  getGmailOauthStart: () => Promise<{ ok: boolean; authUrl?: string; error?: string }>;
  saveAiConfig: (provider: string, apiKey: string) => Promise<void>;
  daemonReady: boolean;
};

export function OnboardingWizard({
  onboarding,
  gmailConnected,
  persistOnboarding,
  completeOnboarding,
  saveGmailToken,
  getGmailOauthStart,
  saveAiConfig,
  daemonReady
}: Props) {
  const [step, setStep] = useState(0);
  const [tokenInput, setTokenInput] = useState(onboarding.gmailAccessToken ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const steps = useMemo(
    () => [
      "Welcome",
      "Choose AI Provider",
      "Connect Gmail (Optional)",
      "Finish Setup"
    ],
    []
  );

  const saveProvider = (provider: OnboardingData["aiProvider"]) => {
    persistOnboarding({ ...onboarding, aiProvider: provider });
  };

  const finish = async () => {
    setLocalError(null);
    if (onboarding.aiKey.trim() && daemonReady) {
      try {
        await saveAiConfig(onboarding.aiProvider, onboarding.aiKey);
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : "Failed to save AI config.");
        return;
      }
    }
    completeOnboarding();
  };

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) {
      setLocalError("Please paste a Gmail access token.");
      return;
    }
    setSaving(true);
    setLocalError(null);
    try {
      await saveGmailToken(tokenInput.trim());
      persistOnboarding({
        ...onboarding,
        gmailAccessToken: tokenInput.trim()
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to save token.");
    } finally {
      setSaving(false);
    }
  };

  const handleOauthConnect = async () => {
    try {
      const response = await getGmailOauthStart();
      if (!response.ok || !response.authUrl) {
        setLocalError(response.error ?? "Unable to start OAuth.");
        return;
      }
      window.open(response.authUrl, "_blank", "noopener,noreferrer");
      setLocalError(
        "Finish sign-in in the browser tab, then return here and continue."
      );
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "OAuth start failed.");
    }
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col justify-center px-6 py-10">
      <Card className="border border-slate-200 shadow-sm">
        <CardHeader className="space-y-3 border-b border-slate-200">
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
            OpenCorpo Setup
          </div>
          <CardTitle className="text-2xl">Let&apos;s make this effortless</CardTitle>
          <div className="flex flex-wrap gap-2 text-xs">
            {steps.map((label, index) => (
              <Badge key={label} tone={index <= step ? "success" : "default"}>
                {index + 1}. {label}
              </Badge>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-6 pt-6">
          {step === 0 && (
            <div className="space-y-4 text-sm text-slate-600">
              <p>
                OpenCorpo runs locally on your desktop, keeps your data private, and
                lets the agent handle your repetitive work safely.
              </p>
              <p>
                This setup takes about two minutes. After that, you just use chat and
                approvals.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4 text-sm">
              <p className="text-slate-600">
                Pick your AI provider and add your API key. Keys are stored locally and never leave your machine.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                {(
                  [
                    ["openai", "OpenAI (GPT-4)"],
                    ["anthropic", "Anthropic (Claude)"],
                    ["vercel", "Vercel AI (BYOK)"]
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => saveProvider(value)}
                    className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${
                      onboarding.aiProvider === value
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">
                  API Key
                </label>
                <input
                  type="password"
                  value={onboarding.aiKey}
                  onChange={(e) =>
                    persistOnboarding({ ...onboarding, aiKey: e.target.value })
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
                  placeholder={
                    onboarding.aiProvider === "openai"
                      ? "sk-..."
                      : onboarding.aiProvider === "anthropic"
                        ? "sk-ant-..."
                        : "Your API key"
                  }
                />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4 text-sm text-slate-600">
              <div className="flex items-center gap-3">
                <span>Gmail status:</span>
                <Badge tone={gmailConnected ? "success" : "warning"}>
                  {gmailConnected ? "Connected" : "Not connected"}
                </Badge>
              </div>
              <p className="text-sm text-slate-500">
                This step is optional. You can skip now and connect Gmail later in
                Settings.
              </p>
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">
                  Gmail access token (quick path)
                </label>
                <input
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
                  placeholder="Paste access token"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void handleSaveToken()} disabled={saving}>
                  {saving ? "Saving..." : "Save token"}
                </Button>
                <Button variant="secondary" onClick={() => void handleOauthConnect()}>
                  Open OAuth connect
                </Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3 text-sm text-slate-600">
              <p>Everything is ready. OpenCorpo will now launch your clean workspace.</p>
              <ul className="space-y-1">
                <li>- Chat is your main workspace.</li>
                <li>- Inbox handles approvals and follow-up actions.</li>
                <li>- Settings includes diagnostics and repair tools.</li>
              </ul>
            </div>
          )}

          {localError && <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-700">{localError}</div>}

          <div className="flex items-center justify-between">
            <Button
              variant="secondary"
              onClick={() => setStep((prev) => Math.max(0, prev - 1))}
              disabled={step === 0}
            >
              Back
            </Button>
            {step < steps.length - 1 ? (
              <Button onClick={() => setStep((prev) => Math.min(steps.length - 1, prev + 1))}>
                {step === 2 ? "Continue without Gmail" : "Continue"}
              </Button>
            ) : (
              <Button onClick={() => void finish()}>
                Enter OpenCorpo
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
