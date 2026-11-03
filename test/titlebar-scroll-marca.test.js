"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { mainBrowserOptions, titleBarOverlayFor, normalizeTheme, applyMainWindowTheme, TITLEBAR_HEIGHT } = require("../src/meeting-window");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("janela principal usa barra de título integrada com as cores do tema", () => {
  const dark = mainBrowserOptions();
  assert.equal(dark.titleBarStyle, "hidden");
  assert.equal(dark.frame, true);
  assert.deepEqual(dark.titleBarOverlay, { color: "#0B0B0D", symbolColor: "#F4EEE2", height: TITLEBAR_HEIGHT });
  assert.equal(dark.backgroundColor, "#0B0B0D");
  const light = mainBrowserOptions("light");
  assert.deepEqual(light.titleBarOverlay, { color: "#F7F3EA", symbolColor: "#2A1D08", height: TITLEBAR_HEIGHT });
  assert.equal(TITLEBAR_HEIGHT, 48);
});

test("tema desconhecido vindo do renderer cai no escuro", () => {
  for (const bad of [undefined, null, 7, "solar", "LIGHT", { x: 1 }]) assert.equal(normalizeTheme(bad), "dark");
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(titleBarOverlayFor("x").color, "#0B0B0D");
});

test("applyMainWindowTheme troca overlay e fundo, e ignora janela destruída", () => {
  const calls = [];
  const win = { isDestroyed: () => false, setTitleBarOverlay: (o) => calls.push(["overlay", o]), setBackgroundColor: (c) => calls.push(["bg", c]) };
  assert.equal(applyMainWindowTheme(win, "light"), true);
  assert.deepEqual(calls, [["overlay", { color: "#F7F3EA", symbolColor: "#2A1D08", height: 48 }], ["bg", "#F7F3EA"]]);
  assert.equal(applyMainWindowTheme({ isDestroyed: () => true }, "dark"), false);
  assert.equal(applyMainWindowTheme(null, "dark"), false);
});

test("o overlay espelha os tokens de cor do CSS (escuro e claro)", () => {
  const tokens = read("renderer", "tokens.css");
  assert.match(tokens, /--titlebar-bg: #0a0a0a; --titlebar-fg: #fafafa;/);
  assert.match(tokens, /--titlebar-bg: #fafafa; --titlebar-fg: #171717;/);
});

test("ponte e canal do tema: contextIsolation mantido, só 'light'/'dark' saem do preload", () => {
  const preload = read("src", "preload-main.cjs");
  assert.match(preload, /setTheme: \(theme\) => ipcRenderer\.send\("window:theme", theme === "light" \? "light" : "dark"\)/);
  const main = read("src", "main.js");
  assert.match(main, /ipcMain\.on\("window:theme"/);
  assert.match(main, /contextIsolation: true/);
  assert.doesNotMatch(main, /contextIsolation: false/);
  const html = read("renderer", "index.html");
  assert.match(html, /script-src 'self'/);
});

test("área arrastável no topo e botões fora dela; conteúdo reserva o espaço do overlay", () => {
  const css = read("renderer", "style.css");
  assert.match(css, /\.sb-top, main > header \{ -webkit-app-region: drag; \}/);
  assert.match(css, /-webkit-app-region: no-drag/);
  assert.match(css, /env\(titlebar-area-width/);
  assert.match(css, /main > header \{[^}]*max\(var\(--sp-8\), var\(--tb-right\)\)/);
});

test("uma barra de rolagem: documento sem rolagem e estilo único compartilhado", () => {
  const css = read("renderer", "style.css");
  assert.match(css, /html, body \{[^}]*overflow: hidden/);
  assert.match(css, /@import url\("scrollbar\.css"\)/);
  const bar = read("renderer", "scrollbar.css");
  assert.match(bar, /::-webkit-scrollbar-thumb:hover/);
  assert.match(bar, /::-webkit-scrollbar-track \{ background: transparent; \}/);
  assert.match(bar, /::-webkit-scrollbar-button \{ display: none;/);
  assert.doesNotMatch(read("renderer", "sidebar.css"), /scrollbar-width: thin/);
  assert.match(read("renderer", "meeting", "style.css"), /scrollbar\.css/);
  assert.doesNotMatch(read("renderer", "meeting", "style.css"), /::-webkit-scrollbar-thumb \{/);
  const tokens = read("renderer", "tokens.css");
  assert.match(tokens, /--scroll-thumb-hover: var\(--gold-400\)/);
  assert.match(tokens, /--scroll-thumb-hover: var\(--gold-700\)/);
});

test("wordmark: Cinzel local (OFL), trocável por --font-brand, sem rede", () => {
  const tokens = read("renderer", "tokens.css");
  assert.match(tokens, /--font-brand: "Cinzel"/);
  assert.match(tokens, /assets\/fonts\/cinzel-latin-wght-normal\.woff2/);
  assert.ok(fs.existsSync(path.join(root, "renderer", "assets", "fonts", "cinzel-latin-wght-normal.woff2")));
  const lic = read("renderer", "assets", "fonts", "LICENSE-Cinzel.txt");
  assert.match(lic, /SIL OPEN FONT LICENSE Version 1\.1/i);
  assert.match(read("renderer", "sidebar.css"), /\.sb-brand-name \{[^}]*font-family: var\(--font-brand\)[^}]*text-transform: uppercase/);
  assert.doesNotMatch(tokens, /fonts\.googleapis|https?:\/\/[^"')\s]*\.woff/);
});
