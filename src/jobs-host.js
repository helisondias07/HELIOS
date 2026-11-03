"use strict";

/**
 * Fase 7: navegador das vagas no processo principal. Ele faz o login com a senha do cofre
 * (o modelo e o servidor nunca veem a senha), respeita 2FA e captcha (mostra a janela e para)
 * e só abre a candidatura de vaga que já foi aprovada num cartão.
 * LEVA R2: planFillLlm (fill-privacy) no preenchimento — modelo vê só vaga + rótulos;
 * dados pessoais saem do cofre/perfil via resolveFill. Em modo aprovação: preenche e para antes de enviar.
 */
const fs = require("node:fs");
const path = require("node:path");
const { PLATFORMS } = require("../server/jobs");
const fill = require("../server/jobs-fill");
const privacy = require("../server/fill-privacy");
const { createCookieSaver, platformDomains, cleanUserAgent, cookieMeta } = require("./vagas-cookies");
const application = require("../server/jobs-application");

const CHALLENGE_URL = /checkpoint|challenge|captcha|two-?step|2fa|mfa|verification|verify|otp|security-check/i;

/** Pura, para teste: a página pede algo que só o Helison pode fazer? */
function detectChallenge(url, flags = {}) {
  if (CHALLENGE_URL.test(String(url || ""))) return "O site pediu uma verificação (2FA ou captcha).";
  if (flags.captcha) return "O site mostrou um captcha.";
  if (flags.otp) return "O site pediu um código de verificação.";
  return "";
}

/** Login do cofre que serve para a plataforma: pelo endereço (domínio) ou pelo nome. */
function findLoginFor(platform, entries) {
  const byUrl = entries.find((entry) => {
    try { const host = new URL(entry.url).hostname.toLowerCase(); return platform.domains.some((d) => host === d || host.endsWith(`.${d}`)); } catch { return false; }
  });
  if (byUrl) return byUrl;
  return entries.find((entry) => String(entry.nome || "").toLowerCase().includes(platform.label.toLowerCase())) || null;
}

/** Script que roda na página do site. Recebe os valores como JSON e devolve só true/false. */
function fillScript(user, pass) {
  return `(() => {
    const u = ${JSON.stringify(String(user || ""))}, p = ${JSON.stringify(String(pass || ""))};
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"); d.set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
    const pw = document.querySelector('input[type="password"]');
    if (!pw) return false;
    const inputs = [...document.querySelectorAll('input[type="email"], input[type="text"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]')].filter((el) => el.offsetParent !== null);
    if (inputs[0] && u) set(inputs[0], u);
    set(pw, p);
    const form = pw.form;
    const btn = (form || document).querySelector('button[type="submit"], input[type="submit"]');
    if (btn) btn.click(); else if (form) form.requestSubmit();
    return true;
  })()`;
}

const PROBE = `(() => {
  const textOf = (el) => String((el && (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.value)) || "");
  const google = [...document.querySelectorAll('button, a, div[role="button"], span')].slice(0, 100).some((el) => {
    const t = textOf(el);
    return /google|g\\s*mail/i.test(t) && /continuar|entrar|sign\\s*in|log\\s*in|with|com/i.test(t);
  });
  return {
    captcha: Boolean(document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, #captcha')),
    otp: Boolean(document.querySelector('input[autocomplete="one-time-code"], input[name*="pin" i], input[name*="otp" i], input[name*="code" i]')),
    password: Boolean(document.querySelector('input[type="password"]')),
    google,
  };
})()`;

/** E-mail reserva (Leva Q): tenta de novo sem gravar no cofre. */
const RESERVA_EMAIL = "closedfps@gmail.com";
const LOGIN_TIMEOUT_MS = 60e3;

/** Classifica o resultado do login para a API (sem senha/cookies/token). */
function classifyLoginResult(result = {}) {
  if (result && result.ok) return { status: "logado", motivo: "" };
  const code = String(result.motivo || result.code || "").toLowerCase();
  const err = String(result.error || result.message || "");
  if (code === "captcha" || /captcha/i.test(err)) return { status: "pendente", motivo: "captcha" };
  if (code === "otp" || code === "2fa" || /2fa|verifica|otp|c[oó]digo/i.test(err)) return { status: "pendente", motivo: "2FA não lido" };
  if (code === "google" || /s[oó] pelo google|apenas pelo google|entrar com google/i.test(err)) return { status: "pendente", motivo: "login só pelo Google" };
  if (code === "form" || /formul[aá]rio/i.test(err)) return { status: "pendente", motivo: "formulário não achado" };
  if (code === "senha" || /senha|n[aã]o confirmou|e-?mail errado|credencial/i.test(err)) return { status: "pendente", motivo: "senha errada" };
  if (code === "timeout" || /tempo esgotado|timeout/i.test(err)) return { status: "pendente", motivo: "tempo esgotado" };
  if (code === "sem-credencial" || /falta .*cofre|senha padr/i.test(err)) return { status: "pendente", motivo: "senha errada" };
  return { status: "pendente", motivo: err.slice(0, 120) || "pendente" };
}

/** True se vale tentar o e-mail reserva (senha/e-mail do principal não entrou). */
function shouldTryReserva(classified) {
  return classified && classified.status === "pendente" && classified.motivo === "senha errada";
}

/** Leva Q3: uma partição compartilhada para todas as plataformas de vagas (um login Google vale em todas). */
const SHARED_VAGAS_PARTITION = "persist:vagas";
const VAGAS_SESSAO_MARKER = "vagas-sessao-unica.json";

/** Partição única das vagas (id ignorado; mantido na assinatura por compatibilidade). */
const partitionFor = () => SHARED_VAGAS_PARTITION;

/** Formato antigo por site (persist:vagas-<site>) — só para migrar cookies/pastas. */
function legacyPartitionFor(id) {
  return `persist:vagas-${String(id || "geral").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`;
}

/** Nome da pasta Electron sob userData/Partitions para um persist:<name>. */
function partitionDirName(partition) {
  return String(partition || "").replace(/^persist:/, "");
}

function copyDirIfMissing(src, dest, fsMod) {
  if (!fsMod.existsSync(src) || fsMod.existsSync(dest)) return false;
  fsMod.mkdirSync(path.dirname(dest), { recursive: true });
  if (typeof fsMod.cpSync === "function") fsMod.cpSync(src, dest, { recursive: true });
  else {
    fsMod.mkdirSync(dest, { recursive: true });
    for (const name of fsMod.readdirSync(src)) {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      if (fsMod.statSync(from).isDirectory()) copyDirIfMissing(from, to, fsMod);
      else fsMod.copyFileSync(from, to);
    }
  }
  return true;
}

/**
 * Migração única: cookies (+ Local Storage / IndexedDB da 1ª partição) → persist:vagas.
 * Não apaga as pastas antigas. Idempotente pelo marcador userData/vagas-sessao-unica.json.
 * Limitação: Local Storage / IndexedDB só da primeira partição antiga (demais puladas se destino já existir).
 */
