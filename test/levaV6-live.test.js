"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runApplication } = require("../src/jobs-host");
const { planFill } = require("../server/jobs-fill");
const { messagesFor } = require("../server/form-vision");
const { canonicalJobUrl } = require("../server/vagas-visual");
const { createJobs } = require("../server/jobs");
const { createAgentVagas } = require("../server/agent-vagas");
const { createQuadro } = require("../server/quadro");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-${name}-`));
const gupy = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "formularios", "gupy-continuar.json"), "utf8"));
const PROFILE = {
  nome: "Pessoa Exemplo",
  email: "pessoa@exemplo.test",
  telefone: "22000000000",
  cidade: "Nova Friburgo",
  estado: "Rio de Janeiro",
  cvPath: "C:\\cv.pdf",
};
const VAGA = { title: "Desenvolvedor Front-end Pleno", company: "Empresa Fixture", location: "Remoto", url: "https://empresa.gupy.io/job/abc", description: "React remoto" };

function scripted(pages, { llm = null } = {}) {
  let cursor = 0;
  const clicks = [];
  const io = {
    load: async (url) => ({ ok: true, url }),
    snapshot: async () => pages[Math.min(cursor, pages.length - 1)],
    click: async (sel) => { clicks.push(sel); cursor += 1; return "clicado"; },
    apply: async () => 1,
    sleep: async () => {},
    screenshot: async () => "data:image/jpeg;base64,QQ==",
  };
  return { io, clicks, run: () => runApplication({ vaga: VAGA, profile: PROFILE, enviar: true, llm, io }) };
}

test("levaV6 live: o mesmo runApplication do jobs-host preenche a Gupy e só confirma com o site", async () => {
  const host = fs.readFileSync(path.join(__dirname, "..", "src", "jobs-host.js"), "utf8");
  assert.match(host, /return runApplication\(/);
  const flow = scripted(gupy);
  const result = await flow.run();
  assert.equal(result.ok, true);
  assert.equal(result.enviado, true);
  assert.match(result.confirmacao, /candidatura/i);
  assert.ok(flow.clicks.includes("[data-helios-btn=next]"));
  assert.ok(result.evidencia.some((item) => item.kind === "snapshot" && /botoes/.test(item.detail)));
  assert.equal(result.evidencia.some((item) => /pessoa@exemplo\.test/.test(item.detail)), false);
});

test("levaV6 live: sem botão conhecido a visão clica e a falha guarda url e botões", async () => {
  const seen = [];
  const llm = {
    async chat({ messages }) {
      const blob = JSON.stringify(messages);
      seen.push(blob);
      assert.equal(blob.includes("pessoa@exemplo.test"), false);
      assert.equal(blob.includes("22000000000"), false);
      return { message: { content: "{\"acao\":\"clicar\",\"alvo\":\"Inscrever-me nesta vaga\",\"motivo\":\"único avanço\"}" }, model: "modelo-teste" };
    },
  };
  const pages = [
    {
      url: "https://ats.example/vaga/1",
      text: "Formulário pessoa@exemplo.test",
      fields: [],
      buttons: [{ sel: "#go", text: "Inscrever-me nesta vaga", tag: "button", visible: true, inForm: true }],
    },
    { url: "https://ats.example/vaga/1/ok", text: "Candidatura enviada", fields: [], buttons: [] },
  ];
  const flow = scripted(pages, { llm });
  const result = await flow.run();
  assert.equal(result.enviado, true);
  assert.equal(result.via, "visao");
  assert.equal(result.model, "modelo-teste");
  assert.deepEqual(flow.clicks, ["#go"]);
  assert.ok(seen.length >= 1);

  const blind = scripted([{ url: "https://ats.example/vazia", text: "página em branco", fields: [], buttons: [{ sel: "#x", text: "Saiba mais", tag: "a", visible: true }] }]);
  const failed = await blind.run();
  assert.equal(failed.ok, undefined);
  assert.equal(failed.classe, "tecnico");
  assert.match(failed.critico, /próximo botão/);
  const snap = failed.evidencia.find((item) => item.kind === "snapshot");
  const body = JSON.parse(snap.detail);
  assert.equal(body.url, "https://ats.example/vazia");
  assert.ok(body.botoes.includes("Saiba mais"));
});

test("levaV6 live: captcha e login param para o dono; rede é falha técnica", async () => {
  const captcha = scripted([{ url: "https://empresa.gupy.io/job/abc", captcha: true, text: "não sou um robô", fields: [], buttons: [{ sel: "#c", text: "Continuar", tag: "button", visible: true, inForm: true, inModal: true }] }]);
  const cap = await captcha.run();
  assert.equal(cap.classe, "humano");
  assert.equal(cap.codigo, "captcha");
  assert.equal(captcha.clicks.length, 0);

  const login = scripted([{ url: "https://br.indeed.com/account/login", text: "Faça login para se candidatar", fields: [], buttons: [] }]);
  const wall = await login.run();
  assert.equal(wall.classe, "humano");
  assert.equal(wall.codigo, "login");

  const io = {
    calls: 0,
    load: async () => {
      io.calls += 1;
      return { ok: false, error: io.calls === 1 ? "ERR_NAME_NOT_RESOLVED" : "ERR_ABORTED" };
    },
    snapshot: async () => ({}),
    click: async () => "",
    apply: async () => 0,
    sleep: async () => {},
  };
  const net = await runApplication({ vaga: VAGA, profile: PROFILE, io });
  assert.equal(net.classe, "tecnico");
  assert.equal(net.codigo, "rede");
  assert.match(net.critico, /ERR_/);
  assert.equal(io.calls, 2);
});

test("levaV6 live: Nome * usa o perfil e o anúncio do Indeed vira a vaga", () => {
  const plan = planFill([{ sel: "#nome", type: "text", label: "Nome *", required: true }], PROFILE, {}, { text: "" });
  assert.deepEqual(plan.criticos, []);
  assert.equal(plan.acoes[0].valor, "Pessoa Exemplo");
  const page = messagesFor({ url: "https://ats.example/1", text: "contato pessoa@exemplo.test", fields: [{ label: "Nome *", type: "text" }], buttons: ["Continuar"] }, [PROFILE.email, PROFILE.telefone]);
  assert.equal(JSON.stringify(page).includes("pessoa@exemplo.test"), false);
  assert.equal(canonicalJobUrl("https://br.indeed.com/pagead/clk?jk=abc123&from=serp"), "https://br.indeed.com/viewjob?jk=abc123");
  assert.equal(canonicalJobUrl("https://br.indeed.com/pagead/clk?ad=1"), "");
});

test("levaV6 live: a fila antiga perde Quality Digital e BairesDev, e botão vira falha técnica", () => {
  const dir = tmp("fila");
  fs.writeFileSync(path.join(dir, "vagas.json"), JSON.stringify({
    version: 1,
    prefs: { termos: ["desenvolvedor front-end"], modo: "automatico", notaMinima: 10, plataformas: ["gupy"] },
    vagas: [
      { id: "vaga_qd", platform: "gupy", extId: "1", title: "Dev React Pleno", company: "Quality Digital", location: "Remoto", url: "https://exemplo.invalid/qd", description: "React remoto", score: 80, status: "nova", motivos: [] },
      { id: "vaga_bd", platform: "linkedin", extId: "2", title: "Dev React Pleno", company: "BairesDev", location: "Remoto", url: "https://exemplo.invalid/bd", description: "React remoto", score: 80, status: "nova", motivos: [] },
      { id: "vaga_ok", platform: "gupy", extId: "3", title: "Dev React Pleno", company: "Empresa Boa", location: "Remoto", url: "https://exemplo.invalid/ok", description: "React remoto", score: 90, status: "nova", motivos: [] },
      { id: "vaga_btn", platform: "gupy", extId: "4", title: "Dev React Pleno", company: "Empresa Boa", location: "Remoto", url: "https://exemplo.invalid/btn", description: "React remoto", score: 90, status: "critica", motivos: [], critico: { motivo: "Não achei o próximo botão do formulário com segurança.", codigo: "botao", classe: "tecnico" } },
    ],
  }));
  const jobs = createJobs(dir, { readProfile: () => "React front-end remoto" });
  const out = jobs.revisarFila();
  assert.ok(out.descartadas >= 2);
  assert.equal(out.tecnicas, 1);
  assert.equal(jobs.get("vaga_qd").status, "descartada");
  assert.equal(jobs.get("vaga_bd").status, "descartada");
  assert.equal(jobs.get("vaga_ok").status, "nova");
  assert.equal(jobs.get("vaga_btn").status, "falhou");
  assert.equal(jobs.autoQueue().some((item) => /quality|baires/i.test(item.company)), false);
  assert.match(jobs.digest(), /Esperando sua resposta: 0|Falhas técnicas/);
  assert.equal(/Esperando sua resposta: [1-9]/.test(jobs.digest()), false);
});

test("levaV6 live: a busca completa devolve na hora e o andamento fecha o ciclo", async () => {
  const dir = tmp("ciclo");
  const jobs = createJobs(dir, { mock: true, readProfile: () => "React front-end" });
  const agent = createAgentVagas(dir, { jobs, quadro: createQuadro(dir), now: () => Date.parse("2026-11-03T15:00:00Z"), readProfile: () => "React front-end" });
  agent.setPausado(false);
  const started = agent.iniciarCiclo({ forcar: true, completa: true, runner: async () => ({ ok: true, novas: 0 }) });
  assert.equal(started.iniciado, true);
  assert.equal(agent.andamento().done, false);
  for (let i = 0; i < 30 && !agent.andamento().done; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(agent.andamento().done, true);
  assert.equal(agent.andamento().fase, "concluido");
  assert.equal(agent.andamento().result.ok, true);
});
