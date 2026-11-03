"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { simulate, step, SNAPSHOT_SCRIPT, nuncaMensagemRecrutador } = require("../server/form-navigator");
const regras = require("../server/vagas-regras");
const visual = require("../server/vagas-visual");
const { createJobs } = require("../server/jobs");
const { createAdaptersRegistry } = require("../server/vagas-adapters");
const { createAgentVagas } = require("../server/agent-vagas");
const { createQuadro } = require("../server/quadro");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-${name}-`));
const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "formularios", name), "utf8"));
const PROFILE = {
  nome: "Pessoa Exemplo",
  email: "pessoa@exemplo.test",
  telefone: "22000000000",
  cidade: "Nova Friburgo",
  estado: "Rio de Janeiro",
  cvPath: "C:\\cv.pdf",
  pretensaoBrlJunior: 3500,
  pretensaoBrlPleno: 8000,
};
const VAGA_PLENO = { title: "Desenvolvedor Front-end Pleno", company: "Empresa Fixture", location: "Remoto", description: "React remoto" };
const CTX = { profile: PROFILE, vaga: VAGA_PLENO, enviar: true };

test("levaV6: Gupy preenche, avança no Continuar do modal e só confirma com o texto do site", () => {
  const run = simulate(load("gupy-continuar.json"), CTX);
  assert.equal(run.final.kind, "submitted");
  assert.match(run.final.confirmacao, /candidatura/i);
  assert.equal(run.trace.filter((item) => item.confirmacao).length, 1);
  assert.equal(run.trace.at(-1).kind, "submitted");
  assert.ok(run.trace.some((item) => item.sel === "[data-helios-btn=next]"));
  assert.ok(run.trace.every((item) => item.sel !== "[data-helios-btn=side]"));
  const salaryPage = load("gupy-continuar.json")[2];
  const filled = step(salaryPage, { ...CTX, memory: { filled: {} } });
  assert.ok(filled.fills.some((action) => action.kind === "combobox" || action.valor === "R$ 8.000" || action.kind === "file" || action.valor === "R$ 8.000"));
  assert.ok(filled.fills.some((action) => action.valor === "R$ 8.000"));
  assert.equal(run.final.kind === "submitted" && run.trace.some((item) => item.kind === "act" && item.intent === "submit"), true);
});

test("levaV6: LinkedIn Easy Apply percorre o modal e não manda mensagem", () => {
  const run = simulate(load("linkedin-easy-apply.json"), CTX);
  assert.equal(run.final.kind, "submitted");
  assert.match(run.final.confirmacao, /candidatura enviada/i);
  assert.ok(run.trace.some((item) => item.intent === "apply"));
  assert.ok(run.trace.some((item) => item.intent === "review"));
  assert.ok(run.trace.some((item) => item.intent === "submit"));
  assert.ok(run.trace.every((item) => item.sel !== "[data-helios-btn=msg]"));
  assert.equal(nuncaMensagemRecrutador().ok, false);
});

test("levaV6: ATS externo aberto pelo LinkedIn preenche e confirma", () => {
  const run = simulate(load("ats-externo.json"), { ...CTX, vaga: { title: "Full Stack Node", location: "Remoto", description: "Node remoto" } });
  assert.equal(run.final.kind, "submitted");
  assert.match(run.final.confirmacao, /thank you/i);
  assert.ok(run.trace.some((item) => item.intent === "apply"));
  assert.ok(run.trace.some((item) => item.fills > 0));
});

test("levaV6: CAPTCHA pausa sem clique e sem enviada", () => {
  const run = simulate(load("captcha.json"), CTX);
  assert.equal(run.final.kind, "pause");
  assert.equal(run.final.codigo, "captcha");
  assert.equal(run.trace.length, 1);
  assert.ok(run.trace.every((item) => !item.sel && !item.intent));
  assert.equal(run.final.confirmacao || "", "");
});

test("levaV6: botões iguais pausam por ambiguidade", () => {
  const run = simulate(load("ambiguidade.json"), CTX);
  assert.equal(run.final.kind, "pause");
  assert.equal(run.final.codigo, "ambiguidade");
  assert.ok(run.trace.every((item) => !item.sel));
});

test("levaV6: clique em enviar sem confirmação do site não vira enviada", () => {
  const run = simulate(load("sem-confirmacao.json"), CTX);
  assert.notEqual(run.final.kind, "submitted");
  assert.equal(run.final.codigo, "validacao");
  assert.ok(run.trace.some((item) => item.intent === "submit"));
  assert.ok(!run.trace.some((item) => item.kind === "submitted"));
});

test("levaV6: botão Gupy sem rótulo entra pelo data-testid e o snapshot lê shadow e iframe", () => {
  const decision = step({
    url: "https://empresa.gupy.io/job/abc/apply",
    modal: true,
    fields: [],
    buttons: [{ sel: "[data-helios-btn=go]", text: "", testId: "continue-button", tag: "button", visible: true, inForm: true, inModal: true }],
  }, CTX);
  assert.equal(decision.kind, "act");
  assert.equal(decision.click.intent, "next");
  assert.match(SNAPSHOT_SCRIPT, /shadowRoot/);
  assert.match(SNAPSHOT_SCRIPT, /contentDocument/);
  assert.equal(regras.pretensao({ title: "Dev Front Jr" }, PROFILE), "R$ 3.500");
  assert.equal(regras.pretensao({ title: "Full Stack Pleno" }, PROFILE), "R$ 8.000");
});

test("levaV6: regras do dono descartam o que não é a vaga e reconhecem empresa parecida", () => {
  const base = { title: "Desenvolvedor React Pleno", location: "Remoto", description: "React TypeScript remoto" };
  assert.equal(regras.avaliarVaga(base).aceita, true);
  assert.equal(regras.avaliarVaga({ ...base, company: "Quality Digital" }).aceita, false);
  assert.equal(regras.empresaEvitada("Quality Digitall"), true);
  assert.equal(regras.empresaEvitada("Micro Um Tecnologia"), true);
  assert.equal(regras.empresaEvitada("Baires Dev"), true);
  assert.equal(regras.empresaEvitada("Lovelace Studio"), false);
  assert.equal(regras.avaliarVaga({ ...base, title: "Desenvolvedor Java Pleno", description: "Java remoto" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Diferencial: Angular" }).aceita, true);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Vaga exclusiva para PcD" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Pessoas com deficiência são bem-vindas" }).aceita, true);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Vaga afirmativa para mulheres" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, location: "Híbrido em São Paulo", description: "React híbrido" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, title: "Desenvolvedor React Sênior" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Inglês fluente obrigatório" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Inglês intermediário" }).aceita, true);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Ensino superior completo obrigatório" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Desejável graduação completa" }).aceita, true);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Obrigatório conhecimento em Docker e Kubernetes" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Diferencial: AWS" }).aceita, true);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Envie um vídeo de apresentação no Loom" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, description: "React remoto. Teste cronometrado no HackerRank" }).aceita, false);
  assert.equal(regras.avaliarVaga({ title: "Analista de marketing", location: "Remoto", description: "vendas" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, title: "Desenvolvedor PHP Pleno", description: "PHP remoto" }).aceita, false);
  assert.equal(regras.avaliarVaga({ ...base, title: "Desenvolvedor .NET Pleno", description: ".NET remoto" }).aceita, false);
});

test("levaV6: fila automática aplica a regra e não marca enviada sem confirmação", async () => {
  const jobs = createJobs(tmp("regras"), { mock: true, now: () => Date.parse("2026-11-03T15:00:00Z"), readProfile: () => "React front-end TypeScript" });
  jobs.setPrefs({ modo: "automatico", notaMinima: 10, termos: "desenvolvedor front-end" });
  jobs.ingestParsedJobs([
    { extId: "ok", title: "Desenvolvedor React Pleno", company: "Empresa Boa", location: "Remoto", url: "https://exemplo.invalid/ok", description: "React remoto" },
    { extId: "qd", title: "Desenvolvedor React Pleno", company: "Quality Digital", location: "Remoto", url: "https://exemplo.invalid/qd", description: "React remoto" },
  ], { platform: "gupy" });
  assert.equal(jobs.get(jobs.list().find((item) => item.extId === "qd").id).status, "descartada");
  const queue = jobs.autoQueue();
  assert.ok(queue.every((item) => item.company !== "Quality Digital"));
  assert.ok(queue.some((item) => item.company === "Empresa Boa"));
  const started = jobs.autoStart(queue.find((item) => item.company === "Empresa Boa").id);
  const blocked = jobs.autoResult(started.id, { ok: true });
  assert.equal(blocked.status, "falhou");
  assert.match(blocked.nota, /confirmação/);
});

test("levaV6: importação passada entra como enviada e segura repetirDias", () => {
  const rows = require("./fixtures/candidaturas-importadas.json");
  assert.equal(rows.length, 16);
  const jobs = createJobs(tmp("import"), { mock: true, now: () => Date.parse("2026-11-03T12:00:00Z"), readProfile: () => "React front-end" });
  jobs.setPrefs({ modo: "automatico", notaMinima: 10, repetirDias: 30 });
  const first = jobs.importHistory(rows);
  assert.equal(first.importados, 16);
  assert.equal(jobs.importHistory(rows).importados, 0);
  const history = jobs.history(30);
  assert.ok(history.every((item) => item.fonte === "importado" && item.status === "enviada"));
  assert.ok(history.some((item) => item.at.startsWith("2026-10-20") && item.empresa === "Port Louis"));
  assert.ok(history.some((item) => item.empresa === "Serendipe" && item.plataforma === "email"));
  jobs.ingestParsedJobs([
    { extId: "jg", title: "Dev Front Pleno", company: "Jungle Gaming", location: "Remoto", url: "https://www.linkedin.com/jobs/view/999", description: "React remoto" },
    { extId: "same", title: "Outra vaga", company: "Outra Empresa", location: "Remoto", url: "https://www.linkedin.com/jobs/view/4481221345", description: "React remoto" },
    { extId: "nova", title: "Dev Front Pleno", company: "Empresa Nova", location: "Remoto", url: "https://exemplo.invalid/nova", description: "React remoto" },
  ], { platform: "linkedin" });
  const queue = jobs.autoQueue();
  assert.ok(queue.every((item) => item.company !== "Jungle Gaming"));
  assert.ok(queue.every((item) => !String(item.url).includes("4481221345")));
  assert.ok(queue.some((item) => item.company === "Empresa Nova"));
});

test("levaV6: Remotar 404 não derruba os outros adaptadores e a busca visual tem as plataformas", async () => {
  const reg = createAdaptersRegistry({
    mock: false,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("remotar.com.br")) return { ok: false, status: 404, json: async () => ({}) };
      if (href.includes("api.github.com")) {
        return { ok: true, status: 200, json: async () => ({ items: [{ number: 7, title: "[Remoto] React pleno", html_url: "https://github.com/frontendbr/vagas/issues/7", body: "React", created_at: "2026-11-01" }] }) };
      }
      throw new Error("rede");
    },
  });
  const out = await reg.searchAll("react");
  assert.equal(out.ok, true);
  assert.ok(out.jobs.some((job) => String(job.platform).startsWith("github")));
  assert.ok(!out.erros.some((item) => /Remotar/.test(item)));
  const broken = createAdaptersRegistry({ mock: true });
  broken.byId.remotar.search = async () => { throw new Error("boom"); };
  const isolated = await broken.searchAll("react");
  assert.equal(isolated.ok, true);
  assert.ok(isolated.jobs.length >= 1);
  assert.ok(isolated.erros.some((item) => /Remotar/.test(item) && /boom/.test(item)));
  const ids = visual.catalog().map((item) => item.id);
  for (const id of ["linkedin", "gupy", "infojobs", "indeed", "glassdoor", "catho", "coodesh", "geekhunter", "programathor", "trampos", "nerdin", "bossabox", "remotar"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(visual.termsFor("infojobs", ["a", "b", "c"]).length, 1);
  assert.equal(visual.termsFor("linkedin", ["a", "b", "c", "d"]).length, 3);
});

test("levaV6: jobs-tracker lê vagas salvas e a aba Salvos", async () => {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", "linkedin", "jobs-tracker.html"), "utf8");
  const parsed = visual.parseSavedJobsPage(html);
  assert.equal(parsed.redirected, true);
  assert.equal(parsed.needsTab, true);
  assert.deepEqual(parsed.jobs.map((job) => job.extId), ["4481442041", "4481434436"]);
  const dir = tmp("tracker");
  const jobs = createJobs(dir, { mock: true, readProfile: () => "React front-end remoto" });
  const agent = createAgentVagas(dir, { jobs, quadro: createQuadro(dir), now: () => Date.parse("2026-11-03T12:00:00Z"), readProfile: () => "React front-end remoto" });
  const ingested = await agent.ingestHtml({ tipo: "salvos-vagas", html });
  assert.equal(ingested.ok, true);
  assert.ok(jobs.list().some((item) => item.extId === "4481442041"));
  assert.match(visual.SAVED_TAB_SCRIPT, /jobs-tracker/);
  assert.match(visual.SAVED_TAB_SCRIPT, /Salvos|saved jobs/);
});
