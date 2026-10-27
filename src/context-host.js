"use strict";

const fs = require("node:fs");
const path = require("node:path");

const NAME_RE = /^helios-contexto-[\w.-]{1,60}\.json$/;
const MAX_SAVE_CHARS = 2_000_000;

/**
 * Parte do processo principal da Fase 2: seletor de pasta, "salvar como" do pacote de contexto e Lixeira do sistema.
 * Recebe `dialog` e `shell` do Electron (nos testes, falsos). `HELIOS_TEST_FOLDER` e `HELIOS_TEST_SAVE_DIR` só valem
 * com `mock: true` (HELIOS_MOCK=1), para testar a janela sem abrir diálogos nativos; com o app instalado são ignorados.
 */
function createContextHost({ dialog, shell, getWindow = () => null, documentsDir, mock = false, env = process.env }) {
  async function pickFolder() {
    if (mock && env.HELIOS_TEST_FOLDER) return env.HELIOS_TEST_FOLDER;
    const win = getWindow();
    const result = await dialog.showOpenDialog(win || undefined, { title: "Escolha uma pasta que o HELIOS pode usar", properties: ["openDirectory"] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  }

  async function saveFile(payload) {
    const nome = String(payload && payload.nome || "");
    const texto = payload && payload.texto;
    if (!NAME_RE.test(nome)) return { ok: false, error: "Nome de arquivo inválido." };
    if (typeof texto !== "string" || !texto || texto.length > MAX_SAVE_CHARS) return { ok: false, error: "Conteúdo inválido ou grande demais." };
    let target;
    if (mock && env.HELIOS_TEST_SAVE_DIR) {
      target = path.join(path.resolve(env.HELIOS_TEST_SAVE_DIR), nome);
    } else {
      const win = getWindow();
      const result = await dialog.showSaveDialog(win || undefined, {
        title: "Salvar pacote de contexto",
        defaultPath: path.join(documentsDir || "", nome),
        filters: [{ name: "Pacote de contexto do HELIOS (JSON)", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelado: true };
      target = result.filePath;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, texto, { encoding: "utf8", mode: 0o600 });
    return { ok: true, caminho: target };
  }

  /** Lixeira do sistema (reversível). Nunca apaga de vez. */
  const trashItem = (target) => shell.trashItem(target);

  return { pickFolder, saveFile, trashItem };
}

/** Pastas do sistema que nunca podem virar "pasta permitida". */
function protectedFolders(env = process.env, execPath = process.execPath) {
  return [env.SystemRoot, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData, path.dirname(execPath)].filter(Boolean);
}

module.exports = { createContextHost, protectedFolders, NAME_RE };