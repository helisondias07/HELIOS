"use strict";

/**
 * LEVA R: provedor gratis compativel com OpenAI (NVIDIA NIM, Gemini AI Studio).
 * - Chave so do cofre (getKey("nvidia") / getKey("gemini")); nunca vai a log, prompt ou erro.
 * - Modelo escolhido por agente; Vagas e Pesquisa usam o gratis por padrao, Oasis e Portfolio ficam no Cursor.
 * - 429: espera (Retry-After, com teto), passa para o proximo modelo gratis e, por ultimo, cai no Cursor.
 * - Loop de agente com tool calling chamando as ferramentas do HELIOS.
 */

const PROVIDERS = {
  nvidia: { id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", keyName: "nvidia" },
  gemini: { id: "gemini", label: "Gemini (AI Studio)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyName: "gemini" },
};

/** IDs conferidos em GET https://integrate.api.nvidia.com/v1/models em 02/11/2026. Lista configuravel (opts.roleModels).
 * Leva R2: chefe/vagas usam ultra (super e kimi dao 404 nesta conta). Reservas na ordem abaixo; Gemini; Cursor por ultimo. */
const ROLE_MODELS = {
  chefe: ["nvidia/nemotron-3-ultra-550b-a55b"],
  vagas: ["nvidia/nemotron-3-ultra-550b-a55b"],
  pesquisa: ["nvidia/nemotron-3-ultra-550b-a55b"],
  dificil: ["nvidia/nemotron-3-ultra-550b-a55b"],
  extracao: ["nvidia/nemotron-3.5-lightning-30b-a3b", "deepseek-ai/deepseek-v4.1-flash"],
  visao: ["nvidia/nemotron-3.5-super-vl-120b-a12b"],
  embeddings: ["nvidia/nemotron-3.5-embed-1b"],
  reservas: [
    "minimaxai/minimax-m3.1-flash",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "z-ai/glm-5.3-flash",
    "deepseek-ai/deepseek-v4.1-flash",
    "moonshotai/kimi-k2.6",
  ],
};
const GEMINI_MODEL = "gemini-3.8-flash";
const nim = (model) => ({ provider: "nvidia", model });
const FREE_MODELS = [...new Set(Object.entries(ROLE_MODELS).filter(([k]) => k !== "embeddings").flatMap(([, v]) => v))].map(nim).concat([{ provider: "gemini", model: GEMINI_MODEL }]);

const AGENT_DEFAULTS = { chefe: "gratis", vagas: "gratis", pesquisa: "gratis", oasis: "cursor", portfolio: "cursor" };
const MAX_WAIT_MS = 20000;
const REQUEST_TIMEOUT_MS = 45000;

function agentKey(agent) {
  return String(agent || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

function providerFor(agent, overrides = {}) {
  const k = agentKey(agent);
  return overrides[k] || AGENT_DEFAULTS[k] || "cursor";
}

/** Ordem: modelos da funcao (ou "dificil"/"extracao"/"visao"), depois reservas, depois Gemini; o Cursor fica por ultimo no chat(). */
function chainFor(agent, { roleModels = ROLE_MODELS, role = null, modelOverrides = {} } = {}) {
  const k = role || agentKey(agent);
  const pick = modelOverrides[agentKey(agent)];
  const ids = [...(pick ? [pick] : []), ...(roleModels[k] || roleModels.vagas || []), ...(roleModels.reservas || [])];
  return [...new Set(ids)].map(nim).concat([{ provider: "gemini", model: GEMINI_MODEL }]);
}

function retryAfterMs(res) {
  const raw = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(MAX_WAIT_MS, n * 1000);
  return 2000;
}

function scrub(text, keys) {
  let out = String(text || "");
  for (const k of keys) if (k) out = out.split(k).join("[segredo]");
  return out.slice(0, 300);
}

function createFreeLlm({ getKey = () => "", fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), cursorFallback = null, overrides = {}, modelOverrides = {}, roleModels = ROLE_MODELS, log = () => {} } = {}) {
  const keyOf = (p) => { try { return String(getKey(PROVIDERS[p].keyName) || ""); } catch { return ""; } };

  function status() {
    return {
      agentes: Object.fromEntries(Object.keys(AGENT_DEFAULTS).map((a) => [a, providerFor(a, overrides)])),
      provedores: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, chave: keyOf(p.id) ? "salva" : "falta" })),
      funcoes: roleModels,
      modelos: FREE_MODELS.map((m) => ({ ...m, disponivel: Boolean(keyOf(m.provider)) })),
    };
  }

  async function callOnce(entry, body) {
    const key = keyOf(entry.provider);
    if (!key) return { skip: "sem chave" };
    const res = await fetchImpl(`${PROVIDERS[entry.provider].baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, model: entry.model }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((e) => ({ status: 0, ok: false, text: async () => String(e && e.name === "TimeoutError" ? "timeout" : (e && e.message) || e) }));
    if (res.status === 429) return { rate: true, wait: retryAfterMs(res) };
    if (!res.ok) {
      let t = ""; try { t = await res.text(); } catch { /* sem corpo */ }
      return { error: `HTTP ${res.status}: ${scrub(t, [key])}` };
    }
    const data = await res.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return { error: "resposta sem message" };
    return { message: msg, usage: data.usage || null };
  }

  /** Uma chamada de chat com a cadeia de reserva. Devolve { message, model, provider, tentativas }. */
  async function chat({ agent = "vagas", role = null, messages, tools = null, temperature = 0.2 } = {}) {
    const body = { messages, temperature };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }
    const tentativas = [];
    for (const entry of chainFor(agent, { roleModels, role, modelOverrides })) {
      let r = await callOnce(entry, body);
      if (r.rate) {
        tentativas.push({ model: entry.model, motivo: "429, esperando" });
        await sleep(r.wait);
        r = await callOnce(entry, body);
        if (r.rate) { tentativas.push({ model: entry.model, motivo: "429 de novo, proximo" }); continue; }
      }
      if (r.skip) { tentativas.push({ model: entry.model, motivo: r.skip }); continue; }
      if (r.error) { tentativas.push({ model: entry.model, motivo: r.error }); log(`free-llm ${entry.model}: ${r.error}`); continue; }
      return { message: r.message, usage: r.usage, model: entry.model, provider: entry.provider, tentativas };
    }
    if (typeof cursorFallback === "function") {
      tentativas.push({ model: "cursor", motivo: "ultimo recurso" });
      const text = await cursorFallback({ agent, messages });
      return { message: { role: "assistant", content: String(text || "") }, model: "cursor", provider: "cursor", tentativas };
    }
    const err = new Error("Nenhum modelo gratis respondeu e nao ha reserva no Cursor.");
    err.tentativas = tentativas;
    throw err;
  }

  /**
   * Loop de agente: tools = [{ name, description, parameters, handler(args) }].
   * Para quando o modelo responde sem tool_calls ou ao atingir maxSteps.
   */
  async function runAgent({ agent = "vagas", role = null, system = "", user = "", tools = [], maxSteps = 8, history = null, onEvent = null } = {}) {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const spec = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || { type: "object", properties: {} } } }));
    const messages = Array.isArray(history) ? history.map((item) => ({ ...item })) : [];
    if (!messages.length && system) messages.push({ role: "system", content: system });
    if (user) messages.push({ role: "user", content: user });
    const chamadas = [];
    let last = null;
    for (let step = 0; step < maxSteps; step++) {
      last = await chat({ agent, role, messages, tools: spec });
      const msg = last.message;
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      messages.push({ role: "assistant", content: msg.content || "", ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) return { text: String(msg.content || ""), model: last.model, provider: last.provider, chamadas, passos: step + 1, history: messages };
      for (const call of calls) {
        const name = call.function && call.function.name;
        let args = {};
        try { args = JSON.parse((call.function && call.function.arguments) || "{}"); } catch { args = {}; }
        const tool = byName.get(name);
        try { await onEvent?.({ type: "tool_call", status: "running", name, args }); } catch { /* observabilidade opcional */ }
        let out;
        try { out = tool ? await tool.handler(args) : `Ferramenta desconhecida: ${name}`; } catch (e) { out = `Erro: ${String(e && e.message || e).slice(0, 200)}`; }
        chamadas.push({ name, args });
        const content = typeof out === "string" ? out : JSON.stringify(out);
        messages.push({ role: "tool", tool_call_id: call.id, content });
        try { await onEvent?.({ type: "tool_call", status: "completed", name, args, result: content }); } catch { /* observabilidade opcional */ }
        // A ferramenta já abriu uma pendência humana. Não deixe o modelo
        // continuar chamando outras ferramentas na mesma rodada (por
        // exemplo, enviar candidatura depois de pedir aprovação).
        if (/^(PENDENTE|PERGUNTA\b|PRECISA DE VOC[EÊ]|Recusado:)/i.test(String(content).trim())) {
          return { text: String(content), model: last.model, provider: last.provider, chamadas, passos: step + 1, interrompido: true, history: messages };
        }
      }
    }
    return { text: String((last && last.message.content) || ""), model: last && last.model, provider: last && last.provider, chamadas, passos: maxSteps, limite: true, history: messages };
  }

  /** Embeddings (nemotron-3.5-embed-1b). Texto sem dado pessoal. */
  async function embed(input, { inputType = "query" } = {}) {
    const key = keyOf("nvidia");
    if (!key) throw new Error("Sem chave NVIDIA no cofre.");
    const res = await fetchImpl(`${PROVIDERS.nvidia.baseUrl}/embeddings`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: roleModels.embeddings[0], input, input_type: inputType }) });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
    const data = await res.json();
    return (data.data || []).map((d) => d.embedding);
  }

  /** Scorer para vagas-match: so a vaga e as skills (sem dados pessoais). */
  function vagasScorer({ skills = [] } = {}) {
    return async ({ job }) => {
      const vaga = { titulo: job.title || job.titulo || "", empresa: job.company || job.empresa || "", descricao: String(job.description || job.descricao || "").slice(0, 6000) };
      const r = await chat({ agent: "vagas", role: "extracao", messages: [
        { role: "system", content: "Voce avalia aderencia de vaga. Responda so JSON: {\"score\":0-100,\"motivos\":[\"...\"]}." },
        { role: "user", content: `Skills do candidato: ${skills.map((s) => (s && typeof s === "object" ? (s.nome || s.id || "") : String(s))).filter(Boolean).join(", ") || "(nao informadas)"}\nVaga: ${JSON.stringify(vaga)}` },
      ] });
      const m = String(r.message.content || "").match(/\{[\s\S]*\}/);
      if (!m) return null; const o = JSON.parse(m[0]); o.modelo = r.model || null; return o;
    };
  }

  return { status, chat, runAgent, embed, vagasScorer, providerFor: (a) => providerFor(a, overrides) };
}

module.exports = { PROVIDERS, ROLE_MODELS, GEMINI_MODEL, FREE_MODELS, AGENT_DEFAULTS, providerFor, chainFor, createFreeLlm };
