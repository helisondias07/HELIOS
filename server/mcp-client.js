"use strict";

/**
 * Cliente MCP mínimo (stdio e HTTP), no mesmo desenho do painel do Oasis Bot.
 * initialize, tools/list e tools/call. Sem dependências.
 */
const { spawn } = require("node:child_process");

const MCP_PROTOCOL = "2025-06-18";
const CLIENT_INFO = { name: "helios", version: "0.1.0" };

// Limite de memória por servidor stdio: uma linha de resposta do stdout acima disso encerra o processo.
const MAX_STDOUT_BYTES = 1_000_000;
const MAX_STDERR_CHARS = 2000;

/**
 * Ambiente mínimo do servidor MCP stdio. Só passam estas variáveis do processo do HELIOS (o necessário para
 * o Windows e o Node funcionarem); chaves e segredos (CURSOR_API_KEY, GROQ_API_KEY, GEMINI_API_KEY e qualquer
 * nome com KEY, TOKEN, SECRET, PASSWORD...) nunca são herdados. O que o usuário configurou para aquele
 * conector (cfg.env) entra por cima.
 */
const ENV_ALLOW = new Set([
  "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "HOMEDRIVE", "HOMEPATH",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
  "SYSTEMDRIVE", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "LANGUAGE",
]);
const ENV_PREFIX_ALLOW = ["NODE_", "LC_"];
const ENV_SECRET = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION/i;
const ENV_NEVER = new Set(["CURSOR_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "ELECTRON_RUN_AS_NODE"]);

function buildChildEnv(parentEnv = process.env, userEnv = {}) {
  const out = {};
  for (const [name, value] of Object.entries(parentEnv || {})) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (ENV_NEVER.has(upper) || ENV_SECRET.test(upper)) continue;
    if (ENV_ALLOW.has(upper) || ENV_PREFIX_ALLOW.some((prefix) => upper.startsWith(prefix))) out[name] = String(value);
  }
  for (const [name, value] of Object.entries(userEnv || {})) {
    if (typeof value === "string" || typeof value === "number") out[name] = String(value);
  }
  return out;
}

function rpcError(msg, extra = {}) {
  return Object.assign(new Error(msg), extra);
}

function stdioTransport(cfg, { timeoutMs }) {
  const child = spawn(cfg.command, cfg.args || [], {
    cwd: cfg.cwd || undefined,
    env: buildChildEnv(process.env, cfg.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buf = "";
  let stderr = "";
  let closed = null;
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    if (Buffer.byteLength(buf, "utf8") > MAX_STDOUT_BYTES && buf.indexOf("\n") < 0) {
      // Uma "linha" sem fim: descarta o que acumulou e encerra o servidor com um erro claro.
      buf = "";
      fail(rpcError("o servidor MCP enviou uma resposta maior que 1 MB numa linha só; a conexão foi encerrada"));
      try { child.kill(); } catch { /* já fechado */ }
      return;
    }
    let index;
    while ((index = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, index).trim();
      buf = buf.slice(index + 1);
      if (!line) continue;
      if (line.length > MAX_STDOUT_BYTES) {
        fail(rpcError("o servidor MCP enviou uma resposta maior que 1 MB; a conexão foi encerrada"));
        try { child.kill(); } catch { /* já fechado */ }
        buf = "";
        return;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk).slice(-MAX_STDERR_CHARS)).slice(-MAX_STDERR_CHARS);
  });
  const fail = (err) => {
    closed = closed || err;
    for (const [, cb] of waiting) cb({ error: { message: err.message } });
    waiting.clear();
  };
  child.on("error", (err) => fail(rpcError(`não deu para iniciar o servidor MCP: ${err.message}`)));
  child.on("exit", (code) => fail(rpcError(`o servidor MCP fechou (código ${code})${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`)));
  let next = 1;
  return {
    request(method, params, { signal } = {}) {
      if (closed) return Promise.reject(closed);
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(rpcError(`tempo esgotado em ${method}`));
        }, timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          waiting.delete(id);
          reject(rpcError("cancelado", { name: "AbortError" }));
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });
        waiting.set(id, (msg) => {
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
          if (msg.error) reject(rpcError(msg.error.message || "erro no servidor MCP", { code: msg.error.code }));
          else resolve(msg.result);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params) {
      if (!closed) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
    },
    close() {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        /* já fechado */
      }
    },
  };
}

function pickFromSse(text, id) {
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg && msg.id === id) return msg;
    } catch {
      /* evento que não é JSON */
    }
  }
  return null;
}

function httpTransport(cfg, { timeoutMs, fetchImpl }) {
  let session = null;
  let next = 1;
  const headers = () => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL,
    ...(session ? { "mcp-session-id": session } : {}),
    ...(cfg.headers || {}),
  });
  async function post(body, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      const res = await fetchImpl(cfg.url, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: ctrl.signal });
      const sid = res.headers.get("mcp-session-id");
      if (sid) session = sid;
      return res;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }
  return {
    async request(method, params, { signal } = {}) {
      const id = next++;
      const res = await post({ jsonrpc: "2.0", id, method, params }, signal);
      if (res.status === 401 || res.status === 403) throw rpcError("o servidor MCP pediu login", { status: res.status });
      if (!res.ok) throw rpcError(`servidor MCP respondeu HTTP ${res.status}`, { status: res.status });
      const type = res.headers.get("content-type") || "";
      const text = await res.text();
      const msg = type.includes("text/event-stream") ? pickFromSse(text, id) : JSON.parse(text || "null");
      if (!msg) throw rpcError("resposta MCP vazia");
      if (msg.error) throw rpcError(msg.error.message || "erro no servidor MCP", { code: msg.error.code });
      return msg.result;
    },
    notify(method, params) {
      post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }).catch(() => {});
    },
    close() {
      if (session) fetchImpl(cfg.url, { method: "DELETE", headers: headers() }).catch(() => {});
    },
  };
}

async function connectMcp(name, cfg, { timeoutMs = 20000, initTimeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const kind = cfg?.type || (cfg?.command ? "stdio" : cfg?.url ? "http" : "");
  let transport;
  if (kind === "stdio") transport = stdioTransport(cfg, { timeoutMs });
  else if (kind === "http" || kind === "streamable-http") transport = httpTransport(cfg, { timeoutMs, fetchImpl });
  else throw rpcError(`tipo de servidor MCP não suportado: ${kind || "?"}`);
  try {
    let timer;
    const init = await Promise.race([
      transport.request("initialize", { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(rpcError("o servidor MCP não respondeu ao initialize")), initTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    transport.notify("notifications/initialized");
    const tools = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const list = await transport.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(list?.tools || []));
      cursor = list?.nextCursor;
      if (!cursor) break;
    }
    return {
      name,
      server: init?.serverInfo || null,
      instructions: init?.instructions || "",
      tools,
      call: (tool, args, opts) => transport.request("tools/call", { name: tool, arguments: args || {} }, opts),
      close: () => transport.close(),
    };
  } catch (err) {
    transport.close();
    throw err;
  }
}

function mcpResultText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const parts = [];
  for (const block of result.content || []) {
    if (block?.type === "text") parts.push(block.text);
    else if (block?.type === "image") parts.push("[imagem omitida]");
    else if (block?.type === "resource") parts.push(block.resource?.text || "[recurso]");
  }
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}

module.exports = { connectMcp, mcpResultText, buildChildEnv, MCP_PROTOCOL, MAX_STDOUT_BYTES };
