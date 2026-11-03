"use strict";

/**
 * Adaptador do loop de modelos grátis para o contrato de worker do agent-runtime.
 * O runtime continua responsável por segurança, aprovações e persistência; este
 * módulo só troca o motor de raciocínio do Cursor pelo free-llm.
 */

function schemaOf(tool) {
  return tool?.inputSchema || tool?.parameters || { type: "object", properties: {} };
}

function createFreeWorker({ llm, agent = "chefe", tools = {}, text = "", maxSteps = 24, onLog = () => {} } = {}) {
  if (!llm || typeof llm.runAgent !== "function") throw new Error("Motor grátis indisponível.");
  const entries = Object.entries(tools || {});
  const specs = entries.map(([name, tool]) => ({
    name,
    description: tool.description || "",
    parameters: schemaOf(tool),
    handler: async (args) => tool.execute(args || {}),
  }));
  let history = text ? [{ role: "system", content: text }] : [];
  let closed = false;

  function send(message) {
    if (closed) throw new Error("Worker encerrado.");
    const events = [];
    let resultPromise;
    resultPromise = llm.runAgent({
      agent,
      history,
      user: String(message || ""),
      tools: specs,
      maxSteps,
      onEvent: async (event) => { events.push(event); onLog(event); },
    }).then((result) => {
      history = Array.isArray(result.history) ? result.history : history;
      return result;
    });
    return {
      supports: (kind) => kind === "stream",
      async *stream() {
        const result = await resultPromise;
        for (const event of events) {
          yield { ...event, result: event.result };
        }
        if (result.text) yield { type: "assistant", message: { content: [{ type: "text", text: result.text }] } };
      },
      wait: () => resultPromise.then((result) => ({ status: "completed", result: result.text, free: result })),
      cancel: async () => { closed = true; },
      close: () => { closed = true; },
    };
  }

  return {
    send,
    close: () => { closed = true; },
    get agentId() { return null; },
  };
}

module.exports = { createFreeWorker };
