"use strict";
/**
 * LEVA P3: print light do Chefe.
 * electron scripts/levaP3-shots.js
 * Porta 48161. Nunca 47331. Sem electron -e.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startServer } = require("../server/index");

const PORT = Number(process.env.HELIOS_SHOT_PORT) || 48161;
const OUT = process.env.HELIOS_SHOT_DIR || path.join(require("node:os").tmpdir(), "helios-levaP3-shots");
const UD = process.env.HELIOS_USER_DATA || path.join(require("node:os").tmpdir(), "helios-levaP3-ud");

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, "settings.json"), JSON.stringify({ port: PORT, closeToTray: false }, null, 2));
app.setPath("userData", UD);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await startServer({
    dataDir: UD,
    port: PORT,
    mock: true,
    chefeMs: 0,
    getMcpToken: () => "shot-token-levaP3",
    getApiToken: () => "shot-token-levaP3",
    getVaultIndex: () => [],
  });

  const token = server.apiToken();
  ipcMain.handle("api", async (_e, { method, pathname, body }) => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
        method: method || "GET",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data, error: data.error || (res.ok ? "" : `HTTP ${res.status}`) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.on("window:theme", () => {});
  const handlers = {
    "meeting:open": async () => ({ ok: true }),
    "settings:get": async () => ({ provider: "groq" }),
    "settings:set": async () => ({ ok: true }),
    "settings:test": async () => ({ ok: true }),
    "shell:open": async () => ({ ok: true }),
    "contexto:salvar": async () => ({ ok: true }),
    "vault:list": async () => ({ logins: [], keys: {}, platforms: [] }),
    "vault:get": async () => null,
    "vault:save": async () => ({ ok: true }),
    "vault:remove": async () => ({ ok: true }),
    "vault:start-fresh": async () => ({ ok: true }),
    "vault:set-key": async () => ({ ok: true }),
    "vagas:login": async () => ({ ok: true }),
    "vagas:abrir": async () => ({ ok: true }),
    "vagas:janela": async () => ({ ok: true }),
    "vagas:auto": async () => ({ ok: true }),
    "vagas:feed": async () => ({ ok: true }),
    "mcp:access": async () => ({ ok: true }),
    "mcp:regenerate": async () => ({ ok: true }),
    "mcp:remote-status": async () => ({ tokenDefinido: false, enabled: false }),
    "mcp:remote-generate": async () => ({ ok: true }),
    "mcp:remote-revoke": async () => ({ ok: true }),
    "mcp:remote-copy": async () => ({ ok: true }),
    "mcp:remote-set": async () => ({ ok: true }),
    "voice:status": async () => ({ ok: true, phase: "off" }),
    "voice:transcribe": async () => ({ text: "" }),
    "voice:speak": async () => ({ ok: true }),
    "dictation:refresh": async () => ({ ok: true }),
  };
  for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#F7F4EE",
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "preload-main.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true,
    },
  });

  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await sleep(2200);

  async function js(code) {
    return win.webContents.executeJavaScript(code, true);
  }

  await js(`
    document.documentElement.setAttribute("data-theme","light");
    localStorage.setItem("helios-theme","light");
    localStorage.setItem("helios-right-v1","0");
    document.body.classList.add("lf-right-off");
    true
  `);
  await js(`
    try { window.HeliosLayout && window.HeliosLayout.closeSettings(false); } catch (e) {}
    try {
      if (window.HeliosChefe && window.HeliosChefe.open) window.HeliosChefe.open();
      else if (window.HeliosLayout && window.HeliosLayout.go) window.HeliosLayout.go("chefe");
    } catch (e) {}
    true
  `);
  await sleep(1200);

  if (!win.isVisible()) win.showInactive();
  await sleep(400);
  const img = await win.webContents.capturePage();
  const file = path.join(OUT, "01-chefe-light.png");
  fs.writeFileSync(file, img.toPNG());
  console.log("shot", file);

  win.destroy();
  await server.close?.();
  app.quit();
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
