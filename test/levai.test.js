"use strict";
// LEVA I: agentes autônomos (runtime, ferramentas com cartão, orçamento, reinício, fila, Telegram, UI).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRuntime, classifyShell, classifyClick, isSecretPath, insideRoot, nameFromTask, scrubEnv } = require("../server/agent-runtime");
const { createMockAgent, agentScript } = require("../server/mock-agent");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-levai-${p}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error("timeout");
}
const realShell = process.platform === "win32";
const fakeShell = async ({ command }) => ({ code: 0, stdout: /Get-Date/.test(command) ? String(new Date().getFullYear()) : "ok", stderr: "" });

function makeRuntime(extra = {}) {
  const dataDir = tmp("data");
  const workRoot = tmp("work");
  const notes = [];
  const browserOps = [];
  const browser = {
    exec: async (rec, op, args) => {
      browserOps.push(op);
      if (op === "inspecionar") return { ok: true, label: args.texto || "Ok", page: "", url: "http://127.0.0.1/x" };
      if (op === "ler") return { ok: true, text: "Título: Teste local\nTexto: Olá agente", url: "http://127.0.0.1/x" };
      return { ok: true, text: "ok", url: args.url || "http://127.0.0.1/x", thumb: "data:image/png;base64,AAAA" };
    },
    close: () => {}, closeAll: () => {},
  };
  const rt = createAgentRuntime({
    dataDir, workRoot, allowedRoots: [], blockedRoots: [dataDir], browser,
    openWorker: async ({ tools }) => ({ agent: createMockAgent({ tools }), mock: true, label: "demonstração" }),
    notify: (e) => notes.push(e),
    shell: realShell ? undefined : fakeShell,
    ...extra,
  });
  return { rt, dataDir, workRoot, notes, browserOps };
}

test("levaI: agente roteirizado abre página local, grava arquivo, roda PowerShell e conclui sozinho", async () => {
  const { rt, notes, browserOps } = makeRuntime();
  const a = rt.create({ tarefa: "Abra http://127.0.0.1:9/teste.html e escreva o arquivo notas.txt. powershell: `Get-Date -Format yyyy`" });
  assert.match(a.id, /^agt_/);
  const done = await until(() => { const v = rt.view(a.id); return v.status === "done" ? v : null; });
  assert.deepEqual(browserOps.slice(0, 2), ["abrir", "ler"]);
  const notas = path.join(done.workDir, "notas.txt");
  assert.ok(fs.existsSync(notas), "arquivo gravado na pasta do agente");
  assert.ok(done.steps.some((s) => /PowerShell: Get-Date/.test(s.label)));
  assert.ok(done.steps.some((s) => /\b20\d\d\b/.test(s.detail || "")), "saída do PowerShell no passo");
  assert.ok(done.artifacts.some((f) => f.path === notas));
  assert.equal(done.thumb, "data:image/png;base64,AAAA");
  assert.ok(notes.some((n) => n.kind === "done"));
});

test("levaI: apagar fora da pasta do agente pede aprovação; aprovar executa e o agente termina", async () => {
  const outside = tmp("fora");
  const alvo = path.join(outside, "lixo.txt");
  fs.writeFileSync(alvo, "x");
  const { rt, notes } = makeRuntime({ allowedRoots: [outside] });
  rt.setPrefs({ pastas: [outside] });
  const a = rt.create({ tarefa: `Organize. apague ${alvo}` });
  const waiting = await until(() => { const v = rt.view(a.id); return v.status === "waiting_you" ? v : null; });
  const card = waiting.approvals.find((x) => x.state === "pending");
  assert.ok(card, "cartão criado");
  assert.ok(fs.existsSync(alvo), "nada apagado antes de aprovar");
  assert.ok(notes.some((n) => n.kind === "approval"));
  assert.ok(rt.inboxItems().some((i) => i.agentId === a.id && i.id === card.id && i.origin === "agente"));
  await rt.decide(a.id, card.id, "approve");
  await until(() => rt.view(a.id).status === "done");
  assert.ok(!fs.existsSync(alvo), "apagado depois da aprovação");
});

