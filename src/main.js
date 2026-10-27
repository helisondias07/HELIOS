"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, session,
  desktopCapturer, globalShortcut, screen, dialog, safeStorage,
} = require("electron");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { createVault, editorView } = require("./vault-store");
const { importKeyFile } = require("./import-keys");
const { injectLogin } = require("./vault-inject");
const { registerDictation } = require("./dictation-host");
const { createSettings } = require("./settings-store");
const { meetingBrowserOptions, applyMeetingProtection, closeMeetingWindow, mainBrowserOptions, applyMainWindowTheme } = require("./meeting-window");
const { startServer } = require("../server/index");
const { registerMeeting } = require("./meeting-host");
const { registerVoice } = require("./voice-host");
const { createContextHost, protectedFolders } = require("./context-host");
const { isLocalApiPath } = require("../server/util");
const { createRendererGuard, guardIpcMain } = require("./ipc-guard");

// Só a página do HELIOS (renderer/) fala com o processo principal. Vale para todos os canais registrados daqui para baixo.
const rendererGuard = createRendererGuard(path.join(__dirname, "..", "renderer"));
guardIpcMain(ipcMain, rendererGuard, (channel, url) => console.error(`[ipc] recusado ${channel} vindo de ${String(url).slice(0, 120) || "origem desconhecida"}`));

const APP_NAME = "HELIOS";
app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId("br.helison.helios");
if (process.env.HELIOS_USER_DATA) app.setPath("userData", path.resolve(process.env.HELIOS_USER_DATA));
else app.setPath("userData", path.join(app.getPath("appData"), "HELIOS"));

