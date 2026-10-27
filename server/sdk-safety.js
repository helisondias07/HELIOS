"use strict";

/**
 * Ferramentas embutidas do @cursor/sdk (shell, edicao, apagar, web...). O agente local do SDK vem com elas ligadas por padrao,
 * e elas NAO passam pelo gate() do HELIOS (Autonomia, cartoes, travas de pagar/preencher).
 *
 * `tools: ["mcp"]` oferece ao modelo SO a familia MCP, que inclui as `customTools` do HELIOS (que passam pelo gate).
 * `disallowedTools` repete a negacao das embutidas perigosas (deny-wins), caso o conjunto padrao ganhe algo novo no futuro.
 * Os dois nao sao gravados no agente: tem de ir de novo em cada Agent.create e Agent.resume.
 * Vocabulario: node_modules/@cursor/sdk/dist/cjs/options.d.ts (ToolName).
 */
const ONLY_CUSTOM_TOOLS = ["mcp"];
const DENIED_BUILTINS = ["shell", "edit", "delete", "applyAgentDiff", "task", "webFetch", "webSearch", "generateImage"];

/** Opcoes de restricao para Agent.create / Agent.resume. `withCustomTools: false` = agente so de texto (sem nenhuma ferramenta). */
function restrictedAgentOptions({ withCustomTools = true } = {}) {
  return {
    tools: withCustomTools ? [...ONLY_CUSTOM_TOOLS] : [],
    disallowedTools: [...DENIED_BUILTINS],
  };
}

module.exports = { restrictedAgentOptions, ONLY_CUSTOM_TOOLS, DENIED_BUILTINS };
