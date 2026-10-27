"use strict";

/**
 * Correções da auditoria de segurança de 25/10/2026: C-1, C-2, C-3, C-4, C-7 e NV-1/NV-2.
 * O SDK é trocado por um falso (loadSdk) que só guarda as opções recebidas e as ferramentas do HELIOS,
 * para chamar cada ferramenta direto, como o modelo faria.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");
const { classifyTool, classifyToolDetailed } = require("../server/irreversible");
const { describeAction, digestOf, maskValue } = require("../server/approval-preview");
const { restrictedAgentOptions } = require("../server/sdk-safety");
const { sanitizeModelAction, createActions } = require("../server/actions");
const { createUsage } = require("../server/usage");
const { createRoutines } = require("../server/routines");

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

function fakeConnect() {
  const calls = [];
  const connect = async () => ({
    tools: [
      { name: "read_inbox", description: "Lê a caixa de entrada." },
      { name: "send_email", description: "Envia um e-mail." },
      { name: "mystery_tool", description: "Faz alguma coisa." },
      { name: "exec_command", description: "Roda um comando." },
      { name: "approve_request", description: "Aprova um pedido." },
    ],
    call: async (tool, args) => {
      calls.push({ tool, args });
      return { content: [{ type: "text", text: `ok:${tool}` }] };
    },
    close() {},
  });
  connect.calls = calls;
  return connect;
}

function fakeSdk() {
  const captured = [];
  const makeAgent = () => ({
    agentId: `agt_${captured.length}`,
    send: async () => ({ supports: () => false, wait: async () => ({ result: "ok", status: "finished" }) }),
    close() {},
  });
  const sdk = {
    Cursor: { models: { list: async () => [] } },
    Agent: {
      create: async (opts) => {
        captured.push({ op: "create", opts });
        return makeAgent();
      },
      resume: async (id, opts) => {
        captured.push({ op: "resume", opts });
        return makeAgent();
      },
    },
  };
  return { sdk, captured };
}

async function boot(extra = {}) {
  const dataDir = extra.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "helios-sec2-"));
  const connect = fakeConnect();
  const { sdk, captured } = fakeSdk();
  const app = await startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: false,
    routineMs: 0,
    connect,
    loadSdk: async () => sdk,
    getAccounts: () => ({ accounts: [{ id: "acc_teste1", kind: "apiKey", apiKey: "crsr_chave_falsa_de_teste_0001" }], activeId: "acc_teste1" }),
    ...extra,
  });
  app.connect = connect;
  app.captured = captured;
  return app;
}

async function json(app, pathname, opts = {}) {
  const res = await fetch(`${app.url}${pathname}`, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function idle(app, id) {
  for (let i = 0; i < 200; i += 1) {
    const { body } = await json(app, `/api/conversations/${id}`);
    if (body.conversation && !body.conversation.busy) return body.conversation;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("a conversa não ficou pronta");
}

/** Abre uma conversa, faz um turno (o SDK falso guarda as ferramentas) e devolve { id, tools }. */
async function openConv(app, body = {}) {
  const created = await json(app, "/api/conversations", { method: "POST", body });
  const id = created.body.conversation.id;
  const before = app.captured.length;
  await json(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text: "oi" } });
  await idle(app, id);
  const entry = app.captured.slice(before).find((item) => item.opts.local && item.opts.local.customTools);
  assert.ok(entry, "o SDK falso devia ter recebido as ferramentas");
  return { id, tools: entry.opts.local.customTools, opts: entry.opts };
}

const cardsOf = async (app, id) => (await json(app, `/api/conversations/${id}`)).body.conversation.messages.filter((m) => m.role === "approval");
const decide = (app, id, card, decision) => json(app, `/api/conversations/${id}/approvals/${card}`, { method: "POST", body: { decision } });

async function addConnector(app) {
  const added = await json(app, "/api/mcp", { method: "POST", body: { name: "caixa", type: "http", url: "http://127.0.0.1:9/mcp" } });
  await json(app, `/api/mcp/${added.body.server.id}/test`, { method: "POST", body: {} });
}

