"use strict";

/**
 * LEVA I + L: navegador próprio de cada agente, no processo principal.
 * LEVA L: sessão/perfil isolado por tarefa (descartado no fim) + reaproveitar login
 * só em sites autorizados (cookies do perfil principal copiados só para esses domínios).
 */
const fs = require("node:fs");
const path = require("node:path");

const READ_SCRIPT = (foco) => `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  let n = Number(document.documentElement.dataset.heliosSeq || 0);
  const sel = (el) => { if (!el.dataset.heliosId) { n += 1; el.dataset.heliosId = String(n); } return '[data-helios-id="' + el.dataset.heliosId + '"]'; };
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || el.title || "").trim().replace(/\\s+/g, " ").slice(0, 80);
  const items = [];
  for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"]')) {
    if (!vis(el) || items.length >= 120) continue;
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.type || "text") : tag;
    if (type === "hidden") continue;
    const secret = type === "password" || /one-time-code/.test(el.autocomplete || "");
    items.push((secret ? "[campo protegido] " : "") + type + ' "' + (secret ? "" : label(el)) + '" ' + sel(el));
  }
  document.documentElement.dataset.heliosSeq = String(n);
  let text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n");
  const foco = ${JSON.stringify(String(foco || ""))}.toLowerCase();
  if (foco) { const i = text.toLowerCase().indexOf(foco); if (i > 0) text = text.slice(Math.max(0, i - 500)); }
  return { title: document.title, url: location.href, text: text.slice(0, 7000), items };
})()`;

const FIND = (seletor, texto) => `(() => {
  const s = ${JSON.stringify(String(seletor || ""))}, t = ${JSON.stringify(String(texto || "").toLowerCase())};
  let el = null;
  if (s) { try { el = document.querySelector(s); } catch { el = null; } }
  if (!el && t) {
    const all = [...document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"], [role="link"], label, summary, [onclick]')];
    el = all.find((x) => (x.innerText || x.value || x.getAttribute("aria-label") || "").trim().toLowerCase() === t)
      || all.find((x) => (x.innerText || x.value || x.getAttribute("aria-label") || "").toLowerCase().includes(t));
  }
  return el;
})()`;

const LABEL_OF = "(el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 120)";

function sessionKey(rec) {
  const task = rec && rec.taskSessionId ? String(rec.taskSessionId) : "";
  return task ? `${rec.id}::${task}` : String(rec.id);
}

function mainPartition(rec) {
  return rec.mainPartition || rec.partition || `persist:agente-${rec.id}`;
}

function taskPartition(rec) {
  // Sessão de tarefa: NÃO persistente — descartada ao fechar.
  return `temp:agente-${rec.id}-task-${rec.taskSessionId}`;
}

function hostOf(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function domainAllowed(host, domains) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!h) return false;
  return (domains || []).some((d) => {
    const n = String(d || "").toLowerCase().replace(/^www\./, "");
    return n && (h === n || h.endsWith(`.${n}`));
  });
}

/**
 * Copia cookies do perfil principal só para domínios autorizados.
 * Nunca copia o perfil inteiro.
 */
async function copyAuthorizedCookies(fromSession, toSession, domains, log) {
  if (!fromSession || !toSession || !domains || !domains.length) return { copied: 0, skipped: 0 };
  let copied = 0;
  let skipped = 0;
  try {
    const all = await fromSession.cookies.get({});
    for (const c of all) {
      const host = String(c.domain || "").replace(/^\./, "").toLowerCase();
      if (!domainAllowed(host, domains)) { skipped += 1; continue; }
      const domain = String(c.domain || "").replace(/^\./, "");
      const url = `http${c.secure ? "s" : ""}://${domain}${c.path || "/"}`;
      try {
        await toSession.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate,
          sameSite: c.sameSite,
        });
        copied += 1;
      } catch (err) {
        skipped += 1;
        log?.(`[agente-navegador] cookie ${c.name}: ${err.message}`);
      }
    }
  } catch (err) {
    log?.(`[agente-navegador] copiar cookies: ${err.message}`);
  }
  return { copied, skipped };
}

