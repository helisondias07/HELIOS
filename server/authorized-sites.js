"use strict";

/**
 * LEVA L: domínios autorizados por assistente.
 * Cookies/sessão do perfil principal só podem ser reaproveitados nestes domínios.
 */
const path = require("node:path");
const { readJson, writeJson } = require("./util");

function normalizeDomain(raw) {
  let d = String(raw || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!d || d.length > 120 || /[^a-z0-9.-]/.test(d) || !d.includes(".")) return "";
  return d;
}

function hostOf(url) {
  try {
    const u = new URL(String(url || ""));
    return String(u.hostname || "").toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Domínio da URL está autorizado? Aceita match exato ou sufixo (ex.: mail.google.com sob google.com). */
function isAuthorized(host, domains = []) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!h) return false;
  return (domains || []).some((d) => {
    const n = normalizeDomain(d);
    return n && (h === n || h.endsWith(`.${n}`));
  });
}

function createAuthorizedSites(dataDir) {
  const file = path.join(dataDir, "authorized-sites.json");
  let data = readJson(file, { version: 1, byAssistant: {} });
  if (!data.byAssistant || typeof data.byAssistant !== "object") data = { version: 1, byAssistant: {} };
  const save = () => writeJson(file, data);

  function list(assistantId) {
    const key = String(assistantId || "default");
    const rows = data.byAssistant[key];
    return Array.isArray(rows) ? rows.map(normalizeDomain).filter(Boolean) : [];
  }

  function set(assistantId, domains) {
    const key = String(assistantId || "default");
    const clean = [...new Set((Array.isArray(domains) ? domains : String(domains || "").split(/[\s,;]+/))
      .map(normalizeDomain)
      .filter(Boolean))].slice(0, 40);
    data.byAssistant[key] = clean;
    save();
    return list(key);
  }

  function allows(assistantId, urlOrHost) {
    const host = hostOf(urlOrHost) || String(urlOrHost || "").toLowerCase().replace(/^www\./, "");
    return isAuthorized(host, list(assistantId));
  }

  function drop(assistantId) {
    const key = String(assistantId || "");
    if (!key || key === "default") return false;
    if (!(key in data.byAssistant)) return false;
    delete data.byAssistant[key];
    save();
    return true;
  }

  return { list, set, allows, drop, normalizeDomain, hostOf, isAuthorized, file };
}

module.exports = { createAuthorizedSites, normalizeDomain, hostOf, isAuthorized };
