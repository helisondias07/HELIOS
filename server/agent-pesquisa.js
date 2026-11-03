"use strict";

/**
 * LEVA O4: agente Pesquisa — lê vagas coletadas, conta skills por nível
 * (júnior/pleno) com % só dos dados reais, compara com perfil.skills
 * (fonte única, evidência por skill) e vagas-helison (somente leitura),
 * gera lacunas e posta pedido ao Portfólio no quadro semanalmente.
 * Nunca inventa números: amostra pequena → indicar n.
 */
const fs = require("node:fs");
const path = require("node:path");
const { nowIso, readJson, writeJson, redact } = require("./util");

const AMOSTRA_MINIMA = 5;
const TOP_LACUNAS = 5;
const JANELA_INI = 8;
const JANELA_FIM = 20;
const PESQUISA_SEMANAL_MARK = "[pesquisa-semanal]";
const PESQUISA_SEMANAL_TITLE = "Pesquisa semanal de lacunas";

/** Catálogo fixo (aliases → id canônico). Só conta o que aparece no texto. */
const SKILL_CATALOG = Object.freeze([
  { id: "react", nome: "React", aliases: ["react.js", "reactjs", "react"] },
  { id: "nextjs", nome: "Next.js", aliases: ["next.js", "nextjs"] },
  { id: "typescript", nome: "TypeScript", aliases: ["typescript", "ts"] },
  { id: "javascript", nome: "JavaScript", aliases: ["javascript", "js", "ecmascript"] },
  { id: "nodejs", nome: "Node.js", aliases: ["node.js", "nodejs", "node"] },
  { id: "html", nome: "HTML", aliases: ["html5", "html"] },
  { id: "css", nome: "CSS", aliases: ["css3", "css", "tailwind", "sass", "scss"] },
  { id: "docker", nome: "Docker", aliases: ["docker", "containers"] },
  { id: "kubernetes", nome: "Kubernetes", aliases: ["kubernetes", "k8s"] },
  { id: "aws", nome: "AWS", aliases: ["amazon web services", "aws"] },
  { id: "sql", nome: "SQL", aliases: ["postgresql", "postgres", "mysql", "sql"] },
  { id: "graphql", nome: "GraphQL", aliases: ["graphql"] },
  { id: "python", nome: "Python", aliases: ["python"] },
  { id: "n8n", nome: "n8n", aliases: ["n8n"] },
  { id: "figma", nome: "Figma", aliases: ["figma"] },
  { id: "git", nome: "Git", aliases: ["git", "github", "gitlab"] },
  { id: "testing", nome: "Testes", aliases: ["jest", "cypress", "playwright", "testing library", "vitest"] },
  { id: "ci", nome: "CI/CD", aliases: ["ci/cd", "github actions", "gitlab ci"] },
]);

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function weekKey(at = Date.now()) {
  const d = new Date(at);
  // ISO week: Thursday-based
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400e3) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function norm(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Detecta nível a partir do título/descrição. Sem chute: sem sinal → "outro". */
function detectNivel(job = {}) {
  const blob = norm(`${job.title || ""} ${job.description || ""} ${job.senioridade || ""}`);
  const junior = /j[uú]?nior|\bjr\b|junior|entry.?level|estagi[aá]rio|trainee/.test(blob);
  const pleno = /\bpleno\b|\bmid[ -]?level\b|\bmiddle\b/.test(blob);
  const senior = /s[eê]nior|\bsr\b|senior|staff|principal/.test(blob);
  if (junior && !pleno && !senior) return "junior";
  if (pleno && !junior && !senior) return "pleno";
  if (junior && pleno) return "outro"; // ambíguo
  return "outro";
}

/** Extrai skills do catálogo presentes no texto (dados reais, sem inventar). */
function extractSkills(text) {
  const blob = norm(text);
  if (!blob.trim()) return [];
  const found = [];
  for (const skill of SKILL_CATALOG) {
    const hit = skill.aliases.some((alias) => {
      const a = norm(alias);
      if (a.length <= 2) return new RegExp(`(?:^|[^a-z0-9])${escapeRe(a)}(?:[^a-z0-9]|$)`).test(blob);
      return blob.includes(a);
    });
    if (hit) found.push({ id: skill.id, nome: skill.nome });
  }
  return found;
}

function pct(parte, total) {
  if (!total || total <= 0) return null; // nunca inventa 0% falso quando não há amostra
  return Math.round((parte / total) * 1000) / 10; // 1 casa
}

function agregarSkills(vagas = []) {
  const lista = Array.isArray(vagas) ? vagas : [];
  const n = lista.length;
  const porNivel = { junior: 0, pleno: 0, outro: 0 };
  const counts = new Map(); // id -> { nome, n, junior, pleno, outro }

  for (const job of lista) {
    const nivel = detectNivel(job);
    porNivel[nivel] = (porNivel[nivel] || 0) + 1;
    const skills = extractSkills(`${job.title || ""} ${job.description || ""} ${job.company || ""}`);
    const seen = new Set();
    for (const s of skills) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const row = counts.get(s.id) || { id: s.id, nome: s.nome, n: 0, junior: 0, pleno: 0, outro: 0 };
      row.n += 1;
      row[nivel] += 1;
      counts.set(s.id, row);
    }
  }

  const amostraPequena = n > 0 && n < AMOSTRA_MINIMA;
  const skills = [...counts.values()]
    .map((row) => ({
      id: row.id,
      nome: row.nome,
      n: row.n,
      nJunior: row.junior,
      nPleno: row.pleno,
      nOutro: row.outro,
      pctGeral: pct(row.n, n),
      pctJunior: pct(row.junior, porNivel.junior),
      pctPleno: pct(row.pleno, porNivel.pleno),
      amostraPequena: amostraPequena || (porNivel.junior > 0 && porNivel.junior < AMOSTRA_MINIMA) || (porNivel.pleno > 0 && porNivel.pleno < AMOSTRA_MINIMA),
    }))
    .sort((a, b) => b.n - a.n || a.nome.localeCompare(b.nome));

  return {
    n,
    porNivel: { ...porNivel },
    amostraPequena,
    aviso: amostraPequena ? `Amostra pequena (n=${n}). Percentuais indicativos; não inventados.` : (n === 0 ? "Nenhuma vaga coletada." : null),
    skills,
  };
}

