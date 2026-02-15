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

function parseProvider(value: string): "anthropic" | "openai" | "local" | undefined {
  if (value === "anthropic" || value === "openai" || value === "local") return value;
  return undefined;
}

export function ChatView() {
  const state = useOpenCorpo();
  const JUMP_TO_LATEST_THRESHOLD_PX = 120;
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
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
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
    lastMessageSignature,
    sending,
    state.chatMessages.length,
  ]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {tabMenuSession && tabMenuPosition && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setTabMenu(null)}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            ref={tabMenuRef}
            className="absolute w-[320px] space-y-2 rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] p-2 shadow-xl"
            style={{ left: tabMenuPosition.x, top: tabMenuPosition.y }}
            onClick={(event) => event.stopPropagation()}
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
        </div>
      )}
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col gap-4 pt-4">
          <div className="space-y-3">
            <div
              ref={tabStripRef}
              onWheel={handleTabStripWheel}
              className="oc-scrollbar-subtle flex items-center gap-2 overflow-x-auto border-b border-[var(--oc-border)] pb-2"
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
              <Button
                size="sm"
                variant="secondary"
                className="h-8 shrink-0 px-3 text-xs"
                onClick={() =>
                  void state.createChatSession({
                    title: "New conversation",
                    metadata: { emoji: "💬", color: "slate" },
                  })
                }
              >
                New tab
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
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    message.content
                  )}
                </div>
              ))}
              {sending && (
                <div className="max-w-2xl rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] px-4 py-3 text-sm text-[var(--oc-ink-muted)] oc-pulse">
                  Working on it...
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
                setSending(true);
                setInput("");
                await state.sendChatMessage(text);
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
                    setSending(true);
                    setInput("");
                    void state.sendChatMessage(text).finally(() => setSending(false));
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
                    value={activeSession?.metadata.provider ?? ""}
                    onChange={(event) => {
                      if (!activeSession) return;
                      void state.updateChatSession(activeSession.id, {
                        title: activeSession.title,
                        metadata: {
                          ...activeSession.metadata,
                          provider: parseProvider(event.target.value),
                        },
                      });
                    }}
                    className="h-8 rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg)] px-2 text-xs text-[var(--oc-ink)] outline-none focus:border-[var(--oc-border-strong)] disabled:opacity-60"
                    disabled={!activeSession}
                  >
                    <option value="">Default provider</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="local">Local / BYOK</option>
                  </select>
                  <input
                    value={activeSession?.metadata.model ?? ""}
                    onChange={(event) => {
                      if (!activeSession) return;
                      void state.updateChatSession(activeSession.id, {
                        title: activeSession.title,
                        metadata: { ...activeSession.metadata, model: event.target.value },
                      });
                    }}
                    className="h-8 w-[180px] rounded-md border border-[var(--oc-border)] bg-[var(--oc-bg)] px-2 text-xs text-[var(--oc-ink)] outline-none transition focus:border-[var(--oc-border-strong)] disabled:opacity-60"
                    placeholder="Model override (optional)"
                    disabled={!activeSession}
                  />
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
