"use strict";

/**
 * Servidor MCP de teste que devolve os NOMES das variáveis de ambiente que recebeu
 * (e o valor só de HELIOS_TESTE_VAR). Nunca devolve valores de segredo.
 */
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let index;
  while ((index = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") {
      reply(msg.id, { protocolVersion: "2025-06-18", serverInfo: { name: "helios-env", version: "0" }, capabilities: {} });
    } else if (msg.method === "tools/list") {
      reply(msg.id, { tools: [{ name: "ambiente", description: "Lista os nomes das variáveis recebidas." }] });
    } else if (msg.method === "tools/call") {
      const payload = { nomes: Object.keys(process.env), teste: process.env.HELIOS_TESTE_VAR || "" };
      reply(msg.id, { content: [{ type: "text", text: JSON.stringify(payload) }] });
    } else {
      reply(msg.id, {});
    }
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}