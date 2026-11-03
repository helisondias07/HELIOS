"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { publicConv } = require("./store");
const { redact, MAX_MESSAGE_CHARS, nowIso, readJson, writeJson } = require("./util");

const PROTOCOL = "2025-06-18";
const BLOCKED = /cofre|senha|vault|segredo|token|password/i;

/** Allowlist mínima do MCP remoto (presidente Grok Bot). Sem cofre/CPF/arquivos. */
const REMOTE_ALLOWLIST = new Set([
  "helios_quadro_postar",
  "helios_quadro_ler",
  "helios_quadro_status",
  "helios_chefe_ordem",
  "helios_chefe_status",
  "helios_agente_status",
]);

const QUADRO_TOOLS = [
  {
    name: "helios_quadro_postar",
    description: "Publica um item no quadro compartilhado (de, para, tipo achado|pedido|resultado|alerta, assunto, corpo, ref opcional).",
    inputSchema: {
      type: "object",
      properties: {
        de: { type: "string" },
        para: { type: "string" },
        tipo: { type: "string" },
        assunto: { type: "string" },
        corpo: { type: "string" },
        ref: { type: "string" },
      },
      required: ["para", "tipo", "assunto", "corpo"],
    },
  },
  {
    name: "helios_quadro_ler",
    description: "Lê o quadro com filtros opcionais: para, de, status, tipo, limite.",
    inputSchema: {
      type: "object",
      properties: {
        para: { type: "string" },
        de: { type: "string" },
        status: { type: "string" },
        tipo: { type: "string" },
        limite: { type: "number" },
      },
    },
  },
  {
    name: "helios_quadro_status",
    description: "Atualiza o status de um item do quadro (aberto|em_andamento|feito|cancelado).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string" } },
      required: ["id", "status"],
    },
  },
  {
    name: "helios_chefe_ordem",
    description: "Envia uma ordem ao Chefe: cria item no quadro e dispara um ciclo de priorização/delegação.",
    inputSchema: {
      type: "object",
      properties: { texto: { type: "string" }, ordem: { type: "string" } },
      required: ["texto"],
    },
  },
  {
    name: "helios_chefe_status",
    description: "Resumo do Chefe: agentes, itens abertos, últimos resultados, pendências de aprovação. Não inventa números.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "helios_agente_status",
    description: "Status de um agente (vagas|pesquisa|oasis|portfolio|chefe) ou resumo se omitir.",
    inputSchema: {
      type: "object",
      properties: { agente: { type: "string" }, id: { type: "string" } },
    },
  },
];

const TOOLS = [
  {
    name: "helios_criar_tarefa",
    description: "Cria uma tarefa local no HELIOS. Não mexe no cofre.",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string" },
        detalhe: { type: "string" },
      },
      required: ["titulo"],
    },
  },
  {
    name: "helios_listar_tarefas",
    description: "Lista as tarefas locais do HELIOS.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "helios_atualizar_tarefa",
    description: "Muda o status de uma tarefa local: aberta, feita ou cancelada. Não mexe no cofre.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string" } },
      required: ["id", "status"],
    },
  },
  {
    name: "helios_listar_rotinas",
    description: "Lista as rotinas do HELIOS, com id, horário e se estão ligadas.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "helios_rodar_rotina",
    description: "Dispara uma rotina agora. Se a rotina pedir algo irreversível, a resposta volta pendente e nada é executado.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, esperarMs: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "helios_listar_ajudantes",
    description: "Lista, só para leitura, os ajudantes temporários do HELIOS (ativos e recentes) e os contadores de ajudantes e consultas. Não cria nem encerra ajudantes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "helios_buscar_conversas",
    description: "Busca conversas do HELIOS pelo título ou pelo texto.",
    inputSchema: { type: "object", properties: { consulta: { type: "string" } } },
  },
  {
    name: "helios_ler_conversa",
    description: "Lê uma conversa do HELIOS pelo id. Não devolve senha nem token.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "helios_consultar_memoria",
    description: "Consulta a memória do HELIOS sobre o Helison. Sem segredos. Cada assistente tem a sua memória; sem o campo assistente, usa a do assistente padrão.",
    inputSchema: { type: "object", properties: { consulta: { type: "string" }, assistente: { type: "string" } } },
  },
  {
    name: "helios_sugerir_assistente",
    description: "Chefe de gabinete: sugere qual assistente do Helison deve cuidar de um pedido. Só sugere: não executa nada nem cria conversa.",
    inputSchema: { type: "object", properties: { pedido: { type: "string" } }, required: ["pedido"] },
  },
  {
    name: "helios_enviar_mensagem",
    description: "Envia uma mensagem ao chat do HELIOS. Enviar para fora, apagar, pagar ou publicar fica pendente até o Helison decidir no aplicativo.",
    inputSchema: {
      type: "object",
      properties: { texto: { type: "string" }, esperarMs: { type: "number" }, assistente: { type: "string" } },
      required: ["texto"],
    },
  },
  ...QUADRO_TOOLS,
];

