import type { ToolHandler } from "../../packages/plugin-sdk/src/index";

const gmailApiBase = "https://gmail.googleapis.com/gmail/v1/users/me";

function getAccessToken() {
  const token = process.env.OPENCORPO_GMAIL_ACCESS_TOKEN ?? "";
  if (!token.trim()) {
    throw new Error("gmail_not_connected:missing_access_token");
  }
  return token.trim();
}

async function gmailRequest(
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {}
) {
  const token = getAccessToken();
  const response = await fetch(`${gmailApiBase}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`gmail_request_failed:${response.status}:${text}`);
  }
  return response.json();
}

function toBase64Url(value: string) {
  return Buffer.from(value, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildRawEmail(input: { to: string; subject: string; body: string }) {
  return [
    `To: ${input.to}`,
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    `Subject: ${input.subject}`,
    "",
    input.body
  ].join("\r\n");
}

const search: ToolHandler = {
  name: "gmail.search",
  version: "0.0.1",
  risk: "medium",
  capabilities: ["gmail.read"],
  async run(input) {
    try {
      const query = typeof input.query === "string" ? input.query : "";
      const encoded = encodeURIComponent(query);
      const list = (await gmailRequest(
        `/messages?q=${encoded}&maxResults=10`
      )) as {
        messages?: Array<{ id: string; threadId: string }>;
      };
      const messages = list.messages ?? [];
      return {
        ok: true,
        query,
        threads: messages.map((item) => ({
          id: item.id,
          threadId: item.threadId
        }))
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "gmail_search_failed"
      };
    }
  }
};

const read: ToolHandler = {
  name: "gmail.read",
  version: "0.0.1",
  risk: "medium",
  capabilities: ["gmail.read"],
  async run(input) {
    try {
      const id = typeof input.id === "string" ? input.id : "";
      if (!id) {
        return { ok: false, error: "gmail_read_missing_id" };
      }
      const message = await gmailRequest(`/messages/${encodeURIComponent(id)}?format=full`);
      return { ok: true, id, message };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "gmail_read_failed"
      };
    }
  }
};

const draft: ToolHandler = {
  name: "gmail.draft",
  version: "0.0.1",
  risk: "medium",
  capabilities: ["gmail.send"],
  async run(input) {
    try {
      const to = typeof input.to === "string" ? input.to : "";
      const subject = typeof input.subject === "string" ? input.subject : "";
      const body = typeof input.body === "string" ? input.body : "";
      if (!to || !subject || !body) {
        return { ok: false, error: "gmail_draft_missing_fields" };
      }
      const raw = toBase64Url(buildRawEmail({ to, subject, body }));
      const response = (await gmailRequest("/drafts", {
        method: "POST",
        body: { message: { raw } }
      })) as { id?: string };
      return { ok: true, draftId: response.id ?? null };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "gmail_draft_failed"
      };
    }
  }
};

const send: ToolHandler = {
  name: "gmail.send",
  version: "0.0.1",
  risk: "high",
  capabilities: ["gmail.send"],
  async run(input) {
    try {
      const to = typeof input.to === "string" ? input.to : "";
      const subject = typeof input.subject === "string" ? input.subject : "";
      const body = typeof input.body === "string" ? input.body : "";
      if (!to || !subject || !body) {
        return { ok: false, error: "gmail_send_missing_fields" };
      }
      const raw = toBase64Url(buildRawEmail({ to, subject, body }));
      const response = (await gmailRequest("/messages/send", {
        method: "POST",
        body: { raw }
      })) as { id?: string; threadId?: string };
      return {
        ok: true,
        messageId: response.id ?? null,
        threadId: response.threadId ?? null
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "gmail_send_failed"
      };
    }
  }
};

export default function createPlugin() {
  return {
    manifest: {
      name: "gmail",
      version: "0.0.1",
      permissions: ["gmail.read", "gmail.send"],
      tools: ["gmail.search", "gmail.read", "gmail.draft", "gmail.send"]
    },
    tools: [search, read, draft, send]
  };
}
