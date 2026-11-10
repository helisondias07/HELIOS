"use strict";

const MAX_TRANSCRIPT = 12000;

function fullTranscript(lines) {
  const rows = (lines || []).filter((line) => line && String(line.text || "").trim())
    .map((line) => `${line.who === "me" ? "Você" : line.who === "them" ? "Outro(s)" : "Voz misturada"}: ${String(line.text).trim()}`);
  let text = rows.join("\n");
  if (text.length > MAX_TRANSCRIPT) text = `[início cortado]\n${text.slice(text.length - MAX_TRANSCRIPT)}`;
  return text;
}

function wrapupPrompt(lines, { meetingContext = "", title = "", objective = "", agenda = "" } = {}) {
  return [
    {
      role: "system",
      content: [
        "Você fecha reuniões. Escreva SEMPRE em português do Brasil.",
        "Use exatamente quatro seções: \"## Resumo\", \"## Decisões\", \"## Pendências\" e \"## Próximos passos\".",
        "Resumo: até 6 frases sobre o que de fato apareceu na transcrição.",
        "Decisões: só o que ficou combinado na fala. Se ninguém decidiu nada, escreva \"Nenhuma decisão citada.\"",
        "Pendências e próximos passos: uma por linha começando com \"- \". Inclua responsável e prazo SOMENTE se alguém citou. Nunca invente nomes, datas, empresas ou números.",
        "Se a transcrição estiver vazia ou for só ruído, diga isso. Não complete com conteúdo típico de reunião.",
        "Não envie e-mail, não chame integração externa, não diga que algo foi enviado.",
        title ? `Título informado pelo usuário: ${String(title).slice(0, 120)}` : "",
        objective ? `Objetivo informado: ${String(objective).slice(0, 800)}` : "",
        agenda ? `Pauta informada:\n${String(agenda).slice(0, 1500)}` : "",
        meetingContext ? `Contexto extra:\n"""\n${String(meetingContext).slice(0, 2000)}\n"""` : "",
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: `Transcrição ("Você" = microfone; "Outro(s)" = áudio do computador):\n"""\n${fullTranscript(lines) || "(vazia)"}\n"""` },
  ];
}

function section(text, name) {
  const re = new RegExp(`^#{1,3}\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,3}\\s|$(?![\\s\\S]))`, "mi");
  const match = String(text || "").match(re);
  return match ? match[1].trim() : "";
}

function bullets(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length >= 3 && !/^(nenhuma|nada|não há|nao ha)/i.test(line))
    .slice(0, 15);
}

function parseAction(line) {
  const raw = String(line || "").trim();
  const ownerMatch = raw.match(/^(?:você|helison|outro\(s\)|[\p{L}.][\p{L}\p{N}. -]{1,40}?)\s*[:—-]\s+/iu);
  const dueMatch = raw.match(/\b(?:até|prazo|para o dia|dia)\s+([^.,;]+)/i);
  const owner = ownerMatch ? ownerMatch[0].replace(/[:—-]\s+$/, "").trim() : "";
  const due = dueMatch ? dueMatch[1].trim().slice(0, 80) : "";
  return { text: raw, owner, due };
}

function parseWrapup(text) {
  const raw = String(text || "").trim();
  const resumo = section(raw, "Resumo") || raw;
  const decisoes = bullets(section(raw, "Decis[oõ]es"));
  const pendencias = bullets(section(raw, "Pend[eê]ncias")).map(parseAction);
  const proximosPassos = bullets(section(raw, "Pr[oó]ximos passos")).map(parseAction);
  return { resumo, decisoes, pendencias, proximosPassos, rascunho: "", edited: false };
}

function mockWrapupText() {
  return [
    "## Resumo",
    "Exemplo de demonstração (não é uma reunião real): o time alinhou o recorte da semana.",
    "",
    "## Decisões",
    "- Manter o recorte atual até a próxima conversa.",
    "",
    "## Pendências",
    "- Você: enviar o rascunho até sexta",
    "",
    "## Próximos passos",
    "- Outro(s): devolver comentários depois do rascunho",
  ].join("\n");
}

module.exports = { wrapupPrompt, parseWrapup, parseAction, fullTranscript, mockWrapupText, MAX_TRANSCRIPT };
