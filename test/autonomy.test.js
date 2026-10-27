"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");
const { createAutonomy, resolveMode, cleanModes, TIPOS } = require("../server/autonomy");
const { classifyTool, normalizeTipo } = require("../server/irreversible");

const TOKEN = "token-de-teste-autonomia";

function fakeConnect() {
  const calls = [];
  const connect = async () => ({
    tools: [
      { name: "read_inbox", description: "Lê a caixa de entrada." },
      { name: "send_email", description: "Envia um e-mail." },
      { name: "pay_invoice", description: "Paga uma fatura." },
      { name: "write_file", description: "Grava um arquivo." },
    ],
    call: async (tool, args) => {
      calls.push({ tool, args });
      return { content: [{ type: "text", text: `ok:${tool}` }] };
    },
    close() {},
  });
  connect.calls = calls;
  return connect;
}

async function boot(extra = {}) {
  const dataDir = extra.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "helios-aut-"));
  const connect = fakeConnect();
  const app = await startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    connect,
    getMcpToken: () => TOKEN,
    searchWeb: async (query) => ({ query, results: [{ title: "Fonte teste", url: "https://exemplo.com/a", snippet: "trecho" }], error: "" }),
    getVaultIndex: () => [{ id: "login_1", tipo: "login", nome: "GitHub", senha: "super-secreta" }],
    onFillLogin: async () => ({ ok: true }),
    ...extra,
  });
  app.connect = connect;
  return app;
}

async function json(app, pathname, opts = {}) {
  const res = await fetch(`${app.url}${pathname}`, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function chat(app, text, convId) {
  const id = convId || (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation.id;
  await json(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text } });
  for (let i = 0; i < 80; i += 1) {
    const { body } = await json(app, `/api/conversations/${id}`);
    if (!body.conversation.busy) return body.conversation;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("a conversa não ficou pronta");
}

const cards = (conv) => conv.messages.filter((m) => m.role === "approval");
const pending = (conv) => cards(conv).filter((m) => m.state === "pending");

test("padrão: tudo pede antes, menos ler e pesquisar; pagar e preencher estão travados", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-aut-unit-"));
  const view = createAutonomy(dir).view();
  assert.equal(view.modes.length, 7);
  for (const row of view.modes) {
    assert.equal(row.mode, row.tipo === "ler" ? "sozinho" : "pedir", row.tipo);
  }
  assert.deepEqual(view.modes.filter((row) => row.locked).map((row) => row.tipo).sort(), ["pagar", "preencher"]);
  assert.deepEqual(TIPOS.map((t) => t.tipo).sort(), ["apagar", "enviar", "escrever", "ler", "pagar", "preencher", "publicar"]);
});

test("travados nunca viram sozinho: nem pela API, nem por arquivo editado, nem por camada de assistente", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-aut-lock-"));
  const aut = createAutonomy(dir);
  assert.throws(() => aut.set({ modes: { pagar: "sozinho" } }), /sempre pede/);
  assert.throws(() => aut.set({ modes: { preencher: "sozinho" } }), /sempre pede/);
  assert.throws(() => aut.set({ modes: { voar: "sozinho" } }), /desconhecido/);
  assert.throws(() => aut.set({ modes: { enviar: "talvez" } }), /pedir/);
  assert.throws(() => cleanModes({ pagar: "sozinho" }), /sempre pede/);
  // arquivo adulterado
  fs.writeFileSync(path.join(dir, "autonomy.json"), JSON.stringify({ version: 1, modes: { pagar: "sozinho", preencher: "sozinho", enviar: "sozinho", apagar: "lixo" } }));
  const tampered = createAutonomy(dir);
  assert.equal(tampered.mode("pagar"), "pedir");
  assert.equal(tampered.mode("preencher"), "pedir");
  assert.equal(tampered.mode("apagar"), "pedir");
  assert.equal(tampered.mode("pagar", { pagar: "sozinho" }), "pedir");
  assert.equal(resolveMode("preencher", { preencher: "sozinho" }), "pedir");
  assert.equal(resolveMode("inexistente", { inexistente: "sozinho" }), "pedir");
});

test("classifica ferramentas de conector por tipo", () => {
  assert.equal(classifyTool("read_inbox", "Lê a caixa"), "ler");
  assert.equal(classifyTool("send_email", ""), "enviar");
  assert.equal(classifyTool("pay_invoice", ""), "pagar");
  assert.equal(classifyTool("delete_event", ""), "apagar");
  assert.equal(classifyTool("publish_post", ""), "publicar");
  assert.equal(classifyTool("write_file", ""), "escrever");
  assert.equal(classifyTool("listar", "Envia nada"), "ler", "descrição sem palavra de ação ainda é leitura");
  assert.equal(classifyTool("fetch", "Faz send de algo"), "enviar", "descrição irreversível sem nome claro cai em enviar (como antes)");
  assert.equal(normalizeTipo("escrever"), "escrever");
  assert.equal(normalizeTipo("gravar"), "escrever");
  assert.equal(normalizeTipo("pesquisar"), "ler");
});

