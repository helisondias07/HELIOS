"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classify } = require("../server/router");
const { chooseModel, selectionFor, COMPOSER, GROK } = require("../server/model-policy");
const { createMemory, unsafeReason } = require("../server/memory");
const { parseDdg, searchWeb } = require("../server/search");
const { agentIndex, vaultPrompt, fillMessage } = require("../server/vault-public");
const { isIrreversible } = require("../server/irreversible");
const { captureSecrets, secret } = require("../server/secrets");
const { redact } = require("../server/util");
const { isDue, createRoutines, dispatchDue } = require("../server/routines");
const { createStore } = require("../server/store");
const { createLivecoding, draftPlanFromRequest, normalizePlan, parsePlanJson } = require("../server/livecoding");
const { connectMcp } = require("../server/mcp-client");

test("Auto manda conversa para o rápido e projeto grande para o avançado", () => {
  assert.equal(classify("oi").level, "rapido");
  assert.equal(classify("qual o status da tarefa?").kind, "pergunta");
  assert.equal(classify("muda a cor do título para #111").level, "rapido");
  assert.equal(classify("corrige o botão do header que quebrou no mobile").level, "padrao");
  assert.equal(classify("cria um aplicativo do zero com login, lista e painel").level, "avancado");
});

test("roteamento nunca pede a variante fast e separa Composer de Grok", () => {
  const cheap = chooseModel({ text: "oi, tudo bem?" });
  const big = chooseModel({ text: "cria um aplicativo do zero com várias telas" });
  assert.equal(cheap.id, COMPOSER);
  assert.equal(cheap.level, "rapido");
  assert.equal(big.id, GROK);
  assert.equal(big.level, "avancado");
  assert.deepEqual(selectionFor(COMPOSER).params, [{ id: "fast", value: "false" }]);
  assert.equal(chooseModel({ text: "cria um aplicativo do zero", override: "rapido" }).id, COMPOSER);
  assert.equal(String(cheap.selection.id).includes("fast"), false);
});

test("memória recusa segredo e recupera fato", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-mem-"));
  const memory = createMemory(dir);
  assert.match(unsafeReason("senha: abc"), /senha/);
  assert.throws(() => memory.remember({ text: "token ghp_abcdefghijklmnopqrstuvwxyz123456" }), /Não guardo/);
  memory.remember({ text: "O Helison prefere explicação curta em português.", kind: "preferencia" });
  const ctx = memory.context({ text: "como explicar em português?" });
  assert.match(ctx.text, /português/);
});

test("pesquisa extrai título e URL real", () => {
  const html = `
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Fguia&amp;rut=1">Guia de teste</a>
    <a class="result__snippet">Um texto curto da fonte.</a>
  `;
  const results = parseDdg(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://exemplo.com/guia");
  assert.equal(results[0].title, "Guia de teste");
  assert.match(results[0].snippet, /texto curto/);
});

test("página vazia da busca vira erro visível", async () => {
  const result = await searchWeb("oasis", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "   " }),
  });
  assert.deepEqual(result.results, []);
  assert.match(result.error, /vazia/);
});

test("pesquisa acha o trecho mesmo longe do título", () => {
  const html = `<a class="result__a" href="https://exemplo.com/flex">Guia de flexbox</a>${"x".repeat(1800)}<a class="result__snippet" href="https://exemplo.com/flex">Trecho distante da fonte.</a>`;
  const results = parseDdg(html);
  assert.equal(results.length, 1);
  assert.match(results[0].snippet, /Trecho distante/);
});

test("cofre público não leva senha para o agente", () => {
  const raw = [
    { id: "1", tipo: "login", nome: "GitHub", usuario: "helison", senha: "super-secreta" },
    { id: "2", tipo: "token", nome: "Groq", valor: "gsk_abcdef1234567890" },
  ];
  const index = agentIndex(raw);
  assert.equal(index.length, 1);
  assert.equal(index[0].senha, undefined);
  const prompt = vaultPrompt(raw);
  assert.match(prompt, /GitHub/);
  assert.equal(prompt.includes("super-secreta"), false);
  assert.equal(prompt.includes("gsk_"), false);
  assert.equal(prompt.includes("helison"), false);
  assert.equal(fillMessage("GitHub", { ok: true, senha: "super-secreta" }).includes("super-secreta"), false);
});

test("ações irreversíveis são reconhecidas e o segredo sai do ambiente", () => {
  assert.equal(isIrreversible("send_email", "envia uma mensagem"), true);
  assert.equal(isIrreversible("list_messages", "lista a caixa"), false);
  const env = { CURSOR_API_KEY: "crsr_teste_1234567890", GROQ_API_KEY: "", OUTRA: "fica" };
  captureSecrets(env);
  assert.equal(env.CURSOR_API_KEY, undefined);
  assert.equal(secret("CURSOR_API_KEY"), "crsr_teste_1234567890");
  assert.equal(env.OUTRA, "fica");
  assert.match(redact('chave gsk_abcdef1234567890 e "senha":"abc"'), /\[segredo\]/);
});

test("rotina por intervalo não dispara no instante em que nasce", () => {
  const created = Date.parse("2026-10-23T12:00:00.000Z");
  const item = { enabled: true, everyMinutes: 30, createdAt: new Date(created).toISOString(), lastRun: null, clock: null };
  assert.equal(isDue(item, created + 1000), false);
  assert.equal(isDue(item, created + 31 * 60 * 1000), true);
});

