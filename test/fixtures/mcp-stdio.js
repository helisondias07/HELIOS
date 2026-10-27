"use strict";

/**
 * Servidor MCP mínimo de teste: uma ferramenta de leitura.
 * Protocolo JSON-RPC em linhas no stdout.
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
      reply(msg.id, { protocolVersion: "2025-06-18", serverInfo: { name: "helios-teste", version: "0" }, capabilities: {} });
    } else if (msg.method === "tools/list") {
      reply(msg.id, { tools: [{ name: "eco", description: "Devolve o texto recebido." }] });
    } else if (msg.method === "tools/call") {
      reply(msg.id, { content: [{ type: "text", text: `eco:${msg.params?.arguments?.texto || ""}` }] });
    } else {
      reply(msg.id, {});
    }
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
