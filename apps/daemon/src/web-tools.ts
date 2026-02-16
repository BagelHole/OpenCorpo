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

function pushRelated(results: SearchResult[], topics: unknown) {
  if (!Array.isArray(topics)) return;
  for (const item of topics) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (Array.isArray(row.Topics)) {
      pushRelated(results, row.Topics);
      continue;
    }
    const text = typeof row.Text === "string" ? row.Text : "";
    const firstUrl = typeof row.FirstURL === "string" ? row.FirstURL : "";
    if (!text || !firstUrl) continue;
    if (results.some((result) => result.url === firstUrl)) continue;
    results.push({
      title: text.split(" - ")[0] || text,
      url: firstUrl,
      snippet: text
    });
  }
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

  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": "OpenCorpo/0.0.2 (+local-agent)"
      }
    });
    if (!response.ok) {
      return { ok: false, error: `search_failed:${response.status}` };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const results: SearchResult[] = [];

    const abstractText = typeof payload.AbstractText === "string" ? payload.AbstractText : "";
    const abstractUrl = typeof payload.AbstractURL === "string" ? payload.AbstractURL : "";
    const heading = typeof payload.Heading === "string" ? payload.Heading : "";
    if (abstractText && abstractUrl) {
      results.push({
        title: heading || query,
        url: abstractUrl,
        snippet: abstractText
      });
    }

    pushRelated(results, payload.RelatedTopics);

    return {
      ok: true,
      query,
      results: results.slice(0, maxResults),
      source: "duckduckgo"
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "search_failed"
    };
  }
}
