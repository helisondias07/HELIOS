"use strict";

/**
 * Carrega o @cursor/sdk do jeito que o app empacotado consegue resolver.
 * O require do build CJS passa pelo asar do Electron. O import() ESM fica de reserva.
 * A primeira linha e o código do erro original sobem juntos — sem trocar por uma frase genérica.
 */
function firstLine(err) {
  return String(err?.message || err || "O pacote de login do Cursor não está disponível neste HELIOS.").split(/\r?\n/)[0].slice(0, 180);
}

function sdkFailure(err) {
  return Object.assign(new Error(firstLine(err)), { code: err?.code || "SDK_AUSENTE", cause: err });
}

async function loadCursorSdk() {
  let loaded = null;
  let failure = null;
  try {
    loaded = require("@cursor/sdk");
  } catch (err) {
    failure = err;
  }
  if (!loaded?.Cursor && !loaded?.Agent) {
    try {
      loaded = await import("@cursor/sdk");
    } catch (err) {
      throw sdkFailure(failure || err);
    }
  }
  if (!loaded?.Cursor && !loaded?.Agent) throw sdkFailure(failure || new Error("Este SDK do Cursor não tem login pelo navegador."));
  return loaded;
}

module.exports = { loadCursorSdk };
