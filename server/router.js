"use strict";

/**
 * Roteamento Auto do HELIOS (mesmo espírito do Oasis Bot: heurística local,
 * custo zero, sem mandar a conversa inteira para um modelo caro só para classificar).
 *
 * - rápido: conversa, pergunta, ajuste pequeno. Modelo barato.
 * - padrão: uma parte do trabalho (um componente, um bug, uma tela).
 * - avançado: projeto novo, várias partes, plano grande. Modelo forte.
 */
const LEVELS = ["rapido", "padrao", "avancado"];
const LEVEL_LABEL = { rapido: "rápido", padrao: "padrão", avancado: "avançado" };

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const ACTION =
  /\b(implement\w*|cri[ae]r?|crie|fa[zc]a?|fazer|mud[ae]r?|mude|troc[ae]r?|troque|ajust[ae]r?|ajuste|corrig\w*|corrij\w*|coloc[ae]r?|coloque|adicion\w*|inclu[ia]r?|remov\w*|tir[ae]r?|aument\w*|diminu\w*|aplic\w*|alter\w*|atualiz\w*|substitu\w*|escrev\w*|reescrev\w*|monta\w*|constru\w*|desenvolv\w*|refa[zc]\w*|program\w*)\b/;
const QUESTION_START =
  /^(como|o que|oque|qual|quais|quando|onde|por que|porque|pq|quanto|quantos|quantas|quem|sera que|me (explica|diz|conta)|explica|existe|tem como|status)\b/;
const CHATTER =
  /^(oi+|ola|opa|e ai|eai|bom dia|boa tarde|boa noite|tudo bem|tudo bom|obrigad[oa]|valeu|vlw|beleza|blz|show|perfeito|otimo|massa|top|legal|ok|okay|certo|entendi|tranquilo|de nada|bora|fechado|joia)\b[\s\w!.,?]{0,24}$/;
const SMALL =
  /\b(fonte|font|tamanho|cor(es)?|color|espacamento|espaco|margem|margin|padding|gap|texto|titulo|subtitulo|negrito|italico|borda|border|radius|css|estilo|largura|altura)\b/;
const MEDIUM =
  /\b(componente|secao|section|card|botao|formulario|bug|quebrad\w*|nao funciona|responsiv\w*|mobile|desktop|funcao|script|api|tela|pagina)\b/;
const BIG =
  /\b(do zero|projeto novo|aplicativo|aplicacao|sistema inteiro|varias telas|pagina inteira|pagina nova|arquitetura|livecoding|passo a passo|completo)\b/;
const PLAN = /\b(plano|planej\w*|etapas|passos)\b/;

/**
 * @returns {{level:"rapido"|"padrao"|"avancado", kind:"pergunta"|"tarefa", reason:string}}
 */
function classify(text) {
  const raw = String(text || "").trim();
  const t = norm(raw);
  const words = t.split(/\s+/).filter(Boolean).length;
  const asks = /\?\s*$/.test(raw) || QUESTION_START.test(t);
  const action = ACTION.test(t);

  if (CHATTER.test(t) && !action) return { level: "rapido", kind: "pergunta", reason: "conversa" };
  if (asks && !action) return { level: "rapido", kind: "pergunta", reason: "pergunta" };
  if (!action && words <= 14 && !MEDIUM.test(t) && !BIG.test(t)) {
    return { level: "rapido", kind: "pergunta", reason: "sem pedido de mudança" };
  }
  if (BIG.test(t) || (PLAN.test(t) && (MEDIUM.test(t) || words > 30)) || (action && /\b(aplicativo|projeto|sistema)\b/.test(t) && words > 12)) {
    return { level: "avancado", kind: "tarefa", reason: "trabalho grande" };
  }
  if (SMALL.test(t) && !BIG.test(t) && words <= 40) return { level: "rapido", kind: "tarefa", reason: "ajuste pequeno" };
  if (MEDIUM.test(t) || (action && words > 8)) return { level: "padrao", kind: "tarefa", reason: "uma parte do trabalho" };
  if (words <= 24) return { level: "rapido", kind: "tarefa", reason: "pedido curto" };
  return { level: "padrao", kind: "tarefa", reason: "tarefa" };
}

module.exports = { LEVELS, LEVEL_LABEL, classify, norm };
