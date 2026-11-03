"use strict";

/**
 * LEVA M: candidatura por e-mail via Gmail.
 * Só o primeiro e-mail; CV anexado; conferir Enviados; assunto "Cargo | Helison Dias".
 * Envio real passa pela aprovação/irreversível do HELIOS (nunca dispara sozinho daqui).
 */

function emailSubject(cargo, nome = "Helison Dias") {
  const title = String(cargo || "Candidatura").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${title} | ${nome}`;
}

function alreadySentTo(sentList = [], to = "") {
  const want = String(to || "").trim().toLowerCase();
  if (!want) return false;
  return (sentList || []).some((m) => {
    const dest = String(m.to || m.destino || "").toLowerCase();
    return dest.includes(want) || want.includes(dest.split(",")[0].trim());
  });
}

function buildDraft({ cargo, to, body, cvPath, lang = "pt", nome = "Helison Dias" } = {}) {
  const subject = emailSubject(cargo, nome);
  const defaultBody = lang === "en"
    ? `Hello,\n\nI'm interested in the ${cargo} role. My CV is attached.\n\nBest regards,\n${nome}`
    : `Olá,\n\nTenho interesse na vaga de ${cargo}. Segue meu currículo em anexo.\n\nObrigado,\n${nome}`;
  return {
    to: String(to || "").trim(),
    subject,
    body: String(body || defaultBody).slice(0, 8000),
    cvPath: String(cvPath || ""),
    firstOnly: true,
  };
}

/**
 * Prepara envio: checa Enviados; devolve rascunho + precisaAprovacao.
 * Nunca envia — o caller deve passar pelo cartão irreversível.
 */
async function prepareEmailApply({
  cargo,
  to,
  body,
  cvPath,
  lang,
  nome,
  listSent = async () => [],
} = {}) {
  const draft = buildDraft({ cargo, to, body, cvPath, lang, nome });
  if (!draft.to) return { ok: false, error: "Informe o e-mail de destino." };
  if (!draft.cvPath) return { ok: false, error: "Falta o caminho do CV." };
  let sent = [];
  try { sent = await listSent(draft.to); } catch (e) {
    return { ok: false, error: `Não consegui ler os Enviados: ${e.message}` };
  }
  if (alreadySentTo(sent, draft.to)) {
    return { ok: false, error: "Já existe e-mail nos Enviados para este endereço. Só o primeiro é permitido.", duplicado: true };
  }
  return {
    ok: true,
    draft,
    precisaAprovacao: true,
    acaoExata: `Enviar e-mail de candidatura para ${draft.to} com assunto “${draft.subject}” e CV anexado.`,
  };
}

/** Envia de fato, sem cartão. O caller injeta o envio (Gmail). Confirmação só se o envio voltar. */
async function sendEmailApply({ cargo, to, body, cvPath, lang, nome, listSent = async () => [], send } = {}) {
  const prepared = await prepareEmailApply({ cargo, to, body, cvPath, lang, nome, listSent });
  if (!prepared.ok) return prepared;
  if (typeof send !== "function") return { ok: false, error: "Envio de e-mail indisponível." };
  await send(prepared.draft);
  return {
    ok: true,
    enviado: true,
    confirmacao: `E-mail enviado para ${prepared.draft.to} com o CV em anexo.`,
    draft: { to: prepared.draft.to, subject: prepared.draft.subject },
  };
}

module.exports = {
  emailSubject,
  alreadySentTo,
  buildDraft,
  prepareEmailApply,
  sendEmailApply,
};
