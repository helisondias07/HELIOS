"use strict";
/**
 * Hotfix status do card: com pendência do usuário (handoff, aprovação, decisão de missão)
 * o status público é waiting_you ("Aguardando você"), nunca done — mesmo após o worker terminar.
 * Ao resolver a pendência, volta ao status real.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createAgentRuntime, hasUserPending, derivedStatus,
} = require("../server/agent-runtime");
const { createMockAgent } = require("../server/mock-agent");
const { createMissions } = require("../server/missions");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-hotfix-status-${p}-`));

function makeRuntime(extra = {}) {
  const dataDir = tmp("data");
  const workRoot = tmp("work");
  const rt = createAgentRuntime({
    dataDir,
    workRoot,
    allowedRoots: [],
    blockedRoots: [dataDir],
    browser: { exec: async () => ({ ok: true }), close: () => {}, closeAll: () => {} },
    openWorker: async ({ tools }) => ({ agent: createMockAgent({ tools }), mock: true }),
    approvalTtlMin: 30,
    ...extra,
  });
  return { rt, dataDir, workRoot };
}

/** Força worker "já terminou" com pendência ainda aberta (o bug clássico do card). */
function markDoneWithPending(rec, { handoff, approval, mission } = {}) {
  rec.status = "done";
  rec.result = "Pronto (worker terminou).";
  rec.motivo = "";
  rec.waitingFor = null;
  if (handoff) {
    rec.browserHandoff = { reason: "captcha/2FA", at: new Date().toISOString(), state: "waiting" };
  }
  if (approval) {
    rec.approvals = rec.approvals || [];
    rec.approvals.push({
      id: "apr_hotfix01",
      tipo: "apagar",
      resumo: "Apagar arquivo de teste",
      detalhe: "x",
      state: "pending",
      at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      action: { op: "noop" },
    });
  }
  if (mission) {
    rec.missionDecisions = rec.missionDecisions || [];
    rec.missionDecisions.push({
      id: "dec_hotfix01",
      question: "Seguir com ouro ou azul?",
      options: ["ouro", "azul"],
      state: "aberta",
      answer: null,
      at: new Date().toISOString(),
      missionId: mission.id || "mis_x",
    });
  }
}

test("hotfix status: helpers hasUserPending / derivedStatus", () => {
  const base = { status: "done", approvals: [], questions: [], missionDecisions: [] };
  assert.equal(hasUserPending(base), false);
  assert.equal(derivedStatus(base), "done");
  assert.equal(derivedStatus({ ...base, browserHandoff: { state: "waiting" } }), "waiting_you");
  assert.equal(derivedStatus({ ...base, approvals: [{ state: "pending" }] }), "waiting_you");
  assert.equal(derivedStatus({ ...base, missionDecisions: [{ state: "aberta" }] }), "waiting_you");
  assert.equal(derivedStatus({ ...base, missionDecisions: [{ state: "respondida" }] }), "done");
});

test("hotfix status: handoff captcha → Aguardando você mesmo com worker done; resolve volta ao real", async () => {
  const { rt } = makeRuntime();
  const a = rt.create({ tarefa: "Abra o site e espere o captcha" });
  await rt.pause(a.id);
  const rec = rt._agents.get(a.id);
  markDoneWithPending(rec, { handoff: true });
  const view = rt.view(a.id);
  assert.equal(view.status, "waiting_you", "card não pode mostrar Concluído com captcha pendente");
  assert.equal(view.statusReal, "done");
  assert.ok(view.handoff && view.handoff.state === "waiting");
  assert.ok(view.pendentes >= 1);

  const after = await rt.resolveHandoff(a.id);
  assert.equal(after.status, "done", "sem pendência, volta ao status real (done)");
  assert.ok(!after.handoff || after.handoff.state !== "waiting");
});

test("hotfix status: aprovação pendente → Aguardando você; após decidir (worker done) não fica Concluído cedo demais na lista", async () => {
  const { rt } = makeRuntime();
  const a = rt.create({ tarefa: "Organize arquivos e peça aprovação" });
  await rt.pause(a.id);
  const rec = rt._agents.get(a.id);
  markDoneWithPending(rec, { approval: true });
  const view = rt.view(a.id);
  assert.equal(view.status, "waiting_you");
  assert.equal(view.statusReal, "done");
  assert.ok(view.approvals.some((x) => x.state === "pending"));

  const listed = rt.list().find((x) => x.id === a.id);
  assert.equal(listed.status, "waiting_you", "lista lateral também deriva");

  // Limpa aprovação sem reenfileirar: simula resolução pura do card.
  const card = rec.approvals.find((x) => x.state === "pending");
  card.state = "denied";
  rec.motivo = "";
  const cleared = rt.view(a.id);
  assert.equal(cleared.status, "done", "volta ao status real após resolver aprovação");
});

test("hotfix status: decisão de missão → Aguardando você; answerMission volta ao real", async () => {
  const { rt, dataDir } = makeRuntime();
  const missions = createMissions(dataDir);
  const m = missions.create({ title: "Site Oasis", goal: "Landing da linha em 5 dias" });
  const asked = missions.askDecision(m.id, { question: "Seguir com ouro ou azul?", options: ["ouro", "azul"] });
  assert.equal(asked.mission.status, "aguardando");

  const a = rt.create({ tarefa: "Toque a missão Oasis" });
  await rt.pause(a.id);
  const rec = rt._agents.get(a.id);
  markDoneWithPending(rec, { mission: { id: m.id } });
  // Também via missionId + callback (como no server/index.js)
  rec.missionId = m.id;

  const rt2 = createAgentRuntime({
    dataDir: tmp("data2"),
    workRoot: tmp("work2"),
    allowedRoots: [],
    blockedRoots: [],
    browser: { exec: async () => ({ ok: true }), close: () => {}, closeAll: () => {} },
    openWorker: async ({ tools }) => ({ agent: createMockAgent({ tools }), mock: true }),
    missionPending: (r) => {
      if (!r.missionId) return false;
      const miss = missions.view(r.missionId);
      return Boolean(miss && miss.status === "aguardando" && (miss.decisions || []).some((d) => d.state === "aberta"));
    },
  });
  // Reusa o mesmo rec injetando no segundo runtime via create + overlay
  const b = rt2.create({ tarefa: "Missão com decisão" });
  await rt2.pause(b.id);
  const recB = rt2._agents.get(b.id);
  recB.status = "done";
  recB.result = "Etapa pronta.";
  recB.missionId = m.id;
  recB.missionDecisions = [{
    id: asked.decision.id,
    question: asked.decision.question,
    options: asked.decision.options,
    state: "aberta",
    at: asked.decision.at,
    missionId: m.id,
  }];

  const waiting = rt2.view(b.id);
  assert.equal(waiting.status, "waiting_you", "decisão de missão força Aguardando você");
  assert.equal(waiting.statusReal, "done");

  const done = rt2.answerMission(b.id, asked.decision.id, "ouro");
  assert.equal(done.status, "done", "após responder a decisão, volta ao status real");
  assert.ok(!(done.missionDecisions || []).some((d) => d.state === "aberta"));
});

test("hotfix status: UI agents.js usa cardStatus / Aguardando você", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "agents.js"), "utf8");
  assert.match(src, /function cardStatus/);
  assert.match(src, /Aguardando você/);
  assert.match(src, /handoff\.state === "waiting"/);
  assert.match(src, /missionDecisions/);
  assert.match(src, /statusReal/);
});
