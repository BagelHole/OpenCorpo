import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Approval,
  AuditEntry,
  Job,
  JobRun,
  PluginInfo,
  ToolInfo,
  DiagnosticsReport,
} from "@/lib/api";
import { OpenCorpoApi } from "@/lib/api";

export type OnboardingData = {
  completed: boolean;
  aiProvider: "anthropic" | "openai" | "local";
  aiKey: string;
  gmailAccessToken: string;
};

export type DaemonStatus = {
  running: boolean;
  ready: boolean;
  pid: number | null;
  port: number;
  apiBase: string;
  hasToken: boolean;
  lastError: string | null;
};

export type GmailStatus = {
  connected: boolean;
  tokenSource: string | null;
  refreshConfigured: boolean;
};

const ONBOARDING_KEY = "opencorpo_onboarding_v2";

function readOnboarding(): OnboardingData {
  try {
    const raw = localStorage.getItem(ONBOARDING_KEY);
    if (!raw) {
      return {
        completed: false,
        aiProvider: "anthropic",
        aiKey: "",
        gmailAccessToken: "",
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
      gmailAccessToken: parsed.gmailAccessToken ?? "",
    };
  } catch {
    return {
      completed: false,
      aiProvider: "anthropic",
      aiKey: "",
      gmailAccessToken: "",
    };
  }
}

type OpenCorpoContextValue = {
  apiBase: string;
  launchToken: string;
  daemonStatus: DaemonStatus;
  apiError: string | null;
  approvals: Approval[];
  jobs: Job[];
  jobRuns: JobRun[];
  audit: AuditEntry[];
  plugins: PluginInfo[];
  tools: ToolInfo[];
  diagnostics: DiagnosticsReport | null;
  onboarding: OnboardingData;
  gmailStatus: GmailStatus;
  pendingApprovals: Approval[];
  api: OpenCorpoApi | null;
  // Actions
  refreshData: () => Promise<void>;
  refreshDaemonStatus: () => Promise<DaemonStatus | null>;
  persistOnboarding: (next: OnboardingData) => void;
  completeOnboarding: () => void;
  saveGmailToken: (token: string) => Promise<void>;
  saveAiKey: (key: string) => Promise<void>;
  saveAiProvider: (provider: string) => Promise<void>;
  checkAiKeyConfigured: () => Promise<boolean>;
  getGmailOauthStart: () => Promise<{ ok: boolean; authUrl?: string; error?: string }>;
  updateApproval: (id: number, action: "approve" | "deny") => Promise<void>;
  runJob: (id: number) => Promise<void>;
  toggleJob: (id: number, enabled: boolean) => Promise<void>;
  runDiagnosticsNow: () => Promise<void>;
  runRepair: () => Promise<void>;
  restartDaemon: () => Promise<void>;
};

const OpenCorpoContext = createContext<OpenCorpoContextValue | null>(null);

export function OpenCorpoProvider({ children }: { children: ReactNode }) {
  const [apiBase, setApiBase] = useState("");
  const [launchToken, setLaunchToken] = useState("");
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus>({
    running: false,
    ready: false,
    port: 3555,
    pid: null,
    apiBase: "",
    hasToken: false,
    lastError: null,
  });
  const [apiError, setApiError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobRuns, setJobRuns] = useState<JobRun[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingData>(readOnboarding);
  const [gmailStatus, setGmailStatus] = useState<GmailStatus>({
    connected: false,
    tokenSource: null,
    refreshConfigured: false,
  });

  const tokenRef = useRef(launchToken);
  const apiRef = useRef<OpenCorpoApi | null>(null);
  tokenRef.current = launchToken;

  const api = useMemo(() => {
    const instance =
      launchToken
        ? new OpenCorpoApi(apiBase, () => tokenRef.current)
        : null;
    apiRef.current = instance;
    return instance;
  }, [apiBase, launchToken]);

  const refreshDaemonStatus = useCallback(async () => {
    if (!window.opencorpo?.daemon) {
      setApiError(
        "Electron bridge not available. Run from apps/desktop with npm run dev."
      );
      return null;
    }
    try {
      const runtime = await window.opencorpo.daemon.getRuntimeConfig();
      // `runtime.apiBase` can be intentionally empty in dev to use the Vite proxy.
      const base = runtime.apiBase ?? `http://127.0.0.1:3555`;
      setApiBase(base);
      setLaunchToken(runtime.launchToken);
      const status = await window.opencorpo.daemon.getStatus();
      setDaemonStatus({
        ...status,
        apiBase: status.apiBase || `http://127.0.0.1:3555`,
      });
      return status;
    } catch (e) {
      setApiError(e instanceof Error ? e.message : "Failed to get daemon status");
      return null;
    }
  }, []);

  const refreshData = useCallback(async () => {
    const currentApi = apiRef.current;
    if (!currentApi || !daemonStatus.ready) return;
    try {
      const [approvalsRes, jobsRes, runsRes, auditRes, pluginsRes, toolsRes, gmailRes] =
        await Promise.all([
          currentApi.listApprovals(),
          currentApi.listJobs(),
          currentApi.listJobRuns(),
          currentApi.listAudit(30),
          currentApi.listPlugins(),
          currentApi.listTools(),
          currentApi.getGmailStatus(),
        ]);

      if (approvalsRes.ok) setApprovals(approvalsRes.data.items ?? []);
      if (jobsRes.ok) setJobs(jobsRes.data.items ?? []);
      if (runsRes.ok) setJobRuns(runsRes.data.items ?? []);
      if (auditRes.ok) setAudit(auditRes.data.items ?? []);
      if (pluginsRes.ok) setPlugins(pluginsRes.data.items ?? []);
      if (toolsRes.ok) setTools(toolsRes.data.items ?? []);
      if (gmailRes.ok) {
        setGmailStatus({
          connected: gmailRes.data.connected,
          tokenSource: gmailRes.data.tokenSource,
          refreshConfigured: gmailRes.data.refreshConfigured,
        });
      }
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Failed to refresh");
    }
  }, [api, daemonStatus.ready]);

  const persistOnboarding = useCallback((next: OnboardingData) => {
    setOnboarding(next);
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify(next));
  }, []);

  const completeOnboarding = useCallback(() => {
    persistOnboarding({ ...onboarding, completed: true });
  }, [onboarding, persistOnboarding]);

  const saveGmailToken = useCallback(
    async (token: string) => {
      if (!api) throw new Error("API client is not ready yet. Please try again.");
      const res = await api.saveGmailToken(token);
      if (!res.ok) throw new Error(res.error);
      await refreshData();
    },
    [api, refreshData]
  );

  const saveAiKey = useCallback(
    async (key: string) => {
      if (!api) throw new Error("API client is not ready yet. Please try again.");
      const res = await api.saveAiKey(key, onboarding.aiProvider);
      if (!res.ok) throw new Error(res.error);
      if (window.opencorpo?.daemon) {
        await window.opencorpo.daemon.restart();
        await refreshDaemonStatus();
      }
    },
    [api, onboarding.aiProvider, refreshDaemonStatus]
  );

  const saveAiProvider = useCallback(
    async (provider: string) => {
      if (!api) throw new Error("API client is not ready yet. Please try again.");
      const res = await api.saveAiProvider(provider);
      if (!res.ok) throw new Error(res.error);
    },
    [api]
  );

  const checkAiKeyConfigured = useCallback(async () => {
    if (!api) return false;
    const res = await api.getAiKeyStatus();
    return res.ok && res.data.configured;
  }, [api]);

  const getGmailOauthStart = useCallback(async () => {
    if (!api) return { ok: false, error: "API client is not ready yet. Please try again." };
    const res = await api.getGmailOauthStart();
    return res.ok ? res.data : { ok: false, error: res.error };
  }, [api]);

  const updateApproval = useCallback(
    async (id: number, action: "approve" | "deny") => {
      if (!api) return;
      if (action === "approve") await api.approve(id);
      else await api.deny(id);
      await refreshData();
    },
    [api, refreshData]
  );

  const runJob = useCallback(
    async (id: number) => {
      if (!api) return;
      await api.runJob(id);
      await refreshData();
    },
    [api, refreshData]
  );

  const toggleJob = useCallback(
    async (id: number, enabled: boolean) => {
      if (!api) return;
      if (enabled) await api.disableJob(id);
      else await api.enableJob(id);
      await refreshData();
    },
    [api, refreshData]
  );

  const runDiagnosticsNow = useCallback(async () => {
    if (!api) return;
    const res = await api.runDiagnostics();
    if (res.ok) setDiagnostics(res.data.report ?? null);
    else setApiError(res.error);
  }, [api]);

  const runRepair = useCallback(async () => {
    if (!api) return;
    await api.runRepair();
    await refreshData();
    await runDiagnosticsNow();
  }, [api, refreshData, runDiagnosticsNow]);

  const restartDaemon = useCallback(async () => {
    if (!window.opencorpo?.daemon) return;
    await window.opencorpo.daemon.restart();
    await refreshDaemonStatus();
    await refreshData();
  }, [refreshDaemonStatus, refreshData]);

  useEffect(() => {
    let mounted = true;
    async function init() {
      const status = await refreshDaemonStatus();
      if (mounted && status?.ready) {
        await refreshData();
        await runDiagnosticsNow();
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
  }, [refreshDaemonStatus, refreshData, runDiagnosticsNow]);

  const pendingApprovals = useMemo(
    () => approvals.filter((a) => a.status === "pending"),
    [approvals]
  );

  const value = useMemo<OpenCorpoContextValue>(
    () => ({
      apiBase,
      launchToken,
      daemonStatus,
      apiError,
      approvals,
      jobs,
      jobRuns,
      audit,
      plugins,
      tools,
      diagnostics,
      onboarding,
      gmailStatus,
      pendingApprovals,
      api,
      refreshData,
      refreshDaemonStatus,
      persistOnboarding,
      completeOnboarding,
      saveGmailToken,
      saveAiKey,
      saveAiProvider,
      checkAiKeyConfigured,
      getGmailOauthStart,
      updateApproval,
      runJob,
      toggleJob,
      runDiagnosticsNow,
      runRepair,
      restartDaemon,
    }),
    [
      apiBase,
      launchToken,
      daemonStatus,
      apiError,
      approvals,
      jobs,
      jobRuns,
      audit,
      plugins,
      tools,
      diagnostics,
      onboarding,
      gmailStatus,
      pendingApprovals,
      api,
      refreshData,
      refreshDaemonStatus,
      persistOnboarding,
      completeOnboarding,
      saveGmailToken,
      saveAiKey,
      saveAiProvider,
      checkAiKeyConfigured,
      getGmailOauthStart,
      updateApproval,
      runJob,
      toggleJob,
      runDiagnosticsNow,
      runRepair,
      restartDaemon,
    ]
  );

  return (
    <OpenCorpoContext.Provider value={value}>
      {children}
    </OpenCorpoContext.Provider>
  );
}

export function useOpenCorpo() {
  const ctx = useContext(OpenCorpoContext);
  if (!ctx) throw new Error("useOpenCorpo must be used within OpenCorpoProvider");
  return ctx;
}
