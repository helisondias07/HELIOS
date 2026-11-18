"use strict";

const { redact } = require("../server/util");
const { getPlaybook } = require("./playbooks");
const { splitTranscriptChunks, chunkSummaryPrompt } = require("./rolling-summary");

const MAX_TRANSCRIPT = 12000;

function formatRawTranscript(lines) {
  return (lines || [])
    .filter((line) => line && String(line.text || "").trim())
    .map((line) => `${line.who === "me" ? "Você" : line.who === "them" ? "Outro(s)" : "Voz misturada"}: ${String(line.text).trim()}`)
    .join("\n");
}

function fullTranscript(lines) {
  let text = formatRawTranscript(lines);
  if (text.length > MAX_TRANSCRIPT) text = `[início resumido em blocos]\n${text.slice(text.length - MAX_TRANSCRIPT)}`;
  return text;
}

function wrapupPrompt(lines, { meetingContext = "", title = "", objective = "", agenda = "", notes = "", playbook = "geral", partialSummaries = [] } = {}) {
  const pb = getPlaybook(playbook);
  const cleanNotes = redact(String(notes || "").trim()).slice(0, 4000);
  const blockDigest = Array.isArray(partialSummaries) && partialSummaries.length
    ? `Síntese factual completa por blocos (reunião longa):\n"""\n${partialSummaries.map((s, i) => `[Bloco ${i + 1}]\n${s}`).join("\n\n")}\n"""\n\n`
    : "";
  const notesBlock = cleanNotes
    ? `Notas humanas registradas pelo usuário durante a reunião (funda com a transcrição dando alta prioridade aos marcos anotados, sem inventar fatos extras):\n"""\n${cleanNotes}\n"""\n\n`
    : "";
  return [
    {
      role: "system",
      content: [
        "Você fecha reuniões gerando uma ata fiel estilo Granola (fusão das notas humanas com a transcrição). Escreva SEMPRE em português do Brasil.",
        "Use exatamente quatro seções: \"## Resumo\", \"## Decisões\", \"## Pendências\" e \"## Próximos passos\".",
        "Resumo: até 6 frases cobrindo do início ao fim o que de fato apareceu nas notas e na transcrição.",
        "Decisões: só o que ficou combinado na fala ou nas notas. Se ninguém decidiu nada, escreva \"Nenhuma decisão citada.\"",
        "Pendências e próximos passos: uma por linha começando com \"- \". Inclua responsável e prazo SOMENTE se alguém citou. Nunca invente nomes, datas, empresas ou números.",
        "Se a transcrição e as notas estiverem vazias ou forem só ruído, diga isso. Não complete com conteúdo típico de reunião.",
        "Não envie e-mail, não chame integração externa, não diga que algo foi enviado.",
        pb && pb.wrapupHint ? pb.wrapupHint : "",
        title ? `Título informado pelo usuário: ${String(title).slice(0, 120)}` : "",
        objective ? `Objetivo informado: ${String(objective).slice(0, 800)}` : "",
        agenda ? `Pauta informada:\n${String(agenda).slice(0, 1500)}` : "",
        meetingContext ? `Contexto extra:\n"""\n${String(meetingContext).slice(0, 2000)}\n"""` : "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: `${notesBlock}${blockDigest}Transcrição ("Você" = microfone; "Outro(s)" = áudio do computador):\n"""\n${fullTranscript(lines) || "(vazia)"}\n"""`,
    },
  ];
}

async function generateWrapup(lines, meta = {}, chatFn, onDelta = null, { mock = false } = {}) {
  if (mock) return { text: mockWrapupText(), provider: "demonstração" };
  const raw = formatRawTranscript(lines);
  let partialSummaries = [];
  if (raw.length > MAX_TRANSCRIPT) {
    const chunks = splitTranscriptChunks(lines, 9500);
    if (chunks.length > 1) {
      const pb = getPlaybook(meta.playbook);
      partialSummaries = [];
      for (let i = 0; i < chunks.length; i++) {
        const res = await chatFn(
          chunkSummaryPrompt(chunks[i], i, chunks.length, {
            title: meta.title,
            objective: meta.objective,
            playbookHint: pb && pb.wrapupHint,
          }),
          { fast: true, maxTokens: 450 }
        );
        if (res && res.text) partialSummaries.push(res.text.trim());
      }
    }
  }
  return chatFn(wrapupPrompt(lines, { ...meta, partialSummaries }), { maxTokens: 1500, onDelta });
}

function section(text, name) {
  const re = new RegExp(`^#{1,3}\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,3}\\s|$(?![\\s\\S]))`, "mi");
  const match = String(text || "").match(re);
  return match ? match[1].trim() : "";
}

function bullets(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^\[[ xX]\]\s*/, "").trim())
    .filter((line) => line.length >= 3 && !/^(nenhuma|nada|não há|nao ha)/i.test(line))
    .slice(0, 20);
}

function parseAction(line) {
  const raw = String(line || "").replace(/^\s*[-*•]?\s*\[[ xX]\]\s*/, "").trim();
  const done = /^\s*[-*•]?\s*\[[xX]\]/.test(String(line || ""));
  const ownerMatch = raw.match(/^(?:você|helison|outro\(s\)|[\p{L}.][\p{L}\p{N}. -]{1,40}?)\s*[:—-]\s+/iu);
  const dueMatch = raw.match(/\b(?:até|prazo|para o dia|dia)\s+([^.,;]+)/i);
  const owner = ownerMatch ? ownerMatch[0].replace(/[:—-]\s+$/, "").trim() : "";
  const due = dueMatch ? dueMatch[1].trim().slice(0, 80) : "";
  return { text: raw, owner, due, done };
}

function parseWrapup(text) {
  const raw = String(text || "").trim();
  const resumo = section(raw, "Resumo") || raw;
  const decisoes = bullets(section(raw, "Decis[oõ]es"));
  const pendencias = bullets(section(raw, "Pend[eê]ncias")).map(parseAction);
  const proximosPassos = bullets(section(raw, "Pr[oó]ximos passos")).map(parseAction);
  return { resumo, decisoes, pendencias, proximosPassos, rascunho: "", edited: false };
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatMeetingMarkdown(session) {
  if (!session) return "";
  const w = session.wrapup || {};
  const pb = getPlaybook(session.playbook);
  const dateStr = (session.startedAt || session.createdAt || "").slice(0, 10);
  const fmtAct = (item) => {
    if (!item) return "";
    const text = typeof item === "string" ? item : item.text;
    const mark = item && item.done ? "[x]" : "[ ]";
    return `- ${mark} ${text}`;
  };
  const parts = [
    `# ${session.title || "Reunião"}`,
    "",
    [
      dateStr ? `- **Data:** ${dateStr}` : "",
      session.durationMs ? `- **Duração:** ${fmtDuration(session.durationMs)}` : "",
      `- **Modo:** ${session.mode === "livecoding" ? "Live Coding" : "Reunião"}`,
      pb ? `- **Playbook:** ${pb.label}` : "",
      session.objective ? `- **Objetivo:** ${session.objective}` : "",
    ].filter(Boolean).join("\n"),
    "",
    "## Resumo",
    w.resumo || "_Sem resumo gerado._",
    "",
    "## Decisões",
    (w.decisoes && w.decisoes.length) ? w.decisoes.map((d) => `- ${d}`).join("\n") : "- Nenhuma decisão citada.",
    "",
    "## Pendências",
    (w.pendencias && w.pendencias.length) ? w.pendencias.map(fmtAct).join("\n") : "- Nenhuma pendência citada.",
    "",
    "## Próximos passos",
    (w.proximosPassos && w.proximosPassos.length) ? w.proximosPassos.map(fmtAct).join("\n") : "- Nenhum próximo passo citado.",
  ];
  if (session.notes && String(session.notes).trim()) {
    parts.push("", "## Notas da reunião", String(session.notes).trim());
  }
  if (Array.isArray(session.lines) && session.lines.length) {
    parts.push(
      "",
      "## Transcrição",
      session.lines.map((l) => `**${l.who === "me" ? "Você" : "Outro(s)"}:** ${l.text}${l.pt ? ` _(${l.pt})_` : ""}`).join("\n")
    );
  }
  return parts.join("\n") + "\n";
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

module.exports = {
  wrapupPrompt,
  generateWrapup,
  parseWrapup,
  parseAction,
  fullTranscript,
  formatRawTranscript,
  formatMeetingMarkdown,
  mockWrapupText,
  MAX_TRANSCRIPT,
};
