import type { Context } from "elysia";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { dataRoot } from "./paths";

export type AuthState = {
  launchToken: string;
  tokenPath: string;
};

export function getAuthState(): AuthState {
  const launchToken = resolveLaunchToken();
  const tokenPath = resolve(
    process.env.OPENCORPO_TOKEN_PATH || resolve(dataRoot, "launch_token")
  );
  return { launchToken, tokenPath };
}

function resolveLaunchToken() {
  if (process.env.OPENCORPO_LAUNCH_TOKEN) {
    return process.env.OPENCORPO_LAUNCH_TOKEN;
  }

  const tokenPath = resolve(
    process.env.OPENCORPO_TOKEN_PATH || resolve(dataRoot, "launch_token")
  );
  mkdirSync(resolve(tokenPath, ".."), { recursive: true });

  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf-8").trim();
    if (existing.length >= 32) return existing;
  }

  const generated = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, generated, { encoding: "utf-8", mode: 0o600 });
  return generated;
}

export function requireAuth(ctx: Context, state: AuthState) {
  const header = ctx.request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const urlToken = new URL(ctx.request.url).searchParams.get("token") ?? "";
  const resolved = token || urlToken;
  if (!resolved || resolved !== state.launchToken) {
    ctx.set.status = 401;
    return { ok: false, error: "unauthorized" } as const;
  }
  return null;
}