/**
 * Fonte única: perfil.skills[{ id, nome, evidencia }].
 * Se skills vazio, deriva declaração da stack/anos (evidência vazia — lacuna de evidência).
 * Nunca inventa link de evidência.
 */
function lerPerfilSkills(perfil = {}) {
  const out = [];
  const seen = new Set();
  const push = (id, nome, evidencia, origem) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      nome: nome || id,
      evidencia: String(evidencia || "").trim().slice(0, 500),
      origem,
    });
  };

  const listed = Array.isArray(perfil.skills) ? perfil.skills : [];
  for (const item of listed) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || item.nome || item.name || "").trim().toLowerCase().slice(0, 40);
    if (!id) continue;
    const cat = SKILL_CATALOG.find((s) => s.id === id || s.aliases.includes(norm(item.nome || item.name || "")));
    push(cat?.id || id, cat?.nome || String(item.nome || item.name || id), item.evidencia || item.evidence || "", "perfil.skills");
  }

  if (!out.length) {
    const stackText = [
      perfil.stack || "",
      ...Object.keys(perfil.anosTecnologia || {}),
    ].join(" ");
    for (const s of extractSkills(stackText)) {
      push(s.id, s.nome, "", "stack"); // declarado sem evidência
    }
  }

  return out;
}

