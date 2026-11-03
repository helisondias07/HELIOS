"use strict";

/**
 * LEVA M: importador somente-leitura de vagas-helison → prévia → aplicar após aprovação.
 * CPF nunca entra em perfil/json/logs/prompt: só mascarado na prévia e, na aplicação, no cofre.
 */
const fs = require("node:fs");
const path = require("node:path");
const { newId, readJson, writeJson } = require("./util");

const DEFAULT_SOURCE = path.join("C:", "Users", "HelisonDias", "Repositorios", "vagas-helison");

const OBSOLETE_RULE_RE = /(2fa|gerenciador de senhas|virtustant|k2on|box antigo|copiar.*box|sess[oõ]es logadas no navegador do box)/i;

const STATUS_MAP = {
  aplicada: "enviada",
  aplicada_confirmada: "enviada",
  enviada: "enviada",
  pendente: "nova",
  bloqueada: "descartada",
  descartada: "descartada",
  recusada: "recusada",
  teste: "teste",
  critica: "critica",
  falhou: "falhou",
};

const PLATFORM_LOGIN = {
  LinkedIn: "https://www.linkedin.com/login",
  Gupy: "https://login.gupy.io/candidates/signin",
  GeekHunter: "https://www.geekhunter.com.br/login",
  ProgramaThor: "https://programathor.com.br/users/sign_in",
  Nerdin: "https://www.nerdin.com.br/login",
  Sólides: "https://login.solides.com.br/",
  Remotar: "https://remotar.com.br/login",
  trampos: "https://trampos.co/login",
  Revelo: "https://app.revelo.com.br/login",
  Coodesh: "https://coodesh.com/login",
  Indeed: "https://secure.indeed.com/auth",
  Glassdoor: "https://www.glassdoor.com/profile/login_input.htm",
  "Vagas.com": "https://www.vagas.com.br/login",
  InfoJobs: "https://www.infojobs.com.br/candidate/login.aspx",
  Catho: "https://www.catho.com.br/signin/",
  BossaBox: "https://app.bossabox.com/login",
  Strider: "https://www.onstrider.com/login",
  Lovel: "https://lovel.com.br/",
  InHire: "https://inhire.app/",
  Greenhouse: "https://boards.greenhouse.io/",
  Quickin: "https://app.quickin.io/",
  Ashby: "https://jobs.ashbyhq.com/",
  "GitHub vagas": "https://github.com/login",
  "99Freelas": "https://www.99freelas.com.br/login",
  "Freelancer.com": "https://www.freelancer.com/login",
};

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function parseCsv(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i += 1; }
        else q = !q;
      } else if (c === "," && !q) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = split(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = split(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (cols[i] || "").trim(); });
    return row;
  });
}

