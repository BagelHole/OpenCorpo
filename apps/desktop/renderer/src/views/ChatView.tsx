import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type WheelEvent,
} from "react";
import EmojiPicker, { Theme } from "emoji-picker-react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useOpenCorpo } from "@/context/OpenCorpoContext";

const TAB_COLOR_PRESETS = [
  "#94a3b8",
  "#c084fc",
  "#60a5fa",
  "#4ade80",
  "#fbbf24",
  "#fb7185",
] as const;

const TAB_COLOR_ALIASES: Record<string, string> = {
  slate: "#94a3b8",
  purple: "#c084fc",
  blue: "#60a5fa",
  green: "#4ade80",
  amber: "#fbbf24",
  rose: "#fb7185",
};
const LAST_CHAT_SELECTION_KEY = "opencorpo_last_chat_selection_v1";

function normalizeHexColor(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

function resolveTabColor(color: string | undefined): string {
  const normalized = normalizeHexColor(color);
  if (normalized) return normalized;
  if (color && TAB_COLOR_ALIASES[color]) return TAB_COLOR_ALIASES[color];
  return TAB_COLOR_ALIASES.slate;
}

function withAlpha(hex: string, alpha: number): string {
  const normalized = normalizeHexColor(hex) ?? TAB_COLOR_ALIASES.slate;
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseProvider(value: string): "anthropic" | "openai" | "local" | "codex" | undefined {
  if (value === "anthropic" || value === "openai" || value === "local" || value === "codex") {
    return value;
  }
  return undefined;
}

function readLastChatSelection(): {
  provider?: "anthropic" | "openai" | "local" | "codex";
  model?: string;
} {
  try {
    const raw = localStorage.getItem(LAST_CHAT_SELECTION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { provider?: string; model?: string };
    return {
      provider: parseProvider(parsed.provider ?? ""),
      model: typeof parsed.model === "string" ? parsed.model.trim() : undefined,
    };
  } catch {
    return {};
  }
}

function writeLastChatSelection(input: {
  provider?: "anthropic" | "openai" | "local" | "codex";
  model?: string;
}) {
  try {
    localStorage.setItem(
      LAST_CHAT_SELECTION_KEY,
      JSON.stringify({
        provider: input.provider,
        model: input.model?.trim() || undefined,
      })
    );
  } catch {
    // ignore storage write errors
  }
}

export function ChatView() {
  const state = useOpenCorpo();
  const JUMP_TO_LATEST_THRESHOLD_PX = 120;
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [agentProgressExpanded, setAgentProgressExpanded] = useState(true);
  const [agentProgress, setAgentProgress] = useState<
    Array<{
      id: number;
      phase: "started" | "completed" | "failed";
      tool: string;
      detail: string;
      at: string;
    }>
  >([]);
  const [tabMenu, setTabMenu] = useState<{ sessionId: number; x: number; y: number } | null>(
    null
  );
  const [menuTitleDraft, setMenuTitleDraft] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [menuColorDraft, setMenuColorDraft] = useState(TAB_COLOR_ALIASES.slate);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [draggingSessionId, setDraggingSessionId] = useState<number | null>(null);
  const [dragOverSessionId, setDragOverSessionId] = useState<number | null>(null);
  const lastMenuSessionIdRef = useRef<number | null>(null);
  const tabMenuRef = useRef<HTMLDivElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const progressIdRef = useRef(1);
  const stickToBottomRef = useRef(true);
  const activeSession = useMemo(
    () => state.chatSessions.find((session) => session.id === state.activeChatSessionId) ?? null,
    [state.activeChatSessionId, state.chatSessions]
  );
  const tabMenuSession = useMemo(
    () =>
      tabMenu
        ? state.chatSessions.find((session) => session.id === tabMenu.sessionId) ?? null
        : null,
    [tabMenu, state.chatSessions]
  );
  const tabMenuPosition = useMemo(() => {
    if (!tabMenu) return null;
    const menuWidth = 320;
    const menuHeight = showEmojiPicker ? 520 : showColorPicker ? 390 : 180;
    const maxX =
      typeof window !== "undefined" ? window.innerWidth - menuWidth - 8 : tabMenu.x;
    const maxY =
      typeof window !== "undefined" ? window.innerHeight - menuHeight - 8 : tabMenu.y;
    return {
      x: Math.max(8, Math.min(tabMenu.x, maxX)),
      y: Math.max(8, Math.min(tabMenu.y, maxY)),
    };
  }, [showColorPicker, showEmojiPicker, tabMenu]);
  const configuredProviders = useMemo(
    () =>
      state.aiProviderCatalog.providers.filter(
        (provider) =>
          provider.id === "anthropic" ||
          provider.id === "openai" ||
          provider.id === "local" ||
          provider.id === "codex"
      ),
    [state.aiProviderCatalog.providers]
  );
  const defaultProviderId = useMemo(() => {
    const preferred = state.aiProviderCatalog.defaultProvider;
    if (preferred && configuredProviders.some((provider) => provider.id === preferred)) {
      return preferred;
    }
    return configuredProviders[0]?.id ?? "";
  }, [configuredProviders, state.aiProviderCatalog.defaultProvider]);
  const selectedProviderId = useMemo(() => {
    const override = activeSession?.metadata.provider;
    if (override && configuredProviders.some((provider) => provider.id === override)) {
      return override;
    }
    return defaultProviderId;
  }, [activeSession?.metadata.provider, configuredProviders, defaultProviderId]);
  const selectedProviderConfig = useMemo(
    () => configuredProviders.find((provider) => provider.id === selectedProviderId) ?? null,
    [configuredProviders, selectedProviderId]
  );
  const providerDefaultModel = selectedProviderConfig?.defaultModel ?? "";
  const selectableModels = useMemo(() => {
    if (!selectedProviderConfig) return [];
    const models = new Set<string>(selectedProviderConfig.models);
    if (providerDefaultModel) models.add(providerDefaultModel);
    return Array.from(models);
  }, [providerDefaultModel, selectedProviderConfig]);
  const selectedModelValue = useMemo(() => {
    const override = activeSession?.metadata.model?.trim() ?? "";
    if (override) return override;
    if (providerDefaultModel) return providerDefaultModel;
    return selectableModels[0] ?? "";
  }, [activeSession?.metadata.model, providerDefaultModel, selectableModels]);

  useEffect(() => {
    if (!state.daemonStatus.ready) return;
    if (state.chatSessions.length === 0) {
      void state.refreshChatSessions();
    }
  }, [state.daemonStatus.ready, state.chatSessions.length, state.refreshChatSessions]);

  useEffect(() => {
    if (!tabMenu) {
      lastMenuSessionIdRef.current = null;
      return;
    }
    if (lastMenuSessionIdRef.current === tabMenu.sessionId) return;
    const session = state.chatSessions.find((item) => item.id === tabMenu.sessionId);
    if (!session) return;
    lastMenuSessionIdRef.current = tabMenu.sessionId;
    setMenuTitleDraft(session.title);
    setMenuColorDraft(resolveTabColor(session.metadata.color));
    setShowEmojiPicker(false);
    setShowColorPicker(false);
  }, [state.chatSessions, tabMenu]);

  useEffect(() => {
    if (!tabMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTabMenu(null);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (tabMenuRef.current && target && !tabMenuRef.current.contains(target)) {
        setTabMenu(null);
      }
    };
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (tabMenuRef.current && target && !tabMenuRef.current.contains(target)) {
        setTabMenu(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, [tabMenu]);

  const canSend = state.daemonStatus.ready && Boolean(state.activeChatSessionId) && !sending;
  const lastMessageSignature = useMemo(() => {
    const last = state.chatMessages.at(-1);
    if (!last) return `${state.activeChatSessionId ?? "none"}:0`;
    return `${state.activeChatSessionId ?? "none"}:${state.chatMessages.length}:${last.id}:${last.content.length}`;
  }, [state.activeChatSessionId, state.chatMessages]);

  const commitTabTitle = () => {
    if (!tabMenuSession) return;
    const nextTitle = menuTitleDraft.trim() || "New conversation";
    if (nextTitle === tabMenuSession.title) return;
    void state.updateChatSession(tabMenuSession.id, {
      title: nextTitle,
      metadata: tabMenuSession.metadata,
    });
  };

  const commitTabColor = (nextColor: string) => {
    if (!tabMenuSession) return;
    const normalized = normalizeHexColor(nextColor);
    if (!normalized) return;
    if (normalized === tabMenuSession.metadata.color) return;
    void state.updateChatSession(tabMenuSession.id, {
      title: tabMenuSession.title,
      metadata: { ...tabMenuSession.metadata, color: normalized },
    });
  };

  const handleTabStripWheel = (event: WheelEvent<HTMLDivElement>) => {
    const strip = tabStripRef.current;
    if (!strip) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    const delta =
      Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (delta === 0) return;
    strip.scrollLeft += delta;
    event.preventDefault();
  };

  const confirmDeleteSession = (sessionId: number, title: string) => {
    const ok = window.confirm(`Delete "${title}" and all chat history in this tab?`);
    if (!ok) return;
    if (tabMenu?.sessionId === sessionId) setTabMenu(null);
    void state.deleteChatSession(sessionId);
  };

  const moveSessionBefore = (sourceSessionId: number, targetSessionId: number) => {
    if (sourceSessionId === targetSessionId) return;
    const ids = state.chatSessions.map((session) => session.id);
    const sourceIndex = ids.indexOf(sourceSessionId);
    const targetIndex = ids.indexOf(targetSessionId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextIds = [...ids];
    const [moved] = nextIds.splice(sourceIndex, 1);
    nextIds.splice(targetIndex, 0, moved);
    void state.reorderChatSessions(nextIds);
  };

  const handleTabDrop = (event: DragEvent<HTMLButtonElement>, targetSessionId: number) => {
    event.preventDefault();
    if (draggingSessionId === null) return;
    moveSessionBefore(draggingSessionId, targetSessionId);
    setDraggingSessionId(null);
    setDragOverSessionId(null);
  };

  const scrollChatToBottom = (behavior: ScrollBehavior = "auto") => {
    const container = chatScrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
  };

  useEffect(() => {
    setShowJumpToLatest(false);
    stickToBottomRef.current = true;
    scrollChatToBottom("auto");
  }, [state.activeChatSessionId]);

  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;
    if (sending) {
      scrollChatToBottom("auto");
      stickToBottomRef.current = true;
      setShowJumpToLatest(false);
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight);
    const shouldStick =
      sending || stickToBottomRef.current || distanceFromBottom < JUMP_TO_LATEST_THRESHOLD_PX;
    if (shouldStick) {
      scrollChatToBottom("auto");
      stickToBottomRef.current = true;
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(state.chatMessages.length > 0);
    }
  }, [
    JUMP_TO_LATEST_THRESHOLD_PX,
    agentProgress.length,
    lastMessageSignature,
    sending,
    state.chatMessages.length,
  ]);

  const toolLabel = (tool: string) => {
    const map: Record<string, string> = {
      get_status: "Checking status",
      get_approvals: "Checking approvals",
      list_jobs: "Checking jobs",
      list_job_runs: "Checking job runs",
      run_job: "Queueing job",
      enable_job: "Enabling job",
      disable_job: "Disabling job",
      list_audit: "Checking audit",
      list_tools: "Checking tools",
      list_plugins: "Checking plugins",
      web_search: "Searching web",
      http_get: "Reading URL",
      get_control_plane_json: "Reading config",
      propose_config_change: "Updating config",
      get_ui_schema: "Reading UI schema",
      list_available_handlers: "Checking handlers",
      get_tool_schema: "Reading tool schema",
      apply_control_plane_change: "Applying config change",
      propose_code_change: "Preparing code patch"
    };
    if (tool.startsWith("mcp.")) return `Calling ${tool}`;
    return map[tool] ?? `Running ${tool}`;
  };

  const formatToolProgress = (
    phase: "started" | "completed" | "failed",
    tool: string,
    inputPreview?: string | null,
    outputPreview?: string | null,
    error?: string | null
  ) => {
    const label = toolLabel(tool);
    if (phase === "started") {
      return `${label}...`;
    }
    if (phase === "completed") {
      return `${label} done`;
    }
    if (error?.trim()) return `${label} failed (${error.trim()})`;
    return `${label} failed`;
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {tabMenuSession && tabMenuPosition && (
        <div
          ref={tabMenuRef}
          className="fixed z-40 w-[320px] space-y-2 rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] p-2 shadow-xl"
          style={{ left: tabMenuPosition.x, top: tabMenuPosition.y }}
        >
            <input
              value={menuTitleDraft}
              onChange={(event) => setMenuTitleDraft(event.target.value)}
              onBlur={commitTabTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitTabTitle();
                }
              }}
              className="h-7 w-full rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg)] px-2 text-xs text-[var(--oc-ink)] outline-none focus:border-[var(--oc-border-strong)]"
              placeholder="Tab name"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowColorPicker(false);
                  setShowEmojiPicker((current) => !current);
                }}
                className="flex h-7 items-center gap-2 rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg)] px-2 text-xs text-[var(--oc-ink)] outline-none transition hover:border-[var(--oc-border-strong)]"
              >
                <span className="text-base leading-none">{tabMenuSession.metadata.emoji ?? "💬"}</span>
                <span className="truncate">Choose emoji</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowEmojiPicker(false);
                  setShowColorPicker((current) => !current);
                }}
                className="flex h-7 items-center gap-2 rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg)] px-2 text-xs text-[var(--oc-ink)] outline-none transition hover:border-[var(--oc-border-strong)]"
              >
                <span
                  className="h-3 w-3 rounded-sm border border-[var(--oc-border)]"
                  style={{ backgroundColor: resolveTabColor(tabMenuSession.metadata.color) }}
                />
                <span className="truncate">Choose color</span>
              </button>
            </div>
            {showEmojiPicker && (
              <div className="overflow-hidden rounded-md border border-[var(--oc-border)]">
                <EmojiPicker
                  width="100%"
                  height={390}
                  lazyLoadEmojis
                  autoFocusSearch={false}
                  previewConfig={{ showPreview: false }}
                  theme={
                    document.documentElement.classList.contains("dark")
                      ? Theme.DARK
                      : Theme.LIGHT
                  }
                  onEmojiClick={(emojiData) =>
                    void state.updateChatSession(tabMenuSession.id, {
                      title: tabMenuSession.title,
                      metadata: { ...tabMenuSession.metadata, emoji: emojiData.emoji },
                    })
                  }
                />
              </div>
            )}
            {showColorPicker && (
              <div className="space-y-2 rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg)] p-2">
                <HexColorPicker
                  color={normalizeHexColor(menuColorDraft) ?? resolveTabColor(tabMenuSession.metadata.color)}
                  onChange={(nextColor) => {
                    setMenuColorDraft(nextColor);
                    commitTabColor(nextColor);
                  }}
                  style={{ width: "100%", height: 150 }}
                />
                <div className="flex items-center gap-2">
                  <HexColorInput
                    color={menuColorDraft}
                    prefixed
                    alpha={false}
                    onChange={(nextColor) => {
                      setMenuColorDraft(nextColor);
                      commitTabColor(nextColor);
                    }}
                    className="h-7 w-[110px] rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] px-2 text-xs text-[var(--oc-ink)] outline-none focus:border-[var(--oc-border-strong)]"
                  />
                  <div className="ml-auto flex items-center gap-1">
                    {TAB_COLOR_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className="h-5 w-5 rounded-sm border border-[var(--oc-border)]"
                        style={{ backgroundColor: preset }}
                        onClick={() => {
                          setMenuColorDraft(preset);
                          commitTabColor(preset);
                        }}
                        aria-label={`Set tab color to ${preset}`}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => confirmDeleteSession(tabMenuSession.id, tabMenuSession.title)}
              className="h-7 w-full rounded-md border border-[var(--oc-danger)]/40 bg-[var(--oc-danger-bg)] px-2 text-left text-xs text-[var(--oc-danger)] transition hover:border-[var(--oc-danger)]"
            >
              Delete tab and history...
            </button>
        </div>
      )}
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col gap-4 pt-4">
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-[var(--oc-border)] pb-2">
              <div
                ref={tabStripRef}
                onWheel={handleTabStripWheel}
                className="oc-scrollbar-subtle flex min-w-0 flex-1 items-center gap-2 overflow-x-auto"
              >
                {state.chatSessions.map((session) => (
                  <div key={session.id} className="group relative shrink-0">
                    <button
                      draggable
                      onDragStart={() => {
                        setDraggingSessionId(session.id);
                        setDragOverSessionId(session.id);
                      }}
                      onDragEnter={() => setDragOverSessionId(session.id)}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(event) => handleTabDrop(event, session.id)}
                      onDragEnd={() => {
                        setDraggingSessionId(null);
                        setDragOverSessionId(null);
                      }}
                      onClick={() => void state.selectChatSession(session.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        void state.selectChatSession(session.id);
                        setTabMenu({ sessionId: session.id, x: event.clientX, y: event.clientY });
                      }}
                      className={cn(
                        "flex h-8 min-w-[140px] items-center gap-2 rounded-md border px-2.5 pr-7 text-left text-xs transition",
                        draggingSessionId === session.id ? "cursor-grabbing opacity-70" : "cursor-grab",
                        dragOverSessionId === session.id &&
                          draggingSessionId !== null &&
                          draggingSessionId !== session.id &&
                          "ring-1 ring-[var(--oc-border-strong)]",
                        state.activeChatSessionId === session.id
                          ? "text-[var(--oc-ink)]"
                          : "border-transparent text-[var(--oc-ink-muted)] hover:border-[var(--oc-border)] hover:bg-[var(--oc-bg)] hover:text-[var(--oc-ink)]"
                      )}
                      style={
                        state.activeChatSessionId === session.id
                          ? {
                              borderColor: withAlpha(resolveTabColor(session.metadata.color), 0.55),
                              backgroundColor: withAlpha(resolveTabColor(session.metadata.color), 0.16),
                            }
                          : undefined
                      }
                    >
                      <span
                        className="h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: resolveTabColor(session.metadata.color) }}
                      />
                      <span>{session.metadata.emoji ?? "💬"}</span>
                      <span className="truncate">{session.title}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        confirmDeleteSession(session.id, session.title);
                      }}
                      className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[11px] text-[var(--oc-ink-muted)] opacity-0 transition hover:bg-[var(--oc-danger-bg)] hover:text-[var(--oc-danger)] group-hover:opacity-100"
                      aria-label={`Delete ${session.title}`}
                      title="Delete tab and history"
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="h-8 shrink-0 px-3 text-base leading-none"
                onClick={() => {
                  const last = readLastChatSelection();
                  const providerId =
                    (last.provider &&
                    configuredProviders.some((provider) => provider.id === last.provider)
                      ? last.provider
                      : parseProvider(selectedProviderId)) ?? undefined;
                  const providerConfig = configuredProviders.find(
                    (provider) => provider.id === providerId
                  );
                  const model =
                    last.model?.trim() ||
                    providerConfig?.defaultModel ||
                    providerConfig?.models[0] ||
                    undefined;
                  void state.createChatSession({
                    title: "New conversation",
                    metadata: { emoji: "💬", color: "slate", provider: providerId, model },
                  });
                }}
                aria-label="New tab"
                title="New tab"
              >
                +
              </Button>
            </div>
          </div>

          <div className="relative min-h-0 flex-1">
            <div
              ref={chatScrollRef}
              onScroll={(event) => {
                const container = event.currentTarget;
                const distanceFromBottom =
                  container.scrollHeight - (container.scrollTop + container.clientHeight);
                const nearBottom = distanceFromBottom < JUMP_TO_LATEST_THRESHOLD_PX;
                stickToBottomRef.current = nearBottom;
                setShowJumpToLatest(!nearBottom && state.chatMessages.length > 0);
              }}
              className="oc-scrollbar-subtle h-full min-h-0 space-y-4 overflow-y-auto rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] p-4"
            >
              {state.chatMessages.length === 0 && (
                <div className="mx-auto max-w-[90%] rounded-lg border border-dashed border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] px-4 py-3 text-sm text-[var(--oc-ink-muted)]">
                  Welcome to OpenCorpo. Ask me what needs your attention and I will do the heavy lifting.
                </div>
              )}
              {state.chatMessages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "max-w-2xl rounded-lg border px-4 py-3 text-sm",
                    message.role !== "assistant" && "whitespace-pre-wrap",
                    message.role === "assistant" &&
                      "border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] text-[var(--oc-ink)]",
                    message.role === "user" &&
                      "ml-auto border-[var(--oc-accent)] bg-[var(--oc-accent)] text-[var(--oc-bg)]",
                    message.role === "system" &&
                      "mx-auto max-w-[90%] border-dashed border-[var(--oc-border)] bg-[var(--oc-bg)] text-[var(--oc-ink-muted)]"
                  )}
                >
                  {message.role === "assistant" ? (
                    <div className="oc-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    message.content
                  )}
                </div>
              ))}
              {sending && (
                <div className="max-w-2xl rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] px-4 py-3 text-sm text-[var(--oc-ink-muted)]">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-left text-sm text-[var(--oc-ink)]"
                    onClick={() => setAgentProgressExpanded((current) => !current)}
                  >
                    <span>Working on it...</span>
                    <span className="text-xs text-[var(--oc-ink-muted)]">
                      {agentProgressExpanded ? "Hide details" : "Show details"}
                    </span>
                  </button>
                  {agentProgressExpanded && (
                    <div className="mt-2 space-y-1 text-xs">
                      {agentProgress.length === 0 ? (
                        <div className="oc-pulse text-[var(--oc-ink-muted)]">
                          Planning request and selecting tools...
                        </div>
                      ) : (
                        agentProgress.slice(-6).map((entry) => (
                          <div key={entry.id} className="rounded border border-[var(--oc-border)] bg-[var(--oc-bg)] px-2 py-1">
                            {entry.phase === "failed" ? "x" : entry.phase === "completed" ? "[ok]" : "..."} {entry.detail}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            {showJumpToLatest && (
              <button
                type="button"
                onClick={() => {
                  stickToBottomRef.current = true;
                  setShowJumpToLatest(false);
                  scrollChatToBottom("smooth");
                }}
                className="absolute bottom-3 right-3 z-10 rounded-full border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--oc-ink)] shadow-md transition hover:border-[var(--oc-border-strong)]"
                aria-label="Jump to latest"
                title="Jump to latest"
              >
                ↓
              </button>
            )}
          </div>

          {state.chatError && (
            <div className="rounded-lg border border-[var(--oc-warning)]/50 bg-[var(--oc-warning-bg)] px-4 py-2 text-sm text-[var(--oc-warning)]">
              {state.chatError}
            </div>
          )}

          <div className="flex-shrink-0 space-y-3">
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const text = input.trim();
                if (!text || !canSend) return;
                writeLastChatSelection({
                  provider: parseProvider(selectedProviderId),
                  model: selectedModelValue || undefined,
                });
                setSending(true);
                setAgentProgressExpanded(true);
                setAgentProgress([
                  {
                    id: progressIdRef.current++,
                    phase: "started",
                    tool: "planner",
                    detail: "Analyzing request and preparing execution plan",
                    at: new Date().toISOString(),
                  },
                ]);
                setInput("");
                await state.sendChatMessage(text, {
                  onAgentProgress: (event) => {
                    setAgentProgress((current) => [
                      ...current,
                      {
                        id: progressIdRef.current++,
                        phase: event.phase,
                        tool: event.tool,
                        detail: formatToolProgress(
                          event.phase,
                          event.tool,
                          event.inputPreview,
                          event.outputPreview,
                          event.error
                        ),
                        at: event.at,
                      },
                    ]);
                  },
                });
                setSending(false);
              }}
              className="space-y-3"
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    const text = input.trim();
                    if (!text || !canSend) return;
                    writeLastChatSelection({
                      provider: parseProvider(selectedProviderId),
                      model: selectedModelValue || undefined,
                    });
                    setSending(true);
                    setAgentProgressExpanded(true);
                    setAgentProgress([
                      {
                        id: progressIdRef.current++,
                        phase: "started",
                        tool: "planner",
                        detail: "Analyzing request and preparing execution plan",
                        at: new Date().toISOString(),
                      },
                    ]);
                    setInput("");
                    void state
                      .sendChatMessage(text, {
                        onAgentProgress: (event) => {
                          setAgentProgress((current) => [
                            ...current,
                            {
                              id: progressIdRef.current++,
                              phase: event.phase,
                              tool: event.tool,
                              detail: formatToolProgress(
                                event.phase,
                                event.tool,
                                event.inputPreview,
                                event.outputPreview,
                                event.error
                              ),
                              at: event.at,
                            },
                          ]);
                        },
                      })
                      .finally(() => setSending(false));
                  }
                }}
                rows={3}
                className="w-full resize-none rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-4 py-3 text-sm outline-none transition focus:border-[var(--oc-border-strong)] focus:ring-2 focus:ring-[var(--oc-border)] disabled:opacity-50"
                placeholder="Tell OpenCorpo what outcome you want..."
                disabled={!canSend}
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-[var(--oc-ink-muted)]">
                    {canSend ? "Press Enter to send." : "Connect daemon to chat."}
                  </span>
                  <select
                    value={selectedProviderId}
                    onChange={(event) => {
                      if (!activeSession) return;
                      const nextProvider = parseProvider(event.target.value);
                      const nextDefaultModel =
                        configuredProviders.find((provider) => provider.id === event.target.value)
                          ?.defaultModel ?? "";
                      void state.updateChatSession(activeSession.id, {
                        title: activeSession.title,
                        metadata: {
                          ...activeSession.metadata,
                          provider: nextProvider,
                          // If the model override was effectively the previous default,
                          // clear it so provider default follows automatically.
                          model:
                            activeSession.metadata.model?.trim() &&
                            activeSession.metadata.model.trim() !== providerDefaultModel &&
                            activeSession.metadata.model.trim() !== nextDefaultModel
                              ? activeSession.metadata.model
                              : undefined,
                        },
                      });
                      writeLastChatSelection({
                        provider: nextProvider,
                        model:
                          activeSession.metadata.model?.trim() &&
                          activeSession.metadata.model.trim() !== providerDefaultModel &&
                          activeSession.metadata.model.trim() !== nextDefaultModel
                            ? activeSession.metadata.model.trim()
                            : nextDefaultModel || undefined,
                      });
                    }}
                    className="h-8 rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg)] px-2 text-xs text-[var(--oc-ink)] outline-none focus:border-[var(--oc-border-strong)] disabled:opacity-60"
                    disabled={!activeSession || configuredProviders.length === 0}
                  >
                    {configuredProviders.length === 0 ? (
                      <option value="">No configured providers</option>
                    ) : (
                      configuredProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.label}
                        </option>
                      ))
                    )}
                  </select>
                  <select
                    value={selectedModelValue}
                    onChange={(event) => {
                      if (!activeSession) return;
                      const next = event.target.value.trim();
                      void state.updateChatSession(activeSession.id, {
                        title: activeSession.title,
                        metadata: {
                          ...activeSession.metadata,
                          model: next && next !== providerDefaultModel ? next : undefined,
                        },
                      });
                      writeLastChatSelection({
                        provider: parseProvider(selectedProviderId),
                        model: next || undefined,
                      });
                    }}
                    className="h-8 w-[180px] rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg)] px-2 text-xs text-[var(--oc-ink)] outline-none transition focus:border-[var(--oc-border-strong)] disabled:opacity-60"
                    disabled={!activeSession || selectableModels.length === 0}
                  >
                    {selectableModels.length === 0 ? (
                      <option value="">No models found</option>
                    ) : (
                      selectableModels.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={!canSend}>
                    {sending ? "Working..." : "Send"}
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