test("por padrão toda ação irreversível pede aprovação e nada é executado", async () => {
  const app = await boot();
  try {
    for (const [fala, tipo] of [
      ["enviar o resumo para o time", "enviar"],
      ["pagar a conta de luz", "pagar"],
      ["publicar o post de hoje", "publicar"],
      ["apagar o rascunho", "apagar"],
      ["preencher login GitHub", "preencher"],
      ["gravar arquivo notas/hoje.txt", "escrever"],
    ]) {
      const conv = await chat(app, fala);
      const open = pending(conv);
      assert.equal(open.length, 1, `${tipo}: um cartão pendente`);
      assert.equal(open[0].kind, tipo);
      assert.equal(cards(conv).some((m) => m.auto), false, `${tipo}: nada rodou sozinho`);
    }
    assert.equal(fs.existsSync(path.join(app.dataDir, "outbox.json")), false, "nada foi registrado para envio");
    assert.equal(fs.existsSync(path.join(app.projectsDir, "notas", "hoje.txt")), false, "nenhum arquivo gravado");
    const view = (await json(app, "/api/autonomy")).body;
    assert.equal(view.modes.find((m) => m.tipo === "enviar").mode, "pedir");
    assert.equal(view.modes.find((m) => m.tipo === "ler").mode, "sozinho");
  } finally {
    await app.close();
  }
});

test("a API de autonomia recusa sozinho em pagar e preencher login e não muda nada", async () => {
  const app = await boot();
  try {
    for (const tipo of ["pagar", "preencher"]) {
      const res = await json(app, "/api/autonomy", { method: "POST", body: { modes: { [tipo]: "sozinho" } } });
      assert.equal(res.status, 400, tipo);
    }
    const mixed = await json(app, "/api/autonomy", { method: "POST", body: { modes: { enviar: "sozinho", pagar: "sozinho" } } });
    assert.equal(mixed.status, 400);
    const view = (await json(app, "/api/autonomy")).body;
    assert.equal(view.modes.find((m) => m.tipo === "enviar").mode, "pedir", "pedido recusado por inteiro");
    assert.equal(view.modes.find((m) => m.tipo === "pagar").locked, true);
    const ok = await json(app, "/api/autonomy", { method: "POST", body: { modes: { enviar: "sozinho" } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.modes.find((m) => m.tipo === "enviar").mode, "sozinho");
    const disk = JSON.parse(fs.readFileSync(path.join(app.dataDir, "autonomy.json"), "utf8"));
    assert.deepEqual(disk.modes, { enviar: "sozinho" });
  } finally {
    await app.close();
  }
});

test("liberado em Autonomia, o tipo roda sozinho e deixa registro; pagar e preencher continuam pedindo", async () => {
  const app = await boot();
  try {
    await json(app, "/api/autonomy", { method: "POST", body: { modes: { enviar: "sozinho", escrever: "sozinho" } } });
    const sent = await chat(app, "enviar o resumo para o time");
    assert.equal(pending(sent).length, 0);
    const auto = cards(sent).find((m) => m.auto);
    assert.equal(auto.state, "done");
    assert.match(auto.result, /Feito sozinho/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app.dataDir, "outbox.json"), "utf8")).length, 1);

    const wrote = await chat(app, "gravar arquivo notas/hoje.txt");
    assert.equal(pending(wrote).length, 0);
    assert.match(fs.readFileSync(path.join(app.projectsDir, "notas", "hoje.txt"), "utf8"), /Gerado pelo HELIOS/);
    const escape = await chat(app, "gravar arquivo ../fora.txt");
    assert.equal(cards(escape).find((m) => m.auto).state, "error");
    assert.equal(fs.existsSync(path.join(app.dataDir, "fora.txt")), false);

    for (const fala of ["pagar a conta de luz", "preencher login GitHub", "apagar o rascunho", "publicar o post"]) {
      const conv = await chat(app, fala);
      assert.equal(pending(conv).length, 1, fala);
    }
  } finally {
    await app.close();
  }
});

test("arquivo de autonomia adulterado não libera pagar nem preencher login no servidor", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-aut-tamper-"));
  fs.writeFileSync(path.join(dataDir, "autonomy.json"), JSON.stringify({ version: 1, modes: { pagar: "sozinho", preencher: "sozinho", enviar: "sozinho" } }));
  const app = await boot({ dataDir });
  try {
    const pay = await chat(app, "pagar a conta de luz");
    assert.equal(pending(pay).length, 1);
    const fill = await chat(app, "preencher login GitHub");
    assert.equal(pending(fill).length, 1);
    assert.equal(JSON.stringify(fill).includes("super-secreta"), false);
    const view = (await json(app, "/api/autonomy")).body;
    assert.equal(view.modes.find((m) => m.tipo === "pagar").mode, "pedir");
    assert.equal(view.modes.find((m) => m.tipo === "enviar").mode, "sozinho", "o que é permitido continua valendo");
  } finally {
    await app.close();
  }
});

