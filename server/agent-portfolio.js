"use strict";

/**
 * LEVA O5: agente Portfólio — recebe lacuna do quadro, propõe 1 projeto pequeno,
 * cria repo LOCAL em reposRoot/portfolio-<slug> com README (+ espaço para mockup),
 * pede aprovação antes de GitHub/deploy Vercel (credenciais só do cofre/CLI do
 * usuário, nunca de outros apps). Ao concluir: posta resultado e atualiza
 * evidência em perfil.skills. Subagentes curtos: planejar / codificar / revisar.
 * Nunca inventa links de evidência nem tokens.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { nowIso, readJson, writeJson, redact, newId } = require("./util");

const PORTFOLIO_CICLO_MARK = "[portfolio-ciclo]";
const PORTFOLIO_CICLO_TITLE = "Portfólio: processar lacunas do quadro";
const DEFAULT_REPOS_ROOT = path.join("C:", "Users", "HelisonDias", "Repositorios");
const SUBAGENTES = Object.freeze(["planejar", "codificar", "revisar"]);

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function slugify(text) {
  const s = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "projeto";
}

/** Extrai skill id/nome do corpo/assunto/ref do pedido no quadro. */
function parseLacuna(item = {}) {
  const ref = String(item.ref || "");
  const skillFromRef = (ref.match(/^skill:(.+)$/i) || [])[1];
  const assunto = String(item.assunto || "");
  const corpo = String(item.corpo || "");
  const skillLine = (corpo.match(/Skill:\s*([^\r\n]+)/i) || [])[1];
  const nome = String(skillLine || (assunto.match(/Lacuna:\s*([^(]+)/i) || [])[1] || skillFromRef || "skill")
    .trim()
    .slice(0, 80);
  const id = slugify(skillFromRef || nome).slice(0, 40);
  const motivo = ((corpo.match(/Motivo:\s*([^\r\n]+)/i) || [])[1] || "").trim().slice(0, 120);
  return { id, nome: nome || id, motivo, quadroId: item.id || null };
}

function proporProjeto(lacuna) {
  const skill = lacuna.nome || lacuna.id || "skill";
  const slug = `portfolio-${slugify(lacuna.id || skill)}`;
  const titulo = `Demo ${skill}`;
  return {
    skillId: lacuna.id,
    skillNome: skill,
    slug,
    titulo,
    resumo: `Projeto pequeno para evidenciar ${skill} no portfólio (README + mockup).`,
    mockupHint: "Coloque um print em docs/mockup.png (ou use shots.so) e cite no README.",
    passos: [
      "planejar: escopo mínimo + README",
      "codificar: estrutura local + placeholder de mockup",
      "revisar: checar README e pasta docs/",
    ],
    quadroId: lacuna.quadroId || null,
    motivo: lacuna.motivo || "",
  };
}

function readmeContent(proposta) {
  return [
    `# ${proposta.titulo}`,
    "",
    `Projeto pequeno de portfólio para evidenciar **${proposta.skillNome}**.`,
    "",
    "## Objetivo",
    "",
    proposta.resumo,
    "",
    "## Mockup",
    "",
    `![Mockup](docs/mockup.png)`,
    "",
    `> ${proposta.mockupHint}`,
    "",
    "## Stack",
    "",
    `- Skill alvo: ${proposta.skillNome}`,
    "",
    "## Como rodar",
    "",
    "Escopo mínimo desta leva: README + espaço de mockup. Código de demo entra nas próximas iterações.",
    "",
    "## Evidência",
    "",
    "Link do repositório (local ou GitHub após aprovação) deve ir em `perfil.skills[].evidencia`.",
    "",
  ].join("\n");
}

function mockupPlaceholder() {
  return [
    "Espaço reservado para mockup do projeto.",
    "Substitua este arquivo por um PNG (ex.: export do shots.so).",
    "Não invente screenshots — use captura real da UI quando existir.",
    "",
  ].join("\n");
}

/** Cria repo LOCAL (git init se git existir). Nunca publica remoto. */
function criarRepoLocal(reposRoot, proposta, { runGit = true } = {}) {
  const root = path.resolve(reposRoot);
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, proposta.slug);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    // Reuso: atualiza README se já existir pasta do slug.
    const readmePath = path.join(dir, "README.md");
    if (!fs.existsSync(readmePath)) fs.writeFileSync(readmePath, readmeContent(proposta), "utf8");
    const docs = path.join(dir, "docs");
    fs.mkdirSync(docs, { recursive: true });
    const mock = path.join(docs, "mockup.txt");
    if (!fs.existsSync(mock) && !fs.existsSync(path.join(docs, "mockup.png"))) {
      fs.writeFileSync(mock, mockupPlaceholder(), "utf8");
    }
    return { path: dir, slug: proposta.slug, criado: false, reusado: true };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), readmeContent(proposta), "utf8");
  const docs = path.join(dir, "docs");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "mockup.txt"), mockupPlaceholder(), "utf8");
  fs.writeFileSync(
    path.join(dir, ".gitignore"),
    ["node_modules/", ".env", ".env.*", "dist/", "*.log", ""].join("\n"),
    "utf8",
  );

  let gitOk = false;
  if (runGit) {
    try {
      const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8", windowsHide: true });
      gitOk = init.status === 0;
      if (gitOk) {
        spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8", windowsHide: true });
        spawnSync(
          "git",
          ["-c", "user.email=helios-local@local", "-c", "user.name=HELIOS Portfólio", "commit", "-m", `chore: scaffold ${proposta.slug}`],
          { cwd: dir, encoding: "utf8", windowsHide: true },
        );
      }
    } catch {
      gitOk = false;
    }
  }
  return { path: dir, slug: proposta.slug, criado: true, reusado: false, gitOk };
}

