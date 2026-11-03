"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runApplication } = require("../src/jobs-host");
const { chooseButton, simulate } = require("../server/form-navigator");
const { catalog } = require("../server/vagas-visual");
const { captchaVisivel, desafioVisivel } = require("../server/captcha-visivel");
const { createCodeReader } = require("../src/code-reader");
const { sendEmailApply } = require("../server/vagas-email-apply");
const { callRotating } = require("../server/cursor-rotation");
const regras = require("../server/vagas-regras");
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

test("levaV6 live: captcha invisível não para; híbrido Florianópolis sai da fila; falha não gasta a hora", async () => {
  assert.equal(captchaVisivel([{ width: 0, height: 0, hidden: true }], ""), false);
  assert.equal(captchaVisivel([{ width: 256, height: 60, badge: true }], ""), false);
  assert.equal(captchaVisivel([{ width: 304, height: 180 }], ""), true);
  const invisivel = scripted([{
    url: "https://vaas.inhire.app/vagas/x",
    text: "Nome completo. Continuar inscrição.",
    captcha: true,
    captchaVisivel: false,
    fields: [{ sel: "#nome", type: "text", label: "Nome completo *", required: true, inForm: true, value: "" }],
    buttons: [{ sel: "#go", text: "Continuar inscrição", tag: "button", visible: true, inForm: true }],
  }, { url: "https://vaas.inhire.app/vagas/x/ok", text: "Candidatura enviada", fields: [], buttons: [] }]);
  const followed = await invisivel.run();
  assert.notEqual(followed.codigo, "captcha");
  assert.ok(invisivel.clicks.includes("#go") || followed.enviado);

  const hibrida = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "formularios", "inhire-vaas.json"), "utf8"));
  const vaas = scripted(hibrida);
  const dropped = await vaas.run();
  assert.equal(dropped.codigo, "regra");
  assert.equal(vaas.clicks.length, 0);
  assert.equal(regras.avaliarVaga({ title: "Desenvolvedor Frontend", company: "VAAS", location: "Híbrido, Florianópolis", description: "React" }).aceita, false);
  assert.equal(regras.avaliarVaga({ title: "Desenvolvedor Frontend", company: "VAAS", location: "Florianópolis, SC", description: "React remoto" }).aceita, false);

  const jobs = createJobs(tmp("hora"), { mock: true, now: () => Date.parse("2026-11-03T15:00:00Z"), readProfile: () => "React front-end remoto" });
  jobs.setPrefs({ modo: "automatico", porHora: 2, notaMinima: 10, termos: "desenvolvedor front-end" });
  jobs.ingestParsedJobs(["A", "B", "C"].map((company) => ({
    extId: company,
    title: "Dev React Pleno",
    company,
    location: "Remoto",
    url: `https://exemplo.invalid/${company}`,
    description: "React remoto",
  })), { platform: "gupy" });
  for (const company of ["A", "B"]) {
    const row = jobs.list().find((item) => item.company === company && item.status === "nova");
    jobs.autoStart(row.id);
    jobs.autoResult(row.id, { critico: "Não achei o próximo botão", codigo: "botao" });
  }
  assert.equal(jobs.rateLeft(), 2);
  assert.ok(jobs.autoQueue().some((item) => item.company === "C"));
  assert.equal(JSON.parse(fs.readFileSync(jobs.logFile, "utf8")).some((item) => item.status === "auto_iniciada"), false);
});

test("levaV6 live: e-mail sai com o CV e a conta do Cursor troca no mesmo pedido", async () => {
  const sent = [];
  const mail = await sendEmailApply({
    cargo: "Dev React",
    to: "rh@empresa.test",
    cvPath: "C:\\cv.pdf",
    nome: "Pessoa Exemplo",
    send: async (draft) => { sent.push(draft); },
  });
  assert.equal(mail.ok, true);
  assert.match(mail.confirmacao, /CV/);
  assert.equal(sent[0].to, "rh@empresa.test");
  assert.equal(sent[0].cvPath, "C:\\cv.pdf");

  const accounts = [
    { id: "a", apiKey: "crsr_a", label: "Conta A" },
    { id: "b", apiKey: "crsr_b", label: "Conta B" },
  ];
  let active = "a";
  const issues = [];
  const api = {
    active: () => accounts.find((item) => item.id === active),
    setActive: (id) => { active = id; },
    noteIssue: (id, kind) => issues.push({ id, kind }),
    noteOk: () => {},
    nextAccount: (fromId) => {
      const next = accounts.find((item) => item.id !== fromId);
      return next ? { id: next.id, label: next.label } : null;
    },
  };
  let calls = 0;
  const rotated = await callRotating(api, async (account) => {
    calls += 1;
    if (account.id === "a") throw Object.assign(new Error("usage limit"), { status: 429 });
    return `ok ${account.id}`;
  });
  assert.equal(rotated.result, "ok b");
  assert.equal(rotated.accountId, "b");
  assert.equal(active, "b");
  assert.equal(issues[0].kind, "usage");
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(rotated).includes("crsr_"), false);
});