test("NV-1/NV-2: o agente do SDK só recebe a família mcp (ferramentas do HELIOS) e as embutidas perigosas ficam negadas", async () => {
  const app = await boot();
  try {
    const { opts } = await openConv(app);
    assert.deepEqual(opts.tools, ["mcp"]);
    for (const name of ["shell", "edit", "delete", "task", "webFetch", "webSearch", "applyAgentDiff"]) {
      assert.ok(opts.disallowedTools.includes(name), `${name} devia estar negada`);
    }
    assert.equal(opts.local.sandboxOptions.enabled, true);
    assert.equal(restrictedAgentOptions({ withCustomTools: false }).tools.length, 0, "agente só de texto não tem ferramenta nenhuma");
  } finally {
    await app.close();
  }
});

test("C-1: helios_acao ignora mcp, loginId e conteudo escritos pelo modelo e redireciona escrever/preencher", async () => {
  const app = await boot();
  try {
    await addConnector(app);
    const { id, tools } = await openConv(app);
    const reply = await tools.helios_acao.execute({
      tipo: "enviar",
      resumo: "Avisar a equipe",
      alvo: "time@exemplo.com",
      texto: "Oi",
      mcp: { server: "caixa", tool: "send_email", args: { to: "outra@pessoa.com" } },
      loginId: "login_1",
      conteudo: "xxx",
    });
    assert.match(reply, /PENDENTE/);
    const [card] = await cardsOf(app, id);
    assert.equal(card.kind, "enviar");
    assert.doesNotMatch(card.detail, /Conector/);
    await decide(app, id, card.id, "approve");
    assert.equal(app.connect.calls.length, 0, "nenhum conector rodou: o campo mcp do modelo foi descartado");

    assert.match(await tools.helios_acao.execute({ tipo: "escrever", resumo: "x", alvo: "a.txt" }), /escrever_arquivo/);
    assert.match(await tools.helios_acao.execute({ tipo: "preencher", resumo: "x", alvo: "GitHub" }), /helios_preencher_login/);
    assert.deepEqual(Object.keys(sanitizeModelAction({ tipo: "a", resumo: "b", alvo: "c", texto: "d", mcp: {}, loginId: "e", conteudo: "f" })).sort(), ["alvo", "resumo", "texto", "tipo"]);
  } finally {
    await app.close();
  }
});