function maskCpf(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length !== 11) return "•••.•••.•••-••";
  return `•••.•••.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function extractCpf(perfilMd) {
  const m = String(perfilMd || "").replace(/\*/g, "").match(/\bCPF:\s*([0-9.-]+)/i);
  return m ? m[1].trim() : "";
}

function sectionAfter(md, headingRe) {
  const text = String(md || "");
  const m = headingRe.exec(text);
  if (!m) return "";
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const next = rest.search(/\n##\s+/);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

function parseRespostasTable(perfilMd) {
  const block = sectionAfter(perfilMd, /##\s*Respostas a perguntas comuns/i);
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m) continue;
    const q = m[1].trim();
    const a = m[2].trim();
    if (/^pergunta$/i.test(q) || /^-+$/.test(q.replace(/\s/g, ""))) continue;
    if (q && a) out[q.toLowerCase()] = a;
  }
  return out;
}

function parseAnosTec(perfilMd) {
  const block = sectionAfter(perfilMd, /##\s*Anos por tecnologia/i);
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m) continue;
    const tech = m[1].trim();
    const anos = m[2].trim();
    if (/^tecnologia$/i.test(tech) || /^-+/.test(tech)) continue;
    if (tech) out[tech] = anos;
  }
  return out;
}

function pickLine(md, re) {
  const line = String(md || "").split(/\r?\n/).find((l) => re.test(l.replace(/\*/g, "")));
  if (!line) return "";
  return line.replace(/^[-*]\s*/, "").replace(/\*\*/g, "").replace(re, "").replace(/^:\s*/, "").trim();
}

function buildPerfil(perfilMd) {
  const tituloOficial = pickLine(perfilMd, /oficial:\s*/i) || "";
  const tituloCurto = pickLine(perfilMd, /curto:\s*/i) || "";
  const cidade = (pickLine(perfilMd, /cidade:\s*/i) || "Bom Jardim, RJ")
    .replace(/\s*—.*$/, "").trim();
  const stackLine = sectionAfter(perfilMd, /##\s*Stack/i).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) || "";
  const pret = sectionAfter(perfilMd, /##\s*Condi[cç][oõ]es e pretens[aã]o/i) || sectionAfter(perfilMd, /##\s*Condições e pretensão/i);
  const brlJr = (pret.match(/j[uú]nior[^.]*R\$\s*([\d.]+)/i) || [])[1] || "3500";
  const brlPl = (pret.match(/pleno[^.]*R\$\s*([\d.]+)/i) || [])[1] || "8000";
  const usd = (pret.match(/US\$\s*([\d.]+)/i) || [])[1] || "";
  const pjH = (pret.match(/R\$\s*([\d.]+)\s*\/\s*h/i) || [])[1] || "25";
  const nomeRaw = pickLine(perfilMd, /nome:\s*/i) || "Helison Dias";
  return {
    nome: nomeRaw.replace(/^nome:\s*/i, "").trim() || "Helison Dias",
    email: (pickLine(perfilMd, /e-mail principal:\s*/i) || "helisondias07@gmail.com").replace(/^e-mail principal:\s*/i, "").split(/\s/)[0],
    telefone: (pickLine(perfilMd, /telefone\/whatsapp:\s*/i) || "").replace(/^telefone\/whatsapp:\s*/i, "").replace(/\*\*/g, ""),
    cidade,
    linkedin: (() => {
      const raw = (pickLine(perfilMd, /linkedin:\s*/i) || "").trim();
      if (!raw) return "https://www.linkedin.com/in/helisondias";
      return /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/\//, "")}`;
    })(),
    portfolio: (pickLine(perfilMd, /portf[oó]lio:\s*/i) || ""),
    github: (pickLine(perfilMd, /github:\s*/i) || ""),
    tituloOficial,
    tituloCurto,
    senioridade: "júnior e pleno",
    anosTecnologia: parseAnosTec(perfilMd),
    stack: stackLine.replace(/\s+/g, " ").trim(),
    ingles: "C1",
    contrato: "CLT ou PJ",
    pretensaoBrlJunior: Number(String(brlJr).replace(/\./g, "")) || 3500,
    pretensaoBrlPleno: Number(String(brlPl).replace(/\./g, "")) || 8000,
    pretensaoUsd: Number(String(usd).replace(/\./g, "")) || 0,
    pretensaoPjHora: Number(String(pjH).replace(/\./g, "")) || 25,
    pretensao: `R$ ${brlJr} júnior / R$ ${brlPl} pleno`,
    disponibilidade: "imediata",
    formacao: pickLine(perfilMd, /ci[eê]ncia da computa[cç][aã]o/i) ? "Ciência da Computação — Estácio (incompleto)" : "",
    remoto: true,
    presencialRj: true,
    aceitaPresencial: true,
    cidadesOk: ["Bom Jardim", "RJ"],
    cvPath: "",
    cvPathPt: "",
    cvPathEn: "",
    // LEVA O4: perfil.skills fonte única — deriva da stack/anos; evidência vazia (não inventar link).
    skills: (() => {
      const { extractSkills } = require("./agent-pesquisa");
      const text = [stackLine, ...Object.keys(parseAnosTec(perfilMd))].join(" ");
      return extractSkills(text).map((s) => ({ id: s.id, nome: s.nome, evidencia: "" }));
    })(),
  };
}

