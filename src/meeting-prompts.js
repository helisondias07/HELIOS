'use strict';
// Prompts do assistente. Saídas curtas e diretas para leitura durante a reunião.

// Contexto pessoal (personallycontext.md), definido pelo main; limitado a ~1,5K tokens
let personal = '';
const PERSONAL_MAX = 8000; // ~2K tokens
function setPersonal(text) { personal = String(text || '').trim().slice(0, PERSONAL_MAX); }

function base(myContext, meeting) {
  return [
    'Você é um assistente discreto que ajuda o Helison (brasileiro, desenvolvedor front-end/e-commerce na Agência Oasis) durante reuniões ao vivo.',
    'Ele entende inglês, mas ainda tem alguma dificuldade; seja curto, claro e prático.',
    'Responda SEMPRE em português do Brasil. Só use inglês quando o Helison pedir de forma explícita (botão em inglês, ou "em inglês" no pedido); nesse caso traga também a versão em português logo abaixo (PT:).',
    myContext ? `Instruções do Helison: ${myContext}` : '',
    personal ? `Responda com confiança em primeira pessoa, como o Helison, quando for algo que ele vai falar. Prefira os fatos deste perfil e da transcrição; se faltar informação, dê uma resposta plausível e natural, coerente com o perfil. Não invente números ou datas específicos que ele precise comprovar (salário, datas, métricas). Ignore campos [preencher].\nPerfil do Helison:\n"""\n${personal}\n"""` : '',
    meeting ? `Contexto desta reunião (use para escolher termos e tom; não repita):\n${meeting}` : '',
  ].filter(Boolean).join('\n');
}

// Limita o contexto às falas mais recentes (~3500 caracteres ≈ 1K tokens) para caber no limite grátis de 8K TPM
const MAX_CHARS = 3500;
function recent(lines) {
  const out = []; let n = 0;
  for (const l of (lines || []).slice().reverse()) { n += l.text.length + 10; if (n > MAX_CHARS) break; out.unshift(l); }
  return out;
}
function transcriptBlock(lines) {
  const t = recent(lines).map((l) => `${l.who === 'me' ? 'Você' : l.who === 'them' ? 'Outro(s)' : 'Voz misturada'}: ${l.text}`).join('\n');
  return t ? `Transcrição recente da reunião ("Você" = o Helison, pelo microfone; "Outro(s)" = as outras pessoas, pelo áudio do PC; pode conter erros de reconhecimento):\n"""\n${t}\n"""` : 'Ainda não há transcrição.';
}

function translate(text) {
  return [
    { role: 'system', content: 'Traduza para português do Brasil, de forma natural e fiel. Responda apenas com a tradução, sem aspas nem comentários. Se o texto já estiver em português, repita-o.' },
    { role: 'user', content: text },
  ];
}

function translateBatchPlain(items) {
  return [
    { role: 'system', content: 'Traduza cada linha numerada para português do Brasil, natural e fiel, sem resumir. Mantenha nomes próprios, siglas e termos técnicos de tecnologia/e-commerce (API, deploy, sprint, checkout, Wake...) como são usados no mercado; se o reconhecimento de voz errou um termo técnico, corrija pelo contexto da vaga e pelo glossário. Responda SOMENTE com as linhas no formato "<número>| <tradução>", uma por linha, mesma numeração.' },
    { role: 'user', content: items.map((it, i) => `${i + 1}| ${it.text}`).join('\n') },
  ];
}
// Tradução "passando o contexto": mesmo formato de saída, com bloco curto de contexto e tom.
function translateBatch(items, extra = {}) {
  const messages = translateBatchPlain(items);
  const ctx = [extra && extra.formality, extra && extra.block].filter(Boolean).join('\n');
  if (!ctx) return messages;
  messages[0].content += `\n\nUse o contexto abaixo apenas para escolher termos e tom. Não o traduza, não comente e não traduza as "Falas anteriores".\n${ctx}`;
  return messages;
}

