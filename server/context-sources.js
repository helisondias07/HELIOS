"use strict";

/**
 * Fontes extras de contexto, SOMENTE LEITURA (Fase 2): ClickUp e e-mail, pelos conectores MCP que o Helison já configurou.
 *
 * Só roda ferramenta que o HELIOS classifica como leitura conhecida (classifyToolDetailed: tipo "ler", known, sem forceCard e
 * sem verbo irreversível). Envio, escrita, apagar e o resto nunca passam por aqui. O texto lido é mascarado (redact + palavra
 * longa suspeita), cortado e devolvido como um PACOTE (mesmo formato do arquivo importado): ele entra pela prévia e só vira
 * contexto depois da confirmação. Nada é gravado aqui.
 *
 * Ponto de extensão: para ligar outra fonte (Notion, Drive...), acrescente uma linha em SOURCE_KINDS.
 */

const { classifyToolDetailed, isIrreversible } = require("./irreversible");
const { maskSecrets } = require("./secret-scan");
const { FORMATO, VERSAO } = require("./context-pack");

const SOURCE_KINDS = [
  { kind: "clickup", label: "ClickUp", match: /clickup/i },
  { kind: "email", label: "E-mail", match: /(gmail|e-?mail|outlook|imap|mail)/i },
];

const MAX_ARGS_CHARS = 4000;
const MAX_TEXT_CHARS = 20000;
const MAX_ITEMS = 30;
const ITEM_CHARS = 580;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function kindOf(server) {
  const hay = `${server.name} ${server.url || ""} ${server.command || ""} ${(server.args || []).join(" ")}`;
  return SOURCE_KINDS.find((item) => item.match.test(hay)) || null;
}

/** Ferramenta de leitura que o HELIOS reconhece. */
function isReadTool(tool) {
  const info = classifyToolDetailed(tool.name, tool.description || "");
  return info.tipo === "ler" && info.known && !info.forceCard && !isIrreversible(tool.name, tool.description || "");
}

function createContextSources({ mcp, assistants }) {
  function list() {
    return (mcp ? mcp.list() : []).map((server) => ({ server, kind: kindOf(server) })).filter((row) => row.kind).map(({ server, kind }) => ({
      servidor: server.name,
      fonte: kind.label,
      tipo: kind.kind,
      status: server.status,
      confirmado: server.confirmed,
      ferramentasDeLeitura: (server.tools || []).filter(isReadTool).map((tool) => ({ nome: tool.name, descricao: tool.description || "" })),
    }));
  }

  /** Quebra o texto lido em itens curtos de contexto (um por parágrafo/linha longa). */
  function toItems(text, label) {
    const parts = String(text).split(/\n{2,}|\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line.length >= 4);
    const out = [];
    let buffer = "";
    const flush = () => {
      if (buffer.length >= 4) out.push(`(${label}) ${buffer}`.slice(0, ITEM_CHARS + label.length + 3));
      buffer = "";
    };
    for (const part of parts) {
      if (buffer && buffer.length + part.length + 3 > ITEM_CHARS) flush();
      buffer = buffer ? `${buffer} | ${part}` : part;
      while (buffer.length > ITEM_CHARS) {
        out.push(`(${label}) ${buffer.slice(0, ITEM_CHARS)}`);
        buffer = buffer.slice(ITEM_CHARS);
      }
      if (out.length >= MAX_ITEMS) break;
    }
    if (out.length < MAX_ITEMS) flush();
    return out.slice(0, MAX_ITEMS);
  }

  /** Lê pelo conector (só leitura) e devolve um pacote para a prévia. Nada é gravado. */
  async function read({ servidor, ferramenta, argumentos, assistenteId } = {}) {
    const found = list().find((row) => row.servidor === String(servidor || ""));
    if (!found) throw fail("Esse conector não é uma fonte de ClickUp ou e-mail configurada aqui.", 404);
    if (found.status === "offline") throw fail("Esse conector está offline. Teste-o em Conectores.", 409);
    const tool = (mcp.findTool && mcp.findTool(found.servidor, String(ferramenta || ""))) || null;
    if (!tool) throw fail("Essa ferramenta não está numa lista já testada de um conector confirmado.", 404);
    if (!isReadTool(tool)) throw fail("Só leio com ferramentas de leitura. Essa pode alterar algo e fica de fora.", 403);
    const args = argumentos === undefined || argumentos === null ? {} : argumentos;
    if (typeof args !== "object" || Array.isArray(args)) throw fail("Os argumentos devem ser um objeto.");
    if (JSON.stringify(args).length > MAX_ARGS_CHARS) throw fail("Argumentos grandes demais.", 413);
    let owner = null;
    if (assistenteId && assistenteId !== "default") {
      owner = assistants.get(String(assistenteId));
      if (!owner) throw fail("Assistente não encontrado.", 404);
    }
    const text = await mcp.call(found.servidor, tool.name, args);
    const masked = maskSecrets(String(text || "")).slice(0, MAX_TEXT_CHARS);
    const items = toItems(masked, found.fonte).map((texto) => ({ texto }));
    if (!items.length) throw fail("O conector não devolveu texto para importar.", 422);
    const pacote = { formato: FORMATO, versao: VERSAO, criadoEm: new Date().toISOString(), origem: `${found.fonte} (somente leitura)` };
    if (owner) pacote.assistentes = [{ nome: owner.name, funcao: owner.role, instrucoes: owner.instructions, memoria: [], contexto: items }];
    else pacote.padrao = { memoria: [], contexto: items };
    return { pacote, itens: items.length, aviso: "Leitura feita só pela ferramenta de leitura. Nada foi enviado nem alterado. Confira a prévia antes de importar." };
  }

  return { list, read };
}

module.exports = { createContextSources, SOURCE_KINDS, isReadTool };