function createAgentBrowser({
  BrowserWindow,
  session,
  jobsHost,
  codeReader,
  partitionFor,
  mock = false,
  isQuitting = () => false,
  offscreen = false,
  log = () => {},
  authorizedDomainsFor = () => [],
}) {
  const wins = new Map(); // sessionKey -> { win, partition, rec, taskSessionId }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const electronSession = session || (() => {
    try { return require("electron").session; } catch { return null; }
  })();

  function partitionOf(rec) {
    if (rec.taskSessionId) return taskPartition(rec);
    return mainPartition(rec);
  }

  function winFor(rec) {
    const key = sessionKey(rec);
    const cur = wins.get(key);
    const partition = partitionOf(rec);
    if (cur && !cur.win.isDestroyed() && cur.partition === partition) return cur.win;
    let url = "";
    if (cur && !cur.win.isDestroyed()) { url = cur.win.webContents.getURL(); cur.win.destroy(); }
    const win = new BrowserWindow({
      width: 1280, height: 860, show: false,
      title: `HELIOS · agente ${rec.name || rec.id}${rec.taskSessionId ? ` · tarefa ${rec.taskSessionId}` : ""}`,
      autoHideMenuBar: true,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: Boolean(offscreen) },
    });
    win.webContents.setWindowOpenHandler(({ url: target }) => { if (/^https?:/i.test(target)) win.loadURL(target).catch(() => {}); return { action: "deny" }; });
    win.webContents.session.on("will-download", (_e, item) => {
      const dir = path.join(rec.workDir || "", "downloads");
      try { fs.mkdirSync(dir, { recursive: true }); item.setSavePath(path.join(dir, path.basename(item.getFilename()))); } catch { item.cancel(); }
    });
    win.on("close", (event) => { if (isQuitting()) return; event.preventDefault(); win.hide(); });
    wins.set(key, { win, partition, rec, taskSessionId: rec.taskSessionId || null });
    if (url && /^https?:|^file:/i.test(url)) win.loadURL(url).catch(() => {});
    return win;
  }

  async function maybeReuseLogin(rec, url) {
    if (!rec.taskSessionId || !electronSession) return { reused: false, reason: "sessao-principal" };
    const host = hostOf(url);
    const domains = typeof authorizedDomainsFor === "function"
      ? authorizedDomainsFor(rec.assistantId || "default")
      : [];
    if (!domainAllowed(host, domains)) {
      return { reused: false, reason: "dominio-nao-autorizado", host, domains };
    }
    const mainPart = mainPartition({ ...rec, taskSessionId: null, partition: rec.mainPartition });
    const from = electronSession.fromPartition(mainPart);
    const to = electronSession.fromPartition(taskPartition(rec));
    // Leva Q3: partição única das vagas (persist:vagas). Também aceita lastLoginPlatform por compat.
    const siteParts = [];
    if (typeof partitionFor === "function") {
      try {
        const part = partitionFor(rec.lastLoginPlatform || "geral");
        if (part && !siteParts.includes(part)) siteParts.push(part);
      } catch { /* ok */ }
    }
    let copied = 0;
    const r1 = await copyAuthorizedCookies(from, to, domains, log);
    copied += r1.copied;
    for (const sp of siteParts) {
      const r = await copyAuthorizedCookies(electronSession.fromPartition(sp), to, domains, log);
      copied += r.copied;
    }
    return { reused: copied > 0, copied, host, domains };
  }

  async function settle(win, ms = 1200) {
    const until = Date.now() + 15000;
    while (win.webContents.isLoading() && Date.now() < until) await sleep(200);
    await sleep(ms);
  }

  async function thumb(win) {
    try {
      const img = await win.webContents.capturePage();
      if (img.isEmpty()) return "";
      return img.resize({ width: 480 }).toDataURL();
    } catch { return ""; }
  }

  const js = (win, code) => win.webContents.executeJavaScript(code, true);

  async function exec(rec, op, args = {}) {
    try {
      const win = winFor(rec);
      const out = await run(win, rec, op, args);
      if (!["inspecionar"].includes(op)) out.thumb = out.thumb || await thumb(win);
      out.url = out.url || win.webContents.getURL();
      out.sessionKey = sessionKey(rec);
      out.taskSession = Boolean(rec.taskSessionId);
      return out;
    } catch (e) {
      log(`[agente-navegador] ${op}: ${e.message}`);
      return { ok: false, error: String(e.message || e).slice(0, 300) };
    }
  }

  async function run(win, rec, op, a) {
    if (op === "abrir") {
      const url = String(a.url || "");
      if (!/^(https?:|file:)/i.test(url)) return { ok: false, error: "Só endereços http(s) ou file." };
      const reuse = await maybeReuseLogin(rec, url);
      await win.loadURL(url).catch(() => {});
      await settle(win);
      return {
        ok: true,
        text: `Abri ${win.webContents.getURL()} · ${win.webContents.getTitle()}${reuse.reused ? " (login autorizado reaproveitado)" : reuse.reason === "dominio-nao-autorizado" ? " (domínio sem login autorizado)" : ""}`,
        loginReuse: reuse,
      };
    }
    if (op === "ler") {
      const r = await js(win, READ_SCRIPT(a.foco));
      const blob = `${r.title}\n${r.url}\n${r.text}`;
      const needsHuman = /captcha|cloudflare|verificar que você|2fa|two-factor|digite o código/i.test(blob);
      const out = { ok: true, text: `Título: ${r.title}\nURL: ${r.url}\n\nTexto:\n${r.text}\n\nElementos:\n${r.items.join("\n")}`, url: r.url };
      if (needsHuman) { out.needsHuman = true; out.reason = "captcha/2FA"; }
      return out;
    }
    if (op === "inspecionar") {
      const r = await js(win, `(() => { const el = ${FIND(a.seletor, a.texto)}; if (!el) return null; return { label: (${LABEL_OF})(el), page: (document.body.innerText || "").slice(0, 3000) }; })()`);
      if (!r) return { ok: false, error: "Não achei esse elemento. Use navegador_ler para ver os seletores." };
      return { ok: true, label: r.label, page: r.page, url: win.webContents.getURL() };
    }
    if (op === "clicar") {
      const r = await js(win, `(() => { const el = ${FIND(a.seletor, a.texto)}; if (!el) return null; el.scrollIntoView({ block: "center" }); el.click(); return (${LABEL_OF})(el); })()`);
      if (r === null) return { ok: false, error: "Não achei esse elemento." };
      await settle(win, 900);
      return { ok: true, text: `Cliquei em "${r}". Agora em ${win.webContents.getURL()}` };
    }
    if (op === "digitar") {
      const r = await js(win, `(() => { const el = ${FIND(a.seletor, "")}; if (!el) return "nao"; if (el.type === "password" || /one-time-code/.test(el.autocomplete || "")) return "protegido";
        el.focus(); const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, "value");
        if (d && d.set && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) d.set.call(el, ${JSON.stringify(String(a.texto || ""))}); else el.textContent = ${JSON.stringify(String(a.texto || ""))};
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
        if (${Boolean(a.enter)}) { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); if (el.form) el.form.requestSubmit(); }
        return "ok"; })()`);
      if (r === "nao") return { ok: false, error: "Campo não encontrado." };
      if (r === "protegido") return { ok: false, error: "Campo de senha ou código: use navegador_login ou navegador_codigo." };
      if (a.enter) await settle(win, 900);
      return { ok: true, text: "Digitado." };
    }
    if (op === "selecionar") {
      const r = await js(win, `(() => { const el = ${FIND(a.seletor, "")}; const v = ${JSON.stringify(String(a.valor || ""))}; if (!el) return "nao";
        if (el.tagName === "SELECT") { const o = [...el.options].find((x) => x.value === v || x.text.trim().toLowerCase() === v.toLowerCase()); if (!o) return "opcao"; el.value = o.value; }
        else el.click();
        el.dispatchEvent(new Event("change", { bubbles: true })); return "ok"; })()`);
      if (r !== "ok") return { ok: false, error: r === "opcao" ? "Opção não existe." : "Campo não encontrado." };
      return { ok: true, text: "Escolhido." };
    }
    if (op === "arquivo") {
      if (!fs.existsSync(String(a.caminho || ""))) return { ok: false, error: "Arquivo não existe." };
      const dbg = win.webContents.debugger;
      let attached = false;
      try {
        if (!dbg.isAttached()) { dbg.attach("1.3"); attached = true; }
        const { root } = await dbg.sendCommand("DOM.getDocument", { depth: -1 });
        const { nodeId } = await dbg.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: String(a.seletor || 'input[type="file"]') });
        if (!nodeId) return { ok: false, error: "Campo de arquivo não encontrado." };
        await dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files: [String(a.caminho)] });
      } finally { if (attached) try { dbg.detach(); } catch { /* solto */ } }
      return { ok: true, text: `Anexei ${path.basename(String(a.caminho))}.` };
    }
    if (op === "esperar") {
      const ms = Math.min(30000, Math.max(200, Number(a.ms) || 2000));
      if (a.seletor) {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          if (await js(win, `Boolean(${FIND(a.seletor, "")})`)) return { ok: true, text: "Apareceu." };
          await sleep(300);
        }
        return { ok: false, error: "Não apareceu a tempo." };
      }
      await sleep(ms);
      return { ok: true, text: "Esperei." };
    }
    if (op === "print") {
      const img = await win.webContents.capturePage();
      const dir = path.join(rec.workDir, "prints");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `print-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      fs.writeFileSync(file, img.toPNG());
      return { ok: true, text: `Print salvo em ${file}`, file, thumb: img.isEmpty() ? "" : img.resize({ width: 480 }).toDataURL() };
    }
    if (op === "login") {
      if (!jobsHost) return { ok: false, error: "Login do cofre indisponível." };
      const id = String(a.plataforma || "").toLowerCase();
      const r = await jobsHost.login(id);
      if (!r.ok) return { ok: false, error: r.error || "Login não confirmou." };
      const partition = partitionFor(id);
      // Login grava no perfil principal do agente (não na sessão descartável da tarefa).
      if (!rec.taskSessionId) {
        rec.partition = partition;
        rec.mainPartition = partition;
      }
      rec.lastLoginPlatform = id;
      rec.mainPartition = rec.mainPartition || partition;
      winFor({ ...rec, taskSessionId: null, partition: rec.mainPartition });
      return { ok: true, partition, text: `${r.message || "Login feito."} O navegador principal do agente agora usa a sessão desse site.` };
    }
    if (op === "codigo") {
      if (mock) return { ok: true, text: "Modo demonstração: código simulado." };
      if (!codeReader || !codeReader.available()) return { ok: false, error: "Sem Gmail conectado para ler o código." };
      const got = await codeReader.fillCode(win.webContents, { from: String(a.remetente || ""), regex: null, since: Date.now() - 10 * 60e3 });
      await settle(win, 1500);
      return got.ok ? { ok: true, text: "Código digitado a partir do Gmail." } : { ok: false, error: got.error || "Código não encontrado." };
    }
    if (op === "abrir_tarefa") {
      const taskId = String(a.taskSessionId || a.tarefaId || "").slice(0, 40);
      if (!taskId) return { ok: false, error: "Informe o id da tarefa." };
      rec.taskSessionId = taskId;
      rec.mainPartition = rec.mainPartition || mainPartition({ ...rec, taskSessionId: null });
      winFor(rec);
      return { ok: true, taskSessionId: taskId, partition: taskPartition(rec), text: `Sessão de tarefa ${taskId} aberta (isolada).` };
    }
    if (op === "fechar_tarefa") {
      const taskId = String(a.taskSessionId || rec.taskSessionId || "").slice(0, 40);
      closeTask(rec.id, taskId);
      if (rec.taskSessionId === taskId) rec.taskSessionId = null;
      return { ok: true, text: `Sessão de tarefa ${taskId} descartada.` };
    }
    return { ok: false, error: `Operação desconhecida: ${op}` };
  }

  const streams = new Map();

  function stopStream(id) {
    const t = streams.get(String(id));
    if (t) clearInterval(t);
    streams.delete(String(id));
  }

  function startStream(id, onFrame) {
    stopStream(id);
    const cur = wins.get(String(id)) || [...wins.values()].find((w) => w.rec && w.rec.id === id && !w.taskSessionId);
    if (!cur || cur.win.isDestroyed()) return false;
    const tick = async () => {
      try {
        const t = await thumb(cur.win);
        if (t && typeof onFrame === "function") onFrame(t);
      } catch { /* frame opcional */ }
    };
    tick();
    streams.set(String(id), setInterval(tick, 1500));
    return true;
  }

  async function snapshot(id) {
    const cur = wins.get(String(id)) || [...wins.values()].find((w) => w.rec && w.rec.id === id && !w.taskSessionId);
    if (!cur || cur.win.isDestroyed()) return "";
    return thumb(cur.win);
  }

  async function takeover(id) {
    const ok = show(id);
    const t = await snapshot(id);
    return { ok, thumb: t };
  }

  function requestStream(rec, onFrame) {
    return startStream(sessionKey(rec), onFrame);
  }

  function show(id) {
    const cur = wins.get(String(id)) || [...wins.values()].find((w) => w.rec && w.rec.id === id);
    if (!cur || cur.win.isDestroyed()) return false;
    if (offscreen) return true;
    cur.win.show(); cur.win.focus();
    return true;
  }

  function closeTask(agentId, taskSessionId) {
    const key = `${agentId}::${taskSessionId}`;
    stopStream(key);
    const cur = wins.get(key);
    if (cur && !cur.win.isDestroyed()) cur.win.destroy();
    wins.delete(key);
    // Limpa storage da partição temporária
    if (electronSession && taskSessionId) {
      try {
        const part = `temp:agente-${agentId}-task-${taskSessionId}`;
        const ses = electronSession.fromPartition(part);
        ses.clearStorageData?.({}).catch?.(() => {});
      } catch { /* ok */ }
    }
  }

  function close(id) {
    stopStream(id);
    const cur = wins.get(String(id));
    if (cur && !cur.win.isDestroyed()) cur.win.destroy();
    wins.delete(String(id));
    // Fecha também sessões de tarefa deste agente
    for (const [key, w] of [...wins.entries()]) {
      if (w.rec && w.rec.id === id) {
        if (!w.win.isDestroyed()) w.win.destroy();
        wins.delete(key);
      }
    }
  }
  function closeAll() { for (const id of [...new Set([...wins.values()].map((w) => w.rec?.id).filter(Boolean))]) close(id); }

  return {
    exec, show, close, closeAll, closeTask, startStream, stopStream, snapshot, takeover, requestStream,
    sessionKey, mainPartition, taskPartition, copyAuthorizedCookies, domainAllowed, hostOf,
    _wins: wins,
  };
}

module.exports = { createAgentBrowser, READ_SCRIPT, sessionKey, domainAllowed, hostOf, copyAuthorizedCookies };