test("escrever arquivo: pede antes por padrão e grava só depois do ok", async () => {
  const app = await boot();
  try {
    const conv = await chat(app, "gravar arquivo notas/ideia.txt");
    const card = pending(conv)[0];
    const target = path.join(app.projectsDir, "notas", "ideia.txt");
    assert.equal(fs.existsSync(target), false);
    const done = await json(app, `/api/conversations/${conv.id}/approvals/${card.id}`, { method: "POST", body: { decision: "approve" } });
    assert.equal(done.body.conversation.messages.find((m) => m.id === card.id).state, "done");
    assert.equal(fs.existsSync(target), true);
  } finally {
    await app.close();
  }
});

test("ler e pesquisar: sozinho por padrão; em 'pedir' vira cartão e só pesquisa depois do ok", async () => {
  const app = await boot();
  try {
    const free = await chat(app, "pesquisar preço do dólar");
    assert.equal(pending(free).length, 0);
    assert.ok(free.messages.find((m) => m.role === "assistant").sources.length >= 1);

    await json(app, "/api/autonomy", { method: "POST", body: { modes: { ler: "pedir" } } });
    const ask = await chat(app, "pesquisar preço do dólar");
    const card = pending(ask)[0];
    assert.equal(card.kind, "ler");
    assert.equal(ask.messages.find((m) => m.role === "assistant").sources.length, 0);
    const done = await json(app, `/api/conversations/${ask.id}/approvals/${card.id}`, { method: "POST", body: { decision: "approve" } });
    const result = done.body.conversation.messages.find((m) => m.id === card.id).result;
    assert.match(result, /Fonte teste/);
  } finally {
    await app.close();
  }
});

test("chamadas de conector MCP seguem a autonomia do tipo da ferramenta", async () => {
  const app = await boot();
  try {
    const added = await json(app, "/api/mcp", { method: "POST", body: { name: "caixa", type: "http", url: "http://127.0.0.1:9/mcp" } });
    await json(app, `/api/mcp/${added.body.server.id}/test`, { method: "POST", body: {} });

    const read = await chat(app, "mcp caixa.read_inbox");
    assert.equal(pending(read).length, 0);
    assert.equal(app.connect.calls.length, 1, "leitura roda sozinha por padrão");

    const send = await chat(app, "mcp caixa.send_email");
    assert.equal(pending(send)[0].kind, "enviar");
    const pay = await chat(app, "mcp caixa.pay_invoice");
    assert.equal(pending(pay)[0].kind, "pagar");
    const write = await chat(app, "mcp caixa.write_file");
    assert.equal(pending(write)[0].kind, "escrever");
    assert.equal(app.connect.calls.length, 1, "nenhuma escrita/envio/pagamento rodou antes do cartão");

    await json(app, "/api/autonomy", { method: "POST", body: { modes: { enviar: "sozinho" } } });
    const sent = await chat(app, "mcp caixa.send_email");
    assert.equal(pending(sent).length, 0);
    assert.equal(cards(sent).find((m) => m.auto).state, "done");
    assert.equal(app.connect.calls.length, 2);
    const stillPay = await chat(app, "mcp caixa.pay_invoice");
    assert.equal(pending(stillPay).length, 1);
    assert.equal(app.connect.calls.length, 2, "pagar continua exigindo cartão");
  } finally {
    await app.close();
  }
});

test("o MCP local do HELIOS respeita a autonomia: pendente por padrão, direto quando liberado, pagar sempre pendente", async () => {
  const app = await boot();
  const rpcCall = async (name, args) => {
    const res = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return JSON.parse(JSON.parse(await res.text()).result.content[0].text);
  };
  try {
    const first = await rpcCall("helios_enviar_mensagem", { texto: "enviar o resumo para o time" });
    assert.equal(first.status, "pendente");
    assert.ok(first.cartao.id);
    assert.equal(fs.existsSync(path.join(app.dataDir, "outbox.json")), false);

    await json(app, "/api/autonomy", { method: "POST", body: { modes: { enviar: "sozinho" } } });
    const free = await rpcCall("helios_enviar_mensagem", { texto: "enviar o resumo para o time" });
    assert.equal(free.status, "ok");
    assert.equal(JSON.parse(fs.readFileSync(path.join(app.dataDir, "outbox.json"), "utf8")).length, 1);

    const pay = await rpcCall("helios_enviar_mensagem", { texto: "pagar a conta de luz" });
    assert.equal(pay.status, "pendente");
    assert.equal(pay.cartao.tipo, "pagar");
  } finally {
    await app.close();
  }
});
