"use strict";

function unwrapStreamEvent(event) {
  if (!event) return null;
  if (event.type === "sdk_message" && event.message) return event.message;
  return event;
}

function extractAssistantText(msg) {
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && block.text).map((block) => block.text).join("");
}

function humanTool(name) {
  const value = String(name || "ferramenta").toLowerCase();
  if (value.includes("preencher")) return "Preenchendo login";
  if (value.includes("acao") || value.includes("aprov")) return "Pedindo aprovação";
  if (value.includes("pesquis") || value.includes("web")) return "Pesquisando";
  if (value.includes("memory") || value.includes("lembr")) return "Atualizando memória";
  if (value.includes("escrever") || value.includes("write") || value.includes("edit")) return "Editando arquivo";
  if (value.includes("mcp")) return "Usando conector";
  if (value.includes("live")) return "Abrindo livecoding";
  return `Usando ${name}`;
}

module.exports = { unwrapStreamEvent, extractAssistantText, humanTool };
