/**
 * OpenCorpo API client - single source of truth for all daemon HTTP calls.
 * Handles auth, base URL, and consistent error handling.
 */

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

export type AiProviderCatalog = {
  defaultProvider: string | null;
  providers: Array<{
    id: string;
    label: string;
    defaultModel: string;
    models: string[];
  }>;
};

export type ScriptSecretItem = {
  name: string;
  ref: string;
  provider: string;
  updatedAt: string;
  description: string;
};

export type ScriptExecutionMode = "safe" | "trusted";

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

  async delete<T>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
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
    return this.get<{
      items: Array<{
        id: number;
        ts: string;
        title?: string;
        metadata?: Record<string, unknown> | null;
      }>;
    }>("/chat/sessions");
  }

  async createChatSession(title?: string, metadata?: Record<string, unknown>) {
    return this.post<{ id: number }>("/chat/sessions", { title, metadata });
  }

  async updateChatSession(
    sessionId: number,
    input: { title?: string | null; metadata?: Record<string, unknown> | null }
  ) {
    return this.post<{ item: { id: number; title?: string; metadata?: Record<string, unknown> | null } }>(
      `/chat/sessions/${sessionId}`,
      input
    );
  }

  async deleteChatSession(sessionId: number) {
    const primary = await this.post<{ ok: boolean }>(`/chat/sessions/${sessionId}/delete`);
    if (primary.ok || !primary.error.includes("(404)")) return primary;
    return this.delete<{ ok: boolean }>(`/chat/sessions/${sessionId}`);
  }

  async listMessages(sessionId: number) {
    return this.get<{
      items: Array<{
        id: number;
        role: string;
        content: string;
        ts: string;
        metadata?: Record<string, unknown> | null;
      }>;
    }>(
      `/chat/messages?sessionId=${sessionId}`
    );
  }

  async sendMessage(
    sessionId: number,
    content: string,
    options?: { skipAgent?: boolean; model?: string; provider?: string; requestId?: string }
  ) {
    return this.post<{ messageId: number; assistantMessageId?: number; reply?: string }>(
      "/chat/messages",
      {
        sessionId,
        role: "user",
        content,
        skipAgent: options?.skipAgent === true,
        model: options?.model,
        provider: options?.provider,
        requestId: options?.requestId
      }
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

  async getUiConfig() {
    return this.get<{ config: UiConfig }>("/ui/config");
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

  async getAiProviderCatalog() {
    return this.get<AiProviderCatalog>("/secrets/ai/providers");
  }

  async getProfile() {
    return this.get<{
      profile: { name: string; role: string; jobTitle: string; about: string };
    }>("/profile");
  }

  async saveProfile(profile: {
    name: string;
    role: string;
    jobTitle: string;
    about: string;
  }) {
    return this.post<{
      ok: boolean;
      profile: { name: string; role: string; jobTitle: string; about: string };
    }>("/profile", profile);
  }

  async getAiModelDefaults() {
    return this.get<{
      defaults: { anthropic: string; openai: string; local: string };
    }>("/secrets/ai-model-defaults");
  }

  async saveAiModelDefaults(defaults: {
    anthropic: string;
    openai: string;
    local: string;
  }) {
    return this.post<{
      ok: boolean;
      defaults: { anthropic: string; openai: string; local: string };
    }>("/secrets/ai-model-defaults", defaults);
  }

  async getScriptSecrets() {
    return this.get<{ items: ScriptSecretItem[] }>("/secrets/script");
  }

  async saveScriptSecret(input: { name: string; value: string; description?: string }) {
    return this.post<{
      ok: boolean;
      item: { name: string; ref: string; description: string };
    }>("/secrets/script", input);
  }

  async getScriptExecutionMode() {
    return this.get<{ mode: ScriptExecutionMode }>("/settings/script-execution-mode");
  }

  async saveScriptExecutionMode(mode: ScriptExecutionMode) {
    return this.post<{ ok: boolean; mode: ScriptExecutionMode }>(
      "/settings/script-execution-mode",
      { mode }
    );
  }

  async resolveWidgetProps(input: { props: Record<string, unknown> }) {
    return this.post<{
      ok: boolean;
      props: Record<string, unknown>;
      resolvedSecrets: string[];
    }>("/widgets/resolve-props", input);
  }

  async createTerminalSession(input: { command: string; cwd?: string; allowInput?: boolean }) {
    return this.post<{
      ok: boolean;
      sessionId: string;
      createdAt: string;
    }>("/terminal/sessions", input);
  }

  async getTerminalSessionEvents(sessionId: string, cursor = 0) {
    return this.get<{
      ok: boolean;
      sessionId: string;
      events: Array<{ cursor: number; stream: "stdout" | "stderr" | "status"; data: string; ts: string }>;
      nextCursor: number;
      closed: boolean;
      exitCode: number | null;
    }>(`/terminal/sessions/${encodeURIComponent(sessionId)}/events?cursor=${cursor}`);
  }

  async sendTerminalSessionInput(sessionId: string, data: string) {
    return this.post<{ ok: boolean }>(`/terminal/sessions/${encodeURIComponent(sessionId)}/input`, {
      data
    });
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
  output?: Record<string, unknown> | null;
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

export type UiSidebarItem = {
  id: string;
  label: string;
  path: string;
  pageId: string;
  showWhen?: "always" | "advanced";
};

export type UiBuiltinPage = {
  id: string;
  kind: "builtin";
  builtin: "chat" | "jobs" | "settings" | "audit";
  title?: string;
  description?: string;
};

export type UiBaseBlock =
  | {
      type: "markdown";
      markdown: string;
    }
  | {
      type: "stats";
      items: Array<{ label: string; value: string; tone?: "default" | "success" | "warning" | "danger" }>;
    }
  | {
      type: "list";
      title?: string;
      items: string[];
    }
  | {
      type: "note";
      tone?: "default" | "success" | "warning" | "danger";
      text: string;
    }
  | {
      type: "key_value";
      title?: string;
      rows: Array<{ label: string; value: string }>;
    }
  | {
      type: "job_results";
      jobName: string;
      title?: string;
      maxItems?: number;
      emptyText?: string;
      source?: "auto" | "output" | "outputs";
    }
  | {
      type: "job_table";
      jobName: string;
      title?: string;
      maxRows?: number;
      columns?: string[];
      emptyText?: string;
      source?: "auto" | "output" | "outputs";
    }
  | {
      type: "actions";
      title?: string;
      description?: string;
      buttons: Array<{
        label: string;
        style?: "primary" | "secondary" | "outline";
        action:
          | {
              type: "run_job";
              jobName: string;
              confirm?: string;
            }
          | {
              type: "open_url";
              url: string;
            };
      }>;
    }
  | {
      type: "react_widget";
      title?: string;
      description?: string;
      package: string;
      exportName?: string;
      props?: Record<string, unknown>;
      height?: number;
    }
  | {
      type: "terminal_widget";
      title?: string;
      description?: string;
      command: string;
      cwd?: string;
      height?: number;
      allowInput?: boolean;
    }
  | {
      type: "web_embed";
      title?: string;
      description?: string;
      url: string;
      height?: number;
    };

export type UiBasePage = {
  id: string;
  kind: "base";
  title: string;
  description?: string;
  blocks: UiBaseBlock[];
};

export type UiPage = UiBuiltinPage | UiBasePage;

export type UiConfig = {
  name: string;
  sidebar: {
    collapsible: boolean;
    defaultCollapsed?: boolean;
    items: UiSidebarItem[];
  };
  pages: UiPage[];
};
