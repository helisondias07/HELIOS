"use strict";

/**
 * LEVA O6: agente Oasis — lê tarefas atribuídas no ClickUp (token no cofre ou
 * conector), propõe plano (estilo oasis-bot: plan → aprovação → execução),
 * executa no repo da tarefa SÓ com aprovação, comenta/atualiza status no
 * ClickUp SÓ com aprovação. Isolado de itens de emprego no quadro.
 * Nunca loga tokens. vagas-helison / oasis-bot só leitura (não importados).
 */
const fs = require("node:fs");
const path = require("node:path");
const { nowIso, readJson, writeJson, redact, newId } = require("./util");
const { createClickUpHttpClient } = require("./clickup-http");
let createClickUpMcpClient;
try { createClickUpMcpClient = require("./clickup-mcp").createClickUpMcpClient; } catch { createClickUpMcpClient = null; }

const OASIS_CICLO_MARK = "[oasis-ciclo]";
const OASIS_CICLO_TITLE = "Oasis: ler ClickUp e propor planos";
const DEFAULT_REPOS_ROOT = path.join("C:", "Users", "HelisonDias", "Repositorios");
const EMPREGO_RE = /vaga|emprego|candidatura|linkedin|curriculo|cv\b|salar/i;
const SUBAGENTES = Object.freeze(["ler", "planejar", "executar", "atualizar"]);

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
  return s || "tarefa";
}

function isEmpregoTask(task) {
  const blob = `${task?.name || ""} ${task?.description || ""} ${task?.listName || ""}`;
  return EMPREGO_RE.test(blob);
}

