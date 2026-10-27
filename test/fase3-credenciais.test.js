"use strict";

/**
 * Fase 3: credenciais que o modelo nunca vê.
 * Cobre: valores secretos conhecidos, segredo digitado no chat, referências opacas do cofre, preenchimento só no processo local,
 * saídas e erros de conectores, montagem do prompt, memória e a tela do cofre (só "definido").
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");
const { redact } = require("../server/util");
const { setSecretValues, clearSecretValues, scrubKnown, knownSecretCount } = require("../server/secret-values");
const { screenUserText } = require("../server/credentials");
const { agentIndex, vaultPrompt } = require("../server/vault-public");
const { buildPrompt, consultPrompt, helperPrompt } = require("../server/agent-prompt");
const { unsafeReason } = require("../server/memory");
const { createVault, editorView } = require("../src/vault-store");

const PASS = "Zorro#Segredo99";
const KEY = "chave-do-conector-7788aa";
const MCP_TOKEN = "TOKENSEGREDO12345xyz";
const XOR = 0x5a;
const xor = (text) => Buffer.from(String(text), "utf8").map((byte) => byte ^ XOR);
const unxor = (buf) => Buffer.from(buf).map((byte) => byte ^ XOR).toString("utf8");
const safeStorage = () => ({ isEncryptionAvailable: () => true, encryptString: xor, decryptString: unxor });

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const everyFile = (root) => fs.readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => fs.readFileSync(path.join(entry.parentPath || entry.path, entry.name), "utf8"));

function fakeSdk(prompts, holder) {
  const grab = (opts) => { if (opts && opts.local && opts.local.customTools) holder.tools = opts.local.customTools; };
  const makeAgent = () => ({
    agentId: "agt_fase3",
    send: async (prompt) => {
      prompts.push(String(prompt));
      return { supports: () => false, wait: async () => ({ result: "ok", status: "finished" }) };
    },
    close() {},
  });
  return { Cursor: { models: { list: async () => [] } }, Agent: { create: async (opts) => { grab(opts); return makeAgent(); }, resume: async (agentId, opts) => { grab(opts); return makeAgent(); } } };
}

function fakeConnect() {
  return async () => ({
    tools: [
      { name: "read_inbox", description: `Lê a caixa. Use a chave ${MCP_TOKEN} se pedir.` },
      { name: "read_broken", description: "Falha de propósito." },
    ],
    call: async (tool) => {
      if (tool === "read_broken") throw new Error(`401: token ${MCP_TOKEN} recusado`);
      return { content: [{ type: "text", text: `3 mensagens, autenticado com ${MCP_TOKEN}` }] };
    },
    close() {},
  });
}

async function boot(extra = {}) {
  const dataDir = tmp("helios-fase3-");
  const prompts = [];
  const holder = { tools: null };
  const app = await startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: false,
    routineMs: 0,
    connect: fakeConnect(),
    loadSdk: async () => fakeSdk(prompts, holder),
    getAccounts: () => ({ accounts: [{ id: "acc_teste1", kind: "apiKey", apiKey: "crsr_chave_falsa_de_teste_0001" }], activeId: "acc_teste1" }),
    ...extra,
  });
  app.dataDir = dataDir;
  app.prompts = prompts;
  app.holder = holder;
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
  for (let i = 0; i < 300; i += 1) {
    const { body } = await json(app, `/api/conversations/${id}`);
    if (body.conversation && !body.conversation.busy) return body.conversation;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("a conversa não ficou pronta");
}

async function say(app, id, text) {
  await json(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text } });
  return idle(app, id);
}

async function newConv(app) {
  return (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation.id;
}

test.afterEach(() => clearSecretValues());

test("valores secretos conhecidos viram [segredo] em qualquer texto, inclusive escapados e sem rótulo", () => {
  setSecretValues("teste", [PASS, "curto", "  ", null, 123456789]);
  assert.equal(knownSecretCount() >= 3, true);
  assert.equal(scrubKnown(`a senha é ${PASS}, ok`), "a senha é [segredo], ok");
  assert.equal(redact(`log: ${PASS}`), "log: [segredo]");
  assert.equal(redact(JSON.stringify({ senha_digitada: PASS })).includes(PASS), false);
  assert.equal(redact(`?x=${encodeURIComponent(PASS)}`).includes(encodeURIComponent(PASS)), false);
  assert.equal(redact("curto continua visível"), "curto continua visível", "valor curto demais não é registrado");
  assert.equal(redact("123456789").includes("123456789"), false);
  setSecretValues("teste", []);
  assert.equal(redact(`log: ${PASS}`), `log: ${PASS}`, "ao limpar a origem o valor deixa de ser mascarado");
});

test("segredo digitado no chat é detectado e mascarado, com aviso; texto normal passa intacto", () => {
  setSecretValues("cofre", [PASS]);
  const labeled = screenUserText("minha senha: abc12345xyz e o resto");
  assert.equal(labeled.masked, true);
  assert.equal(labeled.text.includes("abc12345xyz"), false);
  assert.match(labeled.notice, /Cofre/);
  const bearer = screenUserText("Authorization: Bearer abcdefghijklmnop12345");
  assert.equal(bearer.text.includes("abcdefghijklmnop12345"), false);
  const prefixed = screenUserText("use sk-abcdefghijklmnopqrstuvwxyz0123456789 aqui");
  assert.equal(prefixed.text.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), false);
  const known = screenUserText(`entra com ${PASS} por favor`);
  assert.equal(known.masked, true, "valor que já está no cofre é pego mesmo sem rótulo");
  assert.equal(known.text.includes(PASS), false);
  const plain = screenUserText("Resuma a reunião de ontem e liste os próximos passos.");
  assert.deepEqual(plain, { text: "Resuma a reunião de ontem e liste os próximos passos.", masked: false, notice: "" });
});

test("cofre: a lista, o índice e a edição só dizem 'definido' e o valor não vai a disco em claro", async () => {
  const root = tmp("helios-fase3-vault-");
  const vault = await createVault({ dir: root, safeStorage: safeStorage() });
  const login = await vault.saveLogin({ nome: "GitHub", usuario: "helison", senha: PASS, url: "https://github.com" });
  await vault.saveToken({ nome: "npm", valor: MCP_TOKEN });
  await vault.setKey("groq", "gsk_abcdef1234567890");
  const listed = vault.list();
  assert.equal(listed.logins[0].senhaDefinida, true);
  assert.equal(listed.tokens[0].valorDefinido, true);
  for (const view of [JSON.stringify(listed), JSON.stringify(vault.index()), JSON.stringify(editorView(vault.getLogin(login.id))), JSON.stringify(editorView(vault.getToken(listed.tokens[0].id)))]) {
    assert.equal(view.includes(PASS), false);
    assert.equal(view.includes(MCP_TOKEN), false);
    assert.equal(view.includes("gsk_abcdef1234567890"), false);
  }
  assert.equal(editorView(vault.getLogin(login.id)).senhaDefinida, true);
  // o cofre registra os valores: se escaparem para um texto, o redact() os mascara
  assert.equal(redact(`vazou ${PASS}`).includes(PASS), false);
  assert.equal(redact(`vazou ${MCP_TOKEN}`).includes(MCP_TOKEN), false);
  assert.equal(redact("vazou gsk_abcdef1234567890").includes("gsk_abcdef1234567890"), false);
  // login sem senha não conta como definido
  await vault.saveLogin({ nome: "Vazio", usuario: "x", senha: "" });
  assert.equal(vault.list().logins.find((item) => item.nome === "Vazio").senhaDefinida, false);
});

test("o modelo só recebe referências: agentIndex e vaultPrompt têm nome, nunca usuário, senha ou token", () => {
  const index = [
    { id: "login_1", tipo: "login", nome: "GitHub", usuario: "helison", senha: PASS },
    { id: "tok_1", tipo: "token", nome: "npm", valor: MCP_TOKEN },
  ];
  const ref = agentIndex(index);
  assert.deepEqual(ref, [{ id: "login_1", nome: "GitHub" }]);
  const prompt = vaultPrompt(index);
  assert.match(prompt, /GitHub/);
  for (const secret of [PASS, MCP_TOKEN, "helison"]) assert.equal(prompt.includes(secret), false);
  setSecretValues("teste", [PASS]);
  assert.equal(agentIndex([{ id: "login_2", tipo: "login", nome: `Banco ${PASS}` }])[0].nome.includes(PASS), false);
});

test("montagem do prompt: assistente, memória, contexto, resumo e histórico passam por redact()", () => {
  setSecretValues("teste", [PASS]);
  const built = buildPrompt({
    text: `abra a conta com ${PASS}`,
    assistantText: `Instruções: sempre use ${PASS}`,
    vaultText: "",
    memoryText: `Memória: ${PASS}`,
    contextText: `Contexto: ${PASS}`,
    summaryText: `Resumo: ${PASS}`,
    history: `Helison: ${PASS}`,
  });
  assert.equal(String(built).includes(PASS), false);
  assert.equal(String(consultPrompt({ question: `qual é ${PASS}?`, assistantText: PASS, memoryText: PASS, contextText: PASS })).includes(PASS), false);
  assert.equal(String(helperPrompt({ task: "x", instructions: PASS, context: PASS })).includes(PASS), false);
});

test("memória recusa texto com cara de senha ou chave", () => {
  assert.ok(unsafeReason("minha senha: abc12345xyz"));
  assert.ok(unsafeReason("Authorization: Bearer abcdefghijklmnop12345"));
  setSecretValues("teste", [PASS]);
  assert.ok(unsafeReason(`o login usa ${PASS}`));
  assert.equal(unsafeReason("Prefere respostas curtas em português."), "");
});

test("mensagem com segredo: o modelo, o histórico, a API e o disco só veem [segredo]; o aviso aparece para o Helison", async () => {
  const root = tmp("helios-fase3-vault2-");
  const vault = await createVault({ dir: root, safeStorage: safeStorage() });
  await vault.saveLogin({ nome: "GitHub", usuario: "helison", senha: PASS, url: "https://github.com" });
  const app = await boot({ getVaultIndex: () => vault.index() });
  try {
    const id = await newConv(app);
    const sk = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const conv = await say(app, id, `entra no github com ${PASS} e usa a chave ${sk}`);
    const user = conv.messages.find((message) => message.role === "user");
    assert.equal(user.text.includes(PASS), false);
    assert.equal(user.text.includes(sk), false);
    assert.match(user.text, /\[segredo\]/);
    assert.match(user.aviso, /Cofre/);
    assert.ok(app.prompts.length >= 1);
    for (const prompt of app.prompts) {
      assert.equal(prompt.includes(PASS), false, "o prompt não pode ter a senha");
      assert.equal(prompt.includes(sk), false);
    }
    assert.match(app.prompts.join("\n"), /GitHub/, "o modelo vê o nome do login (referência)");
    assert.equal(JSON.stringify((await json(app, `/api/conversations/${id}`)).body).includes(PASS), false);
    await app.close();
    for (const content of everyFile(app.dataDir)) {
      assert.equal(content.includes(PASS), false, "nenhum arquivo do app pode ter a senha");
      assert.equal(content.includes(sk), false);
    }
    // mensagem normal: sem aviso
    const app2 = await boot();
    try {
      const id2 = await newConv(app2);
      const normal = await say(app2, id2, "Resuma a reunião de ontem.");
      const msg = normal.messages.find((message) => message.role === "user");
      assert.equal(msg.text, "Resuma a reunião de ontem.");
      assert.ok(!msg.aviso);
    } finally {
      await app2.close();
    }
  } finally {
    await app.close().catch(() => {});
  }
});

test("preencher login: o modelo pede só pelo nome, o cartão vai ao Helison e o valor não volta ao modelo", async () => {
  const root = tmp("helios-fase3-vault3-");
  const vault = await createVault({ dir: root, safeStorage: safeStorage() });
  const saved = await vault.saveLogin({ nome: "GitHub", usuario: "helison", senha: PASS, url: "https://github.com" });
  const filled = [];
  const app = await boot({
    getVaultIndex: () => vault.index(),
    onFillLogin: async ({ id, nome }) => {
      // só o processo local abre o cofre; o valor sai daqui direto para a janela, nunca para a resposta
      assert.equal(vault.getLogin(id).senha, PASS);
      filled.push({ id, nome });
      return { ok: true, secretoQueNaoPodeVoltar: PASS };
    },
  });
  try {
    const id = await newConv(app);
    await say(app, id, "oi");
    // chama a ferramenta como o modelo faria, pelas ferramentas que o SDK falso recebeu no turno
    const result = await app.holder.tools.helios_preencher_login.execute({ nome: "GitHub" });
    assert.equal(JSON.stringify(result).includes(PASS), false);
    assert.equal(filled.length, 0, "nada é digitado antes do OK do Helison");
    const conv = (await json(app, `/api/conversations/${id}`)).body.conversation;
    const card = conv.messages.find((message) => message.role === "approval" && message.state === "pending");
    assert.ok(card, "devia haver um cartão pendente");
    assert.equal(card.kind, "preencher");
    assert.match(card.summary, /GitHub/);
    assert.equal(JSON.stringify(conv).includes(PASS), false);
    const decided = await json(app, `/api/conversations/${id}/approvals/${card.id}`, { method: "POST", body: { decision: "approve" } });
    assert.equal(decided.status, 200);
    assert.equal(filled.length, 1);
    assert.equal(filled[0].id, saved.id);
    const after = (await json(app, `/api/conversations/${id}`)).body;
    assert.equal(JSON.stringify(after).includes(PASS), false, "o resultado do preenchimento não devolve o valor");
  } finally {
    await app.close();
  }
});

test("conector: a saída, o erro e as descrições passam por redact() na origem; env sem cara de segredo não é mascarado", async () => {
  const vault = await createVault({ dir: tmp("helios-fase3-vault4-"), safeStorage: safeStorage() });
  const app = await boot({ secretSealer: vault.sealer });
  try {
    const added = await json(app, "/api/mcp", { method: "POST", body: { name: "caixa", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });
    assert.equal(added.status, 201);
    const tested = await json(app, `/api/mcp/${added.body.server.id}/test`, { method: "POST", body: {} });
    assert.equal(JSON.stringify(tested.body).includes(MCP_TOKEN), false, "descrição da ferramenta sem o token");
    assert.equal(JSON.stringify((await json(app, "/api/mcp")).body).includes(MCP_TOKEN), false);
    const id = await newConv(app);
    await say(app, id, "oi");
    const tool = app.holder.tools.mcp_chamar;
    const out = String(await tool.execute({ servidor: "caixa", ferramenta: "read_inbox", argumentos: {} }));
    assert.equal(out.includes(MCP_TOKEN), false, "a saída do conector chega ao modelo sem o token");
    assert.match(out, /3 mensagens/);
    await assert.rejects(() => tool.execute({ servidor: "caixa", ferramenta: "read_broken", argumentos: {} }), (err) => !err.message.includes(MCP_TOKEN) && /401/.test(err.message), "o erro do conector chega ao modelo sem o token");
    // env: só valor com nome ou formato de segredo é registrado
    await json(app, "/api/mcp", { method: "POST", body: { name: "local", type: "stdio", command: "node", env: { NODE_ENV: "production", API_TOKEN: KEY } } });
    const masked = redact(`production e ${KEY}`);
    assert.equal(masked.includes(KEY), false);
    assert.match(masked, /^production e /);
    for (const content of everyFile(app.dataDir)) assert.equal(content.includes(MCP_TOKEN), false, "mcp.json não guarda o token em claro");
  } finally {
    await app.close();
  }
});

test("a narração do turno também sai mascarada", async () => {
  setSecretValues("teste", [PASS]);
  const bot = require("fs").readFileSync(path.join(__dirname, "..", "server", "bot.js"), "utf8");
  assert.match(bot, /reply\.narration = redact\(streamed\)/);
});

test("a tela do cofre nunca recebe o valor: só 'definido'", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.equal(/\$\("vaultSenha"\)\.value\s*=\s*entry\.(senha|valor)/.test(app), false, "a edição não pode preencher a senha salva");
  assert.match(app, /senhaDefinida/);
  assert.match(app, /definido/);
  assert.match(app, /message\.aviso/);
});
