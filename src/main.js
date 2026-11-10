"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, session,
  desktopCapturer, globalShortcut, screen, dialog, safeStorage,
} = require("electron");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { createVault } = require("./vault-store");
const { importKeyFile } = require("./import-keys");
const { createSettings } = require("./settings-store");
const { meetingBrowserOptions, applyMeetingProtection, closeMeetingWindow, mainBrowserOptions, applyMainWindowTheme } = require("./meeting-window");
const { createMeetingsStore } = require("../server/index");
const { registerMeeting } = require("./meeting-host");
const { createRendererGuard, guardIpcMain } = require("./ipc-guard");

const rendererGuard = createRendererGuard(path.join(__dirname, "..", "renderer"));
guardIpcMain(ipcMain, rendererGuard, (channel, url) => console.error(`[ipc] recusado ${channel} vindo de ${String(url).slice(0, 120) || "origem desconhecida"}`));

const APP_NAME = "HELIOS";
app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId("br.helison.helios");
if (process.env.HELIOS_USER_DATA) app.setPath("userData", path.resolve(process.env.HELIOS_USER_DATA));
else app.setPath("userData", path.join(app.getPath("appData"), "HELIOS"));

const HOTKEYS = {
  "CommandOrControl+\\": "toggle",
  "CommandOrControl+Shift+Space": "toggle",
  "CommandOrControl+Shift+Enter": "screen",
  "CommandOrControl+Shift+R": "record",
  "CommandOrControl+Shift+T": "clickthrough",
  "CommandOrControl+Shift+Up": "up",
  "CommandOrControl+Shift+Down": "down",
  "CommandOrControl+Shift+Left": "left",
  "CommandOrControl+Shift+Right": "right",
};
const SESSION_HOTKEYS = { "CommandOrControl+Enter": "assist" };

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function iconFile(name) {
  const unpacked = process.resourcesPath ? path.join(process.resourcesPath, "icons", name) : "";
  if (unpacked && fs.existsSync(unpacked)) return unpacked;
  return path.join(__dirname, "..", "build", name);
}

