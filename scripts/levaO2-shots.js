"use strict";
/**
 * LEVA O2: prints light/dark da tela do Chefe.
 * Roda com: electron scripts/levaO2-shots.js
 * Não usa electron -e. Porta 47941+. Nunca 47331.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startServer } = require("../server/index");

const PORT = Number(process.env.HELIOS_SHOT_PORT) || 47941;
const OUT = process.env.HELIOS_SHOT_DIR || path.join(require("node:os").tmpdir(), "helios-levaO2-shots");
const UD = process.env.HELIOS_USER_DATA || path.join(require("node:os").tmpdir(), "helios-levaO2-ud");

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, "settings.json"), JSON.stringify({ port: PORT, closeToTray: false }, null, 2));
app.setPath("userData", UD);

async function main() {

  const server = await startServer({
    dataDir: UD,
    port: PORT,
    mock: true,
    chefeMs: 0,
    getMcpToken: () => "shot-token-levaO2",
    getApiToken: () => "shot-token-levaO2",
    getVaultIndex: () => [],
  });

  // Seed: um resultado e uma pendência visual para o print.
  try {
    // servidor já tem quadro; usa API
    await fetch(`http://127.0.0.1:${PORT}/api/quadro`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.apiToken()}` },
      body: JSON.stringify({
        de: "pesquisa",
        para: "helison",
        tipo: "resultado",
        assunto: "Lacunas da semana",
        corpo: "Skills pedidas nas vagas lidas — sem inventar percentuais sem contagem.",
      }),
    });
  } catch { /* seed opcional */ }

  ipcMain.handle("api", async (_e, { method, pathname, body }) => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
        method: method || "GET",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.apiToken()}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data, error: data.error || (res.ok ? "" : `HTTP ${res.status}`) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
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
  await new Promise((r) => setTimeout(r, 1800));

  async function shot(theme, name) {
    await win.webContents.executeJavaScript(`document.documentElement.setAttribute("data-theme","${theme}"); localStorage.setItem("helios-theme","${theme}"); true`);
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, name);
    fs.writeFileSync(file, img.toPNG());
    return file;
  }

  const light = await shot("light", "chefe-light.png");
  const dark = await shot("dark", "chefe-dark.png");
  // Ajustes › Avançado (light)
  await win.webContents.executeJavaScript(`document.documentElement.setAttribute("data-theme","light"); true`);
  await win.webContents.executeJavaScript(`window.HeliosLayout && window.HeliosLayout.openSettings("account"); true`);
  await new Promise((r) => setTimeout(r, 500));
  await win.webContents.executeJavaScript(`const d=document.getElementById("lfAdv"); if(d) d.open=true; true`);
  await new Promise((r) => setTimeout(r, 300));
  const adv = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "ajustes-avancado-light.png"), adv.toPNG());

  console.log(JSON.stringify({ ok: true, out: OUT, files: [light, dark, path.join(OUT, "ajustes-avancado-light.png")] }));
  try { await server.close(); } catch { /* ok */ }
  app.exit(0);
}

app.whenReady().then(() => main().catch((err) => {
  console.error(err);
  app.exit(1);
}));
