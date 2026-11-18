"use strict";

const { redact } = require("../server/util");

let personal = "";
const PERSONAL_MAX = 8000;
function setPersonal(text) { personal = String(text || "").trim().slice(0, PERSONAL_MAX); }
function getPersonal() { return personal; }

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

const INTERVIEW_RULE = "Quem pergunta é o(a) entrevistador(a). Se a chamada estiver no viva-voz, a pergunta dele(a) pode aparecer rotulada como \"Você\" ou \"Voz misturada\": foque na ÚLTIMA PERGUNTA feita à pessoa entrevistada, seja qual for o rótulo.";

const Q_START = /^(what|why|how|when|where|who|which|whose|do|does|did|are|is|was|were|can|could|would|will|should|have|has|tell|describe|walk|give|share|explain|talk|o que|por que|porque|como|quando|onde|quem|qual|quais|você|voce|vc|me conta|me fala|fala|conta|descreva|explique|tem|já|ja|pode|poderia|consegue)\b/i;

function splitSentences(text) {
  return String(text || "").replace(/\s+/g, " ").trim().split(/(?<=[.?!])\s+/).map((t) => t.trim()).filter(Boolean);
}

function isQuestionLike(sentence) {
  const t = String(sentence || "").trim();
  return /\?\s*$/.test(t) || Q_START.test(t);
}

/**
 * Pega só a última pergunta do entrevistador, costurando pedaços que o corte de áudio separou.
 * Viva-voz: tudo pode vir como "me"; então olha o último bloco de falas, de qualquer rótulo.
 */
function latestQuestion(lines) {
  const list = (lines || []).filter((l) => l && String(l.text || "").trim());
  if (!list.length) return "";
  let end = list.length - 1;
  if (list.some((l) => l.who === "them")) {
    while (end >= 0 && list[end].who === "me") end--;
  }
  const lastWho = list[end].who;
  const block = [];
  for (let i = end; i >= 0 && block.length < 4; i--) {
    if (list[i].who !== lastWho) break;
    block.unshift(String(list[i].text).trim());
  }
  const sentences = splitSentences(block.join(" "));
  let qi = -1;
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (isQuestionLike(sentences[i])) { qi = i; break; }
  }
  if (qi < 0) return sentences.slice(-2).join(" ").slice(-400);
  // Pergunta cortada no meio ("Can you tell me" + "about your Shopify experience?") ou com contexto curto antes.
  let from = qi;
  if (qi > 0 && !/[?]\s*$/.test(sentences[qi - 1]) && sentences[qi - 1].length < 140) from = qi - 1;
  return sentences.slice(from).join(" ").slice(-400);
}

