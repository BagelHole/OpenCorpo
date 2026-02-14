import { useRef, useCallback, useState, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ChatViewProps = {
  apiBase: string;
  launchToken: string;
  daemonReady: boolean;
};

export function ChatView({ apiBase, launchToken, daemonReady }: ChatViewProps) {
  const tokenRef = useRef(launchToken);
  tokenRef.current = launchToken;

  const customFetch = useCallback(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${tokenRef.current}`);
      headers.set("Content-Type", "application/json");
      return fetch(input, { ...init, headers });
    },
    []
  );

  const chatApiUrl = useMemo(() => {
    if (!apiBase) return "/chat/stream";
    return `${apiBase.replace(/\/$/, "")}/chat/stream`;
  }, [apiBase]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: chatApiUrl,
        fetch: customFetch,
      }),
    [chatApiUrl, customFetch]
  );

  const { messages, sendMessage, status, error, stop } = useChat({ transport });
  const [input, setInput] = useState("");

  const isStreaming = status === "submitted" || status === "streaming";
  const canSend =
    daemonReady &&
    Boolean(launchToken.trim()) &&
    (status === "ready" || status === "error");

  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col gap-4 pt-4">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] p-4">
            {messages.length === 0 && (
              <div className="mx-auto max-w-[90%] rounded-lg border border-dashed border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] px-4 py-3 text-sm text-[var(--oc-ink-muted)]">
                Welcome to OpenCorpo. Ask me what needs your attention and I will do the heavy lifting.
              </div>
            )}
            {messages.map((message, index) => (
              <div
                key={message.id ?? index}
                className={cn(
                  "max-w-2xl whitespace-pre-wrap rounded-lg border px-4 py-3 text-sm",
                  message.role === "assistant" &&
                    "border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] text-[var(--oc-ink)]",
                  message.role === "user" &&
                    "ml-auto border-[var(--oc-accent)] bg-[var(--oc-accent)] text-[var(--oc-bg)]",
                  message.role === "system" &&
                    "mx-auto max-w-[90%] border-dashed border-[var(--oc-border)] bg-[var(--oc-bg)] text-[var(--oc-ink-muted)]"
                )}
              >
                {message.parts?.map((part, i) =>
                  part.type === "text" ? (
                    <span key={i}>{(part as { text?: string }).text}</span>
                  ) : null
                ) ?? (typeof message.content === "string" ? message.content : "")}
              </div>
            ))}
            {isStreaming && (
              <div className="max-w-2xl rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg-elevated)] px-4 py-3 text-sm text-[var(--oc-ink-muted)] oc-pulse">
                Working on it...
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-[var(--oc-warning)]/50 bg-[var(--oc-warning-bg)] px-4 py-2 text-sm text-[var(--oc-warning)]">
              {error.message}
            </div>
          )}

          <div className="flex-shrink-0 space-y-3">
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const text = input.trim();
                if (!text || !canSend) return;
                setInput("");
                await sendMessage({ text });
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
                    setInput("");
                    void sendMessage({ text });
                  }
                }}
                rows={3}
                className="w-full resize-none rounded-lg border border-[var(--oc-border)] bg-[var(--oc-bg)] px-4 py-3 text-sm outline-none transition focus:border-[var(--oc-border-strong)] focus:ring-2 focus:ring-[var(--oc-border)] disabled:opacity-50"
                placeholder="Tell OpenCorpo what outcome you want..."
                disabled={!canSend}
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs text-[var(--oc-ink-muted)]">
                  {canSend ? "Press Enter to send." : "Connecting to daemon..."}
                </span>
                <div className="flex gap-2">
                  {isStreaming && (
                    <Button type="button" variant="secondary" size="sm" onClick={() => stop()}>
                      Stop
                    </Button>
                  )}
                  <Button type="submit" size="sm" disabled={!canSend}>
                    {isStreaming ? "Working..." : "Send"}
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
