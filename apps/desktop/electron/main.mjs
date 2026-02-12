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
const runtimeRoot = path.join(app.getPath("userData"), "runtime");
const runtimeConfig = {
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#f8fafc",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  registerZoomShortcuts(win);

  if (isDev) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
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
  const bundledLinuxBun = path.join(process.resourcesPath, "bun", "bin", "bun");
  if (!isDev && existsSync(bundledLinuxBun)) {
    return bundledLinuxBun;
  }
  return process.env.BUN_BINARY || "bun";
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

function buildDaemonEnv() {
  return {
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
}

async function startDaemon() {
  if (daemonProcess && !daemonProcess.killed) return;
  bootstrapRuntimeLayout();
  runtimeState.launchToken = loadOrCreateLaunchToken();

  const command = resolveBunCommand();
  const daemonEntry = daemonEntryPath();
  daemonProcess = spawn(command, ["run", daemonEntry], {
    cwd: projectRoot,
    env: buildDaemonEnv(),
    windowsHide: true
  });

  runtimeState.daemonRunning = true;
  runtimeState.daemonReady = false;
  runtimeState.daemonPid = daemonProcess.pid ?? null;

  daemonProcess.stdout?.on("data", (chunk) => {
    console.log(String(chunk));
  });
  daemonProcess.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      runtimeState.lastError = text;
      console.error(text);
    }
  });
  daemonProcess.on("exit", (code, signal) => {
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
    daemonRestartAttempts = 0;
    clearRestartTimer();
  }
}

async function restartDaemon() {
  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill();
  }
  runtimeState.daemonRunning = false;
  runtimeState.daemonReady = false;
  await startDaemon();
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
ipcMain.handle("daemon:get-status", async () => {
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
  return {
    apiBase: `http://127.0.0.1:${daemonPort}`,
    launchToken: runtimeState.launchToken
  };
});
ipcMain.handle("daemon:open-runtime-folder", () => {
  return runtimeConfig.root;
});

app.whenReady().then(() => {
  app.isQuitting = false;
  Menu.setApplicationMenu(null);
  void startDaemon();
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
