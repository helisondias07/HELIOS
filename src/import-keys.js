"use strict";

const fs = require("node:fs");

/**
 * Copia chaves do arquivo solto para o cofre. Só apaga o arquivo se cada
 * gravação persistiu, ou se não havia chave nova para gravar.
 */
async function importKeyFile(file, vault, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return { removed: false, reason: "ausente" };
  let keys;
  try {
    keys = JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch {
    return { removed: false, reason: "inválido" };
  }
  const results = [];
  if (keys && keys.groq && !vault.getKey("groq")) results.push(await vault.setKey("groq", keys.groq));
  if (keys && keys.gemini && !vault.getKey("gemini")) results.push(await vault.setKey("gemini", keys.gemini));
  if (results.some((result) => !result || result.persisted !== true)) {
    return { removed: false, reason: "não persistiu" };
  }
  fsImpl.unlinkSync(file);
  return { removed: true };
}

module.exports = { importKeyFile };