function bootstrap() {
  let mainWindow = null;
  let meetingWindow = null;
  let tray = null;
  let settings = null;
  let quitting = false;
  let failedHotkeys = [];
  let meetingHost = null;

  function quitApp() {
    quitting = true;
    app.quit();
  }

  function showMain() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  const closeMeetingNow = () => {
    setSessionHotkeys(false);
    if (meetingHost && typeof meetingHost.abortInflight === "function") meetingHost.abortInflight();
    return closeMeetingWindow(meetingWindow);
  };

  function openMeeting({ focus = true } = {}) {
    if (meetingWindow) {
      if (focus) {
        meetingWindow.show();
        meetingWindow.focus();
      } else if (!meetingWindow.isVisible()) {
        meetingWindow.showInactive();
      }
      return meetingWindow;
    }
    const base = meetingBrowserOptions();
    const { workArea } = screen.getPrimaryDisplay();
    meetingWindow = new BrowserWindow({
      ...base,
      x: Math.round(workArea.x + (workArea.width - base.width) / 2),
      y: workArea.y + 12,
      icon: iconFile("icon.png"),
      webPreferences: {
        preload: path.join(__dirname, "preload-meeting.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    applyMeetingProtection(meetingWindow);
    meetingWindow.setOpacity(Number(settings.get("opacity")) || 1);
    meetingWindow.loadFile(path.join(__dirname, "..", "renderer", "meeting", "index.html"));
    const offscreen = process.env.HELIOS_TEST_OFFSCREEN === "1";
    if (offscreen) meetingWindow.setPosition(-32000, -32000);
    meetingWindow.once("ready-to-show", () => {
      if (offscreen) meetingWindow.showInactive();
      else if (focus) meetingWindow.show();
      else meetingWindow.showInactive();
    });
    meetingWindow.webContents.once("did-finish-load", () => {
      if (failedHotkeys.length) meetingWindow.webContents.send("hotkeys-failed", failedHotkeys);
    });
    meetingWindow.webContents.on("will-navigate", rendererGuard.blockNavigation);
    meetingWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    meetingWindow.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      closeMeetingNow();
    });
    return meetingWindow;
  }

  function createMainWindow() {
    const base = mainBrowserOptions("light");
    mainWindow = new BrowserWindow({
      ...base,
      icon: process.platform === "win32" ? iconFile("icon.ico") : iconFile("icon.png"),
      webPreferences: {
        preload: path.join(__dirname, "preload-main.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    if (process.env.HELIOS_TEST_OFFSCREEN === "1") {
      mainWindow.setSkipTaskbar(true);
      mainWindow.once("ready-to-show", () => { mainWindow.setPosition(-32000, -32000); mainWindow.showInactive(); });
    } else mainWindow.once("ready-to-show", () => mainWindow.show());
    mainWindow.webContents.on("will-navigate", rendererGuard.blockNavigation);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.on("close", (event) => {
      if (quitting) return;
      if (settings.get("closeToTray")) {
        event.preventDefault();
        mainWindow.hide();
        return;
      }
      quitApp();
    });
  }

  function createTray() {
    const image = nativeImage.createFromPath(iconFile("tray.png"));
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip(APP_NAME);
    const menu = Menu.buildFromTemplate([
      { label: "Abrir HELIOS", click: () => showMain() },
      { label: "Painel de reunião", click: () => openMeeting() },
      { type: "separator" },
      { label: "Sair", click: () => quitApp() },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => showMain());
  }

  function onHotkey(name) {
    if (name === "toggle") {
      if (meetingWindow && meetingWindow.isVisible()) closeMeetingNow();
      else openMeeting({ focus: false });
      return;
    }
    const target = openMeeting({ focus: name === "assist" });
    if (!target) return;
    if (name === "up" || name === "down" || name === "left" || name === "right") {
      const [x, y] = target.getPosition();
      const step = 60;
      const delta = { up: [0, -step], down: [0, step], left: [-step, 0], right: [step, 0] }[name];
      target.setPosition(x + delta[0], y + delta[1]);
      return;
    }
    if (name === "clickthrough") {
      target._heliosClickThrough = !target._heliosClickThrough;
      target.setIgnoreMouseEvents(Boolean(target._heliosClickThrough), { forward: true });
    }
    target.webContents.send("hotkey", name);
  }

  function registerHotkeys() {
    const failed = [];
    for (const [accel, name] of Object.entries(HOTKEYS)) {
      try {
        if (!globalShortcut.register(accel, () => onHotkey(name))) failed.push(accel);
      } catch {
        failed.push(accel);
      }
    }
    return failed;
  }

  let sessionHotkeysOn = false;
  function setSessionHotkeys(on) {
    if (on === sessionHotkeysOn) return [];
    sessionHotkeysOn = on;
    const failed = [];
    for (const [accel, name] of Object.entries(SESSION_HOTKEYS)) {
      try {
        if (on) { if (!globalShortcut.register(accel, () => onHotkey(name))) failed.push(accel); }
        else if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
      } catch { failed.push(accel); }
    }
    if (failed.length && meetingWindow && !meetingWindow.isDestroyed()) meetingWindow.webContents.send("hotkeys-failed", failed);
    return failed;
  }
  ipcMain.on("hotkeys:session", (_event, on) => setSessionHotkeys(Boolean(on)));

  async function importEnvKeys(vault) {
    if (!vault.getKey("groq") && process.env.GROQ_API_KEY) await vault.setKey("groq", process.env.GROQ_API_KEY);
    if (!vault.getKey("gemini") && process.env.GEMINI_API_KEY) await vault.setKey("gemini", process.env.GEMINI_API_KEY);
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.CURSOR_API_KEY;
  }

  app.whenReady().then(async () => {
    const dir = app.getPath("userData");
    const vault = await createVault({ dir, safeStorage });
    settings = createSettings(dir);
    const meetings = createMeetingsStore(dir);
    await importKeyFile(path.join(app.getPath("home"), ".helios-keys.json"), vault);
    await importEnvKeys(vault);

    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ["screen"] })
        .then((sources) => callback({ video: sources[0], audio: "loopback" }))
        .catch(() => callback({}));
    });
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(["media", "display-capture", "clipboard-sanitized-write"].includes(permission));
    });

    meetingHost = registerMeeting({
      getWin: () => meetingWindow,
      getMain: () => mainWindow,
      closeMeeting: () => closeMeetingNow(),
      settings,
      vault,
      meetings,
      quit: quitApp,
      mock: process.env.HELIOS_MOCK === "1",
    });

    ipcMain.handle("meeting:open", async (_event, sessionId) => {
      if (sessionId && meetingHost) meetingHost.setActiveSession(sessionId);
      const win = openMeeting({ focus: true });
      return { ok: Boolean(win) };
    });
    ipcMain.handle("shell:open", async (_event, url) => {
      const parsed = new URL(String(url || ""));
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Só abro links http ou https.");
      await shell.openExternal(parsed.toString());
      return { ok: true };
    });
    ipcMain.on("window:theme", (_event, theme) => applyMainWindowTheme(mainWindow, theme));
    ipcMain.handle("app:info", () => ({
      version: app.getVersion(),
      platform: process.platform,
      mock: process.env.HELIOS_MOCK === "1",
      dataDir: dir,
      encryption: vault.encryptionAvailable(),
      vaultBlocked: vault.isBlocked(),
    }));

    createMainWindow();
    if (process.env.HELIOS_TEST_OFFSCREEN !== "1") createTray();
    failedHotkeys = registerHotkeys();
    app.on("second-instance", () => showMain());
    app.on("before-quit", () => {
      quitting = true;
      if (meetingHost) meetingHost.abortInflight();
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") quitApp();
    });
  }).catch((err) => {
    dialog.showErrorBox(APP_NAME, `Não consegui abrir o HELIOS.\n${err.message || err}`);
    quitApp();
  });
}