function parseBatch(text, items) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[|.)-]\s*(.+)$/);
    if (m && items[Number(m[1]) - 1]) out.push({ id: items[Number(m[1]) - 1].id, pt: m[2].trim() });
  }
  return out;
}

const OUTRO_RULE = 'Foque no que o(s) OUTRO(s) acabou de dizer (a última fala marcada "Outro(s)"). Se a última fala for do Helison, ajude-o a continuar a conversa.';

// Prova, verdadeiro/falso ou múltipla escolha na tela: julgar cada item. Não colapsar em "todas falsas".
const PROSE = 'Texto corrido, em frases prontas para falar ou usar. Proibido lista, marcador, tópico, título, markdown e linha que comece com "-" ou número. Curto ou longo conforme o caso.';
const SCREEN_EXAM = `Um print da tela atual está anexado. Leia o texto visível antes de responder. ${PROSE}
Se for prova, questão, verdadeiro/falso ou múltipla escolha, julgue CADA afirmação na ordem da tela, separadamente. É proibido resumir como "todas são falsas" ou "todas são verdadeiras" sem ter decidido cada item. A primeira frase traz só a sequência, no formato "Verdadeiro, verdadeiro, falso, verdadeiro, falso." Depois vêm frases corridas, uma por afirmação, com o motivo. Não fale em primeira pessoa e não chute um veredito único para a lista. Esta regra vale mais do que o hábito de falar como o Helison.
Se não for questão, use o que está visível para responder o pedido. Não descreva a tela inteira.`;

// Ada, questão 19: classificador de spam. Gabarito usado no teste do prompt (não chama a rede).
const ADA_Q19 = [
  { n: 1, answer: "verdadeiro" },
  { n: 2, answer: "verdadeiro" },
  { n: 3, answer: "falso" },
  { n: 4, answer: "verdadeiro" },
  { n: 5, answer: "falso" },
];
function verdictLine(items) {
  const words = (items || []).map((item) => String(item && item.answer || "").trim().toLowerCase()).filter(Boolean);
  if (!words.length) return "";
  const shown = words.map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word));
  return `${shown.join(", ")}.`;
}

// Três falas úteis, no tom do Cluely: específicas ao que acabou de ser dito e à tela. Não uma linha genérica.
const CHEAT = 'Responda como cola de tela: o mínimo de palavras, nada de explicações a menos que pedidas. Sem preâmbulo, sem "Claro!", sem repetir a pergunta.';
function suggest(lines, { myContext, lang, meeting, more = false, withScreen = false } = {}) {
  const english = lang === 'en' || lang === 'both';
  const style = english
    ? 'Inglês natural e simples, no nível de um desenvolvedor brasileiro intermediário: frases que uma pessoa diria em voz alta, vocabulário comum, contrações naturais (I\'m, I\'ve), sem gírias raras nem palavras difíceis.'
    : 'Português do Brasil natural, do jeito que se fala numa reunião. Nada em inglês. Nada de "Claro!", "Com certeza" ou frase vazia.';
  const format = english
    ? `Formato obrigatório: texto corrido, em frases. Proibido lista, marcador, título, markdown e linha que comece com "-" ou número.
EN: <a resposta em inglês simples, específica, em frases corridas, sem tópicos>
PT: <tradução em português> em frases corridas, sem tópicos
Se houver outra fala, separe por uma linha em branco. A segunda resposta é outro parágrafo, não um tópico.`
    : `Formato obrigatório: texto corrido, em frases. Proibido lista, marcador, título, markdown e linha que comece com "-" ou número.
Um ou mais parágrafos. A melhor fala vem primeiro, específica, com 2 a 5 frases que dê para dizer em voz alta.
Se couber outra, deixe uma linha em branco e escreva a segunda resposta como outro parágrafo, não como tópico.`;
  const screen = withScreen ? SCREEN_EXAM : '';
  const exam = withScreen ? 'Se a tela for prova ou verdadeiro/falso, a primeira fala começa pela sequência e segue em frases corridas, uma por afirmação. Outra fala, se houver, só reformula a MESMA correção, também em prosa. Não troque nenhum veredito e não use tópicos.' : '';
  return [
    { role: 'system', content: `${base(myContext, meeting)}\nVocê sugere o que o Helison fala agora. Seja específico ao contexto. Proibido frase genérica. Se a tela for uma prova, a primeira sugestão é o gabarito item a item, não uma frase de reunião.` },
    { role: 'user', content: `${transcriptBlock(lines)}
${screen}

${OUTRO_RULE}
Três respostas que o Helison pode falar em voz alta AGORA${withScreen ? '. Se a tela não for prova, fale em primeira pessoa' : ', em primeira pessoa'}${more ? ', a primeira mais elaborada' : ''}. ${style} Use a transcrição, a tela (se houver), o contexto da vaga/reunião e o perfil dele. Não invente números, datas, empresas nem experiência que ele não tenha. Se ainda não há fala do outro, ofereça uma abertura útil para o que está na tela, não um cumprimento vazio.
${exam}
${format}` },
  ];
}

