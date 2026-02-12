import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type Approval = {
  id: number;
  status: string;
  tool: string | null;
  reason: string | null;
  requested_by: string;
  metadata?: Record<string, unknown> | null;
};

export type Job = {
  id: number;
  name: string;
  enabled: number;
  schedule_summary?: string | null;
};

export type JobRun = {
  id: number;
  job_id: number;
  ts: string;
  status: string;
  error?: string | null;
};

export type AuditEntry = {
  id: number;
  ts: string;
  actor: string;
  action: string;
  tool: string | null;
  policy: string | null;
  entry_hash?: string | null;
};

export type PluginInfo = {
  name: string;
  version: string;
  loaded: boolean;
  error?: string | null;
};

export type ToolInfo = {
  name: string;
  risk: "low" | "medium" | "high";
  capabilities: string[];
};

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type DiagnosticsCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

type DiagnosticsReport = {
  status: "ok" | "warn";
  generatedAt: string;
  checks: DiagnosticsCheck[];
  recommendations: string[];
};

type OnboardingData = {
  completed: boolean;
  aiProvider: "anthropic" | "openai" | "local";
  aiKey: string;
  gmailAccessToken: string;
};

const onboardingStorageKey = "opencorpo_onboarding_v2";

function readOnboardingState(): OnboardingData {
  try {
    const raw = localStorage.getItem(onboardingStorageKey);
    if (!raw) {
      return {
        completed: false,
        aiProvider: "anthropic",
        aiKey: "",
        gmailAccessToken: ""
      };
    }
    const parsed = JSON.parse(raw) as OnboardingData;
    return {
      completed: Boolean(parsed.completed),
      aiProvider:
        parsed.aiProvider === "openai" || parsed.aiProvider === "local"
          ? parsed.aiProvider
          : "anthropic",
      aiKey: parsed.aiKey ?? "",
      gmailAccessToken: parsed.gmailAccessToken ?? ""
    };
  } catch {
    return {
      completed: false,
      aiProvider: "anthropic",
      aiKey: "",
      gmailAccessToken: ""
    };
  }
}

