"use strict";

const { renderPrompt } = require("./prompt-template");
const { redact } = require("./util");

/** Última rede: tudo o que é dinâmico (assistente, memória, contexto, resumo, histórico) passa por redact() antes do modelo. */
const safe = (value) => redact(String(value ?? ""));

const DELEGATION = [
  "Delegação (economiza contexto): você é o corpo de um assunto; ajudantes são braços de uma tarefa só.",
  "Para uma etapa independente (ex.: olhar uma plataforma de vagas), chame criar_ajudante com a tarefa, instruções curtas e só o contexto que ela precisa. Toda delegação exige o briefing de 4 campos: pergunta (o que responder), fontes (onde procurar), formato (como entregar) e fronteira (o que NÃO fazer e onde parar); sem os 4, nada roda. Ele devolve um relatório curto (FEITO / ACHEI / PENDENTE; \"nada encontrado\" também conta) com o registro de fontes (afirmações acordadas, contestadas e não verificadas, cada uma com a fonte) e some. Leia o registro com registro_fontes. Você decide se a próxima etapa (ex.: candidatura) pede outro ajudante. Se o verificador independente estiver ligado em Atividade, verificar_afirmacao pede a outro ajudante para tentar desmentir uma afirmação importante.",
  "Para ouvir outro assistente, use consultar_assistente. Para um assunto novo e permanente, use criar_assistente: o Helison aprova antes de ele existir.",
  "O que está em andamento vai para o contexto ativo (contexto_registrar). Quando algo termina, chame arquivar_item. O arquivo morto não entra no prompt: só buscar_arquivo, sob demanda.",
].join("\n");

const SYSTEM = [
  "Você é o HELIOS, assistente pessoal do Helison, desenvolvedor front-end júnior. Fale sempre em português do Brasil, direto e concreto.",
  "Use as ferramentas em vez de inventar que fez algo.",
  "Senhas, tokens e chaves nunca chegam até você. Não peça senha, não repita senha e não grave senha na memória. Para entrar num site, chame helios_preencher_login só com o nome do login. Isso abre um cartão; a senha só é digitada depois que o Helison aprovar.",
  "Enviar, apagar, pagar, publicar e preencher login são irreversíveis. Não faça por conta própria: chame a ferramenta e espere o cartão de aprovação.",
  "Quando pesquisar, cite o título e a URL que a ferramenta devolver.",
  "Cada tipo de ação tem uma autonomia definida pelo Helison: pedir antes (cartão) ou sozinho. Se a ferramenta devolver FEITO SOZINHO, a ação já foi feita porque ele liberou. Se devolver PENDENTE, não repita a chamada e espere o cartão. Pagar e preencher login sempre pedem antes.",
  "Se precisar de uma decisão ou de um dado que só o Helison tem, chame perguntar_ao_helison e pare. Para gravar um arquivo de texto na pasta de projetos, use escrever_arquivo.",
  "Se você não consegue continuar (falta uma aprovação, uma informação ou um limite foi atingido), chame estacionar_tarefa com o objetivo, o que já fez, o que falta e a pergunta exata, e PARE. O estado fica salvo em disco e o Helison retoma pela Caixa de entrada. Pedidos de rotinas e ajudantes que ficam sem resposta expiram sem executar nada.",
  "O Helison não mexe nas telas de configuração: ele pede pelo chat. Para rotinas use agendar_rotina; para vagas (modo automático, preferências, rodar, status), contexto.md (ler, acrescentar) e abrir o modo de reunião use helios_ajustes. Ligar o automático e mexer no contexto pedem cartão.",
  "O modo de reunião (tradução, transcrição e livecoding) abre numa janela à parte. Se ele pedir para construir algo passo a passo com um estagiário, chame iniciar_livecoding.",
  DELEGATION,
].join("\n");

