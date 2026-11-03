"use strict";

/**
 * LEVA O3: agente Vagas — rotinas LinkedIn (2x/dia) + plataformas (1x/dia),
 * teto por hora, horários aleatórios, ritmo humano, só sessão HELIOS,
 * inscrição automática com paradas críticas, filtro mínimo,
 * achados/resultados no quadro. NUNCA postar/comentar/reagir no LinkedIn.
 */
const path = require("node:path");
const { nowIso, readJson, writeJson, redact } = require("./util");
const { parseLinkedin, DEFAULT_PREFS } = require("./jobs");
const { parseSavedJobsPage } = require("./vagas-visual");
const { keywordPass, matchScore } = require("./vagas-match");

// O Helison autorizou candidaturas automáticas sem uma cota artificial de revisões.
// Perguntas críticas, login, captcha e testes continuam interrompendo a vaga.
const REVISOES_INICIAIS = 0;
const POR_HORA_PADRAO = 3;
const MAX_POR_VARREDURA = 15; // sem raspagem em massa
const JANELA_INI = 8; // 08h
const JANELA_FIM = 20; // 20h
const LINKEDIN_POR_DIA = 2;
const PLATAFORMAS_POR_DIA = 1;
const GAP_MIN_MS = 90 * 60e3; // mínimo entre varreduras no mesmo dia