test("levaV6 live: a carta do Indeed segue e o selo do reCAPTCHA não é captcha", async () => {
  const page = {
    url: "https://br.indeed.com/viewjob?jk=bbchain",
    title: "Adicionar documentos de apoio",
    text: "Adicionar documentos de apoio. Carta de apresentação. Continuar. Este site é protegido pelo reCAPTCHA e está sujeito à Política de Privacidade e aos Termos de Serviço do Google.",
    captcha: true,
    fields: [{ sel: "#carta", type: "textarea", label: "Carta de apresentação *", required: true, inForm: true, value: "" }],
    buttons: [{ sel: "#go", text: "Continuar", tag: "button", visible: true, inForm: true }],
  };
  assert.equal(desafioVisivel(page), false);
  assert.equal(captchaVisivel([], page.text), false);
  const fills = [];
  const flow = scripted([page, { url: page.url, text: "Candidatura enviada", fields: [], buttons: [] }]);
  flow.io.apply = async (acoes) => { fills.push(...(acoes || [])); return (acoes || []).length; };
  const result = await flow.run();
  assert.notEqual(result.codigo, "captcha");
  assert.equal(result.enviado, true);
  const carta = fills.map((item) => item.valor).join("\n");
  assert.match(carta, /Pessoa Exemplo/);
  assert.match(carta, /Desenvolvedor Front-end/);
  assert.ok(flow.clicks.includes("#go"));

  let passo = 0;
  const llm = {
    async chat() {
      passo += 1;
      const content = passo === 1
        ? "{\"acao\":\"preencher\",\"alvo\":\"Carta de apresentação\",\"valor\":\"{{CARTA}}\",\"motivo\":\"campo obrigatório\"}"
        : "{\"acao\":\"clicar\",\"alvo\":\"Continuar\",\"motivo\":\"avançar\"}";
      return { message: { content }, model: "modelo-teste" };
    },
  };
  const visto = scripted([page, { url: page.url, text: "Candidatura enviada", fields: [], buttons: [] }], { llm });
  const fillsVisao = [];
  visto.io.apply = async (acoes) => { fillsVisao.push(...(acoes || [])); return (acoes || []).length; };
  const pelaVisao = await visto.run();
  assert.notEqual(pelaVisao.codigo, "captcha");
  assert.equal(pelaVisao.enviado, true);
  assert.match(fillsVisao.map((item) => item.valor).join("\n"), /Pessoa Exemplo/);
});

test("levaV6 live: post nota alta vira candidatura ou e-mail; híbrido sai; captcha falso volta à fila", () => {
  const jobs = createJobs(tmp("feed-post"), {
    readProfile: () => "React Node desenvolvedor front-end remoto",
    now: () => Date.parse("2026-11-03T18:00:00Z"),
  });
  jobs.setPrefs({ termos: "desenvolvedor", notaMinima: 40, modo: "automatico", porHora: 5 });
  const ingested = jobs.ingestFeed([
    { id: "p1", autor: "Empresa", texto: "OPORTUNIDADE 100% REMOTA | Desenvolvedor(a) Júnior - Integrações. Envie o CV para vagas@empresa.test", url: "https://www.linkedin.com/feed/update/p1" },
    { id: "p2", autor: "VAAS", texto: "Desenvolvedor Frontend híbrido em Florianópolis, SC. React.", url: "https://www.linkedin.com/feed/update/p2" },
    { id: "p3", autor: "La Moda", texto: "Desenvolvedor front-end React remoto. https://www.linkedin.com/jobs/view/99887766", url: "https://www.linkedin.com/jobs/view/99887766" },
  ]);
  assert.ok(ingested.vagasNovas >= 2);
  const fila = jobs.autoQueue();
  assert.ok(fila.some((item) => item.platform === "email" && item.emailTo === "vagas@empresa.test"));
  assert.ok(fila.some((item) => item.extId === "99887766"));
  assert.equal(fila.some((item) => /florian|hibrid/i.test(`${item.location} ${item.title}`)), false);
  assert.equal(jobs.feed().find((item) => item.key === "p2").score, 0);

  const dir = tmp("captcha-falso");
  fs.writeFileSync(path.join(dir, "vagas.json"), JSON.stringify({
    version: 1,
    prefs: { termos: ["desenvolvedor front-end"], modo: "automatico", notaMinima: 10, plataformas: ["linkedin"] },
    vagas: [
      { id: "vaga_h", platform: "linkedin", extId: "h", title: "Desenvolvedor Frontend", company: "VAAS", location: "Florianópolis, SC", description: "React híbrido", score: 80, status: "critica", critico: { motivo: "O site mostrou captcha.", classe: "humano" } },
      { id: "vaga_c", platform: "indeed", extId: "c", title: "Desenvolvedor React", company: "BBChain", location: "Remoto", description: "React remoto", score: 90, status: "critica", critico: { motivo: "O site mostrou captcha.", classe: "humano" } },
      { id: "vaga_r", platform: "gupy", extId: "r", title: "Desenvolvedor React", company: "Empresa", location: "Remoto", description: "React remoto", score: 90, status: "critica", critico: { motivo: "O site mostrou captcha: não sou um robô", classe: "humano" } },
    ],
  }));
  const filaAntiga = createJobs(dir, { readProfile: () => "React remoto" });
  filaAntiga.revisarFila();
  assert.equal(filaAntiga.get("vaga_h").status, "descartada");
  assert.equal(filaAntiga.get("vaga_c").status, "nova");
  assert.equal(filaAntiga.get("vaga_r").status, "critica");
});