test("levaI: negar não faz nada", async () => {
  const outside = tmp("fora2");
  const alvo = path.join(outside, "fica.txt");
  fs.writeFileSync(alvo, "x");
  const { rt } = makeRuntime({ allowedRoots: [outside] });
  rt.setPrefs({ pastas: [outside] });
  const a = rt.create({ tarefa: `apague ${alvo}` });
  const w = await until(() => { const v = rt.view(a.id); return v.status === "waiting_you" ? v : null; });
  await rt.decide(a.id, w.approvals[0].id, "deny");
  await until(() => rt.view(a.id).status === "done");
  assert.ok(fs.existsSync(alvo));
});

test("levaI: pergunta do agente vai para a caixa e a resposta continua a tarefa", async () => {
  const { rt } = makeRuntime();
  const a = rt.create({ tarefa: "Candidate-se e pergunte a pretensão" });
  const w = await until(() => { const v = rt.view(a.id); return v.status === "waiting_you" && v.questions.length ? v : null; });
  const q = w.questions[0];
  assert.ok(rt.findCard(q.id.slice(-6)), "código curto do Telegram acha o cartão");
  rt.answer(a.id, q.id, "Combinar");
  await until(() => rt.view(a.id).status === "done");
});

test("levaI: orçamento de passos para o agente", async () => {
  const { rt } = makeRuntime();
  rt.setPrefs({ maxPassos: 10 });
  const a = rt.create({ tarefa: "Liste muito [[passos:30]]" });
  const v = await until(() => { const r = rt.view(a.id); return ["paused", "error", "done"].includes(r.status) ? r : null; });
  assert.notEqual(v.status, "done");
  assert.ok(v.stepCount <= 12, `parou perto do limite (${v.stepCount})`);
  assert.match(v.motivo, /limite/);
});