async function migrateVagasSession({ userData, session, fs: fsMod = fs, now = () => new Date() } = {}) {
  if (!userData) return { skipped: true, motivo: "sem-userData" };
  const pathMod = path;
  const markerPath = pathMod.join(userData, VAGAS_SESSAO_MARKER);
  if (fsMod.existsSync(markerPath)) {
    try { return { skipped: true, ...JSON.parse(fsMod.readFileSync(markerPath, "utf8")) }; }
    catch { return { skipped: true }; }
  }
  const partsRoot = pathMod.join(userData, "Partitions");
  let particoes = 0;
  let cookies = 0;
  const destName = partitionDirName(SHARED_VAGAS_PARTITION);
  const destDir = pathMod.join(partsRoot, destName);

  if (fsMod.existsSync(partsRoot) && session && typeof session.fromPartition === "function") {
    const oldDirs = fsMod.readdirSync(partsRoot).filter((name) => /^vagas-/.test(name));
    const destSes = session.fromPartition(SHARED_VAGAS_PARTITION);
    for (const name of oldDirs) {
      particoes += 1;
      const fromSes = session.fromPartition(`persist:${name}`);
      let list = [];
      try { list = await fromSes.cookies.get({}); } catch { list = []; }
      for (const c of list) {
        const domain = String(c.domain || "").replace(/^\./, "");
        if (!domain || !c.name) continue;
        const url = `https://${domain}${c.path || "/"}`;
        try {
          let existing = [];
          try { existing = await destSes.cookies.get({ url, name: c.name }); } catch { existing = []; }
          const cur = Array.isArray(existing) ? existing[0] : null;
          const curExp = cur && cur.expirationDate != null ? Number(cur.expirationDate) : 0;
          const srcExp = c.expirationDate != null ? Number(c.expirationDate) : 0;
          if (cur && curExp >= srcExp && curExp > 0) continue;
          await destSes.cookies.set({
            url,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || "/",
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            expirationDate: c.expirationDate,
          });
          cookies += 1;
        } catch { /* ignora cookie inválido */ }
      }
      // Local Storage / IndexedDB: só se o destino ainda não tiver (1ª partição ganha; demais pulam).
      const srcDir = pathMod.join(partsRoot, name);
      for (const folder of ["Local Storage", "IndexedDB"]) {
        copyDirIfMissing(pathMod.join(srcDir, folder), pathMod.join(destDir, folder), fsMod);
      }
    }
  }

  const marker = {
    migradoEm: (typeof now === "function" ? now() : now).toISOString?.() || new Date().toISOString(),
    particoes,
    cookies,
  };
  try {
    fsMod.mkdirSync(userData, { recursive: true });
    fsMod.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, "utf8");
  } catch { /* marcador best-effort */ }
  return marker;
}

function isGoogleAccountsUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:" && u.hostname.toLowerCase() === "accounts.google.com";
  } catch {
    return false;
  }
}

