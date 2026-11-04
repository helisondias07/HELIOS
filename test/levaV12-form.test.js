"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const nav = require("../server/form-navigator");
const { runApplication } = require("../server/application-run");

const HTML = `<!doctype html><html><head><title>Vaga local</title></head><body>
<header><nav>
<a href="#top">Ir para o conteúdo principal</a>
<a href="/">Página inicial</a>
<a href="/emp">Avaliações de Empresas</a>
<a href="/sal">Cargos e salários</a>
<a href="/msg">Mensagens</a>
</nav></header>
<main>
<h1>Desenvolvedor Front-end remoto</h1>
<button id="apply" type="button">Candidatar-se</button>
<form id="form" hidden>
<label>Nome completo *<input name="nome" required></label>
<label>E-mail *<input name="email" type="email" required></label>
<label>Currículo *<input id="cv" name="cv" type="file" required></label>
<button id="send" type="submit">Enviar candidatura</button>
</form>
<p id="done" hidden>Candidatura enviada com sucesso</p>
</main>
<script>
document.getElementById("apply").onclick = () => { document.getElementById("form").hidden = false; };
document.getElementById("form").onsubmit = (event) => {
  event.preventDefault();
  const file = document.getElementById("cv");
  if (!file.files.length && file.dataset.filled !== "1") return;
  document.getElementById("form").hidden = true;
  document.getElementById("done").hidden = false;
};
</script>
</body></html>`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(html) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function cdpSocket(ws) {
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || "cdp"));
    else resolve(message.result || {});
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = seq + 1;
    seq = id;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function jsonWhenReady(url) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch { /* chrome ainda subindo */ }
    await sleep(100);
  }
  throw new Error("o Chrome não abriu o depurador");
}

test("levaV12: candidatura real num formulário local só passa na confirmação", { timeout: 40000, skip: process.platform === "win32" ? "fixture CDP usa google-chrome; coberto pela validação Electron no Windows" : false }, async () => {
  const served = await listen(HTML);
  const cvDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-cv-"));
  const cvPath = path.join(cvDir, "cv.pdf");
  fs.writeFileSync(cvPath, "%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-chrome-"));
  const chrome = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDir}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let pageWs;
  try {
    const portMatch = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const found = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (found) return found[1];
        await sleep(100);
      }
      throw new Error(`Chrome sem porta de depuração. ${stderr.slice(0, 200)}`);
    })();
    const version = await jsonWhenReady(`http://127.0.0.1:${portMatch}/json/version`);
    const browser = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { browser.addEventListener("open", resolve); browser.addEventListener("error", reject); });
    const browserSend = cdpSocket(browser);
    const target = await browserSend("Target.createTarget", { url: `http://127.0.0.1:${served.port}/` });
    const list = await jsonWhenReady(`http://127.0.0.1:${portMatch}/json/list`);
    const page = list.find((item) => item.id === target.targetId) || list.find((item) => item.type === "page" && item.url.includes("127.0.0.1"));
    pageWs = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { pageWs.addEventListener("open", resolve); pageWs.addEventListener("error", reject); });
    const send = cdpSocket(pageWs);
    await send("Runtime.enable");
    await send("DOM.enable");
    const evalJs = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "script");
      return result.result && result.result.value;
    };
    const result = await runApplication({
      vaga: { title: "Desenvolvedor Front-end", company: "Empresa Local", location: "Remoto", url: `http://127.0.0.1:${served.port}/` },
      profile: { nome: "Pessoa Exemplo", email: "pessoa@exemplo.test", cvPath },
      enviar: true,
      io: {
        load: async (url) => {
          await send("Page.enable").catch(() => {});
          await send("Page.navigate", { url });
          for (let i = 0; i < 20; i += 1) {
            const state = await evalJs("document.readyState");
            if (state === "complete" || state === "interactive") break;
            await sleep(100);
          }
          return { ok: true };
        },
        snapshot: () => evalJs(nav.SNAPSHOT_SCRIPT),
        click: (sel) => evalJs(nav.clickScript(sel)),
        apply: (acoes) => evalJs(nav.applyScript(acoes)),
        setFile: async (sel) => {
          const doc = await send("DOM.getDocument", { depth: 1 });
          const found = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
          if (!found.nodeId) throw new Error("campo de arquivo sumiu");
          await send("DOM.setFileInputFiles", { nodeId: found.nodeId, files: [cvPath] });
          await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.dataset.filled = "1"; return true; })()`);
        },
        sleep,
      },
    });
    assert.equal(result.enviado, true, result.critico || result.nota || "sem confirmação");
    assert.match(result.confirmacao, /enviada/i);
    assert.equal(result.codigo, undefined);
    browser.close();
  } finally {
    if (pageWs) pageWs.close();
    chrome.kill();
    await sleep(400);
    served.server.close();
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch { /* o Chrome ainda solta o perfil */ }
    try { fs.rmSync(cvDir, { recursive: true, force: true }); } catch { /* temporário */ }
  }
});
