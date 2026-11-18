"use strict";

const fs = require("node:fs");
const path = require("node:path");
const wrapupLib = require("./meeting-wrapup");
const providers = require("./providers");
const prompts = require("./meeting-prompts");
const mctx = require("./meeting-context");
const rolling = require("./rolling-summary");
const { PLAYBOOKS, getPlaybook } = require("./playbooks");
const { friendlyError } = require("./meeting-errors");
const { redact } = require("../server/util");
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
  const chosen = mode && ["pt", "en", "auto"].includes(mode) ? mode : (setting || "auto");
  if (chosen === "pt") return "pt";
  if (who === "me") return "auto";
  if (chosen === "en") return "en";
  return "auto";
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

function slugify(text) {
  return String(text || "reuniao")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "reuniao";
}

function registerMeeting({ getWin, getMain, closeMeeting, settings, vault, meetings, quit, mock = false, electron = null }) {
  const el = electron || require("electron");
  const { ipcMain, shell, desktopCapturer, screen, dialog, clipboard, app } = el;
  const cfg = () => ({ ...settings.publicView(), groq: vault.getKey("groq"), gemini: vault.getKey("gemini") });

  function docsDir() {
    return app && typeof app.getPath === "function" ? app.getPath("documents") : path.join(require("node:os").tmpdir(), "helios-docs");
  }

  function personalPath() {
    return path.join(docsDir(), "HELIOS", "contexto.md");
  }

  let personalInfo = { path: personalPath(), chars: 0, truncated: false };
  let activeSessionId = "";
  let rollingBusy = false;
  const memRolling = { sessionId: "", summary: "", count: 0 };

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
    if (win && win.webContents && !win.isDestroyed?.()) win.webContents.send("personal", personalInfo);
    return personalInfo;
  }

  function watchPersonal() {
    let timer = null;
    try {
      const w = fs.watch(path.dirname(personalPath()), (_event, name) => {
        if (name === "contexto.md") {
          clearTimeout(timer);
          timer = setTimeout(loadPersonal, 300);
        }
      });
      if (w && typeof w.unref === "function") w.unref();
    } catch {
      /* pasta ainda não existe */
    }
  }

  const glossaryPath = () => path.join(docsDir(), "HELIOS", "glossario.md");
  let glossary = { mtime: 0, text: "", entries: [], skipped: 0, whisper: "" };
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
        const parsed = mctx.parseGlossary(text);
        glossary = { mtime: stat.mtimeMs, text, ...parsed, whisper: mctx.whisperPrompt(parsed.entries) };
      }
    } catch (err) {
      glossary = { mtime: 0, text: "", entries: [], skipped: 0, whisper: "", error: String(err.message || err) };
    }
    return glossary;
  }

  let extrasMemo = { key: "", value: null };
  function meetingExtras({ haystack = "", history = [] } = {}) {
    const current = settings.publicView();
    const past = current.translateHistory > 0 ? history.slice(-current.translateHistory) : [];
    const gloss = loadGlossary();
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    const pb = getPlaybook(session && session.playbook);
    const notesSnippet = session && session.notes ? `Notas ao vivo: ${redact(session.notes).slice(-900)}` : "";
    const ctx = [
      current.meetingContext,
      session && session.title,
      session && session.objective,
      session && session.agenda,
      pb && pb.liveHint,
      notesSnippet,
    ].filter(Boolean).join("\n");
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
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    const pb = getPlaybook(session && session.playbook);
    const extras = meetingExtras({ haystack: (lines || []).slice(-8).map((line) => line.text).join(" ") });
    const notesBlock = session && session.notes && String(session.notes).trim()
      ? `Notas humanas da sessão:\n${redact(String(session.notes).trim()).slice(-1200)}`
      : "";
    return [extras.formality, pb && pb.liveHint, extras.block, notesBlock].filter(Boolean).join("\n");
  };

  function getRollingState() {
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    if (session) {
      return { summary: session.rollingSummary || "", count: session.rollingCount || 0 };
    }
    if (memRolling.sessionId !== activeSessionId) {
      memRolling.sessionId = activeSessionId;
      memRolling.summary = "";
      memRolling.count = 0;
    }
    return { summary: memRolling.summary, count: memRolling.count };
  }

  function maybeRefreshRolling(lines) {
    if (rollingBusy || !Array.isArray(lines) || lines.length < 6) return;
    const rec = prompts.recent(lines);
    if (rec.length >= lines.length) return;
    const st = getRollingState();
    const sid = activeSessionId;
    rollingBusy = true;
    rolling.advanceRollingState({
      lines,
      recentCount: rec.length,
      savedSummary: st.summary,
      summarizedCount: st.count,
      chatFn: (msgs, opts) => chat(msgs, opts),
    }).then((res) => {
      if (!res || !res.updated) return;
      if (sid && meetings.get(sid)) {
        meetings.update(sid, { rollingSummary: res.summary, rollingCount: res.count });
      } else {
        memRolling.sessionId = sid;
        memRolling.summary = res.summary;
        memRolling.count = res.count;
      }
    }).catch(() => { /* fallback determinístico permanece ativo */ })
      .finally(() => { rollingBusy = false; });
  }

  function rollingFor(lines) {
    const list = Array.isArray(lines) ? lines : [];
    const rec = prompts.recent(list);
    const st = getRollingState();
    maybeRefreshRolling(list);
    return rolling.effectiveRollingSummary({
      lines: list,
      recentLines: rec,
      savedSummary: st.summary,
      summarizedCount: st.count,
    });
  }

  function sessionAllowsScreen() {
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    if (session) return Boolean(session.captureScreen || session.mode === "livecoding");
    return Boolean(settings.get("captureScreen") || settings.get("meetingMode") === "livecoding");
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
  async function chatInner(messages, { fast = false, imageBase64 = null, maxTokens, onDelta = null, search = false, temperature } = {}, signal) {
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
      const gem = current.gemini ? [{ p: "gemini", m: search ? VISION_MODEL : current.geminiModel }] : [];
      plan.push(...(current.provider === "gemini" ? [...gem, ...groq] : [...groq, ...gem]));
    }
    if (!plan.length) throw new Error("Nenhuma chave de API no cofre. Abra Ajustes e cole a chave da Groq.");
    let lastErr;
    const firstLabel = plan[0].p === "groq" ? `Groq · ${String(plan[0].m).replace("openai/", "")}` : "Gemini";
    const tag = (label) => (lastErr ? `${label} (reserva: ${firstLabel} ${lastErr.status === 429 ? "bateu o limite" : "falhou"})` : label);
    for (const step of plan) {
      try {
        if (step.p === "groq") {
          const text = await providers.groqChat({ key: current.groq, model: step.m, messages, maxTokens, temperature, onDelta, search, signal });
          return { text, provider: tag(`Groq · ${step.m.replace("openai/", "")}`) };
        }
        const text = await providers.geminiChat({
          key: current.gemini,
          model: step.m || current.geminiModel,
          messages,
          imageBase64,
          search,
          onDelta,
          signal,
          maxTokens,
          temperature: temperature != null ? temperature : (imageBase64 ? 0.15 : undefined),
        });
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
    const gloss = loadGlossary();
    let lastErr;
    for (const name of order) {
      try {
        if (name === "groq") {
          return await providers.groqTranscribe({
            key: current.groq,
            model: current.sttModel,
            audio,
            mime,
            language: transcribeLang(current.meetingLang, who, mode),
            prompt: gloss.whisper,
            timeoutMs: 12000,
            signal,
          });
        }
        return await providers.geminiTranscribe({ key: current.gemini, model: current.geminiModel, audio, mime, timeoutMs: 12000, signal });
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
  function preferredSourceId() {
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    return (session && session.screenSourceId) || settings.get("screenSourceId") || "";
  }
  function captureScreen({ codeMode = false } = {}) {
    return enqueueCapture(async () => {
      const targetId = preferredSourceId();
      const wantWindow = targetId.startsWith("window:");
      const maxW = codeMode ? 1440 : 1280;
      const maxH = codeMode ? 900 : 800;
      const quality = codeMode ? 82 : 76;
      const display = screen.getPrimaryDisplay();
      const sources = await Promise.race([
        desktopCapturer.getSources({
          types: wantWindow ? ["window", "screen"] : ["screen", "window"],
          thumbnailSize: {
            width: Math.min(maxW, Math.round(display.size.width * (display.scaleFactor || 1))),
            height: Math.min(maxH, Math.round(display.size.height * (display.scaleFactor || 1))),
          },
        }),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("A captura da tela demorou demais."), { name: "TimeoutError" })), 8000)),
      ]);
      const usable = sources.filter((s) => !/^HELIOS/i.test(s.name));
      const pool = usable.length ? usable : sources;
      if (!pool.length) throw new Error("Não foi possível capturar a tela.");
      const chosen = (targetId && pool.find((s) => s.id === targetId)) || pool.find((s) => s.id.startsWith("screen:")) || pool[0];
      const thumb = chosen.thumbnail;
      return {
        base64: thumb.toJPEG(quality).toString("base64"),
        preview: thumb.resize({ width: 320 }).toDataURL(),
        sourceName: chosen.name,
      };
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
    if (win && win.webContents && !win.isDestroyed?.()) win.webContents.send("ai:delta", rid, text);
  } : null);

  function publicSettings() {
    const view = settings.publicView();
    const keys = vault.list().keys;
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    const common = {
      ...view,
      session,
      protected: process.env.HELIOS_NO_PROTECT !== "1",
      playbooks: PLAYBOOKS.map(({ id, label, defaultLang, objectivePlaceholder, agendaTemplate }) => ({ id, label, defaultLang, objectivePlaceholder, agendaTemplate })),
    };
    if (mock) return { ...common, hasGroqKey: true, hasGeminiKey: true, mock: true };
    return { ...common, hasGroqKey: keys.hasGroqKey, hasGeminiKey: keys.hasGeminiKey, vaultBlocked: vault.isBlocked(), vaultBlockedMessage: vault.blockedMessage() };
  }

  function notifyMain(channel, payload) {
    const main = typeof getMain === "function" ? getMain() : null;
    if (main && !main.isDestroyed?.()) main.webContents.send(channel, payload);
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
    if (activeSessionId && meetings.get(activeSessionId)) {
      const sessionPatch = {};
      if (typeof next.meetingMode === "string") sessionPatch.mode = next.meetingMode;
      if (typeof next.captureMic === "boolean") sessionPatch.captureMic = next.captureMic;
      if (typeof next.captureScreen === "boolean") sessionPatch.captureScreen = next.captureScreen;
      if (typeof next.micDeviceId === "string") sessionPatch.micDeviceId = next.micDeviceId;
      if (typeof next.screenSourceId === "string") sessionPatch.screenSourceId = next.screenSourceId;
      if (Object.keys(sessionPatch).length) {
        const updated = meetings.update(activeSessionId, sessionPatch);
        const win = getWin();
        if (win && win.webContents && !win.isDestroyed?.()) win.webContents.send("meeting:session", updated);
        notifyMain("meetings:changed", { id: activeSessionId });
      }
    }
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
    return chat(
      prompts.suggest(lines, {
        myContext: settings.get("myContext"),
        lang,
        more: !!more,
        meeting: meetingText(lines),
        rollingSummary: rollingFor(lines),
        withScreen: !!image,
      }),
      { fast: !more && !image, maxTokens: more ? 900 : 550, imageBase64: image, onDelta: stream(rid) }
    );
  }));

  ipcMain.handle("ai:research", wrap(async (lines, topic, rid) => {
    return chat(
      prompts.researchTopic(lines, topic, {
        myContext: settings.get("myContext"),
        meeting: meetingText(lines),
        rollingSummary: rollingFor(lines),
      }),
      { fast: true, search: true, maxTokens: 450, onDelta: stream(rid) }
    );
  }));

  ipcMain.handle("ai:livecode", wrap(async (lines, opts = {}, rid) => {
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    const useClip = opts.useClipboard !== false && settings.get("includeClipboard") !== false;
    let clipboardCode = "";
    if (useClip && clipboard && typeof clipboard.readText === "function") {
      try { clipboardCode = String(clipboard.readText() || "").slice(0, 6000); } catch { /* ignore */ }
    }
    let image = null;
    let warn = "";
    const wantScreen = opts.useScreen !== false && (sessionAllowsScreen() || (session && session.mode === "livecoding") || settings.get("meetingMode") === "livecoding");
    if (wantScreen) {
      if (mock) image = "mock";
      else if (cfg().gemini) {
        try {
          const shot = await captureScreen({ codeMode: true });
          image = shot.base64;
        } catch (err) {
          warn = `Não consegui capturar a tela (${friendlyError(err)}). Seguindo com áudio e clipboard.`;
        }
      } else {
        warn = "Sem chave Gemini para ler a tela da IDE — analisando áudio e área de transferência.";
      }
    }
    const lang = opts.lang || settings.get("meetingLang") || "auto";
    const result = await chat(
      prompts.liveCoding(lines, {
        myContext: settings.get("myContext"),
        meeting: meetingText(lines),
        rollingSummary: rollingFor(lines),
        clipboardCode,
        promptHint: opts.promptHint || "",
        lang,
        withScreen: !!image,
      }),
      { imageBase64: image, maxTokens: 2200, temperature: 0.15, onDelta: stream(rid) }
    );
    return warn ? { ...result, warn } : result;
  }));

  ipcMain.handle("ai:detect", wrap(async (text) => {
    const clean = String(text || "").trim();
    if (clean.length < 8) return { question: "" };
    const r = await chat(prompts.detectQuestion(clean), { fast: true, maxTokens: 30 });
    return { question: prompts.parseDetect(r.text), provider: r.provider };
  }));
  ipcMain.handle("ai:insights", wrap(async (lines, rid) => chat(prompts.insights(lines, { myContext: settings.get("myContext"), meeting: meetingText(lines), rollingSummary: rollingFor(lines) }), { maxTokens: 500, onDelta: stream(rid) })));
  ipcMain.handle("ai:followups", wrap(async (lines, rid) => chat(prompts.followups(lines, { myContext: settings.get("myContext"), meeting: meetingText(lines), rollingSummary: rollingFor(lines) }), { maxTokens: 400, onDelta: stream(rid) })));
  ipcMain.handle("ai:explain", wrap(async (lines, term, rid) => chat(prompts.explain(lines, { myContext: settings.get("myContext"), term, meeting: meetingText(lines), rollingSummary: rollingFor(lines) }), { maxTokens: 400, onDelta: stream(rid) })));

  ipcMain.handle("meeting:wrapup", wrap(async (lines, rid, durationMs) => {
    const sid = activeSessionId;
    const incoming = Array.isArray(lines) ? lines : [];
    // P0.1: Persistir lines + sessão encerrada em disco ANTES de chamar o LLM!
    if (sid && meetings.get(sid)) {
      meetings.end(sid, { lines: incoming, durationMs, warn: "" });
      notifyMain("meetings:changed", { id: sid });
    }
    const session = sid ? meetings.get(sid) : null;
    const allLines = session && Array.isArray(session.lines) && session.lines.length >= incoming.length ? session.lines : incoming;
    const hasSpeech = allLines.some((line) => line && String(line.text || "").trim());
    const hasNotes = Boolean(session && String(session.notes || "").trim());
    if (!hasSpeech && !hasNotes) {
      const empty = { resumo: "Não há transcrição nem notas para resumir. Nada foi inventado.", decisoes: [], pendencias: [], proximosPassos: [], rascunho: "", edited: false };
      if (sid && meetings.get(sid)) meetings.end(sid, { lines: [], wrapup: empty, durationMs, warn: "" });
      notifyMain("meetings:changed", { id: sid });
      return { text: empty.resumo, provider: "local", wrapup: empty, note: "" };
    }
    const meta = {
      meetingContext: [settings.get("meetingContext"), session && session.objective, session && session.agenda].filter(Boolean).join("\n"),
      title: session && session.title,
      objective: session && session.objective,
      agenda: session && session.agenda,
      notes: session && session.notes,
      playbook: session && session.playbook,
    };
    try {
      const result = await wrapupLib.generateWrapup(allLines, meta, (msgs, opts) => chat(msgs, opts), stream(rid), { mock });
      const parsed = wrapupLib.parseWrapup(result.text);
      const demoWarn = result.provider === "demonstração" ? "Fechamento de demonstração: não é uma reunião real." : "";
      if (sid && meetings.get(sid)) meetings.end(sid, { lines: allLines, wrapup: parsed, durationMs, warn: demoWarn });
      notifyMain("meetings:changed", { id: sid });
      return { text: result.text, provider: result.provider, wrapup: parsed };
    } catch (err) {
      if (sid && meetings.get(sid)) {
        meetings.update(sid, { warn: `Transcrição salva com segurança, mas a ata falhou (${friendlyError(err)}). Clique em "Regenerar ata".` });
        notifyMain("meetings:changed", { id: sid });
      }
      throw err;
    }
  }));

  ipcMain.handle("meetings:regenerate", wrap(async (id) => {
    const targetId = id || activeSessionId;
    const session = targetId ? meetings.get(targetId) : null;
    if (!session) throw new Error("Reunião não encontrada.");
    const hasSpeech = Array.isArray(session.lines) && session.lines.some((l) => l && String(l.text || "").trim());
    const hasNotes = Boolean(String(session.notes || "").trim());
    if (!hasSpeech && !hasNotes) throw new Error("Esta sessão não tem transcrição nem notas para gerar ata.");
    const meta = {
      meetingContext: [settings.get("meetingContext"), session.objective, session.agenda].filter(Boolean).join("\n"),
      title: session.title,
      objective: session.objective,
      agenda: session.agenda,
      notes: session.notes,
      playbook: session.playbook,
    };
    const result = await wrapupLib.generateWrapup(session.lines || [], meta, (msgs, opts) => chat(msgs, opts), null, { mock });
    const parsed = wrapupLib.parseWrapup(result.text);
    const updated = meetings.update(targetId, { wrapup: { ...parsed, edited: false }, warn: "" });
    notifyMain("meetings:changed", { id: targetId });
    return { meeting: meetings.get(targetId) || updated, provider: result.provider };
  }));

  ipcMain.handle("meetings:markdown", (_event, id) => {
    const session = meetings.get(id || activeSessionId);
    if (!session) throw new Error("Reunião não encontrada.");
    return { markdown: wrapupLib.formatMeetingMarkdown(session) };
  });

  ipcMain.handle("meetings:export-md", wrap(async (id) => {
    const session = meetings.get(id || activeSessionId);
    if (!session) throw new Error("Reunião não encontrada.");
    const md = wrapupLib.formatMeetingMarkdown(session);
    const dir = path.join(docsDir(), "HELIOS", "atas");
    fs.mkdirSync(dir, { recursive: true });
    const datePrefix = (session.startedAt || session.createdAt || new Date().toISOString()).slice(0, 10);
    const defaultPath = path.join(dir, `${datePrefix}-${slugify(session.title)}.md`);
    const main = typeof getMain === "function" ? getMain() : null;
    const picked = await dialog.showSaveDialog(main || undefined, {
      title: "Exportar ata em Markdown",
      defaultPath,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (picked.canceled || !picked.filePath) return { saved: false, filePath: "" };
    fs.writeFileSync(picked.filePath, md, "utf8");
    return { saved: true, filePath: picked.filePath };
  }));

  ipcMain.handle("ai:summary", wrap(async (lines, rid) => chat(prompts.summary(lines, { myContext: settings.get("myContext"), meeting: meetingText(lines), rollingSummary: rollingFor(lines) }), { maxTokens: 1200, onDelta: stream(rid) })));

  ipcMain.handle("screen:sources", wrap(async () => {
    if (mock) {
      return {
        sources: [
          { id: "screen:0:0", name: "Monitor 1 (Principal)", kind: "screen" },
          { id: "screen:1:0", name: "Monitor 2", kind: "screen" },
          { id: "window:100:0", name: "Visual Studio Code", kind: "window" },
        ],
      };
    }
    const raw = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 160, height: 90 },
    });
    const sources = raw
      .filter((s) => s && s.name && !/^HELIOS/i.test(s.name))
      .slice(0, 24)
      .map((s) => ({
        id: s.id,
        name: s.id.startsWith("screen:") ? `Tela: ${s.name}` : `Janela: ${s.name.slice(0, 60)}`,
        kind: s.id.startsWith("screen:") ? "screen" : "window",
      }));
    return { sources };
  }));

  ipcMain.handle("screen:preview", wrap(async () => {
    if (!sessionAllowsScreen()) throw new Error("O contexto de tela desta reunião está desligado. Ligue-o no menu ou na preparação.");
    if (mock) {
      pendingShot = { base64: "mock", preview: mock_.MOCK_PREVIEW };
      return { preview: pendingShot.preview };
    }
    if (!cfg().gemini) throw new Error("A análise de tela usa o Gemini. Cole a chave em Ajustes.");
    pendingShot = await captureScreen();
    return { preview: pendingShot.preview, sourceName: pendingShot.sourceName };
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
    const result = await chat(
      prompts.ask(lines, question, {
        myContext: settings.get("myContext"),
        withScreen: !!image,
        meeting: meetingText(lines),
        rollingSummary: rollingFor(lines),
      }),
      { imageBase64: image, onDelta: stream(rid), maxTokens: image ? 900 : 500 }
    );
    return warn ? { ...result, warn } : result;
  }));
  ipcMain.handle("ai:roteiro", wrap(async (lines, topic, rid) => {
    const current = cfg();
    if (!current.groq && !current.gemini) return { text: roteiroOffline(topic), provider: "local" };
    return chat(prompts.roteiro(lines, topic, { rollingSummary: rollingFor(lines) }), { maxTokens: 700, onDelta: stream(rid) });
  }));

  ipcMain.handle("meetings:list", () => meetings.list());
  ipcMain.handle("meetings:get", (_event, id) => meetings.get(id));
  ipcMain.handle("meetings:create", (_event, input) => meetings.create(input || {}));
  ipcMain.handle("meetings:update", (_event, id, patch) => {
    const targetId = id || activeSessionId;
    const updated = meetings.update(targetId, patch || {});
    if (targetId === activeSessionId) {
      const win = getWin();
      if (win && win.webContents && !win.isDestroyed?.()) win.webContents.send("meeting:session", meetings.get(targetId));
    }
    notifyMain("meetings:changed", { id: targetId });
    return updated;
  });
  ipcMain.handle("meetings:delete", (_event, id) => meetings.remove(id));
  ipcMain.handle("meetings:active", () => (activeSessionId ? meetings.get(activeSessionId) : null));
  ipcMain.handle("meetings:use", (_event, id) => {
    activeSessionId = String(id || "");
    const session = activeSessionId ? meetings.get(activeSessionId) : null;
    const win = getWin();
    if (win && win.webContents && !win.isDestroyed?.()) win.webContents.send("meeting:session", session);
    return session;
  });
  ipcMain.handle("meetings:start", (_event, id) => {
    const session = meetings.start(id);
    activeSessionId = session.id;
    const pb = getPlaybook(session.playbook);
    const patch = {
      meetingContext: [session.title, session.objective, session.agenda].filter(Boolean).join("\n").slice(0, 1200),
      meetingMode: session.mode,
      captureMic: session.captureMic,
      captureSystem: session.captureSystem,
      captureScreen: session.captureScreen,
      micDeviceId: session.micDeviceId || settings.get("micDeviceId"),
      screenSourceId: session.screenSourceId || settings.get("screenSourceId"),
    };
    if (pb && pb.id === "entrevista" && settings.get("meetingLang") === "pt") patch.meetingLang = "auto";
    settings.update(patch);
    const win = getWin();
    if (win && win.webContents && !win.isDestroyed?.()) win.webContents.send("meeting:session", meetings.get(session.id));
    return session;
  });
  ipcMain.handle("meetings:pause", (_event, id) => meetings.pause(id || activeSessionId));
  ipcMain.handle("meetings:resume", (_event, id) => meetings.resume(id || activeSessionId));
  ipcMain.handle("meetings:sync-lines", (_event, id, lines) => {
    const targetId = id || activeSessionId;
    if (!targetId || !meetings.get(targetId)) return null;
    const res = meetings.syncLines(targetId, lines);
    maybeRefreshRolling(meetings.get(targetId)?.lines || lines);
    return res;
  });

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
