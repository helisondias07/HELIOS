"use strict";

/**
 * Regras do dono para a fila de vagas. Prefs da instalação entram por cima
 * dos valores canônicos (empresas a evitar e pretensão). Nada aqui é credencial.
 * O HELIOS não envia mensagem a recrutador.
 */

const CANONICAL_EVITAR = Object.freeze([
  "Quality Digital",
  "Micro1",
  "Micro Um",
  "BairesDev",
  "NeoWork",
  "Workana",
  "Strider",
  "Lovel",
]);

const ALIASES = Object.freeze({
  micro1: ["micro1", "microum", "microone", "micro um"],
  qualitydigital: ["qualitydigital", "quality digital"],
  bairesdev: ["bairesdev", "baires dev"],
  neowork: ["neowork", "neo work"],
});

const JUNIOR_BRL = 3500;
const PLENO_BRL = 8000;

const norm = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function tokensOf(name) {
  return norm(name)
    .replace(/\b(ltda|s\.?a\.?|me|eireli|inc|group|grupo)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function compact(name) {
  return tokensOf(name).join("");
}

function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const row = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cur = row[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[t.length];
}

function aliasKey(value) {
  const c = compact(value);
  for (const [key, names] of Object.entries(ALIASES)) {
    if (names.some((name) => compact(name) === c)) return key;
  }
  return "";
}

function empresaEvitada(company, prefs = {}) {
  const list = [...CANONICAL_EVITAR, ...((prefs && prefs.evitarEmpresas) || [])];
  const companyTokens = tokensOf(company);
  const companyCompact = companyTokens.join("");
  if (!companyCompact) return false;
  const companyAlias = aliasKey(company);
  return list.some((name) => {
    const avoidTokens = tokensOf(name);
    const avoidCompact = avoidTokens.join("");
    if (!avoidCompact) return false;
    if (avoidTokens.length && avoidTokens.every((token) => companyTokens.includes(token))) return true;
    if (companyCompact === avoidCompact) return true;
    const key = aliasKey(name);
    if (key && (key === companyAlias || key === companyCompact || ALIASES[key].some((item) => compact(item) === companyCompact))) return true;
    const canonical = CANONICAL_EVITAR.some((item) => compact(item) === avoidCompact);
    if (canonical && companyCompact.length >= 6 && avoidCompact.length >= 6 && Math.abs(companyCompact.length - avoidCompact.length) <= 1 && levenshtein(companyCompact, avoidCompact) <= 1) return true;
    return false;
  });
}

function formatBrl(amount) {
  const value = Math.round(Number(amount) || 0);
  const text = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${text}`;
}

function pretensao(job = {}, profile = {}) {
  const title = norm(job.title || "");
  const pleno = /\bpleno\b/.test(title) && !/\b(junior|jr)\b/.test(title);
  const juniorAmount = Number(profile.pretensaoBrlJunior) > 0 ? Number(profile.pretensaoBrlJunior) : JUNIOR_BRL;
  const plenoAmount = Number(profile.pretensaoBrlPleno) > 0 ? Number(profile.pretensaoBrlPleno) : PLENO_BRL;
  return formatBrl(pleno ? plenoAmount : juniorAmount);
}

function sections(job = {}) {
  const title = norm(job.title || "");
  const body = norm(`${job.location || ""}\n${job.description || ""}`);
  const cut = body.search(/\b(diferencial|desejavel|nice to have|plus|bonus|sera um diferencial)\b/);
  const req = (cut >= 0 ? body.slice(0, cut) : body)
    .replace(/\bnao\s+(usamos|utilizamos|exige|requer)\b[^.\n]{0,40}/g, " ");
  return { title, body, req, all: `${title}\n${req}` };
}

function remotoOnly(job = {}) {
  const text = norm(`${job.location || ""} ${job.title || ""} ${job.description || ""}`);
  const negatesOnsite = /\b(nao|sem)\s+(e\s+)?(hibrid|presencial|on-?site)\b/.test(text);
  const onlyRemote = /100\s*%\s*remoto|totalmente remoto|somente remoto|apenas remoto/.test(text);
  const hybrid = /\b(hibrid[oa]|presencial|on-?site|no escritorio)\b/.test(text);
  if (hybrid && !negatesOnsite && !onlyRemote) return false;
  return /100\s*%\s*remoto|totalmente remoto|somente remoto|apenas remoto|\bremoto\b|\bremote\b|home office|trabalho remoto/.test(text);
}

function nivelOk(job = {}) {
  const title = norm(job.title || "");
  const desc = norm(job.description || "");
  if (/\b(senior|especialista|staff|principal|lead|coordenador|arquiteto|gerente|head)\b/.test(title)) return false;
  if (/\b(nivel|senioridade)\s+senior\b/.test(desc) && !/\b(junior|jr|pleno)\b/.test(title)) return false;
  return true;
}

function papelOk(job = {}) {
  const text = norm(`${job.title || ""} ${job.description || ""}`);
  return /\b(front[- ]?end|frontend|full[- ]?stack|fullstack|node(?:\.js)?|react|next(?:\.js)?|typescript|\bts\b|\bia\b|\bai\b|machine learning|inteligencia artificial)\b/.test(text);
}

function stackBloqueada(job = {}) {
  const { title, req, all } = sections(job);
  const blocked = /\b(angular|java|php|c#|\.net|dotnet|asp\.net)\b/;
  if (blocked.test(title)) return true;
  if (!blocked.test(req)) return false;
  const allowed = /\b(front[- ]?end|frontend|full[- ]?stack|fullstack|node(?:\.js)?|react|next(?:\.js)?|typescript)\b/;
  return !allowed.test(all);
}

function requisito(job, pattern) {
  return pattern.test(sections(job).req) || pattern.test(sections(job).title);
}

function avaliarVaga(job = {}, prefs = {}) {
  const motivos = [];
  if (empresaEvitada(job.company, prefs)) motivos.push("empresa evitada");
  if (!remotoOnly(job)) motivos.push("não é somente remoto");
  if (!nivelOk(job)) motivos.push("senioridade fora de júnior/pleno");
  if (!papelOk(job)) motivos.push("fora de front, fullstack, Node, React, Next, TypeScript ou IA");
  if (stackBloqueada(job)) motivos.push("stack principal Angular, Java, .NET ou PHP");
  if (requisito(job, /(video de apresentacao|apresentacao em video|grave um video|envie um video|gravar video|video pitch|\bloom\b)/)) motivos.push("pede vídeo ou Loom");
  if (requisito(job, /(teste cronometrado|prova cronometrada|timed test|hackerrank|codility|teste com tempo|assessment cronometrado)/)) motivos.push("teste com tempo");
  if (requisito(job, /(vaga exclusiva|exclusiv[ao].{0,40}(pcd|deficien|negros|mulheres|lgbt|afirmativ)|vaga afirmativa|afirmativa exclusiva|apenas pcd|somente pcd)/)) motivos.push("vaga exclusiva PcD ou afirmativa");
  if (requisito(job, /((ingl[eê]s|english).{0,40}(fluente|fluent|avancado|advanced|nativo|native|c1|c2|obrigatorio)|(fluente|fluent|avancado|advanced|nativo|native).{0,30}(ingl[eê]s|english))/)) motivos.push("inglês fluente obrigatório");
  if (requisito(job, /(superior completo|graduacao completa|diploma obrigatorio|ensino superior completo|degree required|bachelor)/)) motivos.push("diploma completo obrigatório");
  if (requisito(job, /((obrigat[oó]ri[oa]|imprescind[ií]vel|must[- ]have|required).{0,48}(docker|kubernetes|\bk8s\b|aws)|(docker|kubernetes|\bk8s\b|aws).{0,48}(obrigat[oó]ri[oa]|imprescind[ií]vel|must[- ]have|required))/)) motivos.push("Docker, Kubernetes ou AWS obrigatório");
  return { aceita: motivos.length === 0, motivos };
}

function nuncaMensagemRecrutador() {
  return { ok: false, motivo: "O HELIOS não envia nem responde mensagem de recrutador." };
}

/** CAPTCHA e login pedem o dono. Botão ausente, rede e mapeamento são falha técnica. */
function classeFalha({ motivo = "", pergunta = "", codigo = "", classe = "" } = {}) {
  if (classe === "humano" || classe === "tecnico") return classe;
  const blob = norm(`${codigo} ${motivo} ${pergunta}`);
  if (/captcha|2fa|otp|login|senha|authwall|verificacao|perfil nao responde|perguntar ao usuario|raca|genero|termos legais|dedicacao exclusiva|ambiguidade|sem valor/.test(blob)) return "humano";
  return "tecnico";
}

module.exports = {
  CANONICAL_EVITAR,
  JUNIOR_BRL,
  PLENO_BRL,
  empresaEvitada,
  pretensao,
  formatBrl,
  avaliarVaga,
  nuncaMensagemRecrutador,
  classeFalha,
  remotoOnly,
  nivelOk,
  papelOk,
};
