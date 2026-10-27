"use strict";

/** Servidor MCP de teste que, ao receber o initialize, despeja 2 MB sem quebra de linha e muito stderr. */
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write("e".repeat(500000));
  process.stdout.write("x".repeat(2 * 1024 * 1024));
});
setTimeout(() => process.exit(0), 15000).unref();