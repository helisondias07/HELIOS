"use strict";
/**
 * LEVA P: prints light — Conectores + card Oasis (Entrar com ClickUp).
 * electron scripts/levaP-shots.js
 * Porta 48101+. Nunca 47331. Sem electron -e.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startServer } = require("../server/index");

const PORT = Number(process.env.HELIOS_SHOT_PORT) || 48101;
const OUT = process.env.HELIOS_SHOT_DIR || path.join(require("node:os").tmpdir(), "helios-levaP-shots");
const UD = process.env.HELIOS_USER_DATA || path.join(require("node:os").tmpdir(), "helios-levaP-ud");

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
    getMcpToken: () => "shot-token-levaP",
    getApiToken: () => "shot-token-levaP",
    getVaultIndex: () => [],
  });
  const token = server.apiToken();
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

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
    },
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await sleep(2500);

  async function js(code) {
    return win.webContents.executeJavaScript(code, true);
  }
  async function shot(name) {
    if (!win.isVisible()) win.showInactive();
    await sleep(400);
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, name);
    fs.writeFileSync(file, img.toPNG());
    return file;
  }

  await js(`document.documentElement.setAttribute("data-theme","light"); localStorage.setItem("helios-theme","light"); true`);
  await sleep(400);

  // Abre Conectores (Ajustes › Conectores ou layout go)
  await js(`
    try {
      if (window.HeliosLayout && window.HeliosLayout.openSettings) window.HeliosLayout.openSettings("mcp");
      else if (window.HeliosLayout && window.HeliosLayout.go) window.HeliosLayout.go("mcp");
    } catch (e) {}
    true
  `);
  await sleep(1200);
  // Garante grade de conectores
  const probe1 = await js(`
    (() => {
      const grid = document.querySelector(".connect-grid");
      const clickup = document.querySelector('[data-preset="clickup"]');
      const github = document.querySelector('[data-preset="github"]');
      const vercel = document.querySelector('[data-preset="vercel"]');
      return {
        hasGrid: !!grid,
        clickup: clickup ? clickup.innerText.slice(0, 80) : "",
        github: github ? github.innerText.slice(0, 80) : "",
        vercel: vercel ? vercel.innerText.slice(0, 80) : "",
        text: (document.getElementById("view") || document.body).innerText.slice(0, 200),
      };
    })()
  `);
  fs.writeFileSync(path.join(OUT, "probe-01.json"), JSON.stringify(probe1, null, 2));
  const f1 = await shot("01-conectores-light.png");

  // Card Oasis no Chefe
  await js(`
    try { window.HeliosLayout && window.HeliosLayout.closeSettings(false); } catch (e) {}
    try {
      if (window.HeliosChefe && window.HeliosChefe.open) window.HeliosChefe.open();
      else if (window.HeliosLayout) window.HeliosLayout.go("chefe");
    } catch (e) {}
    true
  `);
  await sleep(1500);
  const probe2 = await js(`
    (() => {
      const oasis = document.querySelector('[data-agent="oasis"]');
      const btn = document.querySelector('[data-entrar-conector="clickup"]');
      return {
        oasis: oasis ? oasis.innerText.slice(0, 160) : "",
        entrarClickup: !!btn,
        text: (document.getElementById("view") || document.body).innerText.slice(0, 240),
      };
    })()
  `);
  fs.writeFileSync(path.join(OUT, "probe-02.json"), JSON.stringify(probe2, null, 2));
  const f2 = await shot("02-card-oasis-light.png");

  console.log(JSON.stringify({ out: OUT, shots: [f1, f2], probe1, probe2 }));
  try { await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers }).catch(() => {}); } catch { /* */ }
  try { server.close?.(); } catch { /* */ }
  app.quit();
}

app.whenReady().then(() => main().catch((err) => {
  fs.writeFileSync(path.join(OUT, "error.txt"), String(err && err.stack ? err.stack : err), "utf8");
  console.error(err);
  app.exit(1);
}));
