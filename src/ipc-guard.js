"use strict";

const { pathToFileURL } = require("node:url");

/**
 * Guarda de IPC: só a página do HELIOS (arquivos dentro de renderer/) pode chamar os canais do processo principal.
 * Se um dia alguma janela ou frame carregar outro conteúdo (navegação inesperada, iframe), as chamadas dele são recusadas.
 * Falha fechada: sem frame de origem, ou com URL fora de renderer/, nada é executado.
 *
 * A comparação é tolerante a maiúsculas/minúsculas, %-codificação e barras (letra de unidade do Windows, espaços no caminho).
 */
function normalize(url) {
  let text = String(url || "");
  try {
    text = decodeURIComponent(text);
  } catch {
    /* mantém o texto como veio */
  }
  return text.replace(/\\/g, "/").toLowerCase();
}

function createRendererGuard(rendererDir) {
  const base = `${normalize(pathToFileURL(rendererDir).href).replace(/\/+$/, "")}/`;

  function isAllowedUrl(url) {
    const text = normalize(url);
    if (!text.startsWith(base)) return false;
    return !text.slice(base.length).split("/").some((part) => part === "..");
  }

  /** `event` de ipcMain.handle / ipcMain.on. */
  function isAllowedEvent(event) {
    const frame = event && event.senderFrame;
    return Boolean(frame) && isAllowedUrl(frame.url);
  }

  /** Para webContents.on("will-navigate"): navegação para fora de renderer/ é cancelada. */
  function blockNavigation(event, url) {
    if (!isAllowedUrl(url) && event && typeof event.preventDefault === "function") event.preventDefault();
  }

  return { isAllowedUrl, isAllowedEvent, blockNavigation, base };
}

/**
 * Envolve ipcMain.handle e ipcMain.on: o listener só roda se o evento vier de uma página do HELIOS.
 * Chame ANTES de registrar qualquer canal. `onDenied(canal, url)` é opcional (log).
 */
function guardIpcMain(ipc, guard, onDenied = () => {}) {
  const rawHandle = ipc.handle.bind(ipc);
  const rawOn = ipc.on.bind(ipc);
  ipc.handle = (channel, listener) => rawHandle(channel, (event, ...args) => {
    if (!guard.isAllowedEvent(event)) {
      onDenied(channel, event && event.senderFrame ? event.senderFrame.url : "");
      throw new Error("Origem não autorizada.");
    }
    return listener(event, ...args);
  });
  ipc.on = (channel, listener) => rawOn(channel, (event, ...args) => {
    if (!guard.isAllowedEvent(event)) {
      onDenied(channel, event && event.senderFrame ? event.senderFrame.url : "");
      return undefined;
    }
    return listener(event, ...args);
  });
  return ipc;
}

module.exports = { createRendererGuard, guardIpcMain };