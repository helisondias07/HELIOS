"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { classifyTool } = require("../server/irreversible");
const { createAutonomy } = require("../server/autonomy");
const { boot, json, say, inbox, runRoutine } = require("./helpers-ideias");

const outboxFile = (app) => path.join(app.dataDir, "outbox.json");
const outboxCount = (app) => (fs.existsSync(outboxFile(app)) ? JSON.parse(fs.readFileSync(outboxFile(app), "utf8")).length : 0);
const liberaTudo = (app) => json(app, "/api/autonomy", { method: "POST", body: { modes: { enviar: "sozinho", apagar: "sozinho", publicar: "sozinho" } } });

test("bot rascunha, humano envia/apaga/publica: em rotina, com 'sozinho' liberado, tudo vira cartão e nada é executado", async () => {
  const app = await boot();
  try {
    await liberaTudo(app);
    const casos = [
      ["R1", "enviar o resumo para o time", "enviar"],
      ["R2", "apagar o rascunho antigo", "apagar"],
      ["R3", "publicar o post de hoje", "publicar"],
      ["R4", "pagar a conta de luz", "pagar"],
    ];
    for (const [title, prompt, tipo] of casos) {
      const out = await runRoutine(app, title, prompt);
      assert.equal(out.status, "pendente", `${tipo} da rotina fica pendente`);
      assert.equal(out.cartao.tipo, tipo);
    }
    const box = await inbox(app);
    assert.equal(box.count, 4);
    assert.ok(box.items.every((item) => item.origin === "rotina" && item.expiresAt));
    assert.equal(outboxCount(app), 0, "nenhuma mensagem saiu");
  } finally {
    await app.close();
  }
});

test("bot rascunha, humano envia/apaga/publica: o mesmo vale para ajudantes (e preencher login continua pedindo)", async () => {
  const app = await boot();
  try {
    await liberaTudo(app);
    for (const pedido of ["enviar o relatório", "apagar o rascunho", "publicar o texto", "pagar a fatura"]) {
      await say(app, `crie um ajudante para ${pedido}`);
    }
    const box = await inbox(app);
    assert.equal(box.count, 4);
    assert.deepEqual(box.items.map((item) => item.tipo).sort(), ["apagar", "enviar", "pagar", "publicar"]);
    assert.ok(box.items.every((item) => item.origin === "ajudante"));
    assert.equal(outboxCount(app), 0);
    await say(app, "crie um ajudante para preencher login GitHub");
    assert.equal((await inbox(app)).items.filter((item) => item.tipo === "preencher").length, 1);
  } finally {
    await app.close();
  }
});

test("conversa ativa continua respeitando o 'sozinho' que o Helison liberou; desligar a trava em Autonomia vale para rotinas", async () => {
  const app = await boot();
  try {
    await liberaTudo(app);
    const conv = await say(app, "enviar o resumo para o time");
    assert.equal(conv.messages.filter((message) => message.role === "approval" && message.state === "pending").length, 0);
    assert.equal(outboxCount(app), 1, "na conversa ativa, 'sozinho' liberado roda direto (como antes)");

    const view = (await json(app, "/api/autonomy")).body;
    assert.equal(view.automaticoPede, true, "padrão: rotina e ajudante sempre pedem");
    assert.deepEqual(view.automaticoTipos, ["enviar", "apagar", "publicar"]);
    assert.equal((await json(app, "/api/autonomy", { method: "POST", body: { automaticoPede: "talvez" } })).status, 400);
    assert.equal((await json(app, "/api/autonomy", { method: "POST", body: { automaticoPede: false } })).body.automaticoPede, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app.dataDir, "autonomy.json"), "utf8")).automaticoPede, false, "a escolha fica em disco");

    const livre = await runRoutine(app, "Livre", "enviar o resumo para o time");
    assert.equal(livre.status, "ok", "com a trava desligada, a rotina segue o 'sozinho'");
    assert.equal(outboxCount(app), 2);
    const paga = await runRoutine(app, "Paga", "pagar a conta de luz");
    assert.equal(paga.status, "pendente", "pagar nunca sai de 'pedir', nem sem a trava");
    assert.equal(outboxCount(app), 2);
  } finally {
    await app.close();
  }
});

test("a trava de rotinas só pode ficar ligada ou desligada: nunca libera pagar nem preencher login", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "helios-aut-"));
  const aut = createAutonomy(dir);
  aut.set({ modes: { enviar: "sozinho", apagar: "sozinho", publicar: "sozinho" } });
  assert.equal(aut.mode("enviar", {}, { automated: true }), "pedir");
  assert.equal(aut.mode("enviar", {}, { automated: false }), "sozinho");
  assert.equal(aut.mode("apagar", { apagar: "sozinho" }, { automated: true }), "pedir", "nem a escolha do assistente vence a trava");
  aut.set({ automaticoPede: false });
  assert.equal(aut.mode("enviar", {}, { automated: true }), "sozinho");
  assert.equal(aut.mode("pagar", { pagar: "sozinho" }, { automated: false }), "pedir");
  assert.equal(aut.mode("preencher", { preencher: "sozinho" }, { automated: true }), "pedir");
  assert.equal(createAutonomy(dir).view().automaticoPede, false, "reabrir lê do disco");
});

test("conectores: nomes de enviar, publicar, apagar e pagar sem as palavras óbvias agora pedem cartão", () => {
  assert.equal(classifyTool("chat_postMessage"), "publicar");
  assert.equal(classifyTool("post_comment"), "publicar");
  assert.equal(classifyTool("slack_send_dm"), "enviar");
  assert.equal(classifyTool("send_sms"), "enviar");
  assert.equal(classifyTool("follow_user"), "enviar");
  assert.equal(classifyTool("erase_data"), "apagar");
  assert.equal(classifyTool("truncate_table"), "apagar");
  assert.equal(classifyTool("donate_funds"), "pagar");
  assert.equal(classifyTool("withdraw_balance"), "pagar");
  assert.equal(classifyTool("browser_click"), "escrever");
  assert.equal(classifyTool("browser_type"), "escrever");
  for (const name of ["list_posts", "get_post", "search_messages", "read_thread", "echo"]) assert.equal(classifyTool(name), "ler", name);
});