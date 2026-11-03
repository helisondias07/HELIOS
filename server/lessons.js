"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");

const STATES = new Set(["pending", "accepted", "refused"]);

const normMotivo = (text) =>
  String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function createLessons(dataDir, { memory } = {}) {
  const file = path.join(dataDir, "lessons.json");
  const saved = readJson(file, { version: 1, items: [] });
  const items = Array.isArray(saved.items) ? saved.items : [];
  const save = () => writeJson(file, { version: 1, items });

  const get = (id) => items.find((entry) => entry.id === id) || null;

  function propose({ agentId, assistantId, text, source = "agente" }) {
    const clean = redact(String(text || "").replace(/\s+/g, " ").trim()).slice(0, 800);
    if (clean.length < 6) throw fail("A lição precisa de pelo menos uma frase.");
    const item = {
      id: newId("lic"),
      agentId: String(agentId || "").slice(0, 40) || null,
      assistantId: String(assistantId || "default").slice(0, 40),
      text: clean,
      source: String(source || "agente").slice(0, 40),
      state: "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    items.unshift(item);
    save();
    return { ...item };
  }

  function accept(id) {
    const item = get(id);
    if (!item) throw fail("Lição não encontrada.", 404);
    if (item.state === "accepted") return { ...item };
    item.state = "accepted";
    item.updatedAt = nowIso();
    if (memory && typeof memory.remember === "function") {
      memory.remember({ text: item.text, kind: "regra", source: `licao:${item.source}` });
    }
    save();
    return { ...item };
  }

  function refuse(id) {
    const item = get(id);
    if (!item) throw fail("Lição não encontrada.", 404);
    item.state = "refused";
    item.updatedAt = nowIso();
    save();
    return { ...item };
  }

  function list({ assistantId, pending } = {}) {
    let rows = items.map((entry) => ({ ...entry }));
    if (assistantId) rows = rows.filter((entry) => entry.assistantId === String(assistantId));
    if (pending === true) rows = rows.filter((entry) => entry.state === "pending");
    return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function fromDenial({ agentId, assistantId, approvalResumo, motivo }) {
    const resumo = redact(String(approvalResumo || "").replace(/\s+/g, " ").trim()).slice(0, 200);
    const why = redact(String(motivo || "").replace(/\s+/g, " ").trim()).slice(0, 300);
    if (!why) throw fail("Informe o motivo da recusa.");
    const text = resumo
      ? `Quando ${resumo}, não repetir: ${why}.`
      : `Evitar repetir este erro: ${why}.`;
    return propose({ agentId, assistantId, text, source: "recusa-aprovacao" });
  }

  function fromError({ agentId, assistantId, error }) {
    const msg = redact(String(error?.message || error || "").replace(/\s+/g, " ").trim()).slice(0, 300);
    if (msg.length < 4) throw fail("Erro vazio demais para virar lição.");
    const text = `Corrigir falha recente: ${msg}`;
    return propose({ agentId, assistantId, text, source: "erro-agente" });
  }

  function recordJobRefusal({ assistantId, motivo }) {
    const why = redact(String(motivo || "").replace(/\s+/g, " ").trim()).slice(0, 300);
    if (!why) throw fail("Informe o motivo da recusa da vaga.");
    return propose({
      assistantId,
      text: `Motivo de recusa de vaga: ${why}`,
      source: "vagas-recusa",
    });
  }

  function jobRefusalPatterns(assistantId) {
    const key = String(assistantId || "");
    const counts = new Map();
    for (const item of items) {
      if (item.source !== "vagas-recusa") continue;
      if (key && item.assistantId !== key) continue;
      const motivo = normMotivo(item.text.replace(/^Motivo de recusa de vaga:\s*/i, ""));
      if (!motivo) continue;
      counts.set(motivo, (counts.get(motivo) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([motivo, count]) => ({ motivo, count }))
      .sort((a, b) => b.count - a.count || a.motivo.localeCompare(b.motivo));
  }

  return {
    propose,
    accept,
    refuse,
    list,
    fromDenial,
    fromError,
    recordJobRefusal,
    jobRefusalPatterns,
    file,
    states: STATES,
  };
}

module.exports = { createLessons, normMotivo };
