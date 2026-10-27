"use strict";

/**
 * Segredos lidos do ambiente uma vez e apagados de process.env, para um
 * comando do agente não herdar CURSOR_API_KEY / Groq / Gemini.
 * A senha do cofre nunca entra aqui.
 */
const { setSecretValues } = require("./secret-values");

const KEYS = ["CURSOR_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY"];
const vault = {};

function captureSecrets(env = process.env) {
  for (const key of KEYS) {
    const value = String(env[key] || "").trim();
    if (value) vault[key] = value;
    delete env[key];
  }
  // Fase 3: essas chaves também nunca podem aparecer num texto que vai ao modelo, ao histórico ou a um log.
  setSecretValues("env", Object.values(vault));
}

function secret(key) {
  return vault[key] || "";
}

function hasSecret(key) {
  return Boolean(vault[key]);
}

module.exports = { KEYS, captureSecrets, secret, hasSecret };
