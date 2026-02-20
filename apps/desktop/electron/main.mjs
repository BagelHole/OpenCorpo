import "dotenv/config";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  copyFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { runAiChat } from "./ai.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const daemonPort = Number(process.env.OPENCORPO_PORT || 3555);

const projectRoot = path.resolve(__dirname, "../../..");
const templateRoot = isDev
  ? projectRoot
  : path.join(process.resourcesPath, "templates");
// In dev, use project data/ so manual daemon runs share the same token/runtime
const runtimeRoot = isDev
  ? path.join(projectRoot, "data")
  : path.join(app.getPath("userData"), "runtime");
const runtimeConfig = isDev
  ? {
      root: runtimeRoot,
      dataDir: runtimeRoot,
      configDir: path.join(runtimeRoot, "config"),
      pluginsDir: path.join(projectRoot, "plugins"),
      userlandDir: path.join(projectRoot, "userland"),
      workspaceDir: path.join(projectRoot, "userland", "workspace"),
      secretsDir: path.join(runtimeRoot, "secrets"),
      tokenPath: path.join(runtimeRoot, "launch_token"),
      logsDir: path.join(runtimeRoot, "logs"),
      daemonLogPath: path.join(runtimeRoot, "logs", "daemon.log")
    }
  : {
      root: runtimeRoot,
      dataDir: path.join(runtimeRoot, "data"),
      configDir: path.join(runtimeRoot, "config"),
      pluginsDir: path.join(runtimeRoot, "plugins"),
      userlandDir: path.join(runtimeRoot, "userland"),
      workspaceDir: path.join(runtimeRoot, "userland", "workspace"),
      secretsDir: path.join(runtimeRoot, "data", "secrets"),
      tokenPath: path.join(runtimeRoot, "launch_token"),
      logsDir: path.join(runtimeRoot, "logs"),
      daemonLogPath: path.join(runtimeRoot, "logs", "daemon.log")
    };
const runtimeState = {
  launchToken: "",
  daemonPid: null,
  daemonReady: false,
  daemonRunning: false,
  lastError: null
};
let daemonProcess = null;
let daemonRestartTimer = null;
let daemonRestartAttempts = 0;
let mainWindow = null;
let securityHooksInstalled = false;

function resolveWindowIconPath() {
  if (isDev) {
    const devIcon = path.join(projectRoot, "OpenCorpo-logo.png");
    return existsSync(devIcon) ? devIcon : undefined;
  }
  const packagedIcon = path.join(process.resourcesPath, "assets", "OpenCorpo-logo.png");
  return existsSync(packagedIcon) ? packagedIcon : undefined;
}

function installSessionSecurityHooks() {
  if (securityHooksInstalled) return;
  const ses = BrowserWindow.getAllWindows()[0]?.webContents?.session;
  const targetSession = ses ?? (BrowserWindow.getFocusedWindow()?.webContents?.session ?? null);
  if (!targetSession) return;
  securityHooksInstalled = true;

  // Allow gamepad/pointer-lock/fullscreen in embedded widgets by relaxing restrictive headers.
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    delete headers["Permissions-Policy"];
    delete headers["permissions-policy"];
    headers["Permissions-Policy"] = [
      "gamepad=*, fullscreen=*, pointer-lock=*, clipboard-read=*, clipboard-write=*"
    ];
    callback({ responseHeaders: headers });
  });

  // Explicitly allow the gamepad permission check in Electron/Chromium.
  targetSession.setPermissionCheckHandler((_wc, permission) => {
    if (permission === "gamepad") return true;
    return true;
  });
}

