"use strict";

/**
 * Client ids do aplicativo, não do usuário. O Helison preenche uma vez
 * (arquivo do build, arquivo na pasta de dados ou variável de ambiente).
 * A tela de Conectores não pede esses valores. Segredo de cliente só existe
 * para o Slack, que não aceita cliente público.
 */
const fs = require("node:fs");
const path = require("node:path");

const GOOGLE_RE = /^[0-9A-Za-z-]{6,120}\.apps\.googleusercontent\.com$/;
const PUBLIC_RE = /^[A-Za-z0-9._-]{8,100}$/;
const SECRET_RE = /^[A-Za-z0-9._-]{8,200}$/;

function readObject(file) {
  if (!file) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function clean(value) {
  return String(value || "").trim();
}

function accept(value, re) {
  if (!value || !re.test(value) || /secret|gsk_|crsr_|cursor_|AIza/i.test(value)) return "";
  return value;
}

function normalizeOAuthClients(raw = {}) {
  return {
    google: accept(clean(raw.google), GOOGLE_RE),
    github: accept(clean(raw.github), PUBLIC_RE),
    slack: accept(clean(raw.slack), PUBLIC_RE),
    slackSecret: accept(clean(raw.slackSecret), SECRET_RE),
  };
}

function firstValid(values, re) {
  for (const value of values) {
    const accepted = accept(clean(value), re);
    if (accepted) return accepted;
  }
  return "";
}

function loadOAuthClients({ file, userFile, env = process.env } = {}) {
  const shippedPath = file || path.join(__dirname, "..", "config", "oauth-clients.json");
  const shipped = readObject(shippedPath);
  const user = readObject(userFile);
  return {
    google: firstValid([env.HELIOS_GOOGLE_CLIENT_ID, user.google, shipped.google], GOOGLE_RE),
    github: firstValid([env.HELIOS_GITHUB_CLIENT_ID, user.github, shipped.github], PUBLIC_RE),
    slack: firstValid([env.HELIOS_SLACK_CLIENT_ID, user.slack, shipped.slack], PUBLIC_RE),
    slackSecret: firstValid([env.HELIOS_SLACK_CLIENT_SECRET, user.slackSecret, shipped.slackSecret], SECRET_RE),
  };
}

module.exports = { loadOAuthClients, normalizeOAuthClients };
