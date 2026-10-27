"use strict";

/** Passos do modo demonstração para as ferramentas de orquestração. Devolve null se o texto não pede nenhuma. */
function orchestrationScript(raw) {
  const consult = raw.match(/\bconsult(?:e|ar)\s+(?:o\s+assistente\s+)?([^\s:,]+)\s*[:,]\s*(.+)/i);
  if (consult) return [["tool", "consultar_assistente", { assistente: consult[1], pergunta: consult[2].slice(0, 300) }, "relay"]];
  const helper = raw.match(/\b(?:crie|criar)\s+(?:um\s+)?ajudante\s+(?:para|de)\s+(.+)/i);
  if (helper) {
    const tools = helper[1].match(/\bferramentas?:\s*([\w, ]+)$/i);
    // "sem briefing" deixa de fora os 4 campos (a ferramenta tem de recusar); do contrário vão valores de demonstração.
    const noBrief = /\bsem briefing\b/i.test(helper[1]);
    const task = helper[1].replace(/\bferramentas?:\s*[\w, ]+$/i, "").replace(/\bsem briefing\b/i, "").trim().slice(0, 400);
    const args = { tarefa: task, instrucoes_curtas: "Seja breve." };
    if (!noBrief) Object.assign(args, { pergunta: task, fontes: "Ferramentas disponíveis ao ajudante (modo demonstração)", formato: "FEITO / ACHEI / PENDENTE", fronteira: "Não enviar, apagar, pagar nem publicar sem aprovação." });
    if (tools) args.ferramentas_permitidas = tools[1].split(",").map((item) => item.trim()).filter(Boolean);
    return [["tool", "criar_ajudante", args, "relay"]];
  }
  // "estacione a tarefa: objetivo | feito: a; b | falta: c | pergunta: ... | motivo: aprovacao"
  const park = raw.match(/\bestacion(?:e|ar)\s+(?:a\s+)?tarefa\s*:\s*(.+)/i);
  if (park) {
    const parts = park[1].split("|").map((item) => item.trim());
    const pick = (name) => {
      const found = parts.find((item) => new RegExp(`^${name}\\s*:`, "i").test(item));
      return found ? found.replace(/^[^:]+:\s*/, "") : "";
    };
    const list = (value) => value.split(";").map((item) => item.trim()).filter(Boolean);
    return [["tool", "estacionar_tarefa", { objetivo: parts[0], feito: list(pick("feito")), falta: list(pick("falta")), pergunta: pick("pergunta") || "Posso continuar?", motivo: pick("motivo") || "informacao" }, "relay"]];
  }
  // "verifique a afirmação af_1 do registro reg_x": pede o verificador independente (se estiver ligado).
  const verify = raw.match(/\bverifi(?:que|car)\s+(?:a\s+)?afirma[cç][aã]o\s+(\S+)\s+(?:do\s+)?registro\s+(\S+)/i);
  if (verify) return [["tool", "verificar_afirmacao", { registro: verify[2], afirmacao: verify[1] }, "relay"]];
  const assistant = raw.match(/\b(?:crie|criar)\s+(?:o\s+)?assistente\s+([^:.,]+?)(?:\s*[:,]\s*(.+))?$/i);
  if (assistant) {
    return [
      ["tool", "criar_assistente", { nome: assistant[1].trim().slice(0, 40), funcao: (assistant[2] || "Assistente criado por bot").slice(0, 120), instrucoes: "Ajude o Helison neste assunto, de forma curta e objetiva." }],
      ["say", "Pedi a criação do assistente. Ele só existe depois da sua aprovação."],
    ];
  }
  const archive = raw.match(/\barquiv(?:e|ar)\s+(?:o\s+item\s+)?(.+)/i);
  if (archive) return [["tool", "arquivar_item", { item: archive[1].trim().slice(0, 200), motivo: "concluído" }, "relay"]];
  const register = raw.match(/\bregistr(?:e|ar)\s+no\s+contexto\s*[:,]?\s*(.+)/i);
  if (register) return [["tool", "contexto_registrar", { item: register[1].trim().slice(0, 300) }, "relay"]];
  const search = raw.match(/\b(?:busc(?:ar|e)|busque)\s+no\s+arquivo\s*[:,]?\s*(.+)/i);
  if (search) return [["tool", "buscar_arquivo", { consulta: search[1].trim().slice(0, 200) }, "relay"]];
  return null;
}

