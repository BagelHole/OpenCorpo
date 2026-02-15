import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type OnboardingData = {
  completed: boolean;
  aiProvider: "anthropic" | "openai" | "local";
  aiKey: string;
  gmailAccessToken: string;
  profile: {
    name: string;
    role: string;
    jobTitle: string;
    about: string;
  };
};

type Props = {
  onboarding: OnboardingData;
  gmailConnected: boolean;
  persistOnboarding: (next: OnboardingData) => void;
  completeOnboarding: () => void;
  saveGmailToken: (token: string) => Promise<void>;
  saveAiKey: (key: string) => Promise<void>;
  saveProfile: (profile: {
    name: string;
    role: string;
    jobTitle: string;
    about: string;
  }) => Promise<void>;
  saveAiProvider?: (provider: string) => Promise<void>;
  checkAiKeyConfigured: () => Promise<boolean>;
  getGmailOauthStart: () => Promise<{ ok: boolean; authUrl?: string; error?: string }>;
};

function normalizeProfile(
  profile: OnboardingData["profile"] | null | undefined
): OnboardingData["profile"] {
  return {
    name: profile?.name ?? "",
    role: profile?.role ?? "",
    jobTitle: profile?.jobTitle ?? "",
    about: profile?.about ?? ""
  };
}

