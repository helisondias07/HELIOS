"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJobs } = require("../server/jobs");
const fill = require("../server/jobs-fill");
const { createTelegram } = require("../server/telegram");
const { startServer } = require("../server/index");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-${name}-`));
const ROOT = path.join(__dirname, "..");
const TOKEN = "123456789:AAH-segredoSuperLongoDoBotTelegram_xyz";

test("leva E: perfil vem do contexto.md e o perfil das Vagas tem prioridade", () => {
  const p = fill.profileFrom("# Eu\nNome: Helison Dias\nE-mail: h@x.com\nPretensão salarial: [preencher]\nCidade: Recife", { email: "outro@x.com" });
  assert.equal(p.nome, "Helison Dias");
  assert.equal(p.email, "outro@x.com");
  assert.equal(p.cidade, "Recife");
  assert.equal(p.pretensao, "");
});

test("leva E: preenchimento cobre campos comuns e para em todo caso crítico", () => {
  const profile = { nome: "Helison Dias", email: "h@x.com", telefone: "81999", cvPath: "C:\\cv.pdf", cidade: "Recife" };
  const ok = fill.planFill([
    { sel: "1", type: "text", label: "Primeiro nome", required: true },
    { sel: "2", type: "text", label: "Sobrenome", required: true },
    { sel: "3", type: "email", label: "E-mail", required: true },
    { sel: "4", type: "file", label: "Currículo", required: true },
    { sel: "5", type: "select", label: "Cidade", required: true, options: [{ value: "rec", text: "Recife" }, { value: "sp", text: "São Paulo" }] },
  ], profile);
  assert.deepEqual(ok.criticos, []);
  assert.deepEqual(ok.acoes.map((a) => a.valor), ["Helison", "Dias", "h@x.com", "C:\\cv.pdf", "rec"]);
  const crit = (fields, page = {}, prof = profile) => fill.planFill(fields, prof, {}, page).criticos.join(" ");
  assert.match(crit([{ sel: "s", type: "text", label: "Pretensão salarial", required: true }]), /Pretensão/);
  assert.match(crit([{ sel: "r", type: "radio", label: "Disponibilidade para trabalho presencial?", required: true }]), /presencial/);
  assert.match(crit([{ sel: "q", type: "text", label: "Quantos anos de Kotlin?", required: true }]), /não responde/);
  assert.match(crit([], { text: "Etapa 2: faça o teste técnico online" }), /teste/);
  assert.match(crit([], { text: "Pague a taxa de inscrição" }), /pagamento/);
  assert.match(crit([], { captcha: true }), /captcha/);
  assert.match(crit([{ sel: "t", type: "checkbox", label: "Li e concordo com os termos", required: true }]), /Termos/);
  assert.match(crit([{ sel: "f", type: "file", label: "Carta de recomendação", required: true }]), /além do CV/);
  assert.match(crit([{ sel: "c", type: "text", label: "CPF", required: true }]), /CPF ausente|cofre|Dado pessoal/);
  assert.match(crit([{ sel: "o", type: "select", label: "Cidade", required: true, options: [{ value: "x", text: "Manaus" }] }]), /opção/);
  // Resposta guardada vale para a próxima vez, e campo opcional desconhecido fica em branco (nunca chuta).
  const again = fill.planFill([{ sel: "q", type: "text", label: "Quantos anos de Kotlin?", required: true }, { sel: "z", type: "text", label: "Hobby" }], profile, { "quantos anos de kotlin?": "2" });
  assert.deepEqual(again, { acoes: [{ sel: "q", kind: "text", valor: "2" }], criticos: [] });
});

test("leva E: automático vem desligado, respeita limites, repetição e empresas evitadas", async () => {
  let t = Date.parse("2026-10-30T15:00:00Z");
  const jobs = createJobs(tmp("auto"), { mock: true, now: () => t, readProfile: () => "Desenvolvedor front-end React" });
  assert.equal(jobs.prefs().modo, "aprovacao");
  await jobs.search();
  const [first] = jobs.autoQueue();
  assert.throws(() => jobs.autoStart(first.id), /desligado/);
  jobs.setPrefs({ modo: "automatico", porHora: 1, evitarEmpresas: "Empresa Demo 2" });
  assert.ok(jobs.autoQueue().every((v) => v.company !== "Empresa Demo 2"));
  assert.equal(jobs.autoQueue().length, 1);
  jobs.autoStart(first.id);
  assert.equal(jobs.autoResult(first.id, { ok: true }).status, "enviada");
  assert.equal(jobs.autoQueue().length, 0); // limite por hora
  t += 2 * 3600e3;
  // a mesma empresa em outra plataforma não repete dentro de repetirDias
  assert.ok(jobs.autoQueue().every((v) => v.company !== first.company));
  const log = fs.readFileSync(jobs.logFile, "utf8");
  assert.match(log, /enviada_auto/);
  assert.match(jobs.dailySummary(t), /Enviadas sozinho: 1/);
});

test("leva E: caso crítico guarda a resposta pelo rótulo e volta para a fila", async () => {
  const t = Date.parse("2026-10-30T15:00:00Z");
  const jobs = createJobs(tmp("crit"), { mock: true, now: () => t, readProfile: () => "React" });
  await jobs.search();
  jobs.setPrefs({ modo: "automatico" });
  const [v] = jobs.autoQueue();
  jobs.autoStart(v.id);
  const c = jobs.autoResult(v.id, { critico: "Pergunta", pergunta: 'Pergunta que o perfil não responde: "Quantos anos de Kotlin?"' });
  assert.equal(c.status, "critica");
  assert.equal(jobs.criticals().length, 1);
  jobs.answerCritical(c.critico.codigo, "2 anos");
  assert.equal(jobs.prefs().respostas["quantos anos de kotlin?"], "2 anos");
  assert.equal(jobs.get(v.id).status, "nova");
  assert.throws(() => jobs.skipCritical("nada"), /não encontrado/);
});

function fakeTelegram() {
  const calls = [];
  const queue = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body || "{}");
    calls.push({ url, method, body });
    if (method === "getUpdates") return { status: 200, json: async () => ({ ok: true, result: queue.splice(0) }) };
    return { status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  return { calls, queue, fetchImpl, sent: () => calls.filter((c) => c.method === "sendMessage") };
}

test("leva E: Telegram só atende o dono pareado e nunca vaza o token", async () => {
  const fake = fakeTelegram();
  const logs = [];
  const tasks = [];
  const tg = createTelegram({ dataDir: tmp("tg"), getToken: () => TOKEN, fetchImpl: fake.fetchImpl, log: (l) => logs.push(l), handlers: { onText: async (text) => { tasks.push(text); return "ok"; }, status: async () => "tudo certo", onCallback: async (d) => `cb ${d}` } });
  const code = tg.newCode();
  assert.match(tg.status().codigo, /^\d{6}$/);
  fake.queue.push(
    { update_id: 1, message: { chat: { id: 666, type: "private" }, text: "/parear 000000" } },
    { update_id: 2, message: { chat: { id: 666, type: "private" }, text: "faça algo" } },
    { update_id: 3, message: { chat: { id: 42, type: "private" }, from: { first_name: "Helison" }, text: `/parear ${code}` } },
    { update_id: 4, message: { chat: { id: 666, type: "private" }, text: "/status" } },
    { update_id: 5, message: { chat: { id: 42, type: "private" }, text: "resuma meu dia" } },
    { update_id: 6, message: { chat: { id: 42, type: "private" }, text: "/status" } },
    { update_id: 7, callback_query: { id: "c1", data: "a:1", message: { chat: { id: 42 } } } },
    { update_id: 8, callback_query: { id: "c2", data: "a:1", message: { chat: { id: 666 } } } },
  );
  await tg.pollOnce();
  assert.equal(tg.status().pareado, true);
  assert.equal(tg.status().codigo, "");
  assert.deepEqual(tasks, ["resuma meu dia"]);
  assert.ok(fake.sent().every((c) => c.body.chat_id === 42), "nada é enviado a outro chat");
  assert.deepEqual(fake.sent().map((c) => c.body.text).slice(1), ["ok", "tudo certo", "cb a:1"]);
  const poll = fake.calls.find((c) => c.method === "getUpdates");
  assert.equal(poll.body.offset, 0);
  await tg.pollOnce();
  assert.equal(fake.calls.filter((c) => c.method === "getUpdates")[1].body.offset, 9);
  // botões
  await tg.send("Aprovar?", [[{ text: "Aprovar", data: "a:1" }, { text: "Negar", data: "n:1" }]]);
  assert.deepEqual(fake.sent().at(-1).body.reply_markup.inline_keyboard[0].map((b) => b.text), ["Aprovar", "Negar"]);
  // erro com token: sai mascarado
  const bad = createTelegram({ dataDir: tmp("tg2"), getToken: () => TOKEN, fetchImpl: async () => { throw new Error(`falhou https://api.telegram.org/bot${TOKEN}/getUpdates`); } });
  await assert.rejects(bad.pollOnce(), (e) => !e.message.includes(TOKEN) && /\[token\]/.test(e.message));
  assert.ok(!fs.readFileSync(tg.file, "utf8").includes(TOKEN));
  assert.ok(!logs.join(" ").includes(TOKEN));
  // código vencido não pareia
  let t = 0;
  const late = createTelegram({ dataDir: tmp("tg3"), getToken: () => TOKEN, fetchImpl: fake.fetchImpl, now: () => t });
  const c2 = late.newCode();
  t = 16 * 60e3;
  await late.handleUpdate({ message: { chat: { id: 9, type: "private" }, text: `/parear ${c2}` } });
  assert.equal(late.status().pareado, false);
});