const slug = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** Dominio registravel: "vagas.solides.com.br" -> "solides.com.br" (trata com.br, net.br, co.uk...). */
function baseDomain(host) {
  const parts = String(host || "").split(".");
  const n = parts.length >= 3 && parts[parts.length - 1].length === 2 && /^(com|net|org|gov|edu|co)$/.test(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join(".");
}

/** Leva Q4: dominios do login com Google (popup OAuth). So abrir janela; nada e preenchido. */
const OAUTH_HOSTS = ["accounts.google.com", "apis.google.com"];
const OAUTH_SUFFIXES = [".gstatic.com", ".googleusercontent.com"];
function isOAuthPopupUrl(url) {
  const raw = String(url || "");
  if (raw === "" || raw === "about:blank") return true;
  let u; try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return OAUTH_HOSTS.includes(h) || OAUTH_SUFFIXES.some((s) => h.endsWith(s));
}

/** Plataformas conhecidas + as do cofre (Cofre › Plataformas). A do cofre manda no link de login. */
function mergePlatforms(builtin, entries = []) {
  const out = { ...builtin };
  for (const entry of entries) {
    let host = "";
    try { host = new URL(entry.url).hostname.toLowerCase().replace(/^www\./, ""); } catch { host = ""; }
    const known = Object.values(out).find((p) => host && p.domains.some((d) => host === d || host.endsWith(`.${d}`)));
    if (known) { out[known.id] = { ...known, loginUrl: entry.url || known.loginUrl, entryId: entry.id }; continue; }
    const id = slug(entry.nome);
    if (!id || !host) continue;
    const base = baseDomain(host);
    out[id] = { id, label: entry.nome, domains: [base], loginUrl: entry.url, codeFrom: base, entryId: entry.id };
  }
  return out;
}

/** Posts do feed do LinkedIn (só leitura): autor, texto e link. Sem curtir, comentar nem clicar. */
const FEED_SCRIPT = `(() => {
  const primary = [...document.querySelectorAll('div.feed-shared-update-v2, div[data-urn*="activity"], article, [data-view-name*="feed" i]')];
  const nodes = primary.length ? primary : [...document.querySelectorAll('main li, main section')];
  const items = nodes.slice(0, 40).map((el) => {
    const link = el.querySelector('a[href*="/jobs/view/"], a[href*="/feed/update/"], a[href*="/posts/"]');
    return {
      id: el.getAttribute('data-urn') || el.getAttribute('data-id') || link?.href || '',
      autor: (el.querySelector('.update-components-actor__title, .feed-shared-actor__name, [class*="actor"]') || {}).innerText || '',
      texto: (el.innerText || '').slice(0, 1200),
      url: link?.href || '',
    };
  }).filter((x) => x.texto || x.url);
  return { items, diagnostics: { selectorNodes: nodes.length, bodyChars: (document.body?.innerText || '').length, title: document.title, url: location.href } };
})()`;

/** LEVA O3: posts salvos — só leitura, no máx. 15. */
const SAVED_SCRIPT = `(() => {
  const direct = [...document.querySelectorAll('a[href*="/jobs/view/"], a[href*="/feed/update/"], a[href*="/posts/"]')];
  const roots = direct.map((a) => a.closest('li, article, [data-view-name], [data-urn], div')).filter(Boolean);
  const nodes = [...new Set([...document.querySelectorAll('li.saved-item, div.entity-result, article[data-id], li[class*="saved" i], [data-view-name*="saved" i]'), ...roots])];
  const items = nodes.slice(0, 30).map((el) => {
    const link = el.querySelector('a[href*="/jobs/view/"], a[href*="/feed/update/"], a[href*="/posts/"], a[href*="linkedin.com"]');
    return {
      id: el.getAttribute('data-id') || el.getAttribute('data-urn') || link?.href || '',
      autor: (el.querySelector('.actor, .entity-result__title-text, h3, h4, [class*="actor"]') || {}).innerText || '',
      texto: (el.innerText || '').slice(0, 1200),
      url: link?.href || '',
    };
  }).filter((x) => x.texto || x.url);
  return { items, diagnostics: { selectorNodes: nodes.length, directLinks: direct.length, jobLinks: direct.filter((a) => /[/]jobs[/]view[/]/.test(a.href)).length, bodyChars: (document.body?.innerText || '').length, title: document.title, url: location.href } };
})()`;

/** LEVA O3: notificações — só leitura; o servidor filtra as de vaga. */
const NOTIF_SCRIPT = `(() => {
  const nodes = [...document.querySelectorAll('li.notification, div.nt-card, li[class*="notification" i], article[data-id], [data-view-name*="notification" i], main li')];
  const items = nodes.slice(0, 30).map((el) => {
    const link = el.querySelector('a[href*="/jobs/view/"], a[href*="linkedin.com"]');
    return {
      id: el.getAttribute('data-id') || el.getAttribute('data-urn') || link?.href || '',
      texto: (el.innerText || '').slice(0, 800),
      url: link?.href || '',
    };
  }).filter((x) => x.texto || x.url);
  return { items, diagnostics: { selectorNodes: nodes.length, jobLinks: items.filter((x) => /[/]jobs[/]view[/]/.test(x.url)).length, bodyChars: (document.body?.innerText || '').length, title: document.title, url: location.href } };
})()`;

/** Nunca postar: qualquer tentativa de clicar em publicar/comentar/reagir é bloqueada no host. */
function assertNuncaPostarLinkedIn(acao) {
  const key = String(acao || "").toLowerCase();
  if (/(postar|publicar|comentar|reagir|curtir|share|mensagem|conectar)/.test(key)) {
    return { ok: false, error: "LinkedIn: o HELIOS nunca posta, comenta, reage nem envia mensagem." };
  }
  return { ok: true };
}

function registerJobs({ ipcMain, BrowserWindow, vault, serverUrl, getApiToken, mock = false, platforms: basePlatforms = PLATFORMS, isQuitting = () => false, readProfile = () => "", codeReader = null, feedMinIntervalMs = 30 * 60e3, session = null, cookieFlushMs = 60e3, freeLlm = null } = {}) {
  const wins = new Map();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const jitter = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));
  const platformEntries = () => (typeof vault.platforms === "function" ? vault.platforms() : []);
  const currentPlatforms = () => mergePlatforms(basePlatforms, platformEntries());
  // Leva Q5: salva os cookies da persist:vagas (fechar janela, before-quit e a cada 60 s).
  const cookieSaver = createCookieSaver({
    ses: !mock && session && typeof session.fromPartition === "function" ? session.fromPartition(SHARED_VAGAS_PARTITION) : null,
    getDomains: () => platformDomains(currentPlatforms()),
    intervalMs: mock ? 0 : cookieFlushMs,
  });
  cookieSaver.start();
  cookieSaver.watch();
  const vagasSes = !mock && session && typeof session.fromPartition === "function" ? session.fromPartition(SHARED_VAGAS_PARTITION) : null;
  // Leva Q6: UA de Chrome comum (alguns sites derrubam a sessao de UA com Electron/HELIOS).
  try { if (vagasSes && vagasSes.getUserAgent) vagasSes.setUserAgent(cleanUserAgent(vagasSes.getUserAgent())); } catch { /* ignora */ }

  function getWin(platformId = "geral") {
    const key = String(platformId || "geral");
    const existing = wins.get(key);
    if (existing && !existing.isDestroyed()) return existing;
    const win = new BrowserWindow({
      show: false, width: 1100, height: 820, title: "HELIOS · Vagas", autoHideMenuBar: true,
      webPreferences: { partition: partitionFor(key), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      // Leva Q4: popup de "Entrar com Google" precisa do window.opener e da mesma sessao.
      if (isOAuthPopupUrl(url)) {
        return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, title: "HELIOS \u00b7 Google", webPreferences: { partition: partitionFor(key), contextIsolation: true, sandbox: true, nodeIntegration: false } } };
      }
      if (/^https:\/\//i.test(url)) win.loadURL(url);
      return { action: "deny" };
    });
    win.on("close", (event) => { cookieSaver.flush().catch(() => {}); if (isQuitting()) return; event.preventDefault(); win.hide(); });
    win.on("hide", () => { cookieSaver.flush().catch(() => {}); });
    wins.set(key, win);
    return win;
  }
  async function notify(texto) {
    await api("POST", "/api/vagas/aviso", { texto }).catch(() => {});
  }

  async function load(w, url, timeoutMs = 30000) {
    let timer;
    try {
      const outcome = await Promise.race([
        w.loadURL(url).then(() => ({ ok: true })).catch((error) => ({ ok: false, error: error.message || "falha ao carregar" })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, timeout: true, error: `Tempo esgotado carregando ${url}` }), timeoutMs); }),
      ]);
      clearTimeout(timer);
      await sleep(1500);
      return outcome;
    } catch (error) {
      clearTimeout(timer);
      return { ok: false, error: error.message || "falha ao carregar" };
    }
  }

  async function api(method, pathname, body) {
    const res = await fetch(`${serverUrl()}${pathname}`, {
      method, headers: { "content-type": "application/json", authorization: `Bearer ${getApiToken()}` }, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  ipcMain.handle("vagas:login", (_event, platformId) => login(platformId));
  /** Credencial do cofre: plataforma (Cofre › Plataformas, com a senha padrão) ou login antigo pelo domínio. */
  function credentialFor(platform) {
    const plat = platformEntries();
    const legacy = vault.index().filter((item) => item.tipo === "login").map((item) => vault.getLogin(item.id)).filter(Boolean);
    const entry = (platform.entryId && vault.getLogin(platform.entryId)) || findLoginFor(platform, legacy);
    if (!entry) return null;
    const cred = typeof vault.platformCredential === "function" ? vault.platformCredential(entry) : { usuario: entry.usuario, senha: entry.senha };
    return { ...cred, url: entry.url || "", known: plat.length };
  }

  /**
   * Login numa plataforma. opts.silent = lote (sem abrir janela / sem avisar).
   * opts.usuario = e-mail alternativo só nesta tentativa (não grava no cofre).
   * Nunca devolve senha, cookies ou token.
   */
  /**
   * Leva Q2/Q3: abre a janela de login visível (partição única) sem preencher nada.
   * Aceita id de plataforma OU { url } (só https://accounts.google.com/…).
   */
  async function abrirLogin(platformIdOrOpts) {
    if (platformIdOrOpts && typeof platformIdOrOpts === "object" && platformIdOrOpts.url != null) {
      const url = String(platformIdOrOpts.url);
      if (!isGoogleAccountsUrl(url)) return { ok: false, error: "Só https://accounts.google.com/ é permitido." };
      if (mock) return { ok: true, url, mock: true, partition: SHARED_VAGAS_PARTITION };
      const w = getWin("geral");
      w.loadURL(url).catch(() => {});
      w.show();
      return { ok: true, url, partition: SHARED_VAGAS_PARTITION };
    }
    const platform = currentPlatforms()[String(platformIdOrOpts)];
    if (!platform) return { ok: false, id: String(platformIdOrOpts), error: "Plataforma desconhecida." };
    if (mock) return { ok: true, id: platform.id, label: platform.label, mock: true, partition: SHARED_VAGAS_PARTITION };
    const existed = wins.has(platform.id) && !wins.get(platform.id).isDestroyed();
    const w = getWin(platform.id);
    const atual = existed ? w.webContents.getURL() : "";
    const mesmoSite = atual && platformDomains([{ url: atual }])[0] === platformDomains([{ url: platform.loginUrl }])[0];
    if (!mesmoSite) w.loadURL(platform.loginUrl).catch(() => {});
    w.show();
    return { ok: true, id: platform.id, label: platform.label, partition: SHARED_VAGAS_PARTITION, recarregou: !mesmoSite };
  }
  /** Leva Q6: diagnostico sem valores (nomes de cookie, dominios, validade; chaves de storage). */
  async function diagnostico(dominio) {
    const dom = String(dominio || "").toLowerCase().replace(/^\./, "");
    if (!/^[a-z0-9.-]{3,80}$/.test(dom)) return { ok: false, error: "dominio invalido" };
    if (!vagasSes) return { ok: true, mock: true, cookies: [], janelas: [] };
    const all = await vagasSes.cookies.get({});
    const cookies = all.filter((c) => { const d = String(c.domain || "").replace(/^\./, ""); return d === dom || d.endsWith(`.${dom}`); }).map(cookieMeta);
    const janelas = [];
    for (const [id, w] of wins) {
      if (!w || w.isDestroyed()) continue;
      const url = w.webContents.getURL();
      let host = ""; try { host = new URL(url).hostname; } catch { /* vazio */ }
      if (!(host === dom || host.endsWith(`.${dom}`))) continue;
      const st = await w.webContents.executeJavaScript("(() => { const k = (s) => { try { return Object.keys(s); } catch { return null; } }; return { local: k(localStorage), sessao: k(sessionStorage) }; })()", true).catch(() => ({}));
      janelas.push({ id, url: url.split("?")[0].slice(0, 120), localStorage: st.local, sessionStorage: st.sessao });
    }
    return { ok: true, userAgent: vagasSes.getUserAgent(), cookies, janelas };
  }
  async function sessoes() {
    const out = [];
    for (const [id, w] of wins) {
      if (!w || w.isDestroyed()) continue;
      const probe = await w.webContents.executeJavaScript(PROBE, true).catch(() => ({}));
      out.push({ id, visivel: w.isVisible(), formularioDeSenha: Boolean(probe.password) });
    }
    return out;
  }
  async function login(platformId, opts = {}) {
    const silent = opts.silent === true;
    const usuarioAlt = String(opts.usuario || "").trim();
    const timeoutMs = Math.max(5e3, Math.min(120e3, Number(opts.timeoutMs) || (silent ? LOGIN_TIMEOUT_MS : LOGIN_TIMEOUT_MS * 2)));
    const platform = currentPlatforms()[String(platformId)];
    if (!platform) return { ok: false, error: "Plataforma desconhecida.", motivo: "desconhecida" };
    if (mock) return { ok: true, mock: true, message: `Modo demonstração: login no ${platform.label} simulado.`, motivo: "" };

    const run = async () => {
      const cred = credentialFor(platform);
      if (!cred || !cred.senha) return { ok: false, error: `Falta ${platform.label} em Cofre › Plataformas (ou a senha padrão).`, motivo: "sem-credencial" };
      const usuario = usuarioAlt || cred.usuario;
      const w = getWin(platform.id);
      if (silent && typeof w.isVisible === "function" && w.isVisible()) w.hide();
      const startedAt = Date.now();
      await load(w, cred.url || platform.loginUrl);
      const filled = await w.webContents.executeJavaScript(fillScript(usuario, cred.senha), true).catch(() => false);
      if (!filled) {
        const probe = await w.webContents.executeJavaScript(PROBE, true).catch(() => ({}));
        const url = String(w.webContents.getURL() || "");
        if (!probe.password) {
          if (probe.google && /login|signin|sign-in|auth|entrar|cadastro|candidates/i.test(url)) {
            if (!silent) { w.show(); await notify(`${platform.label}: este site só entra pelo Google. Abri a janela.`); }
            return { ok: false, needsUser: true, error: "Este site só entra pelo Google.", motivo: "google" };
          }
          return { ok: true, message: `Sessão do ${platform.label} ativa.`, motivo: "" };
        }
        if (!silent) { w.show(); await notify(`Não achei o login do ${platform.label}. Abri a janela.`); }
        return { ok: false, needsUser: true, error: "Não achei o formulário de login.", motivo: "form" };
      }
      await sleep(silent ? 4000 : 6000);
      let probe = await w.webContents.executeJavaScript(PROBE, true).catch(() => ({}));
      // 2FA por e-mail: o HELIOS busca o código no Gmail e digita sozinho (também no lote, sem abrir janela).
      if (probe.otp && !probe.captcha && codeReader && codeReader.available()) {
        const got = await codeReader.fillCode(w.webContents, { from: platform.codeFrom || platform.domains[0], regex: platform.codeRegex || null, since: startedAt });
        if (got.ok) { await sleep(5000); probe = await w.webContents.executeJavaScript(PROBE, true).catch(() => ({})); }
      }
      const challenge = detectChallenge(w.webContents.getURL(), probe);
      if (challenge) {
        const motivo = /captcha/i.test(challenge) ? "captcha" : "otp";
        if (!silent) {
          w.show(); w.focus();
          await notify(`${platform.label}: ${challenge} Preciso de você na janela do HELIOS.`);
        }
        return { ok: false, needsUser: true, error: challenge, motivo };
      }
      if (probe.password) {
        if (!silent) {
          w.show();
          await notify(`${platform.label}: o login não confirmou. Confira a senha em Cofre › Plataformas.`);
        }
        return { ok: false, needsUser: true, error: "O login não confirmou (senha errada ou passo extra).", motivo: "senha" };
      }
      return { ok: true, message: `Entrei no ${platform.label}. A sessão fica salva neste computador.`, motivo: "" };
    };

    if (!silent) return run();
    let settled = false;
    return Promise.race([
      run().then((r) => { settled = true; return r; }),
      sleep(timeoutMs).then(() => {
        if (settled) return null;
        return { ok: false, error: "Tempo esgotado no login.", motivo: "timeout" };
      }),
    ]).then((r) => r || { ok: false, error: "Tempo esgotado no login.", motivo: "timeout" });
  }

  /** Um item seguro para a API (nunca senha/cookies/token). */
  function publicLoginRow(platform, result, email) {
    const { status, motivo } = classifyLoginResult(result);
    return {
      id: platform.id,
      label: platform.label,
      status,
      email: email === "reserva" ? "reserva" : "principal",
      motivo,
    };
  }

  /**
   * Leva Q: login em sequência nas plataformas (Cofre › Plataformas + built-ins).
   * Modo silencioso: sem abrir janela e sem notificar. Só login — nada de inscrição/post.
   */
  async function loginTodas({ reserva = false, plataformas = null, pauseMs = 800 } = {}) {
    const all = currentPlatforms();
    const wanted = Array.isArray(plataformas) && plataformas.length
      ? plataformas.map((id) => String(id)).filter((id) => all[id])
      : Object.keys(all);
    const out = [];
    for (const id of wanted) {
      const platform = all[id];
      let result = await login(id, { silent: true, timeoutMs: LOGIN_TIMEOUT_MS });
      let email = "principal";
      let classified = classifyLoginResult(result);
      if (reserva && shouldTryReserva(classified)) {
        result = await login(id, { silent: true, usuario: RESERVA_EMAIL, timeoutMs: LOGIN_TIMEOUT_MS });
        email = "reserva";
        classified = classifyLoginResult(result);
      }
      out.push(publicLoginRow(platform, result, email));
      if (pauseMs > 0) await sleep(pauseMs);
    }
    return out;
  }

  // ---------------- Leva G + O3: LinkedIn só leitura (feed, salvos, notificações, busca) ----------------
  let lastFeed = 0;
  const lastByKind = { feed: 0, salvos: 0, "salvos-vagas": 0, notificacoes: 0, busca: 0 };
  const LI_URLS = {
    feed: "https://www.linkedin.com/feed/",
    salvos: "https://www.linkedin.com/my-items/saved-posts/",
    "salvos-vagas": "https://www.linkedin.com/my-items/saved-jobs/",
    notificacoes: "https://www.linkedin.com/notifications/",
    busca: null, // montada com termos
  };

  /** LEVA S2: cookies de sessao que provam login (so nomes; nunca valores). */
  const AUTH_COOKIES = { gupy: { dominio: "gupy.io", nomes: ["candidate_secure_token", "candidate_logged_in"] }, linkedin: { dominio: "linkedin.com", nomes: ["li_at"] } };
  async function sessaoAtiva(platformId) {
    const spec = AUTH_COOKIES[platformId];
    if (!spec || mock) return false;
    try {
      const cs = await getWin(platformId).webContents.session.cookies.get({});
      return cs.some((c) => spec.nomes.includes(c.name) && String(c.domain || "").includes(spec.dominio));
    } catch { return false; }
  }
  async function ensureLinkedInSession(w) {
    if (!mock && !(await sessaoAtiva("linkedin"))) {
      return { ok: false, needsUser: true, error: "LinkedIn sem sessao (cookie li_at ausente). Entre na janela do LinkedIn (abrir-login) e rode de novo." };
    }
    if (/login|authwall|checkpoint/i.test(w.webContents.getURL())) {
      const r = await login("linkedin");
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  async function scanFeed() {
    const blocked = assertNuncaPostarLinkedIn("feed");
    if (!blocked.ok) return blocked;
    const now = Date.now();
    if (now - lastFeed < feedMinIntervalMs) return { ok: false, error: `O feed foi lido há pouco. Próxima leitura em ${Math.ceil((feedMinIntervalMs - (now - lastFeed)) / 60e3)} min.` };
    lastFeed = now;
    lastByKind.feed = now;
    if (mock) {
      const posts = [{ id: "urn:demo:1", autor: "Recrutadora Demo", texto: "Estamos contratando dev front-end React remoto! #vagas", url: "https://www.linkedin.com/feed/update/demo1" }];
      const r = await api("POST", "/api/vagas/feed", { posts });
      return { ok: true, ...r };
    }
    const platform = currentPlatforms().linkedin;
    const w = getWin("linkedin-leitura"); // partition persist:vagas — sessão compartilhada das vagas
    const loaded = await load(w, platform.feedUrl || LI_URLS.feed);
    if (!loaded.ok) return { ok: false, error: loaded.error, motivo: loaded.timeout ? "timeout" : "carregamento" };
    const sess = await ensureLinkedInSession(w);
    if (!sess.ok) return { ok: false, error: sess.error };
    const reloaded = await load(w, platform.feedUrl || LI_URLS.feed);
    if (!reloaded.ok) return { ok: false, error: reloaded.error, motivo: reloaded.timeout ? "timeout" : "carregamento" };
    for (let i = 0; i < 25; i += 1) {
      await w.webContents.executeJavaScript("window.scrollBy(0, Math.round(window.innerHeight * 0.9)); true", true).catch(() => {});
      await jitter(3000, 6000);
    }
    const captured = await w.webContents.executeJavaScript(FEED_SCRIPT, true).catch(() => ({ items: [], diagnostics: { erro: "executeJavaScript" } }));
    const posts = Array.isArray(captured) ? captured : (captured.items || []);
    if (!w.isVisible()) w.loadURL("about:blank").catch(() => {});
    const r = await api("POST", "/api/vagas/feed", { posts: posts.slice(0, 30) });
    return { ok: true, ...r, diagnostico: Array.isArray(captured) ? null : captured.diagnostics };
  }
  ipcMain.handle("vagas:feed", () => scanFeed());

  /** LEVA O3: salvos / notificações / busca por palavras-chave — só leitura, ritmo humano, máx. 15. */
  async function scanLinkedInKind(kind, { term = "", location = "Brasil" } = {}) {
    const blocked = assertNuncaPostarLinkedIn(kind);
    if (!blocked.ok) return blocked;
    const now = Date.now();
    if (now - (lastByKind[kind] || 0) < feedMinIntervalMs) {
      return { ok: false, error: `${kind} lido há pouco. Aguarde o intervalo humano.` };
    }
    lastByKind[kind] = now;
    if (mock) {
      if (kind === "salvos") {
        const posts = [{ id: "saved-demo-1", autor: "RH Demo", texto: "Vaga desenvolvedor React remoto #vagas", url: "https://www.linkedin.com/feed/update/saved1" }];
        return { ok: true, ...(await api("POST", "/api/vagas/posts-salvos", { posts })) };
      }
      if (kind === "salvos-vagas") {
        return { ok: true, ...(await api("POST", "/api/vagas/ingest-browser", { platform: "linkedin", items: [{ extId: "saved-job-demo-1", title: "Desenvolvedor React", company: "Empresa Demo", url: "https://www.linkedin.com/jobs/view/1", description: "Vaga salva" }] })) };
      }
      if (kind === "notificacoes") {
        const posts = [{ id: "n1", texto: "Nova vaga: Frontend React na Empresa Demo", url: "https://www.linkedin.com/jobs/view/1" }];
        return { ok: true, ...(await api("POST", "/api/vagas/notificacoes", { posts })) };
      }
      if (kind === "busca") {
        return { ok: true, ...(await api("POST", "/api/vagas/buscar", {})) };
      }
      return scanFeed();
    }
    const platform = currentPlatforms().linkedin;
    const w = getWin("linkedin-leitura");
    let target = LI_URLS[kind];
    if (kind === "busca") {
      target = typeof platform.searchUrl === "function"
        ? platform.searchUrl(term || "desenvolvedor front-end", location)
        : `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(term || "front-end")}`;
    }
    const loaded = await load(w, target);
    if (!loaded.ok) return { ok: false, error: loaded.error, motivo: loaded.timeout ? "timeout" : "carregamento" };
    const sess = await ensureLinkedInSession(w);
    if (!sess.ok) return { ok: false, error: sess.error };
    const reloaded = await load(w, target);
    if (!reloaded.ok) return { ok: false, error: reloaded.error, motivo: reloaded.timeout ? "timeout" : "carregamento" };
    await jitter(2500, 5000);
    for (let i = 0; i < 2; i += 1) {
      await w.webContents.executeJavaScript("window.scrollBy(0, Math.round(window.innerHeight * 0.8)); true", true).catch(() => {});
      await jitter(2500, 4500);
    }
    if (kind === "salvos") {
      const captured = await w.webContents.executeJavaScript(SAVED_SCRIPT, true).catch(() => ({ items: [], diagnostics: { erro: "executeJavaScript" } }));
      const posts = Array.isArray(captured) ? captured : (captured.items || []);
      if (!w.isVisible()) w.loadURL("about:blank").catch(() => {});
      return { ok: true, ...(await api("POST", "/api/vagas/posts-salvos", { posts: posts.slice(0, 30) })), diagnostico: Array.isArray(captured) ? null : captured.diagnostics };
    }
    if (kind === "salvos-vagas") {
      const captured = await w.webContents.executeJavaScript(BROWSER_CAPTURE_SCRIPT, true).catch(() => ({ items: [], diagnostics: { erro: "executeJavaScript" } }));
      const items = Array.isArray(captured) ? captured : (captured.items || []);
      if (!w.isVisible()) w.loadURL("about:blank").catch(() => {});
      return { ok: true, ...(await api("POST", "/api/vagas/ingest-browser", { platform: "linkedin", items: items.slice(0, 40) })), diagnostico: Array.isArray(captured) ? null : captured.diagnostics };
    }
    if (kind === "notificacoes") {
      const captured = await w.webContents.executeJavaScript(NOTIF_SCRIPT, true).catch(() => ({ items: [], diagnostics: { erro: "executeJavaScript" } }));
      const posts = Array.isArray(captured) ? captured : (captured.items || []);
      if (!w.isVisible()) w.loadURL("about:blank").catch(() => {});
      return { ok: true, ...(await api("POST", "/api/vagas/notificacoes", { posts: posts.slice(0, 30) })), diagnostico: Array.isArray(captured) ? null : captured.diagnostics };
    }
    if (kind === "busca") {
      // Devolve HTML truncado para o servidor parsear (sem massa); ou usa guest parse no jobs.
      const captured = await w.webContents.executeJavaScript(
        `({ html: document.documentElement.outerHTML.slice(0, 200000), diagnostics: { title: document.title, url: location.href, bodyChars: (document.body?.innerText || '').length, jobLinks: [...document.querySelectorAll('a[href*="/jobs/view/"]')].length } })`,
        true,
      ).catch(() => ({ html: "", diagnostics: { erro: "executeJavaScript" } }));
      if (!w.isVisible()) w.loadURL("about:blank").catch(() => {});
      return { ok: true, ...(await api("POST", "/api/vagas/ingest-html", { tipo: "busca", html: captured.html || "", term })), diagnostico: captured.diagnostics };
    }
    return scanFeed();
  }

  const BROWSER_SEARCH_SCRIPT = (term) => `(() => {
    const q = ${JSON.stringify(String(term || ""))};
    const norm = (v) => String(v || "").toLowerCase();
    const inputs = [...document.querySelectorAll('input:not([type="hidden"]), textarea')].filter((el) => {
      const text = norm([el.placeholder, el.getAttribute('aria-label'), el.name, el.id, el.getAttribute('data-testid')].join(' '));
      return el.getClientRects().length && !el.disabled && /busca|pesquis|search|cargo|compet[eê]ncia|vaga|oportunidade|palavra|keyword|o que|what/.test(text);
    });
    const el = inputs[0];
    const diagnostics = { inputs: inputs.length, title: document.title, url: location.href, bodyChars: (document.body?.innerText || '').length };
    if (!el) return { ok: false, reason: 'campo_busca_nao_encontrado', diagnostics };
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, q);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"], a')].filter((b) => b.getClientRects().length && /busca|pesquis|search|encontrar|find/i.test([b.innerText, b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid')].join(' ')));
    if (buttons[0]) buttons[0].click();
    else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return { ok: true, method: buttons[0] ? 'button' : 'enter', diagnostics };
  })()`;

  const BROWSER_CAPTURE_SCRIPT = `(() => {
    const anchors = [...document.querySelectorAll('a[href]')].filter((a) => /(linkedin[.]com[/]jobs[/]view|gupy[.]io[/](job|jobs)[/])/i.test(a.href));
    const items = [...new Map(anchors.map((a, index) => {
      const card = a.closest('article, li, [data-job-id], [data-testid*="job" i], div');
      const text = (card?.innerText || a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1800);
      const heading = card?.querySelector('h1,h2,h3,h4,[class*="title" i]');
      return [a.href.split('?')[0], { extId: (a.href.match(/(?:jobs[/]view|job)[/](\\d+)/i) || [])[1] || a.href, title: (heading?.innerText || a.innerText || text).trim().slice(0, 200), company: '', url: a.href.split('?')[0], description: text }];
    }))].map(([, value]) => value).filter((x) => x.title && x.url);
    return { items: items.slice(0, 40), diagnostics: { anchors: anchors.length, itemCount: items.length, title: document.title, url: location.href, bodyChars: (document.body?.innerText || '').length } };
  })()`;

  /** Busca visual em cada site configurado: home, campo de busca, Enter/clique, rolagem e cards. */
  async function searchPlatforms({ terms = [], location = "Brasil" } = {}) {
    const prefData = await api("GET", "/api/vagas");
    const prefs = prefData.prefs || {};
    const ids = Array.isArray(prefs.plataformas) && prefs.plataformas.length ? prefs.plataformas : ["linkedin", "gupy"];
    const words = (Array.isArray(terms) && terms.length ? terms : (prefs.termos || ["desenvolvedor front-end"])).slice(0, 5);
    const results = [];
    for (const id of ids) {
      const platform = currentPlatforms()[id];
      if (!platform) { results.push({ plataforma: id, ok: false, erro: "plataforma não configurada" }); continue; }
      for (const term of words) {
        const home = id === "linkedin" ? "https://www.linkedin.com/jobs/" : id === "gupy" ? "https://portal.gupy.io/" : platform.loginUrl;
        const target = typeof platform.searchUrl === "function" ? platform.searchUrl(term, location) : home;
        const w = getWin(id);
        const loaded = await load(w, home);
        if (!loaded.ok) { results.push({ plataforma: id, termo: term, ok: false, erro: loaded.error, motivo: loaded.timeout ? "timeout" : "carregamento" }); continue; }
        if (id === "linkedin") {
          const sess = await ensureLinkedInSession(w);
          if (!sess.ok) { results.push({ plataforma: id, termo: term, ok: false, erro: sess.error, motivo: "sessao" }); continue; }
        }
        const searched = await w.webContents.executeJavaScript(BROWSER_SEARCH_SCRIPT(term), true).catch(() => ({ ok: false, reason: "executeJavaScript" }));
        let fallback = false;
        if (!searched.ok) {
          fallback = true;
          const fallbackLoad = await load(w, target);
          if (!fallbackLoad.ok) { results.push({ plataforma: id, termo: term, ok: false, erro: fallbackLoad.error, motivo: fallbackLoad.timeout ? "timeout" : "carregamento", busca: searched }); continue; }
        }
        await jitter(2500, 5000);
        for (let i = 0; i < 5; i += 1) {
          await w.webContents.executeJavaScript("window.scrollBy(0, Math.round(window.innerHeight * 0.8)); true", true).catch(() => {});
          await jitter(1200, 2400);
        }
        const captured = await w.webContents.executeJavaScript(BROWSER_CAPTURE_SCRIPT, true).catch(() => ({ items: [], diagnostics: { erro: "executeJavaScript" } }));
        const ingested = await api("POST", "/api/vagas/ingest-browser", { platform: id, term, html: await w.webContents.executeJavaScript("document.documentElement.outerHTML.slice(0, 500000)", true).catch(() => ""), items: captured.items || [] });
        results.push({ plataforma: id, termo: term, ok: true, busca: searched, fallbackUrl: fallback, ...ingested, diagnostico: captured.diagnostics });
        if (!w.isVisible()) w.loadURL("about:blank").catch(() => {});
      }
    }
    return { ok: true, resultados: results, novas: results.reduce((n, r) => n + (Number(r.novas) || 0), 0), erros: results.filter((r) => r.ok === false).map((r) => `${r.plataforma} (${r.termo}): ${r.erro}`) };
  }
  ipcMain.handle("vagas:salvos", () => scanLinkedInKind("salvos"));
  ipcMain.handle("vagas:notificacoes", () => scanLinkedInKind("notificacoes"));
  ipcMain.handle("vagas:busca-li", (_e, opts) => scanLinkedInKind("busca", opts || {}));
  ipcMain.handle("vagas:nunca-postar", (_e, acao) => assertNuncaPostarLinkedIn(acao));

  // ---------------- Leva E: modo automático ----------------
  let autoRunning = false;
  let stopRequested = false;

  /** CV no campo de arquivo: só com o depurador do Chromium (o JS da página não pode escolher arquivo). */
  async function setFile(w, sel, filePath) {
    if (!fs.existsSync(filePath)) throw new Error("O arquivo do CV não existe no caminho do perfil.");
    const dbg = w.webContents.debugger;
    let attached = false;
    try {
      if (!dbg.isAttached()) { dbg.attach("1.3"); attached = true; }
      const { root } = await dbg.sendCommand("DOM.getDocument", { depth: -1 });
      const { nodeId } = await dbg.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
      if (!nodeId) throw new Error("campo do CV sumiu");
      await dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files: [filePath] });
    } finally {
      if (attached) try { dbg.detach(); } catch { /* já solto */ }
    }
  }

  /**
   * Segredos só para o código (resolveFill / planFill). CPF do cofre; demais do perfil.
   * Nunca vão ao prompt do modelo (fill-privacy usa placeholders).
   */
  function vaultSecrets(profile = {}) {
    const secrets = {};
    try {
      if (typeof vault.getKey === "function") {
        const cpf = String(vault.getKey("cpf") || "").trim();
        if (cpf) secrets.cpf = cpf;
      }
    } catch { /* cofre indisponível */ }
    for (const key of ["telefone", "endereco", "email", "nome", "cvPath"]) {
      const val = String((profile && profile[key]) || "").trim();
      if (val) secrets[key] = val;
    }
    return secrets;
  }

  /**
   * Plano de preenchimento: tenta LLM gratis (só vaga + rótulos); se falhar, planFill atual.
   * Retorna { acoes, criticos, via }.
   */
  async function resolvePlan(vaga, fields, profile, respostas, page, secrets) {
    if (freeLlm && typeof freeLlm.chat === "function") {
      try {
        const llmPlan = await privacy.planFillLlm(freeLlm, vaga, fields, secrets);
        const criticos = (llmPlan.faltando || []).map((f) => `Falta ${f}`);
        if (llmPlan.acoes && llmPlan.acoes.length) {
          return { acoes: llmPlan.acoes, criticos, via: "llm", model: llmPlan.model };
        }
        if (!criticos.length) return { acoes: llmPlan.acoes || [], criticos: [], via: "llm", model: llmPlan.model };
      } catch { /* cai no preenchimento atual */ }
    }
    const plan = fill.planFill(fields, profile, respostas, page || {}, secrets);
    return { acoes: plan.acoes || [], criticos: plan.criticos || [], via: "rules" };
  }

  /**
   * Uma vaga: abre, clica em candidatar, preenche etapa por etapa.
   * opts.enviar=false (modo aprovação / vaga aprovada): preenche e PARA antes de enviar.
   * Crítico = para e pergunta.
   */
  async function applyOne(vaga, profile, respostas, opts = {}) {
    const enviar = opts.enviar !== false;
    let appState = application.STATES.OPENING;
    const evidence = [];
    const mark = (event, detail = "") => {
      appState = application.transition(appState, event, { evidence: [...evidence, application.evidence(event, detail)] }).state;
      evidence.push(application.evidence(event, detail));
    };
    const result = (out, event = "") => ({ ...out, estado: event ? application.transition(appState, event).state : appState, evidencia: evidence.slice(-12) });
    const secrets = vaultSecrets(profile);
    if (mock) {
      const fields = vaga.mockFields || [{ sel: "a", type: "text", label: "Nome completo", required: true }, { sel: "b", type: "email", label: "E-mail", required: true }];
      const plan = await resolvePlan(vaga, fields, profile, respostas, { text: vaga.description || "" }, secrets);
      if (plan.criticos.length) return result({ critico: plan.criticos[0], pergunta: plan.criticos.join(" | "), via: plan.via, model: plan.model || null }, "challenge");
      mark("review", "modo demonstração: formulário analisado");
      return result({
        ok: true,
        nota: `demonstração: ${plan.acoes.length} campo(s) preenchido(s)`,
        via: plan.via,
        model: plan.model || null,
        enviado: false,
        paradoAntesDeEnviar: !enviar,
        acoes: plan.acoes,
      }, "review");
    }
    const w = getWin(vaga.platform);
    const loaded = await load(w, vaga.url);
    if (!loaded.ok) return result({ critico: loaded.error, motivo: loaded.timeout ? "timeout" : "carregamento" }, "failed");
    const js = (code) => w.webContents.executeJavaScript(code, true);
    let probe0 = await js(PROBE).catch(() => ({}));
    // Sessão expirou: entra de novo com o cofre (e o código do Gmail, se pedir) e volta para a vaga.
    if ((probe0.password || /login|signin|authwall/i.test(w.webContents.getURL())) && !probe0.captcha) {
      const relog = await login(vaga.platform);
      if (!relog.ok) return result({ critico: relog.error }, "challenge");
      const relogLoaded = await load(w, vaga.url);
      if (!relogLoaded.ok) return result({ critico: relogLoaded.error, motivo: relogLoaded.timeout ? "timeout" : "carregamento" }, "failed");
      probe0 = await js(PROBE).catch(() => ({}));
    }
    const challenge0 = detectChallenge(w.webContents.getURL(), probe0);
    if (challenge0) return result({ critico: challenge0 }, "challenge");
    const opened = await js(fill.clickScript("apply")).catch(() => "");
    if (!opened) return result({ critico: "Não achei o botão de candidatura com segurança (pode ser site externo da empresa)." }, "failed");
    mark("opened", opened);
    await sleep(2500);
    let filledTotal = 0;
    for (let step = 0; step < 10; step += 1) {
      if (stopRequested) return result({ critico: "Você pediu para parar." }, "challenge");
      const probe = await js(PROBE).catch(() => ({}));
      const challenge = detectChallenge(w.webContents.getURL(), probe);
      if (challenge) return result({ critico: challenge }, "challenge");
      const { fields, page } = await js(fill.INSPECT_SCRIPT).catch(() => ({ fields: [], page: {} }));
      const pageState = application.pageResult({ url: page.url, text: page.text, formVisible: fields.length > 0, challenge });
      if (pageState.state === application.STATES.SUBMITTED) return result({ ok: true, nota: `${filledTotal} campo(s) preenchido(s)`, enviado: true, confirmacao: pageState.reason }, "submitted");
      const plan = await resolvePlan(vaga, fields, profile, respostas, page, secrets);
      if (plan.criticos.length) return result({ critico: plan.criticos[0], pergunta: plan.criticos.join(" | "), via: plan.via, model: plan.model || null }, "challenge");
      filledTotal += await js(fill.applyScript(plan.acoes)).catch(() => 0);
      for (const a of plan.acoes.filter((x) => x.kind === "file")) {
        try { await setFile(w, a.sel, a.valor); filledTotal += 1; } catch (e) { return result({ critico: `Não consegui anexar o CV: ${e.message}` }, "failed"); }
      }
      await sleep(800);
      // Modo aprovação: preenche e para — Helison revisa e envia no site.
      if (!enviar) {
        try { w.show(); w.focus(); } catch { /* janela opcional */ }
        mark("review", `${filledTotal} campo(s) preenchido(s); aguardando revisão`);
        return result({
          ok: true,
          paradoAntesDeEnviar: true,
          enviado: false,
          via: plan.via,
          model: plan.model || null,
          nota: `${filledTotal} campo(s) preenchido(s). Revise e envie no site — nada foi submetido.`,
        }, "review");
      }
      const clicked = (await js(fill.clickScript("submit")).catch(() => "")) || (await js(fill.clickScript("review")).catch(() => "")) || (await js(fill.clickScript("next")).catch(() => ""));
      if (!clicked) return result({ critico: "Não achei o próximo botão do formulário com segurança." }, "failed");
      mark("submit", clicked);
      await sleep(2500);
      const after = await js("(document.body.innerText || '').slice(0, 6000)").catch(() => "");
      const afterState = application.pageResult({ url: w.webContents.getURL(), text: after, formVisible: false });
      if (afterState.state === application.STATES.SUBMITTED) return result({ ok: true, nota: `${filledTotal} campo(s) preenchido(s)`, enviado: true, via: plan.via, model: plan.model || null, confirmacao: afterState.reason }, "submitted");
    }
    return result({ critico: "O formulário passou de 10 etapas sem confirmar o envio. Confira no site." }, "failed");
  }

  /**
   * Preenche candidatura de vaga JÁ APROVADA pelo Helison (cartão).
   * Usa planFillLlm quando disponível; para antes de enviar. Aceita objeto vaga (testes) ou id.
   */
  async function preencherAprovada(vagaOrId, { profile = null, respostas = {} } = {}) {
    let vaga = vagaOrId;
    if (typeof vagaOrId === "string") {
      try {
        const data = await api("GET", `/api/vagas/${encodeURIComponent(vagaOrId)}`);
        vaga = data.vaga;
      } catch (e) {
        return { ok: false, error: e.message || "Vaga não encontrada.", enviado: false };
      }
    }
    if (!vaga || vaga.status !== "aprovada") {
      return { ok: false, error: "Essa vaga ainda não foi aprovada no cartão.", enviado: false };
    }
    let prefsPerfil = {};
    let prefsRespostas = respostas || {};
    if (!profile || !Object.keys(respostas || {}).length) {
      try {
        const prefsData = await api("GET", "/api/vagas");
        if (prefsData && prefsData.prefs) {
          prefsPerfil = prefsData.prefs.perfil || {};
          if (!Object.keys(respostas || {}).length) prefsRespostas = prefsData.prefs.respostas || {};
        }
      } catch { /* prefs opcional (mock/testes) */ }
    }
    const prof = profile || fill.profileFrom(readProfile(), prefsPerfil);
    return applyOne(vaga, prof, prefsRespostas, { enviar: false });
  }

  /** Roda a fila do automático. O servidor decide quem entra (modo, limite, repetição, empresas evitadas). */
  async function runAuto({ origem = "app" } = {}) {
    if (autoRunning) return { ok: false, error: "O automático já está rodando." };
    autoRunning = true;
    stopRequested = false;
    const out = { enviadas: 0, criticas: 0, falhas: 0, origem };
    try {
      const { fila, prefs } = await api("GET", "/api/vagas/auto/fila");
      if (prefs.modo !== "automatico") return { ok: false, error: "O modo automático está desligado." };
      const profile = fill.profileFrom(readProfile(), prefs.perfil);
      const loggedIn = new Set();
      for (const vaga of fila) {
        if (stopRequested) break;
        if (!mock && !loggedIn.has(vaga.platform) && (await sessaoAtiva(vaga.platform))) loggedIn.add(vaga.platform);
        if (!mock && !loggedIn.has(vaga.platform)) {
          // O automático não pode ficar preso numa janela de login por minutos.
          // O modo silencioso ainda tenta preencher 2FA por e-mail; CAPTCHA,
          // login Google ou timeout viram bloqueio desta vaga e a fila segue.
          const r = await login(vaga.platform, { silent: true, timeoutMs: 45000 });
          if (!r.ok) {
            await api("POST", `/api/vagas/${encodeURIComponent(vaga.id)}/auto/iniciar`, {}).catch(() => {});
            await api("POST", `/api/vagas/${encodeURIComponent(vaga.id)}/auto/resultado`, { critico: r.error || "Login pediu 2FA ou captcha." }).catch(() => {});
            out.criticas += 1;
            continue;
          }
          loggedIn.add(vaga.platform);
        }
        try {
          await api("POST", `/api/vagas/${encodeURIComponent(vaga.id)}/auto/iniciar`, {});
        } catch {
          continue; // limite, repetição ou modo mudou: o servidor recusou, passa para a próxima
        }
        let result;
        try { result = await applyOne(vaga, profile, prefs.respostas || {}); } catch (e) { result = { nota: String(e.message || e).slice(0, 200) }; }
        if (result.via) result.nota = `${result.nota || ""} [via ${result.via}${result.model ? " " + result.model : ""}]`.trim();
        (out.detalhes = out.detalhes || []).push({ id: vaga.id, titulo: vaga.title, ok: !!result.ok, critico: result.critico || null, nota: result.nota || null, via: result.via || null, model: result.model || null });
        await api("POST", `/api/vagas/${encodeURIComponent(vaga.id)}/auto/resultado`, result).catch(() => {});
        if (result.ok) out.enviadas += 1; else if (result.critico) out.criticas += 1; else out.falhas += 1;
      }
      return { ok: true, ...out };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    } finally {
      autoRunning = false;
      for (const w of wins.values()) if (!w.isDestroyed() && !w.isVisible()) w.loadURL("about:blank").catch(() => {});
    }
  }
  ipcMain.handle("vagas:auto", () => runAuto({ origem: "app" }));

  /** Só abre vaga APROVADA no cartão. O envio final é do Helison, na janela, e depois ele marca o resultado. */
  ipcMain.handle("vagas:abrir", async (_event, id) => {
    try {
      const { vaga } = await api("GET", `/api/vagas/${encodeURIComponent(String(id))}`);
      if (!vaga || vaga.status !== "aprovada") return { ok: false, error: "Essa vaga ainda não foi aprovada no cartão." };
      if (!/^https:\/\//i.test(vaga.url)) return { ok: false, error: "Endereço da vaga inválido." };
      if (mock) return { ok: true, mock: true, message: "Modo demonstração: a janela da vaga não foi aberta." };
      const w = getWin(vaga.platform);
      await load(w, vaga.url);
      w.show(); w.focus();
      return { ok: true, message: "Abri a vaga na janela do HELIOS, já com a sua sessão. Copie a carta aprovada do cartão, revise, envie no site e depois marque o resultado aqui." };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** LEVA R2: preenche vaga aprovada (LLM + cofre) e para antes de enviar. */
  ipcMain.handle("vagas:preencher", (_event, id) => preencherAprovada(String(id || "")));

  ipcMain.handle("vagas:janela", () => {
    if (mock) return { ok: true, mock: true };
    const w = getWin(); w.show(); w.focus();
    return { ok: true };
  });

  return {
    runAuto,
    scanFeed,
    scanLinkedInKind,
    searchPlatforms,
    assertNuncaPostarLinkedIn,
    login,
    abrirLogin,
    sessoes,
    diagnostico,
    loginTodas,
    preencherAprovada,
    platforms: currentPlatforms,
    stopAuto: () => { stopRequested = true; return { ok: true, rodando: autoRunning }; },
    flushCookies: (opts) => cookieSaver.flush(opts),
    close: () => { cookieSaver.stop(); for (const w of wins.values()) if (!w.isDestroyed()) w.destroy(); },
  };
}

module.exports = { isOAuthPopupUrl,
  registerJobs, detectChallenge, findLoginFor, fillScript, CHALLENGE_URL,
  partitionFor, legacyPartitionFor, migrateVagasSession, isGoogleAccountsUrl,
  SHARED_VAGAS_PARTITION, VAGAS_SESSAO_MARKER, mergePlatforms,
  FEED_SCRIPT, SAVED_SCRIPT, NOTIF_SCRIPT, assertNuncaPostarLinkedIn,
  classifyLoginResult, shouldTryReserva, RESERVA_EMAIL, LOGIN_TIMEOUT_MS,
};
