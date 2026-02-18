import type { ToolDefinition } from "./tools";
import type { ToolHandler } from "./tool-types";
import { parseMcpSettingsFromSecret } from "./mcp-settings";

type McpRpcResponse = {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  sessionId?: string | null;
};

function toObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function tryParseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseRpcBody(rawBody: string): Record<string, unknown> | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;
  const direct = tryParseJson(trimmed);
  const directObject = toObject(direct);
  if (directObject) return directObject;
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (let index = dataLines.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseJson(dataLines[index]);
    const row = toObject(parsed);
    if (row) return row;
  }
  return null;
}

async function callRpc(input: {
  url: string;
  headers: Record<string, string>;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string | null;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(input.sessionId ? { "mcp-session-id": input.sessionId } : {}),
        ...input.headers
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        method: input.method,
        ...(input.params ? { params: input.params } : {})
      }),
      signal: controller.signal
    });
    const rawBody = await response.text();
    const payload = parseRpcBody(rawBody);
    const responseSessionId =
      response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id");
    if (!response.ok) {
      return {
        ok: false,
        error: payload?.error ? JSON.stringify(payload.error) : `mcp_http_${response.status}`,
        sessionId: responseSessionId
      } as McpRpcResponse;
    }
    if (!payload) {
      return {
        ok: false,
        error: "mcp_invalid_json",
        sessionId: responseSessionId
      } as McpRpcResponse;
    }
    if (payload.error) {
      return {
        ok: false,
        error: JSON.stringify(payload.error),
        sessionId: responseSessionId
      } as McpRpcResponse;
    }
    const result = toObject(payload.result);
    if (!result) {
      return {
        ok: false,
        error: "mcp_result_missing",
        sessionId: responseSessionId
      } as McpRpcResponse;
    }
    return { ok: true, result, sessionId: responseSessionId } as McpRpcResponse;
  } finally {
    clearTimeout(timeout);
  }
}

async function initializeSession(url: string, headers: Record<string, string>) {
  const initialized = await callRpc({
    url,
    headers,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "OpenCorpo", version: "0.0.2" }
    }
  });
  if (!initialized.ok) return initialized;
  const sessionId = initialized.sessionId ?? null;
  await callRpc({
    url,
    headers,
    method: "notifications/initialized",
    params: {},
    sessionId
  }).catch(() => null);
  return { ok: true as const, sessionId };
}

function normalizeJsonSchema(input: unknown) {
  if (toObject(input)) return input as Record<string, unknown>;
  return {
    type: "object",
    additionalProperties: true
  } as Record<string, unknown>;
}

function normalizeToolName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function buildMcpRuntimeTools(mcpSettingsRaw: string | null | undefined): Promise<{
  definitions: ToolDefinition[];
  handlers: ToolHandler[];
  warnings: string[];
}> {
  const settings = parseMcpSettingsFromSecret(mcpSettingsRaw);
  const definitions: ToolDefinition[] = [];
  const handlers: ToolHandler[] = [];
  const warnings: string[] = [];

  for (const server of settings.servers.filter((row) => row.enabled)) {
    try {
      const init = await initializeSession(server.url, server.headers);
      if (!init.ok) {
        warnings.push(`mcp_server_init_failed:${server.id}:${init.error ?? "unknown"}`);
        continue;
      }
      const listed = await callRpc({
        url: server.url,
        headers: server.headers,
        method: "tools/list",
        sessionId: init.sessionId
      });
      if (!listed.ok || !listed.result) {
        warnings.push(`mcp_tools_list_failed:${server.id}:${listed.error ?? "unknown"}`);
        continue;
      }
      const toolsList = Array.isArray(listed.result.tools) ? listed.result.tools : [];
      for (const item of toolsList) {
        const row = toObject(item);
        const rawName = typeof row?.name === "string" ? row.name.trim() : "";
        if (!rawName) continue;
        const normalizedMcpToolName = normalizeToolName(rawName);
        if (!normalizedMcpToolName) continue;
        const toolName = `mcp.${server.id}.${normalizedMcpToolName}`;
        const inputSchema = normalizeJsonSchema(row?.inputSchema);
        definitions.push({
          name: toolName,
          version: "mcp",
          risk: "medium",
          capabilities: ["mcp", `mcp.${server.id}`],
          inputs: inputSchema
        });

        const handler: ToolHandler = {
          name: toolName,
          version: "mcp",
          risk: "medium",
          capabilities: ["mcp", `mcp.${server.id}`],
          async run(input) {
            const callInit = await initializeSession(server.url, server.headers);
            if (!callInit.ok) {
              return { ok: false, error: callInit.error ?? "mcp_initialize_failed" };
            }
            const called = await callRpc({
              url: server.url,
              headers: server.headers,
              method: "tools/call",
              sessionId: callInit.sessionId,
              params: {
                name: rawName,
                arguments: toObject(input) ?? {}
              }
            });
            if (!called.ok) {
              return { ok: false, error: called.error ?? "mcp_tool_call_failed" };
            }
            return {
              ok: true,
              serverId: server.id,
              mcpTool: rawName,
              result: called.result
            };
          }
        };
        handlers.push(handler);
      }
    } catch (error) {
      warnings.push(
        `mcp_server_failed:${server.id}:${
          error instanceof Error ? error.message : "unknown_error"
        }`
      );
    }
  }

  return { definitions, handlers, warnings };
}