function defaultFiltros() {
  return {
    incluir: ["remoto", "react", "next", "front-end", "frontend", "typescript", "júnior", "pleno", "ia", "n8n"],
    excluir: ["sênior", "senior", "3+ anos", "4+ anos", "java obrigat", ".net", "php obrigat", "presencial", "híbrido sp", "mestrado"],
    notaMinima: 40,
  };
}

function parseRules(rulesMd) {
  const keep = [];
  for (const line of String(rulesMd || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("| Data") || t.startsWith("|---")) continue;
    if (OBSOLETE_RULE_RE.test(t)) continue;
    if (t.startsWith("|") || t.startsWith("-") || t.startsWith("*")) keep.push(t.replace(/^\|\s*/, "").replace(/\s*\|\s*$/, "").slice(0, 400));
  }
  return keep.slice(0, 80);
}

function normalizeStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (STATUS_MAP[s]) return STATUS_MAP[s];
  if (/aplicad|enviad|confirmad/.test(s)) return "enviada";
  if (/descart|encerrad|exige|presencial|bloque/.test(s)) return "descartada";
  if (/pendente|aguard/.test(s)) return "nova";
  if (/recus|reprov/.test(s)) return "recusada";
  if (/teste|assessment/.test(s)) return "teste";
  return "descartada";
}

function parsePlatforms(plataformasMd, defaultEmail) {
  const out = [];
  const seen = new Set();
  for (const line of String(plataformasMd || "").split(/\r?\n/)) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (!m) continue;
    const nome = m[1].trim();
    if (!nome || /^plataforma$/i.test(nome) || /^-+/.test(nome) || /sem conta/i.test(m[2])) continue;
    const email = (m[3].trim().match(/[\w.+-]+@[\w.-]+/) || [defaultEmail])[0];
    const key = nome.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      nome,
      url: PLATFORM_LOGIN[nome] || PLATFORM_LOGIN[nome.replace(/\s+/g, "")] || "",
      usuario: email || defaultEmail,
      senha: "",
    });
  }
  return out;
}

function parseTemplates(md) {
  const templates = [];
  let current = null;
  for (const line of String(md || "").split(/\r?\n/)) {
    const h = /^##\s+(.+)/.exec(line);
    if (h) {
      if (current) templates.push(current);
      current = { id: newId("tpl"), titulo: h[1].trim().slice(0, 120), corpo: "" };
      continue;
    }
    if (current) current.corpo += `${line}\n`;
  }
  if (current) templates.push(current);
  return templates.map((t) => ({ ...t, corpo: t.corpo.trim().slice(0, 4000) })).filter((t) => t.corpo.length > 20).slice(0, 40);
}

function morningPromptFrom(rotinaMd) {
  const m = String(rotinaMd || "").match(/```([\s\S]*?)```/);
  const body = (m ? m[1] : rotinaMd || "").trim();
  return `[vagas-manha]\n${body.slice(0, 6000)}`;
}

/**
 * Lê a pasta-fonte (somente leitura) e monta a prévia. Não grava nada.
 * @param {string} sourceDir
 * @param {{ readFile?: Function }} [opts]
 */
