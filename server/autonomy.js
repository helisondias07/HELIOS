"use strict";

const path = require("node:path");
const { readJson, writeJson, nowIso } = require("./util");

const MODES = ["pedir", "sozinho"];

/**
 * Tipos de ação. `locked` = nunca pode ser "sozinho", nem por arquivo editado à mão,
 * nem por assistente: pagar e usar segredo do cofre (preencher login).
 */
const TIPOS = [
  { tipo: "enviar", label: "Enviar", hint: "E-mail, mensagem ou qualquer coisa que sai daqui.", locked: false, fallback: "pedir" },
  { tipo: "pagar", label: "Pagar", hint: "Pagamentos e transferências. Sempre pede antes.", locked: true, fallback: "pedir" },
  { tipo: "apagar", label: "Apagar", hint: "Apagar arquivos ou dados.", locked: false, fallback: "pedir" },
  { tipo: "publicar", label: "Publicar", hint: "Colocar algo no ar ou postar em público.", locked: false, fallback: "pedir" },
  { tipo: "ler", label: "Ler e pesquisar", hint: "Pesquisar na web e ler dados de conectores.", locked: false, fallback: "sozinho" },
  { tipo: "preencher", label: "Preencher login (usar segredo do cofre)", hint: "Digitar uma senha do cofre. Sempre pede antes.", locked: true, fallback: "pedir" },
  { tipo: "escrever", label: "Escrever arquivo", hint: "Gravar arquivos na pasta de projetos.", locked: false, fallback: "pedir" },
];

const BY_TIPO = new Map(TIPOS.map((item) => [item.tipo, item]));

/**
 * "Bot rascunha, humano envia/apaga/publica": em rotinas e ajudantes (ninguém olhando a conversa),
 * estes tipos sempre viram cartão, mesmo que "sozinho" esteja liberado em Autonomia.
 * Dá para desligar em Autonomia (automaticoPede); pagar e preencher login nunca saem de "pedir".
 */
const AUTOMATIC_ALWAYS_ASK = ["enviar", "apagar", "publicar"];

function isLocked(tipo) {
  const found = BY_TIPO.get(tipo);
  return found ? found.locked : false;
}

/** Modo efetivo de um tipo. Desconhecido, inválido ou travado vira "pedir" (ou o padrão do tipo). */
function resolveMode(tipo, ...layers) {
  const info = BY_TIPO.get(tipo);
  if (!info) return "pedir";
  if (info.locked) return "pedir";
  for (const layer of layers) {
    const value = layer && typeof layer === "object" ? layer[tipo] : undefined;
    if (MODES.includes(value)) return value;
  }
  return info.fallback;
}

/** Valida um conjunto de escolhas vindo da tela ou de um assistente. Recusa "sozinho" nos travados. */
function cleanModes(input) {
  const out = {};
  if (input === null || input === undefined) return out;
  if (typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Autonomia inválida."), { status: 400 });
  for (const [tipo, mode] of Object.entries(input)) {
    if (!BY_TIPO.has(tipo)) throw Object.assign(new Error(`Tipo de ação desconhecido: ${String(tipo).slice(0, 30)}.`), { status: 400 });
    if (!MODES.includes(mode)) throw Object.assign(new Error('Use "pedir" ou "sozinho".'), { status: 400 });
    if (isLocked(tipo) && mode !== "pedir") {
      throw Object.assign(new Error(`“${BY_TIPO.get(tipo).label}” sempre pede antes. Essa trava não muda.`), { status: 400 });
    }
    out[tipo] = mode;
  }
  return out;
}

function createAutonomy(dataDir) {
  const file = path.join(dataDir, "autonomy.json");
  const saved = readJson(file, {});
  // Arquivo editado à mão: entrada por entrada, só entra o que é válido e permitido.
  const modes = {};
  const raw = saved && typeof saved.modes === "object" && saved.modes && !Array.isArray(saved.modes) ? saved.modes : {};
  for (const [tipo, value] of Object.entries(raw)) {
    try {
      Object.assign(modes, cleanModes({ [tipo]: value }));
    } catch {
      /* ignora o que é inválido ou travado */
    }
  }

  let automaticoPede = saved.automaticoPede !== false;

  /**
   * Modo efetivo: assistente (se tiver escolha própria) > configuração geral > padrão. Travados sempre pedem.
   * `opts.automated`: o pedido vem de rotina ou ajudante (veja AUTOMATIC_ALWAYS_ASK).
   */
  function mode(tipo, assistantModes, opts = {}) {
    if (opts && opts.automated && automaticoPede && AUTOMATIC_ALWAYS_ASK.includes(tipo)) return "pedir";
    return resolveMode(tipo, assistantModes, modes);
  }

  function view() {
    return {
      modes: TIPOS.map((item) => ({
        tipo: item.tipo,
        label: item.label,
        hint: item.hint,
        locked: item.locked,
        default: item.fallback,
        mode: resolveMode(item.tipo, modes),
      })),
      automaticoPede,
      automaticoTipos: AUTOMATIC_ALWAYS_ASK,
      updatedAt: saved.updatedAt || null,
    };
  }

  function set(patch) {
    const hasFlag = Boolean(patch) && typeof patch === "object" && Object.prototype.hasOwnProperty.call(patch, "automaticoPede");
    if (hasFlag && typeof patch.automaticoPede !== "boolean") throw Object.assign(new Error("automaticoPede deve ser verdadeiro ou falso."), { status: 400 });
    const rawModes = patch && patch.modes !== undefined ? patch.modes : hasFlag ? undefined : patch;
    const clean = cleanModes(rawModes);
    Object.assign(modes, clean);
    if (hasFlag) automaticoPede = patch.automaticoPede;
    saved.updatedAt = nowIso();
    writeJson(file, { version: 1, modes, automaticoPede, updatedAt: saved.updatedAt });
    return view();
  }

  return { mode, view, set, file };
}

module.exports = { createAutonomy, resolveMode, cleanModes, isLocked, TIPOS, MODES, AUTOMATIC_ALWAYS_ASK };
