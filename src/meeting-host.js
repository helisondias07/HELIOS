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
    `Pauta sugerida${tema} (não substitui o que vocês combinaram):`,
    "1. Qual é o objetivo desta conversa?",
    "2. O que já ficou decidido?",
    "3. O que está travando agora?",
    "4. Quem faz o próximo passo?",
    "5. Para quando? (só se alguém citar prazo)",
    "6. O que precisa ser enviado depois?",
    "7. Tem alguma dúvida em aberto?",
  ].join("\n");
}

function transcribeLang(setting, who, mode) {
  if (mode === "pt") return "pt";
  if (who === "me") return "auto";
  if (mode === "en" && (!setting || setting === "auto")) return "en";
  return setting;
}

const MIN_AUDIO_BYTES = 2000;
const tooSmall = (audio) => !audio || audio.length < MIN_AUDIO_BYTES;
const VISION_MODEL = "gemini-2.5-flash";
const LIVE_SHOT_MS = 4000;

function voiceScreenPlan({ mockMode = false, hasGemini = false, captureScreen = false } = {}) {
  if (!captureScreen) return { capture: false, image: null, warn: "Contexto de tela desligado para esta reunião." };
  if (mockMode) return { capture: false, image: "mock", warn: "" };
  if (!hasGemini) return { capture: false, image: null, warn: "Sem a chave do Gemini, a pergunta segue sem a tela." };
  return { capture: true, image: null, warn: "" };
}

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

