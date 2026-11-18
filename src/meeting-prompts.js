"use strict";

const { redact } = require("../server/util");

let personal = "";
const PERSONAL_MAX = 8000;
function setPersonal(text) { personal = String(text || "").trim().slice(0, PERSONAL_MAX); }

function base(myContext, meeting) {
  return [
    "Você é o HELIOS, copiloto de reuniões e entrevistas técnicas em tempo real.",
    "Responda SEMPRE em português do Brasil, salvo quando pedirem ou a sessão estiver em inglês — nesse caso traga EN: e PT:.",
    "Baseie-se só no contexto desta sessão (objetivo, pauta, notas humanas, resumo anterior, transcrição e tela/código quando enviados). Não invente fatos, números, prazos, responsáveis, empresas ou decisões.",
    "Separe claramente o que é fato citado do que é Sugestão de fala.",
    myContext ? `Instruções do usuário: ${myContext}` : "",
    personal ? `Perfil opcional (use só se bater com a conversa; ignore campos [preencher]):\n"""\n${personal}\n"""` : "",
    meeting ? `Contexto desta reunião:\n${meeting}` : "",
  ].filter(Boolean).join("\n");
}

const MAX_CHARS = 3500;
function recent(lines) {
  const out = [];
  let n = 0;
  for (const l of (lines || []).slice().reverse()) {
    const text = String((l && l.text) || "");
    n += text.length + 10;
    if (n > MAX_CHARS && out.length) break;
    out.unshift(l);
  }
  return out;
}

function transcriptBlock(lines, { rollingSummary = "" } = {}) {
  const rec = recent(lines);
  const t = rec.map((l) => `${l.who === "me" ? "Você" : l.who === "them" ? "Outro(s)" : "Voz misturada"}: ${l.text}`).join("\n");
  const roll = String(rollingSummary || "").trim();
  const rollPart = roll ? `Resumo acumulado das partes anteriores da reunião (fatos já ditos):\n"""\n${roll}\n"""\n\n` : "";
  if (!t && !roll) return "Ainda não há transcrição.";
  return `${rollPart}Transcrição recente ("Você" = microfone; "Outro(s)" = áudio do computador; pode ter erro de reconhecimento):\n"""\n${t || "(sem falas recentes)"}\n"""`;
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
    const m = line.match(/^\s*(\d+)\s*[|.)-]+\s*(.+)$/);
    if (m && items[Number(m[1]) - 1]) out.push({ id: items[Number(m[1]) - 1].id, pt: m[2].trim() });
  }
  return out;
}

const OUTRO_RULE = "Foque no que o(s) OUTRO(s) acabou de dizer ou perguntar. Se a última fala for sua, ajude a conduzir o próximo ponto.";
const SCREEN_NOTE = "Um print da janela/tela da reunião está anexado, só porque o usuário ligou o contexto de tela. Use o que for visível e relevante à conversa. Não descreva o computador inteiro. Não trate a tela como prova, teste ou gabarito.";

function suggest(lines, { myContext, lang, meeting, rollingSummary = "", more = false, withScreen = false } = {}) {
  const english = lang === "en" || lang === "both";
  const style = english
    ? "Inglês natural, direto e conversacional em 1ª pessoa, pronto para falar em voz alta na call."
    : "Português do Brasil natural em 1ª pessoa, direto ao ponto, pronto para falar em voz alta (sem 'Claro!' nem preâmbulo).";
  const format = english
    ? "Formato exato:\nEN: <fala pronta em 1ª pessoa + 1 pergunta curta de gancho se couber>\nPT: <tradução fiel em português>"
    : "Formato: 1 parágrafo curto de fala pronta em 1ª pessoa + na linha seguinte 'Gancho: <1 pergunta inteligente e curta para avançar a conversa>'. Sem markdown pesado.";
  return [
    {
      role: "system",
      content: `${base(myContext, meeting)}\nVocê entrega uma Sugestão imediata do que a pessoa pode falar AGORA na reunião. Seja específico à transcrição e às notas. Proibido frase genérica. Não invente.`,
    },
    {
      role: "user",
      content: `${transcriptBlock(lines, { rollingSummary })}
${withScreen ? SCREEN_NOTE : ""}

${OUTRO_RULE}
Sugestão de fala AGORA${more ? ", um pouco mais completa e estruturada" : ""}. ${style}
${format}`,
    },
  ];
}

function researchTopic(lines, topic, { myContext, meeting, rollingSummary = "" } = {}) {
  const cleanTopic = redact(String(topic || "").trim()).slice(0, 240);
  return [
    {
      role: "system",
      content: [
        base(myContext, meeting),
        "Você pesquisa rapidamente um assunto, tecnologia, empresa ou conceito citado na reunião para dar repertório imediato ao usuário.",
        "Se não tiver certeza absoluta de um número ou detalhe específico, não invente — atenha-se ao conhecimento técnico sólido ou ao resultado da busca.",
        "Responda SEMPRE em português do Brasil em no máximo 3 linhas curtas:",
        "- Definição: <explicação direta em 1 frase>",
        "- Ponto técnico chave: <trade-off, funcionamento ou detalhe prático mais relevante>",
        "- Aplicação prática: <1 frase natural em 1ª pessoa conectando à conversa>",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        transcriptBlock(lines, { rollingSummary }),
        cleanTopic
          ? `Assunto para pesquisar agora: "${cleanTopic}"`
          : "Identifique o termo técnico, ferramenta, empresa ou tema principal mais recente na conversa e explique-o.",
      ].join("\n\n"),
    },
  ];
}