export function OnboardingWizard({
  onboarding,
  gmailConnected,
  persistOnboarding,
  completeOnboarding,
  saveGmailToken,
  saveAiKey,
  saveProfile,
  saveAiProvider,
  checkAiKeyConfigured,
  getGmailOauthStart
}: Props) {
  const [step, setStep] = useState(0);
  const [tokenInput, setTokenInput] = useState(onboarding.gmailAccessToken ?? "");
  const [aiKeyInput, setAiKeyInput] = useState(onboarding.aiKey ?? "");
  const [profileInput, setProfileInput] = useState(() => normalizeProfile(onboarding.profile));
  const [aiKeyConfigured, setAiKeyConfigured] = useState<boolean | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const steps = useMemo(
    () => [
      "Welcome",
      "Your Profile",
      "Choose AI Provider",
      "Enter API Key",
      "Connect Gmail (Optional)",
      "Finish Setup"
    ],
    []
  );

  const saveProvider = async (provider: OnboardingData["aiProvider"]) => {
    persistOnboarding({ ...onboarding, aiProvider: provider });
    if (saveAiProvider) {
      try {
        await saveAiProvider(provider);
      } catch {
        // Daemon may not be ready during onboarding
      }
    }
  };

  useEffect(() => {
    if (step === 3) {
      void checkAiKeyConfigured().then(setAiKeyConfigured);
    }
  }, [step, checkAiKeyConfigured]);

  useEffect(() => {
    setProfileInput(normalizeProfile(onboarding.profile));
  }, [onboarding.profile]);

  const handleSaveProfile = async () => {
    setSaving(true);
    setLocalError(null);
    try {
      await saveProfile(profileInput);
      persistOnboarding({
        ...onboarding,
        profile: profileInput
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to save profile.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAiKey = async () => {
    if (!aiKeyInput.trim()) {
      setLocalError("Please enter an API key.");
      return;
    }
    setSaving(true);
    setLocalError(null);
    try {
      await saveAiKey(aiKeyInput.trim());
      persistOnboarding({ ...onboarding, aiKey: aiKeyInput.trim() });
      setAiKeyConfigured(true);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to save API key.");
    } finally {
      setSaving(false);
    }
  };

  const finish = () => {
    setLocalError(null);
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
    <div className="mx-auto flex w-full max-w-2xl flex-col justify-center px-4 py-8 sm:px-6 sm:py-12">
      <Card>
        <CardHeader className="space-y-3 border-b border-[var(--oc-border)]">
          <div className="text-xs font-semibold uppercase tracking-widest text-[var(--oc-ink-muted)]">
            OpenCorpo Setup
          </div>
          <CardTitle className="text-xl sm:text-2xl">Let&apos;s make this effortless</CardTitle>
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
            <div className="space-y-4 text-sm text-[var(--oc-ink-muted)]">
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
              <p className="text-[var(--oc-ink-muted)]">
                Tell OpenCorpo who you are so responses can match your context.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  value={profileInput.name}
                  onChange={(event) =>
                    setProfileInput((current) => ({ ...current, name: event.target.value }))
                  }
                  className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--oc-border-strong)] focus:ring-2 focus:ring-[var(--oc-border)]"
                  placeholder="Your name"
                />
                <input
                  value={profileInput.role}
                  onChange={(event) =>
                    setProfileInput((current) => ({ ...current, role: event.target.value }))
                  }
                  className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--oc-border-strong)] focus:ring-2 focus:ring-[var(--oc-border)]"
                  placeholder="Role (e.g. Founder)"
                />
                <input
                  value={profileInput.jobTitle}
                  onChange={(event) =>
                    setProfileInput((current) => ({ ...current, jobTitle: event.target.value }))
                  }
                  className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--oc-border-strong)] focus:ring-2 focus:ring-[var(--oc-border)] sm:col-span-2"
                  placeholder="Job title"
                />
                <textarea
                  value={profileInput.about}
                  onChange={(event) =>
                    setProfileInput((current) => ({ ...current, about: event.target.value }))
                  }
                  rows={3}
                  className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--oc-border-strong)] focus:ring-2 focus:ring-[var(--oc-border)] sm:col-span-2"
                  placeholder="Anything else the AI should know about you..."
                />
              </div>
              <Button onClick={() => void handleSaveProfile()} disabled={saving}>
                {saving ? "Saving..." : "Save profile"}
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4 text-sm">
              <p className="text-[var(--oc-ink-muted)]">
                Pick your default AI provider. You can change this later in settings.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                {(
                  [
                    ["anthropic", "Anthropic"],
                    ["openai", "OpenAI"],
                    ["local", "Local / BYOK"]
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => void saveProvider(value)}
                    className={`rounded-lg border px-4 py-3 text-left text-sm transition ${
                      onboarding.aiProvider === value
                        ? "border-[var(--oc-accent)] bg-[var(--oc-accent)] text-[var(--oc-bg)]"
                        : "border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] text-[var(--oc-ink)] hover:border-[var(--oc-border-strong)]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4 text-sm">
              <p className="text-[var(--oc-ink-muted)]">
                Enter your API key for {onboarding.aiProvider === "anthropic" ? "Anthropic" : onboarding.aiProvider === "openai" ? "OpenAI" : "your local/BYOK provider"}. You can change this later in settings.
              </p>
              <div className="flex items-center gap-3">
                <span>API key status:</span>
                <Badge tone={aiKeyConfigured ? "success" : "warning"}>
                  {aiKeyConfigured ? "Configured" : "Not configured"}
                </Badge>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider text-[var(--oc-ink-muted)]">
                  API key
                </label>
                <input
                  type="password"
                  value={aiKeyInput}
                  onChange={(event) => setAiKeyInput(event.target.value)}
                  className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--oc-border-strong)] focus:ring-2 focus:ring-[var(--oc-border)]"
                  placeholder="Paste your API key"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void handleSaveAiKey()} disabled={saving}>
                  {saving ? "Saving..." : "Save key"}
                </Button>
              </div>
              <p className="text-xs text-[var(--oc-ink-muted)]">
                {onboarding.aiProvider === "local" ? "You can skip this step for local/BYOK setups." : "Required for AI-powered chat."}
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4 text-sm text-[var(--oc-ink-muted)]">
              <div className="flex items-center gap-3">
                <span>Gmail status:</span>
                <Badge tone={gmailConnected ? "success" : "warning"}>
                  {gmailConnected ? "Connected" : "Not connected"}
                </Badge>
              </div>
              <p className="text-sm text-[var(--oc-ink-muted)]">
                This step is optional. You can skip now and connect Gmail later in
                Settings.
              </p>
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider text-[var(--oc-ink-muted)]">
                  Gmail access token (quick path)
                </label>
                <input
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  className="w-full rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--oc-border-strong)] focus:ring-2 focus:ring-[var(--oc-border)]"
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

          {step === 5 && (
            <div className="space-y-3 text-sm text-[var(--oc-ink-muted)]">
              <p>Everything is ready. OpenCorpo will now launch your clean workspace.</p>
              <ul className="space-y-1">
                <li>- Chat is your main workspace.</li>
                <li>- Inbox handles approvals and follow-up actions.</li>
                <li>- Settings includes diagnostics and repair tools.</li>
              </ul>
            </div>
          )}

          {localError && <div className="rounded-lg bg-[var(--oc-warning-bg)] px-3 py-2 text-sm text-[var(--oc-warning)]">{localError}</div>}

          <div className="flex items-center justify-between">
            <Button
              variant="secondary"
              onClick={() => setStep((prev) => Math.max(0, prev - 1))}
              disabled={step === 0}
            >
              Back
            </Button>
            {step < steps.length - 1 ? (
              <Button
                onClick={() => {
                  if (step === 1) {
                    persistOnboarding({
                      ...onboarding,
                      profile: profileInput
                    });
                  }
                  setStep((prev) => Math.min(steps.length - 1, prev + 1));
                }}
              >
                {step === 4 ? "Continue without Gmail" : "Continue"}
              </Button>
            ) : (
              <Button onClick={() => void finish()}>Enter OpenCorpo</Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