/**
 * Publicação GitHub/Vercel — SÓ com aprovação explícita.
 * Usa getGithubToken/getVercelToken injetados (cofre/CLI do usuário).
 * Sem token → não inventa; retorna motivo. Em mock, só registra intenção.
 */
async function publicarRemoto(projeto, {
  aprovado,
  alvo = "github",
  getGithubToken = null,
  getVercelToken = null,
  mock = false,
  runGh = null,
  runVercel = null,
} = {}) {
  if (!aprovado) {
    return { ok: false, motivo: "sem_aprovacao", publicado: false };
  }
  const alvos = String(alvo || "github").toLowerCase().split(/[+,\s]+/).filter(Boolean);
  const out = { ok: true, github: null, vercel: null, urls: [] };

  if (alvos.includes("github")) {
    const token = typeof getGithubToken === "function" ? String(await getGithubToken() || "") : "";
    if (mock) {
      out.github = { ok: true, mock: true, url: `https://github.com/exemplo/${projeto.slug}` };
      out.urls.push(out.github.url);
    } else if (!token && typeof runGh !== "function") {
      out.github = { ok: false, motivo: "token_github_ausente" };
      out.ok = false;
    } else if (typeof runGh === "function") {
      const r = await runGh({ token, projeto });
      out.github = r;
      if (r?.url) out.urls.push(r.url);
      if (!r?.ok) out.ok = false;
    } else {
      // Sem runner real nesta leva: não chama rede; deixa pendente com token definido.
      out.github = { ok: false, motivo: "runner_github_nao_configurado", tokenDefinido: true };
      out.ok = false;
    }
  }

  if (alvos.includes("vercel")) {
    const token = typeof getVercelToken === "function" ? String(await getVercelToken() || "") : "";
    if (mock) {
      out.vercel = { ok: true, mock: true, url: `https://${projeto.slug}.vercel.app` };
      out.urls.push(out.vercel.url);
    } else if (typeof runVercel === "function") {
      // CLI pode deployar sem token colado (usuário já logado no vercel).
      const r = await runVercel({ token, projeto });
      out.vercel = r;
      if (r?.url) out.urls.push(r.url);
      if (!r?.ok) out.ok = false;
    } else if (!token) {
      out.vercel = { ok: false, motivo: "token_vercel_ausente" };
      out.ok = false;
    } else {
      out.vercel = { ok: false, motivo: "runner_vercel_nao_configurado", tokenDefinido: true };
      out.ok = false;
    }
  }

  // Nunca devolve tokens.
  return out;
}

