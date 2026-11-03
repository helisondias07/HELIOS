"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJobs, parseLinkedin, parseGupy, scoreJob, PLATFORMS } = require("../server/jobs");
const { detectChallenge, findLoginFor, fillScript } = require("../src/jobs-host");
const wrap = require("../src/meeting-wrapup");
const { startServer } = require("../server/index");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-${name}-`));
const ROOT = path.join(__dirname, "..");

test("fase 6: fechamento separa resumo, pendências e follow-up e vira nota marcada como rascunho", () => {
  const parsed = wrap.parseWrapup(wrap.mockWrapupText());
  assert.equal(parsed.pendencias.length, 2);
  assert.match(parsed.followup, /Obrigado/);
  const note = wrap.noteFromWrapup(parsed, { at: new Date(2026, 9, 30, 14, 5), meetingContext: "Vaga UX na Acme" });
  assert.equal(note.title, "Reunião 30/10/2026 14:05");
  assert.match(note.body, /NÃO enviado/);
  assert.match(note.body, /Vaga UX na Acme/);
  assert.deepEqual(note.tags, ["reuniao"]);
  const msgs = wrap.wrapupPrompt([{ who: "me", text: "oi" }, { who: "them", text: "hello" }], { meetingContext: "vaga X" });
  assert.match(msgs[0].content, /português/);
  assert.match(msgs[0].content, /vaga X/);
  assert.match(msgs[1].content, /Você: oi/);
  assert.match(msgs[1].content, /Outro\(s\): hello/);
  assert.ok(wrap.fullTranscript(Array.from({ length: 2000 }, () => ({ who: "me", text: "palavra repetida" }))).length <= wrap.MAX_TRANSCRIPT + 30);
});

test("fase 6: botão Encerrar existe e as duas abas continuam", () => {
  const html = fs.readFileSync(path.join(ROOT, "renderer", "meeting", "index.html"), "utf8");
  const host = fs.readFileSync(path.join(ROOT, "src", "meeting-host.js"), "utf8");
  // Leva H: "Encerrar" na pílula roda o fechamento; chips separados por modo
  assert.match(html, /id="btnEnd"/);
  assert.match(html, /id="chipSay" class="chip only-pt"/);
  assert.match(html, /id="chipSug" class="chip only-en"/);
  assert.match(host, /"meeting:wrapup"/);
  assert.match(host, /reuniao_terminou/);
  assert.doesNotMatch(host.slice(host.indexOf("meeting:wrapup"), host.indexOf("meeting:wrapup") + 2500), /sendMail|send_email|enviar_email/);
});

test("fase 7: parsers de LinkedIn e Gupy", () => {
  const li = `<ul><li><div data-entity-urn="urn:li:jobPosting:123"><a class="base-card__full-link x" href="https://br.linkedin.com/jobs/view/dev-front-123?refId=a&amp;b=1"><span class="sr-only">Dev Front-end</span></a>
    <h3 class="base-search-card__title">Desenvolvedor Front-end</h3><h4 class="base-search-card__subtitle"><a>Acme</a></h4><span class="job-search-card__location">Remoto</span><time class="x" datetime="2026-10-29"></time></div></li></ul>`;
  const [a] = parseLinkedin(li);
  assert.equal(a.extId, "123");
  assert.equal(a.title, "Desenvolvedor Front-end");
  assert.equal(a.company, "Acme");
  assert.equal(a.url, "https://br.linkedin.com/jobs/view/dev-front-123");
  const next = { props: { pageProps: { initialJobList: { data: [{ id: 9, name: "UI/UX Designer", careerPageName: "Eldorado", city: "Manaus", state: "AM", workplaceType: "on-site", jobUrl: "https://x.gupy.io/job/abc", description: "<p>Figma &amp; React</p>" }] } } } };
  const [g] = parseGupy(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`);
  assert.equal(g.title, "UI/UX Designer");
  assert.equal(g.description, "Figma & React");
  assert.deepEqual(parseGupy("<html></html>"), []);
  assert.ok(PLATFORMS.linkedin.searchUrl("ux", "Brasil").startsWith("https://www.linkedin.com/"));
});

test("fase 7: nota pelo perfil e palavra excluída zera", () => {
  const prefs = { termos: ["desenvolvedor front-end"], incluir: ["remoto"], excluir: ["estágio"] };
  const job = { title: "Desenvolvedor Front-end Pleno", company: "Acme", location: "Remoto", description: "React e e-commerce" };
  const good = scoreJob(job, { profileText: "Desenvolvedor front-end com React e e-commerce", prefs });
  assert.ok(good.score >= 70, String(good.score));
  assert.equal(scoreJob({ ...job, title: "Estágio em front-end" }, { prefs }).score, 0);
});