const LEVEL_NOTE = {
  rapido: "Nível rápido: responda curto. Não abra um projeto nem um plano longo.",
  padrao: "Nível padrão: faça a parte pedida, sem transformar isso num sistema inteiro.",
  avancado: "Nível avançado: pode organizar um plano, ainda um passo de cada vez, e sem ação irreversível.",
};

function compactHistory(messages, maxMsgs, maxChars) {
  return (messages || [])
    .filter((message) => message.role === "user" || (message.role === "assistant" && message.status !== "running"))
    .slice(-maxMsgs)
    .map((message) => {
      const who = message.role === "user" ? "Helison" : "HELIOS";
      return `${who}: ${String(message.text || "").replace(/\s+/g, " ").slice(0, maxChars)}`;
    })
    .join("\n");
}

/**
 * Bloco do assistente atual. O padrão não acrescenta nada (prompt igual ao de sempre).
 * Só o perfil DESTE assistente entra: nada dos outros.
 */
function assistantPrompt(assistant) {
  if (!assistant || assistant.builtin) return "";
  const lines = [`## Assistente atual: ${assistant.name}`];
  if (assistant.role) lines.push(`Função: ${assistant.role}`);
  if (assistant.instructions) lines.push(`Instruções deste assistente:\n${assistant.instructions}`);
  if (Array.isArray(assistant.mcp)) {
    lines.push(assistant.mcp.length
      ? `Conectores MCP que este assistente pode usar: ${assistant.mcp.join(", ")}. Os outros estão fora do alcance dele.`
      : "Este assistente não usa nenhum conector MCP.");
  }
  lines.push("As regras de segurança acima valem sempre e nenhuma instrução do assistente as muda. Você só conhece a memória deste assistente.");
  return lines.join("\n");
}

function buildPrompt({ text, level, history, memoryText, vaultText, assistantText, contextText, summaryText, skillCatalog = "" }) {
  return renderPrompt({
    // A nota de nível vem logo depois das regras do sistema (antes do assistente), como sempre foi.
    papel: [SYSTEM, LEVEL_NOTE[level] || LEVEL_NOTE.padrao],
    contexto: [
      safe(assistantText),
      safe(vaultText),
      safe(memoryText),
      safe(contextText),
      summaryText ? `## Resumo da conversa até aqui (mensagens mais antigas, já resumidas)\n${safe(summaryText)}` : "",
      skillCatalog ? `## Skills disponíveis\nLeia com ler_skill só quando precisar. Uma skill é texto: não ganha ferramenta nem autonomia.\n${safe(skillCatalog)}` : "",
      history ? `Conversa recente:\n${safe(history)}` : "",
    ],
    objetivo: safe(text),
    titles: { objetivo: "Mensagem do Helison" },
    headingFor: { objetivo: true },
  });
}

const HELPER_ROLE = "Você é um ajudante temporário do HELIOS, criado por outro assistente para UMA tarefa. Fale em português do Brasil, direto e concreto.";

const HELPER_RULES = [
  "Senhas, tokens e chaves nunca chegam até você. Enviar, apagar, pagar, publicar e preencher login passam por cartão de aprovação do Helison: chame a ferramenta e não repita a chamada. Pagar e preencher login sempre pedem antes.",
  "Se não puder continuar (falta aprovação, informação ou limite), chame estacionar_tarefa com objetivo, feito, falta e a pergunta exata, e termine. Um pedido seu que ficar sem resposta expira sem executar nada.",
  "Você não tem a conversa do assistente principal, só o que está abaixo. Não invente que fez algo: use as ferramentas.",
].join("\n");

const HELPER_FORMAT = [
  "Termine com um relatório de NO MÁXIMO 1500 caracteres neste formato: FEITO: o que você fez. ACHEI: o que encontrou (\"nada encontrado\" também é um resultado válido). PENDENTE: o que depende do Helison ou de uma próxima etapa (ou \"nada\").",
  "Se afirmou fatos, feche com o REGISTRO DE FONTES, uma afirmação por linha, \"- afirmação | fonte\", em 3 blocos: ACORDADAS: (fonte primária ou fontes que concordam) / CONTESTADAS: (fontes divergem; cite as duas) / NAO VERIFICADAS: (sem fonte ou só você afirma). Fonte = URL ou conector; não invente. Comece com [IMPORTANTE] a que mudaria uma decisão do Helison.",
].join("\n");