function createAgentPortfolio(dataDir, {
  jobs,
  quadro,
  reposRoot = null,
  routines = null,
  getGithubToken = null,
  getVercelToken = null,
  hasGithubConnector = null,
  hasVercelConnector = null,
  vercelCliOk = null,
  mock = false,
  runGit = true,
  runGh = null,
  runVercel = null,
} = {}) {
  if (!jobs) throw new Error("agent-portfolio precisa de jobs");
  if (!quadro) throw new Error("agent-portfolio precisa do quadro");

  // Produção: C:\Users\...\Repositorios. Testes/mock: passar reposRoot explícito (nunca AppData HELIOS).
  const rootRepos = path.resolve(reposRoot || (mock ? path.join(dataDir, "portfolio-repos") : DEFAULT_REPOS_ROOT));

  const file = path.join(dataDir, "agente-portfolio.json");
  const saved = readJson(file, {});
  let state = {
    version: 1,
    pausado: saved.pausado !== false,
    ultimoCicloEm: saved.ultimoCicloEm || null,
    ultimoResumo: saved.ultimoResumo || "",
    projetos: Array.isArray(saved.projetos) ? saved.projetos.slice(-40) : [],
    pendenciasPublicacao: Array.isArray(saved.pendenciasPublicacao) ? saved.pendenciasPublicacao : [],
    processadosQuadro: Array.isArray(saved.processadosQuadro) ? saved.processadosQuadro.slice(-80) : [],
  };

  function persist() {
    writeJson(file, state);
  }

  function githubOk() {
    if (typeof hasGithubConnector === "function" && hasGithubConnector()) return true;
    if (typeof getGithubToken === "function") {
      try {
        const v = getGithubToken();
        // sync only; async token resolvido na publicação
        if (v && typeof v.then !== "function" && String(v).trim()) return true;
      } catch { /* */ }
    }
    return false;
  }
  function vercelOk() {
    if (typeof hasVercelConnector === "function" && hasVercelConnector()) return true;
    if (typeof vercelCliOk === "function" && vercelCliOk()) return true;
    if (typeof getVercelToken === "function") {
      try {
        const v = getVercelToken();
        if (v && typeof v.then !== "function" && String(v).trim()) return true;
      } catch { /* */ }
    }
    return false;
  }
  function conectoresOk() {
    return githubOk() || vercelOk();
  }

  function status() {
    const pend = state.pendenciasPublicacao.filter((p) => p.estado === "pendente");
    return {
      id: "portfolio",
      pausado: state.pausado,
      ultimoCicloEm: state.ultimoCicloEm,
      ultimoResumo: state.ultimoResumo,
      conectoresOk: conectoresOk(),
      githubOk: githubOk(),
      vercelOk: vercelOk(),
      projetos: state.projetos.slice(-10).map((p) => ({
        id: p.id,
        slug: p.slug,
        skillId: p.skillId,
        skillNome: p.skillNome,
        path: p.path,
        etapa: p.etapa,
        evidencia: p.evidencia || "",
        criadoEm: p.criadoEm,
      })),
      pendenciasPublicacao: pend.map((p) => ({
        id: p.id,
        projetoId: p.projetoId,
        slug: p.slug,
        alvo: p.alvo,
        criadoEm: p.criadoEm,
      })),
      reposRoot: rootRepos,
      mark: PORTFOLIO_CICLO_MARK,
      subagentes: [...SUBAGENTES],
    };
  }

  function setPausado(pausado) {
    state.pausado = Boolean(pausado);
    persist();
    return status();
  }

  function pedidosAbertos() {
    return quadro.ler({ para: "portfolio", tipo: "pedido", status: "aberto", limite: 20 });
  }

  function atualizarEvidencia(skillId, skillNome, evidenciaUrl) {
    const url = String(evidenciaUrl || "").trim().slice(0, 500);
    if (!url) throw fail("Evidência vazia: não inventar link.");
    const perfil = { ...(jobs.prefs().perfil || {}) };
    const skills = Array.isArray(perfil.skills) ? perfil.skills.map((s) => ({ ...s })) : [];
    const id = String(skillId || "").trim().toLowerCase().slice(0, 40);
    const nome = String(skillNome || id).trim().slice(0, 80);
    const idx = skills.findIndex((s) => String(s.id || "").toLowerCase() === id);
    if (idx >= 0) {
      skills[idx] = { ...skills[idx], id, nome: skills[idx].nome || nome, evidencia: url };
    } else {
      skills.push({ id, nome, evidencia: url });
    }
    jobs.setPrefs({ perfil: { ...perfil, skills } });
    return skills.find((s) => s.id === id);
  }

  function registrarSubagente(projeto, nome, detalhe) {
    if (!SUBAGENTES.includes(nome)) return;
    projeto.subagentes = Array.isArray(projeto.subagentes) ? projeto.subagentes : [];
    projeto.subagentes.push({ nome, detalhe: String(detalhe || "").slice(0, 200), em: nowIso() });
    projeto.etapa = nome;
  }

  function processarPedido(item) {
    const lacuna = parseLacuna(item);
    const proposta = proporProjeto(lacuna);
    const local = criarRepoLocal(rootRepos, proposta, { runGit });

    const projeto = {
      id: newId("pf"),
      skillId: proposta.skillId,
      skillNome: proposta.skillNome,
      slug: proposta.slug,
      titulo: proposta.titulo,
      path: local.path,
      quadroId: item.id,
      etapa: "planejar",
      subagentes: [],
      evidencia: `file://${local.path.replace(/\\/g, "/")}`,
      criadoEm: nowIso(),
      githubUrl: "",
      vercelUrl: "",
    };
    registrarSubagente(projeto, "planejar", proposta.resumo);
    registrarSubagente(projeto, "codificar", `README + docs/mockup em ${local.path}`);
    registrarSubagente(projeto, "revisar", fs.existsSync(path.join(local.path, "README.md")) ? "README ok" : "README ausente");

    // Evidência local imediata (caminho file:// — real, não inventado).
    atualizarEvidencia(projeto.skillId, projeto.skillNome, projeto.evidencia);

    // Pendência de publicação remota (GitHub/Vercel) — NÃO publica sozinho.
    const pend = {
      id: newId("pfpub"),
      projetoId: projeto.id,
      slug: projeto.slug,
      alvo: "github+vercel",
      estado: "pendente",
      criadoEm: nowIso(),
      path: local.path,
    };
    state.pendenciasPublicacao.push(pend);
    state.projetos.push(projeto);
    if (state.projetos.length > 40) state.projetos = state.projetos.slice(-40);
    if (state.pendenciasPublicacao.length > 40) {
      state.pendenciasPublicacao = state.pendenciasPublicacao.slice(-40);
    }

    try { quadro.atualizarStatus(item.id, "feito"); } catch { /* ok */ }

    quadro.postar({
      de: "portfolio",
      para: "chefe",
      tipo: "resultado",
      assunto: `Projeto local: ${projeto.slug}`.slice(0, 160),
      corpo: redact([
        `Skill: ${projeto.skillNome}`,
        `Repo local: ${projeto.path}`,
        `Evidência em perfil.skills: ${projeto.evidencia}`,
        `Publicar no GitHub/Vercel: aguardando aprovação (pendência ${pend.id}).`,
        `Subagentes: ${projeto.subagentes.map((s) => s.nome).join(" → ")}.`,
      ].join("\n")).slice(0, 4000),
      ref: item.id,
    });

    quadro.postar({
      de: "portfolio",
      para: "helison",
      tipo: "alerta",
      assunto: `Aprovar GitHub/Vercel: ${projeto.slug}`.slice(0, 160),
      corpo: redact([
        `Repo local criado em ${projeto.path}.`,
        "Nada foi publicado remoto.",
        `Para publicar: POST /api/agente/portfolio/publicar com { id: "${pend.id}", decision: "approve", alvo: "github" } (ou github+vercel).`,
        "Credenciais só do cofre/CLI do Helison — nunca de outros apps.",
      ].join("\n")).slice(0, 4000),
      ref: pend.id,
    });

    state.processadosQuadro.push({ quadroId: item.id, projetoId: projeto.id, em: nowIso() });
    if (state.processadosQuadro.length > 80) state.processadosQuadro = state.processadosQuadro.slice(-80);

    return { projeto, pendencia: pend, proposta, local };
  }

  async function ciclo({ forcar = false, limite = 3 } = {}) {
    if (state.pausado && !forcar) {
      return { ok: false, motivo: "pausado", processados: [] };
    }
    const abertos = pedidosAbertos().filter((p) => !state.processadosQuadro.some((x) => x.quadroId === p.id));
    const lote = abertos.slice(0, Math.max(1, Math.min(10, Number(limite) || 3)));
    if (!lote.length) {
      state.ultimoCicloEm = nowIso();
      state.ultimoResumo = "Sem pedidos abertos no quadro.";
      persist();
      return { ok: true, processados: [], status: status() };
    }

    const processados = [];
    for (const item of lote) {
      processados.push(processarPedido(item));
    }
    state.ultimoCicloEm = nowIso();
    state.ultimoResumo = `${processados.length} projeto(s) local(is); ${state.pendenciasPublicacao.filter((p) => p.estado === "pendente").length} publicação(ões) pendente(s).`;
    persist();
    return { ok: true, processados, status: status() };
  }

  /** Proposta sem gravar — útil para UI/teste. */
  function proporDePedido(item) {
    return proporProjeto(parseLacuna(item));
  }

  async function resolverPublicacao(pendenciaId, decision, { alvo } = {}) {
    const id = String(pendenciaId || "").trim();
    const pend = state.pendenciasPublicacao.find((p) => p.id === id && p.estado === "pendente");
    if (!pend) throw fail("Pendência de publicação não encontrada.", 404);
    const ok = decision === "approve" || decision === "aprovar";
    const deny = decision === "deny" || decision === "negar";
    if (!ok && !deny) throw fail("Decisão inválida. Use approve ou deny.");

    if (deny) {
      pend.estado = "negada";
      pend.decididoEm = nowIso();
      persist();
      quadro.postar({
        de: "portfolio",
        para: "chefe",
        tipo: "alerta",
        assunto: `Publicação negada: ${pend.slug}`,
        corpo: `Helison negou ${pend.id}. Repo local permanece em ${pend.path}. Evidência local intacta.`,
        ref: pend.id,
      });
      return { pendencia: { id: pend.id, estado: pend.estado }, publicado: false };
    }

    const projeto = state.projetos.find((p) => p.id === pend.projetoId);
    if (!projeto) throw fail("Projeto da pendência não encontrado.", 404);

    const alvoFinal = alvo || pend.alvo || "github";
    const pub = await publicarRemoto(projeto, {
      aprovado: true,
      alvo: alvoFinal,
      getGithubToken,
      getVercelToken,
      mock,
      runGh,
      runVercel,
    });

    pend.estado = pub.ok ? "aprovada_publicada" : "aprovada_falhou";
    pend.decididoEm = nowIso();
    pend.resultado = {
      ok: pub.ok,
      github: pub.github ? { ok: pub.github.ok, url: pub.github.url || null, motivo: pub.github.motivo || null, mock: Boolean(pub.github.mock) } : null,
      vercel: pub.vercel ? { ok: pub.vercel.ok, url: pub.vercel.url || null, motivo: pub.vercel.motivo || null, mock: Boolean(pub.vercel.mock) } : null,
      // nunca tokens
    };

    const evidenciaRemota = pub.urls[0] || "";
    if (evidenciaRemota) {
      projeto.evidencia = evidenciaRemota;
      if (pub.github?.url) projeto.githubUrl = pub.github.url;
      if (pub.vercel?.url) projeto.vercelUrl = pub.vercel.url;
      atualizarEvidencia(projeto.skillId, projeto.skillNome, evidenciaRemota);
    }

    persist();

    quadro.postar({
      de: "portfolio",
      para: "chefe",
      tipo: "resultado",
      assunto: pub.ok
        ? `Publicado: ${projeto.slug}`
        : `Publicação incompleta: ${projeto.slug}`,
      corpo: redact([
        `Pendência ${pend.id} aprovada.`,
        pub.ok ? `URLs: ${pub.urls.join(", ") || "(nenhuma)"}` : `Motivo: ${pub.github?.motivo || pub.vercel?.motivo || "falha"}`,
        `Evidência perfil.skills: ${projeto.evidencia}`,
        "Tokens nunca logados.",
      ].join("\n")).slice(0, 4000),
      ref: pend.id,
    });

    return { pendencia: { id: pend.id, estado: pend.estado }, publicado: pub.ok, urls: pub.urls, projeto: { id: projeto.id, evidencia: projeto.evidencia } };
  }

  function installRotina({ clock = "14:00", weekdays = [1, 3, 5] } = {}) {
    if (!routines || typeof routines.add !== "function") {
      throw fail("Rotinas não disponíveis neste contexto.");
    }
    const okClock = /^\d{2}:\d{2}$/.test(String(clock || "")) ? String(clock) : "14:00";
    const existing = routines.list().find((r) => String(r.prompt || "").includes(PORTFOLIO_CICLO_MARK));
    if (existing) {
      return routines.update(existing.id, {
        enabled: existing.enabled,
        clock: okClock,
        weekdays: Array.isArray(weekdays) ? weekdays : [1, 3, 5],
        title: PORTFOLIO_CICLO_TITLE,
      });
    }
    return routines.add({
      title: PORTFOLIO_CICLO_TITLE,
      prompt: `${PORTFOLIO_CICLO_MARK} Processar pedidos de lacuna no quadro: 1 projeto local + pedir aprovação GitHub/Vercel.`,
      clock: okClock,
      weekdays: Array.isArray(weekdays) ? weekdays : [1, 3, 5],
      enabled: false,
      assistantId: "portfolio",
    });
  }

  return {
    status,
    setPausado,
    ciclo,
    pedidosAbertos,
    proporDePedido,
    processarPedido,
    resolverPublicacao,
    atualizarEvidencia,
    installRotina,
    criarRepoLocal: (proposta, o) => criarRepoLocal(rootRepos, proposta, { runGit, ...o }),
    proporProjeto,
    parseLacuna,
    PORTFOLIO_CICLO_MARK,
    DEFAULT_REPOS_ROOT,
  };
}

module.exports = {
  createAgentPortfolio,
  proporProjeto,
  parseLacuna,
  slugify,
  criarRepoLocal,
  publicarRemoto,
  readmeContent,
  PORTFOLIO_CICLO_MARK,
  PORTFOLIO_CICLO_TITLE,
  DEFAULT_REPOS_ROOT,
  SUBAGENTES,
};