function createWindow() {
  const iconPath = resolveWindowIconPath();
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#f8fafc",
    autoHideMenuBar: true,
    show: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;

  registerZoomShortcuts(win);

  win.on("closed", () => {
    mainWindow = null;
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(
      `[renderer] did-fail-load code=${errorCode} description=${errorDescription} url=${validatedURL}`
    );
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer] render-process-gone reason=${details.reason} code=${details.exitCode}`);
  });

  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) {
      console.error(`[renderer:console] ${message}`);
    }
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  if (isDev) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  setTimeout(() => {
    if (!win.isVisible()) {
      win.show();
      win.focus();
    }
  }, 3000);
}

function ensureRuntimeDirectory() {
  mkdirSync(runtimeConfig.root, { recursive: true });
  mkdirSync(runtimeConfig.dataDir, { recursive: true });
  mkdirSync(runtimeConfig.secretsDir, { recursive: true });
  mkdirSync(runtimeConfig.workspaceDir, { recursive: true });
  mkdirSync(runtimeConfig.logsDir, { recursive: true });
}

function appendDaemonLog(line) {
  try {
    const stream = createWriteStream(runtimeConfig.daemonLogPath, { flags: "a" });
    stream.write(`[${new Date().toISOString()}] ${line}\n`);
    stream.end();
  } catch {
    // best-effort logging only
  }
}

function syncTemplateIntoRuntime(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  // Merge template content into runtime without overwriting existing user files.
  cpSync(source, target, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
}

function bootstrapRuntimeLayout() {
  ensureRuntimeDirectory();
  syncTemplateIntoRuntime(path.join(templateRoot, "config"), runtimeConfig.configDir);
  syncTemplateIntoRuntime(path.join(templateRoot, "plugins"), runtimeConfig.pluginsDir);
  syncTemplateIntoRuntime(path.join(templateRoot, "userland"), runtimeConfig.userlandDir);
  repairRuntimeUiConfig();
}

function repairRuntimeUiConfig() {
  const runtimeUiPath = path.join(runtimeConfig.configDir, "ui", "desktop.json");
  const templateUiPath = path.join(templateRoot, "config", "ui", "desktop.json");
  if (!existsSync(runtimeUiPath) || !existsSync(templateUiPath)) return;
  const backupPath = `${runtimeUiPath}.invalid-${Date.now()}.bak`;
  try {
    const runtimeRaw = readFileSync(runtimeUiPath, "utf-8");
    const templateRaw = readFileSync(templateUiPath, "utf-8");
    const parsed = JSON.parse(runtimeRaw);
    const template = JSON.parse(templateRaw);
    if (!parsed || typeof parsed !== "object" || !template || typeof template !== "object") return;

    let changed = false;
    const next = { ...parsed };
    if (typeof next.name !== "string" || !next.name.trim()) {
      next.name = template.name;
      changed = true;
    }

    if (!next.sidebar || typeof next.sidebar !== "object") {
      next.sidebar = template.sidebar;
      changed = true;
    } else {
      const sidebar = { ...next.sidebar };
      if (typeof sidebar.collapsible !== "boolean") {
        sidebar.collapsible = template.sidebar?.collapsible ?? true;
        changed = true;
      }
      if (!Array.isArray(sidebar.items) || sidebar.items.length === 0) {
        sidebar.items = Array.isArray(template.sidebar?.items) ? template.sidebar.items : [];
        changed = true;
      }
      next.sidebar = sidebar;
    }

    if (!Array.isArray(next.pages) || next.pages.length === 0) {
      next.pages = Array.isArray(template.pages) ? template.pages : [];
      changed = true;
    }

    if (!changed) return;
    writeFileSync(runtimeUiPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    appendDaemonLog("Repaired runtime UI config by filling missing required defaults.");
  } catch (error) {
    try {
      if (existsSync(runtimeUiPath)) {
        copyFileSync(runtimeUiPath, backupPath);
      }
      copyFileSync(templateUiPath, runtimeUiPath);
      appendDaemonLog(
        `Repaired runtime UI config (invalid JSON/read error). Backed up old file to ${backupPath}`
      );
    } catch {
      // best effort
    }
    appendDaemonLog(
      `Failed to inspect/repair runtime UI config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function daemonEntryPath() {
  if (isDev) return path.join(projectRoot, "apps/daemon/src/index.ts");
  return path.join(process.resourcesPath, "daemon", "index.mjs");
}

function resolveBunCommand() {
  const bunExe = process.platform === "win32" ? "bun.exe" : "bun";
  const bundledBun = path.join(process.resourcesPath, "bun", "bin", bunExe);
  const devBundledBun = path.join(projectRoot, "apps", "desktop", ".runtime", "bun", "bin", bunExe);
  if (!isDev && existsSync(bundledBun)) {
    return bundledBun;
  }
  if (isDev && existsSync(devBundledBun)) {
    return devBundledBun;
  }
  return process.env.BUN_BINARY || bunExe;
}

function loadOrCreateLaunchToken() {
  if (existsSync(runtimeConfig.tokenPath)) {
    const token = readFileSync(runtimeConfig.tokenPath, "utf-8").trim();
    if (token.length >= 32) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(runtimeConfig.tokenPath, token, { encoding: "utf-8", mode: 0o600 });
  return token;
}

async function checkDaemonHealth(token) {
  try {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/health`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDaemonReady(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await checkDaemonHealth(runtimeState.launchToken);
    if (ok) {
      runtimeState.daemonReady = true;
      runtimeState.lastError = null;
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  runtimeState.daemonReady = false;
  runtimeState.lastError = `Daemon health check timed out. See logs: ${runtimeConfig.daemonLogPath}`;
  appendDaemonLog(runtimeState.lastError);
  return false;
}

function clearRestartTimer() {
  if (!daemonRestartTimer) return;
  clearTimeout(daemonRestartTimer);
  daemonRestartTimer = null;
}

function scheduleDaemonRestart() {
  clearRestartTimer();
  const delay = Math.min(12000, 1000 * Math.max(1, daemonRestartAttempts));
  daemonRestartAttempts += 1;
  daemonRestartTimer = setTimeout(() => {
    void startDaemon();
  }, delay);
}

function loadAiKeyFromSecrets() {
  try {
    const keyPath = path.join(runtimeConfig.secretsDir, "ai.api_key.secret");
    if (existsSync(keyPath)) {
      const key = readFileSync(keyPath, "utf-8").trim();
      if (key.length > 0) return key;
    }
  } catch {
    // ignore
  }
  return null;
}

function buildDaemonEnv() {
  const env = {
    ...process.env,
    OPENCORPO_PROJECT_ROOT: projectRoot,
    OPENCORPO_DATA_DIR: runtimeConfig.dataDir,
    OPENCORPO_CONFIG_DIR: runtimeConfig.configDir,
    OPENCORPO_SCHEMA_DIR: path.join(runtimeConfig.configDir, "schemas"),
    OPENCORPO_PLUGINS_DIR: runtimeConfig.pluginsDir,
    OPENCORPO_USERLAND_DIR: runtimeConfig.userlandDir,
    OPENCORPO_SECRETS_DIR: runtimeConfig.secretsDir,
    OPENCORPO_TOKEN_PATH: runtimeConfig.tokenPath,
    OPENCORPO_LAUNCH_TOKEN: runtimeState.launchToken,
    OPENCORPO_PORT: String(daemonPort)
  };
  if (!isDev) {
    env.OPENCORPO_ALLOW_INVALID_CONTROL_PLANE = "true";
  }
  const aiKey = loadAiKeyFromSecrets();
  if (aiKey) {
    env.AI_GATEWAY_API_KEY = aiKey;
    env.VERCEL_AI_API_KEY = aiKey;
  }
  return env;
}

async function isPortInUse() {
  try {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/health`);
    return response.ok || response.status > 0;
  } catch {
    return false;
  }
}

async function killStaleOnPort() {
  if (process.platform === "win32") {
    try {
      const { execSync } = await import("node:child_process");
      const result = execSync(
        `netstat -ano | findstr ":${daemonPort}.*LISTENING"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      const match = result.match(/LISTENING\s+(\d+)/);
      if (match) {
        const pid = match[1];
        console.log(`[daemon] Killing stale process on port ${daemonPort} (PID ${pid})`);
        execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch {
      // ignore - port may already be free
    }
  } else {
    try {
      const { execSync } = await import("node:child_process");
      const result = execSync(`lsof -ti:${daemonPort}`, { encoding: "utf-8", timeout: 5000 }).trim();
      if (result) {
        console.log(`[daemon] Killing stale process on port ${daemonPort} (PID ${result})`);
        execSync(`kill -9 ${result}`, { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch {
      // ignore
    }
  }
}

async function startDaemon(options = {}) {
  const forceRestart = Boolean(options.forceRestart);
  if (daemonProcess && !daemonProcess.killed) return;
  bootstrapRuntimeLayout();
  runtimeState.launchToken = loadOrCreateLaunchToken();
  console.log(`[daemon] Token loaded (${runtimeState.launchToken.length} chars)`);

  // If something is already on our port and accepts our token, reuse it
  const alreadyHealthy = forceRestart
    ? false
    : await checkDaemonHealth(runtimeState.launchToken);
  if (alreadyHealthy) {
    console.log("[daemon] Existing daemon is healthy, reusing.");
    runtimeState.daemonRunning = true;
    runtimeState.daemonReady = true;
    runtimeState.daemonPid = null;
    runtimeState.lastError = null;
    daemonRestartAttempts = 0;
    clearRestartTimer();
    return;
  }

  // Kill anything stale on our port
  const portBusy = await isPortInUse();
  if (portBusy) {
    console.log("[daemon] Port in use with wrong token, killing stale process.");
    await killStaleOnPort();
  }

  const command = resolveBunCommand();
  const daemonEntry = daemonEntryPath();
  console.log(`[daemon] Spawning: ${command} run ${daemonEntry}`);
  const daemonCwd = isDev ? projectRoot : runtimeConfig.root;
  console.log(`[daemon] CWD: ${daemonCwd}`);
  console.log(`[daemon] Data dir: ${runtimeConfig.dataDir}`);
  appendDaemonLog(`Spawning: ${command} run ${daemonEntry}`);
  appendDaemonLog(`CWD: ${daemonCwd}`);
  appendDaemonLog(`Data dir: ${runtimeConfig.dataDir}`);

  daemonProcess = spawn(command, ["run", daemonEntry], {
    cwd: daemonCwd,
    env: buildDaemonEnv(),
    windowsHide: true
  });

  runtimeState.daemonRunning = true;
  runtimeState.daemonReady = false;
  runtimeState.daemonPid = daemonProcess.pid ?? null;
  console.log(`[daemon] Spawned with PID ${runtimeState.daemonPid}`);

  daemonProcess.stdout?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (!text) return;
    console.log(`[daemon:out] ${text}`);
    appendDaemonLog(`[out] ${text}`);
  });
  daemonProcess.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      runtimeState.lastError = text;
      console.error(`[daemon:err] ${text}`);
      appendDaemonLog(`[err] ${text}`);
    }
  });
  daemonProcess.on("error", (err) => {
    console.error(`[daemon] Spawn error: ${err.message}`);
    runtimeState.lastError = `Failed to spawn daemon: ${err.message}. See logs: ${runtimeConfig.daemonLogPath}`;
    runtimeState.daemonRunning = false;
    appendDaemonLog(runtimeState.lastError);
  });
  daemonProcess.on("exit", (code, signal) => {
    console.log(`[daemon] Exited with code=${code}, signal=${signal}`);
    appendDaemonLog(`Exited with code=${code}, signal=${signal}`);
    runtimeState.daemonRunning = false;
    runtimeState.daemonReady = false;
    runtimeState.daemonPid = null;
    daemonProcess = null;
    if (!app.isQuitting) {
      runtimeState.lastError = `Daemon exited (code ${code ?? "unknown"}, signal ${signal ?? "none"})`;
      scheduleDaemonRestart();
    }
  });

  const ready = await waitForDaemonReady();
  if (ready) {
    console.log("[daemon] Health check passed, daemon is ready.");
    daemonRestartAttempts = 0;
    clearRestartTimer();
  } else {
    console.error("[daemon] Health check timed out after 15s.");
  }
}

async function restartDaemon() {
  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill();
  }
  // If a daemon exists that this Electron process didn't spawn, force-kill it.
  await killStaleOnPort();
  runtimeState.daemonRunning = false;
  runtimeState.daemonReady = false;
  await startDaemon({ forceRestart: true });
  return getDaemonStatus();
}

function stopDaemon() {
  clearRestartTimer();
  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill();
  }
  daemonProcess = null;
  runtimeState.daemonRunning = false;
  runtimeState.daemonReady = false;
}

function getDaemonStatus() {
  return {
    running: runtimeState.daemonRunning,
    ready: runtimeState.daemonReady,
    pid: runtimeState.daemonPid,
    port: daemonPort,
    apiBase: `http://127.0.0.1:${daemonPort}`,
    hasToken: Boolean(runtimeState.launchToken),
    lastError: runtimeState.lastError
  };
}

function registerZoomShortcuts(win) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const zoomBy = (delta) => {
    const next = clamp(win.webContents.getZoomFactor() + delta, 0.6, 1.8);
    win.webContents.setZoomFactor(next);
  };

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isCmdOrCtrl = input.control || input.meta;
    if (!isCmdOrCtrl) return;

    if (input.key === "=" || input.key === "+") {
      event.preventDefault();
      zoomBy(0.1);
    } else if (input.key === "-") {
      event.preventDefault();
      zoomBy(-0.1);
    } else if (input.key === "0") {
      event.preventDefault();
      win.webContents.setZoomFactor(1);
    }
  });
}

ipcMain.handle("ai:chat", async (_event, messages) => {
  return runAiChat(messages);
});
function ensureLaunchToken() {
  if (!runtimeState.launchToken || runtimeState.launchToken.length < 32) {
    bootstrapRuntimeLayout();
    runtimeState.launchToken = loadOrCreateLaunchToken();
  }
  return runtimeState.launchToken;
}

ipcMain.handle("daemon:get-status", async () => {
  ensureLaunchToken();
  const ready = await checkDaemonHealth(runtimeState.launchToken);
  runtimeState.daemonReady = ready;
  if (!ready && runtimeState.daemonRunning && !runtimeState.lastError) {
    runtimeState.lastError = "Daemon is running but not healthy.";
  }
  return getDaemonStatus();
});
ipcMain.handle("daemon:restart", async () => {
  return restartDaemon();
});
ipcMain.handle("daemon:get-runtime-config", () => {
  ensureLaunchToken();
  return {
    // In dev, use empty base so requests go through the Vite proxy (same origin)
    apiBase: isDev ? "" : `http://127.0.0.1:${daemonPort}`,
    launchToken: runtimeState.launchToken
  };
});
ipcMain.handle("daemon:open-runtime-folder", () => {
  return runtimeConfig.root;
});

app.whenReady().then(() => {
  app.isQuitting = false;
  Menu.setApplicationMenu(null);
  // In dev, always force a fresh daemon so code/env changes apply immediately.
  void startDaemon({ forceRestart: isDev });
  createWindow();
  installSessionSecurityHooks();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      installSessionSecurityHooks();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.isQuitting = true;
    stopDaemon();
    app.quit();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopDaemon();
});
