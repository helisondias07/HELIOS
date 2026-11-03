"use strict";

/**
 * Leva G: lê e-mails de vagas (só remetente, assunto e trecho) e separa:
 * recusa, teste, entrevista, confirmação de inscrição, importante. E-mail de código de verificação é ignorado:
 * ele nunca entra no resumo nem vai para o modelo.
 */
const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const RULES = {
  codigo: /(codigo|code)\s+de\s+(verificacao|acesso|seguranca)|verification code|one-time|\botp\b|seu codigo|your code/,
  recusa: /(nao (seguiremos|vamos seguir|avancaremos|foi selecionad)|optamos por (seguir|prosseguir) com outr|decidimos (seguir|prosseguir) com outr|outros candidatos|nao sera possivel (seguir|avancar)|processo (foi )?encerrado|unfortunately|not (be )?moving forward|other candidates|we have decided to|nao foi aprovad|reprovad)/,
  teste: /(teste tecnico|desafio tecnico|case tecnico|avaliacao (online|tecnica)|teste (online|de perfil|de logica)|coding challenge|take[- ]home|assessment|hackerrank|codility)/,
  entrevista: /(entrevista|interview|bate[- ]papo|conversa com (o|a) (time|recrutador|gestor)|agendar (uma )?conversa)/,
  inscricao: /(candidatura (foi )?(recebida|enviada|realizada|confirmada)|recebemos (a sua|sua) candidatura|inscricao (realizada|confirmada)|application (received|submitted)|thanks for applying|obrigad[oa] por se candidatar)/,
};

function classify({ from = "", subject = "", snippet = "" } = {}) {
  const text = fold(`${subject} ${snippet}`);
  if (RULES.codigo.test(text)) return "codigo";
  if (RULES.recusa.test(text)) return "recusa";
  if (RULES.teste.test(text)) return "teste";
  if (RULES.entrevista.test(text)) return "entrevista";
  if (RULES.inscricao.test(text)) return "inscricao";
  if (/gupy|linkedin|catho|indeed|vagas\.com|infojobs|kenoby|solides|recrut|talent|rh@|jobs?@|careers?@/i.test(`${from} ${subject}`)) return "vaga";
  return "outro";
}

/** Motivo da recusa, quando o e-mail diz ("perfil mais alinhado a X", "buscando alguém com Y"). */
function rejectionReason(text) {
  const t = String(text || "").replace(/\s+/g, " ");
  const patterns = [
    /perfil (?:mais )?(?:alinhado|aderente|adequado) (?:a|ao|à|com|aos|às)\s+([^.;\n]{3,140})/i,
    /(?:buscando|procurando|priorizando) (?:um |uma )?(?:profissional|candidat[oa]|pessoa|dev\w*)? ?(?:com|que tenha|que possua)\s+([^.;\n]{3,140})/i,
    /(?:mais|maior) experi[eê]ncia (?:em|com)\s+([^.;\n]{3,140})/i,
    /(?:looking for|seeking) (?:a |an |someone |candidates )?(?:with )?([^.;\n]{3,140})/i,
    /(?:more|stronger) experience (?:in|with)\s+([^.;\n]{3,140})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m) return m[1].trim().replace(/[,\s]+$/, "").slice(0, 160);
  }
  return "";
}

/** Empresa provável: nome antes do @ do domínio ou "Equipe X" no remetente. */
function companyFrom(from = "", subject = "") {
  const name = String(from).replace(/<[^>]+>/, "").replace(/["']/g, "").trim();
  const m = /(?:vaga|processo|candidatura)[^-–|]*[-–|:]\s*([^-–|]{2,60})$/i.exec(subject);
  if (m) return m[1].trim();
  return name.replace(/\b(equipe|time|recrutamento|talentos|rh|via gupy|jobs|careers|no-?reply)\b/gi, "").trim().slice(0, 60);
}

const SKILL_WORDS = ["react", "next.js", "nextjs", "typescript", "javascript", "node", "vue", "angular", "testes", "jest", "cypress", "css", "tailwind", "ux", "ui", "figma", "acessibilidade", "seo", "performance", "aws", "docker", "graphql", "rest", "api", "inglês", "ingles", "english", "sênior", "senior", "pleno", "liderança", "e-commerce", "vtex", "wake", "shopify", "git", "scrum", "back-end", "backend", "full stack", "fullstack", "mobile", "react native", "python", "java", "php", "sql"];

/** Padrões das recusas: palavras que mais aparecem nos motivos e sugestões curtas. */
function patterns(reasons = []) {
  const counts = new Map();
  const words = [...new Set(SKILL_WORDS.map(fold))];
  for (const reason of reasons) {
    const t = fold(reason);
    for (const w of words) {
      if (new RegExp(`(^|[^a-z])${w.replace(/[.+]/g, "\\$&")}([^a-z]|$)`).test(t)) counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([termo, vezes]) => ({ termo, vezes }));
  const sugestoes = top.map(({ termo }) => {
    if (/ingles|english/.test(termo)) return "Inglês: reforçar conversação e citar o nível no CV.";
    if (/senior|pleno|lideranca/.test(termo)) return `Senioridade (${termo}): destacar projetos com impacto e autonomia no CV.`;
    if (/testes|jest|cypress/.test(termo)) return "Testes: um projeto de portfólio com Jest/Cypress e citar no CV.";
    return `Estudar ${termo} e colocar um projeto com ${termo} no portfólio/CV.`;
  });
  return { total: reasons.length, top, sugestoes };
}

module.exports = { classify, rejectionReason, companyFrom, patterns, RULES, fold };
