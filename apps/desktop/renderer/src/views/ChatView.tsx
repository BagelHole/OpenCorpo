import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export function ChatView({
  messages,
  pendingApprovals,
  sendMessage,
  isSending
}: {
  messages: ChatMessage[];
  pendingApprovals: number;
  sendMessage: (content: string) => Promise<void>;
  isSending: boolean;
}) {
  const [input, setInput] = useState("");
  const suggestions = useMemo(
    () => [
      "Give me today’s priorities.",
      "Show pending approvals.",
      "Run my heartbeat job.",
      "Summarize recent audit changes."
    ],
    []
  );

  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await sendMessage(text);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="min-h-[70vh] border border-slate-200 shadow-sm">
        <CardHeader className="border-b border-slate-200">
          <CardTitle>Home Chat</CardTitle>
          <p className="text-sm text-slate-500">
            Describe what you want done. OpenCorpo handles routing and safe execution.
          </p>
        </CardHeader>
        <CardContent className="flex h-full flex-col gap-4 pt-5">
          <div className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-4">
            {messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={cn(
                  "max-w-[75%] whitespace-pre-wrap rounded-2xl border px-4 py-3 text-sm shadow-sm",
                  message.role === "assistant" &&
                    "border-slate-200 bg-white text-slate-800",
                  message.role === "user" &&
                    "ml-auto border-slate-900 bg-slate-900 text-white",
                  message.role === "system" &&
                    "mx-auto max-w-[90%] border-dashed border-slate-200 bg-slate-100 text-slate-600"
                )}
              >
                {message.content}
              </div>
            ))}
            {isSending && (
              <div className="max-w-[60%] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
                Working on it...
              </div>
            )}
          </div>

          <div className="space-y-3">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={3}
              className="w-full resize-none rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
              placeholder="Tell OpenCorpo what outcome you want..."
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">Press Enter to send.</span>
              <Button onClick={() => void submit()} disabled={isSending}>
                {isSending ? "Working..." : "Send"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-5">
        <Card className="border border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Suggested prompts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {suggestions.map((text) => (
              <button
                key={text}
                onClick={() => {
                  setInput(text);
                }}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-700 transition hover:border-slate-400"
              >
                {text}
              </button>
            ))}
          </CardContent>
        </Card>
        <Card className="border border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Attention needed</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <span className="text-sm text-slate-600">Pending approvals</span>
            <Badge tone={pendingApprovals > 0 ? "warning" : "success"}>
              {pendingApprovals}
            </Badge>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
