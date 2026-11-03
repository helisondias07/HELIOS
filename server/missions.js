"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");

const STATUS = new Set(["planejando", "em_andamento", "aguardando", "entregue", "cancelada"]);
const STAGE_STATUS = new Set(["pendente", "em_andamento", "feita"]);
const DECISION_STATE = new Set(["aberta", "respondida"]);

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function createMissions(dataDir) {
  const dir = path.join(dataDir, "missoes");
  fs.mkdirSync(dir, { recursive: true });

  const fileOf = (id) => path.join(dir, `${id}.json`);

  function load(id) {
    const item = readJson(fileOf(id), null);
    if (!item || item.id !== id) return null;
    return item;
  }

  function save(item) {
    item.updatedAt = nowIso();
    writeJson(fileOf(item.id), item);
    return item;
  }

  function view(item) {
    return {
      id: item.id,
      title: item.title,
      goal: item.goal,
      assistantId: item.assistantId,
      status: item.status,
      stages: Array.isArray(item.stages) ? item.stages.map((s) => ({ ...s })) : [],
      reports: Array.isArray(item.reports) ? item.reports.map((r) => ({ ...r })) : [],
      decisions: Array.isArray(item.decisions) ? item.decisions.map((d) => ({ ...d })) : [],
      receipt: item.receipt || null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  function create(input = {}) {
    const title = String(input.title || "").trim().slice(0, 120);
    const goal = redact(String(input.goal || input.objetivo || "").trim()).slice(0, 800);
    if (title.length < 2) throw fail("Dê um título à missão.");
    if (goal.length < 4) throw fail("Descreva o objetivo da missão.");
    const item = {
      id: newId("mis"),
      title,
      goal,
      assistantId: String(input.assistantId || "default").slice(0, 40),
      status: "planejando",
      stages: [],
      reports: [],
      decisions: [],
      receipt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    save(item);
    return view(item);
  }

  function list({ assistantId, status } = {}) {
    const ids = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
    let rows = ids.map((id) => load(id)).filter(Boolean);
    if (assistantId) rows = rows.filter((item) => item.assistantId === String(assistantId));
    if (status) rows = rows.filter((item) => item.status === String(status));
    return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(view);
  }

  function requireMission(id) {
    const item = load(id);
    if (!item) throw fail("Missão não encontrada.", 404);
    return item;
  }

  function addStage(id, { title, notes = "" } = {}) {
    const item = requireMission(id);
    const stageTitle = String(title || "").trim().slice(0, 120);
    if (stageTitle.length < 2) throw fail("Dê um nome à etapa.");
    const stage = {
      id: newId("etp"),
      title: stageTitle,
      status: "pendente",
      notes: redact(String(notes || "").trim()).slice(0, 500),
    };
    item.stages.push(stage);
    if (item.status === "planejando") item.status = "em_andamento";
    save(item);
    return view(item);
  }

  function report(id, text) {
    const item = requireMission(id);
    const clean = redact(String(text || "").replace(/\s+/g, " ").trim()).slice(0, 1200);
    if (clean.length < 3) throw fail("Escreva o relatório.");
    item.reports.push({ at: nowIso(), text: clean });
    if (item.status === "planejando") item.status = "em_andamento";
    save(item);
    return view(item);
  }

  function askDecision(id, { question, options = [] } = {}) {
    const item = requireMission(id);
    const q = redact(String(question || "").trim()).slice(0, 400);
    if (q.length < 4) throw fail("Escreva a pergunta da decisão.");
    const opts = (Array.isArray(options) ? options : [options])
      .map((o) => redact(String(o || "").trim()).slice(0, 120))
      .filter(Boolean)
      .slice(0, 6);
    if (opts.length < 2) throw fail("Informe pelo menos duas opções.");
    const decision = {
      id: newId("dec"),
      question: q,
      options: opts,
      state: "aberta",
      answer: null,
      at: nowIso(),
    };
    item.decisions.push(decision);
    item.status = "aguardando";
    save(item);
    return { mission: view(item), decision: { ...decision } };
  }

  function answerDecision(id, decisionId, answer) {
    const item = requireMission(id);
    const decision = item.decisions.find((entry) => entry.id === decisionId);
    if (!decision) throw fail("Decisão não encontrada.", 404);
    const pick = redact(String(answer || "").trim()).slice(0, 120);
    if (!pick) throw fail("Escolha uma resposta.");
    if (!decision.options.includes(pick)) throw fail("Resposta precisa ser uma das opções.");
    decision.state = "respondida";
    decision.answer = pick;
    decision.at = nowIso();
    if (item.status === "aguardando" && !item.decisions.some((d) => d.state === "aberta")) {
      item.status = "em_andamento";
    }
    save(item);
    return view(item);
  }

  function deliver(id, summary) {
    const item = requireMission(id);
    const clean = redact(String(summary || "").replace(/\s+/g, " ").trim()).slice(0, 1200);
    if (clean.length < 4) throw fail("Escreva o resumo da entrega.");
    item.receipt = { summary: clean, at: nowIso() };
    item.status = "entregue";
    save(item);
    return view(item);
  }

  function cancel(id, reason = "") {
    const item = requireMission(id);
    if (item.status === "entregue") throw fail("Missão já entregue não pode ser cancelada.");
    item.status = "cancelada";
    const note = redact(String(reason || "").trim()).slice(0, 300);
    if (note) item.reports.push({ at: nowIso(), text: `Cancelada: ${note}` });
    save(item);
    return view(item);
  }

  return {
    create,
    list,
    view: (id) => {
      const item = load(id);
      return item ? view(item) : null;
    },
    addStage,
    report,
    askDecision,
    answerDecision,
    deliver,
    cancel,
    dir,
    STATUS,
    STAGE_STATUS,
    DECISION_STATE,
  };
}

module.exports = { createMissions };