test("levaI: reinício marca o que trabalhava como interrompido; Retomar continua", async () => {
  const { rt, dataDir, workRoot } = makeRuntime();
  const a = rt.create({ tarefa: "Tarefa qualquer" });
  await until(() => rt.view(a.id).status === "done");
  const file = path.join(dataDir, "agentes", `${a.id}.json`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  rec.status = "working";
  fs.writeFileSync(file, JSON.stringify(rec));
  const rt2 = createAgentRuntime({ dataDir, workRoot, openWorker: async ({ tools }) => ({ agent: createMockAgent({ tools }) }), shell: realShell ? undefined : fakeShell });
  const v = rt2.view(a.id);
  assert.equal(v.status, "paused");
  assert.equal(v.motivo, "interrompido");
  rt2.resume(a.id);
  await until(() => rt2.view(a.id).status === "done");
});

test("levaI: concorrência máxima de 3, o resto fica na fila; Parar todos", async () => {
  process.env.HELIOS_MOCK_DELAY = "60";
  try {
    const { rt } = makeRuntime();
    const ids = [1, 2, 3, 4, 5].map((n) => rt.create({ tarefa: `Liste coisas ${n} [[passos:20]]` }).id);
    await sleep(80);
    const st = ids.map((id) => rt.view(id).status);
    assert.equal(st.filter((s) => s === "working").length, 3);
    assert.equal(st.filter((s) => s === "queued").length, 2);
    const n = await rt.stopAll();
    assert.ok(n >= 5);
    await sleep(150);
    assert.ok(ids.every((id) => !["working", "queued"].includes(rt.view(id).status)));
  } finally { delete process.env.HELIOS_MOCK_DELAY; }
});

test("levaI: instrução no meio do trabalho entra como passo do Helison", async () => {
  process.env.HELIOS_MOCK_DELAY = "40";
  try {
    const { rt } = makeRuntime();
    const a = rt.create({ tarefa: "Liste [[passos:6]]" });
    await sleep(60);
    rt.instruct(a.id, "Também grave um resumo");
    const v = await until(() => { const r = rt.view(a.id); return r.status === "done" ? r : null; });
    assert.ok(v.steps.some((s) => s.kind === "you" && /resumo/.test(s.label)));
    assert.ok(fs.existsSync(path.join(v.workDir, "instrucoes.txt")));
  } finally { delete process.env.HELIOS_MOCK_DELAY; }
});

test("levaI: política de caminhos e segredos", async () => {
  const { rt } = makeRuntime();
  const a = rt.create({ tarefa: "xyz" });
  await until(() => rt.view(a.id).status === "done");
  const tools = rt._tools(a.id);
  assert.match(String(await tools.arquivo_ler.execute({ caminho: path.join(os.homedir(), ".ssh", "id_rsa") })), /Recusad|fora|segredo/i);
  assert.match(String(await tools.arquivo_escrever.execute({ caminho: ".env", conteudo: "A=1" })), /Recusad|segredo/i);
  assert.match(String(await tools.pc_powershell.execute({ comando: "Get-Content $env:USERPROFILE\\.ssh\\id_rsa" })), /Recusad|segredo/i);
  assert.ok(isSecretPath("C:\\x\\.env") && isSecretPath("/a/id_ed25519") && !isSecretPath("/a/notas.txt"));
  assert.ok(insideRoot("/a/b/c", "/a/b") && !insideRoot("/a/bc", "/a/b"));
});

test("levaI: agente usa pesquisa web e MCP com allowlist e cartão para escrita", async () => {
  let calls = 0;
  const { rt } = makeRuntime({
    autonomyMode: (tipo) => tipo === "ler" ? "sozinho" : "pedir",
    assistantMcp: () => ["caixa"],
    searchWeb: async (consulta) => ({ query: consulta, results: [{ title: "Fonte", url: "https://exemplo.test", snippet: "resultado" }] }),
    mcp: {
      findTool: (server, tool) => {
        if (server !== "caixa") return null;
        if (tool === "listar") return { name: tool, description: "Lista itens da caixa" };
        if (tool === "criar_item") return { name: tool, description: "Cria um item na caixa" };
        return null;
      },
      call: async (server, tool) => { calls += 1; return `${server}.${tool}: item`; },
    },
  });
  const a = rt.create({ tarefa: "teste de ferramentas" });
  await until(() => rt.view(a.id).status === "done");
  const tools = rt._tools(a.id);
  assert.match(await tools.pesquisar_web.execute({ consulta: "fonte" }), /https:\/\/exemplo\.test/);
  assert.equal(await tools.mcp_chamar.execute({ servidor: "caixa", ferramenta: "listar", argumentos: {} }), "caixa.listar: item");
  assert.equal(calls, 1);
  assert.match(await tools.mcp_chamar.execute({ servidor: "caixa", ferramenta: "criar_item", argumentos: { titulo: "x" } }), /PENDENTE/);
  assert.equal(calls, 1, "escrita MCP não roda sem aprovação, mesmo com Autonomia sozinho");
  assert.match(await tools.mcp_chamar.execute({ servidor: "outro", ferramenta: "listar", argumentos: {} }), /não tem acesso|não achei/i);
});

test("levaI: agente usa memória do assistente e pede aprovação para esquecer", async () => {
  const items = [{ id: "mem_abc123", text: "Prefere respostas curtas", kind: "preferencia" }];
  const memory = {
    list: () => items.slice(),
    context: () => ({ text: "Memória sobre o Helison:\n- (preferencia) Prefere respostas curtas" }),
    remember: ({ text }) => { items.push({ id: "mem_new", text, kind: "fato" }); return { updated: false }; },
    forget: (id) => { const before = items.length; while (items.some((x) => x.id === id)) items.splice(items.findIndex((x) => x.id === id), 1); return items.length < before; },
  };
  const { rt } = makeRuntime({ memoryFor: () => memory });
  const a = rt.create({ tarefa: "teste de memória" });
  await until(() => rt.view(a.id).status === "done");
  const tools = rt._tools(a.id);
  assert.equal(await tools.memory_save.execute({ texto: "Gosta de resumos objetivos", tipo: "preferencia" }), "Guardei na memória.");
  assert.match(await tools.memory_context.execute({ texto: "preferências" }), /Prefere respostas curtas/);
  assert.match(await tools.memory_forget.execute({ id: "mem_abc123" }), /PENDENTE/);
  const card = rt.view(a.id).approvals.find((item) => item.state === "pending");
  assert.ok(card);
  await rt.decide(a.id, card.id, "approve");
  assert.equal(items.some((x) => x.id === "mem_abc123"), false);
});

test("levaI: classificadores de PowerShell e de clique", () => {
  assert.equal(classifyShell("Get-ChildItem"), null);
  assert.equal(classifyShell("npm test"), null);
  assert.equal(classifyShell("npm install"), null);
  assert.equal(classifyShell("npm install lodash").tipo, "instalar");
  assert.equal(classifyShell("winget install x").tipo, "instalar");
  assert.equal(classifyShell("Set-ItemProperty HKCU:\\Software\\x -Name a -Value 1").tipo, "sistema");
  assert.equal(classifyShell("Remove-Item C:\\x -Recurse").tipo, "apagar");
  assert.equal(classifyShell("Send-MailMessage -To a@b.c").tipo, "enviar");
  assert.ok(classifyClick("Finalizar compra", "").tipo === "pagar");
  assert.ok(classifyClick("Enviar candidatura", "").tipo === "enviar");
  assert.ok(classifyClick("Aceito os termos", "").tipo === "termos");
  assert.equal(classifyClick("Próxima página", ""), null);
});

test("levaI: ambiente do PowerShell sem segredos e nome automático curto", () => {
  const env = scrubEnv({ PATH: "x", CURSOR_API_KEY: "k", GITHUB_TOKEN: "t", MY_SECRET: "s", HOME: "h" });
  assert.equal(env.PATH, "x");
  assert.equal(env.CURSOR_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.MY_SECRET, undefined);
  const n = nameFromTask("Pesquise vagas de React remoto no LinkedIn e salve um resumo em vagas.md com links");
  assert.ok(n.length <= 48 && n.length > 3);
});

test("levaI: nada de senha no prompt nem nos passos gravados", async () => {
  const { rt, dataDir } = makeRuntime();
  const a = rt.create({ tarefa: "Use a chave sk-abcdefghijklmnopqrstuvwx1234 e escreva o arquivo n.txt" });
  await until(() => rt.view(a.id).status === "done");
  const raw = fs.readFileSync(path.join(dataDir, "agentes", `${a.id}.json`), "utf8");
  assert.doesNotMatch(raw, /sk-abcdefghijklmnopqrstuvwx1234/);
});

test("levaI: roteiro do mock: apagar sem concluir; instrução APROVOU conclui", () => {
  const s = agentScript("apague C:\\x.txt", "agente");
  assert.ok(s.some(([k, n]) => k === "tool" && n === "arquivo_apagar"));
  assert.ok(!s.some(([, n]) => n === "concluir"));
  assert.ok(agentScript("APROVOU", "instrucao").some(([, n]) => n === "concluir"));
});

test("levaI: servidor expõe /api/agentes, mistura na caixa de entrada e Telegram tem /agentes e /novo", () => {
  const idx = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  for (const r of ["/api/agentes", "parar-todos", "instrucao", "pausar", "retomar", "aprovacao", "resposta", "navegador"]) assert.ok(idx.includes(r), r);
  assert.match(idx, /agentRuntime\.inboxItems\(\)/);
  assert.match(idx, /agentRuntime\.stopAll\(\)/);
  const tg = fs.readFileSync(path.join(__dirname, "..", "server", "telegram.js"), "utf8");
  assert.match(tg, /command === "agentes"/);
  assert.match(tg, /command === "novo"/);
});

test("levaI: UI: + Novo agente abre a caixa de tarefa, lista com bolinha de status, Parar todos, sem 'Como posso ajudar' no agente", () => {
  const R = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8");
  const ag = R("agents.js");
  assert.match(ag, /\$\("lfNew"\)\.onclick = \(\) => newAgent\(\)/);
  assert.match(ag, /id="agtTask"/);
  assert.match(ag, /lf-st lf-st-/);
  assert.match(ag, /Parar todos/);
  assert.match(ag, /Ver navegador/);
  assert.match(ag, /id="agtSteer"/);
  assert.doesNotMatch(ag, /Como posso ajudar/);
  assert.match(R("index.html"), /<script src="agents.js"><\/script>/);
  assert.match(R("index.html"), /id="lfNewChat"/);
  // cabeçalho da conversa: o ícone que parecia um sol (engrenagem) virou o emblema do HELIOS
  assert.match(R("app.js"), /id="chatOpts"[^>]*>[\s\S]{0,200}hx-mark hx-18 chat-opts-mark/);
});

test("levaI: navegador do agente: partição própria, sem node, downloads na pasta do agente", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "agent-browser.js"), "utf8");
  assert.match(src, /persist:agente-/);
  assert.match(src, /nodeIntegration: false/);
  assert.match(src, /sandbox: true/);
  assert.match(src, /campo protegido/);
  assert.match(src, /will-download/);
  assert.match(src, /jobsHost\.login/);
  assert.match(src, /codeReader\.fillCode/);
});
