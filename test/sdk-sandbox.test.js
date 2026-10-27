"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");
const { createSandboxGate } = require("../server/sdk-sandbox");
const { isLocked } = require("../server/autonomy");

const SANDBOX_ERROR = "Local SDK sandboxing was requested, but sandboxing is not supported in this environment. Disable local.sandboxOptions.enabled or remove ~/.cursor/sandbox.json to run without sandboxing.";

function agentFactory(calls) {
  return {
    async create(opts) {
      calls.push(opts);
      if (opts.local.sandboxOptions.enabled) throw new Error(SANDBOX_ERROR);
      return { agentId: "agt_sem_sandbox", opts };
    },
  };
}

test("o fallback desliga o sandbox do SDK e mantém as travas do HELIOS", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-sandbox-"));
  const calls = [];
  const gate = createSandboxGate({ dataDir: dir, platform: "win32", log: () => {} });
  const sdk = agentFactory(calls);
  const opts = {
    name: "HELIOS",
    apiKey: "crsr_chave_falsa_de_teste_0001",
    local: { cwd: dir, settingSources: [], customTools: { helios_acao: {} } },
    tools: ["mcp"],
    disallowedTools: ["shell", "edit", "delete"],
  };
  const agent = await gate.run({ create: (next) => sdk.create(next), opts });
  assert.equal(agent.agentId, "agt_sem_sandbox");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].local.sandboxOptions.enabled, true);
  assert.equal(calls[1].local.sandboxOptions.enabled, false);
  assert.deepEqual(calls[1].tools, ["mcp"]);
  assert.deepEqual(calls[1].disallowedTools, ["shell", "edit", "delete"]);
  assert.equal(calls[1].local.customTools.helios_acao !== undefined, true);
  assert.equal(gate.status().available, false);
  assert.match(gate.status().notice, /neste Windows/);
  assert.match(gate.status().notice, /aprovações continuam valendo/);
  assert.match(gate.status().notice, /Pedir antes/);
  assert.equal(isLocked("pagar"), true);
  assert.equal(isLocked("preencher"), true);
  const log = fs.readFileSync(path.join(dir, "logs", "helios.log"), "utf8");
  assert.match(log, /isolamento do SDK não está disponível \(Windows\)/);
  assert.match(log, /sandboxing is not supported/);
  assert.equal(log.includes("crsr_chave_falsa"), false);
  const again = [];
  await gate.run({ create: (next) => { again.push(next.local.sandboxOptions.enabled); return { agentId: "agt_2" }; }, opts });
  assert.deepEqual(again, [false]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("outro erro do SDK não desliga o sandbox nem é engolido", async () => {
  const gate = createSandboxGate({ platform: "linux" });
  await assert.rejects(
    () => gate.run({ create: async () => { throw new Error("rede caiu"); }, opts: { local: {} } }),
    /rede caiu/,
  );
  assert.equal(gate.status().available, null);
  assert.equal(gate.status().notice, "");
  assert.equal(gate.note(new Error("rede caiu")), false);
});

test("a primeira mensagem segue sem sandbox e a Autonomia mostra o aviso", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-sandbox-msg-"));
  const calls = [];
  const sdk = {
    Cursor: { models: { list: async () => [] } },
    Agent: {
      create: async (opts) => {
        calls.push({ enabled: opts.local.sandboxOptions.enabled, tools: opts.tools, denied: opts.disallowedTools });
        if (opts.local.sandboxOptions.enabled) throw new Error(SANDBOX_ERROR);
        return {
          agentId: "agt_msg",
          send: async () => ({ supports: () => false, wait: async () => ({ result: "resposta pronta", status: "finished" }) }),
        };
      },
      resume: async () => { throw new Error("sem sessão"); },
    },
  };
  const app = await startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: false,
    routineMs: 0,
    loadSdk: async () => sdk,
    getAccounts: () => ({ accounts: [{ id: "acc_teste1", kind: "apiKey", apiKey: "crsr_chave_falsa_de_teste_0001", label: "Conta A" }], activeId: "acc_teste1" }),
  });
  const headers = { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` };
  try {
    const created = await (await fetch(`${app.url}/api/conversations`, { method: "POST", headers, body: "{}" })).json();
    const id = created.conversation.id;
    const sent = await fetch(`${app.url}/api/conversations/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "oi" }) });
    assert.equal(sent.status, 202);
    let body = null;
    for (let i = 0; i < 40; i += 1) {
      body = await (await fetch(`${app.url}/api/conversations/${id}`, { headers })).json();
      if (!body.conversation.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const reply = body.conversation.messages.find((message) => message.role === "assistant");
    assert.equal(body.conversation.busy, false);
    assert.match(reply.text, /resposta pronta/);
    assert.equal(/sandboxing is not supported/.test(reply.text), false);
    assert.equal(calls[0].enabled, true);
    assert.equal(calls[1].enabled, false);
    assert.deepEqual(calls[1].tools, ["mcp"]);
    assert.ok(calls[1].denied.includes("shell"));
    const view = await (await fetch(`${app.url}/api/autonomy`, { headers })).json();
    assert.equal(view.sandbox.available, false);
    assert.match(view.sandbox.notice, /aprovações continuam valendo/);
    assert.match(view.sandbox.notice, /Pedir antes/);
    assert.equal(view.modes.find((row) => row.tipo === "pagar").locked, true);
    assert.equal(view.modes.find((row) => row.tipo === "pagar").mode, "pedir");
    assert.equal(view.modes.find((row) => row.tipo === "preencher").mode, "pedir");
    const log = fs.readFileSync(path.join(dataDir, "logs", "helios.log"), "utf8");
    assert.match(log, /\[sandbox\]/);
    assert.equal(log.includes("crsr_chave_falsa"), false);
    const ui = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert.match(ui, /id="sandboxNote"/);
    assert.match(ui, /data\.sandbox\.notice/);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
