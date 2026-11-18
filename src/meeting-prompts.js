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
    ? "Fala natural, direta e conversacional em 1ª pessoa, pronta para falar em voz alta na call."
    : "Português do Brasil natural em 1ª pessoa, direto ao ponto, pronto para falar em voz alta (sem 'Claro!' nem preâmbulo).";
  const format = english
    ? [
        "Formato exato (só estas 2 seções):",
        "## O que falar agora",
        "EN: <fala pronta em 1ª pessoa>",
        "PT: <tradução fiel em português>",
        "## Dados reais pesquisados",
        "- <fato, métrica, número ou regra concreta que sustenta a resposta>",
        "- <até 3 itens, um por linha>",
      ].join("\n")
    : [
        "Formato exato (só estas 2 seções):",
        "## O que falar agora",
        "<fala pronta em 1ª pessoa + 1 pergunta curta de gancho se couber>",
        "## Dados reais pesquisados",
        "- <fato, métrica, número ou regra concreta que sustenta a resposta>",
        "- <até 3 itens, um por linha>",
      ].join("\n");
  return [
    {
      role: "system",
      content: `${base(myContext, meeting)}\nVocê entrega uma Sugestão imediata do que a pessoa pode falar AGORA na reunião. Use a busca em tempo real para trazer dados concretos de mercado, técnicos ou de negócio que sustentem a fala quando fizer sentido. Proibido frase genérica. Não invente números, prazos, fontes ou empresas: se a busca não trouxer o dado, escreva só o que a transcrição e as notas sustentarem.`,
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
        "Você é o modo Live Coding do HELIOS: gera um guia extremamente mastigado para o usuário bater o olho e digitar manualmente no VS Code enquanto compartilha a tela numa call.",
        "A resposta aparece numa telinha discreta e invisível no compartilhamento de tela — seja curto, denso e escaneável; o usuário digita acompanhando o guia em tempo real.",
        "Entregue SEMPRE exatamente estas 3 seções numeradas, nesta ordem:",
        "### 1. Preparar no VS Code",
        "- Pasta: <caminho exato onde entrar>",
        "- Arquivo: <nome exato do arquivo a criar ou editar, ex.: src/services/api.ts>",
        "- Terminal: <comando para instalar dependência, se precisar; senão 'nenhuma'>",
        "### 2. Passo a passo do que digitar",
        "Divida a solução em micro-passos numerados na ordem exata de digitação (Passo 2.1: Imports e URL base, Passo 2.2: Função principal, Passo 2.3: Onde chamar no componente…). Cada passo tem 1 bloco de código curto com crases triplas, limpo e idiomático, SEM comentários artificiais de IA. Se houver erro ou stacktrace visível na tela, inclua um passo final apontando a linha exata e a correção. Feche a seção com uma linha 'Tempo: O(...) · Espaço: O(...) — <justificativa curta>'.",
        "### 3. O que falar enquanto digita",
        "- No Passo 2.1: \"<1 frase curta e natural para explicar ao cliente/entrevistador o que está fazendo>\"",
        "- repita uma frase para cada passo da seção 2",
        myContext ? `Preferências técnicas: ${myContext}` : "",
        meeting ? `Contexto da sessão:\n${meeting}` : "",
        "Use a busca em tempo real para checar APIs, libs, assinaturas e versões citadas; não invente APIs, parâmetros nem comandos.",
        english ? "Escreva as falas da seção 3 em inglês natural." : "",
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
  sayEn, followups, insights, explain, ask, summary, roteiro,
};