/** vagas-helison somente leitura: lê perfil.md e extrai skills declaradas (sem CPF). */
function lerVagasHelisonSomenteLeitura(root) {
  if (!root) return { ok: false, motivo: "caminho_ausente", skills: [], stack: "" };
  const perfilPath = path.join(root, "perfil.md");
  try {
    if (!fs.existsSync(perfilPath)) return { ok: false, motivo: "perfil_ausente", skills: [], stack: "" };
    const md = fs.readFileSync(perfilPath, "utf8");
    // Nunca devolver CPF / dados sensíveis — só stack/skills.
    const stackMatch = md.match(/##\s*Stack\s*\r?\n+([^\r\n#]+)/i);
    const stack = stackMatch ? stackMatch[1].trim() : "";
    const anosBlock = (md.match(/##\s*Anos por tecnologia[\s\S]*?(?=\n##\s|\n$)/i) || [])[0] || "";
    const skills = extractSkills(`${stack}\n${anosBlock}`);
    return {
      ok: true,
      somenteLeitura: true,
      stack: stack.slice(0, 300),
      skills: skills.map((s) => ({ ...s, evidencia: "", origem: "vagas-helison" })),
      path: perfilPath,
    };
  } catch (e) {
    return { ok: false, motivo: redact(e.message || String(e)).slice(0, 120), skills: [], stack: "" };
  }
}

/**
 * Lacunas = pedidas nas vagas (top por n) e (ausentes no perfil OU sem evidência).
 * Compara também com vagas-helison (leitura) para reforço; fonte oficial continua perfil.skills.
 */
function gerarLacunas(agregado, perfilSkills, { helisonSkills = [], top = TOP_LACUNAS } = {}) {
  const noPerfil = new Map(perfilSkills.map((s) => [s.id, s]));
  const noHelison = new Set(helisonSkills.map((s) => s.id));
  const lacunas = [];

  for (const row of agregado.skills || []) {
    const mine = noPerfil.get(row.id);
    const ausente = !mine;
    const semEvidencia = Boolean(mine && !mine.evidencia);
    const soNoHelison = !mine && noHelison.has(row.id);
    if (!ausente && !semEvidencia) continue;
    lacunas.push({
      id: row.id,
      nome: row.nome,
      n: row.n,
      pctGeral: row.pctGeral,
      pctJunior: row.pctJunior,
      pctPleno: row.pctPleno,
      nJunior: row.nJunior,
      nPleno: row.nPleno,
      motivo: ausente ? (soNoHelison ? "ausente_no_perfil_skills_mas_em_vagas_helison" : "ausente_no_perfil") : "sem_evidencia",
      amostraPequena: row.amostraPequena || agregado.amostraPequena,
    });
  }

  lacunas.sort((a, b) => b.n - a.n || a.nome.localeCompare(b.nome));
  return lacunas.slice(0, Math.max(1, top));
}

function formatPct(value, nBase) {
  if (value == null) return `sem dados (n=${nBase || 0})`;
  return `${value}%`;
}

function corpoLacuna(lacuna, agregado) {
  // LEVA O9: texto curto para o quadro (sem notas internas de prompt).
  const linhas = [
    `${lacuna.nome}: ${formatPct(lacuna.pctGeral, agregado.n)} (n=${lacuna.n} de ${agregado.n}).`,
    `Motivo: ${lacuna.motivo}.`,
  ];
  if (lacuna.amostraPequena || agregado.amostraPequena) {
    linhas.push(`Amostra pequena (n=${agregado.n}).`);
  }
  linhas.push("Pedido ao Portfólio: 1 projeto com evidência.");
  return linhas.join("\n");
}

function randInt(min, max, rng) {
  const r = typeof rng === "function" ? rng() : Math.random();
  return min + Math.floor(r * (max - min + 1));
}

/** Um slot semanal (weekday 0–6 + HH:MM na janela). */
function planejarSemana(week, { rng = Math.random, weekday = null } = {}) {
  const wd = weekday == null ? randInt(1, 5, rng) : Math.max(0, Math.min(6, Number(weekday))); // seg–sex padrão
  const totalMin = (JANELA_FIM - JANELA_INI) * 60;
  const m = randInt(0, totalMin - 1, rng);
  const hh = String(JANELA_INI + Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return {
    id: `${week}-pesquisa-${wd}-${hh}${mm}`,
    week,
    weekday: wd,
    clock: `${hh}:${mm}`,
    feito: false,
    feitoEm: null,
  };
}

function clockDue(clock, at) {
  if (!/^\d{2}:\d{2}$/.test(String(clock || ""))) return false;
  const d = new Date(at);
  const [hh, mm] = clock.split(":").map(Number);
  return (d.getHours() * 60 + d.getMinutes()) >= (hh * 60 + mm);
}

function weekdayDue(weekday, at) {
  return new Date(at).getDay() === Number(weekday);
}

function normalizeSkillList(list = []) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rawNome = String(item.nome || item.name || item.id || "").trim().slice(0, 80);
    if (!rawNome) continue;
    const cat = SKILL_CATALOG.find((s) => s.id === norm(item.id || "") || s.aliases.includes(norm(rawNome)) || s.id === norm(rawNome));
    const id = cat?.id || norm(item.id || rawNome).replace(/\s+/g, "-").slice(0, 40);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      nome: cat?.nome || rawNome,
      evidencia: String(item.evidencia || item.evidence || "").trim().slice(0, 500),
    });
  }
  return out.slice(0, 80);
}

