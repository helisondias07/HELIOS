"use strict";
// LEVA K: passos ao vivo, handoff, aprovação hold/expira, lições, consulta/roteador, missões, uso SDK, drive, rotinas texto, Obsidian, skills.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAgentRuntime } = require("../server/agent-runtime");
const { createMockAgent } = require("../server/mock-agent");
const { parseRoutineText, parseClock, parseWeekdays } = require("../server/routine-parse");
const { createLessons } = require("../server/lessons");
const { createMissions } = require("../server/missions");
const { createAgentConsult, routeAssistant } = require("../server/agent-consult");
const { createAgentDrive } = require("../server/agent-drive");
const { importObsidianVault } = require("../server/obsidian");
const { extractSdkUsage, formatUsageNote } = require("../server/sdk-usage");
const { createMemory } = require("../server/memory");
const { createSkillFs, parseFrontmatter } = require("../server/skill-fs");
const { KNOWN_SKILL_SOURCES } = require("../server/skill-install");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-levak-${p}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error("timeout");
}

function makeRuntime(extra = {}) {
  const dataDir = tmp("data");
  const workRoot = tmp("work");
  const notes = [];
  const lessons = [];
  const browser = {
    exec: async (rec, op, args) => {
      if (op === "ler" && args && args.foco === "captcha") {
        return { ok: true, text: "Please complete the captcha", needsHuman: true, reason: "captcha/2FA", thumb: "data:image/png;base64,BBBB" };
      }
      if (op === "inspecionar") return { ok: true, label: args.texto || "Ok", page: "", url: "http://127.0.0.1/x" };
      return { ok: true, text: "ok", url: args.url || "http://127.0.0.1/x", thumb: "data:image/png;base64,AAAA" };
    },
    close: () => {},
    closeAll: () => {},
  };
  const rt = createAgentRuntime({
    dataDir,
    workRoot,
    allowedRoots: [],
    blockedRoots: [dataDir],
    browser,
    openWorker: async ({ tools }) => ({ agent: createMockAgent({ tools }), mock: true, label: "demonstração" }),
    notify: (e) => notes.push(e),
    onLesson: (e) => lessons.push(e),
    approvalTtlMin: 10,
    shell: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    now: extra.now || (() => Date.now()),
    ...extra,
  });
  return { rt, dataDir, workRoot, notes, lessons, browser };
}

// ---------- 1. Passos ao vivo ----------
test("levaK: card do agente expõe passos, ferramentas, tempo e live", async () => {
  const { rt } = makeRuntime();
  const a = rt.create({ tarefa: "Abra http://127.0.0.1:9/x e escreva notas.txt" });
  const done = await until(() => {
    const v = rt.view(a.id);
    return v.status === "done" ? v : null;
  });
  assert.ok(done.stepCount >= 1);
  assert.ok(Array.isArray(done.toolsUsed));
  assert.equal(typeof done.toolsLabel, "string");
  assert.equal(typeof done.elapsed, "string");
  assert.equal(typeof done.elapsedMs, "number");
  assert.equal(done.live, false);
  const listed = rt.list().find((x) => x.id === a.id);
  assert.ok(listed.toolsUsed);
  assert.ok("elapsed" in listed);
});

test("levaK: pausar e parar no meio do trabalho", async () => {
  const { rt } = makeRuntime();
  const a = rt.create({ tarefa: "tarefa que fica na fila" });
  // Ainda na fila: pausar e parar devem funcionar sem hang.
  if (rt.view(a.id).status === "queued") {
    await rt.pause(a.id);
    assert.equal(rt.view(a.id).status, "paused");
  }
  const b = rt.create({ tarefa: "outra na fila para parar" });
  await rt.stop(b.id);
  assert.equal(rt.view(b.id).status, "done");
  rt.resume(a.id);
  const done = await until(() => (rt.view(a.id).status === "done" ? rt.view(a.id) : null));
  assert.equal(done.status, "done");
});