test("rotina de horário dispara no dia em que nasce se a hora ainda não passou", () => {
  const created = new Date(2026, 9, 24, 10, 0, 0);
  const item = { enabled: true, clock: "18:00", everyMinutes: null, createdAt: created.toISOString(), lastRun: null };
  const slot = new Date(2026, 9, 24, 18, 0, 20);
  assert.equal(isDue(item, slot.getTime()), true);
  assert.equal(isDue(item, new Date(2026, 9, 24, 18, 15, 0).getTime()), false);
  const late = { ...item, createdAt: new Date(2026, 9, 24, 19, 0, 0).toISOString() };
  assert.equal(isDue(late, slot.getTime()), false);
  item.lastRun = slot.toISOString();
  assert.equal(isDue(item, slot.getTime()), false);
});

test("rotina não marca lastRun se o envio falha", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-rot-"));
  const routines = createRoutines(dir);
  const store = createStore(dir);
  const item = routines.add({ title: "Manhã", prompt: "revisar o pull request", everyMinutes: 1 });
  routines.markRan(item.id, Date.now() - 120000);
  const before = routines.list()[0].lastRun;
  const failed = dispatchDue({
    routines,
    store,
    send() { throw new Error("ocupada"); },
  });
  assert.deepEqual(failed.ran, []);
  assert.equal(failed.skipped.length, 1);
  assert.equal(routines.list()[0].lastRun, before);
  const ok = dispatchDue({ routines, store, send() {} });
  assert.deepEqual(ok.ran, [item.id]);
  assert.notEqual(routines.list()[0].lastRun, before);
});

test("livecoding pausa entre passos, grava o plano e abre o VS Code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-live-"));
  const opened = [];
  const agentCalls = [];
  const live = createLivecoding({
    rootDir: dir,
    openEditor: (folder) => {
      opened.push(folder);
      return { ok: true, cmd: "code", folder };
    },
    runAgentStep: async ({ folder, step }) => {
      agentCalls.push(step.n);
      const { writeFiles } = require("../server/livecoding");
      writeFiles(folder, step.files || []);
      return { via: "agente", text: step.explicacao };
    },
  });
  const session = await live.start("página de apresentação do estágio");
  assert.equal(opened.length, 1);
  assert.equal(fs.existsSync(path.join(session.folder, "index.html")), false);
  assert.equal(fs.existsSync(path.join(session.folder, "PLANO.md")), true);
  assert.equal(session.steps[0].status, "current");
  assert.match(fs.readFileSync(path.join(session.folder, "PLANO.md"), "utf8"), /passo/);
  const step1 = await live.next(session.id);
  assert.deepEqual(agentCalls, [1]);
  assert.equal(fs.existsSync(path.join(session.folder, "index.html")), true);
  assert.equal(fs.existsSync(path.join(session.folder, "style.css")), false);
  assert.equal(step1.status, "paused");
  assert.match(step1.lastNote, /esqueleto|HTML|estrutura/i);
  await live.next(session.id);
  await live.next(session.id);
  const done = await live.next(session.id);
  assert.equal(done.status, "done");
  assert.equal(fs.existsSync(path.join(session.folder, "script.js")), true);
  assert.equal(opened[0], session.folder);
});

test("o plano do livecoding nasce do pedido e recusa JSON inválido", async () => {
  const draft = draftPlanFromRequest("calculadora de desconto do tênis");
  assert.match(draft.steps.map((step) => `${step.titulo} ${step.explicacao}`).join("\n"), /calculadora de desconto/);
  assert.equal(draft.steps[0].files[0].path, "index.html");
  assert.equal(draft.steps.at(-1).files.length, 0);
  const parsed = parsePlanJson("segue\n```json\n{\"title\":\"Lista\",\"steps\":[{\"titulo\":\"HTML\",\"explicacao\":\"Monta a lista.\",\"files\":[{\"path\":\"index.html\",\"contents\":\"<h1>lista</h1>\"}]},{\"titulo\":\"Revisar\",\"explicacao\":\"Parar aqui.\",\"files\":[]}]}\n```");
  assert.equal(normalizePlan(parsed).title, "Lista");
  assert.equal(normalizePlan({ title: "só um" }), null);
  assert.equal(normalizePlan({ title: "Ruim", steps: [{ titulo: "A", explicacao: "B", files: [{ path: "../segredo.txt", contents: "x" }] }, { titulo: "C", explicacao: "D", files: [] }] }), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-plano-"));
  const live = createLivecoding({
    rootDir: dir,
    openEditor: () => ({ ok: true, cmd: "code", folder: dir }),
    proposePlan: async (description) => ({
      title: "Quadro",
      steps: [
        { titulo: "HTML do quadro", explicacao: `Lista para: ${description}`, files: [{ path: "index.html", contents: "<h1>tarefas</h1>" }] },
        { titulo: "Revisar", explicacao: "Parar e ler junto.", files: [] },
      ],
    }),
  });
  const session = await live.start("quadro do estagiário");
  assert.equal(session.steps[0].titulo, "HTML do quadro");
  assert.match(session.steps[0].explicacao, /quadro do estagiário/);
  const fallback = createLivecoding({
    rootDir: dir,
    openEditor: () => ({ ok: true }),
    proposePlan: async () => ({ title: "incompleto" }),
  });
  const local = await fallback.start("página de apoio");
  assert.match(local.steps[0].explicacao, /esqueleto|HTML|estrutura/i);
});

test("conector MCP stdio responde de verdade", async () => {
  const conn = await connectMcp("eco", {
    type: "stdio",
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "mcp-stdio.js")],
  }, { timeoutMs: 8000, initTimeoutMs: 8000 });
  try {
    assert.equal(conn.tools[0].name, "eco");
    const result = await conn.call("eco", { texto: "olá" });
    assert.match(JSON.stringify(result), /eco:olá/);
  } finally {
    conn.close();
  }
});