test("levaV6 live: o e-mail da vaga sai com o CV e sem a chave no corpo", async () => {
  const dir = tmp("cv");
  const cv = path.join(dir, "cv.pdf");
  fs.writeFileSync(cv, "CV-FIXTURE");
  let body = "";
  const reader = createCodeReader({
    getAccounts: () => [{ id: "g1" }],
    getAuthorization: async () => "Bearer teste",
    fetchImpl: async (_url, options) => {
      body = String(options && options.body || "");
      return { ok: true, status: 200, json: async () => ({ id: "m1" }) };
    },
  });
  const sent = await reader.sendApplication({ to: "rh@empresa.test", subject: "Dev React", body: "Olá", cvPath: cv });
  assert.equal(sent.ok, true);
  const raw = JSON.parse(body).raw.replace(/-/g, "+").replace(/_/g, "/");
  const text = Buffer.from(raw, "base64").toString("utf8");
  assert.match(text, /rh@empresa.test/);
  assert.match(text, /cv\.pdf/);
  assert.equal(text.includes("Bearer"), false);
  const denied = createCodeReader({
    getAccounts: () => [{ id: "g1" }],
    getAuthorization: async () => "Bearer teste",
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  });
  const fail = await denied.sendApplication({ to: "rh@empresa.test", subject: "Dev", body: "Olá", cvPath: cv });
  assert.match(fail.error, /leitura/);

  const mailed = [];
  const out = await runApplication({
    vaga: { platform: "email", aplicarPorEmail: true, emailTo: "rh@empresa.test", title: "Dev React", company: "Empresa", location: "Remoto", url: "mailto:rh@empresa.test" },
    profile: PROFILE,
    io: {
      load: async () => { throw new Error("não abre navegador"); },
      snapshot: async () => ({}),
      sendEmail: async (draft) => { mailed.push(draft); },
    },
  });
  assert.equal(out.enviado, true);
  assert.match(out.confirmacao, /CV/);
  assert.equal(mailed[0].to, "rh@empresa.test");
  assert.equal(mailed[0].cvPath, PROFILE.cvPath);
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

test("levaV12: o menu do Indeed não esconde Candidatar-se e as perguntas seguem até a confirmação", () => {
  const choice = chooseButton({
    url: "https://br.indeed.com/viewjob?jk=abc",
    buttons: [
      { sel: "#skip", text: "Ir para o conteúdo principal", tag: "a", chrome: true, visible: true },
      { sel: "#home", text: "Página inicial", tag: "a", chrome: true, visible: true },
      { sel: "#rev", text: "Avaliações de Empresas", tag: "a", chrome: true, visible: true },
      { sel: "#pay", text: "Cargos e salários", tag: "a", chrome: true, visible: true },
      { sel: "#msg", text: "Mensagens", tag: "a", chrome: true, visible: true },
      { sel: "#apply", text: "Candidatar-se", tag: "button", visible: true },
    ],
    fields: [],
  });
  assert.equal(choice.button.sel, "#apply");
  assert.equal(choice.intent, "apply");

  const run = simulate([
    {
      url: "https://smartapply.indeed.com/form/questions-module",
      fields: [
        { sel: "#nome", type: "text", label: "Nome completo", required: true, inForm: true, value: "" },
        { sel: "#anos", type: "text", label: "Anos de experiência com React", required: true, inForm: true, value: "" },
      ],
      buttons: [
        { sel: "#msg", text: "Mensagens", tag: "a", chrome: true, visible: true },
        { sel: "#go", text: "Continuar", tag: "button", visible: true, inForm: true },
      ],
    },
    { url: "https://smartapply.indeed.com/form/review", text: "Candidatura enviada", fields: [], buttons: [] },
  ], {
    profile: { nome: "Pessoa Exemplo", anosTecnologia: { react: 2 } },
    vaga: { title: "Desenvolvedor React", company: "Empresa", location: "Remoto" },
    enviar: true,
  });
  assert.equal(run.final.kind, "submitted");
  assert.ok(run.trace.some((step) => step.sel === "#go"));
  assert.equal(run.final.codigo, "");
});

test("levaV12: falha de botão guarda a URL, BairesDev na descrição sai, e a mesma vaga só repete uma vez", async () => {
  const flow = scripted([{
    url: "https://br.indeed.com/viewjob?jk=1",
    title: "Vaga",
    buttons: [{ sel: "#home", text: "Página inicial", tag: "a", chrome: true, visible: true }],
    fields: [],
  }]);
  const failed = await flow.run();
  assert.equal(failed.codigo, "botao");
  assert.match(failed.critico, /viewjob\?jk=1/);
  assert.match(failed.critico, /Menu ignorado/);

  const wall = scripted([{
    url: "https://www.glassdoor.com.br/job-listing/x",
    title: "Security | Glassdoor",
    buttons: [{ sel: "#home", text: "Página inicial", tag: "a", chrome: true, visible: true }],
    fields: [],
  }]);
  const security = await wall.run();
  assert.equal(security.codigo, "login");
  assert.match(security.critico, /Glassdoor/);

  assert.equal(regras.avaliarVaga({
    title: "Desenvolvedor React Pleno",
    company: "",
    location: "Remoto",
    description: "A BairesDev contrata para um projeto React remoto",
    url: "https://www.glassdoor.com.br/job/bairesdev",
  }).aceita, false);

  const info = catalog().find((item) => item.id === "infojobs");
  assert.match(info.searchUrl("desenvolvedor"), /keyword=/);
  assert.doesNotMatch(info.searchUrl("desenvolvedor"), /ranking-melhores-empresas|vagas-de-emprego\.aspx/);
  assert.equal(catalog().find((item) => item.id === "bossabox").home.includes("app.bossabox.com/vagas"), false);
  assert.equal(catalog().find((item) => item.id === "programathor").direct, true);

  const dir = tmp("perfil-v12");
  fs.writeFileSync(path.join(dir, "vagas.json"), JSON.stringify({
    version: 1,
    prefs: { perfil: { cidade: "Nova Friburgo, RJ", linkedin: "linkedin.com/in/helisondias", pretensao: "R$ 4.000 (júnior) / US$ 1.000" } },
    vagas: [],
  }));
  const perfil = createJobs(dir, { readProfile: () => "" });
  assert.equal(perfil.prefs().perfil.cidade, "Bom Jardim, RJ");
  assert.equal(perfil.prefs().perfil.linkedin, "https://linkedin.com/in/helisondias");
  assert.equal(perfil.prefs().perfil.pretensao, "R$ 3.500 júnior / R$ 8.000 pleno");
  assert.equal(perfil.prefs().perfil.pretensaoBrlJunior, 3500);
  assert.equal(perfil.prefs().perfil.pretensaoBrlPleno, 8000);

  const jobs = createJobs(tmp("retry-v12"), { now: () => Date.parse("2026-11-03T18:00:00Z"), readProfile: () => "React remoto" });
  jobs.setPrefs({ termos: "desenvolvedor", notaMinima: 10, porHora: 5, modo: "automatico" });
  jobs.ingestParsedJobs([{
    extId: "1",
    title: "Desenvolvedor React Pleno",
    company: "Empresa Boa",
    location: "Remoto",
    url: "https://exemplo.invalid/1",
    description: "React remoto",
  }], { platform: "indeed" });
  const row = jobs.list().find((item) => item.status === "nova");
  jobs.autoStart(row.id);
  jobs.autoResult(row.id, { critico: "Não achei o próximo botão do formulário com segurança.", codigo: "botao" });
  assert.ok(jobs.autoQueue().some((item) => item.id === row.id));
  jobs.autoStart(row.id);
  jobs.autoResult(row.id, { critico: "Não achei o próximo botão do formulário com segurança. URL: https://exemplo.invalid/1", codigo: "botao" });
  assert.equal(jobs.autoQueue().some((item) => item.id === row.id), false);
  assert.match(jobs.history().find((item) => item.status === "falhou").nota, /botão/);
});
