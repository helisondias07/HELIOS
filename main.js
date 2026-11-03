"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, session,
  desktopCapturer, globalShortcut, screen, dialog, safeStorage, clipboard,
} = require("electron");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { createVault, editorView } = require("./vault-store");
const { importKeyFile } = require("./import-keys");
const { injectLogin } = require("./vault-inject");
const { registerDictation } = require("./dictation-host");
const { createSettings } = require("./settings-store");
const { meetingBrowserOptions, applyMeetingProtection, closeMeetingWindow, mainBrowserOptions, applyMainWindowTheme } = require("./meeting-window");
const { startServer } = require("../server/index");
const { registerJobs, partitionFor, migrateVagasSession } = require("./jobs-host");
const { createFreeLlm } = require("../server/free-llm");
const { createAgentBrowser } = require("./agent-browser");
const { createCodeReader } = require("./code-reader");
const { loadOAuthClients } = require("../server/oauth-clients");
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

// Leva H (estilo Cluely). Ctrl+Enter só fica registrado enquanto a reunião está ouvindo (SESSION_HOTKEYS).
const HOTKEYS = {
  "CommandOrControl+\\": "toggle",
  "CommandOrControl+Shift+Space": "toggle",
  "CommandOrControl+Shift+Enter": "screen",
  "CommandOrControl+Shift+3": "translate",
  "CommandOrControl+Shift+E": "say",
  "CommandOrControl+Shift+L": "live",
  "CommandOrControl+Shift+M": "mode",
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
  let server = null;
  let settings = null;
  let quitting = false;
  let failedHotkeys = [];
  let jobsHost = null;
  let agentBrowser = null;

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
    setSessionHotkeys(false);
    if (meetingHost && typeof meetingHost.abortInflight === "function") meetingHost.abortInflight();
    // Leva B: fim de reunião dispara as rotinas ligadas a esse evento (cooldown de 1 min no servidor).
    if (meetingWindow && meetingWindow.isVisible()) { try { server?.emitEvent?.("reuniao_terminou"); } catch { /* opcional */ } }
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
    // Testes automáticos (HELIOS_TEST_OFFSCREEN=1): a pílula também abre fora da tela e sem foco.
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
    const base = mainBrowserOptions("light");   // Leva J: claro é o tema principal; o renderer ajusta logo após carregar
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
    // Só para testes automáticos: janela fora da tela, sem foco, sem barra de tarefas e sem ícone na bandeja.
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
    const target = openMeeting({ focus: name === "say" || name === "live" });
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

  // Ctrl+Enter global só durante a reunião ativa (senão briga com Teams, Slack etc.).
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

  function loadLooseKeys(vault) {
    return importKeyFile(path.join(app.getPath("home"), ".helios-keys.json"), vault);
  }

  async function importEnvKeys(vault) {
    if (!vault.getKey("groq") && process.env.GROQ_API_KEY) await vault.setKey("groq", process.env.GROQ_API_KEY);
    if (!vault.getKey("gemini") && process.env.GEMINI_API_KEY) await vault.setKey("gemini", process.env.GEMINI_API_KEY);
    // LEVA R: chaves dos modelos gratis.
    if (!vault.getKey("nvidia") && process.env.HELIOS_NVIDIA_KEY) await vault.setKey("nvidia", process.env.HELIOS_NVIDIA_KEY);
    if (!vault.getKey("gemini") && process.env.HELIOS_GEMINI_KEY) await vault.setKey("gemini", process.env.HELIOS_GEMINI_KEY);
    delete process.env.HELIOS_NVIDIA_KEY; delete process.env.HELIOS_GEMINI_KEY;
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
    // Leva G: leitor do Gmail (códigos e resumo) só no processo principal; contas vêm dos Conectores.
    const codeReader = createCodeReader({
      getAccounts: () => (server && server.conectores ? server.conectores.connected("gmail") : []),
      getAuthorization: (id) => server.conectores.authorization(id),
    });
    // LEVA I: navegador dos agentes (criado depois do jobsHost; o servidor chama pelo proxy).
    agentBrowser = null;
    const agentBrowserProxy = {
      exec: (rec, op, args) => (agentBrowser ? agentBrowser.exec(rec, op, args) : Promise.resolve({ ok: false, error: "Navegador ainda abrindo." })),
      show: (id) => (agentBrowser ? agentBrowser.show(id) : false),
      close: (id) => agentBrowser && agentBrowser.close(id),
      closeAll: () => agentBrowser && agentBrowser.closeAll(),
    };
    try {
      server = await startServer({
        dataDir: dir,
        agentsDir: process.env.HELIOS_AGENTS_DIR || path.join(app.getPath("documents"), "HELIOS", "agentes"),
        skillsDir: process.env.HELIOS_SKILLS_DIR || path.join(app.getPath("documents"), "HELIOS", "skills"),
        agentRoots: (process.env.HELIOS_AGENT_ROOTS ? process.env.HELIOS_AGENT_ROOTS.split(";") : [path.join(app.getPath("home"), "Repositorios")]).filter(Boolean),
        agentBrowser: agentBrowserProxy,
        projectsDir: path.join(app.getPath("documents"), "HELIOS", "projetos"),
        profilePath: path.join(app.getPath("documents"), "HELIOS", "contexto.md"),
        // Leva E: token do Telegram vem do cofre; o automático das vagas roda na janela de vagas.
        openMeeting: () => openMeeting({ focus: true }),
        // Leva H: configurações da reunião pelo chat (helios_ajustes). Sem chaves de API.
        meetingSettings: {
          get: () => ({ ...settings.publicView(), hasGroqKey: Boolean(vault.list().keys.hasGroqKey), hasGeminiKey: Boolean(vault.list().keys.hasGeminiKey) }),
          set: (patch) => {
            const clean = { ...(patch || {}) };
            delete clean.groqKey; delete clean.geminiKey;
            if (/\b(gsk_|sk-|AIza)|senha|password/i.test(String(clean.meetingContext || "") + String(clean.myContext || ""))) throw new Error("Sem senhas ou chaves no contexto da reunião.");
            settings.update(clean);
            if (meetingWindow && !meetingWindow.isDestroyed() && Object.prototype.hasOwnProperty.call(clean, "opacity")) meetingWindow.setOpacity(Math.min(1, Math.max(0.3, Number(clean.opacity) || 1)));
            return settings.publicView();
          },
        },
        getTelegramToken: () => { try { return vault.getKey("telegram") || ""; } catch { return ""; } },
        getLlmKey: (k) => { try { return (k === "nvidia" || k === "gemini") ? (vault.getKey(k) || "") : ""; } catch { return ""; } },
        runVagasAuto: (info) => (jobsHost ? jobsHost.runAuto(info) : Promise.resolve({ ok: false })),
        stopVagasAuto: () => (jobsHost ? jobsHost.stopAuto() : null),
        // Leva Q: login em lote nas plataformas (cofre só no main; servidor nunca vê senha).
        loginVagas: (platformId, opts) => (jobsHost ? jobsHost.login(platformId, opts) : Promise.resolve({ ok: false, error: "Navegador das vagas indisponível.", motivo: "indisponivel" })),
        loginVagasTodas: (opts) => (jobsHost ? jobsHost.loginTodas(opts) : Promise.resolve([])),
        // LEVA S: executor LinkedIn so leitura (persist:vagas) e rodada automatica autorizada.
        vagasRunner: async ({ tipo, fonte }) => {
          if (tipo !== "linkedin" || !jobsHost || typeof jobsHost.scanLinkedInKind !== "function") return null;
          return jobsHost.scanLinkedInKind(fonte, {});
        },
        runAutoVagas: () => (jobsHost && jobsHost.runAuto ? jobsHost.runAuto({ origem: "leva-s" }) : Promise.resolve({ ok: false, error: "indisponivel" })),
        abrirLoginVagas: (id) => (jobsHost && jobsHost.abrirLogin ? jobsHost.abrirLogin(id) : Promise.resolve({ ok: false, error: "indisponivel" })),
        sessoesVagas: () => (jobsHost && jobsHost.sessoes ? jobsHost.sessoes() : Promise.resolve([])),
        diagnosticoVagas: (d) => (jobsHost && jobsHost.diagnostico ? jobsHost.diagnostico(d) : Promise.resolve({ ok: false })),
        // Leva Q6: fecha o HELIOS normalmente (flush de cookies no before-quit), para reinstalar sem taskkill /F.
        sairApp: () => { setTimeout(() => quitApp(), 300); return { ok: true }; },
        listVagasPlatforms: () => (jobsHost ? jobsHost.platforms() : {}),
        // Leva G: client do Google do próprio Helison (cofre), e-mails e feed lidos aqui no processo principal.
        getUserClients: () => { try { return { google: vault.getKey("googleClientId") || "", googleSecret: vault.getKey("googleClientSecret") || "", github: vault.getKey("githubClientId") || "" }; } catch { return {}; } },
        scanEmails: () => codeReader.scanInbox(),
        scanFeed: () => (jobsHost ? jobsHost.scanFeed() : Promise.resolve({ ok: false, error: "Navegador das vagas indisponível." })),
        platforms: {
          list: () => vault.platforms(),
          save: (entry) => vault.savePlatform({ nome: entry.nome, url: entry.url, usuario: entry.usuario, senha: entry.senha }),
          remove: (nome) => vault.removePlatform(nome),
        },
        vaultSaveCpf: async (cpf) => {
          const clean = String(cpf || "").replace(/\D/g, "");
          if (clean.length !== 11) throw new Error("CPF inválido para o cofre.");
          await vault.setKey("cpf", clean);
          return { ok: true };
        },
        vaultSavePlatform: (entry) => vault.savePlatform({ nome: entry.nome, url: entry.url, usuario: entry.usuario, senha: entry.senha || "" }),
        port: settings.get("port"),
        mock: process.env.HELIOS_MOCK === "1",
        operacional: process.env.HELIOS_MOCK !== "1",
        modelosGratisObrigatorios: process.env.HELIOS_MOCK !== "1",
        getAccounts: () => vault.getAccounts(),
        onAccountsChange: (snapshot) => vault.setAccounts(snapshot),
        getVaultIndex: () => vault.index(),
        getApiToken: () => vault.apiToken(),
        getMcpToken: () => vault.mcpToken(),
        getMcpRemoteToken: () => vault.mcpRemoteToken(),
        // LEVA O5/O6: tokens nomeados no cofre (github, vercel, clickup). Nunca logar o valor.
        getVaultToken: (name) => {
          try {
            const wanted = String(name || "").trim().toLowerCase();
            if (!wanted) return "";
            for (const row of vault.index()) {
              if (row.tipo !== "token") continue;
              if (!String(row.nome || "").toLowerCase().includes(wanted)) continue;
              const full = vault.getToken(row.id);
              return full && full.valor ? String(full.valor) : "";
            }
            return "";
          } catch { return ""; }
        },
        secretSealer: vault.sealer,
        pickFolder: contextHost.pickFolder,
        trashItem: contextHost.trashItem,
        blockedFolders: protectedFolders(),
        onFillLogin: (request) => fillLogin(vault, request),
        openExternal: (url) => shell.openExternal(url),
        oauthClients: loadOAuthClients({
          file: path.join(__dirname, "..", "config", "oauth-clients.json"),
          userFile: path.join(dir, "oauth-clients.json"),
        }),
        readClipboard: () => {
          try { return clipboard.readText(); } catch { return ""; }
        },
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

    // Leva Q3: migração única das partições antigas (persist:vagas-<site>) → persist:vagas, antes de abrir janelas.
    try {
      await migrateVagasSession({ userData: dir, session });
    } catch (err) {
      console.error(`[vagas] migração de sessão: ${err && err.message ? err.message : err}`);
    }

    // Fase 7: navegador das vagas (login com o cofre no processo principal; 2FA e captcha ficam com o Helison).
    // LEVA R2: freeLlm com chaves do cofre (nvidia/gemini) — nunca logadas; fill usa planFillLlm.
    const jobsFreeLlm = createFreeLlm({
      getKey: (k) => {
        try { return (k === "nvidia" || k === "gemini") ? (vault.getKey(k) || "") : ""; } catch { return ""; }
      },
    });
    jobsHost = registerJobs({
      ipcMain,
      BrowserWindow,
      vault,
      serverUrl: () => server.url,
      getApiToken: () => vault.apiToken(),
      mock: process.env.HELIOS_MOCK === "1",
      isQuitting: () => quitting,
      session,
      codeReader,
      freeLlm: jobsFreeLlm,
      readProfile: () => {
        try { return fs.readFileSync(path.join(app.getPath("documents"), "HELIOS", "contexto.md"), "utf8"); } catch { return ""; }
      },
    });

    agentBrowser = createAgentBrowser({
      BrowserWindow, jobsHost, codeReader, partitionFor,
      mock: process.env.HELIOS_MOCK === "1",
      isQuitting: () => quitting,
      log: (line) => console.error(line),
      authorizedDomainsFor: (assistantId) => {
        try { return server?.authorizedSites?.list?.(assistantId || "default") || []; } catch { return []; }
      },
    });
    agentBrowserProxy.requestStream = (rec) => {
      if (!agentBrowser || !server?.agents?.setThumb) return false;
      return agentBrowser.startStream(rec.id, (t) => server.agents.setThumb(rec.id, t));
    };
    agentBrowserProxy.snapshot = (id) => (agentBrowser ? agentBrowser.snapshot(id) : Promise.resolve(""));
    agentBrowserProxy.takeover = (id) => (agentBrowser ? agentBrowser.takeover(id) : Promise.resolve({ ok: false, thumb: "" }));

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
    // LEVA O1: MCP remoto — UI só vê "definido"; valor só na cópia/geração pontual.
    ipcMain.handle("mcp:remote-status", async () => {
      const cfg = server?.mcpRemote?.view?.() || { enabled: false, ratePerMin: 30, allowlist: [] };
      return { ...cfg, definido: vault.hasMcpRemoteToken(), url: `${server.url}/mcp` };
    });
    ipcMain.handle("mcp:remote-generate", async () => {
      const out = await vault.generateMcpRemoteToken();
      return { definido: true, persisted: out.persisted, token: out.token, url: `${server.url}/mcp` };
    });
    ipcMain.handle("mcp:remote-revoke", async () => {
      const out = await vault.revokeMcpRemoteToken();
      return { definido: false, persisted: out.persisted };
    });
    ipcMain.handle("mcp:remote-copy", async () => {
      const tok = vault.peekMcpRemoteToken();
      if (!tok) return { ok: false, error: "Token remoto ainda não foi gerado." };
      try {
        require("electron").clipboard.writeText(tok);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || "Não consegui copiar." };
      }
    });
    ipcMain.handle("mcp:remote-set", async (_event, patch) => {
      if (patch && patch.enabled !== undefined) server.mcpRemote.setEnabled(patch.enabled);
      if (patch && patch.ratePerMin !== undefined) server.mcpRemote.setRatePerMin(patch.ratePerMin);
      return { ...server.mcpRemote.view(), definido: vault.hasMcpRemoteToken() };
    });

    createMainWindow();
    if (vault.isBlocked()) {
      dialog.showMessageBox({ type: "warning", title: APP_NAME, message: "O cofre não abriu", detail: vault.blockedMessage() }).catch(() => {});
    }
    if (process.env.HELIOS_TEST_OFFSCREEN !== "1") createTray();
    failedHotkeys = registerHotkeys();

    // Disparo operacional explícito para uma rodada real, acionado somente quando
    // o processo é iniciado com HELIOS_FORCE_VAGAS=1. O token nunca sai do main.
    if (process.env.HELIOS_FORCE_VAGAS === "1") {
      setTimeout(async () => {
        const reportPath = process.env.HELIOS_FORCE_VAGAS_REPORT || path.join(app.getPath("userData"), "force-vagas-report.json");
        const api = async (method, route, body) => {
          const response = await fetch(`${server.url}${route}`, {
            method,
            headers: { "content-type": "application/json", authorization: `Bearer ${vault.apiToken()}` },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${data.error || ""}`.trim());
          return data;
        };
        try {
          const before = await api("GET", "/api/vagas");
          const beforeMap = new Map((before.vagas || []).map((v) => [v.id, v.status]));
          await api("POST", "/api/agente/vagas/modo", { modo: "automatico" });
          await api("POST", "/api/agente/vagas/pausar", { pausado: false });
          const scan = await api("POST", "/api/agente/vagas/ciclo", { forcar: true, completa: true });
          const started = await api("POST", "/api/vagas/auto/rodar", { origem: "ciclo-agora" });
          let after = before;
          const deadline = Date.now() + 5 * 60 * 1000;
          while (Date.now() < deadline) {
            after = await api("GET", "/api/vagas");
            if (!after.autoRodando) break;
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          const chefeCiclo = await api("POST", "/api/chefe/ciclo", { forcar: true });
          const chefe = await api("GET", "/api/chefe");
          const added = (after.vagas || []).filter((v) => !beforeMap.has(v.id));
          const changed = (after.vagas || []).filter((v) => beforeMap.has(v.id) && beforeMap.get(v.id) !== v.status);
          const byPlatform = (rows) => rows.reduce((out, v) => {
            const key = v.platform || "desconhecida";
            out[key] = (out[key] || 0) + 1;
            return out;
          }, {});
          const sent = changed.filter((v) => v.status === "enviada");
          const critical = changed.filter((v) => v.status === "critica");
          const failed = changed.filter((v) => v.status === "falhou");
          const report = {
            ok: true,
            iniciado: started,
            scans: [{ ok: scan.ok, feitos: scan.feitos || [], erros: scan.erros || [] }],
            encontrouNestaRodada: added.length,
            encontradasPorPlataforma: byPlatform(added),
            inscricoesConfirmadasNestaRodada: sent.length,
            inscritasPorPlataforma: byPlatform(sent),
            casosCriticosNestaRodada: critical.map((v) => ({ plataforma: v.platform, empresa: v.company, titulo: v.title, motivo: v.critico?.motivo || "" })),
            falhasNestaRodada: failed.map((v) => ({ plataforma: v.platform, empresa: v.company, titulo: v.title, nota: v.nota || "" })),
            filaRestante: (after.vagas || []).filter((v) => v.status === "nova").length,
            chefe: { resumo: chefe.ultimoResumo || "", ciclo: chefeCiclo.resumo || "", resultadosRecentes: chefe.ultimosResultados || [] },
          };
          fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
        } catch (err) {
          fs.writeFileSync(reportPath, JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2), "utf8");
        }
      }, 1800);
    }
  }).catch((err) => {
    dialog.showErrorBox(APP_NAME, err.message || String(err));
    quitApp();
  });

  app.on("second-instance", () => showMain());
  let cookiesSalvos = false;
  app.on("before-quit", (event) => {
    quitting = true;
    // Leva Q5: salva os cookies da persist:vagas antes de sair (no maximo 3 s).
    if (cookiesSalvos || !jobsHost || !jobsHost.flushCookies) return;
    event.preventDefault();
    cookiesSalvos = true;
    Promise.race([jobsHost.flushCookies({ final: true }), new Promise((r) => setTimeout(r, 3000))]).catch(() => {}).finally(() => app.quit());
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (jobsHost) jobsHost.close();
    if (agentBrowser) agentBrowser.closeAll();
    if (server) server.close();
  });
  app.on("window-all-closed", () => {
    /* a bandeja mantém o processo */
  });
}