function createAgentPesquisa(dataDir, {
  jobs,
  quadro,
  now = () => Date.now(),
  rng = Math.random,
  vagasHelisonRoot = null,
  routines = null,
} = {}) {
  if (!jobs) throw new Error("agent-pesquisa precisa de jobs");
  if (!quadro) throw new Error("agent-pesquisa precisa do quadro");

  const file = path.join(dataDir, "agente-pesquisa.json");
  const saved = readJson(file, {});
  let state = {
    version: 1,
    pausado: saved.pausado !== false,
    week: saved.week || null,
    horario: saved.horario && typeof saved.horario === "object" ? saved.horario : null,
    ultimoCicloEm: saved.ultimoCicloEm || null,
    ultimoResumo: saved.ultimoResumo || "",
    ultimaAgregacao: saved.ultimaAgregacao || null,
    ultimasLacunas: Array.isArray(saved.ultimasLacunas) ? saved.ultimasLacunas : [],
    pedacosQuadro: Array.isArray(saved.pedacosQuadro) ? saved.pedacosQuadro.slice(-40) : [],
  };

  function persist() {
    writeJson(file, state);
  }

  function ensureWeek(at = now()) {
    const w = weekKey(at);
    if (state.week !== w || !state.horario) {
      state.week = w;
      state.horario = planejarSemana(w, { rng });
      persist();
    }
    return state.horario;
  }

  function status(at = now()) {
    ensureWeek(at);
    return {
      id: "pesquisa",
      pausado: state.pausado,
      week: state.week,
      horario: state.horario ? { ...state.horario } : null,
      ultimoCicloEm: state.ultimoCicloEm,
      ultimoResumo: state.ultimoResumo,
      ultimaAgregacao: state.ultimaAgregacao
        ? {
          n: state.ultimaAgregacao.n,
          amostraPequena: state.ultimaAgregacao.amostraPequena,
          aviso: state.ultimaAgregacao.aviso,
          porNivel: state.ultimaAgregacao.porNivel,
          skillsTop: (state.ultimaAgregacao.skills || []).slice(0, 8),
        }
        : null,
      ultimasLacunas: state.ultimasLacunas.slice(0, TOP_LACUNAS),
      amostraMinima: AMOSTRA_MINIMA,
      mark: PESQUISA_SEMANAL_MARK,
    };
  }

  function setPausado(pausado) {
    state.pausado = Boolean(pausado);
    persist();
    return status();
  }

  function due(at = now()) {
    if (state.pausado) return false;
    const slot = ensureWeek(at);
    if (slot.feito) return false;
    return weekdayDue(slot.weekday, at) && clockDue(slot.clock, at);
  }

  function perfilSkillsAtual() {
    const perfil = jobs.prefs().perfil || {};
    return lerPerfilSkills(perfil);
  }

  function setPerfilSkills(list) {
    const skills = normalizeSkillList(list);
    jobs.setPrefs({ perfil: { ...(jobs.prefs().perfil || {}), skills } });
    return lerPerfilSkills(jobs.prefs().perfil || {});
  }

  function analisar({ vagas = null, helisonRoot = vagasHelisonRoot } = {}) {
    const lista = Array.isArray(vagas) ? vagas : jobs.list();
    const agregado = agregarSkills(lista);
    const perfilSkills = perfilSkillsAtual();
    const helison = lerVagasHelisonSomenteLeitura(helisonRoot);
    const lacunas = gerarLacunas(agregado, perfilSkills, { helisonSkills: helison.skills || [] });
    return { agregado, perfilSkills, helison, lacunas };
  }

  function postarPedidos(lacunas, agregado) {
    const ids = [];
    const weekRef = `semana:${state.week}`;
    // LEVA O9: sem vagas lidas → não postar resultado vazio.
    if (agregado.n === 0) {
      return { ids, postado: false, motivo: "sem_vagas" };
    }
    for (const lacuna of lacunas) {
      const skillRef = `skill:${lacuna.id}:${state.week}`;
      const assunto = `Lacuna: ${lacuna.nome} (${formatPct(lacuna.pctGeral, agregado.n)})`.slice(0, 160);
      const item = quadro.postar({
        de: "pesquisa",
        para: "portfolio",
        tipo: "pedido",
        assunto: redact(assunto),
        corpo: redact(corpoLacuna(lacuna, agregado)).slice(0, 4000),
        ref: skillRef,
        idempotente: true,
      });
      ids.push(item.id);
      if (!state.pedacosQuadro.some((p) => p.id === item.id)) {
        state.pedacosQuadro.push({ id: item.id, skill: lacuna.id, week: state.week, em: nowIso() });
      }
    }
    if (lacunas.length) {
      quadro.postar({
        de: "pesquisa",
        para: "chefe",
        tipo: "resultado",
        assunto: "Lacunas da semana",
        corpo: redact(
          [
            `${lacunas.length} lacuna(s) em ${agregado.n} vaga(s).`,
            ...lacunas.map((l) => `• ${l.nome}: ${formatPct(l.pctGeral, agregado.n)}`),
          ].join("\n"),
        ).slice(0, 4000),
        ref: weekRef,
        idempotente: true,
      });
      // Espelho curto para o Helison (feed do Chefe).
      quadro.postar({
        de: "pesquisa",
        para: "helison",
        tipo: "resultado",
        assunto: "Lacunas da semana",
        corpo: redact(`${lacunas.length} lacuna(s) em ${agregado.n} vaga(s) lidas.`),
        ref: `${weekRef}:helison`,
        idempotente: true,
      });
    } else {
      quadro.postar({
        de: "pesquisa",
        para: "chefe",
        tipo: "resultado",
        assunto: "Sem lacunas novas",
        corpo: redact(`Nenhuma lacuna nova em ${agregado.n} vaga(s) lidas.`),
        ref: weekRef,
        idempotente: true,
      });
    }
    if (state.pedacosQuadro.length > 40) state.pedacosQuadro = state.pedacosQuadro.slice(-40);
    return { ids, postado: true, motivo: null };
  }

  async function ciclo({ forcar = false, at = now(), vagas = null } = {}) {
    if (state.pausado && !forcar) {
      return { ok: false, motivo: "pausado", lacunas: [] };
    }
    ensureWeek(at);
    if (!forcar && !due(at)) {
      return { ok: false, motivo: "nao_devido", lacunas: [], status: status(at) };
    }

    const { agregado, perfilSkills, helison, lacunas } = analisar({ vagas });
    const post = postarPedidos(lacunas, agregado);
    const quadroIds = post.ids || [];

    if (state.horario) {
      state.horario.feito = true;
      state.horario.feitoEm = nowIso();
    }
    state.ultimoCicloEm = nowIso();
    state.ultimaAgregacao = agregado;
    state.ultimasLacunas = lacunas;
    // LEVA O9: mensagem curta ao usuário; sem vagas → "Sem vagas lidas ainda".
    state.ultimoResumo = agregado.n === 0
      ? "Sem vagas lidas ainda"
      : `${lacunas.length} lacuna(s) em ${agregado.n} vaga(s).`;
    persist();

    return {
      ok: true,
      n: agregado.n,
      amostraPequena: agregado.amostraPequena,
      aviso: agregado.n === 0 ? "Sem vagas lidas ainda" : agregado.aviso,
      agregado,
      perfilSkills,
      helison: { ok: helison.ok, skills: helison.skills, motivo: helison.motivo || null },
      lacunas,
      quadroIds,
      postado: post.postado,
      status: status(at),
    };
  }

  /** Instala rotina semanal no sistema de rotinas (pausada por padrão). */
  function installRotina({ clock = null, weekdays = [1] } = {}) {
    if (!routines || typeof routines.add !== "function") {
      throw fail("Rotinas não disponíveis neste contexto.");
    }
    const slot = ensureWeek(now());
    const okClock = /^\d{2}:\d{2}$/.test(String(clock || "")) ? String(clock) : (slot.clock || "10:00");
    const existing = routines.list().find((r) => String(r.prompt || "").includes(PESQUISA_SEMANAL_MARK));
    if (existing) {
      return routines.update(existing.id, {
        enabled: existing.enabled,
        clock: okClock,
        weekdays: Array.isArray(weekdays) ? weekdays : [1],
        title: PESQUISA_SEMANAL_TITLE,
      });
    }
    return routines.add({
      title: PESQUISA_SEMANAL_TITLE,
      prompt: `${PESQUISA_SEMANAL_MARK} Agregar skills das vagas, comparar com perfil.skills e postar lacunas ao Portfólio.`,
      clock: okClock,
      weekdays: Array.isArray(weekdays) ? weekdays : [1],
      enabled: false,
      assistantId: "pesquisa",
    });
  }

  return {
    status,
    setPausado,
    due,
    ensureWeek,
    planejarSemana: (w, o) => planejarSemana(w || weekKey(now()), { rng, ...o }),
    analisar,
    ciclo,
    perfilSkillsAtual,
    setPerfilSkills,
    installRotina,
    AMOSTRA_MINIMA,
    PESQUISA_SEMANAL_MARK,
    SKILL_CATALOG,
  };
}

module.exports = {
  createAgentPesquisa,
  agregarSkills,
  extractSkills,
  detectNivel,
  lerPerfilSkills,
  lerVagasHelisonSomenteLeitura,
  gerarLacunas,
  planejarSemana,
  weekKey,
  normalizeSkillList,
  SKILL_CATALOG,
  AMOSTRA_MINIMA,
  PESQUISA_SEMANAL_MARK,
  PESQUISA_SEMANAL_TITLE,
  TOP_LACUNAS,
};
