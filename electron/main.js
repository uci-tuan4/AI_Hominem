import { app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, ipcMain, nativeImage, session } from "electron";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleRequest, handleUpgrade } from "../server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let mainWindow;
let tray;
let server;
let isQuitting = false;

function loadEnv() {
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function startServer() {
  return new Promise((resolveServer) => {
    server = createServer(handleRequest);
    server.on("upgrade", handleUpgrade);
    server.listen(0, "127.0.0.1", () => {
      resolveServer(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVR4AWP4//8/AyUYTFhYGBgYqArYqAoYqAoA0zYEEflFzJkAAAAASUVORK5CYII=");
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("AI Hominem");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show AI Hominem", click: showMainWindow },
    { label: "Hide", click: () => mainWindow?.hide() },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("click", showMainWindow);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow() {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
      if (!sources[0]) callback({});
      else callback({ video: sources[0], audio: "loopback" });
    }).catch(() => callback({}));
  });

  const url = await startServer();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    title: "AI Hominem",
    webPreferences: {
      preload: join(root, "electron/preload.cjs"),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  await mainWindow.loadURL(url);
}

loadEnv();
app.setName("AI Hominem");

app.whenReady().then(async () => {
  createTray();
  await createWindow();
});

app.on("activate", showMainWindow);
app.on("before-quit", () => {
  isQuitting = true;
  server?.close();
});

function notifyWithAppleScript(title, body) {
  const quotedTitle = JSON.stringify(title);
  const quotedBody = JSON.stringify(body);
  execFile("osascript", ["-e", `display notification ${quotedBody} with title ${quotedTitle}`]);
}

ipcMain.handle("notify-flag", (_event, flag) => {
  const title = `AI Hominem: ${String(flag.type || "flag").replaceAll("_", " ")}`;
  const body = flag.followUp || "What is the strongest answer to this?";
  // Native Electron notifications silently no-op in an unpackaged dev app on
  // macOS (no bundle id / notification authorization), so route macOS through
  // AppleScript, which works regardless.
  if (process.platform === "darwin") {
    notifyWithAppleScript(title, body);
    return true;
  }
  if (!Notification.isSupported()) return false;
  const notification = new Notification({
    title,
    body
  });
  notification.on("click", showMainWindow);
  notification.show();
  return true;
});