test("C-1: se o assistente perde o acesso ao conector depois do cartão, aprovar não executa nada", async () => {
  const app = await boot();
  try {
    await addConnector(app);
    const made = await json(app, "/api/assistants", { method: "POST", body: { name: "Caixa", role: "Cuida da caixa", instructions: "Só e-mail.", mcp: ["caixa"] } });
    const { id, tools } = await openConv(app, { assistantId: made.body.assistant.id });
    await tools.mcp_chamar.execute({ servidor: "caixa", ferramenta: "send_email", argumentos: { to: "a@b.com" } });
    const [card] = await cardsOf(app, id);
    await json(app, `/api/assistants/${made.body.assistant.id}`, { method: "POST", body: { mcp: [] } });
    const done = await decide(app, id, card.id, "approve");
    assert.equal(done.status, 200);
    const [after] = await cardsOf(app, id);
    assert.equal(after.state, "error");
    assert.match(after.result, /não tem acesso/);
    assert.equal(app.connect.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("C-2: o cartão mostra os argumentos reais com segredos mascarados e executa exatamente isso", async () => {
  const app = await boot();
  try {
    await addConnector(app);
    const { id, tools } = await openConv(app);
    const args = { to: "bob@exemplo.com", body: "Oi, Bob. Segue o contrato.", token: SECRET, nota: `chave ${SECRET}` };
    await tools.mcp_chamar.execute({ servidor: "caixa", ferramenta: "send_email", argumentos: args });
    const [card] = await cardsOf(app, id);
    assert.match(card.detail, /Conector: caixa\.send_email/);
    assert.match(card.detail, /to: bob@exemplo\.com/);
    assert.match(card.detail, /body: Oi, Bob\. Segue o contrato\./);
    assert.ok(!card.detail.includes(SECRET), "a chave não pode aparecer no cartão");
    assert.equal(app.connect.calls.length, 0);
    await decide(app, id, card.id, "approve");
    assert.equal(app.connect.calls.length, 1);
    assert.deepEqual(app.connect.calls[0], { tool: "send_email", args });
  } finally {
    await app.close();
  }
});

test("C-2: escrever_arquivo mostra o caminho e o começo do conteúdo", async () => {
  const app = await boot();
  try {
    const { id, tools } = await openConv(app);
    await tools.escrever_arquivo.execute({ caminho: "notas/ideias.txt", conteudo: "primeira linha\nsegunda linha" });
    const [card] = await cardsOf(app, id);
    assert.match(card.detail, /Arquivo: notas\/ideias\.txt/);
    assert.match(card.detail, /primeira linha/);
    assert.match(card.detail, /28 caracteres/);
  } finally {
    await app.close();
  }
});

test("C-2: cartão alterado no disco depois de criado não executa (a impressão digital não bate)", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-sec2-tamper-"));
  const app = await boot({ dataDir });
  let convId;
  let cardId;
  try {
    await addConnector(app);
    const { id, tools } = await openConv(app);
    convId = id;
    await tools.mcp_chamar.execute({ servidor: "caixa", ferramenta: "send_email", argumentos: { to: "ok@exemplo.com" } });
    cardId = (await cardsOf(app, id))[0].id;
  } finally {
    await app.close();
  }
  const file = fs.readdirSync(dataDir).map((name) => path.join(dataDir, name)).find((name) => fs.statSync(name).isFile() && fs.readFileSync(name, "utf8").includes(cardId));
  assert.ok(file, "achar o arquivo de conversas");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("ok@exemplo.com").join("atacante@exemplo.com"));
  const again = await boot({ dataDir });
  try {
    const done = await decide(again, convId, cardId, "approve");
    assert.equal(done.status, 200);
    const [card] = await cardsOf(again, convId);
    assert.equal(card.state, "error");
    assert.match(card.result, /mudou depois/);
    assert.equal(again.connect.calls.length, 0);
  } finally {
    await again.close();
  }
});

test("C-4: ferramenta desconhecida ou que executa/aprova sempre pede cartão, mesmo com Autonomia liberada", async () => {
  const app = await boot();
  try {
    await addConnector(app);
    await json(app, "/api/autonomy", { method: "POST", body: { modes: { ler: "sozinho", escrever: "sozinho", enviar: "sozinho", publicar: "sozinho", apagar: "sozinho" } } });
    const { id, tools } = await openConv(app);
    const read = await tools.mcp_chamar.execute({ servidor: "caixa", ferramenta: "read_inbox", argumentos: {} });
    assert.doesNotMatch(read, /PENDENTE/, "leitura conhecida segue sozinha");
    for (const name of ["mystery_tool", "exec_command", "approve_request"]) {
      assert.match(await tools.mcp_chamar.execute({ servidor: "caixa", ferramenta: name, argumentos: {} }), /PENDENTE/, name);
    }
    assert.equal(app.connect.calls.filter((call) => call.tool !== "read_inbox").length, 0);
    assert.equal((await cardsOf(app, id)).filter((card) => card.state === "pending").length, 3);
  } finally {
    await app.close();
  }
});

test("C-4: classificação falha fechada", () => {
  for (const name of ["approve_request", "close_issue", "exec", "browser_navigate", "mystery", "resolve-library-id"]) {
    assert.notEqual(classifyTool(name, ""), "ler", name);
  }
  for (const name of ["list_posts", "get_order", "read_inbox", "search_messages", "echo", "whoami"]) {
    assert.equal(classifyTool(name, ""), "ler", name);
  }
  assert.equal(classifyToolDetailed("mystery", "").known, false);
  assert.equal(classifyToolDetailed("mystery", "").forceCard, true);
  assert.equal(classifyToolDetailed("exec", "").forceCard, true);
  assert.equal(classifyToolDetailed("create_issue", "").forceCard, false);
  assert.equal(classifyTool("browser_navigate", ""), "enviar");
});

test("C-3: agendar_rotina vira cartão, respeita o intervalo mínimo e o máximo de rotinas", async () => {
  const app = await boot();
  try {
    const { id, tools } = await openConv(app);
    const reply = await tools.agendar_rotina.execute({ titulo: "Resumo diário", pedido: "Resuma meus e-mails e me conte.", cadaMinutos: 60 });
    assert.match(reply, /PENDENTE/);
    assert.equal((await json(app, "/api/routines")).body.routines.length, 0, "nada agendado antes de aprovar");
    const [card] = await cardsOf(app, id);
    assert.equal(card.kind, "rotina");
    assert.match(card.detail, /Resuma meus e-mails/);
    assert.match(card.detail, /a cada 60 minutos/);
    await decide(app, id, card.id, "approve");
    assert.equal((await json(app, "/api/routines")).body.routines.length, 1);

    assert.match(await tools.agendar_rotina.execute({ titulo: "Laço", pedido: "Faça algo sem parar.", cadaMinutos: 1 }), /pelo menos 15 minutos/);
    assert.equal((await cardsOf(app, id)).length, 1, "pedido abaixo do mínimo nem vira cartão");

    await json(app, "/api/atividade/limites", { method: "POST", body: { rotinasMax: 1 } });
    assert.match(await tools.agendar_rotina.execute({ titulo: "Outra", pedido: "Mais uma rotina.", cadaMinutos: 120 }), /limite: 1/);
  } finally {
    await app.close();
  }
});

test("C-3: o intervalo mínimo só vale para o bot; a tela e a API continuam aceitando o que aceitavam", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-rot-"));
  const routines = createRoutines(dir);
  assert.ok(routines.add({ title: "Teste", prompt: "Faça algo.", everyMinutes: 1 }));
  assert.throws(() => routines.checkLimits({ title: "Teste", prompt: "Faça algo.", everyMinutes: 1 }, { fromBot: true, minEveryMinutes: 15 }), /pelo menos 15/);
  assert.ok(routines.checkLimits({ title: "Teste", prompt: "Faça algo.", clock: "08:30" }, { fromBot: true, minEveryMinutes: 15 }));
});

test("C-7: teto global de chamadas por dia, somando assistentes, configurável (0 = sem teto)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-uso-"));
  let max = 3;
  const usage = createUsage(dir, { globalCallsPerDay: () => max });
  usage.record("a", {});
  usage.record("b", {});
  assert.equal(usage.blockReason("a"), null);
  usage.record("a", {});
  assert.match(usage.blockReason("b"), /teto global/);
  assert.equal(usage.globalStatus().used, 3);
  max = 0;
  assert.equal(usage.blockReason("b"), null, "0 = sem teto");
  assert.equal(createUsage(fs.mkdtempSync(path.join(os.tmpdir(), "helios-uso-")), {}).globalStatus().max, 500, "padrão");
});