test("leva E: API do automático, rotina e Telegram pelo servidor", async () => {
  const fake = fakeTelegram();
  let ran = 0;
  const server = await startServer({ dataDir: tmp("e-api"), mock: true, port: 0, routineMs: 0, fetch: fake.fetchImpl, getTelegramToken: () => TOKEN, runVagasAuto: async () => { ran += 1; return { ok: true, enviadas: 0, criticas: 0, falhas: 0 }; } });
  const call = async (method, p, body) => {
    const res = await fetch(server.url + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${server.apiToken()}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    let r = await call("POST", "/api/vagas/auto/rodar", {});
    assert.equal(r.body.iniciado, true);
    r = await call("POST", "/api/vagas/preferencias", { modo: "automatico" });
    assert.equal(r.status, 200);
    assert.equal(r.body.prefs.modo, "automatico");
    r = await call("POST", "/api/vagas/auto/rodar", {});
    assert.equal(r.body.iniciado, true);
    assert.equal(ran, 2);
    r = await call("GET", "/api/vagas/auto/fila");
    const id = r.body.fila[0].id;
    assert.equal((await call("POST", `/api/vagas/${id}/auto/iniciar`, {})).body.vaga.status, "auto_enviando");
    r = await call("POST", `/api/vagas/${id}/auto/resultado`, { critico: "Pretensão", pergunta: 'Pretensão salarial sem valor no seu contexto: "Pretensão salarial"' });
    assert.equal(r.body.vaga.status, "critica");
    r = await call("GET", "/api/vagas");
    assert.equal(r.body.criticas.length, 1);
    r = await call("POST", `/api/vagas/critica/${r.body.criticas[0].critico.codigo}/responder`, { resposta: "R$ 8.000" });
    assert.equal(r.body.vaga.status, "nova");
    r = await call("POST", "/api/routines/vagas-auto", { everyMinutes: 120 });
    assert.equal(r.status, 201);
    assert.match(r.body.routine.prompt, /^\[vagas-auto\]/);
    r = await call("GET", "/api/telegram");
    assert.equal(r.body.telegram.ligado, false);
    assert.equal(r.body.telegram.temToken, true);
    assert.ok(!JSON.stringify(r.body).includes(TOKEN));
    r = await call("POST", "/api/telegram/codigo", {});
    assert.match(r.body.telegram.codigo, /^\d{6}$/);
  } finally {
    await server.close();
  }
});

test("leva E: cofre aceita a chave telegram e a interface mostra Telegram no Cofre e o modo Automático", () => {
  const vault = fs.readFileSync(path.join(ROOT, "src", "vault-store.js"), "utf8");
  assert.match(vault, /"telegram"/);
  assert.match(vault, /hasTelegramKey/);
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.match(app, /<h2>Telegram<\/h2>/);
  assert.match(app, /helios\.setKey\("telegram"/);
  assert.match(app, /Com aprovação \(padrão\)/);
  assert.match(app, /termos do LinkedIn proíbem automação/);
  assert.doesNotMatch(app, /Ajustes/);
  const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  assert.match(main, /getTelegramToken/);
  const tg = fs.readFileSync(path.join(ROOT, "server", "telegram.js"), "utf8");
  assert.match(tg, /getUpdates/);
  assert.doesNotMatch(tg, /createServer|listen\(/);
});