const HOTKEYS = {
  "CommandOrControl+Shift+Space": "toggle",
  "CommandOrControl+Shift+1": "sugEn",
  "CommandOrControl+Shift+2": "sugPt",
  "CommandOrControl+Shift+3": "translate",
  "CommandOrControl+Shift+Enter": "screen",
  "CommandOrControl+Shift+A": "ask",
  "CommandOrControl+Shift+E": "say",
  "CommandOrControl+Shift+R": "record",
  "CommandOrControl+Shift+T": "clickthrough",
  "CommandOrControl+Shift+W": "close",
  "CommandOrControl+Shift+Up": "up",
  "CommandOrControl+Shift+Down": "down",
  "CommandOrControl+Shift+Left": "left",
  "CommandOrControl+Shift+Right": "right",
};

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
  let server = null;
  let settings = null;
  let quitting = false;
  let failedHotkeys = [];

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

  // Fechar a janela de reunião também cancela o que ainda estava indo para a nuvem (transcrição, tradução, respostas)
  let meetingHost = null;
  const closeMeetingNow = () => {
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
    meetingWindow.once("ready-to-show", () => {
      if (focus) meetingWindow.show();
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
    const base = mainBrowserOptions();
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
    mainWindow.once("ready-to-show", () => mainWindow.show());
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
      { label: "Modo de reunião", click: () => openMeeting() },
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
    if (name === "close") {
      if (meetingWindow && meetingWindow.isVisible()) closeMeetingNow();
      return;
    }
    const target = openMeeting({ focus: name === "ask" || name === "say" });
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

  function loadLooseKeys(vault) {
    return importKeyFile(path.join(app.getPath("home"), ".helios-keys.json"), vault);
  }

  async function importEnvKeys(vault) {
    if (!vault.getKey("groq") && process.env.GROQ_API_KEY) await vault.setKey("groq", process.env.GROQ_API_KEY);
    if (!vault.getKey("gemini") && process.env.GEMINI_API_KEY) await vault.setKey("gemini", process.env.GEMINI_API_KEY);
  }

  async function fillLogin(vault, request) {
    const entry = vault.getLogin(request.id) || vault.findLoginByName(request.nome);
    if (!entry) return { ok: false };
    try {
      const result = await injectLogin(entry, { clipboard: require("electron").clipboard });
      return { ok: Boolean(result.ok) };
    } catch {
      return { ok: false };
    }
  }

  app.whenReady().then(async () => {
    const dir = app.getPath("userData");
    // safeStorage assíncrono: abrir o cofre, os tokens e as chaves soltas acontece antes de o servidor subir.
    const vault = await createVault({ dir, safeStorage });
    const contextHost = createContextHost({ dialog, shell, getWindow: () => mainWindow, documentsDir: app.getPath("documents"), mock: process.env.HELIOS_MOCK === "1" });
    settings = createSettings(dir);
    await loadLooseKeys(vault);
    await importEnvKeys(vault);
    await vault.apiAccess();
    await vault.mcpAccess();
    try {
      server = await startServer({
        dataDir: dir,
        projectsDir: path.join(app.getPath("documents"), "HELIOS", "projetos"),
        port: settings.get("port"),
        mock: process.env.HELIOS_MOCK === "1",
        getAccounts: () => vault.getAccounts(),
        onAccountsChange: (snapshot) => vault.setAccounts(snapshot),
        getVaultIndex: () => vault.index(),
        getApiToken: () => vault.apiToken(),
        getMcpToken: () => vault.mcpToken(),
        secretSealer: vault.sealer,
        pickFolder: contextHost.pickFolder,
        trashItem: contextHost.trashItem,
        blockedFolders: protectedFolders(),
        onFillLogin: (request) => fillLogin(vault, request),
        openExternal: (url) => shell.openExternal(url),
        onLiveSession: (session) => {
          const win = openMeeting();
          const send = () => win.webContents.send("livecoding:session", session);
          if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
          else send();
        },
      });
    } catch (err) {
      dialog.showErrorBox(APP_NAME, `Não consegui abrir o servidor local.\n${err.message || err}`);
      quitApp();
      return;
    }

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
      closeMeeting: () => closeMeetingNow(),
      settings,
      vault,
      serverUrl: () => server.url,
      getApiToken: () => vault.apiToken(),
      quit: quitApp,
      mock: process.env.HELIOS_MOCK === "1",
    });

    registerVoice({ ipcMain, vault });
    registerDictation({
      ipcMain,
      globalShortcut,
      BrowserWindow,
      vault,
      serverUrl: () => server.url,
      getApiToken: () => vault.apiToken(),
      getMainWindow: () => mainWindow,
    });

    ipcMain.handle("api", async (_event, { method, pathname, body }) => {
      if (!isLocalApiPath(pathname) || !["GET", "POST", "DELETE"].includes(method)) {
        return { ok: false, error: "Pedido inválido." };
      }
      try {
        const res = await fetch(`${server.url}${pathname}`, {
          method,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${vault.apiToken()}`,
          },
          body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body || {}),
        });
        const data = await res.json();
        return { ok: res.ok, status: res.status, data, error: data.error || "" };
      } catch {
        return { ok: false, error: "O servidor local não respondeu." };
      }
    });
    // Tema da interface -> cor da barra de título integrada. Só "light"/"dark" valem (normalizado em applyMainWindowTheme).
    ipcMain.on("window:theme", (_event, theme) => {
      applyMainWindowTheme(mainWindow, theme);
    });
    ipcMain.handle("meeting:open", () => {
      openMeeting();
      return { ok: true };
    });
    ipcMain.handle("shell:open", (_event, url) => {
      if (/^https?:\/\//i.test(String(url || ""))) return shell.openExternal(url);
      return false;
    });
    ipcMain.handle("contexto:salvar", (_event, payload) => contextHost.saveFile(payload));
    ipcMain.handle("vault:list", () => vault.list());
    ipcMain.handle("vault:get", (_event, id) => editorView(vault.getLogin(id) || vault.getToken(id)));
    // Cofre ilegível: a gravação é recusada com uma mensagem clara (nunca um erro cru do IPC).
    const vaultGuard = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err && err.code === "VAULT_BLOCKED") return { ok: false, blocked: true, error: err.message };
        throw err;
      }
    };
    ipcMain.handle("vault:save", (_event, entry) => vaultGuard(() => (entry?.tipo === "token" ? vault.saveToken(entry) : vault.saveLogin(entry))));
    ipcMain.handle("vault:remove", (_event, id) => vaultGuard(() => vault.remove(id)));
    ipcMain.handle("vault:set-key", async (_event, payload) => {
      const saved = await vault.setKey(payload?.name, payload?.value);
      return { ...vault.list().keys, persisted: saved.persisted, blocked: Boolean(saved.blocked), error: saved.error || "" };
    });
    ipcMain.handle("vault:start-fresh", async () => {
      try {
        const out = await vault.startFresh();
        return { ok: true, backup: out.backup };
      } catch (err) {
        return { ok: false, error: err.message || "Não consegui começar um cofre novo." };
      }
    });
    const mcpView = (access) => ({ token: access.token, persisted: access.persisted, url: `${server.url}/mcp` });
    ipcMain.handle("mcp:access", async () => mcpView(await vault.mcpAccess()));
    ipcMain.handle("mcp:regenerate", async () => mcpView(await vault.regenerateMcpToken()));

    createMainWindow();
    if (vault.isBlocked()) {
      dialog.showMessageBox({ type: "warning", title: APP_NAME, message: "O cofre não abriu", detail: vault.blockedMessage() }).catch(() => {});
    }
    createTray();
    failedHotkeys = registerHotkeys();
  }).catch((err) => {
    dialog.showErrorBox(APP_NAME, err.message || String(err));
    quitApp();
  });

  app.on("second-instance", () => showMain());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (server) server.close();
  });
  app.on("window-all-closed", () => {
    /* a bandeja mantém o processo */
  });
}