export function useOpenCorpoState() {
  const [apiBase, setApiBase] = useState("http://127.0.0.1:3555");
  const [launchToken, setLaunchToken] = useState("");
  const [daemonStatus, setDaemonStatus] = useState<{
    running: boolean;
    ready: boolean;
    port: number;
    pid: number | null;
    hasToken: boolean;
    lastError: string | null;
  }>({
    running: false,
    ready: false,
    port: 3555,
    pid: null,
    hasToken: false,
    lastError: null
  });
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobRuns, setJobRuns] = useState<JobRun[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "system",
      content:
        "Welcome to OpenCorpo. Ask me what needs your attention and I will do the heavy lifting."
    }
  ]);
  const [isSending, setIsSending] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(() => {
    const raw = localStorage.getItem("opencorpo_session");
    return raw ? Number(raw) : null;
  });
  const [onboarding, setOnboarding] = useState<OnboardingData>(() => readOnboardingState());
  const [gmailStatus, setGmailStatus] = useState<{
    connected: boolean;
    tokenSource: string | null;
    refreshConfigured: boolean;
  }>({
    connected: false,
    tokenSource: null,
    refreshConfigured: false
  });

  const apiBaseRef = useRef(apiBase);
  const launchTokenRef = useRef(launchToken);

  useEffect(() => {
    apiBaseRef.current = apiBase;
  }, [apiBase]);

  useEffect(() => {
    launchTokenRef.current = launchToken;
  }, [launchToken]);

  const persistOnboarding = useCallback((next: OnboardingData) => {
    setOnboarding(next);
    localStorage.setItem(onboardingStorageKey, JSON.stringify(next));
  }, []);

  const requestJson = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const headers: HeadersInit = {
        Authorization: `Bearer ${launchTokenRef.current}`,
        "content-type": "application/json",
        ...(options.headers ?? {})
      };
      const response = await fetch(`${apiBaseRef.current}${path}`, {
        ...options,
        headers
      });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status}) for ${path}`);
      }
      return response.json();
    },
    []
  );

  const refreshDaemonStatus = useCallback(async () => {
    if (!window.opencorpo?.daemon) return;
    const runtime = await window.opencorpo.daemon.getRuntimeConfig();
    setApiBase(runtime.apiBase);
    setLaunchToken(runtime.launchToken);
    const status = await window.opencorpo.daemon.getStatus();
    setDaemonStatus(status);
  }, []);

  const refreshData = useCallback(async () => {
    if (!launchTokenRef.current || !daemonStatus.ready) return;
    try {
      const [approvalsData, jobsData, runsData, auditData, pluginData, toolsData, gmailData] =
        await Promise.all([
          requestJson("/approvals"),
          requestJson("/jobs"),
          requestJson("/jobs/runs"),
          requestJson("/audit?limit=30"),
          requestJson("/plugins"),
          requestJson("/tools"),
          requestJson("/connectors/gmail/status")
        ]);
      setApprovals(approvalsData.items ?? []);
      setJobs(jobsData.items ?? []);
      setJobRuns(runsData.items ?? []);
      setAudit(auditData.items ?? []);
      setPlugins(pluginData.items ?? []);
      setTools(toolsData.items ?? []);
      setGmailStatus({
        connected: Boolean(gmailData.connected),
        tokenSource: gmailData.tokenSource ?? null,
        refreshConfigured: Boolean(gmailData.refreshConfigured)
      });
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Failed to refresh data");
    }
  }, [daemonStatus.ready, requestJson]);

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    const session = await requestJson("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Primary session" })
    });
    setSessionId(session.id);
    localStorage.setItem("opencorpo_session", String(session.id));
    return session.id as number;
  }, [requestJson, sessionId]);

  const loadChatHistory = useCallback(async () => {
    if (!daemonStatus.ready) return;
    const id = await ensureSession();
    const response = await requestJson(`/chat/messages?sessionId=${id}`);
    if (Array.isArray(response.items) && response.items.length > 0) {
      setMessages(
        response.items.map((item: { role: ChatMessage["role"]; content: string }) => ({
          role: item.role,
          content: item.content
        }))
      );
    }
  }, [daemonStatus.ready, ensureSession, requestJson]);

  const sendMessage = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || isSending) return;
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setIsSending(true);
      try {
        const id = await ensureSession();
        const response = await requestJson("/chat/messages", {
          method: "POST",
          body: JSON.stringify({
            sessionId: id,
            role: "user",
            content: text
          })
        });
        if (response.reply) {
          setMessages((prev) => [...prev, { role: "assistant", content: response.reply }]);
        } else {
          setMessages((prev) => [
            ...prev,
            { role: "system", content: "Agent did not return a response." }
          ]);
        }
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content:
              error instanceof Error
                ? `Message failed: ${error.message}`
                : "Message failed unexpectedly."
          }
        ]);
      } finally {
        setIsSending(false);
      }
    },
    [ensureSession, isSending, requestJson]
  );

  const runDiagnosticsNow = useCallback(async () => {
    try {
      const response = await requestJson("/diagnostics");
      setDiagnostics(response.report ?? null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Failed to run diagnostics");
    }
  }, [requestJson]);

  const restartDaemon = useCallback(async () => {
    if (!window.opencorpo?.daemon) return;
    setLoading(true);
    await window.opencorpo.daemon.restart();
    await refreshDaemonStatus();
    await refreshData();
    setLoading(false);
  }, [refreshDaemonStatus, refreshData]);

  const runRepair = useCallback(async () => {
    await requestJson("/diagnostics/repair", { method: "POST" });
    await refreshData();
    await runDiagnosticsNow();
  }, [refreshData, requestJson, runDiagnosticsNow]);

  const updateApproval = useCallback(
    async (id: number, action: "approve" | "deny") => {
      await requestJson(`/approvals/${id}/${action}`, { method: "POST" });
      await refreshData();
    },
    [refreshData, requestJson]
  );

  const runJob = useCallback(
    async (id: number) => {
      await requestJson(`/jobs/run/${id}`, { method: "POST" });
      await refreshData();
    },
    [refreshData, requestJson]
  );

  const toggleJob = useCallback(
    async (id: number, currentlyEnabled: boolean) => {
      await requestJson(`/jobs/${id}/${currentlyEnabled ? "disable" : "enable"}`, {
        method: "POST"
      });
      await refreshData();
    },
    [refreshData, requestJson]
  );

  const saveGmailToken = useCallback(
    async (token: string) => {
      await requestJson("/connectors/gmail/token", {
        method: "POST",
        body: JSON.stringify({ accessToken: token })
      });
      await refreshData();
    },
    [refreshData, requestJson]
  );

  const getGmailOauthStart = useCallback(async () => {
    return requestJson("/connectors/gmail/oauth/start");
  }, [requestJson]);

  useEffect(() => {
    let mounted = true;
    async function init() {
      setLoading(true);
      try {
        await refreshDaemonStatus();
        await refreshData();
        await runDiagnosticsNow();
        await loadChatHistory();
      } catch (error) {
        if (mounted) {
          setApiError(error instanceof Error ? error.message : "Failed to initialize");
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void init();
    const interval = setInterval(() => {
      void refreshDaemonStatus().then(() => refreshData());
    }, 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [loadChatHistory, refreshDaemonStatus, refreshData, runDiagnosticsNow]);

  const onboardingReady = useMemo(
    () => onboarding.completed,
    [onboarding]
  );

  const completeOnboarding = useCallback(() => {
    persistOnboarding({ ...onboarding, completed: true });
  }, [onboarding, persistOnboarding]);

  const pendingApprovals = useMemo(
    () => approvals.filter((item) => item.status === "pending"),
    [approvals]
  );

  return {
    apiBase,
    launchToken,
    daemonStatus,
    loading,
    apiError,
    approvals,
    jobs,
    jobRuns,
    audit,
    plugins,
    tools,
    diagnostics,
    messages,
    isSending,
    onboarding,
    onboardingReady,
    pendingApprovals,
    gmailStatus,
    persistOnboarding,
    completeOnboarding,
    sendMessage,
    runDiagnosticsNow,
    restartDaemon,
    runRepair,
    updateApproval,
    runJob,
    toggleJob,
    saveGmailToken,
    getGmailOauthStart,
    refreshData
  };
}
