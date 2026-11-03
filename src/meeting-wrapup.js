"use strict";
// Fase 6: fechamento da reunião. Resumo, pendências e rascunho de follow-up (nunca enviado), salvos como nota no Second Brain.

const MAX_TRANSCRIPT = 12000;

function fullTranscript(lines) {
  const rows = (lines || []).filter((line) => line && String(line.text || "").trim())
    .map((line) => `${line.who === "me" ? "Você" : line.who === "them" ? "Outro(s)" : "Voz misturada"}: ${String(line.text).trim()}`);
  let text = rows.join("\n");
  if (text.length > MAX_TRANSCRIPT) text = `[início cortado]\n${text.slice(text.length - MAX_TRANSCRIPT)}`;
  return text;
}

function wrapupPrompt(lines, { meetingContext = "", personal = "" } = {}) {
  return [
    {
      role: "system",
      content: [
        "Você fecha reuniões do Helison (brasileiro, desenvolvedor front-end). Escreva SEMPRE em português do Brasil.",
        "Use exatamente três seções com estes títulos: \"## Resumo\", \"## Pendências\" e \"## Rascunho de follow-up\".",
        "Resumo: até 6 tópicos curtos com decisões. Pendências: uma por linha começando com \"- \", com responsável e prazo se ditos (\"Você\" é o Helison).",
        "Rascunho de follow-up: mensagem curta e educada que o Helison PODE enviar depois, em primeira pessoa. É só rascunho; não diga que foi enviada.",
        "Não invente fatos, números ou datas que não estejam na transcrição ou no contexto.",
        meetingContext ? `Contexto da reunião ou da vaga (use para dar foco):\n"""\n${String(meetingContext).slice(0, 3000)}\n"""` : "",
        personal ? `Perfil do Helison (só para tom e termos):\n"""\n${String(personal).slice(0, 2000)}\n"""` : "",
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: `Transcrição ("Você" = microfone do Helison; "Outro(s)" = áudio do PC):\n"""\n${fullTranscript(lines)}\n"""` },
  ];
}

function section(text, name) {
  const re = new RegExp(`^#{1,3}\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,3}\\s|$(?![\\s\\S]))`, "mi");
  const match = String(text || "").match(re);
  return match ? match[1].trim() : "";
}

function parseWrapup(text) {
  const raw = String(text || "").trim();
  const resumo = section(raw, "Resumo") || raw;
  const pendText = section(raw, "Pend[eê]ncias");
  const pendencias = pendText.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length >= 4 && !/^nenhuma/i.test(line)).slice(0, 15);
  const followup = section(raw, "Rascunho de follow-up");
  return { resumo, pendencias, followup };
}

function noteFromWrapup(parsed, { at = new Date(), meetingContext = "" } = {}) {
  const pad = (n) => String(n).padStart(2, "0");
  const title = `Reunião ${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const body = [
    meetingContext ? `Contexto: ${String(meetingContext).replace(/\s+/g, " ").slice(0, 300)}` : "",
    "## Resumo", parsed.resumo || "(sem resumo)",
    "## Pendências", parsed.pendencias.length ? parsed.pendencias.map((item) => `- ${item}`).join("\n") : "- nenhuma",
    "## Rascunho de follow-up (NÃO enviado)", parsed.followup || "(sem rascunho)",
  ].filter(Boolean).join("\n\n");
  return { title, body, tags: ["reuniao"] };
}

function mockWrapupText() {
  return "## Resumo\n- Alinhamento do projeto de demonstração.\n\n## Pendências\n- Você: enviar o portfólio até sexta\n- Outro(s): mandar o briefing\n\n## Rascunho de follow-up\nOlá! Obrigado pela conversa de hoje. Envio o portfólio até sexta. Abraço, Helison.";
}

module.exports = { wrapupPrompt, parseWrapup, noteFromWrapup, fullTranscript, mockWrapupText, MAX_TRANSCRIPT };
