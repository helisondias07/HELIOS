"use strict";

/**
 * Próxima ação pedida ao modelo grátis, com a página em texto (e a foto, se houver).
 * O prompt não leva nome, e-mail, telefone nem CPF. O modelo devolve placeholders;
 * os valores reais só são colocados aqui, no código.
 * A resposta do modelo nunca conta como candidatura enviada.
 */

const { cleanLabel, cartaDeApresentacao } = require("./jobs-fill");
const { desafioVisivel } = require("./captcha-visivel");
const regras = require("./vagas-regras");

const SYSTEM = [
  "Você olha uma página de candidatura e escolhe UMA próxima ação.",
  "Responda só JSON: {\"acao\":\"clicar\"|\"preencher\"|\"esperar\"|\"rolar\"|\"email\"|\"pausar\"|\"nada\",\"alvo\":\"texto visível do botão, rótulo do campo ou e-mail\",\"valor\":\"{{NOME}}|{{EMAIL}}|{{TELEFONE}}|{{CIDADE}}|{{ESTADO}}|{{LINKEDIN}}|{{PRETENSAO}}|{{CV}}|{{CARTA}}\",\"motivo\":\"curto\"}.",
  "Não invente nome, e-mail, telefone, CPF nem endereço. Não diga que a candidatura foi enviada.",
  "Carta de apresentação ou cover letter: preencha com {{CARTA}} e depois clique em Continuar.",
  "O selo do rodapé 'protegido pelo reCAPTCHA' NÃO é captcha. Só use acao=pausar para captcha se houver um desafio visível: checkbox, iframe de desafio ou quebra-cabeça.",
  "Pedido de login ou 2FA: acao=pausar. Não clique em mensagem, InMail, conectar ou seguir.",
].join(" ");

const PLACEHOLDERS = ["{{NOME}}", "{{EMAIL}}", "{{TELEFONE}}", "{{CIDADE}}", "{{ESTADO}}", "{{LINKEDIN}}", "{{PRETENSAO}}", "{{CV}}", "{{CARTA}}"];

function scrub(text, secrets = []) {
  let out = String(text || "");
  for (const secret of secrets) {
    const value = String(secret || "").trim();
    if (value.length >= 3) out = out.split(value).join("[oculto]");
  }
  return out.replace(/\s+/g, " ").trim();
}

function publicSnapshot(snapshot = {}, secrets = []) {
  return {
    url: scrub(snapshot.url, secrets).slice(0, 300),
    titulo: scrub(snapshot.title, secrets).slice(0, 140),
    texto: scrub(snapshot.text, secrets).slice(0, 1800),
    captcha: desafioVisivel(snapshot),
    campos: (snapshot.fields || []).slice(0, 20).map((field) => ({
      rotulo: scrub(field.label || field.ariaLabel || field.name || "", secrets).slice(0, 80),
      tipo: String(field.type || "text").slice(0, 20),
      obrigatorio: Boolean(field.required),
    })).filter((field) => field.rotulo),
    botoes: (snapshot.buttons || []).slice(0, 20).map((button) => scrub(button.text || button.ariaLabel || button.testId || "", secrets).slice(0, 80)).filter(Boolean),
  };
}

function parseAction(content) {
  const match = String(content || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[0]); } catch { return null; }
  const acao = String(data.acao || data.action || "").toLowerCase();
  if (!["clicar", "preencher", "esperar", "pausar", "nada", "rolar", "email"].includes(acao)) return null;
  return {
    acao,
    alvo: String(data.alvo || data.target || "").replace(/\s+/g, " ").trim().slice(0, 120),
    valor: String(data.valor || data.value || "").trim().slice(0, 160),
    motivo: String(data.motivo || data.reason || "").replace(/\s+/g, " ").trim().slice(0, 180),
  };
}

function resolveValor(valor, profile = {}, job = {}) {
  const table = {
    "{{NOME}}": profile.nome || "",
    "{{EMAIL}}": profile.email || "",
    "{{TELEFONE}}": profile.telefone || "",
    "{{CIDADE}}": profile.cidade || "",
    "{{ESTADO}}": profile.estado || "",
    "{{LINKEDIN}}": profile.linkedin || "",
    "{{PRETENSAO}}": regras.pretensao(job, profile),
    "{{CV}}": profile.cvPath || "",
    "{{CARTA}}": cartaDeApresentacao(job, profile),
  };
  let out = String(valor || "").trim();
  if (!out) return "";
  if (PLACEHOLDERS.some((token) => out.includes(token))) {
    for (const [token, value] of Object.entries(table)) out = out.split(token).join(String(value || ""));
    return out.trim();
  }
  if (/@|\bcpf\b|\d{8,}/i.test(out)) return "";
  if (out.length > 80) return "";
  return out;
}

function buttonFor(snapshot, alvo) {
  const want = cleanLabel(alvo);
  if (!want) return null;
  const buttons = snapshot.buttons || [];
  return buttons.find((button) => cleanLabel(button.text || button.ariaLabel || "") === want)
    || buttons.find((button) => cleanLabel(`${button.text || ""} ${button.ariaLabel || ""} ${button.testId || ""}`).includes(want))
    || null;
}

function fieldFor(snapshot, alvo) {
  const want = cleanLabel(alvo);
  if (!want) return null;
  const fields = snapshot.fields || [];
  return fields.find((field) => cleanLabel(field.label || field.name || "") === want)
    || fields.find((field) => cleanLabel(`${field.label || ""} ${field.name || ""}`).includes(want))
    || null;
}

function messagesFor(snapshot, secrets = []) {
  const page = publicSnapshot(snapshot, secrets);
  const text = JSON.stringify(page);
  const user = snapshot.screenshot
    ? [{ type: "text", text }, { type: "image_url", image_url: { url: String(snapshot.screenshot).slice(0, 1_200_000) } }]
    : text;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

async function askNextAction(llm, snapshot = {}, secrets = []) {
  if (!llm || typeof llm.chat !== "function") return null;
  const messages = messagesFor(snapshot, secrets);
  const roles = snapshot.screenshot ? ["visao", "extracao"] : ["extracao"];
  let lastError = "";
  for (const role of roles) {
    const payload = role === "visao" ? messages : [
      messages[0],
      { role: "user", content: typeof messages[1].content === "string" ? messages[1].content : messages[1].content[0].text },
    ];
    try {
      const response = await llm.chat({ agent: "vagas", role, messages: payload });
      const action = parseAction(response && response.message && response.message.content);
      if (action) return { action, model: response.model || null, via: "visao" };
    } catch (error) {
      lastError = String(error && error.message || error).slice(0, 160);
    }
  }
  return { action: null, model: null, via: "visao", erro: lastError };
}

module.exports = {
  SYSTEM,
  publicSnapshot,
  parseAction,
  resolveValor,
  buttonFor,
  fieldFor,
  messagesFor,
  askNextAction,
  scrub,
};
