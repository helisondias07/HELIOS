"use strict";

const path = require("node:path");
const { newId, readJson, writeJson } = require("./util");
const { tokens } = require("./memory");
const mail = require("./vagas-email");
const regras = require("./vagas-regras");
const { canonicalJobUrl } = require("./vagas-visual");

/**
 * Fase 7: bot de vagas seguro. Busca vagas públicas, dá nota pelo contexto.md, prepara a inscrição
 * e só libera o envio depois de um cartão aprovado pelo Helison. Tem limite de ritmo e registro.
 * O servidor nunca vê senha: o login é feito pelo processo principal (src/jobs-host.js) com o cofre.
 */

const decode = (text) => String(text || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();

function parseLinkedin(html) {
  const out = [];
  const blocks = String(html || "").split(/<li[\s>]/).slice(1);
  for (const block of blocks) {
    const id = (block.match(/jobPosting:(\d+)/) || [])[1];
    const href = (block.match(/class="base-card__full-link[^"]*"[^>]*href="([^"]+)"/) || block.match(/href="(https:\/\/[a-z.]*linkedin\.com\/jobs\/view\/[^"]+)"/) || [])[1];
    if (!id || !href) continue;
    const title = decode((block.match(/<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/) || block.match(/<span class="sr-only">([\s\S]*?)<\/span>/) || [])[1]);
    const company = decode((block.match(/<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/) || [])[1]);
    const location = decode((block.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
    const postedAt = (block.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || null;
    out.push({ extId: id, title, company, location, url: decode(href).split("?")[0], postedAt, description: "" });
  }
  return out;
}

function parseGupy(html) {
  const match = String(html || "").match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  let data;
  try { data = JSON.parse(match[1]); } catch { return []; }
  const list = data?.props?.pageProps?.initialJobList?.data || [];
  return list.map((job) => ({
    extId: String(job.id),
    title: String(job.name || ""),
    company: String(job.careerPageName || ""),
    location: [job.city, job.state].filter(Boolean).join(", ") || (job.workplaceType === "remote" ? "Remoto" : ""),
    remote: job.workplaceType === "remote",
    url: String(job.jobUrl || ""),
    postedAt: job.publishedDate || null,
    description: decode(job.description).slice(0, 1500),
  })).filter((job) => /^https:\/\//.test(job.url));
}

/** Plataformas. Para adicionar outra: id, nome, domínios, endereço de login, URL de busca e um parser. */
const PLATFORMS = {
  linkedin: {
    id: "linkedin",
    label: "LinkedIn",
    domains: ["linkedin.com"],
    loginUrl: "https://www.linkedin.com/login",
    feedUrl: "https://www.linkedin.com/feed/",
    codeFrom: "linkedin.com",
    searchUrl: (term, location) => `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(term)}&location=${encodeURIComponent(location || "Brasil")}&start=0`,
    parse: parseLinkedin,
  },
  gupy: {
    id: "gupy",
    label: "Gupy",
    domains: ["gupy.io"],
    loginUrl: "https://login.gupy.io/candidates/signin",
    codeFrom: "gupy",
    searchUrl: (term) => `https://portal.gupy.io/job-search/term=${encodeURIComponent(term)}`,
    parse: parseGupy,
  },
};

const DEFAULT_PREFS = {
  termos: ["desenvolvedor front-end"],
  local: "Brasil",
  incluir: [],
  excluir: [],
  notaMinima: 40,
  porHora: 3,
  // LEVA M: sem teto diário (porDia removido do ritmo). Campo legado ignorado se ainda existir no JSON.
  plataformas: ["linkedin", "gupy"],
  // Leva E: modo automático é opcional e começa desligado. "aprovacao" = cartão antes de cada envio.
  modo: "aprovacao",
  evitarEmpresas: [],
  repetirDias: 30,
  perfil: {
    nome: "", email: "", telefone: "", cidade: "", linkedin: "", portfolio: "", github: "",
    cvPath: "", cvPathPt: "", cvPathEn: "", pretensao: "",
    tituloOficial: "", tituloCurto: "", senioridade: "", stack: "", ingles: "",
    contrato: "", pretensaoBrlJunior: 0, pretensaoBrlPleno: 0, pretensaoUsd: 0, pretensaoPjHora: 0,
    disponibilidade: "", formacao: "", remoto: true, presencialRj: true,
    aceitaPresencial: false, cidadesOk: [], anosTecnologia: {},
    // LEVA O4: fonte única de skills com evidência (link) por item.
    skills: [],
  },
  respostas: {},
  templates: [],
  regrasAgente: [],
  recruiters: [],
};

const PERFIL_KEYS = [
  "nome", "email", "telefone", "cidade", "linkedin", "portfolio", "github",
  "cvPath", "cvPathPt", "cvPathEn", "pretensao", "tituloOficial", "tituloCurto",
  "senioridade", "stack", "ingles", "contrato", "disponibilidade", "formacao",
];
const PERFIL_NUM = ["pretensaoBrlJunior", "pretensaoBrlPleno", "pretensaoUsd", "pretensaoPjHora"];
const normCompany = (name) => String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(ltda|s\.?a\.?|me|eireli|inc|group|grupo)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const STATUS = ["nova", "aguardando_aprovacao", "aprovada", "enviada", "falhou", "descartada", "auto_enviando", "critica", "recusada", "teste"];

function splitList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,;\n]/);
  return [...new Set(list.map((item) => String(item).trim()).filter((item) => item.length >= 2))].slice(0, 20);
}

/** Nota de 0 a 100: título bate com o termo, palavras do perfil, palavras obrigatórias; palavra excluída zera. */
function scoreJob(job, { profileText = "", prefs = DEFAULT_PREFS } = {}) {
  const hay = `${job.title} ${job.company} ${job.location} ${job.description || ""}`;
  const hayTokens = new Set(tokens(hay));
  const titleTokens = new Set(tokens(job.title));
  const lower = hay.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const norm = (word) => String(word).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  for (const word of prefs.excluir || []) if (word && lower.includes(norm(word))) return { score: 0, motivos: [`tem "${word}" (excluído)`] };
  const motivos = [];
  let score = 0;
  const termHit = (prefs.termos || []).find((term) => { const t = tokens(term); return t.length && t.every((w) => [...titleTokens].some((x) => x.startsWith(w.slice(0, 5)))); });
  if (termHit) { score += 50; motivos.push(`título bate com "${termHit}"`); }
  else if ((prefs.termos || []).some((term) => tokens(term).some((w) => titleTokens.has(w)))) { score += 25; motivos.push("título parecido"); }
  const profile = new Set(tokens(profileText));
  const shared = [...hayTokens].filter((word) => profile.has(word) && word.length >= 4);
  if (shared.length) { score += Math.min(30, shared.length * 5); motivos.push(`perfil: ${shared.slice(0, 5).join(", ")}`); }
  const inc = (prefs.incluir || []).filter((word) => lower.includes(norm(word)));
  if (inc.length) { score += Math.min(20, inc.length * 10); motivos.push(`tem ${inc.join(", ")}`); }
  return { score: Math.min(100, score), motivos };
}

/** Nota do perfil mais as regras do dono. Fora da regra não entra na fila. */
function gateJob(job, { profileText = "", prefs = DEFAULT_PREFS } = {}) {
  const gate = regras.avaliarVaga(job, prefs);
  const scored = scoreJob(job, { profileText, prefs });
  if (!gate.aceita) {
    return { score: 0, motivos: [...gate.motivos, ...scored.motivos].slice(0, 8), status: "descartada" };
  }
  const min = Number.isFinite(Number(prefs.notaMinima)) ? Number(prefs.notaMinima) : 40;
  return { score: scored.score, motivos: scored.motivos, status: scored.score >= min ? "nova" : "descartada" };
}

/** Rascunho de apresentação, local e sem nuvem. O Helison edita antes de aprovar. */
function draftLetter(job, profileText) {
  const first = String(profileText || "").split(/\r?\n/).map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).filter((line) => line.length > 20 && !/\[preencher\]/i.test(line))[0] || "";
  return [
    `Olá, equipe ${job.company || ""}!`.replace(" !", "!"),
    `Tenho interesse na vaga de ${job.title}.${first ? ` ${first.slice(0, 280)}` : ""}`,
    "Acredito que posso contribuir com o time e fico à disposição para conversar.",
    "Obrigado, Helison Dias",
  ].join("\n\n");
}

function mockResults(platform, term) {
  return [1, 2].map((n) => ({
    extId: `${platform}-${n}`,
    title: n === 1 ? `${term} pleno` : `Analista de marketing ${n}`,
    company: `Empresa Demo ${n}`,
    location: n === 1 ? "Remoto" : "São Paulo",
    url: `https://exemplo.invalid/${platform}/vaga/${n}`,
    postedAt: null,
    description: n === 1 ? "React, JavaScript, e-commerce e design de interfaces" : "Planilhas e vendas",
  }));
}

function createJobs(dataDir, { fetchImpl = globalThis.fetch, now = () => Date.now(), readProfile = () => "", mock = false, platforms = PLATFORMS } = {}) {
  const file = path.join(dataDir, "vagas.json");
  const logFile = path.join(dataDir, "candidaturas.json");
  let data = readJson(file, { version: 1, prefs: { ...DEFAULT_PREFS }, vagas: [] });
  if (!Array.isArray(data.vagas)) data.vagas = [];
  // Clonar arrays/objetos do default para não vazar estado entre instâncias/testes.
  data.prefs = {
    ...DEFAULT_PREFS,
    ...(data.prefs || {}),
    termos: [...(data.prefs?.termos || DEFAULT_PREFS.termos)],
    incluir: [...(data.prefs?.incluir || [])],
    excluir: [...(data.prefs?.excluir || [])],
    plataformas: [...(data.prefs?.plataformas || DEFAULT_PREFS.plataformas)],
    evitarEmpresas: [...(data.prefs?.evitarEmpresas || [])],
    respostas: { ...(data.prefs?.respostas || {}) },
    templates: [...(data.prefs?.templates || [])],
    regrasAgente: [...(data.prefs?.regrasAgente || [])],
    recruiters: [...(data.prefs?.recruiters || [])],
    perfil: {
      ...DEFAULT_PREFS.perfil,
      ...(data.prefs?.perfil || {}),
      anosTecnologia: { ...(data.prefs?.perfil?.anosTecnologia || {}) },
      cidadesOk: [...(data.prefs?.perfil?.cidadesOk || [])],
      skills: Array.isArray(data.prefs?.perfil?.skills)
        ? data.prefs.perfil.skills.map((s) => ({
          id: String(s?.id || "").slice(0, 40),
          nome: String(s?.nome || s?.name || s?.id || "").slice(0, 80),
          evidencia: String(s?.evidencia || s?.evidence || "").slice(0, 500),
        })).filter((s) => s.id)
        : [],
    },
  };
  // App fechado no meio de um envio automático: não sabemos se foi. Vira "falhou" para você conferir (nunca reenvia sozinho).
  for (const v of data.vagas) if (v.status === "auto_enviando") { v.status = "falhou"; v.nota = "Interrompida (app fechado no meio do envio). Confira no site."; }
  let log = readJson(logFile, []);
  if (!Array.isArray(log)) log = [];
  const save = () => writeJson(file, data);
  const saveLog = () => writeJson(logFile, log);
  const err = (message, status = 400) => Object.assign(new Error(message), { status });
  const iso = () => new Date(now()).toISOString();

  function record(vaga, status, nota = "") {
    log.push({ id: newId("cand"), vagaId: vaga.id, plataforma: vaga.platform, titulo: vaga.title, empresa: vaga.company, url: vaga.url, status, nota: String(nota || "").slice(0, 300), at: iso() });
    if (log.length > 2000) log = log.slice(-2000);
    saveLog();
  }

  function prefs() { return { ...data.prefs }; }

  function setPrefs(patch = {}) {
    const next = { ...data.prefs };
    if (patch.termos !== undefined) next.termos = splitList(patch.termos);
    if (patch.incluir !== undefined) next.incluir = splitList(patch.incluir);
    if (patch.excluir !== undefined) next.excluir = splitList(patch.excluir);
    if (patch.local !== undefined) next.local = String(patch.local || "").trim().slice(0, 80);
    if (patch.notaMinima !== undefined) next.notaMinima = Math.max(0, Math.min(100, Number(patch.notaMinima) || 0));
    if (patch.porHora !== undefined) next.porHora = Math.max(1, Math.min(20, Number(patch.porHora) || 1));
    // LEVA M: porDia removido — ritmo suave só por hora.
    if (patch.porDia !== undefined) delete next.porDia;
    if (patch.modo !== undefined) next.modo = patch.modo === "automatico" ? "automatico" : "aprovacao";
    if (patch.evitarEmpresas !== undefined) next.evitarEmpresas = splitList(patch.evitarEmpresas);
    if (patch.repetirDias !== undefined) next.repetirDias = Math.max(1, Math.min(365, Number(patch.repetirDias) || 30));
    if (patch.respostas && typeof patch.respostas === "object") {
      next.respostas = { ...(next.respostas || {}), ...Object.fromEntries(Object.entries(patch.respostas).map(([k, v]) => [String(k).slice(0, 160), String(v).slice(0, 500)])) };
    }
    if (patch.perfil && typeof patch.perfil === "object") {
      const perfil = { ...DEFAULT_PREFS.perfil, ...(next.perfil || {}) };
      for (const key of PERFIL_KEYS) if (patch.perfil[key] !== undefined) perfil[key] = String(patch.perfil[key] || "").trim().slice(0, 500);
      for (const key of PERFIL_NUM) if (patch.perfil[key] !== undefined) perfil[key] = Number(patch.perfil[key]) || 0;
      if (patch.perfil.aceitaPresencial !== undefined) perfil.aceitaPresencial = patch.perfil.aceitaPresencial === true || patch.perfil.aceitaPresencial === "true";
      if (patch.perfil.remoto !== undefined) perfil.remoto = patch.perfil.remoto === true || patch.perfil.remoto === "true";
      if (patch.perfil.presencialRj !== undefined) perfil.presencialRj = patch.perfil.presencialRj === true || patch.perfil.presencialRj === "true";
      if (patch.perfil.cidadesOk !== undefined) perfil.cidadesOk = splitList(patch.perfil.cidadesOk);
      if (patch.perfil.anosTecnologia && typeof patch.perfil.anosTecnologia === "object") perfil.anosTecnologia = patch.perfil.anosTecnologia;
      // LEVA O4: perfil.skills = [{ id, nome, evidencia }] — fonte única; nunca inventar evidência.
      if (patch.perfil.skills !== undefined) {
        const list = Array.isArray(patch.perfil.skills) ? patch.perfil.skills : [];
        const seen = new Set();
        perfil.skills = [];
        for (const item of list.slice(0, 80)) {
          if (!item || typeof item !== "object") continue;
          const id = String(item.id || item.nome || item.name || "").trim().toLowerCase().slice(0, 40);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          perfil.skills.push({
            id,
            nome: String(item.nome || item.name || id).trim().slice(0, 80),
            evidencia: String(item.evidencia || item.evidence || "").trim().slice(0, 500),
          });
        }
      }
      if (!Array.isArray(perfil.skills)) perfil.skills = [];
      // Nunca aceitar CPF no perfil persistido.
      delete perfil.cpf;
      next.perfil = perfil;
    }
    if (patch.plataformas !== undefined) next.plataformas = splitList(patch.plataformas).filter((id) => platforms[id]);
    if (!next.termos.length) throw err("Informe pelo menos um cargo ou termo de busca.");
    delete next.porDia;
    data.prefs = next;
    save();
    return prefs();
  }

  async function search() {
    const p = data.prefs;
    const profileText = String(readProfile() || "");
    const erros = [];
    const fontes = [];
    let novas = 0;
    for (const platformId of p.plataformas) {
      const platform = platforms[platformId];
      if (!platform) continue;
      for (const term of p.termos.slice(0, 5)) {
        let found = [];
        try {
          if (mock) found = mockResults(platformId, term);
          else {
            const res = await fetchImpl(platform.searchUrl(term, p.local), { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HELIOS", accept: "text/html,application/json" } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const raw = await res.text();
            found = platform.parse(raw);
            fontes.push({ plataforma: platformId, termo: term, status: res.status, bytes: raw.length, encontradas: found.length });
          }
        } catch (e) {
          erros.push(`${platform.label} (${term}): ${e.message}`);
          fontes.push({ plataforma: platformId, termo: term, ok: false, erro: e.message });
          continue;
        }
        for (const job of found.slice(0, 40)) {
          if (data.vagas.some((v) => v.platform === platformId && v.extId === job.extId)) continue;
          const gated = gateJob(job, { profileText, prefs: p });
          data.vagas.push({ id: newId("vaga"), platform: platformId, ...job, score: gated.score, motivos: gated.motivos, status: gated.status, auto: gated.status !== "nova", foundAt: iso() });
          if (gated.status === "nova") novas += 1;
        }
      }
    }
    if (data.vagas.length > 800) data.vagas = data.vagas.slice(-800);
    save();
    return { novas, total: data.vagas.filter((v) => v.status === "nova").length, erros, fontes, semPerfil: !profileText.trim() };
  }

  function list({ status } = {}) {
    return data.vagas.filter((v) => !status || v.status === status).sort((a, b) => b.score - a.score || String(b.foundAt).localeCompare(String(a.foundAt)));
  }
  const get = (id) => data.vagas.find((v) => v.id === id) || null;
  /** LEVA S2: grava nota da triagem LLM (e modelo) em disco. */
  function setTriagem(id, { score, motivos, modelo } = {}) {
    const v = get(id);
    if (!v) return null;
    v.score = Math.max(0, Math.min(100, Number(score) || 0));
    if (Array.isArray(motivos)) v.motivos = motivos.map(String).slice(0, 8);
    v.triagemModelo = modelo ? String(modelo).slice(0, 120) : null;
    v.triagemEm = iso();
    save();
    return v;
  }
  const must = (id) => { const v = get(id); if (!v) throw err("Vaga não encontrada.", 404); return v; };

  function discard(id) { const v = must(id); v.status = "descartada"; v.auto = false; save(); return v; }

  /** Prepara a inscrição e abre o cartão de aprovação. Nada é enviado aqui. */
  function prepare(id, { carta } = {}) {
    const v = must(id);
    if (!["nova", "falhou", "descartada"].includes(v.status)) throw err("Essa vaga já está em andamento.", 409);
    v.carta = String(carta || draftLetter(v, readProfile())).slice(0, 3000);
    v.status = "aguardando_aprovacao";
    v.preparedAt = iso();
    save();
    record(v, "preparada");
    return v;
  }

  function counts(at = now()) {
    const sent = log.filter((item) => item.status === "aprovada" || item.status === "enviada_auto" || item.status === "auto_iniciada").map((item) => Date.parse(item.at));
    return { hora: sent.filter((t) => at - t < 3600e3).length, dia: sent.filter((t) => at - t < 86400e3).length };
  }

  /** O clique do Helison no cartão. Respeita o ritmo por hora (sem teto diário). */
  function approve(id, { carta } = {}) {
    const v = must(id);
    if (v.status !== "aguardando_aprovacao") throw err("Essa vaga não está esperando aprovação.", 409);
    const c = counts();
    if (c.hora >= data.prefs.porHora) throw err(`Limite de ${data.prefs.porHora} candidatura(s) por hora atingido. Tente mais tarde.`, 429);
    if (carta !== undefined) v.carta = String(carta).slice(0, 3000);
    v.status = "aprovada";
    v.approvedAt = iso();
    save();
    record(v, "aprovada");
    return v;
  }

  function deny(id) {
    const v = must(id);
    if (v.status !== "aguardando_aprovacao") throw err("Essa vaga não está esperando aprovação.", 409);
    v.status = "descartada";
    save();
    record(v, "negada");
    return v;
  }

  function markResult(id, { ok, nota = "" } = {}) {
    const v = must(id);
    if (v.status !== "aprovada") throw err("Só dá para marcar resultado de candidatura aprovada.", 409);
    v.status = ok ? "enviada" : "falhou";
    save();
    record(v, ok ? "enviada" : "falhou", nota);
    return v;
  }

  // ---- Leva E: modo automático ----
  const avoided = (v) => regras.empresaEvitada(v.company, data.prefs);
  function sameApplication(item, vaga) {
    const left = String(item.url || "");
    const right = String(vaga.url || "");
    if (left && right && left === right) return true;
    const idOf = (url) => (String(url).match(/jobs\/view\/(\d+)/i) || String(url).match(/\/jobs\/(\d+)/) || [])[1] || "";
    const a = idOf(left);
    const b = idOf(right);
    if (a && b && a === b) return true;
    const company = normCompany(item.empresa);
    const other = normCompany(vaga.company);
    return Boolean(company && other && company === other);
  }
  /** Já se candidatou nesta vaga (mesma URL) ou nesta empresa nos últimos X dias? */
  function recentlyApplied(v, at = now()) {
    const windowMs = (Number(data.prefs.repetirDias) || 30) * 86400e3;
    return log.some((item) => ["enviada", "enviada_auto", "aprovada"].includes(item.status)
      && at - Date.parse(item.at) < windowMs
      && sameApplication(item, v));
  }
  function eligible(v) {
    return regras.avaliarVaga(v, data.prefs).aceita && !avoided(v);
  }
  function rateLeft(at = now()) {
    const c = counts(at);
    return Math.max(0, data.prefs.porHora - c.hora);
  }
  /** Fila do automático: vagas novas acima da nota mínima, sem empresa evitada nem repetida, dentro do limite. */
  function autoQueue(at = now()) {
    const left = rateLeft(at);
    if (!left) return [];
    return data.vagas
      .filter((v) => v.status === "nova" && v.score >= data.prefs.notaMinima && eligible(v) && !recentlyApplied(v, at))
      .sort((a, b) => b.score - a.score)
      .slice(0, left);
  }
  /** Explica por que cada vaga nova não entrou na fila automática. Nunca inclui dados sensíveis. */
  function autoQueueDiagnostics(at = now()) {
    const left = rateLeft(at);
    const min = data.prefs.notaMinima;
    return data.vagas
      .filter((v) => v.status === "nova")
      .map((v) => {
        const motivos = [];
        if (!left) motivos.push("limite_por_hora");
        if (Number(v.score) < min) motivos.push("nota_abaixo_do_minimo");
        if (avoided(v)) motivos.push("empresa_evitada");
        if (!regras.avaliarVaga(v, data.prefs).aceita) motivos.push("regra_do_dono");
        if (recentlyApplied(v, at)) motivos.push("candidatura_recente_na_vaga_ou_empresa");
        return { id: v.id, plataforma: v.platform, empresa: v.company, titulo: v.title, motivos };
      })
      .filter((v) => v.motivos.length);
  }
  /** O automático vai abrir esta vaga. Confere modo, limite e repetição de novo (o servidor é a trava). */
  function autoStart(id) {
    if (data.prefs.modo !== "automatico") throw err("O modo automático está desligado.", 409);
    const v = must(id);
    if (v.status !== "nova") throw err("Essa vaga não está na fila do automático.", 409);
    if (!eligible(v)) throw err("A vaga foge das regras do dono ou está na lista de evitar.", 409);
    if (recentlyApplied(v)) throw err(`Já houve candidatura nessa vaga ou empresa nos últimos ${data.prefs.repetirDias} dias.`, 409);
    if (!rateLeft()) throw err("Limite por hora atingido.", 429);
    v.status = "auto_enviando";
    v.autoAt = iso();
    save();
    record(v, "auto_iniciada");
    return v;
  }
  /** Resultado do automático: enviada, crítica (pergunta para o Helison) ou falhou. */
  function autoResult(id, { ok = false, critico = "", pergunta = "", nota = "", via = "", model = "", estado = "", evidencia = [], confirmacao = "", codigo = "", classe = "" } = {}) {
    const v = must(id);
    if (v.status !== "auto_enviando") throw err("Essa vaga não está em envio automático.", 409);
    v.autoVia = String(via || "").slice(0, 40) || null;
    v.autoModelo = String(model || "").slice(0, 120) || null;
    v.autoEstado = String(estado || "").slice(0, 40) || null;
    v.autoEvidencia = Array.isArray(evidencia) ? evidencia.slice(-12) : [];
    const successEvidence = Array.isArray(evidencia) && evidencia.some((item) => /success|confirm/.test(String(item && item.kind || "")));
    const confirmed = Boolean(String(confirmacao || "").trim()) || successEvidence;
    const motivoTexto = ok && !confirmed
      ? "Sem confirmação positiva do site. Nada foi marcado como enviada."
      : String(critico || nota || "");
    const tipo = regras.classeFalha({ motivo: motivoTexto, pergunta, codigo, classe });
    if (ok && confirmed) {
      v.status = "enviada";
      v.confirmacao = String(confirmacao || "confirmação do site").slice(0, 180);
      record(v, "enviada_auto", nota);
    } else if ((ok && !confirmed) || critico || nota) {
      const humano = tipo === "humano" && !(ok && !confirmed);
      if (humano) {
        v.status = "critica";
        v.critico = {
          motivo: motivoTexto.slice(0, 200),
          pergunta: String(pergunta || motivoTexto).slice(0, 400),
          codigo: String(v.id).slice(-6),
          classe: "humano",
          via: v.autoVia,
          modelo: v.autoModelo,
          estado: v.autoEstado,
          evidencia: v.autoEvidencia,
          at: iso(),
        };
        record(v, "critica", v.critico.motivo);
      } else {
        v.status = "falhou";
        v.falhaClasse = "tecnico";
        v.nota = motivoTexto.slice(0, 300);
        v.critico = null;
        record(v, "falhou", v.nota);
      }
    } else {
      v.status = "falhou";
      v.falhaClasse = "tecnico";
      record(v, "falhou", nota);
    }
    save();
    return v;
  }
  const criticals = () => data.vagas.filter((v) => v.status === "critica");
  /** Reaplica regras nas vagas novas e tira da fila de "sua resposta" as falhas técnicas antigas. */
  function revisarFila() {
    let descartadas = 0;
    let tecnicas = 0;
    for (const vaga of data.vagas) {
      if (vaga.status === "nova") {
        const gate = regras.avaliarVaga(vaga, data.prefs);
        if (!gate.aceita) {
          vaga.status = "descartada";
          vaga.score = 0;
          vaga.motivos = [...gate.motivos, ...(vaga.motivos || [])].slice(0, 8);
          descartadas += 1;
        }
      } else if (vaga.status === "critica" && regras.classeFalha({ motivo: vaga.critico && vaga.critico.motivo, codigo: vaga.critico && vaga.critico.codigo, classe: vaga.critico && vaga.critico.classe }) === "tecnico") {
        vaga.status = "falhou";
        vaga.falhaClasse = "tecnico";
        vaga.nota = String((vaga.critico && vaga.critico.motivo) || "Falha técnica.").slice(0, 300);
        vaga.autoEvidencia = (vaga.critico && vaga.critico.evidencia) || vaga.autoEvidencia || [];
        vaga.critico = null;
        tecnicas += 1;
      }
    }
    if (descartadas || tecnicas) save();
    return { descartadas, tecnicas };
  }
  const findCritical = (code) => criticals().find((v) => v.id === code || v.critico?.codigo === String(code));
  /** Resposta do Helison a um caso crítico: guarda para as próximas e devolve a vaga à fila. */
  function answerCritical(code, resposta) {
    const v = findCritical(code);
    if (!v) throw err("Caso crítico não encontrado.", 404);
    const text = String(resposta || "").trim();
    if (!text) throw err("Escreva a resposta.");
    // A pergunta vem como 'Motivo: "rótulo do campo"'; a resposta fica guardada pelo rótulo, para o preenchimento achar depois.
    const asked = String(v.critico.pergunta || "");
    const quoted = asked.match(/"([^"]+)"\s*$/);
    const key = (quoted ? quoted[1] : asked).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
    data.prefs.respostas = { ...(data.prefs.respostas || {}), [key]: text.slice(0, 500) };
    v.status = "nova";
    v.critico = null;
    save();
    record(v, "critica_respondida");
    return v;
  }
  function skipCritical(code) {
    const v = findCritical(code);
    if (!v) throw err("Caso crítico não encontrado.", 404);
    v.status = "descartada";
    v.critico = null;
    save();
    record(v, "critica_pulada");
    return v;
  }
  /** Resumo do dia (para o Telegram). */
  function dailySummary(at = now()) {
    const day = new Date(at).toISOString().slice(0, 10);
    const today = log.filter((item) => String(item.at).slice(0, 10) === day);
    const n = (st) => today.filter((item) => item.status === st).length;
    const lines = [`Resumo das vagas (${day.split("-").reverse().join("/")})`,
      `Enviadas sozinho: ${n("enviada_auto")}`, `Enviadas por você: ${n("enviada")}`, `Casos críticos: ${n("critica")}`, `Falhas técnicas: ${n("falhou")}`,
      `Esperando sua resposta: ${criticals().length}`];
    for (const item of today.filter((x) => x.status === "enviada_auto").slice(0, 10)) lines.push(`• ${item.titulo} — ${item.empresa}`);
    return lines.join("\n");
  }


  // ---- Leva G: e-mails das vagas, recusas, testes, posts do LinkedIn e resumo do dia ----
  if (!Array.isArray(data.emails)) data.emails = [];
  if (!Array.isArray(data.recusas)) data.recusas = [];
  if (!Array.isArray(data.feed)) data.feed = [];
  if (!Array.isArray(data.prefs.templates)) data.prefs.templates = [];
  if (!Array.isArray(data.prefs.regrasAgente)) data.prefs.regrasAgente = [];
  if (!Array.isArray(data.prefs.recruiters)) data.prefs.recruiters = [];
  delete data.prefs.porDia;

  function canonicalDay(raw) {
    const text = String(raw || "").trim();
    const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    return "";
  }
  function importHistory(rows = []) {
    let n = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const url = String(row.url || "").slice(0, 500);
      const empresa = String(row.empresa || "").slice(0, 120);
      const titulo = String(row.titulo || "").slice(0, 200);
      const status = String(row.status || "enviada");
      const day = canonicalDay(row.data);
      const at = day ? `${day}T12:00:00.000Z` : iso();
      if (log.some((item) => (url && item.url === url) || (empresa && titulo && item.empresa === empresa && item.titulo === titulo && String(item.at).slice(0, 10) === String(at).slice(0, 10)))) continue;
      log.push({
        id: newId("cand"),
        vagaId: "",
        plataforma: String(row.plataforma || "").slice(0, 80),
        titulo,
        empresa,
        url,
        status: ["enviada", "descartada", "recusada", "nova", "teste", "critica", "falhou"].includes(status) ? status : "enviada",
        nota: String(row.motivo || "").slice(0, 300),
        at,
        importado: true,
        fonte: String(row.fonte || "importado").slice(0, 40),
      });
      n += 1;
    }
    if (log.length > 4000) log = log.slice(-4000);
    saveLog();
    return { importados: n, total: log.length };
  }

  function importRecruiters(rows = []) {
    const cur = Array.isArray(data.prefs.recruiters) ? data.prefs.recruiters : [];
    const keyOf = (r) => String(r.profile_url || r.name || "").toLowerCase().trim();
    const seen = new Set(cur.map(keyOf).filter(Boolean));
    let n = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const k = keyOf(row);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      cur.push({
        name: String(row.name || "").slice(0, 80),
        company: String(row.company || "").slice(0, 80),
        role: String(row.role || "").slice(0, 120),
        profile_url: String(row.profile_url || "").slice(0, 300),
        date_invited: String(row.date_invited || "").slice(0, 20),
        date_messaged: String(row.date_messaged || "").slice(0, 20),
      });
      n += 1;
    }
    data.prefs.recruiters = cur.slice(-2000);
    save();
    return { importados: n, total: data.prefs.recruiters.length };
  }

  function setTemplates(list = []) {
    data.prefs.templates = (Array.isArray(list) ? list : []).slice(0, 40).map((t) => ({
      id: t.id || newId("tpl"),
      titulo: String(t.titulo || "").slice(0, 120),
      corpo: String(t.corpo || "").slice(0, 4000),
    }));
    save();
    return data.prefs.templates;
  }

  function setAgentRules(list = []) {
    data.prefs.regrasAgente = (Array.isArray(list) ? list : []).map((r) => String(r).slice(0, 400)).filter(Boolean).slice(0, 80);
    save();
    return data.prefs.regrasAgente;
  }

  const recruiters = () => [...(data.prefs.recruiters || [])];
  const templates = () => [...(data.prefs.templates || [])];
  const agentRules = () => [...(data.prefs.regrasAgente || [])];

  const matchVaga = (empresa, texto = "") => {
    const c = normCompany(empresa);
    const t = normCompany(texto);
    return data.vagas.find((v) => ["enviada", "aprovada", "teste"].includes(v.status) && normCompany(v.company)
      && ((c && (c.includes(normCompany(v.company)) || normCompany(v.company).includes(c))) || t.includes(normCompany(v.company))));
  };
  /**
   * Recebe e-mails já resumidos pelo processo principal (remetente, assunto, trecho). E-mail de código é jogado fora.
   * Recusa tira a vaga da lista ativa e guarda o motivo. Teste vira pendência.
   */
  function ingestEmails(list = [], at = now()) {
    const out = { recusas: 0, testes: 0, entrevistas: 0, inscricoes: 0, ignorados: 0 };
    for (const raw of Array.isArray(list) ? list.slice(0, 100) : []) {
      const e = { id: String(raw.id || "").slice(0, 80), conta: String(raw.conta || "").slice(0, 60), from: String(raw.from || "").slice(0, 160), subject: String(raw.subject || "").slice(0, 200), snippet: String(raw.snippet || "").slice(0, 600), at: raw.at ? new Date(Number(raw.at) || raw.at).toISOString() : new Date(at).toISOString() };
      if (!e.id || data.emails.some((x) => x.id === e.id)) continue;
      const tipo = mail.classify(e);
      if (tipo === "codigo") { out.ignorados += 1; continue; }
      e.tipo = tipo;
      e.snippet = e.snippet.replace(/\b\d{4,8}\b/g, "[número]");
      const empresa = mail.companyFrom(e.from, e.subject);
      const vaga = matchVaga(empresa, `${e.subject} ${e.snippet}`);
      e.vagaId = vaga ? vaga.id : "";
      if (tipo === "recusa") {
        const motivo = mail.rejectionReason(`${e.subject}. ${raw.body || e.snippet}`);
        data.recusas.push({ id: newId("rec"), empresa: vaga ? vaga.company : empresa, titulo: vaga ? vaga.title : e.subject, motivo, at: e.at, emailId: e.id });
        if (vaga) { vaga.status = "recusada"; vaga.motivoRecusa = motivo; record(vaga, "recusada", motivo); }
        out.recusas += 1;
      } else if (tipo === "teste") {
        if (vaga) { vaga.status = "teste"; record(vaga, "teste", e.subject); }
        e.pendente = true;
        out.testes += 1;
      } else if (tipo === "entrevista") out.entrevistas += 1;
      else if (tipo === "inscricao") out.inscricoes += 1;
      data.emails.push(e);
    }
    if (data.emails.length > 500) data.emails = data.emails.slice(-500);
    if (data.recusas.length > 500) data.recusas = data.recusas.slice(-500);
    save();
    return out;
  }
  /** Recusa registrada à mão (pelo chat). */
  function markRejected(ref, motivo = "") {
    const v = get(ref) || data.vagas.find((x) => normCompany(x.company) && normCompany(x.company) === normCompany(ref));
    const reason = String(motivo || "").slice(0, 200);
    data.recusas.push({ id: newId("rec"), empresa: v ? v.company : String(ref).slice(0, 60), titulo: v ? v.title : "", motivo: reason, at: iso() });
    if (v) { v.status = "recusada"; v.motivoRecusa = reason; record(v, "recusada", reason); }
    save();
    return v;
  }
  function finishTest(emailId) {
    const e = data.emails.find((x) => x.id === emailId);
    if (e) { e.pendente = false; save(); }
    return Boolean(e);
  }
  const pendingTests = () => data.emails.filter((e) => e.tipo === "teste" && e.pendente);
  const rejections = () => [...data.recusas].reverse();
  const rejectionPatterns = () => mail.patterns(data.recusas.map((r) => r.motivo).filter(Boolean));

  /** Posts do feed do LinkedIn que parecem vaga (só leitura). Sem duplicar. */
  function ingestFeed(posts = [], at = now()) {
    let novos = 0;
    let vagasNovas = 0;
    for (const p of Array.isArray(posts) ? posts.slice(0, 30) : []) {
      const texto = String(p.texto || "").replace(/\s+/g, " ").trim().slice(0, 800);
      const key = String(p.id || texto.slice(0, 80));
      if (!texto || data.feed.some((x) => x.key === key)) continue;
      const url = /^https:\/\//.test(String(p.url || "")) ? String(p.url) : "";
      const jobUrl = url.match(/https:\/\/[^\s"']*linkedin\.com\/jobs\/view\/[^\s"']+/i)?.[0] || texto.match(/https:\/\/[^\s"']*linkedin\.com\/jobs\/view\/[^\s"']+/i)?.[0] || "";
      if (!/(vaga|contratando|hiring|oportunidade|estamos buscando|procuramos|#vagas|job opening)/i.test(`${texto} ${url}`) && !jobUrl) continue;
      const { score, motivos } = scoreJob({ title: texto.slice(0, 120), company: String(p.autor || ""), location: "", description: texto }, { profileText: String(readProfile() || ""), prefs: data.prefs });
      data.feed.push({ key, autor: String(p.autor || "").slice(0, 80), texto, url, score, motivos, at: new Date(at).toISOString(), fonte: "feed" });
      novos += 1;
      const jobId = jobUrl.match(/\/jobs\/view\/(\d+)/i)?.[1];
      if (jobId) vagasNovas += ingestParsedJobs([{
        extId: jobId,
        title: texto.slice(0, 160),
        company: String(p.autor || ""),
        url: jobUrl.replace(/[),.;]+$/, ""),
        description: texto,
      }], { platform: "linkedin", at }).novas;
    }
    if (data.feed.length > 300) data.feed = data.feed.slice(-300);
    save();
    return { novos, vagasNovas, total: data.feed.length };
  }

  /**
   * LEVA O3: ingere vagas já parseadas (HTML fixture / DOM da sessão HELIOS).
   * Sem rede. Respeita dedupe por platform+extId e nota mínima.
   */
  function ingestParsedJobs(list = [], { platform = "linkedin", at = now() } = {}) {
    const p = data.prefs;
    const profileText = String(readProfile() || "");
    let novas = 0;
    const aceitas = [];
    for (const job of (Array.isArray(list) ? list : []).slice(0, 40)) {
      const extId = String(job.extId || "").slice(0, 80);
      if (!extId) continue;
      if (data.vagas.some((v) => v.platform === platform && v.extId === extId)) continue;
      const stored = {
        title: String(job.title || "").slice(0, 200),
        company: String(job.company || "").slice(0, 120),
        location: String(job.location || "").slice(0, 120),
        description: String(job.description || "").slice(0, 1500),
      };
      const gated = gateJob(stored, { profileText, prefs: p });
      const row = {
        id: newId("vaga"),
        platform,
        extId,
        ...stored,
        url: String(job.url || "").slice(0, 500),
        postedAt: job.postedAt || null,
        score: gated.score,
        motivos: gated.motivos,
        status: gated.status,
        auto: gated.status !== "nova",
        foundAt: new Date(at).toISOString(),
        fonte: "sessao-helios",
      };
      data.vagas.push(row);
      if (row.status === "nova") { novas += 1; aceitas.push(row); }
    }
    if (data.vagas.length > 800) data.vagas = data.vagas.slice(-800);
    save();
    return { novas, total: data.vagas.filter((v) => v.status === "nova").length, aceitas };
  }

  /** Ingestão de uma busca feita pelo navegador do HELIOS; não faz rede nem usa API externa. */
  function ingestBrowserSearch({ platform = "linkedin", html = "", items = [], term = "", at = now() } = {}) {
    const spec = platforms[platform];
    let parsed = [];
    try { parsed = spec && typeof spec.parse === "function" ? spec.parse(String(html || "")) : []; } catch { parsed = []; }
    const manual = (Array.isArray(items) ? items : []).map((item, index) => ({
      extId: String(item.extId || item.id || item.url || `browser-${index}`),
      title: String(item.title || ""),
      company: String(item.company || ""),
      location: String(item.location || ""),
      url: String(item.url || ""),
      description: String(item.description || item.text || "").slice(0, 1500),
      postedAt: item.postedAt || null,
    })).map((item) => ({ ...item, url: canonicalJobUrl(item.url) || item.url })).filter((item) => item.url && item.title && !/pagead\/clk/i.test(item.url));
    // A busca já foi executada na página. Não exigir igualdade literal aqui:
    // "front-end", "front end" e variações locais não podem virar falso zero.
    const all = [...parsed, ...manual];
    const unique = [...new Map(all.map((job) => [String(job.extId || job.url), job])).values()];
    const result = ingestParsedJobs(unique, { platform, at });
    return { ...result, lidos: unique.length, fonte: "navegador", termo: String(term || "").slice(0, 120) };
  }

  /** LEVA M: posts salvos do LinkedIn (/my-items/saved-posts/) — só leitura, mesma fila do feed, com dedupe. */
  function ingestSavedPosts(posts = [], at = now()) {
    let novos = 0;
    let vagasNovas = 0;
    for (const p of Array.isArray(posts) ? posts.slice(0, 50) : []) {
      const texto = String(p.texto || "").replace(/\s+/g, " ").trim().slice(0, 800);
      const url = /^https:\/\//.test(String(p.url || "")) ? String(p.url) : "";
      const key = String(p.id || url || `saved:${texto.slice(0, 80)}`);
      if (!texto && !url) continue;
      if (data.feed.some((x) => x.key === key || (url && x.url === url))) continue;
      const hay = `${texto} ${url}`;
      if (!/(vaga|contratando|hiring|oportunidade|estamos buscando|procuramos|#vagas|job opening|desenvolvedor|developer)/i.test(hay)) continue;
      const { score, motivos } = scoreJob({ title: (texto || url).slice(0, 120), company: String(p.autor || ""), location: "", description: texto }, { profileText: String(readProfile() || ""), prefs: data.prefs });
      data.feed.push({ key, autor: String(p.autor || "").slice(0, 80), texto: texto || url, url, score, motivos, at: new Date(at).toISOString(), fonte: "saved" });
      novos += 1;
      const jobUrl = url.match(/https:\/\/[^\s"']*linkedin\.com\/jobs\/view\/[^\s"']+/i)?.[0] || texto.match(/https:\/\/[^\s"']*linkedin\.com\/jobs\/view\/[^\s"']+/i)?.[0] || "";
      const jobId = jobUrl.match(/\/jobs\/view\/(\d+)/i)?.[1];
      if (jobId) vagasNovas += ingestParsedJobs([{
        extId: jobId,
        title: texto.slice(0, 160),
        company: String(p.autor || ""),
        url: jobUrl.replace(/[),.;]+$/, ""),
        description: texto,
      }], { platform: "linkedin", at }).novas;
    }
    if (data.feed.length > 300) data.feed = data.feed.slice(-300);
    save();
    return { novos, vagasNovas, total: data.feed.length };
  }

  const feed = (limit = 30) => [...data.feed].sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at))).slice(0, limit);

  /** Resumo completo do dia: inscrições, testes, recusas, e-mails importantes e o que estudar. */
  function digest(at = now()) {
    const day = new Date(at).toISOString().slice(0, 10);
    const today = log.filter((item) => String(item.at).slice(0, 10) === day);
    const sent = today.filter((x) => x.status === "enviada_auto" || x.status === "enviada");
    const recToday = data.recusas.filter((r) => String(r.at).slice(0, 10) === day);
    const important = data.emails.filter((e) => String(e.at).slice(0, 10) === day && ["entrevista", "teste", "vaga"].includes(e.tipo));
    const lines = [`Vagas · ${day.split("-").reverse().join("/")}`, `Inscrições hoje: ${sent.length}`];
    for (const item of sent.slice(0, 10)) lines.push(`• ${item.titulo} — ${item.empresa}`);
    const tests = pendingTests();
    lines.push(`Testes esperando: ${tests.length}`);
    for (const e of tests.slice(0, 5)) lines.push(`• ${e.subject}`);
    lines.push(`Recusas hoje: ${recToday.length}`);
    for (const r of recToday.slice(0, 8)) lines.push(`• ${r.empresa}${r.motivo ? ` — ${r.motivo}` : ""}`);
    const tecnicas = data.vagas.filter((vaga) => vaga.status === "falhou").length;
    if (tecnicas) lines.push(`Falhas técnicas (não precisam de resposta): ${tecnicas}`);
    if (criticals().length) lines.push(`Esperando sua resposta: ${criticals().length}`);
    if (important.length) {
      lines.push("E-mails importantes:");
      for (const e of important.slice(0, 8)) lines.push(`• ${e.subject}`);
    }
    const pat = rejectionPatterns();
    if (pat.top.length) lines.push("O que mais pedem:", ...pat.sugestoes.slice(0, 3).map((s) => `• ${s}`));
    return lines.join("\n");
  }

  const pending = () => data.vagas.filter((v) => v.status === "aguardando_aprovacao").length;
  const history = (limit = 50) => log.slice(-limit).reverse();
  const platformList = () => Object.values(platforms).map(({ id, label, domains, loginUrl }) => ({ id, label, domains, loginUrl }));

  return {
    ingestEmails, markRejected, finishTest, pendingTests, rejections, rejectionPatterns, ingestFeed, ingestSavedPosts, ingestParsedJobs, ingestBrowserSearch, feed, digest,
    autoQueue, autoQueueDiagnostics, autoStart, autoResult, criticals, revisarFila, answerCritical, skipCritical, dailySummary, rateLeft, recentlyApplied,
    importHistory, importRecruiters, setTemplates, setAgentRules, recruiters, templates, agentRules,
    prefs, setPrefs, setTriagem, search, list, get, discard, prepare, approve, deny, markResult, pending, history, counts, platforms: platformList, file, logFile,
  };
}

module.exports = {
  normCompany, createJobs, PLATFORMS, DEFAULT_PREFS, STATUS, parseLinkedin, parseGupy, scoreJob, gateJob, draftLetter, splitList };
