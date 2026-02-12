import { existsSync, mkdirSync, copyFileSync, chmodSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";

const root = resolve(process.cwd());
const runtimeBunPath = resolve(root, ".runtime/bun/bin/bun");

function ensurePlaceholder() {
  mkdirSync(dirname(runtimeBunPath), { recursive: true });
  if (existsSync(runtimeBunPath)) return;
  const placeholder = `#!/usr/bin/env bash
echo "Bundled Bun runtime is missing. Rebuild with Bun installed."
exit 1
`;
  writeFileSync(runtimeBunPath, placeholder, "utf-8");
  chmodSync(runtimeBunPath, 0o755);
}

function resolveBunBinary() {
  if (process.env.BUN_BINARY && existsSync(process.env.BUN_BINARY)) {
    return process.env.BUN_BINARY;
  }
  try {
    const whichResult = execSync("which bun", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (whichResult && existsSync(whichResult)) return whichResult;
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
  chmodSync(runtimeBunPath, 0o755);
  console.log(`[prepare-bun-runtime] Bundled Bun binary from ${bunBinary}`);
}

main();
