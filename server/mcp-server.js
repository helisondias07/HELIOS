"use strict";

const crypto = require("node:crypto");
const { publicConv } = require("./store");
const { redact, MAX_MESSAGE_CHARS } = require("./util");

const PROTOCOL = "2025-06-18";
const BLOCKED = /cofre|senha|vault|segredo|token|password/i;

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
];

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

function createMcpServer({ tasks, routines, store, memory, memories, assistants, orchestration, bot, getToken }) {
  let fallback = "";
  const token = () => {
    if (typeof getToken === "function") return String(getToken() || "");
    if (!fallback) fallback = crypto.randomBytes(32).toString("base64url");
    return fallback;
  };

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

  async function callTool(name, args) {
    const input = args && typeof args === "object" ? args : {};
    if (BLOCKED.test(String(name || ""))) {
      return textResult("Esta ferramenta não existe. O MCP do HELIOS não lê o cofre.", true);
    }
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
    return textResult(`Ferramenta desconhecida: ${name}`, true);
  }

  async function rpc(message) {
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
              instructions: "Assistente local do Helison. Nenhuma ferramenta lê o cofre. Ação irreversível volta pendente.",
            },
          },
        };
      }
      if (method === "tools/list") return { http: 200, body: { jsonrpc: "2.0", id, result: { tools: TOOLS } } };
      if (method === "tools/call") {
        const result = await callTool(message.params?.name, message.params?.arguments);
        return { http: 200, body: { jsonrpc: "2.0", id, result } };
      }
      return { http: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message: "método não encontrado" } } };
    } catch (err) {
      return { http: 200, body: { jsonrpc: "2.0", id, error: { code: -32000, message: redact(err.message || "erro") } } };
    }
  }

  function respond(req, res, body) {
    if (!bearerOk(req.headers.authorization || req.headers.Authorization, token())) {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "token inválido" } });
      res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
      return Promise.resolve();
    }
    if (req.method !== "POST") {
      const payload = JSON.stringify({ error: "Use POST em /mcp." });
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
      return Promise.resolve();
    }
    const session = String(req.headers["mcp-session-id"] || crypto.randomUUID());
    return rpc(body || {}).then((out) => {
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

  /** Confere o token antes de o corpo ser lido (quem não tem token não faz o servidor gastar memória com o corpo). */
  const isAuthorized = (req) => bearerOk(req.headers.authorization || req.headers.Authorization, token());

  return { respond, isAuthorized, tools: TOOLS };
}

module.exports = { createMcpServer, isLoopbackAddress, bearerOk, TOOLS };
