"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore, publicConv } = require("../server/store");

const R = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8");

test("hotfix t82: sem Pesquisa na sidebar, Novo agente, reuniao no rodape acima das Decisões", () => {
  const html = R("index.html");
  const layout = R("layout.js");
  assert.doesNotMatch(layout, /key: "@search"/);
  assert.match(html, /<span>Novo agente<\/span>/);
  assert.doesNotMatch(html, /lfMenuMeeting/);
  const foot = html.slice(html.indexOf('class="lf-foot"'));
  assert.ok(foot.indexOf('id="openMeeting"') > -1 && foot.indexOf('id="openMeeting"') < foot.indexOf('data-view="inbox"'));
  const header = html.slice(html.indexOf('<header class="lf-top"'), html.indexOf("</header>", html.indexOf('<header class="lf-top"')));
  assert.doesNotMatch(header, /openMeeting/);
  assert.match(layout, /data-lf-del/);
  assert.match(html, /id="lfToastUndo"/);
});

test("hotfix t82: estado vazio usa a logo do HELIOS, sem o sol", () => {
  const app = R("app.js");
  assert.match(app, /lf-hello-logo"[^>]*><span class="hx-mark hx-96">/);
  assert.match(R("layout.css"), /\.lf-hello::before \{ content: none/);
});

test("hotfix layout: area dos botoes da janela reservada e painel vira gaveta", () => {
  const css = R("layout.css");
  assert.match(css, /\.lf-right::before \{[^}]*height: var\(--lf-tb-h\)/);
  assert.match(css, /padding-right: calc\(var\(--lf-ctrl-w\) \+ 12px\)/);
  assert.match(css, /body\.lf-right-drawer \.lf-right/);
});

test("hotfix t82: apagar arquiva (nunca permanente) e desfazer restaura; status do agente", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-arq-"));
  const store = createStore(dir);
  const c = store.create("Nova conversa");
  assert.equal(publicConv(store.get(c.id)).status, "new");
  store.update(c.id, (x) => { x.messages.push({ id: "q1", role: "question", state: "pending", question: "?" }); });
  assert.equal(publicConv(store.get(c.id)).status, "waiting");
  store.update(c.id, (x) => { x.busy = true; });
  assert.equal(publicConv(store.get(c.id)).status, "working");
  store.update(c.id, (x) => { x.busy = false; x.messages = [{ id: "m", role: "user", text: "oi" }]; });
  assert.equal(publicConv(store.get(c.id)).status, "done");
  assert.equal(store.archive(c.id), true);
  assert.equal(store.get(c.id), null);
  const arc = JSON.parse(fs.readFileSync(store.archiveFile, "utf8"));
  assert.equal(arc.items[0].id, c.id);
  assert.ok(store.restore(c.id));
  assert.ok(store.get(c.id));
  assert.equal(JSON.parse(fs.readFileSync(store.archiveFile, "utf8")).items.length, 0);
});