// ---------- 2. Assumir navegador ----------
test("levaK: handoff do navegador (captcha) e resolvi", async () => {
  const { rt, notes } = makeRuntime();
  await rt.startHandoff("missing", "x").catch((e) => assert.equal(e.status, 404));
  const a = rt.create({ tarefa: "Só conclua dizendo pronto" });
  await until(() => rt.view(a.id).status === "done" || rt.view(a.id).status === "working" || rt.view(a.id).status === "queued");
  // cria agente só para handoff manual
  const b = rt.create({ tarefa: "Espere" });
  await rt.pause(b.id);
  const hand = await rt.startHandoff(b.id, "captcha/2FA");
  assert.equal(hand.status, "waiting_you");
  assert.ok(hand.handoff && hand.handoff.state === "waiting");
  assert.ok(notes.some((n) => n.kind === "browser_handoff"));
  const inbox = rt.inboxItems().find((i) => i.origin === "browser_handoff" && i.agentId === b.id);
  assert.ok(inbox);
  const done = await rt.resolveHandoff(b.id);
  assert.ok(!done.handoff || done.handoff.state === "done");
});

// ---------- 3. Aprovação hold / expiração / lição ----------
test("levaK: aprovação com ação exata, hold, expiração e motivo vira lição", async () => {
  let clock = Date.now();
  const outside = tmp("fora");
  const alvo = path.join(outside, "lixo.txt");
  fs.writeFileSync(alvo, "x");
  const { rt, lessons } = makeRuntime({
    allowedRoots: [outside],
    approvalTtlMin: 1 / 60, // 1 segundo
    now: () => clock,
  });
  rt.setPrefs({ pastas: [outside] });
  const a = rt.create({ tarefa: `apague ${alvo}` });
  const waiting = await until(() => {
    const v = rt.view(a.id);
    return v.status === "waiting_you" ? v : null;
  });
  const card = waiting.approvals.find((x) => x.state === "pending");
  assert.ok(card);
  assert.ok(card.acaoExata || card.detalhe);
  assert.ok(card.expiresAt);
  assert.equal(card.holdRequired, true);
  assert.ok(card.digest);

  clock += 70_000;
  rt.expireApprovals();
  const expired = rt.view(a.id).approvals.find((x) => x.id === card.id);
  assert.equal(expired.state, "expired");

  const alvo2 = path.join(outside, "lixo2.txt");
  fs.writeFileSync(alvo2, "y");
  const a2 = rt.create({ tarefa: `apague ${alvo2}` });
  const w2 = await until(() => {
    const v = rt.view(a2.id);
    return v.status === "waiting_you" ? v : null;
  });
  await rt.decide(a2.id, w2.approvals[0].id, "deny", { motivo: "não apagar arquivos do cliente" });
  assert.ok(lessons.some((l) => l.type === "deny" && /cliente/.test(l.motivo)));
  await until(() => rt.view(a2.id).status === "done");
  assert.ok(fs.existsSync(alvo2));
});

// ---------- 4. Lições + padrões vagas ----------
test("levaK: lições aceitar/recusar e padrões de recusa de vagas", () => {
  const dataDir = tmp("lic");
  const memory = createMemory(dataDir);
  const lessons = createLessons(dataDir, { memory });
  const p = lessons.propose({ agentId: "agt_1", assistantId: "default", text: "Sempre confirmar o salário antes de candidatar." });
  assert.equal(p.state, "pending");
  lessons.accept(p.id);
  assert.ok(memory.list().some((m) => /salário|salario/i.test(m.text)));
  const p2 = lessons.propose({ agentId: "agt_1", assistantId: "default", text: "Nunca usar emoji na UI." });
  lessons.refuse(p2.id);
  assert.equal(lessons.list({ pending: true }).length, 0);
  lessons.recordJobRefusal({ assistantId: "vagas", motivo: "Presencial obrigatório" });
  lessons.recordJobRefusal({ assistantId: "vagas", motivo: "presencial obrigatorio" });
  lessons.recordJobRefusal({ assistantId: "vagas", motivo: "Salário abaixo" });
  const patterns = lessons.jobRefusalPatterns("vagas");
  assert.ok(patterns.some((x) => x.count >= 2));
});