test("fase 7: cartão obrigatório, limite de ritmo e registro", async () => {
  let t = Date.parse("2026-10-30T12:00:00Z");
  const jobs = createJobs(tmp("vagas"), { mock: true, now: () => t, readProfile: () => "Desenvolvedor front-end React" });
  jobs.setPrefs({ termos: "desenvolvedor front-end", porHora: 1, porDia: 2, notaMinima: 40 });
  const out = await jobs.search();
  assert.ok(out.novas >= 1);
  const [first, second] = jobs.list({ status: "nova" });
  assert.throws(() => jobs.approve(first.id), /não está esperando/);
  const prepared = jobs.prepare(first.id);
  assert.equal(prepared.status, "aguardando_aprovacao");
  assert.match(prepared.carta, /Helison/);
  assert.equal(jobs.approve(first.id, { carta: "minha carta" }).status, "aprovada");
  jobs.prepare(second.id);
  assert.throws(() => jobs.approve(second.id), /por hora/);
  t += 3601e3;
  jobs.approve(second.id);
  assert.equal(jobs.markResult(first.id, { ok: true }).status, "enviada");
  const hist = jobs.history().map((h) => h.status);
  assert.deepEqual(hist.slice(0, 4), ["enviada", "aprovada", "preparada", "aprovada"]);
  assert.ok(fs.existsSync(jobs.logFile));
});

test("fase 7: login acha a entrada do cofre, detecta 2FA/captcha e não expõe a senha no servidor", () => {
  const entries = [{ nome: "Banco", url: "https://banco.com" }, { nome: "Meu LI", url: "https://www.linkedin.com/login", usuario: "u", senha: "s" }, { nome: "Gupy pessoal", url: "" }];
  assert.equal(findLoginFor(PLATFORMS.linkedin, entries).nome, "Meu LI");
  assert.equal(findLoginFor(PLATFORMS.gupy, entries).nome, "Gupy pessoal");
  assert.match(detectChallenge("https://www.linkedin.com/checkpoint/challenge/x"), /2FA|captcha/);
  assert.match(detectChallenge("https://x.com/", { captcha: true }), /captcha/);
  assert.equal(detectChallenge("https://www.linkedin.com/feed/", {}), "");
  assert.match(fillScript('a"b', "p'q"), /"a\\"b"/);
  const server = fs.readFileSync(path.join(ROOT, "server", "jobs.js"), "utf8");
  assert.doesNotMatch(server, /getLogin|vault-store|\.senha/);
});

test("fase 7: API exige confirmação no cartão para aprovar", async () => {
  const server = await startServer({ dataDir: tmp("vagas-api"), mock: true, port: 0, routineMs: 0 });
  const headers = { "content-type": "application/json", authorization: `Bearer ${server.apiToken()}` };
  const call = async (method, url, body) => {
    const res = await fetch(`${server.url}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  try {
    assert.equal((await call("POST", "/api/vagas/preferencias", { termos: "desenvolvedor front-end" })).status, 200);
    assert.ok((await call("POST", "/api/vagas/buscar", {})).data.novas >= 1);
    const list = (await call("GET", "/api/vagas")).data;
    assert.equal(list.plataformas.length, 2);
    const id = list.vagas.find((v) => v.status === "nova").id;
    assert.equal((await call("POST", `/api/vagas/${id}/preparar`, {})).status, 200);
    assert.equal((await call("POST", `/api/vagas/${id}/aprovar`, {})).status, 400);
    assert.equal((await call("POST", `/api/vagas/${id}/aprovar`, { confirmar: true })).data.vaga.status, "aprovada");
    assert.equal((await call("GET", `/api/vagas/${id}`)).data.vaga.status, "aprovada");
  } finally {
    await server.close();
  }
});

test("interface: aba Vagas em português", () => {
  const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.match(html, /data-view="vagas"/);
  assert.match(app, /Na fila do automático/);
  assert.match(app, /Esperando sua aprovação/);
  assert.match(app, /hx-insc/);
  assert.match(app, /<th>Empresa<\/th><th>Cargo<\/th><th>Plataforma<\/th><th>Data<\/th><th>Status<\/th>/);
  assert.match(app, /loadAgentChat\("pesquisa"\)/);
  assert.match(app, /loadAgentChat\("oasis"\)/);
  assert.match(app, /loadAgentChat\("portfolio"\)/);
  assert.match(app, /loadVagasPainel/);
});
