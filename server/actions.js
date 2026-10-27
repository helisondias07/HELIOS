"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readJson, writeJson, redact } = require("./util");
const { normalizeTipo } = require("./irreversible");
const { fillMessage } = require("./vault-public");
const { formatResults } = require("./search");

function cleanAction(action = {}) {
  const tipo = normalizeTipo(action.tipo);
  const mcp = action.mcp && action.mcp.server && action.mcp.tool
    ? { server: String(action.mcp.server).slice(0, 40), tool: String(action.mcp.tool).slice(0, 80), args: action.mcp.args || {} }
    : null;
  return {
    tipo,
    resumo: redact(String(action.resumo || "Ação").slice(0, 200)),
    alvo: redact(String(action.alvo || "").slice(0, 300)),
    texto: redact(String(action.texto || "").slice(0, 1000)),
    loginId: action.loginId ? String(action.loginId).slice(0, 80) : "",
    conteudo: action.conteudo === undefined ? "" : redact(String(action.conteudo)).slice(0, 20000),
    mcp,
  };
}

/**
 * A ferramenta `helios_acao` é escrita pelo modelo. Só estes quatro campos de texto valem.
 * `mcp`, `loginId` e `conteudo` NUNCA vêm dela: conector só pelo `mcp_chamar` (que confere allowlist e classificação),
 * login só pelo `helios_preencher_login` (que confere o cofre) e arquivo só pelo `escrever_arquivo`.
 */
function sanitizeModelAction(args = {}) {
  return {
    tipo: args && args.tipo,
    resumo: args && args.resumo,
    alvo: args && args.alvo,
    texto: args && args.texto,
  };
}

/** Caminho dentro da pasta de projetos, sem seguir junction/symlink para fora. Devolve { target, rel }. */
function resolveInside(projectsDir, alvo, { followFinal }) {
  const root = path.resolve(String(projectsDir));
  const text = String(alvo || "");
  const target = path.resolve(root, text);
  const rel = path.relative(root, target);
  if (!text || !rel || rel.startsWith("..") || path.isAbsolute(rel) || text.includes(":")) return null;
  if (fs.existsSync(root)) {
    const realRoot = fs.realpathSync(root);
    let probe = followFinal ? target : path.dirname(target);
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realRel = path.relative(realRoot, fs.realpathSync(probe));
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
  }
  return { target, rel };
}

function createActions({ dataDir, projectsDir, mcp, onFillLogin, searchWeb }) {
  const outbox = path.join(dataDir, "outbox.json");

  /** `auto` = a ação roda sem cartão, porque o Helison liberou esse tipo em Autonomia. */
  async function perform(action, { auto = false } = {}) {
    const item = cleanAction(action);
    const ok = auto ? "" : "Aprovado. ";
    if (item.mcp && mcp) {
      // Revalida na hora de executar: a ferramenta tem de existir numa lista já testada de um conector confirmado.
      if (typeof mcp.findTool === "function" && !mcp.findTool(item.mcp.server, item.mcp.tool)) {
        throw new Error(`Não achei ${item.mcp.server}.${item.mcp.tool} numa lista já testada. Nada foi executado.`);
      }
      const text = await mcp.call(item.mcp.server, item.mcp.tool, item.mcp.args);
      return `${ok}Rodei ${item.mcp.server}.${item.mcp.tool}${auto ? "" : " depois do cartão"}.\n${redact(text).slice(0, 1500)}`;
    }
    if (item.tipo === "ler") {
      if (typeof searchWeb !== "function" || !item.alvo) throw new Error("Não sei ler isso por aqui. Use um conector ou a pesquisa.");
      const found = await searchWeb(item.alvo);
      return `${ok}Pesquisei “${item.alvo}”.\n${formatResults(found.query || item.alvo, found.results || []).slice(0, 1500)}`;
    }
    if (item.tipo === "escrever") {
      const root = path.resolve(String(projectsDir));
      fs.mkdirSync(root, { recursive: true });
      const inside = resolveInside(root, item.alvo, { followFinal: true });
      if (!inside) throw new Error("Só gravo arquivos dentro da pasta de projetos do HELIOS.");
      fs.mkdirSync(path.dirname(inside.target), { recursive: true });
      // Depois de criar as pastas, confere de novo: um junction criado no meio do caminho não pode levar para fora.
      if (!resolveInside(root, item.alvo, { followFinal: true })) throw new Error("Só gravo arquivos dentro da pasta de projetos do HELIOS.");
      fs.writeFileSync(inside.target, item.conteudo, "utf8");
      return `${ok}Gravei ${inside.rel.split(path.sep).join("/")} (${item.conteudo.length} caracteres).`;
    }
    if (item.tipo === "apagar") {
      const inside = resolveInside(projectsDir, action.alvo, { followFinal: false });
      if (!inside) throw new Error("Só apago arquivos dentro da pasta de projetos do HELIOS, e só depois da aprovação.");
      fs.rmSync(inside.target, { recursive: true, force: true });
      return `Apaguei ${inside.rel}${auto ? "" : " depois da sua aprovação"}.`;
    }
    if (item.tipo === "preencher") {
      if (typeof onFillLogin !== "function") throw new Error("O preenchimento não está disponível neste processo.");
      const result = await onFillLogin({ id: item.loginId, nome: item.alvo });
      return fillMessage(item.alvo, { ok: Boolean(result && result.ok) });
    }
    if (item.tipo === "pagar") {
      return "Aprovado. Nenhum pagamento saiu daqui: o HELIOS não move dinheiro. Quando houver um conector, ele também só roda depois deste cartão.";
    }
    const box = readJson(outbox, []);
    box.push({ at: new Date().toISOString(), tipo: item.tipo, resumo: item.resumo, alvo: item.alvo, texto: item.texto });
    writeJson(outbox, box);
    if (auto) return `Registrei “${item.resumo}” para ${item.tipo} na caixa de saída local. Nada saiu do computador.`;
    return `Aprovado. Registrei “${item.resumo}” para ${item.tipo}. Nada foi enviado para fora sem este cartão.`;
  }

  return { perform, cleanAction, outbox };
}

module.exports = { createActions, cleanAction, sanitizeModelAction, resolveInside };