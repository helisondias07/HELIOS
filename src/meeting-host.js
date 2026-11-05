"use strict";

const fs = require("node:fs");
const wrapupLib = require("./meeting-wrapup");
const path = require("node:path");
const providers = require("./providers");
const prompts = require("./meeting-prompts");
const mctx = require("./meeting-context");
const { friendlyError } = require("./meeting-errors");
const mock_ = require("./meeting-mock");

function roteiroOffline(topic) {
  const tema = topic ? ` sobre ${topic}` : "";
  return [
    `Roteiro${tema}, para o Helison conduzir a conversa:`,
    "1. Qual é o objetivo desta conversa?",
    "2. O que já ficou decidido?",
    "3. O que está travando agora?",
    "4. Quem faz o próximo passo?",
    "5. Para quando?",
    "6. O que eu preciso te enviar depois?",
    "7. Tem alguma dúvida que eu não perguntei?",
  ].join("\n");
}

// Idioma enviado ao Whisper: aba em português = pt; aba em inglês = en para o áudio do PC; o microfone (Você) fica automático.
function transcribeLang(setting, who, mode) {
  if (mode === "pt") return "pt";
  if (who === "me") return "auto";
  if (mode === "en" && (!setting || setting === "auto")) return "en";
  return setting;
}

// Blocos de áudio minúsculos (menos de ~0,5 s a 32 kbps) não têm fala: nem vão para a nuvem
const MIN_AUDIO_BYTES = 2000;
const tooSmall = (audio) => !audio || audio.length < MIN_AUDIO_BYTES;

// Plano da tela na pergunta por voz. Sem Gemini e em demonstração não chama o capturador.
function voiceScreenPlan({ mockMode = false, hasGemini = false } = {}) {
  if (mockMode) return { capture: false, image: "mock", warn: "" };
  if (!hasGemini) return { capture: false, image: null, warn: "Sem a chave do Gemini, a pergunta por voz segue sem a tela." };
  return { capture: true, image: null, warn: "" };
}
// Com a escuta ativa o print fica na memória e é refeito. Mais novo que isto já serve a pergunta.
const LIVE_SHOT_MS = 4000;

// Cache curto (LRU) de traduções já feitas: não paga a IA de novo pela mesma frase
function makeCache(max = 300) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}
const cacheText = (text) => String(text || "").toLowerCase().replace(/\s+/g, " ").trim();