const FONTES_LI = ["feed", "salvos", "salvos-vagas", "notificacoes", "busca"];
const ACOES_PROIBIDAS = Object.freeze([
  "postar", "publicar", "comentar", "reagir", "curtir", "share", "mensagem", "conectar",
]);

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function dayKey(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** Fixture / DOM: posts do feed (só leitura). */
function parseLinkedinFeedHtml(html) {
  const out = [];
  const blocks = String(html || "").split(/data-urn=["']([^"']+)["']/i);
  // split yields [before, urn, rest, urn, rest...]
  for (let i = 1; i < blocks.length; i += 2) {
    const urn = blocks[i];
    const chunk = blocks[i + 1] || "";
    const autor = decodeHtml((chunk.match(/class=["'][^"']*actor[^"']*["'][^>]*>([\s\S]*?)<\//i) || chunk.match(/data-autor=["']([^"']+)/i) || [])[1]);
    const texto = decodeHtml((chunk.match(/class=["'][^"']*(?:update-components-text|feed-shared-text|post-text)[^"']*["'][^>]*>([\s\S]*?)<\//i) || chunk.match(/data-texto=["']([^"']+)/i) || [])[1]);
    const url = (chunk.match(/href=["'](https:\/\/[^"']*(?:feed\/update|posts)[^"']*)["']/i) || [])[1] || "";
    if (!texto && !urn) continue;
    out.push({ id: urn, autor: autor.slice(0, 80), texto: (texto || "").slice(0, 1200), url: url.split("?")[0] });
  }
  // marcadores simples de fixture
  const simple = [...String(html || "").matchAll(/<article[^>]*data-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/article>/gi)];
  for (const m of simple) {
    if (out.some((x) => x.id === m[1])) continue;
    const chunk = m[2];
    out.push({
      id: m[1],
      autor: decodeHtml((chunk.match(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/i) || [])[1]).slice(0, 80),
      texto: decodeHtml((chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1]).slice(0, 1200),
      url: (chunk.match(/href=["'](https:\/\/[^"']+)["']/i) || [])[1] || "",
    });
  }
  return out.slice(0, MAX_POR_VARREDURA);
}

/** Fixture: posts salvos (/my-items/saved-posts/). */
function parseLinkedinSavedHtml(html) {
  const out = [];
  const cards = [...String(html || "").matchAll(/<li[^>]*class=["'][^"']*saved[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)];
  for (const m of cards) {
    const chunk = m[1];
    const url = (chunk.match(/href=["'](https:\/\/[^"']+)["']/i) || [])[1] || "";
    const id = (chunk.match(/data-id=["']([^"']+)["']/i) || [])[1] || url || `saved:${out.length}`;
    const texto = decodeHtml((chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || chunk.match(/class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\//i) || [])[1]);
    const autor = decodeHtml((chunk.match(/class=["'][^"']*actor[^"']*["'][^>]*>([\s\S]*?)<\//i) || [])[1]);
    if (!texto && !url) continue;
    out.push({ id, autor: autor.slice(0, 80), texto: (texto || url).slice(0, 1200), url: url.split("?")[0] });
  }
  if (!out.length) return parseLinkedinFeedHtml(html);
  return out.slice(0, MAX_POR_VARREDURA);
}

/** Fixture: notificações (só leitura; filtra as que parecem vaga). */
function parseLinkedinNotificationsHtml(html) {
  const out = [];
  const items = [...String(html || "").matchAll(/<li[^>]*class=["'][^"']*notification[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)];
  for (const m of items) {
    const chunk = m[1];
    const texto = decodeHtml((chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || chunk.match(/class=["'][^"']*text[^"']*["'][^>]*>([\s\S]*?)<\//i) || [])[1]);
    const url = (chunk.match(/href=["'](https:\/\/[^"']+)["']/i) || [])[1] || "";
    const id = (chunk.match(/data-id=["']([^"']+)["']/i) || [])[1] || `notif:${texto.slice(0, 40)}`;
    if (!texto) continue;
    if (!/(vaga|job|contratando|hiring|candidat|oportunidade|recrut)/i.test(texto)) continue;
    out.push({ id, autor: "notificação", texto: texto.slice(0, 800), url: url.split("?")[0] });
  }
  return out.slice(0, MAX_POR_VARREDURA);
}

/** Bloqueia qualquer tentativa de ação social no LinkedIn. */
function assertNuncaPostar(acao) {
  const key = String(acao || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (ACOES_PROIBIDAS.some((p) => key.includes(p))) {
    throw fail("LinkedIn: o HELIOS nunca posta, comenta, reage nem envia mensagem.", 403);
  }
  return true;
}

function randInt(min, max, rng) {
  const r = typeof rng === "function" ? rng() : Math.random();
  return min + Math.floor(r * (max - min + 1));
}

/**
 * Gera horários aleatórios no dia (HH:MM) dentro da janela, com gap mínimo.
 * LinkedIn: 2; plataformas: 1.
 */
function planejarHorarios(day, { rng = Math.random, linkedin = LINKEDIN_POR_DIA, plataformas = PLATAFORMAS_POR_DIA } = {}) {
  const slots = [];
  const totalMin = (JANELA_FIM - JANELA_INI) * 60;
  const picks = [];
  const n = linkedin + plataformas;
  let tries = 0;
  while (picks.length < n && tries < 80) {
    tries += 1;
    const m = randInt(0, totalMin - 1, rng);
    if (picks.every((p) => Math.abs(p - m) * 60e3 >= GAP_MIN_MS)) picks.push(m);
  }
  picks.sort((a, b) => a - b);
  for (let i = 0; i < picks.length; i += 1) {
    const mins = picks[i];
    const hh = String(JANELA_INI + Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    const tipo = i < linkedin ? "linkedin" : "plataformas";
    const fontes = tipo === "linkedin"
      ? FONTES_LI.slice(0, 5) // publicações salvas, vagas salvas, notificações e busca
      : ["plataformas"];
    slots.push({
      id: `${day}-${tipo}-${hh}${mm}`,
      day,
      clock: `${hh}:${mm}`,
      tipo,
      fontes,
      feito: false,
      feitoEm: null,
    });
  }
  return slots;
}

function clockDue(clock, at) {
  if (!/^\d{2}:\d{2}$/.test(String(clock || ""))) return false;
  const d = new Date(at);
  const [hh, mm] = clock.split(":").map(Number);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  return nowMin >= hh * 60 + mm;
}

function createAgentVagas(dataDir, {
  scorer: scorerFn = null,
  jobs,
  quadro,
  adapters = null,
  operacional = false,
  now = () => Date.now(),
  rng = Math.random,
  readProfile = () => "",
  sleep = null, // injetável; em teste null = sem espera
} = {}) {
  if (!jobs) throw new Error("agent-vagas precisa de jobs");
  if (!quadro) throw new Error("agent-vagas precisa do quadro");

  const file = path.join(dataDir, "agente-vagas.json");
  const saved = readJson(file, {});
  let state = {
    version: 1,
    // No app instalado a operação começa ativa; uma pausa salva pelo Helison é respeitada.
    pausado: saved.pausado === undefined ? !operacional : saved.pausado !== false,
    porHora: Math.min(10, Math.max(1, Number(saved.porHora) || POR_HORA_PADRAO)),
    revisoesManuais: Math.max(0, Number(saved.revisoesManuais) || 0),
    revisoesNecessarias: 0,
    modo: "automatico",
    partition: "persist:vagas",
    day: saved.day || null,
    horarios: Array.isArray(saved.horarios) ? saved.horarios : [],
    ultimasVarreduras: Array.isArray(saved.ultimasVarreduras) ? saved.ultimasVarreduras.slice(-40) : [],
    contagemHora: Array.isArray(saved.contagemHora) ? saved.contagemHora : [],
    ultimoCicloEm: saved.ultimoCicloEm || null,
    ultimoResumo: saved.ultimoResumo || "",
  };

  // Migra a antiga trava de revisão para o comportamento autorizado pelo Helison.
  // As paradas críticas continuam existindo no preenchimento e no navegador.
  try { if (jobs.prefs().modo !== "automatico") jobs.setPrefs({ modo: "automatico" }); } catch { /* prefs opcionais */ }

  // LEVA S3: modo automatico (decisao t143u/t145u) -> cancela cartoes antigos "Aprovar inscricao".
  function limparAlertasAprovacao() {
    if (!quadro || typeof quadro.ler !== "function") return 0;
    let n = 0;
    try {
      for (const it of quadro.ler({ de: "vagas", status: "aberto", limite: 500 })) {
        if (/^Aprovar inscri/i.test(String(it.assunto || ""))) { quadro.atualizarStatus(it.id, "cancelado"); n += 1; }
      }
    } catch { /* quadro opcional */ }
    return n;
  }
  setTimeout(limparAlertasAprovacao, 0);

  function persist() {
    writeJson(file, state);
  }
  // Mantém o arquivo de estado coerente com a preferência migrada do jobs.
  persist();

  function ensureDay(at = now()) {
    const d = dayKey(at);
    if (state.day !== d || !state.horarios.length) {
      state.day = d;
      state.horarios = planejarHorarios(d, { rng });
      persist();
    }
    return state.horarios;
  }

  function limparHora(at = now()) {
    state.contagemHora = (state.contagemHora || []).filter((t) => at - t < 3600e3);
  }

  function rateLeft(at = now()) {
    limparHora(at);
    return Math.max(0, state.porHora - state.contagemHora.length);
  }

  function registrarUso(at = now()) {
    limparHora(at);
    state.contagemHora.push(at);
    persist();
  }

  function modoInscricao() {
    return jobs.prefs().modo === "automatico" ? "automatico" : "aprovacao";
  }

  function podeAutomatico() {
    return true;
  }

  /** Permite alternar o modo sem exigir uma cota artificial de revisões. */
  function setModo(valor) {
    const next = String(valor) === "automatico" ? "automatico" : "aprovacao";
    state.modo = next;
    jobs.setPrefs({ modo: state.modo });
    persist();
    return status();
  }

  function registrarRevisaoManual() {
    state.revisoesManuais += 1;
    persist();
    return { revisoesManuais: state.revisoesManuais, faltam: Math.max(0, state.revisoesNecessarias - state.revisoesManuais) };
  }

  function status(at = now()) {
    ensureDay(at);
    return {
      id: "vagas",
      pausado: state.pausado,
      modo: modoInscricao(),
      porHora: state.porHora,
      rateLeft: rateLeft(at),
      revisoesManuais: state.revisoesManuais,
      revisoesNecessarias: 0,
      faltamRevisoes: 0,
      podeAutomatico: podeAutomatico(),
      partition: state.partition,
      day: state.day,
      horarios: state.horarios.map((h) => ({ ...h })),
      ultimoCicloEm: state.ultimoCicloEm,
      ultimoResumo: state.ultimoResumo,
      nuncaPostar: true,
      maxPorVarredura: MAX_POR_VARREDURA,
    };
  }

  function setPausado(pausado) {
    state.pausado = Boolean(pausado);
    persist();
    return status();
  }

  function due(at = now()) {
    if (state.pausado) return [];
    ensureDay(at);
    return state.horarios.filter((h) => !h.feito && clockDue(h.clock, at));
  }

  async function filtrarLista(lista, prefs) {
    const profileText = String(readProfile() || "");
    const out = [];
    for (const job of lista.slice(0, MAX_POR_VARREDURA)) {
      const pre = keywordPass(job, prefs);
      if (!pre.pass) continue;
      const scored = await matchScore(job, { prefs, profileText, perfil: prefs.perfil || {}, scorer: typeof scorerFn === "function" ? scorerFn() : null });
      const min = Number(prefs.notaMinima) || 40;
      if (scored.score < min) continue;
      out.push({ ...job, score: scored.score, motivos: scored.motivos });
    }
    return out;
  }

  function postarAchados(itens, { fonte = "varredura", tipo = "achado" } = {}) {
    if (!itens.length) return null;
    const top = itens.slice(0, 8);
    const assunto = tipo === "resultado"
      ? `Resultado Vagas (${fonte})`
      : `Achados Vagas (${fonte}): ${itens.length}`;
    const corpo = top.map((j) => `• ${j.title || j.texto || "item"} — ${j.company || j.autor || ""} [${j.score ?? "?"}]`).join("\n")
      || "Sem itens novos.";
    return quadro.postar({
      de: "vagas",
      para: "chefe",
      tipo: tipo === "resultado" ? "resultado" : "achado",
      assunto: redact(assunto).slice(0, 160),
      corpo: redact(corpo).slice(0, 4000),
      ref: fonte,
    });
  }

  /**
   * Ingestão a partir de HTML de fixture (testes sem rede) ou DOM capturado pelo host.
   * tipos: feed | salvos | notificacoes | busca
   */
  async function ingestHtml({ tipo, html, term = "" } = {}) {
    assertNuncaPostar(tipo);
    const kind = String(tipo || "").toLowerCase();
    const prefs = jobs.prefs();
    let novos = 0;
    let filtrados = [];
    let raw = [];

    if (kind === "feed") {
      raw = parseLinkedinFeedHtml(html);
      const r = jobs.ingestFeed(raw);
      novos = r.novos;
      filtrados = jobs.feed(MAX_POR_VARREDURA).filter((f) => f.fonte === "feed" || !f.fonte);
    } else if (kind === "salvos") {
      raw = parseLinkedinSavedHtml(html);
      const r = jobs.ingestSavedPosts(raw);
      novos = r.novos;
      filtrados = jobs.feed(MAX_POR_VARREDURA).filter((f) => f.fonte === "saved");
    } else if (kind === "notificacoes") {
      raw = parseLinkedinNotificationsHtml(html);
      const r = jobs.ingestFeed(raw.map((p) => ({ ...p, id: `notif:${p.id}` })));
      novos = r.novos;
      filtrados = raw;
    } else if (kind === "busca") {
      raw = parseLinkedin(html).slice(0, MAX_POR_VARREDURA);
      if (term) {
        const q = String(term).toLowerCase();
        raw = raw.filter((j) => `${j.title} ${j.company} ${j.description}`.toLowerCase().includes(q) || !q);
      }
      const ingested = jobs.ingestParsedJobs(raw, { platform: "linkedin" });
      novos = ingested.novas;
      filtrados = ingested.aceitas || [];
      void prefs;
    } else if (kind === "salvos-vagas") {
      const parsed = parseSavedJobsPage(html);
      raw = parsed.jobs.slice(0, MAX_POR_VARREDURA);
      const ingested = jobs.ingestParsedJobs(raw, { platform: "linkedin" });
      novos = ingested.novas;
      filtrados = ingested.aceitas || [];
    } else {
      throw fail("tipo de ingestão inválido (feed|salvos|notificacoes|busca|salvos-vagas).");
    }

    const card = postarAchados(
      filtrados.map((x) => ({
        title: x.title || x.texto,
        company: x.company || x.autor,
        score: x.score,
      })),
      { fonte: `linkedin:${kind}` },
    );
    return { ok: true, tipo: kind, lidos: raw.length, novos, quadroId: card?.id || null };
  }

  let live = { running: false, done: true, fase: "ocioso", error: "", result: null, ultimo: null };
  const progress = (fase, detalhe = {}) => {
    live = { ...live, fase, ultimo: detalhe, at: new Date(now()).toISOString() };
  };
  function andamento() {
    const { result, ...rest } = live;
    return { ...rest, result: result ? { ok: result.ok, feitos: result.feitos || [], erros: result.erros || [], motivo: result.motivo || "" } : null };
  }
  function iniciarCiclo(opts = {}) {
    if (live.running) return { ok: true, iniciado: true, jaRodando: true };
    live = { running: true, done: false, fase: "inicio", error: "", result: null, ultimo: null };
    ciclo({ ...opts, background: false }).then((result) => {
      live = { running: false, done: true, fase: "concluido", error: "", result, ultimo: { feitos: (result.feitos || []).length } };
    }).catch((error) => {
      live = { running: false, done: true, fase: "erro", result: null, error: String(error && error.message || error).slice(0, 300), ultimo: null };
    });
    return { ok: true, iniciado: true };
  }

  /** Ciclo: executa slots vencidos com teto/hora e ritmo humano (sem rede no mock). */
  async function ciclo({ forcar = false, completa = false, at = now(), htmlByFonte = {}, runner = null } = {}) {
    assertNuncaPostar("ciclo");
    if (state.pausado && !forcar) {
      return { ok: false, motivo: "pausado", feitos: [] };
    }
    ensureDay(at);
    if (!rateLeft(at) && !forcar) {
      return { ok: false, motivo: "limite_hora", feitos: [], rateLeft: 0 };
    }

    // Uma rodada manual completa não depende dos slots já consumidos no dia:
    // ela sempre cobre LinkedIn (somente leitura) e as plataformas de vagas.
    // Os slots sintéticos não alteram a agenda; servem apenas para esta execução.
    const slots = completa
      ? [
        { id: `manual-${dayKey(at)}-linkedin`, tipo: "linkedin", fontes: FONTES_LI, feito: false },
        { id: `manual-${dayKey(at)}-plataformas`, tipo: "plataformas", fontes: ["plataformas"], feito: false },
      ]
      : (forcar
        ? state.horarios.filter((h) => !h.feito).slice(0, 1)
        : due(at));
    const feitos = [];
    const erros = [];
    if (typeof jobs.revisarFila === "function") jobs.revisarFila();
    progress("busca", { slots: slots.length });

    for (const slot of slots) {
      if (!rateLeft(at) && !forcar) break;
      if (typeof sleep === "function") await sleep(50 + Math.floor(rng() * 50)); // ritmo humano (curto em teste)

      const feitosAntes = feitos.length;
      if (slot.tipo === "linkedin") {
        for (const fonte of slot.fontes) {
          progress("linkedin", { fonte });
          try {
            if (typeof runner === "function") {
              const r = await runner({ tipo: "linkedin", fonte, slot });
              feitos.push({ slot: slot.id, fonte, ...r });
            } else if (htmlByFonte[fonte]) {
              const r = await ingestHtml({ tipo: fonte, html: htmlByFonte[fonte] });
              feitos.push({ slot: slot.id, fonte, ...r });
            } else {
              feitos.push({ slot: slot.id, fonte, ok: true, skipped: "sem_html_nem_runner" });
            }
          } catch (e) {
            erros.push(`${fonte}: ${e.message}`);
          }
        }
      } else if (slot.tipo === "plataformas") {
        try {
          progress("plataformas", { slot: slot.id });
          const rr = typeof runner === "function" ? await runner({ tipo: "plataformas", slot, onProgress: (detalhe) => progress("plataforma", detalhe || {}) }) : null;
          if (rr) {
            const r = rr;
            feitos.push({ slot: slot.id, fonte: "plataformas", ...r });
          } else if (adapters && typeof adapters.searchAll === "function") {
            const term = (jobs.prefs().termos || DEFAULT_PREFS.termos)[0] || "front-end";
            const antes = new Set(jobs.list().map((v) => v.id));
            // Busca normal (LinkedIn/Gupy) + APIs auxiliares (GitHub/Remotar). Os dois
            // caminhos precisam persistir vagas na mesma fila para o automático.
            const base = await jobs.search();
            const r = await adapters.searchAll(term);
            const prefs = jobs.prefs();
            const filtrados = await filtrarLista(r.jobs || [], prefs);
            const porPlataforma = new Map();
            for (const job of filtrados) {
              const platform = String(job.platform || "plataforma");
              if (!porPlataforma.has(platform)) porPlataforma.set(platform, []);
              porPlataforma.get(platform).push(job);
            }
            for (const [platform, rows] of porPlataforma) jobs.ingestParsedJobs(rows, { platform });
            const novos = jobs.list({ status: "nova" }).filter((v) => !antes.has(v.id));
            const card = postarAchados(novos.slice(0, MAX_POR_VARREDURA).map((j) => ({
              title: j.title, company: j.company, score: j.score,
            })), { fonte: "plataformas" });
            feitos.push({
              slot: slot.id,
              fonte: "plataformas",
              ok: true,
              novos: novos.length,
              lidos: (base.fontes || []).reduce((n, f) => n + (Number(f.encontradas) || 0), 0) + (r.jobs || []).length,
              fontes: base.fontes || [],
              quadroId: card?.id || null,
              erros: [...(base.erros || []), ...(r.erros || [])],
            });
          } else {
            const busca = await jobs.search();
            const card = postarAchados(
              jobs.list({ status: "nova" }).slice(0, 8).map((v) => ({ title: v.title, company: v.company, score: v.score })),
              { fonte: "plataformas" },
            );
            feitos.push({ slot: slot.id, fonte: "plataformas", ok: true, novas: busca.novas, quadroId: card?.id || null, erros: busca.erros || [] });
          }
        } catch (e) {
          erros.push(`plataformas: ${e.message}`);
        }
      }

      // LEVA S: so marca feito se alguma varredura rodou de verdade (nao pulada nem falha).
      const reais = feitos.slice(feitosAntes).filter((f) => !f.skipped && f.ok !== false);
      if (!reais.length) continue;
      slot.feito = true;
      slot.feitoEm = nowIso();
      registrarUso(at);
      state.ultimasVarreduras.push({ id: slot.id, at: nowIso(), tipo: slot.tipo });
      if (state.ultimasVarreduras.length > 40) state.ultimasVarreduras = state.ultimasVarreduras.slice(-40);
    }

    state.ultimoCicloEm = nowIso();
    state.ultimoResumo = feitos.length
      ? `${feitos.length} varredura(s): ${feitos.map((f) => f.fonte).join(", ")}`
      : (erros[0] || "nada devido");
    persist();

    if (feitos.length) {
      postarAchados(
        [{ title: state.ultimoResumo, company: "agente-vagas", score: feitos.length }],
        { fonte: "ciclo", tipo: "resultado" },
      );
    }

    progress(erros.length ? "concluido_com_erros" : "concluido", { feitos: feitos.length, erros: erros.length });
    return { ok: true, feitos, erros, status: status(at) };
  }

  /** Prepara inscrição; o modo automático não cria cartão, mas mantém paradas críticas. */
  function prepararInscricao(vagaId, opts = {}) {
    assertNuncaPostar("inscricao");
    const v = jobs.prepare(vagaId, opts);
    if (podeAutomatico()) return v; // LEVA S3: automatico nao cria cartao de aprovacao
    try {
      quadro.postar({
        de: "vagas",
        para: "helison",
        tipo: "alerta",
        assunto: `Aprovar inscrição: ${v.title}`.slice(0, 160),
        corpo: `Empresa: ${v.company}\nNota: ${v.score}\nURL: ${v.url}\nModo: aprovação. Nada é enviado sem o seu OK.`,
        ref: v.id,
      });
    } catch { /* quadro opcional */ }
    return v;
  }

  function aprovarInscricao(vagaId, opts = {}) {
    assertNuncaPostar("aprovar");
    const v = jobs.approve(vagaId, opts);
    registrarRevisaoManual();
    try {
      quadro.postar({
        de: "vagas",
        para: "chefe",
        tipo: "resultado",
        assunto: `Inscrição aprovada: ${v.title}`.slice(0, 160),
        corpo: `${v.company} — revisão manual registrada.`,
        ref: v.id,
      });
    } catch { /* ok */ }
    return v;
  }

  return {
    status,
    setPausado,
    setModo,
    due,
    ensureDay,
    planejarHorarios: (d, o) => planejarHorarios(d || dayKey(now()), { rng, ...o }),
    ciclo,
    iniciarCiclo,
    andamento,
    ingestHtml,
    filtrarLista,
    prepararInscricao,
    aprovarInscricao,
    registrarRevisaoManual,
    podeAutomatico,
    modoInscricao,
    rateLeft,
    assertNuncaPostar,
    REVISOES_INICIAIS,
    MAX_POR_VARREDURA,
    FONTES_LI,
    ACOES_PROIBIDAS,
  };
}

module.exports = {
  createAgentVagas,
  planejarHorarios,
  parseLinkedinFeedHtml,
  parseLinkedinSavedHtml,
  parseLinkedinNotificationsHtml,
  assertNuncaPostar,
  dayKey,
  REVISOES_INICIAIS,
  MAX_POR_VARREDURA,
  FONTES_LI,
  ACOES_PROIBIDAS,
  POR_HORA_PADRAO,
};
