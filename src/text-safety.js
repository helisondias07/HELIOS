"use strict";

const { redact } = require("../server/util");

const STOP = new Set("a o e de da do das dos em no na nos nas um uma para pra por com sem que se ao aos as os ou mais como quando onde qual eu voce vc me te ja nao sim tem ser estar the and of to in is it on for".split(" "));

function tokens(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

function unsafeReason(text) {
  const value = String(text || "");
  if (/\b(sk-|gsk_|crsr_|key_|ghp_|glpat-|figd_|AIza)[\w-]{8,}/i.test(value)) return "parece uma chave ou token";
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(value)) return "tem um e-mail";
  if (/\b(?:senha|password)\b\s*[:=]/i.test(value)) return "parece uma senha";
  if (/\b[A-Za-z0-9+/_-]{40,}\b/.test(value)) return "parece um segredo";
  if (redact(value) !== value) return "parece conter senha, chave ou token";
  return "";
}

module.exports = { tokens, unsafeReason, STOP };