// Pergunta detectada na última fala do Outro(s): até 8 palavras ou NONE. Barato (modelo rápido), alimenta o chip.
function detectQuestion(text) {
  return [
    { role: 'system', content: 'Você detecta perguntas feitas ao Helison numa reunião. Se a fala contém uma pergunta ou pedido dirigido a ele, devolva só essa pergunta resumida em português, em até 8 palavras, sem aspas. Se não houver pergunta, devolva exatamente NONE.' },
    { role: 'user', content: String(text || '').slice(0, 600) },
  ];
}
function parseDetect(text) {
  const t = String(text || '').trim().split(/\r?\n/)[0].replace(/^["'“]|["'”]$/g, '').trim();
  if (!t || /^none\.?$/i.test(t)) return '';
  return t.split(/\s+/).slice(0, 8).join(' ');
}

// Livecoding (Leva H): só código, curto e direto, sem texto em volta.
function code(lines, request, { myContext, meeting } = {}) {
  return [
    { role: 'system', content: ['Você é a cola de livecoding do Helison (dev front-end/e-commerce) numa entrevista ou reunião ao vivo.', 'Responda SÓ com um bloco de código curto e funcional, sem explicação antes ou depois, sem cercas ```.', 'Comentários no código só se indispensáveis, em português, curtos. No máximo 40 linhas. Use a linguagem pedida; se não disser, JavaScript.', myContext ? `Instruções do Helison: ${myContext}` : '', meeting ? `Contexto da reunião (não repita):\n${meeting}` : ''].filter(Boolean).join('\n') },
    { role: 'user', content: `${lines && lines.length ? `${transcriptBlock(lines)}\n\n` : ''}Pedido: ${String(request || '').slice(0, 800)}` },
  ];
}
function stripFences(text) {
  return String(text || '').replace(/^\s*```[\w-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

function suggestBoth(lines, { myContext, meeting } = {}) {
  return suggest(lines, { myContext, meeting, lang: 'both' });
}

// "Dizer em inglês": o Helison digita em português o que quer falar e recebe a frase em inglês (e a volta em português para conferir).
function sayEn(text, { myContext, meeting } = {}) {
  return [
    { role: 'system', content: ['Você traduz do português para o inglês o que o Helison quer dizer numa reunião ao vivo: inglês simples, natural e curto, em tom neutro, em primeira pessoa, no nível de um desenvolvedor brasileiro intermediário. Não acrescente informação nova.', myContext ? `Instruções do Helison: ${myContext}` : '', meeting ? `Contexto da reunião (use só para escolher termos e tom; não repita):\n${meeting}` : ''].filter(Boolean).join('\n') },
    { role: 'user', content: `Formato obrigatório (nada além disso):\nEN: <frase em inglês>\nPT: <o que ficou dito, em português, para ele conferir>\n\nO que ele quer dizer:\n"""\n${String(text || '').slice(0, 600)}\n"""` },
  ];
}

// Pesquisa contextualizada, só leitura: resposta curta em português com links das fontes.
function research(lines, query, { myContext, meeting } = {}) {
  return [
    { role: 'system', content: base(myContext, meeting) },
    { role: 'user', content: `${transcriptBlock(lines)}

Pesquise na web (somente leitura) sobre: ${query}
Use o contexto da vaga/empresa/assunto da reunião para escolher o sentido certo do termo. Responda em português do Brasil, em frases corridas. ${PROSE}
Feche com a frase "Fontes:" e até 3 links completos (https://...) na sequência, sem transformar em lista. Se não achar informação confiável, diga isso claramente e não invente.` },
  ];
}

function explain(lines, { myContext, term, meeting } = {}) {
  return [
    { role: 'system', content: base(myContext, meeting) },
    { role: 'user', content: `${transcriptBlock(lines)}

${term ? `Explique "${term}" no contexto desta conversa.` : 'Explique o termo, sigla ou assunto mais recente/difícil desta conversa, e o que está sendo discutido agora.'}
Responda em português, em até 5 frases. ${PROSE}` },
  ];
}

function ask(lines, question, { myContext, withScreen, meeting } = {}) {
  const shape = withScreen
    ? SCREEN_EXAM
    : `${PROSE} A primeira frase é a resposta direta. Sem preâmbulo, sem "Claro!" e sem repetir a pergunta.`;
  return [
    { role: 'system', content: `${base(myContext, meeting)}${withScreen ? '\nSe o print for uma prova, resolva cada item. Não responda em primeira pessoa.' : ''}` },
    { role: 'user', content: `${transcriptBlock(lines)}
Pergunta do Helison: ${question}
${shape}
Responda em português. Se ele pedir algo para falar em inglês, dê a frase em inglês e a tradução. Se ele perguntar "o que é X?", "não entendi X" ou pedir para explicar um termo, ferramenta, empresa ou sigla: pesquise na web (browser_search) se não tiver certeza, explique em português simples em 2-3 linhas (só dê frase em inglês se ele pedir). Fora isso, pesquise na web só se precisar de informação atual ou que você não sabe; cite a fonte em 1 linha só se pesquisou. Nunca invente experiência do Helison.` },
  ];
}

function roteiro(lines, topic) {
  return [
    { role: 'system', content: 'Você ajuda o Helison a conduzir uma entrevista ou uma reunião. Escreva perguntas em português, numeradas e curtas, para ELE fazer às outras pessoas. Não responda no lugar dele e não invente fatos da vida dele.' },
    { role: 'user', content: `${transcriptBlock(lines)}\n\n${topic ? `Tema: ${topic}\n` : ''}Escreva de 6 a 10 perguntas em frases, uma por parágrafo, sem número e sem marcador. Só em português; se ele quiser a versão em inglês, ele pede. ${PROSE}` },
  ];
}

function summary(lines, { myContext, meeting } = {}) {
  return [
    { role: 'system', content: base(myContext, meeting) },
    { role: 'user', content: `${transcriptBlock(lines)}

Faça um resumo da reunião em português, em prosa: o que foi tratado, o que ficou decidido e os próximos passos, com responsáveis se mencionados. ${PROSE}` },
  ];
}

module.exports = { CHEAT, SCREEN_EXAM, ADA_Q19, verdictLine, detectQuestion, parseDetect, code, stripFences, sayEn, research, suggestBoth, setPersonal, PERSONAL_MAX, recent, translateBatch, parseBatch, translate, suggest, explain, ask, summary, roteiro, transcriptBlock };
