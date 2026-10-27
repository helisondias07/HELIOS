"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { classify, LEVELS } = require("./router");

const PRICES = JSON.parse(fs.readFileSync(path.join(__dirname, "model-prices.json"), "utf8"));
const COMPOSER = "composer-2.5";
const GROK = "grok-4.5";
const PREFS = { rapido: [COMPOSER], padrao: [COMPOSER], avancado: [GROK, COMPOSER] };

function priceOf(id) {
  const models = PRICES.models;
  if (!id) return null;
  if (models[id]) return models[id];
  const base = Object.keys(models)
    .filter((k) => String(id).startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return base ? models[base] : null;
}

const labelOf = (id) => priceOf(id)?.label || String(id || "?");

/** Custo estimado em centavos de dólar. Com sdk:true, inputTokens já inclui o cache. */
function estimateCents(id, usage, { sdk = false } = {}) {
  const price = priceOf(id);
  if (!price || !usage) return null;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  let input = Number(usage.inputTokens) || 0;
  if (sdk) input = Math.max(0, input - cacheRead - cacheWrite);
  const output = Number(usage.outputTokens) || 0;
  const usd =
    (input * price.input + cacheWrite * (price.cacheWrite ?? price.input) + cacheRead * price.cacheRead + output * price.output) / 1e6;
  return Math.round(usd * 100 * 100) / 100;
}

/** Nunca a variante rápida: fast=false quando o modelo aceita o parâmetro. */
function selectionFor(id) {
  return { id, params: [{ id: "fast", value: "false" }] };
}

function pickFor(level, catalog) {
  const prefs = PREFS[level] || PREFS.padrao;
  if (!Array.isArray(catalog) || !catalog.length) return prefs[0];
  const has = (id) => catalog.some((m) => m.id === id || (m.aliases || []).includes(id));
  return prefs.find(has) || COMPOSER;
}

function chooseModel({ text = "", override = null, catalog = null } = {}) {
  const classified = classify(text);
  let level = classified.level;
  if (override && override !== "auto" && LEVELS.includes(override)) level = override;
  const id = pickFor(level, catalog);
  const auto = !override || override === "auto";
  const reason = id === GROK ? "Grok para trabalho grande" : "Composer 2.5 para o dia a dia";
  return {
    id,
    label: labelOf(id),
    selection: selectionFor(id),
    reason: auto ? reason : `${reason} (nível escolhido)`,
    auto,
    level,
    kind: classified.kind,
    classReason: classified.reason,
  };
}

function referenceEstimates() {
  return [COMPOSER, GROK].map((id) => ({
    id,
    label: labelOf(id),
    cents: estimateCents(id, PRICES.referenceTask),
  }));
}

module.exports = {
  COMPOSER,
  GROK,
  PRICES,
  priceOf,
  labelOf,
  estimateCents,
  selectionFor,
  chooseModel,
  pickFor,
  referenceEstimates,
};
