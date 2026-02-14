import { existsSync, mkdirSync, copyFileSync, chmodSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";

const root = resolve(process.cwd());
const isWin = process.platform === "win32";
const bunExe = isWin ? "bun.exe" : "bun";
const runtimeBunPath = resolve(root, ".runtime/bun/bin", bunExe);

function ensurePlaceholder() {
  mkdirSync(dirname(runtimeBunPath), { recursive: true });
  if (existsSync(runtimeBunPath)) return;
  const placeholder = isWin
    ? "@echo off\necho Bundled Bun runtime is missing. Rebuild with Bun installed.\nexit /b 1\n"
    : `#!/usr/bin/env bash
echo "Bundled Bun runtime is missing. Rebuild with Bun installed."
exit 1
`;
  writeFileSync(runtimeBunPath, placeholder, "utf-8");
  if (!isWin) chmodSync(runtimeBunPath, 0o755);
}

function resolveBunBinary() {
  if (process.env.BUN_BINARY && existsSync(process.env.BUN_BINARY)) {
    return process.env.BUN_BINARY;
  }
  try {
    const whichCmd = isWin ? "where bun" : "which bun";
    const result = execSync(whichCmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const firstLine = result.split(/\r?\n/)[0]?.trim();
    if (firstLine && existsSync(firstLine)) return firstLine;
  } catch {
    // ignore
  }
  return null;
}

function main() {
  ensurePlaceholder();
  const bunBinary = resolveBunBinary();
  if (!bunBinary) {
    console.warn("[prepare-bun-runtime] Bun binary not found. Keeping placeholder.");
    return;
  }
  copyFileSync(bunBinary, runtimeBunPath);
  if (!isWin) chmodSync(runtimeBunPath, 0o755);
  console.log(`[prepare-bun-runtime] Bundled Bun binary from ${bunBinary}`);
}

main();
