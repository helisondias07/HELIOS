"use strict";
// LEVA H: modo reunião estilo Cluely (pílula + card, respostas curtas, Livecoding como chip, ajustes fora da janela).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const prompts = require("../src/meeting-prompts");
const mock = require("../src/meeting-mock");
const { meetingBrowserOptions } = require("../src/meeting-window");

const html = read("renderer/meeting/index.html");
const app = read("renderer/meeting/app.js");
const css = read("renderer/meeting/style.css");
const main = read("src/main.js");
const host = read("src/meeting-host.js");
const preload = read("src/preload-meeting.cjs");
const LINES = [{ who: "them", text: "What was the hardest performance problem you solved?" }];

test("leva H: pílula com PT|EN, ouvir, Encerrar mm:ss, menu e X; sem abas nem configurações na janela", () => {
  for (const id of ["pill", "btnLogo", "modePt", "modeEn", "btnStart", "btnEnd", "timer", "btnMenu", "btnHide", "card", "chipQ", "answer", "askInput", "shotBox", "transcript"]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const gone of ["tabChat", "tabTranscript", "tabLive", "settings", "groqKey", "meetingContext", "<details", "<kbd>Ctrl", "status-row", "Clique em"]) assert.equal(html.includes(gone), false, gone);
  assert.match(html, />PT<\/button><button id="modeEn"[^>]*>EN</);
});

test("leva H: chips por modo e Livecoding mantido como chip", () => {
  assert.match(html, /id="chipSay" class="chip only-pt"[^>]*>.*O que digo/);
  assert.match(html, /id="chipAsk" class="chip only-pt"/);
  for (const id of ["chipSug", "chipTr", "chipSayEn"]) assert.match(html, new RegExp(`id="${id}" class="chip only-en"`));
  assert.match(html, /id="chipLive" class="chip"[^>]*>.*Livecoding/);
  assert.match(css, /\.mode-pt \.only-en, \.mode-en \.only-pt \{ display: none !important; \}/);
  assert.match(app, /if \(state\.input === 'code'\) return liveCode\(t\)/);
  assert.match(preload, /code: \(lines, request, rid\)/);
  assert.match(preload, /liveNext/); assert.match(preload, /onLiveSession/);
});

test("leva H: sugestão em três falas, detectQuestion e livecoding só código", () => {
  const pt = prompts.suggest(LINES, { lang: "pt" });
  assert.match(pt[0].content, /específico ao contexto/);
  assert.match(pt[1].content, /Três respostas que o Helison pode falar/);
  assert.match(pt[1].content, /segunda resposta/);
  assert.doesNotMatch(pt[1].content, /EN: </);
  assert.match(prompts.suggest(LINES, { lang: "pt", more: true })[1].content, /mais elaborada/);
  assert.match(prompts.ask(LINES, "o que é CDN?")[1].content, /texto corrido/i);
  assert.doesNotMatch(prompts.ask(LINES, "o que é CDN?")[1].content, /bullet/);
  assert.equal(prompts.parseDetect("NONE"), "");
  assert.equal(prompts.parseDetect("Qual foi o maior problema de performance que você resolveu ontem?").split(" ").length, 8);
  assert.match(prompts.code([], "debounce em JS")[0].content, /SÓ com um bloco de código/);
  assert.equal(prompts.stripFences("```js\nconst a = 1;\n```"), "const a = 1;");
  assert.match(mock.mockChat(prompts.detectQuestion("Can you tell me about your experience building storefronts on Wake?")), /experiência/);
  assert.equal(mock.mockChat(prompts.detectQuestion("Great, thanks.")), "NONE");
  assert.doesNotMatch(mock.mockChat(prompts.code([], "debounce")), /```/);
});

test("leva H: suggest rápido (120 tokens), ask 300, detect e code no host", () => {
  assert.match(host, /"ai:suggest"[\s\S]{0,500}maxTokens: more \? 900 : 700/);
  assert.match(host, /search: !image, maxTokens: image \? 1400 : 300/);
  assert.match(host, /ipcMain\.handle\("ai:detect"/);
  assert.match(host, /ipcMain\.handle\("ai:code"/);
  assert.match(preload, /detect: \(text\) => ipcRenderer\.invoke\("ai:detect", text\)/);
});

test("leva H: Ctrl+Enter só com a reunião ativa; atalhos novos", () => {
  const table = main.slice(main.indexOf("const HOTKEYS"), main.indexOf("const SESSION_HOTKEYS"));
  assert.equal(table.includes("CommandOrControl+Enter"), false);
  for (const k of ["CommandOrControl+\\\\\\\\", "CommandOrControl+Shift+M", "CommandOrControl+Shift+Enter", "CommandOrControl+Shift+T"]) assert.ok(table.includes(k.replace(/\\\\\\\\/, "\\\\")), k);
  for (const gone of ["Shift+1\"", "Shift+2\"", "Shift+A\"", "Shift+W\""]) assert.equal(table.includes(gone), false, gone);
  assert.match(main, /const SESSION_HOTKEYS = \{ "CommandOrControl\+Enter": "assist" \}/);
  assert.match(main, /setSessionHotkeys\(false\);/);
  assert.match(app, /api\.setHotkeysActive\(true\)/);
  assert.match(app, /if \(n === 'assist'\) \{ if \(state\.recording\) assist\(\); \}/);
});

test("leva H: janela pequena, invisível no share e fora da tela nos testes", () => {
  const o = meetingBrowserOptions();
  assert.equal(o.height, 48); assert.ok(o.width <= 600 && o.minWidth === 480);
  assert.match(read("src/meeting-window.js"), /setContentProtection/);
  assert.match(main, /HELIOS_TEST_OFFSCREEN === "1";\r?\n\s+if \(offscreen\) meetingWindow\.setPosition\(-32000, -32000\)/);
});

test("leva H: preview do print com ✓/✕ e EN sem original por padrão", () => {
  assert.match(html, /id="btnShotSend"[^>]*aria-label="Enviar print"/);
  assert.match(app, /nada é enviado antes do ✓/);
  assert.match(css, /\.mode-en \.line\.them:not\(\.plain\) \.orig \{ display: none; \}/);
  assert.match(app, /const WHO = \{ me: 'Você', them: 'Outro' \}/);
});

test("leva H: ajustes da reunião ficam em Ajustes › Reunião e no helios_ajustes", () => {
  const index = read("renderer/index.html");
  assert.match(index, /data-set="reuniao"/);
  assert.match(read("renderer/layout.js"), /function paintMeeting\(\)/);
  assert.match(read("src/preload-main.cjs"), /meetingSettingsSet: \(patch\) => ipcRenderer\.invoke\("settings:set", patch\)/);
  const srv = read("server/index.js");
  assert.match(srv, /"reuniao_ajustes", "reuniao_ajustar"/);
  assert.match(read("server/bot.js"), /reuniao_ajustar \(preferencias/);
  assert.match(main, /meetingSettings: \{/);
});

test("leva H: cores só preto/branco com dourado de destaque", () => {
  const colors = [...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase());
  for (const c of colors) assert.ok(["#fafafa", "#a3a3a3", "#e0b44a", "#0a0a0a", "#525252", "#b8891f", "#f87171", /* leva J: kit */ "#f4eee2", "#9a968c", "#2a2a31", "#1c1c21", "#e8b23a", "#2a1d08", "#6b5d45", "#dcd1bc", "#efe7d6", "#86590f", "#9a6a14", "#e5574f"].includes(c), c);
});
