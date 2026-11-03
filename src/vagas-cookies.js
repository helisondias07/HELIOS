"use strict";

/**
 * Leva Q5: salva os cookies da persist:vagas em disco (flushStore + flushStorageData)
 * ao esconder/fechar janela de vagas, no before-quit e a cada 60 s. Cookies de sessao
 * (sem validade) dos dominios das plataformas viram persistentes (30 dias).
 */
const PERSIST_DAYS = 30;

function hostOfUrl(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ""; }
}

/** Dominios-base (ex.: gupy.io, vagas.com.br) a partir das URLs das plataformas. */
function platformDomains(platforms = []) {
  const out = new Set();
  const list = Array.isArray(platforms) ? platforms : Object.values(platforms || {});
  for (const p of list) {
    const h = hostOfUrl(p && (p.url || p.loginUrl || p.home));
    if (!h) continue;
    const parts = h.replace(/^www\./, "").split(".");
    const n = parts.length >= 3 && /^(com|net|org|gov|edu)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
    out.add(parts.slice(-n).join("."));
  }
  return [...out];
}

function cookieMatches(domain, domains) {
  const d = String(domain || "").replace(/^\./, "").toLowerCase();
  return d && domains.some((base) => d === base || d.endsWith(`.${base}`));
}

/** Pura: detalhes para cookies.set que tornam um cookie de sessao persistente; null se nao se aplica. */
function persistentDetails(cookie, domains, nowMs = Date.now()) {
  if (!cookie || !cookie.session || cookie.expirationDate) return null;
  if (!cookieMatches(cookie.domain, domains)) return null;
  const host = String(cookie.domain || "").replace(/^\./, "");
  const details = {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
    name: cookie.name, value: cookie.value, path: cookie.path || "/",
    secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly),
    expirationDate: Math.floor(nowMs / 1000) + PERSIST_DAYS * 86400,
  };
  if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain;
  if (cookie.sameSite && cookie.sameSite !== "unspecified") details.sameSite = cookie.sameSite;
  return details;
}

function createCookieSaver({ ses, getDomains = () => [], intervalMs = 60e3, timers = { setInterval, clearInterval }, now = () => Date.now() } = {}) {
  let timer = null;
  let busy = null;
  async function convert() {
    if (!ses || !ses.cookies || typeof ses.cookies.get !== "function") return 0;
    const domains = getDomains();
    if (!domains.length) return 0;
    let n = 0;
    const all = await ses.cookies.get({});
    for (const c of all) {
      const det = persistentDetails(c, domains, now());
      if (!det) continue;
      try { await ses.cookies.set(det); n++; } catch { /* cookie recusado: segue */ }
    }
    return n;
  }
  // Leva Q6: converte no evento "changed" (valor mais novo, sem corrida com rotacao de token).
  // Antes (Q5) a conversao rodava a cada 60 s com get->set e podia regravar um token ja rotacionado.
  let watching = false;
  function onChanged(_e, cookie, _cause, removed) {
    if (removed) return;
    const det = persistentDetails(cookie, getDomains(), now());
    if (det) Promise.resolve(ses.cookies.set(det)).catch(() => {});
  }
  function watch() {
    if (watching || !ses || !ses.cookies || typeof ses.cookies.on !== "function") return false;
    ses.cookies.on("changed", onChanged);
    watching = true;
    return true;
  }
  /** final=true (before-quit) tambem converte os cookies de sessao restantes; o timer so faz flush. */
  async function flush({ final = false } = {}) {
    if (busy) return busy;
    busy = (async () => {
      let convertidos = 0;
      if (final) { try { convertidos = await convert(); } catch { /* ignora */ } }
      try { if (ses && ses.cookies && ses.cookies.flushStore) await ses.cookies.flushStore(); } catch { /* ignora */ }
      try { if (ses && typeof ses.flushStorageData === "function") ses.flushStorageData(); } catch { /* ignora */ }
      return { ok: true, convertidos };
    })();
    try { return await busy; } finally { busy = null; }
  }
  function start() {
    if (timer || !intervalMs) return;
    timer = timers.setInterval(() => { flush().catch(() => {}); }, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }
  function stop() {
    if (timer) timers.clearInterval(timer);
    timer = null;
    if (watching && ses.cookies.removeListener) ses.cookies.removeListener("changed", onChanged);
    watching = false;
  }
  return { flush, start, stop, convert, watch, onChanged };
}

module.exports = { createCookieSaver, persistentDetails, platformDomains, cookieMatches, PERSIST_DAYS };
/** Leva Q6: user-agent de Chrome comum (sem "Electron/" nem "HELIOS/") para as janelas de vagas. */
function cleanUserAgent(ua) {
  return String(ua || "").replace(/\s?(Electron|helios|HELIOS)\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
}

/** Leva Q6: metadados de cookie para diagnostico (NUNCA o valor). */
function cookieMeta(c) {
  return {
    nome: c.name, dominio: c.domain, caminho: c.path, hostOnly: Boolean(c.hostOnly), sessao: Boolean(c.session),
    expira: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString().slice(0, 16) : "sessao",
    secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly), sameSite: c.sameSite || "",
  };
}

module.exports.cleanUserAgent = cleanUserAgent;
module.exports.cookieMeta = cookieMeta;