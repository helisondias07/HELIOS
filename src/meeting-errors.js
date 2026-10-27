"use strict";

/**
 * Mensagens de erro do modo de reunião em português claro, sem jargão de rede.
 * Erro que já é uma frase nossa (por exemplo "Nenhuma chave de API...") passa como está.
 */
function friendlyError(err) {
  const raw = String(err && err.message ? err.message : err || "erro");
  const status = Number(err && err.status) || 0;
  const name = String((err && err.name) || "");
  const code = String((err && (err.code || (err.cause && err.cause.code))) || "");
  if (status === 401 || status === 403) return "A chave de API foi recusada. Abra Configurações, cole a chave de novo e use Testar chaves.";
  if (status === 429) return "O limite gratuito da IA foi atingido por agora. Espere cerca de 1 minuto. Se repetir, aumente o Bloco de áudio para 9 segundos em Configurações.";
  if (status >= 500 && status < 600) return "O serviço de IA está instável agora. Tente de novo em instantes.";
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|timeout/i.test(raw)) return "A IA demorou demais para responder. Confira a internet e tente de novo.";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|network|socket hang up/i.test(`${raw} ${code}`)) {
    return "Sem conexão com a internet (ou o serviço não respondeu). Confira a rede e tente de novo.";
  }
  return raw;
}

module.exports = { friendlyError };
