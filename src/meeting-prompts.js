"use strict";

let personal = "";
const PERSONAL_MAX = 8000;
function setPersonal(text) { personal = String(text || "").trim().slice(0, PERSONAL_MAX); }

function base(myContext, meeting) {
  return [
    "Você é o HELIOS, assistente de reuniões. Ajuda a preparar, acompanhar e fechar conversas ao vivo.",
    "Responda SEMPRE em português do Brasil, salvo quando pedirem uma fala em inglês — nesse caso traga EN: e PT:.",
    "Baseie-se só no contexto desta reunião (objetivo, pauta, transcrição, tela se houver). Não invente fatos, números, prazos, responsáveis, empresas ou decisões.",
    "Separe claramente o que é fato citado do que é só sugestão de fala. Sugestões começam com a palavra Sugestão.",
    myContext ? `Instruções do usuário: ${myContext}` : "",
    personal ? `Perfil opcional (use só se bater com a conversa; ignore campos [preencher]):\n"""\n${personal}\n"""` : "",
    meeting ? `Contexto desta reunião:\n${meeting}` : "",
  ].filter(Boolean).join("\n");
}

const MAX_CHARS = 3500;
function recent(lines) {
  const out = []; let n = 0;
  for (const l of (lines || []).slice().reverse()) { n += l.text.length + 10; if (n > MAX_CHARS) break; out.unshift(l); }
  return out;
}
function transcriptBlock(lines) {
  const t = recent(lines).map((l) => `${l.who === "me" ? "Você" : l.who === "them" ? "Outro(s)" : "Voz misturada"}: ${l.text}`).join("\n");
  return t ? `Transcrição recente ("Você" = microfone; "Outro(s)" = áudio do computador; pode ter erro de reconhecimento):\n"""\n${t}\n"""` : "Ainda não há transcrição.";
}

function translate(text) {
  return [
    { role: "system", content: "Traduza para português do Brasil, natural e fiel. Responda só com a tradução. Se já estiver em português, repita." },
    { role: "user", content: text },
  ];
}

function translateBatchPlain(items) {
  return [
    { role: "system", content: "Traduza cada linha numerada para português do Brasil, natural e fiel, sem resumir. Mantenha nomes próprios e termos técnicos. Responda SOMENTE com \"<número>| <tradução>\", uma por linha." },
    { role: "user", content: items.map((it, i) => `${i + 1}| ${it.text}`).join("\n") },
  ];
}
function translateBatch(items, extra = {}) {
  const messages = translateBatchPlain(items);
  const ctx = [extra && extra.formality, extra && extra.block].filter(Boolean).join("\n");
  if (!ctx) return messages;
  messages[0].content += `\n\nUse o contexto abaixo só para termos e tom. Não o traduza.\n${ctx}`;
  return messages;
}

function parseBatch(text, items) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[|.)-]\s*(.+)$/);
    if (m && items[Number(m[1]) - 1]) out.push({ id: items[Number(m[1]) - 1].id, pt: m[2].trim() });
  }
  return out;
}

const OUTRO_RULE = "Foque no que o(s) OUTRO(s) acabou de dizer. Se a última fala for sua, ajude a continuar a conversa.";
const SCREEN_NOTE = "Um print da janela/tela da reunião está anexado, só porque o usuário ligou o contexto de tela. Use o que for visível e relevante à conversa. Não descreva o computador inteiro. Não trate a tela como prova, teste ou gabarito.";

function suggest(lines, { myContext, lang, meeting, more = false, withScreen = false } = {}) {
  const english = lang === "en" || lang === "both";
  const style = english
    ? "Inglês natural e simples, o que alguém diria em voz alta numa reunião."
    : "Português do Brasil natural, de reunião. Nada de \"Claro!\" ou frase vazia.";
  const format = english
    ? "Formato: EN: <fala>\nPT: <tradução>. Sem lista, sem markdown."
    : "Formato: um ou dois parágrafos de fala. A melhor vem primeiro. Sem lista, sem markdown.";
  return [
    { role: "system", content: `${base(myContext, meeting)}\nVocê sugere o que a pessoa pode falar agora. Marque como Sugestão. Seja específico à transcrição. Proibido frase genérica. Não invente.` },
    { role: "user", content: `${transcriptBlock(lines)}
${withScreen ? SCREEN_NOTE : ""}

${OUTRO_RULE}
Sugestão de fala AGORA${more ? ", um pouco mais elaborada" : ""}. ${style}
${format}` },
  ];
}

