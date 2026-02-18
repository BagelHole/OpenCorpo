import { parseMcpSettingsFromSecret } from "./mcp-settings";

const BLOCKED_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-forwarded-for"
]);

const PRIVATE_IPV4_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./
];

function isPrivateHostname(hostname: string) {
  const lower = hostname.trim().toLowerCase();
  if (!lower) return true;
  if (lower === "localhost" || lower === "::1" || lower === "0.0.0.0") return true;
  if (lower.endsWith(".local")) return true;
  return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(lower));
}

export function validatePublicHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false as const, error: "Only http/https URLs are allowed." };
    }
    if (isPrivateHostname(parsed.hostname)) {
      return { ok: false as const, error: "Private/local network hosts are blocked." };
    }
    return { ok: true as const, url: parsed };
  } catch {
    return { ok: false as const, error: "Invalid URL." };
  }
}

function sanitizeHeaders(input: unknown) {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const headerName = key.trim();
    if (!headerName) continue;
    if (BLOCKED_HEADER_NAMES.has(headerName.toLowerCase())) continue;
    out[headerName] = value;
  }
  return out;
}

export async function runHttpGet(input: {
  url?: unknown;
  headers?: unknown;
  timeoutMs?: unknown;
  maxBytes?: unknown;
}) {
  const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
  const validated = validatePublicHttpUrl(rawUrl);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.max(1000, Math.min(20000, Math.floor(input.timeoutMs)))
      : 10000;
  const maxBytes =
    typeof input.maxBytes === "number" && Number.isFinite(input.maxBytes)
      ? Math.max(512, Math.min(100000, Math.floor(input.maxBytes)))
      : 12000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(validated.url, {
      method: "GET",
      headers: {
        "user-agent": "OpenCorpo/0.0.2 (+local-agent)",
        ...sanitizeHeaders(input.headers)
      },
      signal: controller.signal
    });
    const body = await response.text();
    const clipped = body.slice(0, maxBytes);
    return {
      ok: true,
      url: validated.url.toString(),
      status: response.status,
      contentType: response.headers.get("content-type") ?? null,
      body: clipped,
      truncated: body.length > clipped.length
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "request_failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type McpRpcResponse = {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  sessionId?: string | null;
};

function toJsonObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return toJsonObject(parsed);
  } catch {
    return null;
  }
}

function parseMcpBody(rawBody: string): Record<string, unknown> | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;
  const parsed = tryParseJson(trimmed);
  if (parsed) return parsed;
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (let index = dataLines.length - 1; index >= 0; index -= 1) {
    const sseParsed = tryParseJson(dataLines[index]);
    if (sseParsed) return sseParsed;
  }
  return null;
}

async function callMcpRpc(input: {
  url: string;
  headers: Record<string, string>;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string | null;
}) {
  const requestBody: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    method: input.method
  };
  if (input.params) requestBody.params = input.params;

  const response = await fetch(input.url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(input.sessionId ? { "mcp-session-id": input.sessionId } : {}),
      ...input.headers
    },
    body: JSON.stringify(requestBody)
  });
  const rawBody = await response.text();
  const payload = parseMcpBody(rawBody);
  const responseSessionId =
    response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id");
  if (!response.ok) {
    return {
      ok: false,
      error: payload?.error
        ? JSON.stringify(payload.error)
        : `mcp_http_${response.status}`,
      sessionId: responseSessionId
    } as McpRpcResponse;
  }
  if (!payload) {
    return { ok: false, error: "mcp_invalid_json", sessionId: responseSessionId } as McpRpcResponse;
  }
  if (payload.error) {
    return {
      ok: false,
      error: JSON.stringify(payload.error),
      sessionId: responseSessionId
    } as McpRpcResponse;
  }
  const result = toJsonObject(payload.result);
  if (!result) {
    return { ok: false, error: "mcp_result_missing", sessionId: responseSessionId } as McpRpcResponse;
  }
  return { ok: true, result, sessionId: responseSessionId } as McpRpcResponse;
}

async function initializeMcpSession(url: string, headers: Record<string, string>) {
  const initialized = await callMcpRpc({
    url,
    headers,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "OpenCorpo",
        version: "0.0.2"
      }
    }
  });
  if (!initialized.ok) return initialized;
  const sessionId = initialized.sessionId ?? null;
  await callMcpRpc({
    url,
    headers,
    method: "notifications/initialized",
    params: {},
    sessionId
  }).catch(() => null);
  return { ok: true, sessionId } as const;
}

function normalizeSearchRow(row: Record<string, unknown>): SearchResult | null {
  const titleCandidates = [row.title, row.name, row.headline];
  const urlCandidates = [row.url, row.link, row.href, row.id];
  const snippetCandidates = [row.snippet, row.text, row.summary, row.description];
  const title = titleCandidates.find((item) => typeof item === "string" && item.trim()) as
    | string
    | undefined;
  const url = urlCandidates.find((item) => typeof item === "string" && item.trim()) as
    | string
    | undefined;
  const snippet = snippetCandidates.find((item) => typeof item === "string" && item.trim()) as
    | string
    | undefined;
  if (!title || !url) return null;
  return {
    title: title.trim(),
    url: url.trim(),
    snippet: snippet ? snippet.trim() : ""
  };
}

