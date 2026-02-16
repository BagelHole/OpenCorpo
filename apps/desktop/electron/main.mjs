import "dotenv/config";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
      tokenPath: path.join(runtimeRoot, "launch_token")
    }
  : {
      root: runtimeRoot,
      dataDir: path.join(runtimeRoot, "data"),
      configDir: path.join(runtimeRoot, "config"),
      pluginsDir: path.join(runtimeRoot, "plugins"),
      userlandDir: path.join(runtimeRoot, "userland"),
      workspaceDir: path.join(runtimeRoot, "userland", "workspace"),
      secretsDir: path.join(runtimeRoot, "data", "secrets"),
      tokenPath: path.join(runtimeRoot, "launch_token")
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#f8fafc",
    autoHideMenuBar: true,
    show: false,
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
}

function copyTemplateIfMissing(source, target) {
  if (existsSync(target)) return;
  if (!existsSync(source)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function bootstrapRuntimeLayout() {
  ensureRuntimeDirectory();
  copyTemplateIfMissing(path.join(templateRoot, "config"), runtimeConfig.configDir);
  copyTemplateIfMissing(path.join(templateRoot, "plugins"), runtimeConfig.pluginsDir);
  copyTemplateIfMissing(path.join(templateRoot, "userland"), runtimeConfig.userlandDir);
}

function daemonEntryPath() {
  if (isDev) return path.join(projectRoot, "apps/daemon/src/index.ts");
  return path.join(process.resourcesPath, "daemon", "src", "index.ts");
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
  runtimeState.lastError = "Daemon health check timed out.";
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
    OPENCORPO_PLUGINS_DIR: runtimeConfig.pluginsDir,
    OPENCORPO_USERLAND_DIR: runtimeConfig.userlandDir,
    OPENCORPO_SECRETS_DIR: runtimeConfig.secretsDir,
    OPENCORPO_TOKEN_PATH: runtimeConfig.tokenPath,
    OPENCORPO_LAUNCH_TOKEN: runtimeState.launchToken,
    OPENCORPO_PORT: String(daemonPort)
  };
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
  console.log(`[daemon] CWD: ${projectRoot}`);
  console.log(`[daemon] Data dir: ${runtimeConfig.dataDir}`);

  daemonProcess = spawn(command, ["run", daemonEntry], {
    cwd: projectRoot,
    env: buildDaemonEnv(),
    windowsHide: true
  });

  runtimeState.daemonRunning = true;
  runtimeState.daemonReady = false;
  runtimeState.daemonPid = daemonProcess.pid ?? null;
  console.log(`[daemon] Spawned with PID ${runtimeState.daemonPid}`);

  daemonProcess.stdout?.on("data", (chunk) => {
    console.log(`[daemon:out] ${String(chunk).trim()}`);
  });
  daemonProcess.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      runtimeState.lastError = text;
      console.error(`[daemon:err] ${text}`);
    }
  });
  daemonProcess.on("error", (err) => {
    console.error(`[daemon] Spawn error: ${err.message}`);
    runtimeState.lastError = `Failed to spawn daemon: ${err.message}`;
    runtimeState.daemonRunning = false;
  });
  daemonProcess.on("exit", (code, signal) => {
    console.log(`[daemon] Exited with code=${code}, signal=${signal}`);
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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
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
