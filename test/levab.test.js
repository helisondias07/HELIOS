"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMemory } = require("../server/memory");
const { createBrain, linksOf, cleanTags } = require("../server/brain");
const { createRoutines, isDue, dispatchEvent, EVENTS, EVENT_COOLDOWN_MS } = require("../server/routines");
const { createStore } = require("../server/store");
const { startServer } = require("../server/index");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-${name}-`));

test("memória enxuta: fechar tira do prompt e guarda no arquivo, reabrir devolve", () => {
  const memory = createMemory(tmp("lean"));
  const { item } = memory.remember({ text: "Pendência: enviar portfólio para a vaga da Oasis", kind: "pendencia" });
  assert.match(memory.context({ text: "portfólio vaga" }).text, /portfólio/);
  assert.equal(memory.close(item.id), true);
  assert.equal(memory.list().length, 0);
  assert.equal(memory.context({ text: "portfólio vaga" }).text, "");
  assert.equal(memory.archived().length, 1);
  assert.equal(memory.archived()[0].status, "fechado");
  assert.ok(fs.existsSync(memory.archiveFile));
  assert.equal(memory.restore(item.id), true);
  assert.equal(memory.list()[0].status, "aberto");
  assert.equal(memory.archived().length, 0);
});

test("memória enxuta: passar do teto arquiva os mais antigos e preserva regras", () => {
  const memory = createMemory(tmp("lean2"));
  memory.remember({ text: "Regra fixa: nunca enviar sem aprovação explícita", kind: "regra" });
  for (let i = 0; i < 6; i += 1) memory.remember({ text: `Fato numero ${i} sobre projeto distinto alfa${i} beta${i} gama${i}` });
  const out = memory.compact({ maxActive: 3 });
  assert.equal(out.moved, 4);
  assert.equal(memory.list().length, 3);
  assert.ok(memory.list().some((item) => item.kind === "regra"));
  assert.ok(memory.archived().every((item) => item.archiveReason === "antigo"));
});

test("Second Brain: cria, busca por palavra e etiqueta, liga notas e recusa segredo", () => {
  const created = [];
  const brain = createBrain(tmp("brain"), { onCreate: (note) => created.push(note.title) });
  const a = brain.add({ title: "Entrevista UX", body: "Preparar cases de design de produto. Ver [[Portfólio]].", tags: "carreira, ux" });
  const b = brain.add({ title: "Portfólio", body: "Link do site e cases principais. Contato: eu@exemplo.com" });
  assert.deepEqual(created, ["Entrevista UX", "Portfólio"]);
  assert.equal(brain.search("cases")[0] !== undefined, true);
  assert.equal(brain.search("entrevista")[0].id, a.id);
  assert.equal(brain.list({ tag: "ux" }).length, 1);
  assert.deepEqual(brain.get(b.id).backlinks.map((x) => x.id), [a.id]);
  assert.match(brain.context({ text: "como montar os cases do portfólio" }).text, /Second Brain/);
  assert.throws(() => brain.add({ title: "chaves", body: "senha: 123456" }), /Cofre/);
  assert.throws(() => brain.add({ title: "token", body: "ghp_abcdefghijklmnopqrstuvwxyz123456" }), /Cofre/);
  assert.equal(brain.update(a.id, { pinned: true }).pinned, true);
  assert.equal(brain.list()[0].id, a.id);
  assert.equal(brain.remove(b.id), true);
  assert.deepEqual(linksOf("[[A b]] e [[Cd]]"), ["A b", "Cd"]);
  assert.deepEqual(cleanTags("#UX, Carreira Nova"), ["ux", "carreira-nova"]);
});

test("rotinas: dias da semana, evento com cooldown, Morning Brief e Monitor", () => {
  const dir = tmp("rot");
  const routines = createRoutines(dir);
  const weekday = routines.add({ title: "Só seg", prompt: "fazer algo", clock: "09:00", weekdays: [1] });
  const monday = new Date(2026, 10, 2, 9, 0).getTime(); // segunda
  const tuesday = new Date(2026, 10, 3, 9, 0).getTime();
  const raw = { ...weekday, enabled: true, createdAt: new Date(2026, 9, 1).toISOString() };
  assert.equal(isDue(raw, monday), true);
  assert.equal(isDue(raw, tuesday), false);
  assert.throws(() => routines.add({ title: "x1", prompt: "abcd", trigger: "evento", event: "inexistente" }), /evento/);
  assert.throws(() => routines.add({ title: "x2", prompt: "abcd", clock: "25:00" }), /inválido/);
  const ev = routines.add({ title: "Pós reunião", prompt: "resuma a reunião", trigger: "evento", event: "reuniao_terminou" });
  assert.equal(ev.trigger, "evento");
  assert.equal(routines.due(Date.now()).some((item) => item.id === ev.id), false);
  const store = createStore(dir);
  const sent = [];
  const send = (id, prompt) => sent.push(prompt);
  const at = Date.now();
  assert.deepEqual(dispatchEvent({ routines, store, send, event: "reuniao_terminou", detail: "durou 20 min", at }).ran, [ev.id]);
  assert.match(sent[0], /Evento: Quando uma reunião termina/);
  assert.deepEqual(dispatchEvent({ routines, store, send, event: "reuniao_terminou", at: at + 1000 }).ran, []);
  assert.deepEqual(dispatchEvent({ routines, store, send, event: "reuniao_terminou", at: at + EVENT_COOLDOWN_MS + 1 }).ran, [ev.id]);
  assert.ok(EVENTS.app_iniciou && EVENTS.nota_criada);
  const brief = routines.installBrief();
  assert.equal(brief.enabled, false);
  assert.equal(brief.readOnly, true);
  assert.deepEqual(brief.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(routines.installBrief().id, brief.id);
  const mon = routines.installMonitor({ target: "vagas de UX remotas", everyMinutes: 5 });
  assert.equal(mon.everyMinutes, 15);
  assert.equal(mon.enabled, false);
  assert.equal(mon.readOnly, true);
  assert.match(mon.prompt, /Sem novidades/);
  assert.match(mon.prompt, /não se inscreva/);
  assert.throws(() => routines.installMonitor({ target: "" }), /vigiar/);
});

test("API da leva B: memória arquivo, Second Brain e rotinas com evento", async () => {
  const server = await startServer({ dataDir: tmp("api"), mock: true, port: 0, routineMs: 0 });
  const headers = { "content-type": "application/json", authorization: `Bearer ${server.apiToken()}`, "x-helios-token": server.apiToken() };
  const call = async (method, url, body) => {
    const res = await fetch(`${server.url}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  try {
    const mem = await call("POST", "/api/memory", { text: "Pendência: revisar currículo em inglês", kind: "pendencia" });
    assert.equal(mem.status, 201);
    assert.equal((await call("POST", `/api/memory/${mem.data.item.id}/fechar`, {})).status, 200);
    assert.equal((await call("GET", "/api/memory/arquivo")).data.items.length, 1);
    assert.equal((await call("GET", "/api/memory")).data.items.length, 0);
    assert.equal((await call("POST", `/api/memory/${mem.data.item.id}/reabrir`, {})).status, 200);
    assert.equal((await call("POST", "/api/memory/enxugar", {})).status, 200);

    const note = await call("POST", "/api/brain", { title: "Ideia de produto", body: "Assistente local de vagas", tags: "ideias" });
    assert.equal(note.status, 201);
    assert.equal((await call("GET", "/api/brain?q=vagas")).data.results[0].id, note.data.note.id);
    assert.equal((await call("POST", "/api/brain", { title: "x", body: "senha: 999999" })).status, 400);

    assert.ok((await call("GET", "/api/routines/eventos")).data.eventos.length >= 3);
    assert.equal((await call("POST", "/api/routines/morning-brief", {})).status, 201);
    assert.equal((await call("POST", "/api/routines/monitor", { target: "vagas de UX" })).status, 201);
    const ev = await call("POST", "/api/routines", { title: "Ao abrir", prompt: "diga bom dia", trigger: "evento", event: "app_iniciou" });
    assert.equal(ev.status, 201);
    assert.equal(ev.data.routine.event, "app_iniciou");
    assert.equal((await call("POST", "/api/routines/evento", { event: "nao_existe" })).status, 400);
  } finally {
    await server.close();
  }
});

test("interface: Second Brain no menu e textos em português", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.match(html, /data-view="brain"/);
  assert.match(app, /Morning Brief/);
  assert.match(app, /Criar Monitor/);
  assert.match(app, /Enxugar agora/);
  assert.match(app, /Reabrir/);
});
