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
    // When apiBase is empty (dev), use relative path so Vite proxy forwards to daemon
    if (!apiBase) return "/chat/stream";
    return `${apiBase.replace(/\/$/, "")}/chat/stream`;
  }, [apiBase]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: chatApiUrl,
        fetch: customFetch
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
    <div className="flex h-full flex-col">
      <Card className="flex min-h-0 flex-1 flex-col border border-slate-200 shadow-sm">
        <CardContent className="flex min-h-0 flex-1 flex-col gap-4 pt-5">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-4">
            {messages.length === 0 && (
              <div className="mx-auto max-w-[90%] rounded-2xl border border-dashed border-slate-200 bg-slate-100 px-4 py-3 text-sm text-slate-600">
                Welcome to OpenCorpo. Ask me what needs your attention and I will do the heavy
                lifting.
              </div>
            )}
            {messages.map((message, index) => (
              <div
                key={message.id ?? index}
                className={cn(
                  "max-w-2xl whitespace-pre-wrap rounded-2xl border px-4 py-3 text-sm shadow-sm",
                  message.role === "assistant" &&
                    "border-slate-200 bg-white text-slate-800",
                  message.role === "user" &&
                    "ml-auto border-slate-900 bg-slate-900 text-white",
                  message.role === "system" &&
                    "mx-auto max-w-[90%] border-dashed border-slate-200 bg-slate-100 text-slate-600"
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
              <div className="max-w-2xl rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
                Working on it...
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
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
                className="w-full resize-none rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
                placeholder="Tell OpenCorpo what outcome you want..."
                disabled={!canSend}
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">
                  {canSend ? "Press Enter to send." : "Connecting to daemon..."}
                </span>
                <div className="flex gap-2">
                  {isStreaming && (
                    <Button type="button" variant="secondary" onClick={() => stop()}>
                      Stop
                    </Button>
                  )}
                  <Button type="submit" disabled={!canSend}>
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
