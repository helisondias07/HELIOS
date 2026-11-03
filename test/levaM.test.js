"use strict";
// LEVA M: importador vagas-helison, adaptadores, paradas críticas, ritmo/hora, posts salvos, e-mail.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createJobs } = require("../server/jobs");
const fill = require("../server/jobs-fill");
const { createVagasImport, previewImport, maskCpf, normalizeStatus, OBSOLETE_RULE_RE } = require("../server/vagas-import");
const { createAdaptersRegistry, detectCriticalCommon } = require("../server/vagas-adapters");
const { matchScore, pickCvPath, detectJobLanguage } = require("../server/vagas-match");
const { prepareEmailApply, emailSubject, alreadySentTo } = require("../server/vagas-email-apply");
const { startServer } = require("../server/index");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-levam-${p}-`));
const FIXTURE = path.join(__dirname, "fixtures", "vagas-helison");

test("levaM: importador gera prévia sanitizada sem gravar e mascara CPF", () => {
  const previa = previewImport(FIXTURE);
  assert.ok(previa.id);
  assert.equal(previa.perfil.nome, "Pessoa Exemplo");
  assert.ok(previa.perfil.tituloCurto);
  assert.equal(previa.perfil.ingles, "C1");
  assert.ok(previa.perfil.pretensaoBrlPleno >= 4000);
  assert.ok(Object.keys(previa.respostas).length >= 3);
  assert.ok(previa.filtros.incluir.includes("remoto"));
  assert.ok(previa.regras.some((r) => /primeiro/i.test(r) || /e-mail/i.test(r) || /nunca inventar/i.test(r)));
  assert.ok(!previa.regras.some((r) => OBSOLETE_RULE_RE.test(r)), "regras obsoletas descartadas");
  assert.match(previa.vagasManhaPrompt, /\[vagas-manha\]/);
  assert.ok(previa.templates.length >= 1);
  assert.ok(previa.plataformas.some((p) => p.nome === "LinkedIn" && p.usuario && !p.senha));
  assert.ok(previa.historico.some((h) => h.status === "enviada"));
  assert.ok(previa.historico.some((h) => h.status === "descartada"));
  assert.equal(normalizeStatus("aplicada"), "enviada");
  assert.equal(previa.cpfMascarado, maskCpf("000.000.000-00"));
  assert.match(previa.cpfMascarado, /•••/);
  assert.ok(!JSON.stringify(previa.perfil).includes("000.000.000-00"));
  // CPF só no campo interno da prévia em memória
  assert.equal(previa._cpfVault, "000.000.000-00");
});

test("levaM: aplicar importação grava prefs/histórico/recrutadores e CPF só no cofre", async () => {
  const dataDir = tmp("imp");
  const jobs = createJobs(dataDir, { mock: true, readProfile: () => "React Next" });
  const platforms = [];
  let cpfSaved = "";
  const routinesAdded = [];
  const importer = createVagasImport(dataDir, {
    sourceDir: FIXTURE,
    jobs,
    vaultSaveCpf: async (cpf) => { cpfSaved = String(cpf).replace(/\D/g, ""); },
    vaultSavePlatform: async (p) => { platforms.push(p); return { senhaDefinida: false }; },
    routines: {
      list: () => [],
      add: (r) => { routinesAdded.push(r); return { id: "rot-1", ...r }; },
    },
  });
  const previa = importer.preview(FIXTURE);
  await assert.rejects(() => importer.apply(previa.id, { confirmar: false }), /Confirme/);
  const out = await importer.apply(previa.id, { confirmar: true });
  assert.equal(out.ok, true);
  assert.equal(out.cpfNoCofre, true);
  assert.equal(cpfSaved, "00000000000");
  assert.ok(platforms.length >= 3);
  assert.ok(platforms.every((p) => p.senha === "" || p.senha === undefined));
  const prefs = jobs.prefs();
  assert.equal(prefs.perfil.nome, "Pessoa Exemplo");
  assert.ok(!("cpf" in prefs.perfil) || !prefs.perfil.cpf);
  assert.ok(!("porDia" in prefs));
  assert.ok(jobs.history().length >= 3);
  assert.ok(jobs.recruiters().length >= 2); // Ana deduplicada
  assert.equal(jobs.recruiters().filter((r) => /ana-fixture/i.test(r.profile_url)).length, 1);
  assert.ok(routinesAdded.length >= 1);
  assert.match(JSON.stringify(prefs), /^(?!.*000\.000\.000-00).*$/);
});

test("levaM: adaptadores com interface comum e feed-only honestos", async () => {
  const reg = createAdaptersRegistry({ mock: true });
  const st = reg.status();
  assert.ok(st.find((a) => a.id === "remotar" && a.mode === "api"));
  assert.ok(st.find((a) => a.id === "linkedin"));
  assert.ok(st.find((a) => a.id === "indeed" && a.feedOnly));
  assert.ok(st.every((a) => a.realTested === false), "nesta leva só mock/fixture");
  const remotar = reg.byId.remotar;
  const r = await remotar.search("React");
  assert.equal(r.ok, true);
  assert.ok(r.jobs.length >= 1);
  const gh = await reg.byId["github-frontendbr"].search("frontend");
  assert.equal(gh.ok, true);
  const crit = detectCriticalCommon({ text: "Question 3 of 10 — tempo restante 4:00", captcha: false });
  assert.ok(crit.some((c) => c.tipo === "teste_tempo"));
  assert.ok(detectCriticalCommon({ text: "dedicação exclusiva full-time" }).some((c) => c.tipo === "dedicacao_exclusiva"));
  assert.ok(detectCriticalCommon({ text: "taxa de inscrição via pix" }).some((c) => c.tipo === "pagamento"));
});

test("levaM: paradas críticas novas + CPF do cofre no fill", () => {
  const profile = { nome: "Pessoa Exemplo", email: "e@x.test", telefone: "119", cvPath: "C:\\cv.pdf", cidade: "Cidade Exemplo" };
  const pageTimed = fill.planFill([], profile, {}, { text: "Question 2 of 8 — cronômetro" });
  assert.match(pageTimed.criticos.join(" "), /tempo|prova/i);
  const excl = fill.planFill([], profile, {}, { text: "Exige dedicação exclusiva saindo do emprego atual" });
  assert.match(excl.criticos.join(" "), /exclusiva/i);
  const race = fill.planFill([{ sel: "r", type: "select", label: "Raça/etnia", required: true, options: [{ value: "x", text: "Prefiro não" }] }], profile);
  assert.match(race.criticos.join(" "), /raça\/gênero|perguntar/i);
  const cpfMissing = fill.planFill([{ sel: "c", type: "text", label: "CPF", required: true }], profile, {}, {}, {});
  assert.match(cpfMissing.criticos.join(" "), /CPF ausente|cofre/i);
  const cpfOk = fill.planFill([{ sel: "c", type: "text", label: "CPF", required: true }], profile, {}, {}, { cpf: "000.000.000-00" });
  assert.deepEqual(cpfOk.criticos, []);
  assert.equal(cpfOk.acoes[0].valor, "000.000.000-00");
  const termos = fill.planFill([{ sel: "t", type: "checkbox", label: "Li e concordo com os termos", required: true }], profile);
  assert.match(termos.criticos.join(" "), /Termos/);
  const anexo = fill.planFill([{ sel: "f", type: "file", label: "Diploma", required: true }], profile);
  assert.match(anexo.criticos.join(" "), /além do CV/);
});

test("levaM: ritmo só por hora — sem teto diário", async () => {
  let t = Date.parse("2026-10-31T12:00:00Z");
  const jobs = createJobs(tmp("rate"), { mock: true, now: () => t, readProfile: () => "React front-end" });
  jobs.setPrefs({ termos: "desenvolvedor front-end", porHora: 2, porDia: 1, notaMinima: 40, modo: "automatico" });
  assert.ok(!("porDia" in jobs.prefs()));
  await jobs.search();
  const q1 = jobs.autoQueue();
  assert.ok(q1.length >= 1);
  const a = jobs.autoStart(q1[0].id);
  jobs.autoResult(a.id, { ok: true });
  const q2 = jobs.autoQueue();
  if (q2[0]) {
    jobs.autoStart(q2[0].id);
    jobs.autoResult(q2[0].id, { ok: true });
  }
  assert.equal(jobs.rateLeft(), 0);
  // Mesmo “dia”: sem teto diário — após 1h libera de novo
  t += 3600e3 + 1;
  assert.ok(jobs.rateLeft() >= 1);
});

test("levaM: dedupe de posts salvos e recrutadores", () => {
  const jobs = createJobs(tmp("dedupe"), { mock: true, readProfile: () => "React vaga remoto" });
  const r1 = jobs.ingestSavedPosts([
    { id: "s1", texto: "Estamos contratando desenvolvedor React remoto", url: "https://linkedin.com/posts/1", autor: "RH" },
    { id: "s1", texto: "duplicado", url: "https://linkedin.com/posts/1", autor: "RH" },
    { id: "s2", texto: "Feliz aniversário time", url: "https://linkedin.com/posts/2", autor: "X" },
  ]);
  assert.equal(r1.novos, 1);
  const r2 = jobs.ingestSavedPosts([{ id: "s1", texto: "de novo", url: "https://linkedin.com/posts/1" }]);
  assert.equal(r2.novos, 0);
  jobs.importRecruiters([
    { name: "A", profile_url: "https://linkedin.com/in/a" },
    { name: "A", profile_url: "https://linkedin.com/in/a" },
    { name: "B", profile_url: "https://linkedin.com/in/b" },
  ]);
  assert.equal(jobs.recruiters().length, 2);
});

test("levaM: regra do e-mail — assunto, primeiro só, checa Enviados", async () => {
  assert.equal(emailSubject("Frontend React"), "Frontend React | Helison Dias");
  assert.equal(alreadySentTo([{ to: "jobs@acme.test" }], "jobs@acme.test"), true);
  const dup = await prepareEmailApply({
    cargo: "Frontend",
    to: "jobs@acme.test",
    cvPath: "C:\\cv.pdf",
    listSent: async () => [{ to: "jobs@acme.test", subject: "x" }],
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.duplicado, true);
  const ok = await prepareEmailApply({
    cargo: "Frontend",
    to: "novo@acme.test",
    cvPath: "C:\\cv.pdf",
    listSent: async () => [],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.precisaAprovacao, true);
  assert.match(ok.draft.subject, /Frontend \| Helison Dias/);
  assert.match(ok.acaoExata, /novo@acme\.test/);
});

test("levaM: match + idioma do CV", async () => {
  const perfil = { cvPathPt: "C:\\cv-pt.pdf", cvPathEn: "C:\\cv-en.pdf", cvPath: "C:\\cv-pt.pdf" };
  assert.equal(detectJobLanguage({ title: "Software Engineer", description: "We are looking for a developer with experience and remote work for the team" }), "en");
  assert.equal(pickCvPath(perfil, { title: "Software Engineer", description: "the developer role with years of experience requirements" }).lang, "en");
  assert.equal(pickCvPath(perfil, { title: "Desenvolvedor Frontend", description: "vaga remoto requisitos experiência" }).cvPath, "C:\\cv-pt.pdf");
  const scored = await matchScore(
    { title: "Desenvolvedor Frontend React", company: "X", location: "Remoto", description: "React Next TypeScript" },
    { prefs: { termos: ["desenvolvedor front-end"], incluir: ["react"], excluir: [], notaMinima: 40 }, profileText: "React Next.js", perfil, scorer: async () => ({ score: 90, motivos: ["modelo"] }) },
  );
  assert.ok(scored.score >= 40);
  assert.ok(scored.model);
  assert.equal(scored.cv.lang, "pt");
});

test("levaM: API importar/adaptadores/posts-salvos/email e UI", async () => {
  const dataDir = tmp("api");
  const platforms = [];
  const server = await startServer({
    dataDir,
    mock: true,
    port: 0,
    routineMs: 0,
    seedAssistants: false,
    vagasSourceDir: FIXTURE,
    vaultSaveCpf: async () => ({ ok: true }),
    vaultSavePlatform: async (p) => { platforms.push(p); return { senhaDefinida: false }; },
  });
  const call = async (method, p, body) => {
    const res = await fetch(`${server.url}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${server.apiToken()}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const prev = await call("POST", "/api/vagas/importar/previa", {});
    assert.equal(prev.status, 200);
    assert.ok(prev.body.previa.cpfMascarado);
    assert.ok(!JSON.stringify(prev.body.previa.perfil).includes("000.000.000-00"));
    assert.ok(!prev.body.previa._cpfVault);
    const apl = await call("POST", "/api/vagas/importar/aplicar", { previaId: prev.body.previa.id, confirmar: true });
    assert.equal(apl.status, 200);
    assert.ok(platforms.length >= 1);

    const ad = await call("GET", "/api/vagas/adaptadores");
    assert.ok(ad.body.adaptadores.length >= 10);

    const saved = await call("POST", "/api/vagas/posts-salvos", {
      posts: [{ id: "p1", texto: "Vaga para desenvolvedor React remoto", url: "https://linkedin.com/posts/x" }],
    });
    assert.equal(saved.body.novos, 1);

    const mail = await call("POST", "/api/vagas/email/preparar", {
      cargo: "Frontend",
      to: "rh@exemplo.invalid",
      cvPath: "C:\\cv.pdf",
      enviados: [],
    });
    assert.equal(mail.status, 200);
    assert.equal(mail.body.precisaAprovacao, true);

    const scan = await call("POST", "/api/routines/vagas-scan-30", {});
    assert.equal(scan.status, 201);
    assert.equal(scan.body.routine.enabled, false);

    const list = await call("GET", "/api/vagas");
    assert.ok(!("porDia" in list.body.prefs));
    assert.ok(Array.isArray(list.body.adaptadores));

    const ui = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert.match(ui, /vgImportar|Importar vagas-helison/);
    assert.match(ui, /vgAdaptadores|Adaptadores/);
    assert.match(ui, /vgImportPrevia|Prévia da importação/);
    assert.match(ui, /Sem teto diário/);
    assert.match(ui, /vgCriticaCard|Caso crítico/);
    assert.doesNotMatch(ui, /name="porDia"/);
  } finally {
    await server.close();
  }
});
