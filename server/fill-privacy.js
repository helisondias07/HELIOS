"use strict";

/**
 * LEVA R: preenchimento de candidatura com modelo gratis SEM dado pessoal no prompt.
 * O modelo recebe so a vaga e os rotulos dos campos; campos pessoais viram placeholders
 * ({{CPF}}, {{TELEFONE}}, {{ENDERECO}}, {{CV}} ...) que o codigo troca pelos valores do cofre.
 */

const PLACEHOLDERS = [
  { ph: "{{CPF}}", re: /\bcpf\b/i, key: "cpf" },
  { ph: "{{TELEFONE}}", re: /(telefone|celular|phone|mobile|whatsapp)/i, key: "telefone" },
  { ph: "{{ENDERECO}}", re: /(endere[cç]o|address|cep|zip|logradouro|bairro)/i, key: "endereco" },
  { ph: "{{CV}}", re: /(curr[ií]culo|resume|\bcv\b)/i, key: "cvPath", file: true },
  { ph: "{{EMAIL}}", re: /e-?mail/i, key: "email" },
  { ph: "{{NOME}}", re: /^(nome( completo)?|full name|name)$/i, key: "nome" },
];

function placeholderFor(field) {
  const label = String((field && (field.label || field.name)) || "").trim();
  if (field && field.type === "file") return PLACEHOLDERS.find((p) => p.key === "cvPath");
  return PLACEHOLDERS.find((p) => p.re.test(label)) || null;
}

/** Mensagens para o modelo: so vaga + campos. Campos pessoais ja chegam marcados como placeholder. */
function buildFillMessages(vaga = {}, fields = []) {
  const campos = fields.map((f, i) => {
    const p = placeholderFor(f);
    return { i, rotulo: String(f.label || f.name || "").slice(0, 120), tipo: f.type || "text", opcoes: Array.isArray(f.options) ? f.options.slice(0, 20) : undefined, ...(p ? { valor_fixo: p.ph } : {}) };
  });
  const v = { titulo: vaga.title || vaga.titulo || "", empresa: vaga.company || vaga.empresa || "", descricao: String(vaga.description || vaga.descricao || "").slice(0, 6000) };
  return [
    { role: "system", content: "Voce preenche formularios de candidatura. Para campos com valor_fixo, devolva exatamente o placeholder. Nunca invente CPF, telefone, endereco ou e-mail. Responda so JSON: {\"respostas\":[{\"i\":0,\"valor\":\"...\"}]}." },
    { role: "user", content: JSON.stringify({ vaga: v, campos }) },
  ];
}

/** Troca placeholders pelos valores do cofre/perfil (fora do modelo). Campo pessoal sempre vem do cofre, ignorando o modelo. */
function resolveFill(fields = [], respostas = [], secrets = {}) {
  const byI = new Map((respostas || []).map((r) => [Number(r.i), r.valor]));
  const acoes = [];
  const faltando = [];
  fields.forEach((f, i) => {
    const p = placeholderFor(f);
    if (p) {
      const val = String(secrets[p.key] || "").trim();
      if (val) acoes.push({ sel: f.sel, kind: p.file ? "file" : "text", valor: val });
      else if (f.required) faltando.push(p.ph);
      return;
    }
    const v = byI.get(i);
    if (v === undefined || v === null || v === "") { if (f.required) faltando.push(f.label || f.name); return; }
    let s = String(v);
    for (const q of PLACEHOLDERS) if (s.includes(q.ph)) s = s.split(q.ph).join(String(secrets[q.key] || ""));
    acoes.push({ sel: f.sel, kind: f.type === "select" ? "select" : "text", valor: s });
  });
  return { acoes, faltando };
}

/** Fluxo completo: chama o modelo (agente vagas) e resolve no codigo. */
async function planFillLlm(llm, vaga, fields, secrets = {}) {
  const r = await llm.chat({ agent: "vagas", messages: buildFillMessages(vaga, fields) });
  let respostas = [];
  try { const m = String(r.message.content || "").match(/\{[\s\S]*\}/); respostas = m ? JSON.parse(m[0]).respostas || [] : []; } catch { respostas = []; }
  return { ...resolveFill(fields, respostas, secrets), model: r.model };
}

module.exports = { PLACEHOLDERS, placeholderFor, buildFillMessages, resolveFill, planFillLlm };