/** Extrai caminho de repo da descrição/custom field (nunca inventa path remoto). */
function resolveRepoPath(task, reposRoot) {
  const root = path.resolve(reposRoot);
  const custom = task?.repoPath || task?.customRepo || "";
  if (custom && path.isAbsolute(String(custom))) return path.normalize(String(custom));
  const fromDesc = String(task?.description || "").match(/repo:\s*([^\r\n]+)/i);
  if (fromDesc) {
    const p = fromDesc[1].trim().replace(/^["']|["']$/g, "");
    if (path.isAbsolute(p)) return path.normalize(p);
    return path.resolve(root, p);
  }
  const slug = slugify(task?.name || task?.id || "tarefa");
  return path.join(root, slug);
}

/**
 * Plano no estilo oasis-bot (resumo + passos + riscos), sem editar arquivos.
 */
function proporPlano(task) {
  const nome = String(task?.name || "Tarefa").trim().slice(0, 160);
  const desc = String(task?.description || "").trim().slice(0, 800);
  const passos = [
    "Ler o contexto da tarefa e o repo local",
    "Implementar a mudança mínima no repo da tarefa",
    "Revisar diff local (sem push)",
    "Comentar e atualizar status no ClickUp (após aprovação)",
  ];
  return {
    taskId: String(task?.id || ""),
    titulo: nome,
    resumo: `Entregar: ${nome}`.slice(0, 200),
    passos,
    riscos: [
      "Escrita no ClickUp só após aprovação explícita",
      "Execução limitada ao repo da tarefa (sem push remoto nesta leva)",
    ],
    descricao: desc,
    listName: String(task?.listName || "").slice(0, 80),
    url: String(task?.url || "").slice(0, 300),
  };
}

function planoMarkdown(plano, task, repoPath) {
  return [
    `# Plano Oasis — ${plano.titulo}`,
    "",
    `ClickUp: ${plano.taskId || "(sem id)"}`,
    plano.url ? `Link: ${plano.url}` : "",
    `Repo: ${repoPath}`,
    "",
    "## Resumo",
    "",
    plano.resumo,
    "",
    "## Passos",
    "",
    ...plano.passos.map((p, i) => `${i + 1}. ${p}`),
    "",
    "## Riscos",
    "",
    ...plano.riscos.map((r) => `- ${r}`),
    "",
    "## Contexto",
    "",
    plano.descricao || "(sem descrição)",
    "",
    "_Gerado pelo agente Oasis do HELIOS. Execução e ClickUp só com aprovação._",
    "",
  ].filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n");
}

function createAgentOasis(dataDir, {
  quadro,
  routines = null,
  reposRoot = null,
  getClickUpToken = null,
  getClickUpAuthorization = null,
  refreshClickUpAuth = null,
  hasClickUpConnector = null,
  clickupClient = null,
  preferMcp = true,
  mock = false,
  now = () => Date.now(),
} = {}) {
  if (!quadro) throw new Error("agent-oasis precisa do quadro");

  const rootRepos = path.resolve(
    reposRoot || (mock ? path.join(dataDir, "oasis-repos") : DEFAULT_REPOS_ROOT),
  );

  const file = path.join(dataDir, "agente-oasis.json");
  const saved = readJson(file, {});
  let state = {
    version: 1,
    pausado: saved.pausado !== false,
    ultimoCicloEm: saved.ultimoCicloEm || null,
    ultimoResumo: saved.ultimoResumo || "",
    tarefas: Array.isArray(saved.tarefas) ? saved.tarefas.slice(-40) : [],
    pendencias: Array.isArray(saved.pendencias) ? saved.pendencias : [],
    processadosTaskIds: Array.isArray(saved.processadosTaskIds) ? saved.processadosTaskIds.slice(-80) : [],
    alertaConfigEm: saved.alertaConfigEm || null,
  };

  function persist() {
    writeJson(file, state);
  }

  function tokenPresente() {
    if (typeof getClickUpToken === "function" && String(getClickUpToken() || "").trim()) return true;
    return false;
  }

  function conectorPresente() {
    if (typeof hasClickUpConnector === "function") return Boolean(hasClickUpConnector());
    return false;
  }

  function clickupConfigurado() {
    if (clickupClient) return true;
    return tokenPresente() || conectorPresente();
  }

  function client() {
    if (clickupClient) return clickupClient;
    if (mock && !tokenPresente() && !conectorPresente()) {
      // Mock sem token/cliente: ciclo reporta falta de config (não inventa tarefas).
      return null;
    }
    // Leva P: prefere MCP remoto do ClickUp; cai na API v2 se faltar ferramenta.
    if (preferMcp && createClickUpMcpClient && (tokenPresente() || conectorPresente() || getClickUpAuthorization)) {
      return createClickUpMcpClient({
        getAuthorization: getClickUpAuthorization || (async () => {
          const t = typeof getClickUpToken === "function" ? getClickUpToken() : "";
          return t || "";
        }),
        refreshAuth: refreshClickUpAuth,
        getToken: getClickUpToken,
      });
    }
    return createClickUpHttpClient({ getToken: getClickUpToken });
  }

  function status() {
    const pend = state.pendencias.filter((p) => p.estado === "pendente");
    return {
      id: "oasis",
      pausado: state.pausado,
      ultimoCicloEm: state.ultimoCicloEm,
      ultimoResumo: state.ultimoResumo,
      clickupConfigurado: clickupConfigurado(),
      tokenDefinido: tokenPresente(),
      conectorDefinido: conectorPresente(),
      // nunca o valor do token
      tarefas: state.tarefas.slice(-10).map((t) => ({
        id: t.id,
        taskId: t.taskId,
        nome: t.nome,
        repoPath: t.repoPath,
        etapa: t.etapa,
        criadoEm: t.criadoEm,
      })),
      pendencias: pend.map((p) => ({
        id: p.id,
        tipo: p.tipo,
        taskId: p.taskId,
        titulo: p.titulo,
        criadoEm: p.criadoEm,
      })),
      reposRoot: rootRepos,
      mark: OASIS_CICLO_MARK,
      subagentes: [...SUBAGENTES],
    };
  }

  function setPausado(pausado) {
    state.pausado = Boolean(pausado);
    persist();
    return status();
  }

  function postConfigCard() {
    const ago = state.alertaConfigEm ? Date.parse(state.alertaConfigEm) : 0;
    if (ago && now() - ago < 6 * 60 * 60 * 1000) return false;
    state.alertaConfigEm = nowIso();
    persist();
    try {
      quadro.postar({
        de: "oasis",
        para: "helison",
        tipo: "alerta",
        assunto: "Configure o ClickUp para o Oasis",
        corpo: redact([
          "O agente Oasis precisa do token do ClickUp no cofre (nome contendo ClickUp)",
          "ou do conector ClickUp ligado em Conectores.",
          "Sem isso não lê tarefas nem escreve comentários.",
          "Cofre › Token, ou Ajustes › Conectores › ClickUp.",
        ].join("\n")).slice(0, 4000),
        ref: "oasis-config-clickup",
      });
    } catch { /* isolamento / quadro */ }
    return true;
  }

  function registrarSubagente(tarefa, nome, detalhe) {
    if (!SUBAGENTES.includes(nome)) return;
    tarefa.subagentes = Array.isArray(tarefa.subagentes) ? tarefa.subagentes : [];
    tarefa.subagentes.push({ nome, detalhe: String(detalhe || "").slice(0, 200), em: nowIso() });
    tarefa.etapa = nome;
  }

  function processarTarefa(task) {
    if (isEmpregoTask(task)) {
      return { ignorada: true, motivo: "emprego_isolado", taskId: task.id };
    }
    if (state.processadosTaskIds.includes(String(task.id))) {
      return { ignorada: true, motivo: "ja_processada", taskId: task.id };
    }

    const plano = proporPlano(task);
    const repoPath = resolveRepoPath(task, rootRepos);
    const tarefa = {
      id: newId("oas"),
      taskId: String(task.id),
      nome: plano.titulo,
      repoPath,
      plano,
      etapa: "ler",
      subagentes: [],
      criadoEm: nowIso(),
      url: plano.url,
    };
    registrarSubagente(tarefa, "ler", `ClickUp ${task.id}`);
    registrarSubagente(tarefa, "planejar", plano.resumo);

    const pend = {
      id: newId("oasp"),
      tipo: "execucao",
      estado: "pendente",
      taskId: tarefa.taskId,
      tarefaId: tarefa.id,
      titulo: plano.titulo,
      repoPath,
      plano,
      criadoEm: nowIso(),
    };
    state.pendencias.push(pend);
    state.tarefas.push(tarefa);
    if (state.tarefas.length > 40) state.tarefas = state.tarefas.slice(-40);
    if (state.pendencias.length > 40) state.pendencias = state.pendencias.slice(-40);

    state.processadosTaskIds.push(String(task.id));
    if (state.processadosTaskIds.length > 80) {
      state.processadosTaskIds = state.processadosTaskIds.slice(-80);
    }

    quadro.postar({
      de: "oasis",
      para: "chefe",
      tipo: "resultado",
      assunto: `Plano Oasis: ${plano.titulo}`.slice(0, 160),
      corpo: redact([
        `Tarefa ClickUp: ${tarefa.taskId}`,
        `Repo: ${repoPath}`,
        `Resumo: ${plano.resumo}`,
        `Passos: ${plano.passos.join(" → ")}`,
        `Aguardando aprovação para executar no repo (pendência ${pend.id}).`,
        "Nada foi escrito no ClickUp.",
      ].join("\n")).slice(0, 4000),
      ref: tarefa.taskId,
    });

    quadro.postar({
      de: "oasis",
      para: "helison",
      tipo: "alerta",
      assunto: `Aprovar execução Oasis: ${plano.titulo}`.slice(0, 160),
      corpo: redact([
        `Plano pronto para ${plano.titulo}.`,
        `Repo alvo: ${repoPath}`,
        "Aprovar execução local: POST /api/agente/oasis/aprovar com { id, decision: \"approve\" }.",
        "Comentar/atualizar ClickUp só numa segunda aprovação.",
      ].join("\n")).slice(0, 4000),
      ref: pend.id,
    });

    return { tarefa, pendencia: pend, plano };
  }

  async function ciclo({ forcar = false, limite = 5, tasks: injected } = {}) {
    if (state.pausado && !forcar) {
      return { ok: false, motivo: "pausado", processados: [], status: status() };
    }

    if (!clickupConfigurado() && injected == null) {
      postConfigCard();
      state.ultimoCicloEm = nowIso();
      state.ultimoResumo = "ClickUp não configurado — card pedindo configuração.";
      persist();
      return {
        ok: false,
        motivo: "clickup_nao_configurado",
        configNeeded: true,
        processados: [],
        status: status(),
      };
    }

    let tasks = Array.isArray(injected) ? injected : null;
    if (!tasks) {
      const c = client();
      if (!c || typeof c.listAssigned !== "function") {
        postConfigCard();
        state.ultimoCicloEm = nowIso();
        state.ultimoResumo = "ClickUp sem cliente.";
        persist();
        return { ok: false, motivo: "clickup_nao_configurado", configNeeded: true, processados: [], status: status() };
      }
      try {
        tasks = await c.listAssigned();
      } catch (err) {
        state.ultimoCicloEm = nowIso();
        state.ultimoResumo = `Falha ao ler ClickUp: ${String(err.message || err).slice(0, 120)}`;
        persist();
        return { ok: false, motivo: "clickup_erro", erro: String(err.message || err).slice(0, 160), processados: [], status: status() };
      }
    }

    const lote = (tasks || [])
      .filter((t) => t && t.id)
      .filter((t) => !isEmpregoTask(t))
      .filter((t) => !state.processadosTaskIds.includes(String(t.id)))
      .slice(0, Math.max(1, Math.min(15, Number(limite) || 5)));

    const processados = [];
    for (const task of lote) {
      processados.push(processarTarefa(task));
    }

    state.ultimoCicloEm = nowIso();
    state.ultimoResumo = processados.length
      ? `${processados.length} plano(s); ${state.pendencias.filter((p) => p.estado === "pendente").length} aprovação(ões) pendente(s).`
      : "Sem tarefas novas atribuídas (ou só emprego filtrado).";
    persist();
    return { ok: true, processados, status: status() };
  }

  function escreverPlanoNoRepo(repoPath, plano, task) {
    const dir = path.resolve(repoPath);
    // Trava: repo deve ficar sob reposRoot (evita escrever fora).
    const rel = path.relative(rootRepos, dir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      // Permite path absoluto explícito da tarefa se estiver sob Repositorios do usuário
      // ou se for o path customizado — ainda assim bloqueia system dirs.
      const blocked = /^(C:\\Windows|C:\\Program Files|\/etc|\/usr)/i.test(dir);
      if (blocked) throw fail("Repo fora da área permitida.", 403);
    }
    fs.mkdirSync(path.join(dir, ".helios"), { recursive: true });
    const dest = path.join(dir, ".helios", "oasis-plano.md");
    fs.writeFileSync(dest, planoMarkdown(plano, task, dir), "utf8");
    return { path: dest, repoPath: dir };
  }

  async function aplicarClickUp(pend, { statusClickUp = "in progress" } = {}) {
    if (mock && !clickupClient) {
      return {
        ok: true,
        mock: true,
        comment: { ok: true, taskId: pend.taskId },
        status: { ok: true, taskId: pend.taskId, status: statusClickUp },
      };
    }
    const c = client();
    if (!c) throw fail("ClickUp não configurado.", 503);
    const texto = [
      "HELIOS Oasis — plano executado localmente.",
      `Repo: ${pend.repoPath}`,
      `Resumo: ${pend.plano?.resumo || pend.titulo}`,
      "Aguardando revisão humana no repositório.",
    ].join("\n");
    const comment = typeof c.comment === "function"
      ? await c.comment(pend.taskId, texto)
      : { ok: true, taskId: pend.taskId };
    const st = typeof c.setStatus === "function"
      ? await c.setStatus(pend.taskId, statusClickUp)
      : { ok: true, taskId: pend.taskId, status: statusClickUp };
    return { ok: true, comment, status: st };
  }

  async function resolver(pendenciaId, decision, { statusClickUp } = {}) {
    const id = String(pendenciaId || "").trim();
    const pend = state.pendencias.find((p) => p.id === id && p.estado === "pendente");
    if (!pend) throw fail("Pendência Oasis não encontrada.", 404);
    const ok = decision === "approve" || decision === "aprovar";
    const deny = decision === "deny" || decision === "negar";
    if (!ok && !deny) throw fail("Decisão inválida. Use approve ou deny.");

    const tarefa = state.tarefas.find((t) => t.id === pend.tarefaId);

    if (deny) {
      pend.estado = "negada";
      pend.decididoEm = nowIso();
      persist();
      quadro.postar({
        de: "oasis",
        para: "chefe",
        tipo: "alerta",
        assunto: `Oasis negado: ${pend.titulo}`.slice(0, 160),
        corpo: `Helison negou ${pend.id} (${pend.tipo}). Nada escrito no repo nem no ClickUp.`,
        ref: pend.id,
      });
      return { pendencia: { id: pend.id, estado: pend.estado, tipo: pend.tipo }, executado: false, clickup: false };
    }

    if (pend.tipo === "execucao") {
      const written = escreverPlanoNoRepo(pend.repoPath, pend.plano, { id: pend.taskId, name: pend.titulo });
      if (tarefa) registrarSubagente(tarefa, "executar", written.path);
      pend.estado = "aprovada_executada";
      pend.decididoEm = nowIso();
      pend.arquivoPlano = written.path;

      const pendCu = {
        id: newId("oasp"),
        tipo: "clickup",
        estado: "pendente",
        taskId: pend.taskId,
        tarefaId: pend.tarefaId,
        titulo: pend.titulo,
        repoPath: pend.repoPath,
        plano: pend.plano,
        arquivoPlano: written.path,
        criadoEm: nowIso(),
      };
      state.pendencias.push(pendCu);
      persist();

      quadro.postar({
        de: "oasis",
        para: "chefe",
        tipo: "resultado",
        assunto: `Executado local: ${pend.titulo}`.slice(0, 160),
        corpo: redact([
          `Plano gravado em ${written.path}.`,
          "ClickUp ainda não foi atualizado.",
          `Aprovar comentário/status: pendência ${pendCu.id}.`,
        ].join("\n")).slice(0, 4000),
        ref: pend.id,
      });

      quadro.postar({
        de: "oasis",
        para: "helison",
        tipo: "alerta",
        assunto: `Aprovar ClickUp: ${pend.titulo}`.slice(0, 160),
        corpo: redact([
          "Execução local ok.",
          "Comentar e atualizar status no ClickUp exige nova aprovação.",
          `POST /api/agente/oasis/aprovar { id: "${pendCu.id}", decision: "approve" }.`,
        ].join("\n")).slice(0, 4000),
        ref: pendCu.id,
      });

      return {
        pendencia: { id: pend.id, estado: pend.estado, tipo: pend.tipo },
        executado: true,
        arquivoPlano: written.path,
        pendenciaClickUp: { id: pendCu.id },
        clickup: false,
      };
    }

    if (pend.tipo === "clickup") {
      const result = await aplicarClickUp(pend, { statusClickUp: statusClickUp || "in progress" });
      if (tarefa) registrarSubagente(tarefa, "atualizar", "comentário + status ClickUp");
      pend.estado = "aprovada_clickup";
      pend.decididoEm = nowIso();
      pend.resultadoClickUp = {
        ok: result.ok,
        mock: Boolean(result.mock),
        status: result.status?.status || null,
        // nunca tokens
      };
      persist();

      quadro.postar({
        de: "oasis",
        para: "chefe",
        tipo: "resultado",
        assunto: `ClickUp atualizado: ${pend.titulo}`.slice(0, 160),
        corpo: redact([
          `Tarefa ${pend.taskId}: comentário + status.`,
          result.mock ? "Modo mock (sem rede)." : "Escrita via API ClickUp.",
          `Plano local: ${pend.arquivoPlano || pend.repoPath}`,
        ].join("\n")).slice(0, 4000),
        ref: pend.id,
      });

      return {
        pendencia: { id: pend.id, estado: pend.estado, tipo: pend.tipo },
        executado: true,
        clickup: true,
        mock: Boolean(result.mock),
      };
    }

    throw fail(`Tipo de pendência desconhecido: ${pend.tipo}`);
  }

  function installRotina({ clock = "09:30", weekdays = [1, 2, 3, 4, 5] } = {}) {
    if (!routines || typeof routines.add !== "function") {
      throw fail("Rotinas não disponíveis neste contexto.");
    }
    const okClock = /^\d{2}:\d{2}$/.test(String(clock || "")) ? String(clock) : "09:30";
    const existing = routines.list().find((r) => String(r.prompt || "").includes(OASIS_CICLO_MARK));
    if (existing) {
      return routines.update(existing.id, {
        enabled: existing.enabled,
        clock: okClock,
        weekdays: Array.isArray(weekdays) ? weekdays : [1, 2, 3, 4, 5],
        title: OASIS_CICLO_TITLE,
      });
    }
    return routines.add({
      title: OASIS_CICLO_TITLE,
      prompt: `${OASIS_CICLO_MARK} Ler tarefas atribuídas no ClickUp, propor planos e pedir aprovação antes de executar/comentar.`,
      clock: okClock,
      weekdays: Array.isArray(weekdays) ? weekdays : [1, 2, 3, 4, 5],
      enabled: false,
      assistantId: "oasis",
    });
  }

  return {
    status,
    setPausado,
    ciclo,
    resolver,
    proporPlano,
    resolveRepoPath: (task) => resolveRepoPath(task, rootRepos),
    installRotina,
    clickupConfigurado,
    isEmpregoTask,
    OASIS_CICLO_MARK,
    DEFAULT_REPOS_ROOT,
  };
}

module.exports = {
  createAgentOasis,
  createClickUpHttpClient,
  proporPlano,
  resolveRepoPath,
  slugify,
  isEmpregoTask,
  planoMarkdown,
  OASIS_CICLO_MARK,
  OASIS_CICLO_TITLE,
  DEFAULT_REPOS_ROOT,
  SUBAGENTES,
  EMPREGO_RE,
};
