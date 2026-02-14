/**
 * OpenCorpo API client - single source of truth for all daemon HTTP calls.
 * Handles auth, base URL, and consistent error handling.
 */

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

export class OpenCorpoApi {
  constructor(
    private baseUrl: string,
    private getToken: () => string
  ) {}

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const headers: HeadersInit = {
      Authorization: `Bearer ${this.getToken()}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    };

    try {
      const res = await fetch(url, { ...options, headers });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        return {
          ok: false,
          error: (data as { error?: string }).error ?? `Request failed (${res.status})`,
        };
      }
      return { ok: true, data: data as T };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  async get<T>(path: string) {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  // Auth
  async createAuthSession(actor = "desktop", ttlSeconds = 28800) {
    return this.post<{ ok: boolean; token: string; expiresAt: string }>("/auth/session", {
      actor,
      ttlSeconds,
    });
  }

  // Chat
  async listSessions() {
    return this.get<{ items: Array<{ id: number; title?: string }> }>("/chat/sessions");
  }

  async createChatSession(title?: string) {
    return this.post<{ id: number }>("/chat/sessions", { title });
  }

  async listMessages(sessionId: number) {
    return this.get<{ items: Array<{ id: number; role: string; content: string }> }>(
      `/chat/messages?sessionId=${sessionId}`
    );
  }

  async sendMessage(sessionId: number, content: string, skipAgent = false) {
    return this.post<{ messageId: number; assistantMessageId?: number; reply?: string }>(
      "/chat/messages",
      { sessionId, role: "user", content, skipAgent }
    );
  }

  // Approvals
  async listApprovals() {
    return this.get<{ items: Array<Approval> }>("/approvals");
  }

  async approve(id: number) {
    return this.post<{ ok: boolean }>(`/approvals/${id}/approve`);
  }

  async deny(id: number) {
    return this.post<{ ok: boolean }>(`/approvals/${id}/deny`);
  }

  // Jobs
  async listJobs() {
    return this.get<{ items: Job[] }>("/jobs");
  }

  async listJobRuns() {
    return this.get<{ items: JobRun[] }>("/jobs/runs");
  }

  async runJob(id: number) {
    return this.post<{ jobRunId: number }>(`/jobs/run/${id}`);
  }

  async enableJob(id: number) {
    return this.post<{ ok: boolean }>(`/jobs/${id}/enable`);
  }

  async disableJob(id: number) {
    return this.post<{ ok: boolean }>(`/jobs/${id}/disable`);
  }

  // Audit
  async listAudit(limit = 30) {
    return this.get<{ items: AuditEntry[] }>(`/audit?limit=${limit}`);
  }

  // Plugins & Tools
  async listPlugins() {
    return this.get<{ items: PluginInfo[] }>("/plugins");
  }

  async listTools() {
    return this.get<{ items: ToolInfo[] }>("/tools");
  }

  // Connectors
  async getGmailStatus() {
    return this.get<{
      connected: boolean;
      tokenSource: string | null;
      refreshConfigured: boolean;
    }>("/connectors/gmail/status");
  }

  async saveGmailToken(accessToken: string, refreshToken?: string) {
    return this.post<{ ok: boolean }>("/connectors/gmail/token", {
      accessToken,
      refreshToken,
    });
  }

  async getGmailOauthStart() {
    return this.get<{ ok: boolean; authUrl?: string; error?: string }>(
      "/connectors/gmail/oauth/start"
    );
  }

  // Secrets / AI
  async getAiKeyStatus() {
    return this.get<{ configured: boolean; provider: string | null }>(
      "/secrets/ai-key/status"
    );
  }

  async saveAiKey(value: string, provider: string) {
    return this.post<{ ok: boolean }>("/secrets/ai-key", { value, provider });
  }

  async saveAiProvider(provider: string) {
    return this.post<{ ok: boolean }>("/secrets/ai-provider", { provider });
  }

  // Diagnostics
  async runDiagnostics() {
    return this.get<{ report: DiagnosticsReport }>("/diagnostics");
  }

  async runRepair() {
    return this.post<{ ok: boolean; repaired: string[] }>("/diagnostics/repair");
  }

  // Health
  async health() {
    return this.get<{ ok: boolean }>("/health");
  }

  // Chat stream URL (for useChat)
  getChatStreamUrl() {
    return `${this.baseUrl.replace(/\/$/, "")}/chat/stream`;
  }
}

// Types
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

export type DiagnosticsReport = {
  status: "ok" | "warn";
  generatedAt: string;
  checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  recommendations: string[];
};
