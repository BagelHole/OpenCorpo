export type McpServerConfig = {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
};

export type McpSettings = {
  servers: McpServerConfig[];
  webSearch: {
    serverId: string;
    toolName: string;
  };
};

const DEFAULT_EXA_SERVER: McpServerConfig = {
  id: "exa",
  name: "Exa Remote",
  url: "https://mcp.exa.ai/mcp",
  headers: {},
  enabled: true
};

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  servers: [DEFAULT_EXA_SERVER],
  webSearch: {
    serverId: "exa",
    toolName: "web_search_exa"
  }
};

function normalizeServerId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sanitizeHeaders(input: unknown) {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (typeof rawValue !== "string") continue;
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

function normalizeServer(input: unknown, fallbackIndex: number): McpServerConfig | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const url = typeof row.url === "string" ? row.url.trim() : "";
  if (!name || !url) return null;
  const rawId = typeof row.id === "string" ? row.id : name || `server-${fallbackIndex + 1}`;
  const id = normalizeServerId(rawId);
  if (!id) return null;
  return {
    id,
    name,
    url,
    headers: sanitizeHeaders(row.headers),
    enabled: row.enabled === false ? false : true
  };
}

export function normalizeMcpSettings(input: unknown): McpSettings {
  if (!input || typeof input !== "object") {
    return DEFAULT_MCP_SETTINGS;
  }
  const row = input as Record<string, unknown>;
  const rawServers = Array.isArray(row.servers) ? row.servers : [];
  const deduped = new Map<string, McpServerConfig>();
  for (let index = 0; index < rawServers.length; index += 1) {
    const normalized = normalizeServer(rawServers[index], index);
    if (!normalized) continue;
    deduped.set(normalized.id, normalized);
  }
  const servers = Array.from(deduped.values());
  if (servers.length === 0) return DEFAULT_MCP_SETTINGS;

  const webSearchRow =
    row.webSearch && typeof row.webSearch === "object"
      ? (row.webSearch as Record<string, unknown>)
      : {};
  const rawServerId =
    typeof webSearchRow.serverId === "string" ? normalizeServerId(webSearchRow.serverId) : "";
  const toolName =
    typeof webSearchRow.toolName === "string" && webSearchRow.toolName.trim()
      ? webSearchRow.toolName.trim()
      : "web_search_exa";
  const selectedServer = servers.find((server) => server.id === rawServerId) ?? servers[0];
  return {
    servers,
    webSearch: {
      serverId: selectedServer.id,
      toolName
    }
  };
}

export function parseMcpSettingsFromSecret(raw: string | null | undefined) {
  if (!raw) return DEFAULT_MCP_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeMcpSettings(parsed);
  } catch {
    return DEFAULT_MCP_SETTINGS;
  }
}