const SMALL_TALK = /^(hi|hello|hey|good (morning|afternoon|evening)|how are you|how's it going|can you hear me|are you there|nice to meet you|thanks?( you)?|oi|olá|ola|bom dia|boa tarde|boa noite|tudo bem|tudo bom|está me ouvindo|ta me ouvindo|consegue me ouvir|prazer)\b/i;
function isSmallTalk(q) {
  const t = String(q || "").trim();
  return Boolean(t) && t.length < 90 && SMALL_TALK.test(t) && !/(tell me|experience|experiência|projeto|project|shopify|why|por que)/i.test(t);
}

function interviewSuggest(lines, { myContext, lang, meeting, rollingSummary = "", more = false, previous = [] } = {}) {
  const english = lang !== "pt";
  const question = latestQuestion(lines);
  const noise = Boolean(question) && !/\?/.test(question) && question.replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(uh+|um+|hm+|hmm+|ah+|eh+|oh+|mhm+|aham)$/i.test(w)).length < 3;
  const small = noise || isSmallTalk(question);
  const prev = (previous || []).filter((p) => p && p.answer).slice(-3);
  const length = small
    ? "1 frase curta e simpática (é só conversa social, não é pergunta de entrevista)"
    : more
      ? "versão mais completa e aprofundada da resposta, com exemplo concreto e resultado"
      : "tamanho definido pela pergunta: sim/não, horário ou disponibilidade = curto e direto; experiência, projeto, motivação ou comportamental = resposta completa, bem raciocinada, com exemplo real; sem enchimento";
  const format = english
    ? [
        "Formato exato (estas seções, nesta ordem, sem preâmbulo). A resposta direta vem PRIMEIRO, pronta para ler em voz alta:",
        "## Pergunta",
        "PT: <a ÚLTIMA pergunta, em 1 linha em português>",
        "## Responda",
        `EN: <${length}; inglês falado natural e simples, 1ª pessoa, frases curtas e fáceis de pronunciar, sem travessões, sem listas>`,
        "PT: <tradução fiel da resposta EN>",
        small ? "" : "## Pontos de apoio",
        small ? "" : "- EN: <fato concreto do perfil para usar se ela aprofundar> (PT: <tradução curta>)",
        small ? "" : "- <1 a 3 itens; omita a seção se não houver nada útil além da resposta>",
      ].filter(Boolean).join("\n")
    : [
        "Formato exato (estas seções, nesta ordem, sem preâmbulo). A resposta direta vem PRIMEIRO, pronta para falar:",
        "## Pergunta",
        "<a ÚLTIMA pergunta, em 1 linha>",
        "## Responda",
        `<${length}; português natural, 1ª pessoa>`,
        small ? "" : "## Pontos de apoio",
        small ? "" : "- <1 a 3 fatos concretos do perfil para usar se aprofundarem; omita se não houver>",
      ].filter(Boolean).join("\n");
  const rules = [
    "Regras de qualidade (obrigatórias):",
    "1. Responda SOMENTE a última pergunta indicada abaixo. Não responda perguntas antigas e não junte várias respostas numa só.",
    "2. Não repita frases nem exemplos das respostas já sugeridas listadas abaixo. Se a pergunta for um follow-up da resposta anterior, aprofunde com detalhe NOVO (como fiz, ferramenta, resultado), sem recontar a mesma história.",
    "3. Nunca raso: a resposta tem que fazer sentido sozinha, responder de verdade o que foi perguntado e trazer fatos concretos do Perfil (empresa, plataforma, número de lojas, projeto, ferramenta real) ligados à pergunta. Proibido frase genérica do tipo 'I am hardworking' ou resposta de uma linha sem conteúdo.",
    "4. Pergunta comportamental (\"tell me about a time\", desafio, conflito, erro): estruture como situação, o que EU fiz e resultado, com um caso real do Perfil.",
    "5. Se a fala não for pergunta (comentário, explicação longa da vaga), sugira uma reação curta + 1 pergunta pertinente sobre o que foi dito.",
    "6. Se o perfil não comprovar algo, diga a verdade e mostre a experiência real mais próxima e como ela se transfere.",
    "7. PROIBIDO inventar: número, percentual, tempo de carregamento, prazo (\"48 hours\"), quantidade de clientes, resultado, métrica, episódio específico ou tarefa que não esteja escrita no Perfil. Para exemplos, descreva COMO você costuma trabalhar (processo real) ou use os fatos do Perfil; resultado só de forma qualitativa. Os únicos números permitidos são os que aparecem no Perfil, nas notas ou na conversa.",
  ].join("\n");
  const prevBlock = prev.length
    ? `Respostas já sugeridas nesta entrevista (NÃO repetir):\n${prev.map((p, i) => `${i + 1}. Pergunta: ${String(p.question || "").slice(0, 160)}\n   Resposta: ${String(p.answer).replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}`
    : "";
  return [
    {
      role: "system",
      content: [
        base(myContext, meeting),
        "Você é o ponto eletrônico de uma ENTREVISTA DE EMPREGO: entrega a resposta que a pessoa entrevistada pode falar AGORA.",
        "Use só fatos do Perfil, das notas e da conversa. Nunca invente empresa, cliente, número, prazo, salário ou ferramenta.",
        "Tom: confiante, simpático, direto. Nada de 'Great question', 'Claro!' ou enrolação.",
        rules,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        transcriptBlock(lines, { rollingSummary }),
        INTERVIEW_RULE,
        prevBlock,
        question ? `ÚLTIMA PERGUNTA a responder (detectada; pode ter erro de reconhecimento): """${question}"""` : "Ainda não há pergunta clara: sugira uma frase curta de abertura.",
        noise ? "A última fala parece ruído ou fala incompleta: sugira só uma frase curta e educada (ex.: pedir para repetir) e nada mais." : small ? "Isto é conversa social: responda curto e natural, sem pitch." : "",
        small ? "" : "Lembrete final: só fatos do Perfil; nenhum número, métrica ou episódio inventado.",
        format,
      ].filter(Boolean).join("\n\n"),
    },
  ];
}

/** Marca números da sugestão que não aparecem no perfil, nas notas nem na conversa (rede de segurança contra métrica inventada). */
function flagUnsupportedNumbers(text, sources) {
  const out = String(text || "");
  if (!out.trim()) return out;
  const src = String(sources || "").replace(/\s+/g, " ");
  const body = out.split(/\n##\s*Pergunta\s*\n/).length > 1 ? out.replace(/##\s*Pergunta\s*\n[^\n]*\n?/, "") : out;
  const seen = new Set();
  const bad = [];
  for (const m of body.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = m[0];
    if (seen.has(n)) continue;
    seen.add(n);
    const has = (v) => new RegExp(`(^|[^\\d.,])${v.replace(/[.,]/g, "[.,]")}(?![\\d]|[.,]\\d)`).test(src);
    if (!has(n)) bad.push(n);
  }
  if (!bad.length) return out;
  return `${out.trimEnd()}\n\n⚠ Confira antes de falar: ${bad.join(", ")} não está no seu perfil. Se não tiver certeza, não cite o número.`;
}

function suggest(lines, { myContext, lang, meeting, rollingSummary = "", more = false, withScreen = false, interview = false, previous = [] } = {}) {
  if (interview && !withScreen) return interviewSuggest(lines, { myContext, lang, meeting, rollingSummary, more, previous });
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
  setPersonal, getPersonal, flagUnsupportedNumbers, PERSONAL_MAX, MAX_CHARS, recent, transcriptBlock,
  translateBatch, parseBatch, translate, suggest, interviewSuggest, latestQuestion, isSmallTalk, researchTopic, liveCoding,
  sayEn, followups, insights, explain, ask, summary, roteiro,
};