function registerMeeting({ getWin, getMain, closeMeeting, settings, vault, meetings, quit, mock = false }) {
  const { ipcMain, shell, desktopCapturer, screen } = require("electron");
  const cfg = () => ({ ...settings.publicView(), groq: vault.getKey("groq"), gemini: vault.getKey("gemini") });

  function personalPath() {
    return path.join(require("electron").app.getPath("documents"), "HELIOS", "contexto.md");
  }

  let personalInfo = { path: personalPath(), chars: 0, truncated: false };
  let activeSessionId = "";

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
      /* pasta ainda não existe */
    }
  }

  const glossaryPath = () => path.join(require("electron").app.getPath("documents"), "HELIOS", "glossario.md");
  let glossary = { mtime: 0, text: "", entries: [], skipped: 0 };
  let glossaryCheckedAt = 0;
  function loadGlossary(force = false) {
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

  let extrasMemo = { key: "", value: null };
  function meetingExtras({ haystack = "", history = [] } = {}) {
    const current = settings.publicView();
    const past = current.translateHistory > 0 ? history.slice(-current.translateHistory) : [];
    const gloss = loadGlossary();
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    const ctx = [current.meetingContext, session && session.title, session && session.objective, session && session.agenda].filter(Boolean).join("\n");
    const key = JSON.stringify([ctx, current.formality, current.translateContextChars, gloss.mtime, haystack, past]);
    if (extrasMemo.key === key) return extrasMemo.value;
    const value = {
      block: mctx.buildBlock({ meetingContext: ctx, entries: gloss.entries, haystack, history: past, maxChars: current.translateContextChars }),
      formality: mctx.formalityLine(current.formality),
    };
    extrasMemo = { key, value };
    return value;
  }
  const meetingText = (lines) => {
    const extras = meetingExtras({ haystack: (lines || []).slice(-8).map((line) => line.text).join(" ") });
    return [extras.formality, extras.block].filter(Boolean).join("\n");
  };

  function sessionAllowsScreen() {
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    if (session) return Boolean(session.captureScreen);
    return Boolean(settings.get("captureScreen"));
  }

  const inflight = new Set();
  const CANCELLED = () => Object.assign(new Error("Cancelado: a sessão de reunião foi encerrada."), { name: "CancelledError", cancelled: true });
  function track(run) {
    const ctl = new AbortController();
    inflight.add(ctl);
    return Promise.resolve().then(() => run(ctl.signal)).finally(() => inflight.delete(ctl));
  }
  function abortInflight() {
    const count = inflight.size;
    for (const ctl of inflight) ctl.abort(CANCELLED());
    inflight.clear();
    pendingShot = null;
    liveShot = null;
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
      if (!current.gemini) throw new Error("A análise de tela usa o Gemini. Cole a chave em Ajustes.");
      const models = [VISION_MODEL, current.geminiModel].filter((name, i, all) => name && all.indexOf(name) === i);
      for (const name of models) plan.push({ p: "gemini", m: name });
    } else {
      const groq = current.groq ? (fast ? [current.fastModel, current.llmModel] : [current.llmModel, current.fastModel]).map((model) => ({ p: "groq", m: model })) : [];
      const gem = current.gemini ? [{ p: "gemini" }] : [];
      plan.push(...(current.provider === "gemini" ? [...gem, ...groq] : [...groq, ...gem]));
    }
    if (!plan.length) throw new Error("Nenhuma chave de API no cofre. Abra Ajustes e cole a chave da Groq.");
    let lastErr;
    const firstLabel = plan[0].p === "groq" ? `Groq · ${String(plan[0].m).replace("openai/", "")}` : "Gemini";
    const tag = (label) => (lastErr ? `${label} (reserva: ${firstLabel} ${lastErr.status === 429 ? "bateu o limite" : "falhou"})` : label);
    for (const step of plan) {
      try {
        if (step.p === "groq") {
          const text = await providers.groqChat({ key: current.groq, model: step.m, messages, maxTokens, onDelta, search, signal });
          return { text, provider: tag(`Groq · ${step.m.replace("openai/", "")}`) };
        }
        const text = await providers.geminiChat({
          key: current.gemini,
          model: step.m || current.geminiModel,
          messages,
          imageBase64,
          search,
          signal,
          maxTokens,
          temperature: imageBase64 ? 0.1 : undefined,
        });
        if (onDelta) onDelta(text);
        return { text, provider: tag("Gemini") };
      } catch (err) {
        lastErr = err;
        if (signal && signal.aborted) break;
      }
    }
    throw lastErr;
  }

  async function transcribe(audio, mime, who, mode) {
    if (mock) return mock_.mockTranscribe(audio);
    if (tooSmall(audio)) return { text: "", language: "", skipped: true };
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
        if (lastErr && lastErr.status === 429 && order.length === 1) break;
      }
    }
    throw lastErr;
  }

  let pendingShot = null;
  let liveShot = null;
  let captureTail = Promise.resolve();
  function enqueueCapture(fn) {
    const run = captureTail.then(fn, fn);
    captureTail = run.then(() => {}, () => {});
    return run;
  }
  function captureScreen() {
    return enqueueCapture(async () => {
      const display = screen.getPrimaryDisplay();
      const sources = await Promise.race([
        desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: {
            width: Math.min(1920, display.size.width * display.scaleFactor),
            height: Math.min(1440, display.size.height * display.scaleFactor),
          },
        }),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("A captura da tela demorou demais."), { name: "TimeoutError" })), 8000)),
      ]);
      if (!sources.length) throw new Error("Não foi possível capturar a tela.");
      const thumb = sources[0].thumbnail;
      return { base64: thumb.toJPEG(88).toString("base64"), preview: thumb.resize({ width: 320 }).toDataURL() };
    });
  }
  async function shotForSuggest() {
    if (!sessionAllowsScreen()) return null;
    if (mock || !cfg().gemini) return null;
    const fresh = liveShot && Date.now() - liveShot.at <= 12000;
    if (!fresh) {
      try { await refreshLiveShot(); } catch { /* segue sem print */ }
    }
    return liveShot && liveShot.base64 ? liveShot.base64 : null;
  }
  async function refreshLiveShot() {
    const plan = voiceScreenPlan({ mockMode: !!mock, hasGemini: !!cfg().gemini, captureScreen: sessionAllowsScreen() });
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
    pendingShot = null;
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
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    if (mock) return { ...view, hasGroqKey: true, hasGeminiKey: true, mock: true, session };
    return { ...view, hasGroqKey: keys.hasGroqKey, hasGeminiKey: keys.hasGeminiKey, session, vaultBlocked: vault.isBlocked(), vaultBlockedMessage: vault.blockedMessage() };
  }

  function notifyMain(channel, payload) {
    const main = typeof getMain === "function" ? getMain() : null;
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload);
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
    if (!current.groq && !current.gemini) return { result: { aviso: "Nenhuma chave no cofre." } };
    if (current.groq) {
      try {
        await providers.groqChat({ key: current.groq, model: current.fastModel, messages: [{ role: "user", content: "Responda só: ok" }], maxTokens: 20 });
        out.groq = "OK";
      } catch (err) {
        out.groq = friendlyError(err);
      }
    }
    if (current.gemini) {
      try {
        await providers.geminiChat({ key: current.gemini, model: current.geminiModel, messages: [{ role: "user", content: "Responda só: ok" }] });
        out.gemini = "OK";
      } catch (err) {
        out.gemini = friendlyError(err);
      }
    }
    return { result: out };
  }));
  ipcMain.handle("audio:transcribe", wrap(async (buf, mime, who, mode) => transcribe(Buffer.from(buf), mime, who, mode)));
  ipcMain.handle("ai:translate", wrap(async (text) => chat(prompts.translate(text), { fast: true, maxTokens: 400 })));
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
    const result = await chat(prompts.translateBatch(todo, extras), { fast: true, maxTokens: 120 * todo.length + 200, onDelta: todo.length === 1 ? stream(rid) : null });
    const parsed = prompts.parseBatch(result.text, todo);
    for (const it of parsed) {
      const source = todo.find((x) => x.id === it.id);
      if (source && it.pt && cacheText(it.pt) !== cacheText(source.text)) trCache.set(`${formality}|${cacheText(source.text)}`, it.pt);
    }
    return { items: [...hits, ...parsed], provider: result.provider, cached: hits.length };
  }));
  ipcMain.handle("rate:get", () => providers.getRate());
  ipcMain.handle("ai:suggest", wrap(async (lines, lang, rid, more) => {
    const image = await shotForSuggest();
    return chat(prompts.suggest(lines, { myContext: settings.get("myContext"), lang, more: !!more, meeting: meetingText(lines), withScreen: !!image }), { maxTokens: more ? 900 : 700, imageBase64: image, onDelta: stream(rid) });
  }));
  ipcMain.handle("ai:detect", wrap(async (text) => {
    const clean = String(text || "").trim();
    if (clean.length < 8) return { question: "" };
    const r = await chat(prompts.detectQuestion(clean), { fast: true, maxTokens: 30 });
    return { question: prompts.parseDetect(r.text), provider: r.provider };
  }));
  ipcMain.handle("ai:insights", wrap(async (lines, rid) => chat(prompts.insights(lines, { myContext: settings.get("myContext"), meeting: meetingText(lines) }), { maxTokens: 500, onDelta: stream(rid) })));
  ipcMain.handle("ai:followups", wrap(async (lines, rid) => chat(prompts.followups(lines, { myContext: settings.get("myContext"), meeting: meetingText(lines) }), { maxTokens: 400, onDelta: stream(rid) })));
  ipcMain.handle("ai:explain", wrap(async (lines, term, rid) => chat(prompts.explain(lines, { myContext: settings.get("myContext"), term, meeting: meetingText(lines) }), { maxTokens: 400, onDelta: stream(rid) })));
  ipcMain.handle("meeting:wrapup", wrap(async (lines, rid, durationMs) => {
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    const meetingContext = [settings.get("meetingContext"), session && session.objective, session && session.agenda].filter(Boolean).join("\n");
    if (!Array.isArray(lines) || !lines.some((line) => line && String(line.text || "").trim())) {
      const empty = { resumo: "Não há transcrição para resumir. Nada foi inventado.", decisoes: [], pendencias: [], proximosPassos: [], rascunho: "", edited: false };
      if (activeSessionId) meetings.end(activeSessionId, { lines: [], wrapup: empty, durationMs });
      notifyMain("meetings:changed", { id: activeSessionId });
      return { text: empty.resumo, provider: "local", wrapup: empty, note: "" };
    }
    const result = mock
      ? { text: wrapupLib.mockWrapupText(), provider: "demonstração" }
      : await chat(wrapupLib.wrapupPrompt(lines, { meetingContext, title: session && session.title, objective: session && session.objective, agenda: session && session.agenda }), { maxTokens: 1400, onDelta: stream(rid) });
    const parsed = wrapupLib.parseWrapup(result.text);
    if (activeSessionId) meetings.end(activeSessionId, { lines, wrapup: parsed, durationMs, warn: result.provider === "demonstração" ? "Fechamento de demonstração: não é uma reunião real." : "" });
    notifyMain("meetings:changed", { id: activeSessionId });
    return { text: result.text, provider: result.provider, wrapup: parsed };
  }));
  ipcMain.handle("ai:summary", wrap(async (lines, rid) => chat(prompts.summary(lines, { myContext: settings.get("myContext"), meeting: meetingText(lines) }), { maxTokens: 1200, onDelta: stream(rid) })));
  ipcMain.handle("screen:preview", wrap(async () => {
    if (!sessionAllowsScreen()) throw new Error("O contexto de tela desta reunião está desligado. Ligue-o na preparação, com um propósito explícito.");
    if (mock) {
      pendingShot = { base64: "mock", preview: mock_.MOCK_PREVIEW };
      return { preview: pendingShot.preview };
    }
    if (!cfg().gemini) throw new Error("A análise de tela usa o Gemini. Cole a chave em Ajustes.");
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
      const plan = voiceScreenPlan({ mockMode: !!mock, hasGemini: !!cfg().gemini, captureScreen: sessionAllowsScreen() });
      warn = plan.warn;
      if (screenMode === "voice") {
        if (plan.capture) {
          const fresh = liveShot && Date.now() - liveShot.at <= LIVE_SHOT_MS;
          if (!fresh) {
            try { await refreshLiveShot(); } catch { /* usa o último print */ }
          }
          image = liveShot && liveShot.base64;
          if (!image) warn = "Não capturei a tela. Respondo só com a transcrição e a pergunta.";
        } else if (plan.image) image = plan.image;
      } else if (plan.capture) {
        const shot = pendingShot || await captureScreen();
        pendingShot = null;
        image = shot.base64;
      } else if (plan.image) image = plan.image;
    }
    const result = await chat(prompts.ask(lines, question, { myContext: settings.get("myContext"), withScreen: !!image, meeting: meetingText(lines) }), { imageBase64: image, onDelta: stream(rid), maxTokens: image ? 900 : 500 });
    return warn ? { ...result, warn } : result;
  }));
  ipcMain.handle("ai:roteiro", wrap(async (lines, topic, rid) => {
    const current = cfg();
    if (!current.groq && !current.gemini) return { text: roteiroOffline(topic), provider: "local" };
    return chat(prompts.roteiro(lines, topic), { maxTokens: 700, onDelta: stream(rid) });
  }));

  ipcMain.handle("meetings:list", () => meetings.list());
  ipcMain.handle("meetings:get", (_event, id) => meetings.get(id));
  ipcMain.handle("meetings:create", (_event, input) => meetings.create(input || {}));
  ipcMain.handle("meetings:update", (_event, id, patch) => meetings.update(id, patch || {}));
  ipcMain.handle("meetings:delete", (_event, id) => meetings.remove(id));
  ipcMain.handle("meetings:active", () => (activeSessionId ? meetings.get(activeSessionId) : null));
  ipcMain.handle("meetings:use", (_event, id) => {
    activeSessionId = String(id || "");
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    const win = getWin();
    if (win) win.webContents.send("meeting:session", session);
    return session;
  });
  ipcMain.handle("meetings:start", (_event, id) => {
    const session = meetings.start(id);
    activeSessionId = session.id;
    settings.update({
      meetingContext: [session.title, session.objective, session.agenda].filter(Boolean).join("\n").slice(0, 800),
      captureMic: session.captureMic,
      captureSystem: session.captureSystem,
      captureScreen: session.captureScreen,
    });
    const win = getWin();
    if (win) win.webContents.send("meeting:session", session);
    return session;
  });
  ipcMain.handle("meetings:pause", (_event, id) => meetings.pause(id || activeSessionId));
  ipcMain.handle("meetings:resume", (_event, id) => meetings.resume(id || activeSessionId));
  ipcMain.handle("meetings:sync-lines", (_event, id, lines) => meetings.appendLines(id || activeSessionId, lines));

  ipcMain.on("win:height", (_event, height) => {
    const win = getWin();
    if (!win) return;
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    const next = Math.max(48, Math.min(Math.round(Number(height) || 48), workArea.height - 40));
    const bounds = win.getBounds();
    if (bounds.height !== next) win.setBounds({ ...bounds, height: next });
  });
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
  ipcMain.handle("personal:info", () => personalInfo);
  ipcMain.handle("personal:open", async () => {
    loadPersonal();
    await shell.openPath(personalPath());
    return personalInfo;
  });

  loadPersonal();
  loadGlossary();
  watchPersonal();
  return { loadPersonal, personalPath, abortInflight, setActiveSession: (id) => { activeSessionId = id || ""; } };
}

module.exports = { transcribeLang, registerMeeting, roteiroOffline, makeCache, tooSmall, MIN_AUDIO_BYTES, voiceScreenPlan, LIVE_SHOT_MS, VISION_MODEL };
