"use strict";

const { redact } = require("./util");

/** O que o agente pode saber sobre o cofre: nomes de login, nunca senha, token ou usuário. */
function agentIndex(entries) {
  return (entries || [])
    .filter((entry) => entry && entry.tipo === "login" && entry.nome)
    .map((entry) => ({ id: String(entry.id || ""), nome: redact(String(entry.nome)) }));
}

function vaultPrompt(entries) {
  const names = agentIndex(entries).map((entry) => entry.nome);
  if (!names.length) return "Nenhum login no cofre.";
  return `Logins no cofre (somente os nomes, sem senha): ${names.join(", ")}. Para preencher um deles na janela em foco, chame helios_preencher_login com o nome. Você não recebe a senha.`;
}

/** Resposta da ferramenta. Ignora qualquer campo extra — a senha não volta. */
function fillMessage(nome, result) {
  const label = String(nome || "login").slice(0, 80);
  if (result && result.ok) return `Preenchi o login "${label}" na janela em foco. A senha não sai do cofre e não volta para você.`;
  return `Não consegui preencher o login "${label}".`;
}

module.exports = { agentIndex, vaultPrompt, fillMessage };
