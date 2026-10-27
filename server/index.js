"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore, publicConv } = require("./store");
const { createMemories } = require("./memory");
const { createAssistants } = require("./assistants");
const { createRoutines } = require("./routines");
const { createTasks } = require("./tasks");
const { createMcpRegistry } = require("./mcp-registry");
const { createMcpServer, isLoopbackAddress, bearerOk } = require("./mcp-server");
const { dispatchDue } = require("./routines");
const { createLivecoding } = require("./livecoding");
const { createSkills } = require("./skills");
const { createOnboarding } = require("./onboarding");
const { createDictationPrefs } = require("./dictation-prefs");
const { createDictationStats } = require("./dictation-stats");
const { MORNING_TITLE, MORNING_MODEL, MORNING_PROMPT } = require("./routines");
const { createActions } = require("./actions");
const { createAccountStore, sdkAdapters, MAX_ACCOUNTS, SLOT_NAMES, KEY_PAGE } = require("./accounts");
const { createConectores } = require("./conectores");
const REAL_LIMIT_URL = "https://cursor.com/dashboard";
const LOCAL_USAGE_NOTE = "Isto é só o que o HELIOS enviou nesta conta (mensagens e chamadas ao modelo). O limite semanal de verdade, que também conta o uso no Cursor e no Grok, só aparece no painel do Cursor ou do Grok: o SDK não informa esse número ao HELIOS.";
const { createBot } = require("./bot");
const { buildInbox } = require("./inbox");
const { createAutonomy } = require("./autonomy");
const { createOrchestration } = require("./orchestration");
const { createUsage, NOTE: USAGE_NOTE } = require("./usage");
const { suggest: suggestAssistant } = require("./gabinete");
const { createParking } = require("./parking");
const { createLedger } = require("./ledger");
const { createContexts } = require("./context");
const { searchWeb } = require("./search");
const { createContextPack } = require("./context-pack");
const { createContextSources } = require("./context-sources");
const { createSafeFolders } = require("./safe-folders");
const { captureSecrets, secret } = require("./secrets");
const { referenceEstimates } = require("./model-policy");
const { redact, MAX_BODY_BYTES } = require("./util");

const VERSION = "0.1.0";
const HOST = "127.0.0.1";

function readSdkAuthFile() {
  try { return fs.readFileSync(path.join(os.homedir(), ".cursor", "sdk", "auth.json"), "utf8"); }
  catch { return ""; }
}