function previewImport(sourceDir = DEFAULT_SOURCE, opts = {}) {
  const root = path.resolve(sourceDir);
  const read = opts.readFile || ((p) => readText(p));
  const join = (...parts) => path.join(root, ...parts);
  if (!fs.existsSync(root) && !opts.readFile) {
    throw Object.assign(new Error(`Pasta fonte não encontrada: ${root}`), { status: 404 });
  }

  const perfilMd = read(join("perfil.md"));
  const regrasMd = read(join("regras-e-permissoes.md"));
  const rotinaMd = read(join("rotina-diaria.md"));
  const respostasMd = read(join("respostas-prontas.md"));
  const plataformasMd = read(join("plataformas.md"));
  const candidaturasCsv = read(join("candidaturas.csv"));
  const recruitersCsv = read(join("recruiters-linkedin.csv"));

  const cpfRaw = extractCpf(perfilMd);
  const perfil = buildPerfil(perfilMd);
  const cvPt = join("arquivos", "curriculo-helison-dias.pdf");
  const cvEn = join("arquivos", "curriculo-helison-dias-en.pdf");
  perfil.cvPathPt = fs.existsSync(cvPt) || opts.readFile ? cvPt : "";
  perfil.cvPathEn = fs.existsSync(cvEn) || opts.readFile ? cvEn : "";
  perfil.cvPath = perfil.cvPathPt || perfil.cvPathEn || "";

  const respostas = parseRespostasTable(perfilMd);
  const filtros = defaultFiltros();
  const regras = parseRules(regrasMd);
  const vagasManhaPrompt = morningPromptFrom(rotinaMd);
  const templates = parseTemplates(respostasMd);
  const plataformas = parsePlatforms(plataformasMd, perfil.email);

  const histRows = parseCsv(candidaturasCsv);
  const historico = histRows.map((row) => ({
    plataforma: row.plataforma || "",
    empresa: row.empresa || "",
    titulo: row.titulo || "",
    url: row.url || "",
    status: normalizeStatus(row.status),
    statusOrigem: row.status || "",
    motivo: (row.motivo || "").slice(0, 300),
    data: row.data || "",
  }));

  const recruiters = parseCsv(recruitersCsv).map((row) => ({
    name: row.name || "",
    company: row.company || "",
    role: row.role || "",
    profile_url: row.profile_url || "",
    date_invited: row.date_invited || "",
    date_messaged: row.date_messaged || "",
  })).filter((r) => r.name || r.profile_url);

  const previaId = newId("prev");
  const previa = {
    id: previaId,
    sourceDir: root,
    createdAt: new Date().toISOString(),
    perfil,
    respostas,
    filtros,
    regras,
    vagasManhaPrompt,
    templates,
    plataformas,
    historico,
    recruiters,
    cpfMascarado: cpfRaw ? maskCpf(cpfRaw) : "",
    // CPF real só em memória da prévia até aplicar → cofre; nunca em prefs.
    _cpfVault: cpfRaw || "",
    resumo: {
      perfilCampos: Object.keys(perfil).length,
      respostas: Object.keys(respostas).length,
      regras: regras.length,
      templates: templates.length,
      plataformas: plataformas.length,
      historico: historico.length,
      recruiters: recruiters.length,
      temCpf: Boolean(cpfRaw),
      cvPt: Boolean(perfil.cvPathPt),
      cvEn: Boolean(perfil.cvPathEn),
    },
  };
  return previa;
}

