import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_SCOPE = "openid profile email offline_access";
export const CODEX_CALLBACK_HOST = "127.0.0.1";
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_CALLBACK_PATH = "/auth/callback";
export const CODEX_DEFAULT_REDIRECT_URI = `http://localhost:${CODEX_CALLBACK_PORT}${CODEX_CALLBACK_PATH}`;
const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

type OauthStateEntry = {
  verifier: string;
  createdAt: number;
};

const oauthStateMap = new Map<string, OauthStateEntry>();
let codexCallbackServer: ReturnType<typeof createServer> | null = null;
let codexCallbackState = "";
let codexCallbackHandler:
  | ((input: { code: string; state: string }) => Promise<{ ok: boolean; error?: string }>)
  | null = null;

function callbackHtml(ok: boolean, message: string) {
  const title = ok ? "OpenCorpo Connected" : "OpenCorpo Connection Failed";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; padding: 24px;">
    <h1>${title}</h1>
    <p>${message}</p>
    <p>You can close this window and return to OpenCorpo.</p>
  </body>
</html>`;
}

function replyHtml(response: ServerResponse, status: number, ok: boolean, message: string) {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(callbackHtml(ok, message));
}

async function handleCodexCallbackRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", CODEX_DEFAULT_REDIRECT_URI);
  if (url.pathname !== CODEX_CALLBACK_PATH) {
    replyHtml(res, 404, false, "Not found.");
    return;
  }
  const code = url.searchParams.get("code")?.trim() ?? "";
  const state = url.searchParams.get("state")?.trim() ?? "";
  const oauthError = url.searchParams.get("error")?.trim() ?? "";
  if (oauthError) {
    replyHtml(res, 400, false, `OpenAI OAuth error: ${oauthError}`);
    return;
  }
  if (!code || !state) {
    replyHtml(res, 400, false, "Missing code or state.");
    return;
  }
  if (!codexCallbackHandler || !codexCallbackState || state !== codexCallbackState) {
    replyHtml(res, 400, false, "OAuth state is invalid or expired.");
    return;
  }

  const result = await codexCallbackHandler({ code, state }).catch((err) => ({
    ok: false,
    error: err instanceof Error ? err.message : "oauth_callback_failed"
  }));
  if (!result.ok) {
    replyHtml(res, 400, false, `Failed to connect: ${result.error ?? "unknown error"}`);
  } else {
    replyHtml(res, 200, true, "ChatGPT subscription connected.");
  }
}

export async function startCodexCallbackServer(input: {
  state: string;
  onCallback: (input: { code: string; state: string }) => Promise<{ ok: boolean; error?: string }>;
}) {
  codexCallbackState = input.state;
  codexCallbackHandler = input.onCallback;

  if (!codexCallbackServer) {
    codexCallbackServer = createServer((req, res) => {
      void handleCodexCallbackRequest(req, res);
    });
    codexCallbackServer.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => {
        codexCallbackServer?.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        codexCallbackServer?.off("error", onError);
        resolve();
      };
      codexCallbackServer?.once("error", onError);
      codexCallbackServer?.once("listening", onListening);
      codexCallbackServer?.listen(CODEX_CALLBACK_PORT, CODEX_CALLBACK_HOST);
    }).catch((err) => {
      codexCallbackServer = null;
      throw err;
    });
  }
  return { redirectUri: CODEX_DEFAULT_REDIRECT_URI };
}

function pruneOauthStateMap(now = Date.now()) {
  for (const [state, entry] of oauthStateMap.entries()) {
    if (now - entry.createdAt > OAUTH_STATE_TTL_MS) {
      oauthStateMap.delete(state);
    }
  }
}

function toBase64Url(value: Buffer) {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createPkcePair() {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createOauthState() {
  return randomBytes(16).toString("hex");
}

export function buildCodexAuthorizeUrl(input: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}) {
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", CODEX_SCOPE);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

export function createCodexOauthStart(redirectUri: string) {
  pruneOauthStateMap();
  const state = createOauthState();
  const pkce = createPkcePair();
  oauthStateMap.set(state, {
    verifier: pkce.verifier,
    createdAt: Date.now()
  });
  return {
    state,
    authUrl: buildCodexAuthorizeUrl({
      redirectUri,
      state,
      codeChallenge: pkce.challenge
    })
  };
}

export function consumeCodexOauthVerifier(state: string) {
  pruneOauthStateMap();
  const key = state.trim();
  if (!key) return null;
  const entry = oauthStateMap.get(key);
  if (!entry) return null;
  oauthStateMap.delete(key);
  return entry.verifier;
}

type CodexTokenSuccess = {
  ok: true;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

type CodexTokenFailure = {
  ok: false;
  error: string;
};

type CodexTokenResult = CodexTokenSuccess | CodexTokenFailure;

async function parseTokenResponse(response: Response, failurePrefix: string): Promise<CodexTokenResult> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, error: `${failurePrefix}:${response.status}:${body || "unknown"}` };
  }
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (
    typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string" ||
    typeof payload.expires_in !== "number"
  ) {
    return { ok: false, error: `${failurePrefix}:invalid_token_payload` };
  }
  return {
    ok: true,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresIn: payload.expires_in
  };
}

export async function exchangeCodexAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string
): Promise<CodexTokenResult> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri
    }).toString()
  });
  return parseTokenResponse(response, "codex_oauth_exchange_failed");
}

export async function refreshCodexAccessToken(
  refreshToken: string
): Promise<CodexTokenResult> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID
    }).toString()
  });
  return parseTokenResponse(response, "codex_oauth_refresh_failed");
}

export function decodeCodexJwt(accessToken: string): Record<string, unknown> | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8")) as Record<
      string,
      unknown
    >;
    return payload;
  } catch {
    return null;
  }
}

export function extractCodexAccountId(accessToken: string) {
  const decoded = decodeCodexJwt(accessToken);
  if (!decoded) return null;
  const claim = decoded[CODEX_JWT_CLAIM_PATH];
  if (!claim || typeof claim !== "object") return null;
  const accountId = (claim as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
}
