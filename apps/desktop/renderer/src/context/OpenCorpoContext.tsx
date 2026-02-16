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
  AiProviderCatalog,
  Approval,
  AuditEntry,
  Job,
  JobRun,
  PluginInfo,
  ToolInfo,
  DiagnosticsReport,
  UiConfig,
} from "@/lib/api";
import { OpenCorpoApi } from "@/lib/api";

export type OnboardingData = {
  completed: boolean;
  aiProvider: "anthropic" | "openai" | "local";
  aiKey: string;
  gmailAccessToken: string;
  profile: UserProfile;
};

export type UserProfile = {
  name: string;
  role: string;
  jobTitle: string;
  about: string;
};

export type AiModelDefaults = {
  anthropic: string;
  openai: string;
  local: string;
};

export type ChatSessionMetadata = {
  emoji?: string;
  color?: string;
  order?: number;
  provider?: "anthropic" | "openai" | "local";
  model?: string;
};

export type ChatSessionRecord = {
  id: number;
  title: string;
  metadata: ChatSessionMetadata;
};

export type ChatMessageRecord = {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
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

const EMPTY_AI_PROVIDER_CATALOG: AiProviderCatalog = {
  defaultProvider: null,
  providers: [],
};

const ONBOARDING_KEY = "opencorpo_onboarding_v2";
const ACTIVE_CHAT_SESSION_KEY = "opencorpo_active_chat_session";
const CHAT_SESSIONS_CACHE_KEY = "opencorpo_chat_sessions_cache_v1";
const CHAT_MESSAGES_CACHE_KEY = "opencorpo_chat_messages_cache_v1";

const DEFAULT_UI_CONFIG: UiConfig = {
  name: "fallback",
  sidebar: {
    collapsible: true,
    defaultCollapsed: false,
    items: [
      { id: "chat", label: "Chat", path: "/", pageId: "chat" },
      { id: "jobs", label: "Jobs", path: "/jobs", pageId: "jobs" },
      { id: "settings", label: "Settings", path: "/settings", pageId: "settings" },
      {
        id: "audit",
        label: "Audit",
        path: "/audit",
        pageId: "audit",
        showWhen: "advanced",
      },
    ],
  },
  pages: [
    { id: "chat", kind: "builtin", builtin: "chat" },
    { id: "jobs", kind: "builtin", builtin: "jobs" },
    { id: "settings", kind: "builtin", builtin: "settings" },
    { id: "audit", kind: "builtin", builtin: "audit" },
  ],
};

function isValidUiConfig(value: unknown): value is UiConfig {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string") return false;
  if (!row.sidebar || typeof row.sidebar !== "object") return false;
  if (!Array.isArray(row.pages)) return false;
  const sidebar = row.sidebar as Record<string, unknown>;
  if (!Array.isArray(sidebar.items)) return false;
  return true;
}

function writeOnboarding(next: OnboardingData) {
  localStorage.setItem(ONBOARDING_KEY, JSON.stringify(next));
}

function readStoredActiveSessionId() {
  try {
    const raw = localStorage.getItem(ACTIVE_CHAT_SESSION_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeChatSessionsCache(next: ChatSessionRecord[]) {
  try {
    localStorage.setItem(CHAT_SESSIONS_CACHE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage write errors
  }
}

function readChatSessionsCache(): ChatSessionRecord[] {
  try {
    const raw = localStorage.getItem(CHAT_SESSIONS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): ChatSessionRecord | null => {
        if (!entry || typeof entry !== "object") return null;
        const row = entry as Record<string, unknown>;
        const id = Number(row.id);
        if (!Number.isFinite(id)) return null;
        const title = typeof row.title === "string" && row.title.trim() ? row.title : `Conversation ${id}`;
        const metadataRaw =
          row.metadata && typeof row.metadata === "object"
            ? (row.metadata as Record<string, unknown>)
            : {};
        const providerRaw = metadataRaw.provider;
        const provider =
          providerRaw === "anthropic" || providerRaw === "openai" || providerRaw === "local"
            ? providerRaw
            : undefined;
        const orderRaw = metadataRaw.order;
        const order =
          typeof orderRaw === "number" && Number.isFinite(orderRaw) ? Number(orderRaw) : undefined;
        return {
          id,
          title,
          metadata: {
            emoji: typeof metadataRaw.emoji === "string" ? metadataRaw.emoji : undefined,
            color: typeof metadataRaw.color === "string" ? metadataRaw.color : undefined,
            provider,
            model: typeof metadataRaw.model === "string" ? metadataRaw.model : undefined,
            order,
          },
        };
      })
      .filter((item): item is ChatSessionRecord => Boolean(item));
  } catch {
    return [];
  }
}

function writeChatMessagesCache(next: Record<number, ChatMessageRecord[]>) {
  try {
    localStorage.setItem(CHAT_MESSAGES_CACHE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage write errors
  }
}

function readChatMessagesCache(): Record<number, ChatMessageRecord[]> {
  try {
    const raw = localStorage.getItem(CHAT_MESSAGES_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<number, ChatMessageRecord[]> = {};
    for (const [sessionIdRaw, messagesRaw] of Object.entries(parsed)) {
      const sessionId = Number(sessionIdRaw);
      if (!Number.isFinite(sessionId) || !Array.isArray(messagesRaw)) continue;
      out[sessionId] = messagesRaw
        .map((msg): ChatMessageRecord | null => {
          if (!msg || typeof msg !== "object") return null;
          const row = msg as Record<string, unknown>;
          const id = Number(row.id);
          if (!Number.isFinite(id)) return null;
          const roleRaw = row.role;
          const role =
            roleRaw === "assistant" || roleRaw === "system" || roleRaw === "user"
              ? roleRaw
              : "user";
          return {
            id,
            role,
            content: typeof row.content === "string" ? row.content : "",
            ts: typeof row.ts === "string" ? row.ts : "",
          };
        })
        .filter((item): item is ChatMessageRecord => Boolean(item));
    }
    return out;
  } catch {
    return {};
  }
}

function readOnboarding(): OnboardingData {
  try {
    const raw = localStorage.getItem(ONBOARDING_KEY);
    if (!raw) {
      return {
        completed: false,
        aiProvider: "anthropic",
        aiKey: "",
        gmailAccessToken: "",
        profile: {
          name: "",
          role: "",
          jobTitle: "",
          about: "",
        },
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
      profile: {
        name: parsed.profile?.name ?? "",
        role: parsed.profile?.role ?? "",
        jobTitle: parsed.profile?.jobTitle ?? "",
        about: parsed.profile?.about ?? "",
      },
    };
  } catch {
    return {
      completed: false,
      aiProvider: "anthropic",
      aiKey: "",
      gmailAccessToken: "",
      profile: {
        name: "",
        role: "",
        jobTitle: "",
        about: "",
      },
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
  profile: UserProfile;
  aiModelDefaults: AiModelDefaults;
  gmailStatus: GmailStatus;
  aiProviderCatalog: AiProviderCatalog;
  uiConfig: UiConfig;
  pendingApprovals: Approval[];
  chatSessions: ChatSessionRecord[];
  activeChatSessionId: number | null;
  chatMessages: ChatMessageRecord[];
  chatLoading: boolean;
  chatError: string | null;
  api: OpenCorpoApi | null;
  // Actions
  refreshData: () => Promise<void>;
  refreshDaemonStatus: () => Promise<DaemonStatus | null>;
  persistOnboarding: (next: OnboardingData) => void;
  completeOnboarding: () => void;
  saveProfile: (profile: UserProfile) => Promise<void>;
  saveAiModelDefaults: (defaults: AiModelDefaults) => Promise<void>;
  refreshChatSessions: () => Promise<void>;
  createChatSession: (input?: {
    title?: string;
    metadata?: ChatSessionMetadata;
  }) => Promise<number | null>;
  updateChatSession: (
    sessionId: number,
    input: { title?: string | null; metadata?: ChatSessionMetadata | null }
  ) => Promise<void>;
  deleteChatSession: (sessionId: number) => Promise<void>;
  reorderChatSessions: (orderedSessionIds: number[]) => Promise<void>;
  selectChatSession: (sessionId: number) => Promise<void>;
  sendChatMessage: (content: string) => Promise<void>;
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
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    role: "",
    jobTitle: "",
    about: "",
  });
  const [aiModelDefaults, setAiModelDefaults] = useState<AiModelDefaults>({
    anthropic: "",
    openai: "",
    local: "",
  });
  const [gmailStatus, setGmailStatus] = useState<GmailStatus>({
    connected: false,
    tokenSource: null,
    refreshConfigured: false,
  });
  const [aiProviderCatalog, setAiProviderCatalog] = useState<AiProviderCatalog>(
    EMPTY_AI_PROVIDER_CATALOG
  );
  const [uiConfig, setUiConfig] = useState<UiConfig>(DEFAULT_UI_CONFIG);
  const [chatSessions, setChatSessions] = useState<ChatSessionRecord[]>(readChatSessionsCache);
  const [activeChatSessionId, setActiveChatSessionId] = useState<number | null>(
    readStoredActiveSessionId
  );
  const [chatMessagesBySession, setChatMessagesBySession] = useState<
    Record<number, ChatMessageRecord[]>
  >(readChatMessagesCache);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const tokenRef = useRef(launchToken);
  const apiRef = useRef<OpenCorpoApi | null>(null);
  const activeChatSessionIdRef = useRef<number | null>(null);
  const chatMessagesBySessionRef = useRef<Record<number, ChatMessageRecord[]>>({});
  tokenRef.current = launchToken;

  useEffect(() => {
    activeChatSessionIdRef.current = activeChatSessionId;
  }, [activeChatSessionId]);

  useEffect(() => {
    chatMessagesBySessionRef.current = chatMessagesBySession;
  }, [chatMessagesBySession]);

  useEffect(() => {
    writeChatSessionsCache(chatSessions);
  }, [chatSessions]);

  useEffect(() => {
    writeChatMessagesCache(chatMessagesBySession);
  }, [chatMessagesBySession]);

  const api = useMemo(() => {
    const instance =
      launchToken
        ? new OpenCorpoApi(apiBase, () => tokenRef.current)
        : null;
    apiRef.current = instance;
    return instance;
  }, [apiBase, launchToken]);

  const readStoredActiveSession = useCallback(() => {
    return readStoredActiveSessionId();
  }, []);

  const persistActiveSession = useCallback((sessionId: number | null) => {
    try {
      if (sessionId === null) {
        localStorage.removeItem(ACTIVE_CHAT_SESSION_KEY);
      } else {
        localStorage.setItem(ACTIVE_CHAT_SESSION_KEY, String(sessionId));
      }
    } catch {
      // ignore storage write errors
    }
  }, []);

  const mapSessionRow = useCallback((row: {
    id: number;
    title?: string;
    metadata?: Record<string, unknown> | null;
  }): ChatSessionRecord => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const providerRaw =
      typeof metadata.provider === "string" ? metadata.provider : undefined;
    const provider =
      providerRaw === "anthropic" || providerRaw === "openai" || providerRaw === "local"
        ? providerRaw
        : undefined;
    const orderRaw = metadata.order;
    const order =
      typeof orderRaw === "number" && Number.isFinite(orderRaw) ? Number(orderRaw) : undefined;
    return {
      id: row.id,
      title:
        (typeof row.title === "string" && row.title.trim()) ||
        `Conversation ${row.id}`,
      metadata: {
        emoji: typeof metadata.emoji === "string" ? metadata.emoji : undefined,
        color: typeof metadata.color === "string" ? metadata.color : undefined,
        order,
        provider,
        model: typeof metadata.model === "string" ? metadata.model : undefined,
      },
    };
  }, []);

  const loadProfileAndModels = useCallback(async (client: OpenCorpoApi) => {
    const [profileRes, modelRes, providerRes] = await Promise.all([
      client.getProfile(),
      client.getAiModelDefaults(),
      client.getAiProviderCatalog(),
    ]);
    if (profileRes.ok) {
      setProfile(profileRes.data.profile);
      setOnboarding((current) => {
        const next = {
          ...current,
          profile: profileRes.data.profile,
        };
        writeOnboarding(next);
        return next;
      });
    }
    if (modelRes.ok) {
      setAiModelDefaults(modelRes.data.defaults);
    }
    if (providerRes.ok) {
      setAiProviderCatalog(providerRes.data);
    }
  }, []);

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
      const [approvalsRes, jobsRes, runsRes, auditRes, pluginsRes, toolsRes, gmailRes, uiRes] =
        await Promise.all([
          currentApi.listApprovals(),
          currentApi.listJobs(),
          currentApi.listJobRuns(),
          currentApi.listAudit(30),
          currentApi.listPlugins(),
          currentApi.listTools(),
          currentApi.getGmailStatus(),
          currentApi.getUiConfig(),
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
      if (uiRes.ok && isValidUiConfig(uiRes.data.config)) {
        setUiConfig(uiRes.data.config);
      }
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Failed to refresh");
    }
  }, [api, daemonStatus.ready]);

  const selectChatSession = useCallback(
    async (sessionId: number) => {
      const currentApi = apiRef.current;
      if (!currentApi || !daemonStatus.ready) return;
      setActiveChatSessionId(sessionId);
      persistActiveSession(sessionId);
      if (chatMessagesBySessionRef.current[sessionId]) return;
      const messagesRes = await currentApi.listMessages(sessionId);
      if (!messagesRes.ok) {
        setChatError(messagesRes.error);
        return;
      }
      setChatMessagesBySession((current) => ({
        ...current,
        [sessionId]: messagesRes.data.items.map((msg) => ({
          id: msg.id,
          role:
            msg.role === "assistant" || msg.role === "system" ? msg.role : "user",
          content: msg.content,
          ts: msg.ts,
        })),
      }));
      setChatError(null);
    },
    [daemonStatus.ready, persistActiveSession]
  );

  const refreshChatSessions = useCallback(async () => {
    const currentApi = apiRef.current;
    if (!currentApi || !daemonStatus.ready) return;
    setChatLoading(true);
    const sessionsRes = await currentApi.listSessions();
    if (!sessionsRes.ok) {
      setChatError(sessionsRes.error);
      setChatLoading(false);
      return;
    }
    let sessions = sessionsRes.data.items.map((item) => mapSessionRow(item));
    if (sessions.length === 0) {
      const created = await currentApi.createChatSession("New conversation", {
        emoji: "💬",
        color: "slate",
      });
      if (created.ok) {
        const reread = await currentApi.listSessions();
        if (reread.ok) {
          sessions = reread.data.items.map((item) => mapSessionRow(item));
        }
      }
    }
    setChatSessions(sessions);
    const preferredSessionId = readStoredActiveSession();
    const currentActive = activeChatSessionIdRef.current;
    const activeCandidate =
      currentActive && sessions.some((s) => s.id === currentActive)
        ? currentActive
        : preferredSessionId && sessions.some((s) => s.id === preferredSessionId)
          ? preferredSessionId
          : sessions[0]?.id ?? null;
    if (activeCandidate !== null) {
      await selectChatSession(activeCandidate);
    } else {
      setActiveChatSessionId(null);
      persistActiveSession(null);
    }
    setChatLoading(false);
    setChatError(null);
  }, [
    daemonStatus.ready,
    mapSessionRow,
    persistActiveSession,
    readStoredActiveSession,
    selectChatSession,
  ]);

  const createChatSession = useCallback(
    async (input?: { title?: string; metadata?: ChatSessionMetadata }) => {
      const currentApi = apiRef.current;
      if (!currentApi || !daemonStatus.ready) return null;
      const created = await currentApi.createChatSession(
        input?.title ?? "New conversation",
        input?.metadata
      );
      if (!created.ok) {
        setChatError(created.error);
        return null;
      }
      await refreshChatSessions();
      const nextId = created.data.id;
      await selectChatSession(nextId);
      return nextId;
    },
    [daemonStatus.ready, refreshChatSessions, selectChatSession]
  );

  const updateChatSession = useCallback(
    async (
      sessionId: number,
      input: { title?: string | null; metadata?: ChatSessionMetadata | null }
    ) => {
      const currentApi = apiRef.current;
      if (!currentApi || !daemonStatus.ready) return;
      const result = await currentApi.updateChatSession(sessionId, input);
      if (!result.ok) {
        setChatError(result.error);
        return;
      }
      setChatSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? mapSessionRow(result.data.item) : session
        )
      );
      setChatError(null);
    },
    [daemonStatus.ready, mapSessionRow]
  );

  const deleteChatSession = useCallback(
    async (sessionId: number) => {
      let currentApi = apiRef.current;
      if (!currentApi || !daemonStatus.ready) return;
      let result = await currentApi.deleteChatSession(sessionId);
      if (!result.ok && result.error.includes("(404)") && window.opencorpo?.daemon) {
        await window.opencorpo.daemon.restart();
        await refreshDaemonStatus();
        currentApi = apiRef.current;
        if (currentApi) {
          result = await currentApi.deleteChatSession(sessionId);
        }
      }
      if (!result.ok) {
        setChatError(result.error);
        return;
      }
      let remainingSessions: ChatSessionRecord[] = [];
      setChatSessions((current) => {
        remainingSessions = current.filter((session) => session.id !== sessionId);
        return remainingSessions;
      });
      setChatMessagesBySession((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      if (activeChatSessionIdRef.current === sessionId) {
        const fallbackSessionId = remainingSessions[0]?.id ?? null;
        if (fallbackSessionId !== null) {
          await selectChatSession(fallbackSessionId);
        } else {
          setActiveChatSessionId(null);
          persistActiveSession(null);
        }
      }
      setChatError(null);
    },
    [daemonStatus.ready, persistActiveSession, refreshDaemonStatus, selectChatSession]
  );

  const reorderChatSessions = useCallback(
    async (orderedSessionIds: number[]) => {
      const currentApi = apiRef.current;
      if (!currentApi || !daemonStatus.ready) return;
      if (orderedSessionIds.length !== chatSessions.length) return;
      const byId = new Map(chatSessions.map((session) => [session.id, session] as const));
      const reordered = orderedSessionIds
        .map((sessionId) => byId.get(sessionId))
        .filter((session): session is ChatSessionRecord => Boolean(session));
      if (reordered.length !== chatSessions.length) return;
      const withOrder = reordered.map((session, index) => ({
        ...session,
        metadata: { ...session.metadata, order: index },
      }));
      setChatSessions(withOrder);
      const results = await Promise.all(
        withOrder.map((session, index) =>
          currentApi.updateChatSession(session.id, {
            title: session.title,
            metadata: { ...session.metadata, order: index },
          })
        )
      );
      const failed = results.find((result) => !result.ok);
      if (failed && !failed.ok) {
        setChatError(failed.error);
        await refreshChatSessions();
        return;
      }
      setChatError(null);
    },
    [chatSessions, daemonStatus.ready, refreshChatSessions]
  );

  const sendChatMessage = useCallback(
    async (content: string) => {
      const currentApi = apiRef.current;
      if (!currentApi || !daemonStatus.ready || !activeChatSessionId) return;
      const text = content.trim();
      if (!text) return;
      const activeSession = chatSessions.find((session) => session.id === activeChatSessionId);
      const optimisticMessageId = -Date.now();
      setChatMessagesBySession((current) => ({
        ...current,
        [activeChatSessionId]: [
          ...(current[activeChatSessionId] ?? []),
          {
            id: optimisticMessageId,
            role: "user",
            content: text,
            ts: new Date().toISOString(),
          },
        ],
      }));
      const sendRes = await currentApi.sendMessage(activeChatSessionId, text, {
        provider: activeSession?.metadata.provider,
        model: activeSession?.metadata.model,
      });
      if (!sendRes.ok) {
        setChatMessagesBySession((current) => ({
          ...current,
          [activeChatSessionId]: (current[activeChatSessionId] ?? []).filter(
            (message) => message.id !== optimisticMessageId
          ),
        }));
        setChatError(sendRes.error);
        return;
      }
      const messagesRes = await currentApi.listMessages(activeChatSessionId);
      if (!messagesRes.ok) {
        setChatMessagesBySession((current) => ({
          ...current,
          [activeChatSessionId]: (current[activeChatSessionId] ?? []).map((message) =>
            message.id === optimisticMessageId
              ? { ...message, id: sendRes.data.messageId }
              : message
          ),
        }));
        setChatError(messagesRes.error);
        return;
      }
      setChatMessagesBySession((current) => ({
        ...current,
        [activeChatSessionId]: messagesRes.data.items.map((msg) => ({
          id: msg.id,
          role:
            msg.role === "assistant" || msg.role === "system" ? msg.role : "user",
          content: msg.content,
          ts: msg.ts,
        })),
      }));
      if (!activeSession?.title || activeSession.title === "New conversation") {
        const autoTitle = text.slice(0, 48);
        await updateChatSession(activeChatSessionId, {
          title: autoTitle,
          metadata: activeSession?.metadata ?? null,
        });
      }
      setChatError(null);
    },
    [
      activeChatSessionId,
      chatSessions,
      daemonStatus.ready,
      updateChatSession,
    ]
  );

  const persistOnboarding = useCallback((next: OnboardingData) => {
    setOnboarding(next);
    writeOnboarding(next);
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
      const providerRes = await api.getAiProviderCatalog();
      if (providerRes.ok) setAiProviderCatalog(providerRes.data);
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
      const providerRes = await api.getAiProviderCatalog();
      if (providerRes.ok) setAiProviderCatalog(providerRes.data);
    },
    [api]
  );

  const saveProfile = useCallback(
    async (nextProfile: UserProfile) => {
      if (!api) throw new Error("API client is not ready yet. Please try again.");
      const res = await api.saveProfile(nextProfile);
      if (!res.ok) throw new Error(res.error);
      setProfile(res.data.profile);
      setOnboarding((current) => {
        const next = {
          ...current,
          profile: res.data.profile,
        };
        writeOnboarding(next);
        return next;
      });
    },
    [api]
  );

  const saveAiModelDefaults = useCallback(
    async (defaults: AiModelDefaults) => {
      if (!api) throw new Error("API client is not ready yet. Please try again.");
      const res = await api.saveAiModelDefaults(defaults);
      if (!res.ok) throw new Error(res.error);
      setAiModelDefaults(res.data.defaults);
      const providerRes = await api.getAiProviderCatalog();
      if (providerRes.ok) setAiProviderCatalog(providerRes.data);
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

  useEffect(() => {
    if (!api || !daemonStatus.ready) return;
    void loadProfileAndModels(api);
    void refreshChatSessions();
  }, [api, daemonStatus.ready, loadProfileAndModels, refreshChatSessions]);

  const pendingApprovals = useMemo(
    () => approvals.filter((a) => a.status === "pending"),
    [approvals]
  );
  const chatMessages = useMemo(
    () => (activeChatSessionId ? chatMessagesBySession[activeChatSessionId] ?? [] : []),
    [activeChatSessionId, chatMessagesBySession]
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
      profile,
      aiModelDefaults,
      gmailStatus,
      aiProviderCatalog,
      uiConfig,
      pendingApprovals,
      chatSessions,
      activeChatSessionId,
      chatMessages,
      chatLoading,
      chatError,
      api,
      refreshData,
      refreshDaemonStatus,
      persistOnboarding,
      completeOnboarding,
      saveProfile,
      saveAiModelDefaults,
      refreshChatSessions,
      createChatSession,
      updateChatSession,
      deleteChatSession,
      reorderChatSessions,
      selectChatSession,
      sendChatMessage,
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
      profile,
      aiModelDefaults,
      gmailStatus,
      aiProviderCatalog,
      uiConfig,
      pendingApprovals,
      chatSessions,
      activeChatSessionId,
      chatMessages,
      chatLoading,
      chatError,
      api,
      refreshData,
      refreshDaemonStatus,
      persistOnboarding,
      completeOnboarding,
      saveProfile,
      saveAiModelDefaults,
      refreshChatSessions,
      createChatSession,
      updateChatSession,
      deleteChatSession,
      reorderChatSessions,
      selectChatSession,
      sendChatMessage,
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
      chatMessagesBySession,
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
