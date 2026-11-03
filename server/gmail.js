"use strict";

/**
 * Leva G: Gmail pela API REST, no processo principal do HELIOS (nunca pelo modelo).
 * Lê com gmail.readonly. O leitor de código de verificação devolve o código só para quem o
 * chamou (o navegador das vagas); ele nunca vai para log, histórico, cartão ou modelo.
 */
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Regex padrão de código: 4 a 8 dígitos (ou alfanumérico com "código"/"code" perto). */
const DEFAULT_CODE_RE = /(?:c[oó]digo|code|token|pin|verifica\w*)[^0-9A-Z]{0,40}([0-9]{4,8}|[A-Z0-9]{6,8})\b|\b([0-9]{6})\b/i;

function decodeB64(data) {
  try { return Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return ""; }
}

const stripHtml = (html) => String(html || "")
  .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\s+/g, " ").trim();

/** Texto de uma mensagem do Gmail (format=full): prefere text/plain, cai para HTML sem tags. */
function messageText(msg) {
  const plain = [];
  const html = [];
  const walk = (part) => {
    if (!part) return;
    const mime = String(part.mimeType || "");
    if (part.body && part.body.data) {
      if (mime === "text/plain") plain.push(decodeB64(part.body.data));
      else if (mime === "text/html") html.push(stripHtml(decodeB64(part.body.data)));
    }
    for (const child of part.parts || []) walk(child);
  };
  walk(msg && msg.payload);
  const text = plain.join("\n").trim() || html.join("\n").trim() || String(msg?.snippet || "");
  return text.slice(0, 20000);
}

function header(msg, name) {
  const found = (msg?.payload?.headers || []).find((h) => String(h.name).toLowerCase() === name.toLowerCase());
  return found ? String(found.value || "") : "";
}

/** Busca de código: remetente + janela de 10 minutos. */
function codeQuery({ from = "", newerThan = "10m" } = {}) {
  const parts = [];
  if (from) parts.push(`from:(${String(from).replace(/[()"]/g, "")})`);
  parts.push(`newer_than:${newerThan}`);
  return parts.join(" ");
}

/** Pura: acha o código no texto. Regex do site primeiro; senão, a padrão. */
function extractCode(text, regex) {
  const body = String(text || "");
  let re = DEFAULT_CODE_RE;
  if (regex) {
    try { re = regex instanceof RegExp ? regex : new RegExp(String(regex), "i"); } catch { re = DEFAULT_CODE_RE; }
  }
  const m = re.exec(body);
  if (!m) return "";
  const got = m.slice(1).find(Boolean) || m[0];
  return String(got).trim().slice(0, 12);
}

function createGmailClient({ fetchImpl = globalThis.fetch, getAuthorization }) {
  async function get(pathname) {
    const auth = await getAuthorization();
    if (!auth) throw Object.assign(new Error("A conta Gmail precisa entrar de novo."), { code: "REAUTH" });
    const res = await fetchImpl(`${API}${pathname}`, { headers: { authorization: auth, accept: "application/json" } });
    if (res.status === 401) throw Object.assign(new Error("A conta Gmail precisa entrar de novo."), { code: "REAUTH" });
    if (!res.ok) throw new Error(`Gmail respondeu ${res.status}.`);
    return res.json();
  }
  async function search(q, max = 10) {
    const data = await get(`/messages?maxResults=${Math.min(50, max)}&q=${encodeURIComponent(q)}`);
    return Array.isArray(data.messages) ? data.messages : [];
  }
  async function message(id, format = "full") {
    return get(`/messages/${encodeURIComponent(id)}?format=${format}`);
  }
  async function profile() { return get("/profile"); }
  return { search, message, profile };
}

/**
 * Espera o código chegar. Só aceita e-mail com internalDate >= início do login.
 * Devolve { code } ou { code: "", motivo }. Nunca registra o código.
 */
async function waitForCode({ clients, from = "", regex = null, since, intervalMs = 4000, timeoutMs = 120000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const deadline = now() + timeoutMs;
  const seen = new Set();
  const q = codeQuery({ from, newerThan: "10m" });
  while (now() <= deadline) {
    for (const client of clients) {
      let list = [];
      try { list = await client.search(q, 5); } catch { continue; }
      for (const ref of list) {
        if (seen.has(ref.id)) continue;
        seen.add(ref.id);
        let msg;
        try { msg = await client.message(ref.id); } catch { continue; }
        if (Number(msg.internalDate) < Number(since)) continue;
        const code = extractCode(`${header(msg, "subject")}\n${messageText(msg)}`, regex);
        if (code) return { code };
      }
    }
    if (now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  return { code: "", motivo: "O código não chegou no Gmail em 2 minutos." };
}

module.exports = { createGmailClient, waitForCode, extractCode, codeQuery, messageText, header, stripHtml, DEFAULT_CODE_RE, API };