// Depois de recusar um corpo grande, o resto ainda é lido e descartado (até este teto) e a conexão NÃO é fechada:
// fechar com dados por ler faz o sistema mandar um "reset" e o cliente perderia a resposta 413.
const DRAIN_CAP_BYTES = 64 * 1024 * 1024;

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let refused = false;
    let drained = 0;
    const refuse = () => {
      if (refused) return;
      refused = true;
      chunks.length = 0;
      reject(Object.assign(new Error(`O pedido é grande demais: o limite do corpo é ${Math.round(limit / 1_000_000)} MB. Envie menos dados.`), { status: 413 }));
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) refuse();
    req.on("data", (chunk) => {
      if (refused) {
        drained += chunk.length;
        if (drained > DRAIN_CAP_BYTES) req.destroy();
        return;
      }
      size += chunk.length;
      if (size > limit) {
        refuse();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (refused) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("JSON inválido"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function startServer(opts = {}) {
  const dataDir = opts.dataDir || path.join(os.tmpdir(), "helios-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const mock = Boolean(opts.mock);
  captureSecrets(process.env);
  const store = createStore(dataDir);
  const memories = createMemories(dataDir);
  const memory = memories.for("default");
  const assistants = createAssistants(dataDir);
  const routines = createRoutines(dataDir);
  const skills = createSkills(dataDir);
  const dictationPrefs = createDictationPrefs(dataDir);
  const onboarding = createOnboarding({ dataDir, assistants, routines });
  const tasks = createTasks(dataDir);
  const authHeaders = { authorization: async () => "" };
  const mcp = createMcpRegistry(dataDir, {
    ...(opts.connect ? { connect: opts.connect } : {}),
    sealer: opts.secretSealer || null,
    headerFor: (id) => authHeaders.authorization(id),
  });
  // Abre as credenciais cifradas dos conectores (e migra as antigas em texto aberto) antes de o servidor atender qualquer pedido.
  await mcp.ready();
  const projectsDir = opts.projectsDir || path.join(dataDir, "projetos");
  const autonomy = createAutonomy(dataDir);
  const orchestration = createOrchestration(dataDir);
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const dictationStats = createDictationStats(dataDir, { now });
  const parking = createParking(dataDir, { now });
  const ledger = createLedger(dataDir, { now });
  const usage = createUsage(dataDir, { now, globalCallsPerDay: () => orchestration.limits().usoGlobalChamadasDia, activeAccountId: () => accounts?.active()?.id || null });
  const contexts = createContexts(dataDir, { getLimit: () => orchestration.limits().contextoMaxCaracteres });
  const actions = createActions({ dataDir, projectsDir, mcp, onFillLogin: opts.onFillLogin, searchWeb: opts.searchWeb || searchWeb });
  const accounts = createAccountStore({
    initial: typeof opts.getAccounts === "function" ? opts.getAccounts() : {},
    persist: (snapshot) => opts.onAccountsChange?.(snapshot),
    adapters: sdkAdapters({ mock, openExternal: mock ? null : opts.openExternal }),
    allowDemoKeys: mock,
    openKeyPage: mock ? null : (url) => opts.openExternal?.(url),
    log: (line) => (opts.log || (() => {}))(redact(line)),
  });
  if (!mock) accounts.addEnvKey(secret("CURSOR_API_KEY"));
  const conectores = createConectores({
    dataDir,
    sealer: opts.secretSealer || null,
    mcp,
    fetchImpl: opts.fetch || globalThis.fetch,
    openExternal: mock ? null : opts.openExternal,
    listen: opts.listenLoopback,
    now,
  });
  authHeaders.authorization = (id) => conectores.authorization(id);
  await conectores.ready();

  // Fase 2: pacote de contexto, fontes extras (só leitura) e pastas seguras do PC.
  const contextPack = createContextPack({ dataDir, memories, assistants, routines, contexts, store, mcp, autonomy, orchestration, now });
  const contextSources = createContextSources({ mcp, assistants });
  const safeFolders = createSafeFolders(dataDir, { trashItem: opts.trashItem, pickFolder: opts.pickFolder, extraBlocked: opts.blockedFolders || [] });
  let bot;
  const livecoding = createLivecoding({
    rootDir: projectsDir,
    proposePlan: (description) => bot.proposeLivePlan(description),
  });
  bot = createBot({
    store,
    memory,
    memories,
    assistants,
    searchWeb: opts.searchWeb || searchWeb,
    mcp,
    actions,
    accounts,
    routines,
    autonomy,
    contexts,
    orchestration,
    parking,
    ledger,
    usage,
    skills,
    now,
    helperTimeoutMs: opts.helperTimeoutMs,
    loadSdk: opts.loadSdk,
    getVaultIndex: () => (typeof opts.getVaultIndex === "function" ? opts.getVaultIndex() : []),
    onLivecoding: async (description) => {
      const session = await livecoding.start(description);
      opts.onLiveSession?.(session);
      return session;
    },
    mock,
    cwd: projectsDir,
    log: (line) => (opts.log || ((value) => console.error(value)))(redact(line)),
  });
  const mcpServer = createMcpServer({
    tasks,
    routines,
    store,
    memory,
    memories,
    assistants,
    orchestration,
    bot,
    getToken: opts.getMcpToken,
  });

  let memoryApiToken = "";
  function apiToken() {
    if (typeof opts.getApiToken === "function") return String(opts.getApiToken() || "");
    if (!memoryApiToken) memoryApiToken = crypto.randomBytes(32).toString("base64url");
    return memoryApiToken;
  }

  // Pedidos de rotinas e ajudantes que ficaram sem resposta: depois da validade viram "expirado" (nada é executado).
  bot.expireDue();
  const expireTimer = setInterval(() => bot.expireDue(), 30000);
  expireTimer.unref?.();

  const routineMs = opts.routineMs === undefined ? 30000 : Number(opts.routineMs);
  const timer = routineMs > 0
    ? setInterval(() => {
      dispatchDue({
        routines,
        store,
        send: (id, prompt, level) => bot.send(id, prompt, level),
      });
    }, routineMs)
    : null;
  timer?.unref?.();

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathName = url.pathname;
    let match;

    // Autentica antes de ler o corpo: sem token a resposta é sempre 401, não 400 de JSON inválido.
    if (pathName.startsWith("/api") && !bearerOk(req.headers.authorization || req.headers.Authorization, apiToken())) {
      return send(res, 401, { error: "A API local exige o token do HELIOS." });
    }
    try {
      decodeURIComponent(pathName);
    } catch {
      return send(res, 400, { error: "endereço inválido" });
    }
    // O /mcp também confere o token antes de ler o corpo: sem token, a resposta é o 401 padrão do próprio /mcp.
    if (pathName === "/mcp" && !mcpServer.isAuthorized(req)) return mcpServer.respond(req, res, {});
    const rawBody = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req);
    // Na API, corpo que não seja objeto (null, lista, número) vale como vazio; /mcp aceita lote JSON-RPC.
    const body = pathName.startsWith("/api") && !(rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) ? {} : rawBody;

    if (pathName === "/mcp") {
      const local = req.socket?.localAddress;
      const remote = req.socket?.remoteAddress;
      if (!isLoopbackAddress(local) || !isLoopbackAddress(remote)) {
        return send(res, 403, { error: "O HELIOS só aceita MCP em 127.0.0.1." });
      }
      return mcpServer.respond(req, res, body);
    }
    if (req.method === "GET" && pathName === "/api/health") {
      return send(res, 200, { ok: true, name: "HELIOS", version: VERSION });
    }
    if (req.method === "GET" && pathName === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>HELIOS</title><p>HELIOS está no ar. A interface abre na janela do aplicativo.</p>");
      return;
    }
    if (req.method === "GET" && pathName === "/api/conversations") {
      return send(res, 200, { conversations: store.list().filter((conv) => !conv.helper).map(publicConv) });
    }
    if (req.method === "POST" && pathName === "/api/conversations") {
      if (body.assistantId && !assistants.get(String(body.assistantId))) return send(res, 404, { error: "assistente não encontrado" });
      return send(res, 201, { conversation: publicConv(store.create(typeof body.title === "string" ? body.title : undefined, typeof body.assistantId === "string" && body.assistantId ? body.assistantId : undefined)) });
    }
    if ((match = pathName.match(/^\/api\/conversations\/([^/]+)$/))) {
      const conv = store.get(decodeURIComponent(match[1]));
      if (!conv) return send(res, 404, { error: "conversa não encontrada" });
      if (req.method === "GET") {
        bot.expireDue();
        return send(res, 200, { conversation: publicConv(store.get(conv.id) || conv) });
      }
      if (req.method === "DELETE") {
        store.remove(conv.id);
        return send(res, 200, { ok: true });
      }
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/conversations\/([^/]+)\/messages$/))) {
      const conversation = bot.send(decodeURIComponent(match[1]), typeof body.text === "string" ? body.text : "", { level: body.level || "auto" });
      return send(res, 202, { conversation: publicConv(conversation) });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/conversations\/([^/]+)\/approvals\/([^/]+)$/))) {
      const conversation = await bot.decide(decodeURIComponent(match[1]), decodeURIComponent(match[2]), body);
      return send(res, 200, { conversation: publicConv(conversation) });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/conversations\/([^/]+)\/questions\/([^/]+)$/))) {
      const conversation = bot.answerQuestion(decodeURIComponent(match[1]), decodeURIComponent(match[2]), body);
      return send(res, 200, { conversation: publicConv(conversation) });
    }
    if (req.method === "GET" && pathName === "/api/inbox") {
      bot.expireDue();
      return send(res, 200, buildInbox(store, { assistants, parking }));
    }
    // Registro de fontes dos ajudantes (acordadas, contestadas, não verificadas e estado do verificador). Só leitura.
    if (req.method === "GET" && pathName === "/api/registro-fontes") {
      const assistantId = url.searchParams.get("assistant") || undefined;
      return send(res, 200, { items: ledger.list({ assistantId, limit: 50 }) });
    }
    if (req.method === "GET" && (match = pathName.match(/^\/api\/registro-fontes\/([^/]+)$/))) {
      const entry = ledger.get(decodeURIComponent(match[1]));
      if (!entry) return send(res, 404, { error: "registro de fontes não encontrado" });
      return send(res, 200, { entry });
    }
    if (req.method === "GET" && pathName === "/api/estacionadas") return send(res, 200, { items: parking.open() });
    if (req.method === "GET" && pathName === "/api/autonomy") return send(res, 200, autonomy.view());
    if (req.method === "POST" && pathName === "/api/autonomy") return send(res, 200, autonomy.set(body));
    if (req.method === "GET" && pathName === "/api/models") {
      return send(res, 200, await bot.modelsView(url.searchParams.get("text") || ""));
    }
    if (req.method === "GET" && pathName === "/api/accounts") {
      const rows = accounts.list().map((account) => ({ ...account, localUsage: usage.accountStatus(account.id) }));
      const assistantAlerts = assistants.list().map((item) => ({ ...usage.status(item.id), name: item.name })).filter((row) => row.state === "alerta" || row.state === "limite").map((row) => ({ name: row.name, state: row.state, percent: row.percent }));
      return send(res, 200, {
        accounts: rows,
        max: MAX_ACCOUNTS,
        slotNames: SLOT_NAMES,
        login: accounts.loginStatus(),
        demo: mock,
        prices: referenceEstimates(),
        // O SDK só informa tokens e custo por agente, não o limite semanal da conta: só o uso local do HELIOS é mostrado.
        usage: { global: usage.globalStatus(), assistantAlerts, realLimitUrl: REAL_LIMIT_URL, note: LOCAL_USAGE_NOTE },
      });
    }
    if (req.method === "POST" && pathName === "/api/accounts/key") {
      return send(res, 201, { account: await accounts.addApiKey(body) });
    }
    if (req.method === "POST" && pathName === "/api/accounts/label") {
      return send(res, 200, { account: accounts.setLabel(String(body.id || ""), body.label) });
    }
    if (req.method === "POST" && pathName === "/api/accounts/login") return send(res, 200, { login: accounts.startLogin() });
    if (req.method === "POST" && pathName === "/api/accounts/login/cancel") return send(res, 200, { login: accounts.cancelLogin() });
    if (req.method === "POST" && pathName === "/api/accounts/login/local") {
      const raw = typeof opts.readSdkAuth === "function" ? opts.readSdkAuth() : readSdkAuthFile();
      return send(res, 200, { account: await accounts.adoptLocal(raw) });
    }
    if (req.method === "POST" && pathName === "/api/accounts/chave") {
      if (!mock && opts.openExternal) await opts.openExternal(KEY_PAGE);
      return send(res, 200, { url: KEY_PAGE, demo: mock });
    }
    if (req.method === "POST" && pathName === "/api/accounts/colar") {
      const text = typeof opts.readClipboard === "function" ? opts.readClipboard() : "";
      return send(res, 200, await accounts.acceptClipboard(text));
    }
    if (req.method === "GET" && pathName === "/api/conectores") {
      return send(res, 200, { ...conectores.view(), cursor: { login: accounts.loginStatus(), demo: mock, keyPage: KEY_PAGE } });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/conectores\/([a-z0-9-]+)\/conectar$/))) {
      return send(res, 202, { connection: conectores.start(decodeURIComponent(match[1]), body) });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/conectores\/([^/]+)\/renomear$/))) {
      return send(res, 200, { connection: conectores.rename(decodeURIComponent(match[1]), body.label) });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/conectores\/([^/]+)\/atualizar$/))) {
      return send(res, 200, { connection: await conectores.refresh(decodeURIComponent(match[1])) });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/conectores\/([^/]+)\/cancelar$/))) {
      return send(res, 200, { connection: conectores.cancel(decodeURIComponent(match[1])) });
    }
    if (req.method === "DELETE" && (match = pathName.match(/^\/api\/conectores\/([^/]+)$/))) {
      return send(res, 200, { ok: conectores.remove(decodeURIComponent(match[1])) });
    }
    if (req.method === "POST" && pathName === "/api/accounts/active") return send(res, 200, { account: accounts.setActive(body.id) });
    if (req.method === "DELETE" && (match = pathName.match(/^\/api\/accounts\/([^/]+)$/))) {
      return send(res, 200, accounts.remove(decodeURIComponent(match[1])));
    }
    const memoryFor = (id) => {
      if (id && !assistants.get(String(id))) throw Object.assign(new Error("assistente não encontrado"), { status: 404 });
      return memories.for(id || "default");
    };
    if (req.method === "GET" && pathName === "/api/memory") return send(res, 200, { items: memoryFor(url.searchParams.get("assistant")).list() });
    if (req.method === "POST" && pathName === "/api/memory") return send(res, 201, memoryFor(body.assistantId).remember({ text: body.text, kind: body.kind, source: "user" }));
    if (req.method === "DELETE" && (match = pathName.match(/^\/api\/memory\/([^/]+)$/))) {
      return send(res, 200, { ok: memoryFor(url.searchParams.get("assistant")).forget(decodeURIComponent(match[1])) });
    }
    if (req.method === "GET" && pathName === "/api/assistants") {
      return send(res, 200, { assistants: assistants.list(), pending: assistants.listPending(), templates: assistants.templates() });
    }
    if (req.method === "POST" && pathName === "/api/assistants") return send(res, 201, { assistant: assistants.create(body) });
    if (req.method === "POST" && (match = pathName.match(/^\/api\/assistants\/([^/]+)$/))) {
      const assistant = assistants.update(decodeURIComponent(match[1]), body);
      if (!assistant) return send(res, 404, { error: "assistente não encontrado" });
      return send(res, 200, { assistant });
    }
    if (req.method === "DELETE" && (match = pathName.match(/^\/api\/assistants\/([^/]+)$/))) {
      const id = decodeURIComponent(match[1]);
      if (!assistants.remove(id)) return send(res, 404, { error: "assistente não encontrado" });
      skills.detach(id);
      const moved = store.reassign(id, "default");
      memories.drop(id);
      contexts.drop(id);
      return send(res, 200, { ok: true, conversasMovidas: moved });
    }
    if (req.method === "GET" && pathName === "/api/atividade") {
      const stats = orchestration.stats();
      return send(res, 200, {
        limits: orchestration.limitsView(),
        helpers: orchestration.helpers().map((item) => ({ ...item, ledger: ledger.summaryFor(item.id) })),
        active: orchestration.activeCount(),
        stats,
        assistants: assistants.list().map((item) => ({ id: item.id, name: item.name, createdBy: item.createdBy, stats: orchestration.statsFor(item.id), context: contexts.for(item.id).view() })),
        tokens: {
          reported: stats.total.execucoesComTokens,
          note: stats.total.execucoesComTokens
            ? "Tokens somados só das execuções em que o SDK informou o uso. Em demonstração e em execuções sem esse dado, só há contagens."
            : "O SDK não informou uso de tokens nestas execuções (o modo demonstração nunca informa). Por isso aparecem só contagens de ajudantes e consultas.",
        },
      });
    }
    if (req.method === "POST" && pathName === "/api/roteador") return send(res, 200, suggestAssistant(body.texto ?? body.text, assistants.list()));
    if (req.method === "GET" && pathName === "/api/uso") {
      const list = assistants.list();
      const rows = list.map((item) => ({ ...usage.status(item.id), name: item.name }));
      return send(res, 200, { approximate: true, note: USAGE_NOTE, alertAt: 80, global: usage.globalStatus(), assistants: rows, alerts: rows.filter((row) => row.state === "alerta" || row.state === "limite").map((row) => ({ assistantId: row.assistantId, name: row.name, state: row.state, percent: row.percent })) });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/uso\/([^/]+)\/limite$/))) {
      const id = decodeURIComponent(match[1]);
      const target = assistants.get(id);
      if (!target) return send(res, 404, { error: "assistente não encontrado" });
      return send(res, 200, { status: { ...usage.setLimit(target.id, body), name: target.name } });
    }
    if (req.method === "POST" && pathName === "/api/atividade/limites") return send(res, 200, { limits: orchestration.setLimits(body), view: orchestration.limitsView() });
    if (req.method === "POST" && (match = pathName.match(/^\/api\/atividade\/ajudantes\/([^/]+)\/encerrar$/))) {
      const stopped = await orchestration.stop(decodeURIComponent(match[1]));
      if (!stopped) return send(res, 404, { error: "ajudante não está ativo" });
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/contexto\/([^/]+)\/compactar$/))) {
      const id = decodeURIComponent(match[1]);
      if (!assistants.get(id)) return send(res, 404, { error: "assistente não encontrado" });
      const own = contexts.for(id);
      const result = own.compact({ reason: "compactação manual" });
      return send(res, 200, { ...result, context: own.view() });
    }
    if (req.method === "GET" && (match = pathName.match(/^\/api\/contexto\/([^/]+)$/))) {
      const id = decodeURIComponent(match[1]);
      if (!assistants.get(id)) return send(res, 404, { error: "assistente não encontrado" });
      return send(res, 200, { context: contexts.for(id).view(), items: contexts.for(id).items() });
    }
    // ---- Fase 2: pacote de contexto
    if (req.method === "POST" && pathName === "/api/pacote/exportar") {
      return send(res, 200, contextPack.exportPackage({ conversas: body.conversas !== false, maxConversas: body.maxConversas === undefined ? 20 : body.maxConversas }));
    }
    if (req.method === "POST" && pathName === "/api/pacote/importar/previa") {
      return send(res, 200, contextPack.preview(body.pacote, { renomear: body.renomearConflitos === true }));
    }
    if (req.method === "POST" && pathName === "/api/pacote/importar/aplicar") {
      return send(res, 200, { resultado: contextPack.apply(body.previaId, { confirmar: body.confirmar }) });
    }
    if (req.method === "GET" && pathName === "/api/pacote/conectores") return send(res, 200, { conectores: contextPack.pendingConnectors() });
    if (req.method === "GET" && pathName === "/api/pacote/fontes") return send(res, 200, { fontes: contextSources.list() });
    if (req.method === "POST" && pathName === "/api/pacote/fontes/ler") return send(res, 200, await contextSources.read(body));
    // ---- Fase 2: pastas seguras
    if (req.method === "GET" && pathName === "/api/pastas") {
      return send(res, 200, { pastas: safeFolders.list(), lixeira: safeFolders.trashAvailable(), seletor: safeFolders.pickerAvailable() });
    }
    if (req.method === "POST" && pathName === "/api/pastas/escolher") {
      const added = await safeFolders.pick();
      return send(res, added ? 201 : 200, { pasta: added, cancelado: !added });
    }
    if ((match = pathName.match(/^\/api\/pastas\/([^/]+)$/)) && req.method === "DELETE") {
      return send(res, 200, { ok: safeFolders.remove(decodeURIComponent(match[1])) });
    }
    if ((match = pathName.match(/^\/api\/pastas\/([^/]+)\/(arquivos|arquivo|lixeira)$/))) {
      const id = decodeURIComponent(match[1]);
      const rel = url.searchParams.get("caminho") ?? body.caminho ?? "";
      if (req.method === "GET" && match[2] === "arquivos") return send(res, 200, safeFolders.listFiles(id, rel));
      if (req.method === "GET" && match[2] === "arquivo") return send(res, 200, safeFolders.read(id, rel));
      if (req.method === "POST" && match[2] === "arquivo") return send(res, 200, safeFolders.write(id, rel, body.conteudo));
      if (req.method === "POST" && match[2] === "lixeira") return send(res, 200, await safeFolders.trash(id, rel));
    }
    if (req.method === "GET" && pathName === "/api/ditado") {
      return send(res, 200, { prefs: dictationPrefs.view(), stats: dictationStats.view() });
    }
    if (req.method === "POST" && pathName === "/api/ditado") return send(res, 200, { prefs: dictationPrefs.update(body) });
    if (req.method === "POST" && pathName === "/api/ditado/uso") return send(res, 200, { stats: dictationStats.record(body) });
    if (req.method === "GET" && pathName === "/api/skills") return send(res, 200, { skills: skills.list(body.assistantId || url.searchParams.get("assistant") || "") });
    if (req.method === "POST" && pathName === "/api/skills/importar/previa") return send(res, 200, { preview: skills.preview(body) });
    if (req.method === "POST" && pathName === "/api/skills/importar/aplicar") return send(res, 201, { skill: skills.apply(body) });
    if (req.method === "POST" && pathName === "/api/skills/modelo/pagina-oasis") {
      if (body.confirmar !== true) return send(res, 400, { error: "Confirme para instalar a skill de exemplo." });
      return send(res, 201, { skill: skills.installOasis() });
    }
    if (req.method === "DELETE" && (match = pathName.match(/^\/api\/skills\/([^/]+)$/))) {
      return send(res, 200, { ok: skills.remove(decodeURIComponent(match[1])) });
    }
    if (req.method === "GET" && pathName === "/api/onboarding") return send(res, 200, onboarding.checklist());
    if (req.method === "POST" && pathName === "/api/onboarding/propor") return send(res, 200, onboarding.propose(body.texto || body.text || ""));
    if (req.method === "POST" && pathName === "/api/onboarding/aplicar") return send(res, 201, onboarding.aplicar(body.modelos));
    if (req.method === "POST" && pathName === "/api/onboarding/checklist") return send(res, 200, onboarding.mark(body));
    if (req.method === "GET" && pathName === "/api/routines/modelos") {
      return send(res, 200, { modelos: [{ id: MORNING_MODEL, title: MORNING_TITLE, prompt: MORNING_PROMPT, clock: "08:00", readOnly: true, enabled: false }] });
    }
    if (req.method === "POST" && pathName === "/api/routines/digest-manha") return send(res, 201, { routine: routines.installMorning() });
    if (req.method === "GET" && pathName === "/api/routines") return send(res, 200, { routines: routines.list() });
    if (req.method === "POST" && pathName === "/api/routines") {
      if (body.assistantId && !assistants.get(String(body.assistantId))) return send(res, 404, { error: "assistente não encontrado" });
      return send(res, 201, { routine: routines.add(body) });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/routines\/([^/]+)$/))) {
      const routine = routines.update(decodeURIComponent(match[1]), body);
      if (!routine) return send(res, 404, { error: "rotina não encontrada" });
      return send(res, 200, { routine });
    }
    if (req.method === "DELETE" && (match = pathName.match(/^\/api\/routines\/([^/]+)$/))) {
      return send(res, 200, { ok: routines.remove(decodeURIComponent(match[1])) });
    }
    if (req.method === "GET" && pathName === "/api/mcp") return send(res, 200, { servers: mcp.list() });
    if (req.method === "POST" && pathName === "/api/mcp") return send(res, 201, { server: mcp.add(body) });
    if (req.method === "DELETE" && (match = pathName.match(/^\/api\/mcp\/([^/]+)$/))) {
      return send(res, 200, { ok: mcp.remove(decodeURIComponent(match[1])) });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/mcp\/([^/]+)\/confirm$/))) {
      return send(res, 200, { server: mcp.confirm(decodeURIComponent(match[1])) });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/mcp\/([^/]+)\/test$/))) {
      return send(res, 200, { server: await mcp.test(decodeURIComponent(match[1])) });
    }
    if (req.method === "POST" && pathName === "/api/search") return send(res, 200, await (opts.searchWeb || searchWeb)(body.query));
    if (req.method === "GET" && pathName === "/api/livecoding") return send(res, 200, { sessions: livecoding.list() });
    if (req.method === "POST" && pathName === "/api/livecoding") {
      const description = typeof body.description === "string" ? body.description.trim() : "";
      if (!description) return send(res, 400, { error: "Descreva o que você quer construir no livecoding." });
      return send(res, 201, { session: await livecoding.start(description) });
    }
    if (req.method === "GET" && (match = pathName.match(/^\/api\/livecoding\/([^/]+)$/))) {
      const session = livecoding.get(decodeURIComponent(match[1]));
      if (!session) return send(res, 404, { error: "sessão não encontrada" });
      return send(res, 200, { session });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/livecoding\/([^/]+)\/next$/))) {
      return send(res, 200, { session: await livecoding.next(decodeURIComponent(match[1])) });
    }
    if (req.method === "POST" && (match = pathName.match(/^\/api\/livecoding\/([^/]+)\/anterior$/))) {
      return send(res, 200, { session: livecoding.prev(decodeURIComponent(match[1])) });
    }
    return send(res, 404, { error: "não encontrado" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return;
      const status = Number(err.status) || 500;
      send(res, status, { error: redact(err.message || "erro interno") });
    });
  });

  const preferred = Number.isInteger(opts.port) ? opts.port : Number(process.env.HELIOS_PORT || 47331);
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferred, HOST, () => resolve(server.address().port));
  });

  return {
    port,
    url: `http://${HOST}:${port}`,
    host: HOST,
    apiToken,
    dataDir,
    projectsDir,
    close: () => new Promise((resolve) => {
      if (timer) clearInterval(timer);
      clearInterval(expireTimer);
      server.close(() => resolve());
    }),
  };
}

module.exports = { startServer, VERSION };

if (require.main === module) {
  startServer({ port: Number(process.env.HELIOS_PORT || 47331) })
    .then((app) => {
      console.log(`HELIOS em ${app.url}`);
    })
    .catch((err) => {
      console.error(redact(err.stack || err));
      process.exit(1);
    });
}
