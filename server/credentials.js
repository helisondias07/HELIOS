"use strict";

const { redact } = require("./util");

/** Aviso mostrado ao Helison quando algo parecido com segredo foi mascarado na mensagem dele. */
const USER_SECRET_NOTICE = "Troquei por [segredo] o que parecia senha, chave ou token na sua mensagem, antes de ela ir ao assistente e ao histórico. "
  + "Guarde segredos na aba Cofre: o assistente usa um login só pelo nome, e a senha nunca passa por ele.";

/**
 * Mensagem digitada no chat: mascara segredo (formatos conhecidos, "senha: ...", Authorization/Bearer, chave privada e qualquer
 * valor que já esteja no cofre) ANTES de ela ir ao modelo, ao histórico ou ao disco.
 * Devolve { text, masked, notice }. Limite: uma chave aleatória sem rótulo e sem prefixo conhecido não é reconhecida.
 */
function screenUserText(text) {
  const original = String(text ?? "");
  const text2 = redact(original);
  const masked = text2 !== original;
  return { text: text2, masked, notice: masked ? USER_SECRET_NOTICE : "" };
}

module.exports = { screenUserText, USER_SECRET_NOTICE };
