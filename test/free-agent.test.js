"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFreeLlm } = require("../server/free-llm");
const { createFreeWorker } = require("../server/free-agent");
const { boot, json } = require("./helpers-ideias");

function response(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("worker grátis mantém histórico e executa ferramentas do HELIOS", async () => {
  const chamadas = [];
  const llm = {
    async runAgent(input) {
      chamadas.push(input);
      const tool = input.tools.find((item) => item.name === "arquivo_ler");
      const result = await tool.handler({ caminho: "README.md" });
      await input.onEvent?.({ type: "tool_call", status: "running", name: "arquivo_ler", args: { caminho: "README.md" } });
      await input.onEvent?.({ type: "tool_call", status: "completed", name: "arquivo_ler", result });
      return {
        text: "Li o arquivo e concluí.",
        history: [...input.history, { role: "user", content: input.user }, { role: "assistant", content: "Li o arquivo e concluí." }],
      };
    },
  };
  const logs = [];
  const worker = createFreeWorker({
    llm,
    agent: "chefe",
    text: "Você é o Chefe.",
    tools: { arquivo_ler: { description: "Lê arquivo", inputSchema: { type: "object" }, execute: async (args) => `conteúdo de ${args.caminho}` } },
    onLog: (event) => logs.push(event),
  });

  const first = worker.send("Analise o repositório.");
  const events = [];
  for await (const event of first.stream()) events.push(event);
  const done = await first.wait();
  assert.equal(done.status, "completed");
  assert.equal(done.result, "Li o arquivo e concluí.");
  assert.equal(chamadas.length, 1);
  assert.deepEqual(chamadas[0].history, [{ role: "system", content: "Você é o Chefe." }]);
  assert.equal(events.filter((event) => event.type === "tool_call").length, 2);
  assert.equal(logs.length, 2);

  const second = worker.send("Agora faça o resumo.");
  await second.wait();
  assert.equal(chamadas.length, 2);
  assert.equal(chamadas[1].history.at(-1).role, "assistant");
  worker.close();
  assert.throws(() => worker.send("não deve rodar"), /encerrado/);
});

test("loop grátis faz tool-call OpenAI compatível e volta ao modelo", async () => {
  const bodies = [];
  const llm = createFreeLlm({
    getKey: () => "chave-de-teste",
    roleModels: { chefe: ["modelo-teste"], reservas: [] },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const hasToolResult = body.messages.some((message) => message.role === "tool");
      return response({ choices: [{ message: hasToolResult
        ? { role: "assistant", content: "arquivo conferido" }
        : { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "ler", arguments: '{"caminho":"README.md"}' } }] } }], usage: { total_tokens: 3 } });
    },
  });
  const events = [];
  const result = await llm.runAgent({
    agent: "chefe",
    user: "Leia o README.",
    tools: [{ name: "ler", description: "Lê", parameters: { type: "object" }, handler: async () => "conteúdo seguro" }],
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.text, "arquivo conferido");
  assert.equal(result.chamadas.length, 1);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].messages.at(-1).role, "tool");
  assert.equal(events.filter((event) => event.status === "running").length, 1);
  assert.equal(bodies.every((body) => JSON.stringify(body).includes("chave-de-teste") === false), true);
});

test("runtime escolhe modelos grátis quando há chave e conserva fallback configurável", async () => {
  const app = await boot({
    getLlmKey: () => "chave-de-teste",
    fetch: async () => response({ choices: [{ message: { role: "assistant", content: "Tarefa concluída pelo modelo gratuito." } }] }),
  });
  try {
    const created = await json(app, "/api/agentes", { method: "POST", body: { tarefa: "Leia os arquivos e me entregue um resumo.", assistantId: "chefe" } });
    assert.equal(created.status, 201);
    const id = created.body.agente.id;
    let view = created.body.agente;
    for (let i = 0; i < 80 && view.status !== "done" && view.status !== "error"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      view = (await json(app, `/api/agentes/${encodeURIComponent(id)}`)).body.agente;
    }
    assert.equal(view.status, "done");
    assert.equal(view.modelo, "modelos grátis");
    assert.match(view.result, /modelo gratuito/);
  } finally {
    await app.close();
  }
});
