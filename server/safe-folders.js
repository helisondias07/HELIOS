"use strict";

/**
 * Pastas seguras do PC (Fase 2).
 *
 * O Helison escolhe, numa janela do sistema, as pastas que o HELIOS pode tocar. Ler e gravar só dentro delas, usando a mesma
 * checagem de caminho real da pasta de projetos (resolveInside, NV-3): junction/symlink que leva para fora é recusado.
 * Apagar NUNCA é definitivo: só move para a Lixeira do sistema (`trashItem`). Sem `trashItem`, nada é apagado.
 * A lista de pastas só muda por `adicionar` (que recebe o caminho do seletor, não do pedido) e `remover` (que tira da lista,
 * nunca mexe nos arquivos).
 */

const fs = require("node:fs");
const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");
const { resolveInside } = require("./actions");

const MAX_READ_BYTES = 1_000_000;
const MAX_WRITE_CHARS = 1_000_000;
const MAX_LIST = 500;
const MAX_FOLDERS = 20;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const sameOrInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

function createSafeFolders(dataDir, { trashItem = null, pickFolder = null, extraBlocked = [] } = {}) {
  const file = path.join(dataDir, "pastas.json");
  const saved = readJson(file, { version: 1, items: [] });
  let items = Array.isArray(saved.items) ? saved.items.filter((item) => item && typeof item.id === "string" && typeof item.path === "string") : [];
  const save = () => writeJson(file, { version: 1, items });
  const realData = (() => {
    try {
      return fs.realpathSync(dataDir);
    } catch {
      return path.resolve(dataDir);
    }
  })();

  const view = (item) => ({ id: item.id, nome: item.name, caminho: item.path, adicionadaEm: item.addedAt });
  const list = () => items.map(view);
  const find = (id) => {
    const item = items.find((entry) => entry.id === String(id || ""));
    if (!item) throw fail("Essa pasta não está na lista de pastas permitidas.", 404);
    return item;
  };

  /** Pastas que nunca podem entrar: raiz do disco, a pasta de dados do HELIOS (cofre) e qualquer pasta que a contenha ou esteja dentro dela. */
  function refusal(real) {
    if (path.parse(real).root === real) return "Escolha uma pasta, não o disco inteiro.";
    if (sameOrInside(real, realData) || sameOrInside(realData, real)) return "Essa pasta contém (ou é) a pasta de dados do HELIOS, onde fica o cofre. Escolha outra.";
    for (const blocked of extraBlocked) {
      try {
        const real2 = fs.realpathSync(blocked);
        if (sameOrInside(real, real2) || sameOrInside(real2, real)) return "Essa pasta é protegida pelo sistema. Escolha outra.";
      } catch {
        /* pasta protegida inexistente: nada a comparar */
      }
    }
    return "";
  }

  /** Adiciona uma pasta (caminho absoluto de uma pasta que existe). Guarda o caminho real, já resolvido. */
  function add(input) {
    const text = String(input || "").trim();
    if (!text || !path.isAbsolute(text)) throw fail("Informe o caminho completo de uma pasta.");
    let real;
    try {
      real = fs.realpathSync(text);
      if (!fs.statSync(real).isDirectory()) throw new Error("não é pasta");
    } catch {
      throw fail("Essa pasta não existe ou não é uma pasta.");
    }
    const why = refusal(real);
    if (why) throw fail(why);
    if (items.some((entry) => entry.path.toLowerCase() === real.toLowerCase())) throw fail("Essa pasta já está na lista.", 409);
    if (items.length >= MAX_FOLDERS) throw fail(`Limite de ${MAX_FOLDERS} pastas permitidas.`, 409);
    const item = { id: newId("pasta"), name: path.basename(real) || real, path: real, addedAt: nowIso() };
    items.push(item);
    save();
    return view(item);
  }

  /** Abre o seletor do sistema (o caminho vem de lá, nunca do pedido) e adiciona. Devolve null se o Helison cancelou. */
  async function pick() {
    if (typeof pickFolder !== "function") throw fail("O seletor de pastas não está disponível neste modo.", 501);
    const chosen = await pickFolder();
    if (!chosen) return null;
    return add(chosen);
  }

  /** Tira da lista. Não mexe em nenhum arquivo da pasta. */
  function remove(id) {
    const before = items.length;
    items = items.filter((entry) => entry.id !== String(id || ""));
    if (items.length === before) return false;
    save();
    return true;
  }

  /** Raiz real da pasta, conferida de novo a cada uso (se virou junction para outro lugar, recusa). */
  function rootOf(id) {
    const item = find(id);
    let real;
    try {
      real = fs.realpathSync(item.path);
    } catch {
      throw fail("A pasta não existe mais.", 404);
    }
    if (real.toLowerCase() !== item.path.toLowerCase()) throw fail("A pasta mudou de lugar (atalho ou junction). Remova-a da lista e adicione de novo.", 409);
    const why = refusal(real);
    if (why) throw fail(why, 409);
    return real;
  }

  function target(id, rel, { followFinal }) {
    const root = rootOf(id);
    const text = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!text || text === ".") return { root, target: root, rel: "", isRoot: true };
    const inside = resolveInside(root, text, { followFinal });
    if (!inside) throw fail("Esse caminho está fora da pasta permitida.", 403);
    return { root, target: inside.target, rel: inside.rel.split(path.sep).join("/"), isRoot: false };
  }

  function listFiles(id, rel = "") {
    const at = target(id, rel, { followFinal: true });
    let entries;
    try {
      entries = fs.readdirSync(at.target, { withFileTypes: true });
    } catch {
      throw fail("Não consegui abrir essa pasta.", 404);
    }
    const out = entries.slice(0, MAX_LIST).map((entry) => {
      let size = null;
      let link = false;
      try {
        const st = fs.lstatSync(path.join(at.target, entry.name));
        link = st.isSymbolicLink();
        if (entry.isFile()) size = st.size;
      } catch {
        /* some da listagem sem tamanho */
      }
      return { nome: entry.name, tipo: link ? "atalho" : entry.isDirectory() ? "pasta" : "arquivo", tamanho: size };
    }).sort((a, b) => (a.tipo === "pasta" ? 0 : 1) - (b.tipo === "pasta" ? 0 : 1) || a.nome.localeCompare(b.nome));
    return { caminho: at.rel, itens: out, cortado: entries.length > MAX_LIST };
  }

  /** Lê texto (até 1 MB). O conteúdo passa por redact(): segredo em arquivo não vai para a tela nem para o modelo. */
  function read(id, rel) {
    const at = target(id, rel, { followFinal: true });
    if (at.isRoot) throw fail("Informe um arquivo.");
    let stat;
    try {
      stat = fs.statSync(at.target);
    } catch {
      throw fail("Arquivo não encontrado.", 404);
    }
    if (!stat.isFile()) throw fail("Isso não é um arquivo.");
    if (stat.size > MAX_READ_BYTES) throw fail("Arquivo grande demais para ler aqui (limite 1 MB).", 413);
    const raw = fs.readFileSync(at.target, "utf8");
    if (raw.includes("\u0000")) throw fail("Arquivo binário: só leio texto.", 415);
    const text = redact(raw);
    return { caminho: at.rel, texto: text, mascarado: text !== raw, tamanho: stat.size };
  }

  /** Grava texto dentro da pasta. Cria subpastas e confere de novo o caminho real depois de criá-las. */
  function write(id, rel, content) {
    const text = String(content ?? "");
    if (text.length > MAX_WRITE_CHARS) throw fail("Conteúdo grande demais (limite 1 milhão de caracteres).", 413);
    const at = target(id, rel, { followFinal: true });
    if (at.isRoot) throw fail("Informe o nome de um arquivo.");
    fs.mkdirSync(path.dirname(at.target), { recursive: true });
    const again = target(id, rel, { followFinal: true });
    if (again.target !== at.target) throw fail("O caminho mudou durante a gravação. Nada foi gravado.", 409);
    try {
      if (fs.statSync(at.target).isDirectory()) throw fail("Esse caminho é uma pasta, não um arquivo.");
    } catch (err) {
      if (err.status) throw err;
    }
    fs.writeFileSync(at.target, text, "utf8");
    return { caminho: at.rel, caracteres: text.length };
  }

  /** Move para a Lixeira do sistema. Nunca apaga de vez; atalhos/junctions e a própria pasta permitida são recusados. */
  async function trash(id, rel) {
    if (typeof trashItem !== "function") throw fail("A Lixeira do sistema não está disponível. Nada foi apagado.", 501);
    const at = target(id, rel, { followFinal: false });
    if (at.isRoot) throw fail("Não apago a própria pasta permitida. Remova-a da lista se quiser.");
    let stat;
    try {
      stat = fs.lstatSync(at.target);
    } catch {
      throw fail("Arquivo não encontrado.", 404);
    }
    if (stat.isSymbolicLink()) throw fail("Isso é um atalho (link/junction). Não mexo nele; apague você mesmo, se quiser.", 409);
    await trashItem(at.target);
    return { caminho: at.rel, mensagem: `Movi “${at.rel}” para a Lixeira. Dá para restaurar por lá.` };
  }

  return { list, add, pick, remove, listFiles, read, write, trash, trashAvailable: () => typeof trashItem === "function", pickerAvailable: () => typeof pickFolder === "function", file };
}

module.exports = { createSafeFolders };