test("C-7: o teto global aparece em Atividade > Limites e em /api/uso", async () => {
  const app = await boot();
  try {
    const limits = (await json(app, "/api/atividade")).body.limits;
    const row = limits.find((item) => item.key === "usoGlobalChamadasDia");
    assert.equal(row.value, 500);
    await json(app, "/api/atividade/limites", { method: "POST", body: { usoGlobalChamadasDia: 7 } });
    assert.equal((await json(app, "/api/uso")).body.global.max, 7);
  } finally {
    await app.close();
  }
});

test("C-2: máscara de segredos e impressão digital estável", () => {
  const masked = maskValue({ a: 1, senha: "x", nested: { apiKey: "y", ok: "texto" }, lista: [SECRET] });
  assert.equal(masked.senha, "[segredo]");
  assert.equal(masked.nested.apiKey, "[segredo]");
  assert.equal(masked.nested.ok, "texto");
  assert.ok(!JSON.stringify(masked).includes(SECRET));
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: 2 }));
  const long = describeAction({ tipo: "enviar", mcp: { server: "s", tool: "t", args: { texto: "x".repeat(5000) } } });
  assert.ok(long.length < 1200, "argumentos enormes são cortados no cartão");
});

test("NV-3: escrever e apagar não atravessam junction/symlink para fora da pasta de projetos", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helios-nv3-"));
  const projects = path.join(root, "projetos");
  const outside = path.join(root, "fora");
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "alvo.txt"), "intacto");
  try {
    fs.symlinkSync(outside, path.join(projects, "atalho"), "junction");
  } catch {
    t.skip("o sistema não deixou criar o junction/symlink de teste");
    return;
  }
  const actions = createActions({ dataDir: root, projectsDir: projects, mcp: null });
  return Promise.all([
    assert.rejects(actions.perform({ tipo: "escrever", alvo: "atalho/novo.txt", conteudo: "x" }), /dentro da pasta de projetos/),
    assert.rejects(actions.perform({ tipo: "apagar", alvo: "atalho/alvo.txt" }), /dentro da pasta de projetos/),
  ]).then(async () => {
    assert.equal(fs.readFileSync(path.join(outside, "alvo.txt"), "utf8"), "intacto");
    assert.equal(fs.existsSync(path.join(outside, "novo.txt")), false);
    await actions.perform({ tipo: "escrever", alvo: "normal/ok.txt", conteudo: "dentro" });
    assert.equal(fs.readFileSync(path.join(projects, "normal", "ok.txt"), "utf8"), "dentro");
  });
});