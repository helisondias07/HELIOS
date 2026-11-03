"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createCookieSaver, persistentDetails, platformDomains } = require("../src/vagas-cookies");
const { PLATFORMS } = require("../server/jobs");

test("Q5: dominios-base das plataformas (inclui .com.br)", () => {
  const d = platformDomains([{ url: "https://www.vagas.com.br/x" }, { url: "https://portal.gupy.io/" }]);
  assert.deepStrictEqual(d.sort(), ["gupy.io", "vagas.com.br"]);
  assert.ok(platformDomains(PLATFORMS).length > 0);
});

test("Q5: cookie de sessao da plataforma vira persistente; outros nao", () => {
  const now = 1_000_000_000_000;
  const det = persistentDetails({ name: "s", value: "v", domain: ".gupy.io", path: "/", secure: true, session: true, sameSite: "lax" }, ["gupy.io"], now);
  assert.strictEqual(det.url, "https://gupy.io/");
  assert.strictEqual(det.domain, ".gupy.io");
  assert.strictEqual(det.expirationDate, Math.floor(now / 1000) + 30 * 86400);
  assert.strictEqual(persistentDetails({ name: "a", domain: "evil.com", session: true }, ["gupy.io"]), null);
  assert.strictEqual(persistentDetails({ name: "a", domain: "gupy.io", session: false, expirationDate: 5 }, ["gupy.io"]), null);
});

test("Q5: flush converte, chama flushStore e flushStorageData; timer a cada 60 s", async () => {
  const calls = [];
  const ses = {
    cookies: {
      get: async () => [{ name: "s", value: "v", domain: "trampos.co", hostOnly: true, path: "/", secure: true, session: true }],
      set: async (d) => calls.push(["set", d.url, Boolean(d.domain)]),
      flushStore: async () => calls.push(["flushStore"]),
    },
    flushStorageData: () => calls.push(["flushStorageData"]),
  };
  let ms = 0;
  const saver = createCookieSaver({ ses, getDomains: () => ["trampos.co"], timers: { setInterval: (fn, t) => { ms = t; return 1; }, clearInterval: () => {} } });
  const r = await saver.flush({ final: true });
  assert.strictEqual(r.convertidos, 1);
  assert.deepStrictEqual(calls, [["set", "https://trampos.co/", false], ["flushStore"], ["flushStorageData"]]);
  saver.start();
  assert.strictEqual(ms, 60e3);
  saver.stop();
});

test("Q5: sem sessao (mock) o flush nao quebra", async () => {
  const r = await createCookieSaver({ ses: null }).flush();
  assert.strictEqual(r.ok, true);
});