/** `role`: "usuario" (conversa), "ajudante" (relatório curto) ou "consulta" (resposta curta). */
function script(text, role = "usuario") {
  const steps = baseScript(text, role);
  if (role === "ajudante") {
    // "com fontes" na tarefa: o relatório de demonstração traz o registro de fontes (3 categorias).
    const ledger = /\bcom fontes\b/i.test(text)
      ? "\nACORDADAS:\n- [IMPORTANTE] O Node.js 22 é uma versão LTS [confirmar] | https://nodejs.org/pt/about/previous-releases\nCONTESTADAS:\n- [IMPORTANTE] A biblioteca X é a mais rápida | https://exemplo.com/a diz que sim | https://exemplo.com/b diz que não\nNAO VERIFICADAS:\n- [IMPORTANTE] O preço caiu 30% [desmentir] | sem fonte\n- A versão nova sai em breve"
      : "";
    return steps.map((step) => (step[0] === "say" ? ["say", `FEITO: ${step[1]} ACHEI: nada encontrado (modo demonstração). PENDENTE: nada, ou o que estiver na Caixa de entrada.${ledger}`] : step));
  }
  return steps;
}

function baseScript(text, role) {
  const raw = String(text || "");
  const folded = raw.toLowerCase();
  if (/^resposta à sua pergunta/i.test(raw)) return [["say", "Entendi. Sigo daqui com a sua resposta."]];
  if (role === "verificador") {
    // Modo demonstração: sem como checar de verdade. Marcadores no texto da afirmação escolhem o veredito (usado nos testes).
    const verdict = /\[desmentir\]/i.test(raw) ? "rejected" : /\[confirmar\]/i.test(raw) ? "confirmed" : "needs_validation";
    return [["say", `VEREDITO: ${verdict}\nMOTIVO: modo demonstração, sem como checar de verdade.\nFONTE: nenhuma`]];
  }
  if (role === "consulta") return [["say", `Resposta em modo demonstração, sem conta do Cursor: ${raw.slice(0, 120)}`]];
  const orchestrated = orchestrationScript(raw);
  if (orchestrated) return orchestrated;
  if (/\b(me pergunte|pergunte-me|fa[cç]a uma pergunta)\b/.test(folded)) {
    return [
      ["tool", "perguntar_ao_helison", { pergunta: raw.slice(0, 200), opcoes: ["Sim", "Não"] }],
      ["say", "Deixei uma pergunta na Caixa de entrada."],
    ];
  }
  const viaMcp = raw.match(/\bmcp\s+([\w-]+)\.([\w-]+)/i);
  if (viaMcp) {
    return [
      ["tool", "mcp_chamar", { servidor: viaMcp[1], ferramenta: viaMcp[2], argumentos: { texto: "demo" } }],
      ["say", "Chamei o conector."],
    ];
  }
  const write = raw.match(/\b(?:grav\w+|escrev\w+)\s+(?:o\s+)?arquivo\s+(\S+)/i);
  if (write) {
    return [
      ["tool", "escrever_arquivo", { caminho: write[1], conteudo: `Gerado pelo HELIOS: ${raw.slice(0, 120)}\n` }],
      ["say", "Pedi para gravar o arquivo."],
    ];
  }
  const fill = raw.match(/preencher login\s+([^\n.]+)/i);
  if (fill) {
    return [
      ["tool", "helios_preencher_login", { nome: fill[1].trim() }],
      ["say", "Pedi o preenchimento do login. A senha não passa por mim."],
    ];
  }
  if (/\b(enviar|envia|mandar|apagar|apague|excluir|pagar|pague|publicar)\b/i.test(folded)) {
    let tipo = "enviar";
    if (/apag|exclu/.test(folded)) tipo = "apagar";
    else if (/pag/.test(folded)) tipo = "pagar";
    else if (/public/.test(folded)) tipo = "publicar";
    return [
      ["tool", "helios_acao", { tipo, resumo: raw.slice(0, 180), alvo: "", texto: raw.slice(0, 500) }],
      ["say", "Preciso da sua aprovação antes de fazer isso."],
    ];
  }
  if (/\blembra/.test(folded)) {
    const fato = raw.replace(/^[\s\S]*?lembra(?:r|-se)?(?: que)?\s*/i, "").slice(0, 240);
    return [
      ["tool", "memory_save", { texto: fato || raw.slice(0, 240), tipo: "fato" }],
      ["say", "Anotado na memória."],
    ];
  }
  if (/\bpesquis/.test(folded)) {
    const consulta = raw.replace(/^[\s\S]*?pesquis\w*\s*/i, "").slice(0, 200) || raw.slice(0, 200);
    return [
      ["tool", "pesquisar_web", { consulta }],
      ["say", "Pesquisei. As fontes ficam junto da resposta."],
    ];
  }
  if (/\blivecoding|ao vivo com estagi/.test(folded)) {
    return [
      ["tool", "iniciar_livecoding", { descricao: raw.slice(0, 120) }],
      ["say", "Abri o roteiro na pílula de reunião. Nada foi salvo e nenhum editor abriu. Use Próximo e Anterior."],
    ];
  }
  if (role === "ajudante") return [["say", `executei a tarefa “${raw.slice(0, 80)}” em modo demonstração.`]];
  return [[
    "say",
    "Estou sem uma conta do Cursor neste modo. Posso pesquisar, lembrar um fato, preencher um login do cofre ou pedir aprovação antes de enviar, apagar ou pagar.",
  ]];
}

