"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { readJson, writeJson } = require("./util");

/**
 * Leva E: controle remoto pelo Telegram. Long polling (getUpdates), sem abrir porta.
 * Só o chat pareado (código mostrado no app) é atendido; qualquer outro é ignorado.
 * O token vem do cofre por getToken() e nunca vai para log, erro ou tela.
 */
function createTelegram({ dataDir, getToken = () => "", fetchImpl = globalThis.fetch, handlers = {}, log = () => {}, now = () => Date.now(), pollTimeoutSec = 25 }) {
  const file = path.join(dataDir, "telegram.json");
  let state = readJson(file, {});
  state = { ligado: false, ownerChatId: null, ownerName: "", offset: 0, codigo: "", codigoAte: 0, ultimoResumo: "", ...state };
  const save = () => writeJson(file, state);
  let running = false;
  let lastError = "";
  let loop = null;
  const scrub = (text) => {
    const token = String(getToken() || "");
    let out = String(text || "");
    if (token) out = out.split(token).join("[token]");
    return out.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot[token]").slice(0, 300);
  };

  async function call(method, body) {
    const token = String(getToken() || "");
    if (!token) throw new Error("Sem token do Telegram no Cofre.");
    let res;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    } catch (err) {
      throw new Error(scrub(`Telegram fora do ar: ${err.message || err}`));
    }
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw Object.assign(new Error(scrub(`Telegram recusou (${res.status}): ${data.description || ""}`)), { status: res.status });
    return data.result;
  }

  function status() {
    return {
      ligado: state.ligado,
      rodando: running,
      temToken: Boolean(getToken()),
      pareado: Boolean(state.ownerChatId),
      dono: state.ownerName || "",
      codigo: !state.ownerChatId && state.codigo && state.codigoAte > now() ? state.codigo : "",
      erro: lastError,
    };
  }

  /** Código de pareamento de 6 dígitos, vale 15 minutos. */
  function newCode() {
    state.codigo = String(crypto.randomInt(100000, 1000000));
    state.codigoAte = now() + 15 * 60e3;
    save();
    return state.codigo;
  }

  function unpair() {
    state.ownerChatId = null;
    state.ownerName = "";
    save();
    return status();
  }

  /** Só manda para o dono. buttons: [[{ text, data }]] */
  async function send(text, buttons = null) {
    if (!state.ownerChatId || !getToken()) return false;
    const body = { chat_id: state.ownerChatId, text: String(text || "").slice(0, 3900), disable_web_page_preview: true };
    if (buttons) body.reply_markup = { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: String(b.data).slice(0, 64) }))) };
    try {
      await call("sendMessage", body);
      return true;
    } catch (err) {
      lastError = err.message;
      return false;
    }
  }

  async function handleUpdate(update) {
    const msg = update.message;
    const cb = update.callback_query;
    const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    // Pareamento: único caso em que um chat desconhecido é ouvido, e só com o código certo e válido.
    if (msg && !state.ownerChatId) {
      const m = String(msg.text || "").trim().match(/^\/(?:parear|start)\s+(\d{6})$/);
      if (m && state.codigo && m[1] === state.codigo && state.codigoAte > now() && msg.chat.type === "private") {
        state.ownerChatId = chatId;
        state.ownerName = String(msg.from?.first_name || "").slice(0, 40);
        state.codigo = "";
        save();
        await send("Pareado com o HELIOS. Mande uma tarefa em texto, ou use /status, /vagas e /parar.");
      }
      return;
    }
    if (chatId !== state.ownerChatId) return; // qualquer outro chat: ignorado, sem resposta
    if (cb) {
      await call("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      const reply = await Promise.resolve(handlers.onCallback?.(String(cb.data || ""))).catch((err) => `Não deu: ${err.message}`);
      if (reply) await send(reply);
      return;
    }
    const text = String(msg.text || "").trim();
    if (!text) return;
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    const command = cmd.startsWith("/") ? cmd.slice(1).split("@")[0].toLowerCase() : "";
    let reply;
    try {
      if (command === "status") reply = await handlers.status?.();
      else if (command === "parar") reply = await handlers.parar?.();
      else if (command === "vagas") reply = await handlers.vagas?.(arg);
      else if (command === "r" || command === "responder") reply = await handlers.responder?.(rest[0], rest.slice(1).join(" "));
      else if (command === "pular") reply = await handlers.pular?.(rest[0]);
      else if (command === "agentes" && handlers.agentes) reply = await handlers.agentes();
      else if (command === "novo" && handlers.novo) reply = await handlers.novo(arg);
      else if (command === "corrigir" && handlers.corrigir) reply = await handlers.corrigir(arg);
      else if (command === "start" || command === "ajuda") reply = "Comandos: /status, /agentes, /novo <tarefa>, /corrigir <texto>, /vagas, /parar (para tudo). /r <código> <resposta> responde um caso crítico; /pular <código> pula. Qualquer outro texto vira tarefa.";
      else if (command) reply = "Comando desconhecido. Use /ajuda.";
      else reply = await handlers.onText?.(text);
    } catch (err) {
      reply = `Não deu: ${scrub(err.message || err)}`;
    }
    if (reply) await send(reply);
  }

  async function pollOnce() {
    const updates = await call("getUpdates", { offset: state.offset, timeout: pollTimeoutSec, allowed_updates: ["message", "callback_query"] });
    for (const update of updates || []) {
      state.offset = Math.max(state.offset, Number(update.update_id) + 1);
      save();
      try { await handleUpdate(update); } catch (err) { log(`[telegram] ${scrub(err.message)}`); }
    }
    return (updates || []).length;
  }

  async function runLoop() {
    while (running) {
      try {
        await pollOnce();
        lastError = "";
      } catch (err) {
        lastError = scrub(err.message || err);
        log(`[telegram] ${lastError}`);
        if (err.status === 401 || err.status === 404) { running = false; break; }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  function start() {
    if (running || !state.ligado || !getToken()) return status();
    running = true;
    loop = runLoop();
    return status();
  }
  function stop() { running = false; return status(); }
  function setLigado(on) {
    state.ligado = Boolean(on);
    save();
    if (state.ligado) start(); else stop();
    return status();
  }

  /** Resumo diário: uma vez por dia, depois do horário (20h, hora do computador). */
  async function maybeDaily(textFn, hour = 20) {
    const d = new Date(now());
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (!state.ownerChatId || d.getHours() < hour || state.ultimoResumo === day) return false;
    const text = await textFn();
    if (!text) return false;
    if (await send(text)) { state.ultimoResumo = day; save(); return true; }
    return false;
  }

  return { status, newCode, unpair, send, start, stop, setLigado, pollOnce, handleUpdate, maybeDaily, scrub, waitLoop: () => loop, file };
}

module.exports = { createTelegram };