function parseExaTextResults(text: string, maxResults: number): SearchResult[] {
  const pattern =
    /Title:\s*(.+?)\r?\n(?:Published Date:.*\r?\n)?URL:\s*(https?:\/\/\S+)\r?\nText:\s*([\s\S]*?)(?=\r?\nTitle:\s*|$)/g;
  const results: SearchResult[] = [];
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const title = match[1]?.trim() ?? "";
    const url = match[2]?.trim() ?? "";
    const snippet = (match[3] ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    if (title && url && !results.some((item) => item.url === url)) {
      results.push({ title, url, snippet });
      if (results.length >= maxResults) break;
    }
    match = pattern.exec(text);
  }
  return results;
}

function extractSearchResultsFromMcpResult(result: Record<string, unknown>, maxResults: number) {
  const candidates: unknown[] = [];
  const textCandidates: string[] = [];
  const structuredContent = toJsonObject(result.structuredContent);
  if (structuredContent?.results && Array.isArray(structuredContent.results)) {
    candidates.push(...structuredContent.results);
  }
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      const row = toJsonObject(item);
      if (!row) continue;
      if (row.type === "json" && row.json) candidates.push(row.json);
      if (row.type === "text" && typeof row.text === "string") {
        const parsed = tryParseJson(row.text);
        if (parsed) candidates.push(parsed);
        textCandidates.push(row.text);
      }
    }
  }
  const flattened: unknown[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) flattened.push(...candidate);
    else if (toJsonObject(candidate)?.results && Array.isArray(toJsonObject(candidate)?.results)) {
      flattened.push(...((toJsonObject(candidate)?.results as unknown[]) ?? []));
    } else {
      flattened.push(candidate);
    }
  }

  const results: SearchResult[] = [];
  for (const candidate of flattened) {
    const row = toJsonObject(candidate);
    if (!row) continue;
    const normalized = normalizeSearchRow(row);
    if (!normalized) continue;
    if (results.some((item) => item.url === normalized.url)) continue;
    results.push(normalized);
    if (results.length >= maxResults) break;
  }
  if (results.length < maxResults) {
    for (const text of textCandidates) {
      const parsedRows = parseExaTextResults(text, maxResults - results.length);
      for (const row of parsedRows) {
        if (results.some((item) => item.url === row.url)) continue;
        results.push(row);
        if (results.length >= maxResults) break;
      }
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

export async function runWebSearch(input: {
  query?: unknown;
  maxResults?: unknown;
}) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    return { ok: false, error: "query_required" };
  }
  const maxResults =
    typeof input.maxResults === "number" && Number.isFinite(input.maxResults)
      ? Math.max(1, Math.min(10, Math.floor(input.maxResults)))
      : 5;

  try {
    const mcpSettings = parseMcpSettingsFromSecret(process.env.OPENCORPO_MCP_SETTINGS);
    const server = mcpSettings.servers.find(
      (entry) => entry.id === mcpSettings.webSearch.serverId && entry.enabled
    );
    if (!server) {
      return { ok: false, error: "mcp_server_missing" };
    }
    const init = await initializeMcpSession(server.url, server.headers);
    if (!init.ok) {
      return { ok: false, error: init.error ?? "mcp_initialize_failed" };
    }
    const toolArgsCandidates: Record<string, unknown>[] = [
      { query, numResults: maxResults },
      { query, maxResults },
      { q: query, limit: maxResults }
    ];

    let response: McpRpcResponse | null = null;
    for (const args of toolArgsCandidates) {
      const attempt = await callMcpRpc({
        url: server.url,
        headers: server.headers,
        method: "tools/call",
        sessionId: init.sessionId,
        params: {
          name: mcpSettings.webSearch.toolName,
          arguments: args
        }
      });
      if (attempt.ok) {
        response = attempt;
        break;
      }
      response = attempt;
    }
    if (!response || !response.ok || !response.result) {
      const listed = await callMcpRpc({
        url: server.url,
        headers: server.headers,
        method: "tools/list",
        sessionId: init.sessionId
      });
      if (listed.ok && listed.result && Array.isArray(listed.result.tools)) {
        const discoveredTool = listed.result.tools
          .map((item) =>
            item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
              ? ((item as { name: string }).name ?? "").trim()
              : ""
          )
          .find((name) => /search/i.test(name));
        if (discoveredTool) {
          for (const args of toolArgsCandidates) {
            const attempt = await callMcpRpc({
              url: server.url,
              headers: server.headers,
              method: "tools/call",
              sessionId: init.sessionId,
              params: {
                name: discoveredTool,
                arguments: args
              }
            });
            if (attempt.ok) {
              response = attempt;
              break;
            }
            response = attempt;
          }
        }
      }
    }
    if (!response || !response.ok || !response.result) {
      return { ok: false, error: response?.error ?? "mcp_tool_call_failed" };
    }

    const results = extractSearchResultsFromMcpResult(response.result, maxResults);
    return {
      ok: true,
      query,
      results,
      source: `mcp:${server.id}`
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "search_failed"
    };
  }
}