function registerMeeting({ getWin, closeMeeting, settings, vault, serverUrl, getApiToken, quit, mock = false }) {
  const { ipcMain, shell, desktopCapturer, screen } = require("electron");
  const cfg = () => ({ ...settings.publicView(), groq: vault.getKey("groq"), gemini: vault.getKey("gemini") });

  function personalPath() {
    return path.join(require("electron").app.getPath("documents"), "HELIOS", "contexto.md");
  }

  let personalInfo = { path: personalPath(), chars: 0, truncated: false };

  function loadPersonal() {
    const file = personalPath();
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(path.join(__dirname, "contexto.example.md"), file);
      }
      const text = fs.readFileSync(file, "utf8");
      prompts.setPersonal(text);
      personalInfo = { path: file, chars: text.length, truncated: text.length > prompts.PERSONAL_MAX };
    } catch (err) {
      personalInfo = { path: file, chars: 0, truncated: false, error: String(err.message || err) };
    }
    const win = getWin();
    if (win) win.webContents.send("personal", personalInfo);
    return personalInfo;
  }

  function watchPersonal() {
    let timer = null;
    try {
      fs.watch(path.dirname(personalPath()), (_event, name) => {
        if (name === "contexto.md") {
          clearTimeout(timer);
          timer = setTimeout(loadPersonal, 300);
        }
      });
    } catch {
      /* a pasta ainda não existe */
    }
  }

  // Glossário: arquivo editável em Documentos\HELIOS\glossario.md (recarrega quando o arquivo muda).
  const glossaryPath = () => path.join(require("electron").app.getPath("documents"), "HELIOS", "glossario.md");
  let glossary = { mtime: 0, text: "", entries: [], skipped: 0 };
  let glossaryCheckedAt = 0;
  function loadGlossary(force = false) {
    // checa o arquivo no máximo a cada 2 s (a tradução chama isto a cada lote)
    if (!force && glossary.mtime && Date.now() - glossaryCheckedAt < 2000) return glossary;
    glossaryCheckedAt = Date.now();
    const file = glossaryPath();
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(path.join(__dirname, "glossario.example.md"), file);
      }
      const stat = fs.statSync(file);
      if (stat.mtimeMs !== glossary.mtime) {
        const text = fs.readFileSync(file, "utf8");
        glossary = { mtime: stat.mtimeMs, text, ...mctx.parseGlossary(text) };
      }
    } catch (err) {
      glossary = { mtime: 0, text: "", entries: [], skipped: 0, error: String(err.message || err) };
    }
    return glossary;
  }

  // Bloco curto de contexto (reunião + glossário + falas anteriores) e tom, com teto de caracteres.
  // O bloco é refeito só quando algo muda (contexto, glossário, falas recentes ou configuração); senão reaproveita o último
  let extrasMemo = { key: "", value: null };
  function meetingExtras({ haystack = "", history = [] } = {}) {
    const current = settings.publicView();
    const past = current.translateHistory > 0 ? history.slice(-current.translateHistory) : [];
    const gloss = loadGlossary();
    const key = JSON.stringify([current.meetingContext, current.formality, current.translateContextChars, gloss.mtime, haystack, past]);
    if (extrasMemo.key === key) return extrasMemo.value;
    const value = {
      block: mctx.buildBlock({ meetingContext: current.meetingContext, entries: gloss.entries, haystack, history: past, maxChars: current.translateContextChars }),
      formality: mctx.formalityLine(current.formality),
    };
    extrasMemo = { key, value };
    return value;
  }
  const meetingText = (lines) => {
    const extras = meetingExtras({ haystack: (lines || []).slice(-8).map((line) => line.text).join(" ") });
    return [extras.formality, extras.block].filter(Boolean).join("\n");
  };

  // Tudo o que vai para a nuvem pelo modo reunião pode ser cancelado ao fechar a janela
  const inflight = new Set();
  const CANCELLED = () => Object.assign(new Error("Cancelado: a janela da reunião foi fechada."), { name: "CancelledError", cancelled: true });
  function track(run) {
    const ctl = new AbortController();
    inflight.add(ctl);
    return Promise.resolve().then(() => run(ctl.signal)).finally(() => inflight.delete(ctl));
  }
  function abortInflight() {
    const count = inflight.size;
    for (const ctl of inflight) ctl.abort(CANCELLED());
    inflight.clear();
    return count;
  }

  async function chat(messages, opts = {}) {
    if (mock) return chatInner(messages, opts, null);
    return track((signal) => chatInner(messages, opts, signal));
  }
  async function chatInner(messages, { fast = false, imageBase64 = null, maxTokens, onDelta = null, search = false } = {}, signal) {
    if (mock) {
      const text = mock_.mockChat(messages);
      if (onDelta) onDelta(text);
      return { text, provider: "demonstração" };
    }
    const current = cfg();
    const plan = [];
    if (imageBase64) {
      if (!current.gemini) throw new Error("A análise de tela usa o Gemini. Cole a chave no cofre do HELIOS.");
      plan.push({ p: "gemini" });
    } else {
      const groq = current.groq ? (fast ? [current.fastModel, current.llmModel] : [current.llmModel, current.fastModel]).map((model) => ({ p: "groq", m: model })) : [];
      const gem = current.gemini ? [{ p: "gemini" }] : [];
      plan.push(...(current.provider === "gemini" ? [...gem, ...groq] : [...groq, ...gem]));
    }
    if (!plan.length) throw new Error("Nenhuma chave de API no cofre. Abra o cadeado do HELIOS e cole a chave da Groq.");
    let lastErr;
    const firstLabel = plan[0].p === "groq" ? `Groq · ${String(plan[0].m).replace("openai/", "")}` : "Gemini";
    // Fase 8: se o primeiro falhar, o próximo assume e a janela mostra o aviso em português.
    const tag = (label) => (lastErr ? `${label} (reserva: ${firstLabel} ${lastErr.status === 429 ? "bateu o limite" : "falhou"})` : label);
    for (const step of plan) {
      try {
        if (step.p === "groq") {
          const text = await providers.groqChat({ key: current.groq, model: step.m, messages, maxTokens, onDelta, search, signal });
          return { text, provider: tag(`Groq · ${step.m.replace("openai/", "")}`) };
        }
        const text = await providers.geminiChat({ key: current.gemini, model: current.geminiModel, messages, imageBase64, search, signal });
        if (onDelta) onDelta(text);
        return { text, provider: tag("Gemini") };
      } catch (err) {
        lastErr = err;
        if (signal && signal.aborted) break; // janela fechada: não tenta outro modelo
      }
    }
    throw lastErr;
  }

  async function transcribe(audio, mime, who, mode) {
    if (mock) return mock_.mockTranscribe(audio);
    if (tooSmall(audio)) return { text: "", language: "", skipped: true }; // pouco áudio = sem fala: não gasta cota
    return track((signal) => transcribeInner(audio, mime, who, mode, signal));
  }
  async function transcribeInner(audio, mime, who, mode, signal) {
    const current = cfg();
    const order = (current.provider === "gemini" ? ["gemini", "groq"] : ["groq", "gemini"]).filter((name) => current[name]);
    if (!order.length) throw new Error("Nenhuma chave de API no cofre. Cole a chave da Groq para transcrever.");
    let lastErr;
    for (const name of order) {
      try {
        if (name === "groq") return await providers.groqTranscribe({ key: current.groq, model: current.sttModel, audio, mime, language: transcribeLang(current.meetingLang, who, mode), signal });
        return await providers.geminiTranscribe({ key: current.gemini, model: current.geminiModel, audio, mime, signal });
      } catch (err) {
        lastErr = err;
        if (signal && signal.aborted) break;
        if (lastErr && lastErr.status === 429 && order.length === 1) break; // sem outro provedor: avisa a janela logo
      }
    }
    throw lastErr;
  }

  // Print manual: guardado só aqui até o Helison confirmar na prévia; cancelar descarta.
  // A escuta guarda outro print, só na memória, e a pergunta por voz não mexe nesta prévia.
  let pendingShot = null;
  let liveShot = null;
  async function captureScreen() {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.min(1920, display.size.width * display.scaleFactor),
        height: Math.min(1080, display.size.height * display.scaleFactor),
      },
    });
    if (!sources.length) throw new Error("Não foi possível capturar a tela.");
    const thumb = sources[0].thumbnail;
    return { base64: thumb.toJPEG(75).toString("base64"), preview: thumb.resize({ width: 320 }).toDataURL() };
  }
  async function refreshLiveShot() {
    const plan = voiceScreenPlan({ mockMode: !!mock, hasGemini: !!cfg().gemini });
    if (!plan.capture) {
      liveShot = plan.image ? { base64: plan.image, at: Date.now() } : null;
      return { at: liveShot ? liveShot.at : 0, warn: plan.warn };
    }
    const shot = await captureScreen();
    liveShot = { base64: shot.base64, at: Date.now() };
    return { at: liveShot.at, warn: "" };
  }
  function clearLiveShot() {
    liveShot = null;
    return {};
  }

  const wrap = (fn) => async (_event, ...args) => {
    const started = Date.now();
    try {
      return { ok: true, ...(await fn(...args)), ms: Date.now() - started };
    } catch (err) {
      if (err && err.cancelled) return { ok: false, cancelled: true, error: err.message, ms: Date.now() - started };
      return { ok: false, error: friendlyError(err), rate: Number(err && err.status) === 429, ms: Date.now() - started };
    }
  };

  const stream = (rid) => (rid ? (text) => {
    const win = getWin();
    if (win) win.webContents.send("ai:delta", rid, text);
  } : null);

  function publicSettings() {
    const view = settings.publicView();
    const keys = vault.list().keys;
    if (mock) return { ...view, hasGroqKey: true, hasGeminiKey: true, mock: true };
    return { ...view, hasGroqKey: keys.hasGroqKey, hasGeminiKey: keys.hasGeminiKey };
  }

  ipcMain.handle("settings:get", () => publicSettings());
  ipcMain.handle("settings:set", async (_event, patch) => {
    const next = { ...(patch || {}) };
    if (typeof next.meetingContext === "string" && mctx.problem(next.meetingContext)) throw new Error(mctx.problem(next.meetingContext));
    let vaultError = "";
    if (next.groqKey) {
      const saved = await vault.setKey("groq", next.groqKey);
      if (saved && saved.blocked) vaultError = saved.error;
      delete next.groqKey;
    }
    if (next.geminiKey) {
      const saved = await vault.setKey("gemini", next.geminiKey);
      if (saved && saved.blocked) vaultError = saved.error;
      delete next.geminiKey;
    }
    settings.update(next);
    const win = getWin();
    if (win && patch && Object.prototype.hasOwnProperty.call(patch, "opacity")) {
      win.setOpacity(Math.min(1, Math.max(0.3, Number(patch.opacity) || 1)));
    }
    if (vaultError) throw new Error(vaultError);
    return publicSettings();
  });
  ipcMain.handle("settings:test", wrap(async () => {
    if (mock) return { result: { groq: "demonstração (nenhuma chamada real)" } };
    const current = cfg();
    const out = {};
    if (current.groq) {
      try {
        await providers.groqChat({ key: current.groq, model: current.fastModel, messages: [{ role: "user", content: "Responda só: ok" }], maxTokens: 20 });
        out.groq = "OK";
      } catch (err) {
        out.groq = err.message;
      }
    }
    if (current.gemini) {
      try {
        await providers.geminiChat({ key: current.gemini, model: current.geminiModel, messages: [{ role: "user", content: "Responda só: ok" }] });
        out.gemini = "OK";
      } catch (err) {
        out.gemini = err.message;
      }
    }
    return { result: out };
  }));
  ipcMain.handle("audio:transcribe", wrap(async (buf, mime, who, mode) => transcribe(Buffer.from(buf), mime, who, mode)));
  ipcMain.handle("ai:translate", wrap(async (text) => chat(prompts.translate(text), { fast: true, maxTokens: 400 })));
  // Traduções já feitas não voltam para a IA (mesma frase = mesma tradução)
  const trCache = makeCache(300);
  ipcMain.handle("ai:translateBatch", wrap(async (items, history, rid) => {
    const list = (Array.isArray(items) ? items : []).slice(0, 8).map((item) => ({ id: item.id, text: String((item && item.text) || "") }));
    const formality = settings.publicView().formality;
    const hits = [];
    const todo = [];
    for (const item of list) {
      const cached = trCache.get(`${formality}|${cacheText(item.text)}`);
      if (cached) hits.push({ id: item.id, pt: cached });
      else todo.push(item);
    }
    if (!todo.length) return { items: hits, provider: "cache", cached: hits.length };
    const past = Array.isArray(history) ? history.map((text) => String(text || "")) : [];
    const extras = meetingExtras({ haystack: todo.map((item) => item.text).join(" "), history: past });
    // com uma fala só, a tradução vai chegando na legenda enquanto a IA escreve
    const result = await chat(prompts.translateBatch(todo, extras), { fast: true, maxTokens: 120 * todo.length + 200, onDelta: todo.length === 1 ? stream(rid) : null });
    const parsed = prompts.parseBatch(result.text, todo);
    for (const it of parsed) {
      const source = todo.find((x) => x.id === it.id);
      if (source && it.pt && cacheText(it.pt) !== cacheText(source.text)) trCache.set(`${formality}|${cacheText(source.text)}`, it.pt);
    }
    return { items: [...hits, ...parsed], provider: result.provider, cached: hits.length };
  }));
  ipcMain.handle("rate:get", () => providers.getRate());
  // Leva H: 1 resposta curta (maxTokens 120, modelo rápido); "more" gera a versão elaborada sob demanda.
  ipcMain.handle("ai:suggest", wrap(async (lines, lang, rid, more) => chat(prompts.suggest(lines, { myContext: settings.get("myContext"), lang, more: !!more, meeting: meetingText(lines) }), { fast: true, maxTokens: more ? 200 : 120, onDelta: stream(rid) })));
  // Pergunta detectada na última fala do Outro(s): barata, alimenta o chip dinâmico (Tab responde).
  ipcMain.handle("ai:detect", wrap(async (text) => {
    const clean = String(text || "").trim();
    if (clean.length < 8) return { question: "" };
    const r = await chat(prompts.detectQuestion(clean), { fast: true, maxTokens: 30 });
    return { question: prompts.parseDetect(r.text), provider: r.provider };
  }));
  // Livecoding (Leva H): só o código, curto e direto.
  ipcMain.handle("ai:code", wrap(async (lines, request, rid) => {
    const clean = String(request || "").trim();
    if (!clean) throw new Error("Escreva o que precisa em código.");
    const r = await chat(prompts.code((lines || []).slice(-6), clean, { myContext: settings.get("myContext"), meeting: meetingText(lines) }), { maxTokens: 700, onDelta: stream(rid) });
    return { ...r, text: prompts.stripFences(r.text) };
  }));
  ipcMain.handle("ai:explain", wrap(async (lines, term, rid) => chat(prompts.explain(lines, { myContext: settings.get("myContext"), term, meeting: meetingText(lines) }), { maxTokens: 400, onDelta: stream(rid) })));
  // Fase 6: encerrar com resumo, pendências e rascunho de follow-up (só rascunho). Vira nota no Second Brain e dispara "reunião termina".
  async function localApi(method, pathname, body) {
    const res = await fetch(`${serverUrl()}${pathname}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${typeof getApiToken === "function" ? getApiToken() : ""}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  ipcMain.handle("meeting:wrapup", wrap(async (lines, rid) => {
    if (!Array.isArray(lines) || !lines.some((line) => line && String(line.text || "").trim())) throw new Error("Ainda não há transcrição para resumir.");
    const meetingContext = settings.get("meetingContext") || "";
    const result = mock
      ? { text: wrapupLib.mockWrapupText(), provider: "demonstração" }
      : await chat(wrapupLib.wrapupPrompt(lines, { meetingContext }), { maxTokens: 1400, onDelta: stream(rid) });
    const parsed = wrapupLib.parseWrapup(result.text);
    const note = wrapupLib.noteFromWrapup(parsed, { at: new Date(), meetingContext });
    let saved = "";
    try {
      const out = await localApi("POST", "/api/brain", note);
      saved = out.note ? out.note.title : "";
    } catch (err) {
      saved = "";
      result.warn = `Não salvei a nota: ${err.message}`;
    }
    for (const item of parsed.pendencias.slice(0, 8)) {
      try { await localApi("POST", "/api/memory", { text: `Pendência da ${note.title}: ${item}`, kind: "pendencia" }); } catch { /* item recusado (ex.: e-mail) fica só na nota */ }
    }
    try { await localApi("POST", "/api/routines/evento", { event: "reuniao_terminou", detail: saved ? `Nota: ${saved}` : "" }); } catch { /* opcional */ }
    const tail = saved ? `\n\nSalvo no Second Brain como "${saved}". O follow-up é só rascunho: nada foi enviado.` : `\n\n${result.warn || ""}`;
    return { text: `${result.text}${tail}`, provider: result.provider, note: saved, pendencias: parsed.pendencias.length };
  }));
  ipcMain.handle("ai:summary", wrap(async (lines, rid) => chat(prompts.summary(lines, { myContext: settings.get("myContext"), meeting: meetingText(lines) }), { maxTokens: 1200, onDelta: stream(rid) })));
  ipcMain.handle("screen:preview", wrap(async () => {
    if (mock) {
      pendingShot = { base64: "mock", preview: mock_.MOCK_PREVIEW };
      return { preview: pendingShot.preview };
    }
    if (!cfg().gemini) throw new Error("A análise de tela usa o Gemini. Cole a chave do Gemini em Configurações.");
    pendingShot = await captureScreen();
    return { preview: pendingShot.preview };
  }));
  ipcMain.handle("screen:cancel", () => {
    pendingShot = null;
    return { ok: true };
  });
  ipcMain.handle("screen:refresh", wrap(async () => refreshLiveShot()));
  ipcMain.handle("screen:liveStop", () => {
    clearLiveShot();
    return { ok: true };
  });
  const sayCache = makeCache(100);
  ipcMain.handle("ai:sayEn", wrap(async (text, rid) => {
    const said = String(text || "").trim();
    if (!said) throw new Error("Escreva o que você quer dizer, em português.");
    const key = cacheText(said);
    const cached = sayCache.get(key);
    if (cached) return { ...cached, provider: "cache" };
    const result = await chat(prompts.sayEn(said, { myContext: settings.get("myContext"), meeting: meetingText([{ text: said }]) }), { fast: true, maxTokens: 220, onDelta: stream(rid) });
    if (/^EN:/m.test(result.text)) sayCache.set(key, { text: result.text, provider: result.provider });
    return result;
  }));
  ipcMain.handle("net:warm", wrap(async () => {
    const key = mock ? "" : cfg().groq;
    if (key) await track((signal) => providers.groqWarm({ key, signal }));
    return {};
  }));
  ipcMain.handle("ai:research", wrap(async (lines, query, rid) => {
    const clean = String(query || "").trim().slice(0, 200);
    if (!clean) throw new Error("Pesquisa vazia.");
    return chat(prompts.research(lines, clean, { myContext: settings.get("myContext"), meeting: meetingText(lines) }), { maxTokens: 700, onDelta: stream(rid), search: true });
  }));
  ipcMain.handle("link:open", wrap(async (url) => {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Só abro links http ou https.");
    await shell.openExternal(parsed.toString());
    return {};
  }));
  ipcMain.handle("ai:ask", wrap(async (lines, question, withScreen, rid, screenMode) => {
    let image = null;
    let warn = "";
    if (withScreen) {
      if (screenMode === "voice") {
        const plan = voiceScreenPlan({ mockMode: !!mock, hasGemini: !!cfg().gemini });
        warn = plan.warn;
        if (plan.capture) {
          const fresh = liveShot && Date.now() - liveShot.at <= LIVE_SHOT_MS;
          if (!fresh) {
            try { await refreshLiveShot(); } catch { /* usa o último print, se ainda houver */ }
          }
          image = liveShot && liveShot.base64;
          if (!image) warn = "Não capturei a tela. Respondo só com o que você falou.";
        } else if (plan.image) image = plan.image;
      } else {
        const shot = pendingShot || await captureScreen();
        pendingShot = null;
        image = shot.base64;
      }
    }
    const result = await chat(prompts.ask(lines, question, { myContext: settings.get("myContext"), withScreen: !!image, meeting: meetingText(lines) }), { imageBase64: image, onDelta: stream(rid), search: !image, maxTokens: 300 });
    return warn ? { ...result, warn } : result;
  }));
  ipcMain.handle("ai:roteiro", wrap(async (lines, topic, rid) => {
    const current = cfg();
    if (!current.groq && !current.gemini) return { text: roteiroOffline(topic), provider: "local" };
    return chat(prompts.roteiro(lines, topic), { maxTokens: 700, onDelta: stream(rid) });
  }));

  const histDir = () => {
    const dir = path.join(require("electron").app.getPath("documents"), "HELIOS", "reunioes");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  ipcMain.handle("history:save", wrap(async (sessionId, text) => {
    const file = path.join(histDir(), `reuniao-${String(sessionId).replace(/[^0-9a-z-]/gi, "")}.md`);
    fs.writeFileSync(file, text, "utf8");
    return { file };
  }));
  ipcMain.handle("history:open", wrap(async () => {
    await shell.openPath(histDir());
    return {};
  }));

  ipcMain.on("win:height", (_event, height) => {
    const win = getWin();
    if (!win) return;
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    const next = Math.max(48, Math.min(Math.round(Number(height) || 48), workArea.height - 40));
    const bounds = win.getBounds();
    if (bounds.height !== next) win.setBounds({ ...bounds, height: next });
  });
  // Fechar a janela: encerra a captura (via página), desliga o modo atravessar e esconde.
  ipcMain.on("win:hide", () => {
    abortInflight();
    if (typeof closeMeeting === "function") {
      closeMeeting();
      return;
    }
    const win = getWin();
    if (win) win.hide();
  });
  ipcMain.on("win:quit", () => quit());
  ipcMain.on("win:focus", () => {
    const win = getWin();
    if (win) {
      win.show();
      win.focus();
    }
  });

  async function live(method, pathname, body) {
    const res = await fetch(`${serverUrl()}${pathname}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${typeof getApiToken === "function" ? getApiToken() : ""}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || "falha no livecoding" };
    return { ok: true, session: data.session };
  }
  ipcMain.handle("livecoding:start", (_event, description) => live("POST", "/api/livecoding", { description }));
  ipcMain.handle("livecoding:next", (_event, id) => live("POST", `/api/livecoding/${encodeURIComponent(id)}/next`, {}));
  ipcMain.handle("livecoding:prev", (_event, id) => live("POST", `/api/livecoding/${encodeURIComponent(id)}/anterior`, {}));

  ipcMain.handle("glossary:get", wrap(async () => {
    const g = loadGlossary(true);
    return { path: glossaryPath(), text: g.text, count: g.entries.length, skipped: g.skipped, error: g.error };
  }));
  ipcMain.handle("glossary:set", wrap(async (text) => {
    const file = glossaryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(text || "").slice(0, 20000), "utf8");
    glossary.mtime = 0;
    const g = loadGlossary(true);
    return { path: file, count: g.entries.length, skipped: g.skipped };
  }));
  ipcMain.handle("glossary:open", wrap(async () => {
    loadGlossary(true);
    await shell.openPath(glossaryPath());
    return {};
  }));
  // Pesquisa contextual: só monta a consulta; abrir no navegador é um segundo clique, e a URL é refeita aqui.
  ipcMain.handle("search:build", wrap(async (term, lastLine) => mctx.buildSearch({ term, lastLine, meetingContext: settings.get("meetingContext") })));
  ipcMain.handle("search:open", wrap(async (query) => {
    await shell.openExternal(mctx.searchUrl(query));
    return {};
  }));

  ipcMain.handle("personal:info", () => personalInfo);
  ipcMain.handle("personal:open", async () => {
    loadPersonal();
    await shell.openPath(personalPath());
    return personalInfo;
  });

  loadPersonal();
  loadGlossary();
  watchPersonal();
  return { loadPersonal, personalPath, abortInflight };
}

module.exports = { transcribeLang, registerMeeting, roteiroOffline, makeCache, tooSmall, MIN_AUDIO_BYTES, voiceScreenPlan, LIVE_SHOT_MS };