// ---------- 5. Consulta + roteador ----------
test("levaK: agentes se consultam e roteador escolhe sem marcar", async () => {
  const consult = createAgentConsult({
    askFn: async (id, q) => (id === "portfolio" ? `Projetos: Oasis, HELIOS. Pergunta: ${q}` : "ok"),
  });
  const r = await consult.consultar({ fromAgentId: "agt_vagas", toAssistantId: "portfolio", pergunta: "Quais projetos citar?" });
  assert.match(r.resposta, /Oasis/);
  assert.equal(consult.list("agt_vagas").length, 1);

  const assistants = [
    { id: "vagas", name: "Vagas" },
    { id: "portfolio", name: "Portfólio" },
    { id: "lojas-wake", name: "Lojas Wake" },
    { id: "default", name: "HELIOS", builtin: true },
  ];
  assert.equal(routeAssistant("quero candidatar a vagas no linkedin", assistants).assistantId, "vagas");
  assert.equal(routeAssistant("monte o portfólio com projetos", assistants).assistantId, "portfolio");
  assert.equal(routeAssistant("ajuste o template da loja wake", assistants).assistantId, "lojas-wake");
  assert.equal(routeAssistant("bom dia", assistants).assistantId, "default");
  assert.doesNotMatch(routeAssistant("vagas", assistants).reason, /marca/i);
});

// ---------- 6. Missões ----------
test("levaK: missões multi-dia persistidas com etapas, relatos, decisão e recibo", () => {
  const dataDir = tmp("mis");
  const missions = createMissions(dataDir);
  const m = missions.create({ title: "Site Oasis", goal: "Landing da linha de tênis em 5 dias" });
  missions.addStage(m.id, { title: "Wireframe" });
  missions.addStage(m.id, { title: "Visual" });
  missions.report(m.id, "Dia 1: wireframe pronto");
  const asked = missions.askDecision(m.id, { question: "Seguir com ouro ou azul?", options: ["ouro", "azul"] });
  assert.equal(asked.mission.status, "aguardando");
  missions.answerDecision(m.id, asked.decision.id, "ouro");
  const delivered = missions.deliver(m.id, "Landing entregue com ouro; recibo anexado.");
  assert.equal(delivered.status, "entregue");
  assert.ok(delivered.receipt && delivered.receipt.summary);
  assert.ok(fs.existsSync(path.join(dataDir, "missoes", `${m.id}.json`)));
});

// ---------- 7. Uso SDK sem inventar custo ----------
test("levaK: extractSdkUsage nunca inventa custo", () => {
  const onlyTokens = extractSdkUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(onlyTokens.costInformado, false);
  assert.match(onlyTokens.rotulo, /custo não informado/i);
  assert.equal(onlyTokens.tokens.totalTokens, 15);
  assert.match(formatUsageNote(onlyTokens), /não informado/i);

  const withCost = extractSdkUsage({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cost: { rawCostCents: 12.5, chargedCents: 10 },
  });
  assert.equal(withCost.costInformado, true);
  assert.equal(withCost.cost.chargedCents, 10);

  const empty = extractSdkUsage(null);
  assert.equal(empty.costInformado, false);
  assert.deepEqual(empty.tokens, {});
});

// ---------- 8. Drive, rotinas texto, Obsidian ----------
test("levaK: parser de rotinas em português", () => {
  const a = parseRoutineText("toda segunda às 9h verificar e-mail");
  assert.equal(a.clock, "09:00");
  assert.deepEqual(a.weekdays, [1]);
  assert.match(a.prompt, /e-mail/i);

  const b = parseRoutineText("a cada 30 minutos checar site");
  assert.equal(b.everyMinutes, 30);

  const c = parseRoutineText("seg a sex às 7:30 Morning Brief");
  assert.equal(c.clock, "07:30");
  assert.deepEqual(c.weekdays, [1, 2, 3, 4, 5]);

  assert.equal(parseClock("9h"), "09:00");
  assert.deepEqual(parseWeekdays("toda sexta"), [5]);
});

test("levaK: drive versionado e restaurar", () => {
  const dataDir = tmp("drv");
  const drive = createAgentDrive(dataDir);
  const v1 = drive.put({ agentId: "agt_x", name: "carta.md", content: "v1" });
  const v2 = drive.put({ agentId: "agt_x", name: "carta.md", content: "v2" });
  assert.ok(v2.version > v1.version);
  assert.equal(drive.versions("agt_x", v1.id).length, 2);
  const restored = drive.restore("agt_x", v1.id, v1.version);
  assert.equal(drive.read("agt_x", v1.id).content, "v1");
  assert.ok(restored.version >= 3);
});

