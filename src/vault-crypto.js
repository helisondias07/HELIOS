"use strict";

/**
 * Camada de criptografia do cofre. Usa o safeStorage ASSÍNCRONO do Electron
 * (isAsyncEncryptionAvailable / encryptStringAsync / decryptStringAsync) quando ele existe.
 * Se a versão do Electron não tiver essas funções, cai para a API síncrona (deprecada
 * desde o Electron 45 e removida no 46). Sem nenhuma das duas, o cofre fica só em memória.
 *
 * Nada aqui registra texto aberto, buffer cifrado ou chave em log.
 */
function hasFn(obj, name) {
  return Boolean(obj) && typeof obj[name] === "function";
}

function createVaultCrypto(safeStorage) {
  const hasAsync = hasFn(safeStorage, "encryptStringAsync")
    && hasFn(safeStorage, "decryptStringAsync")
    && hasFn(safeStorage, "isAsyncEncryptionAvailable");
  const hasSync = hasFn(safeStorage, "encryptString")
    && hasFn(safeStorage, "decryptString")
    && hasFn(safeStorage, "isEncryptionAvailable");

  let resolved = null;

  /** "async" | "sync" | "none". Decidido uma vez (depois do evento ready do app) e mantido. */
  async function mode() {
    if (resolved) return resolved;
    let picked = "none";
    if (hasAsync) {
      try {
        if (await safeStorage.isAsyncEncryptionAvailable()) picked = "async";
      } catch {
        /* tenta a síncrona */
      }
    }
    if (picked === "none" && hasSync) {
      try {
        if (safeStorage.isEncryptionAvailable()) picked = "sync";
      } catch {
        /* sem criptografia */
      }
    }
    resolved = picked;
    return picked;
  }

  async function encrypt(text) {
    const current = await mode();
    if (current === "async") return Buffer.from(await safeStorage.encryptStringAsync(String(text)));
    if (current === "sync") return Buffer.from(safeStorage.encryptString(String(text)));
    throw new Error("Sem criptografia disponível.");
  }

  /**
   * Devolve { text, reEncrypt }. `reEncrypt` = o sistema pediu para regravar (chave girou)
   * ou o dado só abriu pelo caminho síncrono antigo. Dado gravado pela API síncrona abre
   * pela assíncrona (documentação do Electron); se mesmo assim falhar, tenta a síncrona.
   */
  async function decrypt(buffer) {
    const current = await mode();
    if (current === "none") throw new Error("Sem criptografia disponível.");
    const input = Buffer.from(buffer);
    if (current === "async") {
      try {
        let out = await safeStorage.decryptStringAsync(input);
        let reEncrypt = false;
        if (out && out.shouldReEncrypt) {
          reEncrypt = true;
          out = await safeStorage.decryptStringAsync(input);
        }
        if (out && typeof out.result === "string") return { text: out.result, reEncrypt };
        throw new Error("Resposta inesperada do safeStorage.");
      } catch (err) {
        if (!hasSync) throw err;
        let text;
        try {
          text = safeStorage.decryptString(input);
        } catch {
          throw err;
        }
        return { text, reEncrypt: true };
      }
    }
    return { text: safeStorage.decryptString(input), reEncrypt: false };
  }

  return { mode, encrypt, decrypt, hasAsync, hasSync };
}

module.exports = { createVaultCrypto };