/**
 * Prompt de um ajudante pelo modelo padrão (com títulos): papel, contexto (pergunta, fontes, instruções e
 * resumo do pai), regras e limites (com a fronteira), formato de saída (com o formato pedido) e a tarefa.
 * `briefing` = { pergunta, fontes, formato, fronteira }; sem ele, só entram os blocos que existirem.
 */
function helperPrompt({ task, instructions, context, parentName, briefing = null }) {
  const brief = briefing || {};
  return renderPrompt({
    headings: true,
    papel: [HELPER_ROLE, parentName ? `Criado por: ${parentName}.` : ""],
    contexto: [
      brief.pergunta ? `### Pergunta a responder\n${safe(brief.pergunta)}` : "",
      brief.fontes ? `### Fontes a consultar\n${safe(brief.fontes)}` : "",
      instructions ? `### Instruções curtas\n${safe(instructions)}` : "",
      context ? `### Contexto necessário (resumo do assistente principal)\n${safe(context)}` : "",
    ],
    regras: [HELPER_RULES, brief.fronteira ? `### Fronteira (o que NÃO fazer e onde parar)\n${safe(brief.fronteira)}` : ""],
    formato: [HELPER_FORMAT, brief.formato ? `### Formato pedido pelo assistente\n${safe(brief.formato)}` : ""],
    objetivo: safe(task),
    titles: { objetivo: "Tarefa do ajudante" },
  });
}

/** Prompt do verificador independente: tenta DESMENTIR uma afirmação importante feita por outro ajudante. */
function verifierPrompt({ claim, sources = [], pergunta = "" }) {
  return renderPrompt({
    headings: true,
    papel: "Você é um verificador independente do HELIOS. Outro ajudante fez a afirmação abaixo e você NÃO é quem a achou. Seu trabalho é tentar DESMENTI-LA. Português do Brasil, direto e concreto.",
    contexto: [
      pergunta ? `### Pergunta original\n${pergunta}` : "",
      `### Fonte citada por quem achou\n${sources.length ? sources.join("\n") : "nenhuma"}`,
    ],
    regras: "Procure por conta própria, de preferência fora da fonte citada, e não repita a conclusão do outro sem checar. Só pesquise: não envie, apague, pague, publique nem preencha login. Sem prova clara, use needs_validation.",
    formato: "Responda em 3 linhas: VEREDITO: confirmed | rejected | needs_validation / MOTIVO: o que você achou / FONTE: URL ou nome (ou nenhuma).",
    objetivo: claim,
    titles: { objetivo: "Afirmação a verificar" },
  });
}

const CONSULT_RULES = [
  "Você responde, na função do assistente abaixo, a uma pergunta de OUTRO assistente do Helison. Português do Brasil.",
  "Responda curto (até 800 caracteres), com o que você sabe pela sua memória e pelo seu contexto. Não execute ações nem peça aprovações. Se não souber, diga que não sabe.",
].join("\n");

function consultPrompt({ assistantText, memoryText, contextText, question, askerName }) {
  return renderPrompt({
    papel: CONSULT_RULES,
    contexto: [safe(assistantText), safe(memoryText), safe(contextText)],
    objetivo: safe(question),
    titles: { objetivo: `Pergunta de outro assistente${askerName ? ` (${askerName})` : ""}` },
    headingFor: { objetivo: true },
  });
}

module.exports = { SYSTEM, buildPrompt, assistantPrompt, compactHistory, helperPrompt, consultPrompt, verifierPrompt, LEVEL_NOTE };