function createVagasImport(dataDir, {
  sourceDir = process.env.HELIOS_VAGAS_SOURCE || DEFAULT_SOURCE,
  jobs = null,
  vaultSaveCpf = null,
  vaultSavePlatform = null,
  routines = null,
  assistants = null,
} = {}) {
  const previasFile = path.join(dataDir, "vagas-import-previas.json");
  let bag = readJson(previasFile, { items: [] });
  if (!Array.isArray(bag.items)) bag.items = [];
  const saveBag = () => {
    // Nunca persistir CPF no disco das prévias.
    const safe = {
      items: bag.items.map((p) => {
        const copy = { ...p };
        delete copy._cpfVault;
        return copy;
      }).slice(-20),
    };
    writeJson(previasFile, safe);
  };

  function preview(dir = sourceDir) {
    const previa = previewImport(dir);
    bag.items = bag.items.filter((p) => p.id !== previa.id);
    bag.items.push(previa);
    if (bag.items.length > 10) bag.items = bag.items.slice(-10);
    saveBag();
    const publicPrev = { ...previa };
    delete publicPrev._cpfVault;
    return publicPrev;
  }

  function getPrevia(id) {
    return bag.items.find((p) => p.id === id) || null;
  }

  /**
   * Aplica prévia aprovada. Grava perfil/respostas/filtros/histórico; CPF só no cofre;
   * plataformas no cofre com senha vazia.
   */
  async function apply(previaId, { confirmar = false } = {}) {
    if (confirmar !== true) throw Object.assign(new Error("Confirme no cartão para importar."), { status: 400 });
    const previa = getPrevia(previaId);
    if (!previa) throw Object.assign(new Error("Prévia expirada. Gere de novo."), { status: 404 });

    const patch = {
      incluir: previa.filtros.incluir,
      excluir: previa.filtros.excluir,
      notaMinima: previa.filtros.notaMinima,
      perfil: { ...previa.perfil },
      respostas: { ...(previa.respostas || {}) },
    };
    // Garantir que CPF não vá para prefs.
    delete patch.perfil.cpf;
    if (jobs && typeof jobs.setPrefs === "function") jobs.setPrefs(patch);
    if (jobs && typeof jobs.importHistory === "function") jobs.importHistory(previa.historico || []);
    if (jobs && typeof jobs.importRecruiters === "function") jobs.importRecruiters(previa.recruiters || []);
    if (jobs && typeof jobs.setTemplates === "function") jobs.setTemplates(previa.templates || []);
    if (jobs && typeof jobs.setAgentRules === "function") jobs.setAgentRules(previa.regras || []);

    if (routines && typeof routines.add === "function" && previa.vagasManhaPrompt) {
      try {
        const existing = (routines.list && routines.list()) || [];
        const hit = existing.find((r) => /verifica[cç][aã]o das vagas|vagas-manha/i.test(r.title || r.prompt || ""));
        if (hit && routines.update) routines.update(hit.id, { prompt: previa.vagasManhaPrompt });
        else routines.add({ title: "Verificação das vagas", prompt: previa.vagasManhaPrompt, clock: "08:30", enabled: false });
      } catch { /* rotina opcional */ }
    }

    if (assistants && typeof assistants.importContext === "function" && (previa.regras || []).length) {
      try {
        assistants.importContext("vagas", ["# Regras importadas (vagas-helison)", ...previa.regras].join("\n"));
      } catch { /* assistente opcional */ }
    }

    const platformsSaved = [];
    if (typeof vaultSavePlatform === "function") {
      for (const p of previa.plataformas || []) {
        if (!p.nome) continue;
        // Senha vazia de propósito — usuário preenche no Cofre.
        const saved = await vaultSavePlatform({ nome: p.nome, url: p.url || "", usuario: p.usuario || "", senha: "" });
        platformsSaved.push({ nome: p.nome, url: p.url || "", usuario: p.usuario || "", senhaDefinida: Boolean(saved && saved.senhaDefinida) });
      }
    }

    let cpfNoCofre = false;
    if (typeof vaultSaveCpf === "function" && previa._cpfVault) {
      await vaultSaveCpf(previa._cpfVault);
      cpfNoCofre = true;
      previa._cpfVault = "";
    }

    bag.items = bag.items.filter((p) => p.id !== previaId);
    saveBag();

    return {
      ok: true,
      plataformas: platformsSaved,
      historico: (previa.historico || []).length,
      recruiters: (previa.recruiters || []).length,
      cpfNoCofre,
      perfil: jobs ? jobs.prefs().perfil : previa.perfil,
    };
  }

  return { preview, apply, getPrevia, previewImport, sourceDir, maskCpf, normalizeStatus, DEFAULT_SOURCE };
}

module.exports = {
  createVagasImport,
  previewImport,
  maskCpf,
  normalizeStatus,
  parseCsv,
  extractCpf,
  PLATFORM_LOGIN,
  OBSOLETE_RULE_RE,
  DEFAULT_SOURCE,
};