function createMockAgent({ tools }) {
  const id = `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    agentId: id,
    async send(message, opts = {}) {
      const full = typeof message === "string" ? message : message?.text || "";
      const marker = /## (Mensagem do Helison|Tarefa do ajudante|Afirmação a verificar|Pergunta de outro assistente[^\n]*)\n/g;
      let last = null;
      for (const found of full.matchAll(marker)) last = found;
      const role = last ? (last[1].startsWith("Tarefa") ? "ajudante" : last[1].startsWith("Afirma") ? "verificador" : last[1].startsWith("Pergunta") ? "consulta" : "usuario") : "usuario";
      const text = (last ? full.slice(last.index + last[0].length) : full).trim();
      // Ganchos só para testar o aviso de limite sem gastar nada (modo demonstração).
      const simulated = /\[\[simular:(uso|taxa|auth)\]\]/.exec(text);
      if (simulated) {
        const fake = {
          uso: ["Usage limit exceeded", "RateLimitError", 429],
          taxa: ["Rate limit exceeded", "RateLimitError", 429],
          auth: ["Invalid API key", "AuthenticationError", 401],
        }[simulated[1]];
        throw Object.assign(new Error(fake[0]), { name: fake[1], status: fake[2] });
      }
      const steps = script(text, role);
      let finalText = "";
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      let cancelled = false;
      async function* stream() {
        const delay = Number(process.env.HELIOS_MOCK_DELAY || 0);
        for (const [kind, name, args, mode] of steps) {
          if (cancelled) break;
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          if (kind === "say") {
            finalText = name;
            yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: name }] } };
            continue;
          }
          yield { type: "tool_call", name, status: "running", args: args || {} };
          let result = "ok";
          if (tools[name]?.execute) {
            try {
              result = await tools[name].execute(args || {});
            } catch (err) {
              result = err.message || String(err);
            }
          }
          yield { type: "tool_call", name, status: "completed", args: args || {}, result };
          if (mode === "relay") {
            finalText = String(result);
            yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: finalText }] } };
          }
        }
        resolveDone({ id: `run-${id}`, status: cancelled ? "cancelled" : "finished", result: finalText, model: opts.model || null });
      }
      return {
        id: `run-${id}`,
        supports: () => true,
        stream,
        wait: () => done,
        cancel: async () => {
          cancelled = true;
          resolveDone({ id: `run-${id}`, status: "cancelled", result: "" });
        },
      };
    },
    async [Symbol.asyncDispose]() {},
  };
}

module.exports = { createMockAgent, script };