function liveCoding(lines, { myContext, meeting, rollingSummary = "", clipboardCode = "", promptHint = "", lang = "auto", withScreen = false } = {}) {
  const english = lang === "en";
  const clip = redact(String(clipboardCode || "").trim()).slice(0, 6000);
  const hint = redact(String(promptHint || "").trim()).slice(0, 800);
  return [
    {
      role: "system",
      content: [
        "Você é o modo Código / Pair Programming do HELIOS: assistente técnico para programação em par, code review e depuração ao vivo.",
        "Analise o trecho de código ou erro visível no monitor selecionado, o conteúdo da área de transferência (se houver) e o contexto técnico falado na conversa.",
        "Entregue a resposta SEMPRE estruturada exatamente nestes 3 blocos curtos e escaneáveis:",
        english
          ? "### 1. O que falar agora\nEN: <2 a 3 frases naturais em 1ª pessoa explicando a abordagem antes de codar>\nPT: <resumo em português>"
          : "### 1. O que falar agora\n<2 a 3 frases naturais em 1ª pessoa explicando o raciocínio e a abordagem em voz alta>",
        "### 2. Código limpo & Complexidade\n<bloco de código com crases triplas, idiomático, limpo, SEM comentários robóticos óbvios>\nTempo: O(...) · Espaço: O(...) — <1 frase curta justificando>",
        "### 3. Debug / Edge cases\n<se houver erro, teste quebrado ou stacktrace visível, aponte a linha/causa exata e a correção; senão, liste 2 a 3 casos de borda essenciais>",
        myContext ? `Preferências técnicas: ${myContext}` : "",
        meeting ? `Contexto da sessão:\n${meeting}` : "",
      ].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: [
        transcriptBlock(lines, { rollingSummary }),
        withScreen ? "A imagem anexada mostra o editor/enunciado atual na tela escolhida pelo usuário. Leia o enunciado, assinatura da função, testes e eventuais erros." : "",
        clip ? `Código / texto atual na área de transferência:\n"""\n${clip}\n"""` : "",
        hint ? `Pedido específico do usuário: ${hint}` : "Resolva ou destrave o problema atual de forma limpa e direta.",
      ].filter(Boolean).join("\n\n"),
    },
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

function followups(lines, { myContext, meeting, rollingSummary = "" } = {}) {
  return [
    { role: "system", content: `${base(myContext, meeting)}\nSugira perguntas de acompanhamento que a pessoa pode fazer. Só o que faz sentido com a transcrição. Se não houver base, diga isso.` },
    { role: "user", content: `${transcriptBlock(lines, { rollingSummary })}\n\nAté 4 perguntas curtas, uma por linha, começando com "- ". Sem inventar temas.` },
  ];
}

function insights(lines, { myContext, meeting, rollingSummary = "" } = {}) {
  return [
    { role: "system", content: `${base(myContext, meeting)}\nAjuda ao vivo: o que está em jogo agora, o que ficou em aberto e uma sugestão de fala. Distinga fato (citado) de sugestão.` },
    { role: "user", content: `${transcriptBlock(lines, { rollingSummary })}\n\nResponda em três parágrafos curtos: Fato. Aberto. Sugestão.` },
  ];
}

function explain(lines, { myContext, term, meeting, rollingSummary = "" } = {}) {
  return [
    { role: "system", content: base(myContext, meeting) },
    { role: "user", content: `${transcriptBlock(lines, { rollingSummary })}\n\n${term ? `Explique "${term}" no contexto desta conversa.` : "Explique o termo ou ponto mais recente desta conversa."}\nAté 5 frases. Se não estiver na transcrição, diga que não dá para afirmar.` },
  ];
}

function ask(lines, question, { myContext, withScreen, meeting, rollingSummary = "" } = {}) {
  return [
    { role: "system", content: `${base(myContext, meeting)}\nResponda à pergunta com base no contexto atual. Se for para falar, comece com Sugestão. Fatos só se estiverem na transcrição, nas notas, na pauta ou na tela autorizada.` },
    { role: "user", content: `${transcriptBlock(lines, { rollingSummary })}
Pergunta: ${question}
${withScreen ? SCREEN_NOTE : ""}
Responda em português. Sem preâmbulo. Não invente.` },
  ];
}

function roteiro(lines, topic, { rollingSummary = "" } = {}) {
  return [
    { role: "system", content: "Ajude a conduzir a reunião. Escreva perguntas em português, curtas, para A PESSOA fazer. Não responda no lugar dela e não invente fatos." },
    { role: "user", content: `${transcriptBlock(lines, { rollingSummary })}\n\n${topic ? `Tema: ${topic}\n` : ""}6 a 10 perguntas em frases, uma por parágrafo, só em português.` },
  ];
}

function summary(lines, { myContext, meeting, rollingSummary = "" } = {}) {
  return [
    { role: "system", content: base(myContext, meeting) },
    { role: "user", content: `${transcriptBlock(lines, { rollingSummary })}\n\nResumo corrido do que já foi dito: temas, decisões citadas e próximos passos só se mencionados. Se ainda não há transcrição, diga isso.` },
  ];
}

module.exports = {
  setPersonal, PERSONAL_MAX, MAX_CHARS, recent, transcriptBlock,
  translateBatch, parseBatch, translate, suggest, researchTopic, liveCoding,
  detectQuestion, parseDetect, sayEn, followups, insights, explain, ask, summary, roteiro,
};
