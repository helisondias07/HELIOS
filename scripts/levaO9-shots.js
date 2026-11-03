"use strict";
/**
 * LEVA O9: prints light/dark do Chefe + Ajustes (colapsado e Avançado expandido).
 * Roda com: electron scripts/levaO9-shots.js
 * Não usa electron -e. Porta 48081+. Nunca 47331.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startServer } = require("../server/index");

const PORT = Number(process.env.HELIOS_SHOT_PORT) || 48081;
const OUT = process.env.HELIOS_SHOT_DIR || path.join(require("node:os").tmpdir(), "helios-levaO9-shots");
const UD = process.env.HELIOS_USER_DATA || path.join(require("node:os").tmpdir(), "helios-levaO9-ud");

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
    getMcpToken: () => "shot-token-levaO9",
    getApiToken: () => "shot-token-levaO9",
    getVaultIndex: () => [],
  });

  const token = server.apiToken();
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

  try {
    await fetch(`http://127.0.0.1:${PORT}/api/quadro`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        de: "pesquisa",
        para: "helison",
        tipo: "resultado",
        assunto: "Lacunas da semana",
        corpo: "3 lacuna(s) em 12 vaga(s) lidas.",
        ref: "semana:2026-W44:helison",
        idempotente: true,
      }),
    });
    await fetch(`http://127.0.0.1:${PORT}/api/quadro`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        de: "pesquisa",
        para: "helison",
        tipo: "resultado",
        assunto: "Lacunas da semana",
        corpo: "duplicata",
        ref: "semana:2026-W44:helison",
        idempotente: true,
      }),
    });
  } catch { /* seed opcional */ }

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
      offscreen: false,
    },
  });
  win.webContents.on("console-message", (_e, _level, message) => {
    if (/error|fail|throw/i.test(String(message))) console.error("[renderer]", message);
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => console.error("did-fail-load", code, desc));
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await sleep(2500);

  async function js(code) {
    return win.webContents.executeJavaScript(code, true);
  }

  async function ensureTheme(theme) {
    await js(`
      document.documentElement.setAttribute("data-theme","${theme}");
      localStorage.setItem("helios-theme","${theme}");
      true
    `);
    await sleep(500);
  }

  async function shot(name) {
    // showInactive: com show:false o overlay do modal às vezes não entra no capturePage.
    if (!win.isVisible()) win.showInactive();
    await sleep(350);
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, name);
    fs.writeFileSync(file, img.toPNG());
    return file;
  }

  async function pageProbe() {
    return js(`
      (() => {
        const m = document.getElementById("lfModal");
        const adv = document.getElementById("lfAdv");
        const title = document.getElementById("title");
        return {
          modalHidden: !m || !!m.hidden,
          advOpen: !!(adv && adv.open),
          advText: adv ? String(adv.textContent || "").replace(/\\s+/g, " ").slice(0, 120) : "",
          title: title ? title.textContent : "",
          hasConta: !!(m && m.querySelector('[data-set="account"]')),
          hasVault: !!(m && m.querySelector('[data-set="vault"]')),
          theme: document.documentElement.getAttribute("data-theme"),
        };
      })()
    `);
  }

  async function openChefe() {
    await js(`
      try { window.HeliosLayout && window.HeliosLayout.closeSettings(false); } catch (e) {}
      try {
        if (window.HeliosChefe && window.HeliosChefe.open) window.HeliosChefe.open();
        else if (window.HeliosLayout && window.HeliosLayout.go) window.HeliosLayout.go("chefe");
      } catch (e) {}
      true
    `);
    await sleep(900);
  }

  async function openAjustesCollapsed() {
    // Clica no botão real da UI (mais confiável que só a API).
    const ok = await js(`
      (() => {
        try {
          const btn = document.getElementById("lfSettings");
          if (!btn) return "sem-botao";
          btn.click();
          const adv = document.getElementById("lfAdv");
          if (adv) adv.open = false;
          const m = document.getElementById("lfModal");
          if (!m || m.hidden) return "modal-fechado";
          const nav = document.getElementById("lfMnav");
          if (!nav || !/Ajustes/.test(nav.textContent || "")) return "sem-nav";
          return "ok";
        } catch (e) { return "err:" + (e && e.message); }
      })()
    `);
    if (ok !== "ok") {
      // Fallback API
      await js(`
        document.documentElement.setAttribute("data-theme","light");
        if (window.HeliosLayout) window.HeliosLayout.openSettings("account");
        const adv = document.getElementById("lfAdv");
        if (adv) adv.open = false;
        true
      `);
      await sleep(800);
      const ok2 = await js(`
        (() => {
          const m = document.getElementById("lfModal");
          return m && !m.hidden ? "ok" : "fail";
        })()
      `);
      if (ok2 !== "ok") throw new Error(`Ajustes não abriu (${ok}/${ok2})`);
    }
    await sleep(700);
    return ok;
  }

  async function expandAvancado() {
    const ok = await js(`
      (() => {
        try {
          const d = document.getElementById("lfAdv");
          if (!d) return "sem-adv";
          d.open = true;
          const sum = d.querySelector("summary");
          if (sum && !d.open) sum.click();
          d.open = true;
          const m = document.getElementById("lfModal");
          if (!m || m.hidden) return "modal-fechado";
          if (!d.open) return "nao-abriu";
          // Garante itens avançados visíveis
          const hasVault = !!d.querySelector('[data-set="vault"]');
          return hasVault ? "ok" : "sem-itens";
        } catch (e) { return "err:" + (e && e.message); }
      })()
    `);
    if (ok !== "ok") throw new Error(`Avançado não expandiu (${ok})`);
    await sleep(600);
    return ok;
  }

  await openChefe();
  await ensureTheme("light");
  const f1 = await shot("01-chefe-light.png");

  await ensureTheme("dark");
  const f2 = await shot("02-chefe-dark.png");

  await ensureTheme("light");
  await openChefe();
  await ensureTheme("light");
  win.showInactive();
  const a1 = await openAjustesCollapsed();
  await sleep(900);
  const probe3 = await pageProbe();
  if (probe3.modalHidden) throw new Error(`Modal fechado antes do 03: ${JSON.stringify(probe3)}`);
  if (probe3.theme !== "light") throw new Error(`Tema não é light: ${probe3.theme}`);
  if (probe3.advOpen) {
    await js(`const d=document.getElementById("lfAdv"); if(d) d.open=false; true`);
    await sleep(300);
  }
  const f3 = await shot("03-ajustes-light.png");
  fs.writeFileSync(path.join(OUT, "probe-03.json"), JSON.stringify(await pageProbe(), null, 2));

  const a2 = await expandAvancado();
  // Abre um item de Avançado (Atividade) para o print deixar claro que a seção expandiu.
  await js(`
    if (window.HeliosLayout) window.HeliosLayout.openSettings("activity");
    const d = document.getElementById("lfAdv");
    if (d) d.open = true;
    true
  `);
  await sleep(900);
  const probe4 = await pageProbe();
  if (probe4.modalHidden || !probe4.advOpen) throw new Error(`Avançado/modal falhou no 04: ${JSON.stringify(probe4)}`);
  const f4 = await shot("04-ajustes-avancado-light.png");
  fs.writeFileSync(path.join(OUT, "probe-04.json"), JSON.stringify(probe4, null, 2));

  console.log(JSON.stringify({
    ok: true,
    out: OUT,
    files: [f1, f2, f3, f4],
    openAjustes: a1,
    expandAvancado: a2,
    probe3,
    probe4,
  }));
  try { await server.close(); } catch { /* ok */ }
  app.exit(0);
}

app.whenReady().then(() => main().catch((err) => {
  const msg = err && err.stack ? err.stack : String(err);
  console.error(msg);
  try {
    fs.writeFileSync(path.join(OUT, "error.txt"), msg, "utf8");
  } catch { /* ok */ }
  app.exit(1);
}));
