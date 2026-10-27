"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { closeMeetingWindow } = require("../src/meeting-window");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");

function fakeWindow(extra = {}) {
  const calls = [];
  return {
    calls,
    webContents: { send: (...args) => calls.push(["send", ...args]), isDestroyed: () => false },
    setIgnoreMouseEvents: (...args) => calls.push(["ignore", ...args]),
    hide: () => calls.push(["hide"]),
    isDestroyed: () => false,
    ...extra,
  };
}

test("fechar o modo de reuni\u00e3o avisa a p\u00e1gina para parar a captura e esconde a janela", () => {
  const win = fakeWindow();
  assert.equal(closeMeetingWindow(win), true);
  assert.deepEqual(win.calls, [["send", "meeting:stop", { stop: true, clickThrough: false }], ["hide"]]);
});

test("fechar desliga o modo atravessar, sen\u00e3o a janela voltaria sem aceitar clique", () => {
  const win = fakeWindow({ _heliosClickThrough: true });
  closeMeetingWindow(win, { stop: false });
  assert.equal(win._heliosClickThrough, false);
  assert.deepEqual(win.calls[0], ["ignore", false]);
  assert.deepEqual(win.calls[1], ["send", "meeting:stop", { stop: false, clickThrough: false }]);
  assert.deepEqual(win.calls[2], ["hide"]);
});

test("fechar sem janela ou com janela destru\u00edda n\u00e3o quebra", () => {
  assert.equal(closeMeetingWindow(null), false);
  assert.equal(closeMeetingWindow(fakeWindow({ isDestroyed: () => true })), false);
  const win = fakeWindow({ webContents: { send: () => { throw new Error("n\u00e3o deveria enviar"); }, isDestroyed: () => true } });
  assert.equal(closeMeetingWindow(win), true);
  assert.deepEqual(win.calls, [["hide"]]);
});

test("a janela da reuni\u00e3o tem bot\u00e3o X vis\u00edvel, Esc e atalho global para fechar", () => {
  const html = read("renderer", "meeting", "index.html");
  const app = read("renderer", "meeting", "app.js");
  const preload = read("src", "preload-meeting.cjs");
  const main = read("src", "main.js");
  const host = read("src", "meeting-host.js");
  assert.match(html, /<button id="btnHide"[^>]*aria-label="Fechar"><svg/);
  assert.ok(html.indexOf('id="btnSettings"') < html.indexOf('id="btnHide"'));
  assert.ok(html.indexOf('id="btnHide"') - html.indexOf('id="btnSettings"') < 600);
  assert.match(html, /<button id="btnHide"[^>]*Ctrl\+Shift\+W/);
  assert.match(app, /\$\('btnHide'\)\.onclick = \(\) => \{ stopSession\(\); api\.hide\(\); \}/);
  assert.match(app, /e\.key !== 'Escape'/);
  assert.match(app, /if \(state\.recording\) return;/);
  assert.match(app, /api\.onMeetingStop/);
  assert.match(preload, /onMeetingStop/);
  assert.match(preload, /"win:hide"/);
  assert.match(main, /"CommandOrControl\+Shift\+W": "close"/);
  assert.match(main, /closeMeetingNow\(\);\s*\n\s*\}\);/);
  assert.match(host, /closeMeeting\(\)/);
  // continua sempre no topo, fora da barra e protegida da captura
  const win = read("src", "meeting-window.js");
  assert.match(win, /skipTaskbar: true/);
  assert.match(win, /alwaysOnTop: true/);
});