test("levaK: importação Obsidian .md → memória", () => {
  const dataDir = tmp("obs");
  const vault = tmp("vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(vault, "Nota.md"), "# Projeto Oasis\nLinha de tênis premium.\n");
  fs.writeFileSync(path.join(vault, ".obsidian", "cfg.json"), "{}");
  const memory = createMemory(dataDir);
  const result = importObsidianVault(vault, { memory });
  assert.ok(result.imported >= 1);
  assert.ok(memory.list().some((m) => /Oasis|tênis|tenis/i.test(m.text)));
});

// ---------- 9. Skills ----------
test("levaK: frontmatter, carregamento progressivo, manifest, atribuição e aprovação MCP", async () => {
  const dataDir = tmp("skdata");
  const skillsDir = tmp("skdir");
  const bundleDir = path.join(__dirname, "..", "design", "skills");
  const fsSkills = createSkillFs({ dataDir, skillsDir, bundleDir, repoRoot: path.join(__dirname, "..") });

  const md = `---\nname: demo-skill\ndescription: Skill de teste local\nlicense: MIT\n---\nCorpo completo da skill.\n`;
  assert.equal(parseFrontmatter(md).name, "demo-skill");
  assert.equal(parseFrontmatter(md).description, "Skill de teste local");

  const local = path.join(tmp("localskill"), "demo-skill");
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "SKILL.md"), md);
  fs.writeFileSync(path.join(local, "LICENSE"), "MIT License");
  fsSkills.installLocalFolder(local, "demo-skill", { license: "MIT", source: "local-test" });

  const cat = fsSkills.catalog();
  assert.ok(cat.some((s) => /demo-skill/.test(s)));
  assert.ok(cat.some((s) => /de-slop-ui/.test(s)), "bundle design/skills sempre lido");

  fsSkills.assign("default", ["demo-skill", "de-slop-ui"]);
  const index = [].concat(fsSkills.promptIndex("default") || []).join("\n");
  assert.match(index, /demo-skill/);
  assert.doesNotMatch(index, /Corpo completo/);
  const body = fsSkills.loadBody("demo-skill");
  assert.match(String(body || ""), /Corpo completo/);

  fsSkills.ensureDefaults();
  const wake = fsSkills.assignments("lojas-wake");
  assert.ok(wake.includes("impeccable") || wake.includes("frontend-design") || wake.includes("de-slop-ui"));
  const helios = fsSkills.assignments("default");
  assert.ok(!helios.includes("revenue-centric-design"));
  const vagas = fsSkills.assignments("vagas");
  assert.ok(vagas.includes("agent-browser"));

  const pending = fsSkills.requestInstallApproval({
    name: "mcp-skill",
    sourceUrl: "https://example.com/skill",
    license: "MIT",
    kind: "github-repo",
  });
  assert.equal(pending.pending, true);
  assert.ok(pending.approvalId);
  assert.ok(fsSkills.listPendingInstalls().some((p) => p.approvalId === pending.approvalId));

  const skipped = KNOWN_SKILL_SOURCES.find((s) => s.name === "web-design-guidelines");
  assert.equal(skipped.licenseExpected, null);

  const man = fsSkills.listManifest();
  assert.ok(Array.isArray(man));
});

test("levaK: UI hold-to-approve e barra ouro só no item selecionado", () => {
  const agents = fs.readFileSync(path.join(__dirname, "..", "renderer", "agents.js"), "utf8");
  assert.match(agents, /holdRequired|HeliosHold|1\.5|1500/);
  assert.match(agents, /acaoExata|expiresAt|resolvi|handoff/);

  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.match(app, /HeliosHold|holdRequired/);
  assert.match(app, /\/api\/routines\/texto|\/api\/obsidian\/importar|\/api\/licoes/);

  const kit = fs.readFileSync(path.join(__dirname, "..", "renderer", "kit.css"), "utf8");
  assert.match(kit, /\.lf-it\.on::before/);
  const layout = fs.readFileSync(path.join(__dirname, "..", "renderer", "layout.css"), "utf8");
  assert.match(layout, /--lf-gold:\s*var\(--helios-ouro/);
  assert.doesNotMatch(layout, /\.lf-it\.on::before[^{]*\{[^}]*width:\s*2px/);
});