const REMOTE_TOOLS = TOOLS.filter((t) => REMOTE_ALLOWLIST.has(t.name));

function isLoopbackAddress(address) {
  const value = String(address || "").replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1";
}

function bearerOk(header, expected) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ""));
  if (!match || !expected) return false;
  const got = Buffer.from(match[1]);
  const want = Buffer.from(String(expected));
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function fold(text) {
  return String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function textResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
    isError,
  };
}

function safeMessage(message) {
  const copy = { ...message };
  for (const key of ["text", "summary", "detail", "result", "narration"]) {
    if (copy[key]) copy[key] = redact(copy[key]);
  }
  return copy;
}

/**
 * @param {object} deps
 * @param {object} [deps.quadro]
 * @param {object} [deps.chefe]
 * @param {function} [deps.getRemoteToken] token remoto SEPARADO do local
 * @param {function} [deps.isRemoteEnabled] desligado por padrão
 * @param {string} [deps.dataDir] para log de acessos e config remota
 */
function createMcpServer({
  tasks,
  routines,
  store,
  memory,
  memories,
  assistants,
  orchestration,
  bot,
  getToken,
  quadro = null,
  chefe = null,
  getRemoteToken = () => "",
  isRemoteEnabled = () => false,
  dataDir = null,
  /** número ou getter (() => number) — permite alterar o teto via API sem reiniciar */
  remoteRatePerMin = 30,
}) {
  let fallback = "";
  const token = () => {
    if (typeof getToken === "function") return String(getToken() || "");
    if (!fallback) fallback = crypto.randomBytes(32).toString("base64url");
    return fallback;
  };
  const remoteToken = () => (typeof getRemoteToken === "function" ? String(getRemoteToken() || "") : "");

  const accessLogFile = dataDir ? path.join(dataDir, "mcp-remote-access.json") : null;
  const rateBuckets = new Map();

  function logAccess({ mode, tool, ok, reason = "" }) {
    if (!accessLogFile) return;
    try {
      const data = readJson(accessLogFile, { version: 1, items: [] });
      const items = Array.isArray(data.items) ? data.items : [];
      items.push({
        at: nowIso(),
        mode, // local | remoto
        tool: String(tool || "").slice(0, 80),
        ok: Boolean(ok),
        reason: redact(String(reason || "")).slice(0, 120),
        // nunca loga token, Authorization, corpo com segredo
      });
      writeJson(accessLogFile, { version: 1, items: items.slice(-500) });
    } catch { /* log best-effort */ }
  }

  function rateLimit() {
    const raw = typeof remoteRatePerMin === "function" ? remoteRatePerMin() : remoteRatePerMin;
    return Math.max(1, Number(raw) || 30);
  }

  function rateOk(key) {
    const now = Date.now();
    const windowMs = 60_000;
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= rateLimit();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitTurn(convId, esperarMs) {
    const limit = Math.min(20000, Math.max(200, Number(esperarMs) || 8000));
    const start = Date.now();
    let conv = store.get(convId);
    while (conv?.busy && Date.now() - start < limit) {
      await sleep(20);
      conv = store.get(convId);
    }
    return conv;
  }

  function outcome(conv) {
    const pending = (conv?.messages || []).find((message) => message.role === "approval" && message.state === "pending");
    if (pending) {
      return {
        status: "pendente",
        conversa: conv.id,
        cartao: { id: pending.id, conversa: conv.id, tipo: pending.kind, resumo: redact(pending.summary || "") },
      };
    }
    const asked = (conv?.messages || []).find((message) => message.role === "question" && message.state === "pending");
    if (asked) {
      return { status: "pendente", conversa: conv.id, pergunta: { id: asked.id, conversa: conv.id, texto: redact(asked.question || "") } };
    }
    if (conv?.busy) return { status: "pendente", conversa: conv.id, cartao: null };
    const assistant = [...(conv?.messages || [])].reverse().find((message) => message.role === "assistant");
    return { status: "ok", conversa: conv.id, resposta: redact(assistant?.text || "") };
  }

  async function runPrompt(title, prompt, esperarMs, level, assistantId, readOnly) {
    const conv = store.create(title, assistantId);
    if (readOnly) store.update(conv.id, (current) => { current.readOnly = true; });
    bot.send(conv.id, prompt, { level });
    return outcome(await waitTurn(conv.id, esperarMs));
  }

  /** Sem referência: null (padrão). Referência que não existe: false. */
  function pickAssistant(ref) {
    if (!ref) return null;
    return (assistants && assistants.find(ref)) || false;
  }

  async function callTool(name, args, { remote = false } = {}) {
    const input = args && typeof args === "object" ? args : {};
    if (BLOCKED.test(String(name || ""))) {
      logAccess({ mode: remote ? "remoto" : "local", tool: name, ok: false, reason: "bloqueada" });
      return textResult("Esta ferramenta não existe. O MCP do HELIOS não lê o cofre.", true);
    }
    if (remote && !REMOTE_ALLOWLIST.has(name)) {
      logAccess({ mode: "remoto", tool: name, ok: false, reason: "fora da allowlist" });
      return textResult("Ferramenta indisponível no MCP remoto.", true);
    }

    try {
      if (name === "helios_criar_tarefa") {
        const item = tasks.add({ title: input.titulo || input.title, detail: input.detalhe || input.detail });
        return textResult({ tarefa: item });
      }
      if (name === "helios_listar_tarefas") return textResult({ tarefas: tasks.list() });
      if (name === "helios_atualizar_tarefa") {
        const item = tasks.update(String(input.id || ""), { status: input.status });
        if (!item) return textResult("Tarefa não encontrada.", true);
        return textResult({ tarefa: item });
      }
      if (name === "helios_listar_rotinas") return textResult({ rotinas: routines.list() });
      if (name === "helios_rodar_rotina") {
        const id = String(input.id || "");
        const routine = routines.list().find((item) => item.id === id);
        if (!routine) return textResult("Rotina não encontrada.", true);
        routines.markRan(id);
        return textResult(await runPrompt(`Rotina: ${routine.title}`, routine.prompt, input.esperarMs, "rapido", routine.assistantId || undefined, routine.readOnly === true));
      }
      if (name === "helios_sugerir_assistente") {
        try {
          return textResult(require("./gabinete").suggest(input.pedido || input.texto, assistants.list()));
        } catch (err) {
          return textResult(err.message, true);
        }
      }
      if (name === "helios_listar_ajudantes") {
        if (!orchestration) return textResult({ ajudantes: [], contadores: {} });
        const stats = orchestration.stats();
        return textResult({
          ajudantes: orchestration.helpers().slice(0, 30).map((item) => ({
            id: item.id,
            tarefa: redact(item.task),
            assistente: item.assistantName,
            estado: item.state,
            duracaoSeg: Math.round(item.durationMs / 1000),
          })),
          ativos: orchestration.activeCount(),
          contadores: { ajudantesCriados: stats.total.ajudantesCriados, consultasEntreAssistentes: stats.total.consultas },
        });
      }
      if (name === "helios_buscar_conversas") {
        const query = fold(input.consulta || input.query || "");
        const found = store.list().filter((conv) => {
          if (conv.helper) return false;
          if (!query) return true;
          const blob = [conv.title, ...(conv.messages || []).map((message) => message.text || message.summary || "")].join("\n");
          return fold(blob).includes(query);
        }).slice(0, 20).map((conv) => ({
          id: conv.id,
          title: conv.title,
          updatedAt: conv.updatedAt,
          preview: redact(String(conv.messages?.find((message) => message.text)?.text || "").replace(/\s+/g, " ").slice(0, 90)),
        }));
        return textResult({ conversas: found });
      }
      if (name === "helios_ler_conversa") {
        const conv = store.get(String(input.id || ""));
        if (!conv) return textResult("Conversa não encontrada.", true);
        const pub = publicConv(conv);
        pub.messages = pub.messages.map(safeMessage);
        return textResult({ conversa: pub });
      }
      if (name === "helios_consultar_memoria") {
        const owner = pickAssistant(input.assistente);
        if (owner === false) return textResult("Assistente não encontrado.", true);
        const ctx = (memories ? memories.for(owner ? owner.id : "default") : memory).context({ text: String(input.consulta || input.query || ""), maxChars: 1200 });
        return textResult({ texto: redact(ctx.text || ""), ids: ctx.ids });
      }
      if (name === "helios_enviar_mensagem") {
        const texto = String(input.texto || input.text || "").trim();
        if (texto.length < 1) return textResult("Escreva a mensagem.", true);
        const owner = pickAssistant(input.assistente);
        if (owner === false) return textResult("Assistente não encontrado.", true);
        if (texto.length > MAX_MESSAGE_CHARS) {
          return textResult(`A mensagem é grande demais (${texto.length} caracteres). O limite é ${MAX_MESSAGE_CHARS}. Divida em partes menores.`, true);
        }
        return textResult(await runPrompt("Mensagem via MCP", texto, input.esperarMs, "auto", owner ? owner.id : undefined));
      }

      // ---- Quadro / Chefe (O1) ----
      if (name === "helios_quadro_postar") {
        if (!quadro) return textResult("Quadro indisponível.", true);
        const item = quadro.postar({
          de: input.de || (remote ? "presidente" : "mcp"),
          para: input.para,
          tipo: input.tipo,
          assunto: input.assunto,
          corpo: input.corpo,
          ref: input.ref,
        });
        logAccess({ mode: remote ? "remoto" : "local", tool: name, ok: true });
        return textResult({ item });
      }
      if (name === "helios_quadro_ler") {
        if (!quadro) return textResult("Quadro indisponível.", true);
        const itens = quadro.ler({
          para: input.para,
          de: input.de,
          status: input.status,
          tipo: input.tipo,
          limite: input.limite,
        });
        logAccess({ mode: remote ? "remoto" : "local", tool: name, ok: true });
        return textResult({ itens, total: itens.length });
      }
      if (name === "helios_quadro_status") {
        if (!quadro) return textResult("Quadro indisponível.", true);
        const item = quadro.atualizarStatus(input.id, input.status);
        logAccess({ mode: remote ? "remoto" : "local", tool: name, ok: true });
        return textResult({ item });
      }
      if (name === "helios_chefe_ordem") {
        if (!chefe) return textResult("Chefe indisponível.", true);
        const out = await chefe.ordem(input.texto || input.ordem);
        logAccess({ mode: remote ? "remoto" : "local", tool: name, ok: true });
        return textResult(out);
      }
      if (name === "helios_chefe_status") {
        if (!chefe) return textResult("Chefe indisponível.", true);
        logAccess({ mode: remote ? "remoto" : "local", tool: name, ok: true });
        return textResult(chefe.status());
      }
      if (name === "helios_agente_status") {
        if (!chefe) return textResult("Chefe indisponível.", true);
        const ref = input.agente || input.id;
        logAccess({ mode: remote ? "remoto" : "local", tool: name, ok: true });
        if (!ref) return textResult({ agentes: chefe.status().agentes });
        return textResult(chefe.agenteStatus(ref));
      }

      logAccess({ mode: remote ? "remoto" : "local", tool: name, ok: false, reason: "desconhecida" });
      return textResult(`Ferramenta desconhecida: ${name}`, true);
    } catch (err) {
      logAccess({ mode: remote ? "remoto" : "local", tool: name, ok: false, reason: err.message || "erro" });
      return textResult(redact(err.message || "erro"), true);
    }
  }

  async function rpc(message, { remote = false } = {}) {
    const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
    const method = message.method;
    if (!method) return { http: 400, body: { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "pedido inválido" } } };
    if (id === undefined) return { http: 202, body: null };
    try {
      if (method === "ping") return { http: 200, body: { jsonrpc: "2.0", id, result: {} } };
      if (method === "initialize") {
        return {
          http: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: PROTOCOL,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "helios", version: "0.1.0" },
              instructions: remote
                ? "MCP remoto do HELIOS (allowlist mínima). Sem cofre/CPF/arquivos. Ação crítica volta pendente."
                : "Assistente local do Helison. Nenhuma ferramenta lê o cofre. Ação irreversível volta pendente.",
            },
          },
        };
      }
      if (method === "tools/list") {
        return { http: 200, body: { jsonrpc: "2.0", id, result: { tools: remote ? REMOTE_TOOLS : TOOLS } } };
      }
      if (method === "tools/call") {
        const result = await callTool(message.params?.name, message.params?.arguments, { remote });
        return { http: 200, body: { jsonrpc: "2.0", id, result } };
      }
      return { http: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message: "método não encontrado" } } };
    } catch (err) {
      return { http: 200, body: { jsonrpc: "2.0", id, error: { code: -32000, message: redact(err.message || "erro") } } };
    }
  }

  /**
   * Classifica o pedido: local (loopback + token local) ou remoto (token remoto + ligado).
   * Token remoto NUNCA autentica no caminho local e vice-versa.
   */
  function authMode(req) {
    const local = isLoopbackAddress(req.socket?.localAddress) && isLoopbackAddress(req.socket?.remoteAddress);
    const auth = req.headers.authorization || req.headers.Authorization;
    const localTok = token();
    const remoteTok = remoteToken();
    if (local && localTok && bearerOk(auth, localTok)) return { ok: true, remote: false };
    if (remoteTok && bearerOk(auth, remoteTok)) {
      if (!isRemoteEnabled()) return { ok: false, reason: "MCP remoto desligado" };
      if (!rateOk("remote")) return { ok: false, reason: "rate limit" };
      return { ok: true, remote: true };
    }
    return { ok: false, reason: "token inválido" };
  }

  function respond(req, res, body) {
    const mode = authMode(req);
    if (!mode.ok) {
      const code = mode.reason === "MCP remoto desligado" ? 403 : mode.reason === "rate limit" ? 429 : 401;
      const payload = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: mode.reason || "token inválido" } });
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
      logAccess({ mode: "remoto", tool: "(auth)", ok: false, reason: mode.reason });
      return Promise.resolve();
    }
    if (req.method !== "POST") {
      const payload = JSON.stringify({ error: "Use POST em /mcp." });
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
      return Promise.resolve();
    }
    const session = String(req.headers["mcp-session-id"] || crypto.randomUUID());
    return rpc(body || {}, { remote: mode.remote }).then((out) => {
      if (out.http === 202) {
        res.writeHead(202, { "mcp-session-id": session, "cache-control": "no-store" });
        res.end();
        return;
      }
      const payload = JSON.stringify(out.body);
      res.writeHead(out.http, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "mcp-session-id": session,
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  }

  const isAuthorized = (req) => authMode(req).ok;

  return {
    respond,
    isAuthorized,
    tools: TOOLS,
    remoteTools: REMOTE_TOOLS,
    remoteAllowlist: [...REMOTE_ALLOWLIST],
    authMode,
  };
}

/** Estado persistido do MCP remoto (ligado/desligado). Token fica só no cofre. */
function createMcpRemoteConfig(dataDir) {
  const file = path.join(dataDir, "mcp-remote.json");
  fs.mkdirSync(dataDir, { recursive: true });
  const saved = readJson(file, {});
  let enabled = saved.enabled === true; // desligado por padrão
  let ratePerMin = Math.min(120, Math.max(1, Number(saved.ratePerMin) || 30));

  function persist() {
    writeJson(file, { version: 1, enabled, ratePerMin });
  }

  return {
    isEnabled: () => enabled,
    setEnabled(value) {
      enabled = Boolean(value);
      persist();
      return { enabled };
    },
    ratePerMin: () => ratePerMin,
    setRatePerMin(n) {
      ratePerMin = Math.min(120, Math.max(1, Math.round(Number(n) || 30)));
      persist();
      return { ratePerMin };
    },
    view() {
      return { enabled, ratePerMin, allowlist: [...REMOTE_ALLOWLIST] };
    },
  };
}

module.exports = {
  createMcpServer,
  createMcpRemoteConfig,
  isLoopbackAddress,
  bearerOk,
  TOOLS,
  REMOTE_TOOLS,
  REMOTE_ALLOWLIST: [...REMOTE_ALLOWLIST],
};
