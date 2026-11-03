"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { cleanUserAgent, cookieMeta } = require("../src/vagas-cookies");

test("Q6: UA sem Electron/ e HELIOS/", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) helios/0.1.0 Chrome/140.0.0.0 Electron/44.9.3 Safari/537.36";
  const out = cleanUserAgent(ua);
  assert.ok(!/Electron|helios/i.test(out));
  assert.ok(/Chrome\/140/.test(out) && /Safari\/537\.36$/.test(out));
});

test("Q6: cookieMeta nunca expoe o valor", () => {
  const m = cookieMeta({ name: "tok", value: "SEGREDO", domain: ".gupy.io", path: "/", session: true, hostOnly: false });
  assert.strictEqual(JSON.stringify(m).includes("SEGREDO"), false);
  assert.strictEqual(m.expira, "sessao");
});

test("Q6: rotas /api/app/sair e /api/vagas/diagnostico existem no servidor", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "server", "index.js"), "utf8");
  assert.ok(src.includes('"/api/app/sair"') && src.includes('"/api/vagas/diagnostico"'));
});
test("Q6: timer so faz flush (nao regrava cookie); conversao vem do evento changed com o valor novo", async () => {
  const { createCookieSaver } = require("../src/vagas-cookies");
  const sets = []; let listener = null;
  const ses = {
    cookies: {
      get: async () => [{ name: "tok", value: "V1", domain: ".gupy.io", path: "/", secure: true, session: true }],
      set: async (d) => sets.push(d.value),
      flushStore: async () => {},
      on: (ev, fn) => { if (ev === "changed") listener = fn; },
      removeListener: () => { listener = null; },
    },
  };
  const saver = createCookieSaver({ ses, getDomains: () => ["gupy.io"], intervalMs: 0 });
  await saver.flush();
  assert.deepStrictEqual(sets, []);
  assert.strictEqual(saver.watch(), true);
  listener({}, { name: "tok", value: "V2", domain: ".gupy.io", path: "/", secure: true, session: true }, "explicit", false);
  listener({}, { name: "tok", value: "V2", domain: ".gupy.io", path: "/", secure: true, session: true }, "explicit", true);
  listener({}, { name: "x", value: "y", domain: ".outro.com", path: "/", secure: true, session: true }, "explicit", false);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(sets, ["V2"]);
  saver.stop();
  assert.strictEqual(listener, null);
});

test("Q6: abrir-login nao recarrega o login se a janela ja esta no site", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "jobs-host.js"), "utf8");
  assert.ok(src.includes("if (!mesmoSite) w.loadURL(platform.loginUrl)"));
});