function detectQuestion(text) {
  return [
    { role: "system", content: "Detecte se a fala contém uma pergunta dirigida a quem você está ajudando. Se sim, devolva só a pergunta em português, até 8 palavras. Se não, devolva exatamente NONE." },
    { role: "user", content: String(text || "").slice(0, 600) },
  ];
}
function parseDetect(text) {
  const t = String(text || "").trim().split(/\r?\n/)[0].replace(/^["'“]|["'”]$/g, "").trim();
  if (!t || /^none\.?$/i.test(t)) return "";
  return t.split(/\s+/).slice(0, 8).join(" ");
}

function sayEn(text, { myContext, meeting } = {}) {
  return [
    { role: "system", content: ["Traduza do português para o inglês o que a pessoa quer dizer numa reunião: inglês simples, curto, em primeira pessoa. Não acrescente informação.", myContext ? `Instruções: ${myContext}` : "", meeting ? `Contexto:\n${meeting}` : ""].filter(Boolean).join("\n") },
    { role: "user", content: `Formato:\nEN: <frase>\nPT: <o que ficou dito>\n\n"""\n${String(text || "").slice(0, 600)}\n"""` },
  ];
}

function followups(lines, { myContext, meeting } = {}) {
  return [
    { role: "system", content: `${base(myContext, meeting)}\nSugira perguntas de acompanhamento que a pessoa pode fazer. Só o que faz sentido com a transcrição. Se não houver base, diga isso.` },
    { role: "user", content: `${transcriptBlock(lines)}\n\nAté 4 perguntas curtas, uma por linha, começando com "- ". Sem inventar temas.` },
  ];
}

function insights(lines, { myContext, meeting } = {}) {
  return [
    { role: "system", content: `${base(myContext, meeting)}\nAjuda ao vivo: o que está em jogo agora, o que ficou em aberto e uma sugestão de fala. Distinga fato (citado) de sugestão.` },
    { role: "user", content: `${transcriptBlock(lines)}\n\nResponda em três parágrafos curtos: Fato. Aberto. Sugestão.` },
  ];
}

function explain(lines, { myContext, term, meeting } = {}) {
  return [
    { role: "system", content: base(myContext, meeting) },
    { role: "user", content: `${transcriptBlock(lines)}\n\n${term ? `Explique "${term}" no contexto desta conversa.` : "Explique o termo ou ponto mais recente desta conversa."}\nAté 5 frases. Se não estiver na transcrição, diga que não dá para afirmar.` },
  ];
}

function ask(lines, question, { myContext, withScreen, meeting } = {}) {
  return [
    { role: "system", content: `${base(myContext, meeting)}\nResponda à pergunta com base no contexto atual. Se for para falar, comece com Sugestão. Fatos só se estiverem na transcrição, na pauta ou na tela autorizada.` },
    { role: "user", content: `${transcriptBlock(lines)}
Pergunta: ${question}
${withScreen ? SCREEN_NOTE : ""}
Responda em português. Sem preâmbulo. Não invente.` },
  ];
}

function roteiro(lines, topic) {
  return [
    { role: "system", content: "Ajude a conduzir a reunião. Escreva perguntas em português, curtas, para A PESSOA fazer. Não responda no lugar dela e não invente fatos." },
    { role: "user", content: `${transcriptBlock(lines)}\n\n${topic ? `Tema: ${topic}\n` : ""}6 a 10 perguntas em frases, uma por parágrafo, só em português.` },
  ];
}

function summary(lines, { myContext, meeting } = {}) {
  return [
    { role: "system", content: base(myContext, meeting) },
    { role: "user", content: `${transcriptBlock(lines)}\n\nResumo corrido do que já foi dito: temas, decisões citadas e próximos passos só se mencionados. Se ainda não há transcrição, diga isso.` },
  ];
}

module.exports = {
  setPersonal, PERSONAL_MAX, recent, transcriptBlock,
  translateBatch, parseBatch, translate, suggest, detectQuestion, parseDetect,
  sayEn, followups, insights, explain, ask, summary, roteiro,
};
