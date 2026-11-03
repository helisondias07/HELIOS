"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, json } = require("./helpers-ideias");

test("levaT: rack do Chefe expõe operação pública sem segredos", async () => {
  const app = await boot();
  try {
    const out = await json(app, "/api/chefe/operacao");
    assert.equal(out.status, 200);
    assert.equal(out.body.maquina.id, "helios-local");
    assert.equal(out.body.maquina.status, "online");
    assert.ok(Array.isArray(out.body.agentes));
    assert.ok(Array.isArray(out.body.workers));
    assert.equal(typeof out.body.emExecucao, "number");
    assert.equal(typeof out.body.pendencias, "number");
    assert.equal(JSON.stringify(out.body).includes("senha-super-secreta"), false);
    assert.equal(JSON.stringify(out.body).includes(app.apiToken()), false);
  } finally {
    await app.close();
  }
});
