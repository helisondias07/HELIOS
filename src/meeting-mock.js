"use strict";

/**
 * Modo demonstração (HELIOS_MOCK=1): nada sai do computador e não precisa de chave.
 * As falas são exemplo marcado, não uma reunião real.
 */
const SCRIPT = [
  { en: "Thanks for joining. Let's lock the scope for this week.", pt: "Obrigado por entrar. Vamos fechar o recorte desta semana." },
  { en: "Can you walk me through the current blocker?", pt: "Você pode me contar o que está travando agora?" },
  { en: "Who owns the next draft, and is there a date already?", pt: "Quem fica com o próximo rascunho, e já tem data?" },
  { en: "Great. Any open questions before we wrap?", pt: "Ótimo. Alguma dúvida em aberto antes de encerrar?" },
];
let cursor = 0;
const seen429 = new Set();

function resetMock() { cursor = 0; seen429.clear(); }

function mockTranscribe(audio) {
  let forced = "";
  try {
    const head = Buffer.from(audio || []).subarray(0, 400).toString("utf8");
    if (head.startsWith("MOCK:")) forced = head.slice(5).trim();
    const lim = head.match(/^MOCK429(ONCE)?:(.*)$/s);
    if (lim) {
      const once = !!lim[1];
      const key = lim[2].trim();
      if (!once || !seen429.has(key)) {
        seen429.add(key);
        throw Object.assign(new Error("HTTP 429 (limite do plano gratuito atingido, aguarde um pouco)"), { status: 429 });
      }
      forced = key;
    }
  } catch (err) {
    if (err && err.status === 429) throw err;
  }
  if (forced) return { text: forced, language: /[ãõçéáíóú]/i.test(forced) ? "pt" : "en" };
  const item = SCRIPT[cursor % SCRIPT.length];
  cursor += 1;
  return { text: item.en, language: "en" };
}

function toPt(text) {
  const clean = String(text || "").trim();
  const hit = SCRIPT.find((item) => item.en === clean);
  return hit ? hit.pt : `(demonstração) ${clean}`;
}

function mockChat(messages) {
  const system = String((messages[0] && messages[0].content) || "");
  const user = String((messages[messages.length - 1] && messages[messages.length - 1].content) || "");
  if (/Traduza cada linha numerada/.test(system)) {
    return user.split(/\r?\n/).map((line) => {
      const m = line.match(/^\s*(\d+)\|\s*(.+)$/);
      return m ? `${m[1]}| ${toPt(m[2])}` : "";
    }).filter(Boolean).join("\n");
  }
  if (/Traduza do português para o inglês/i.test(system) || /traduz do português para o inglês/i.test(system)) {
    const said = (user.match(/"""([\s\S]*?)"""/) || ["", user])[1].trim();
    return `EN: (demo) ${said}\nPT: ${said}`;
  }
  if (/ENTREVISTA DE EMPREGO/.test(system)) {
    const q = (user.match(/ÚLTIMA PERGUNTA a responder[^"]*"""([\s\S]*?)"""/) || ["", ""])[1].trim();
    return [
      "## Pergunta",
      `PT: (demonstração) ${q || "sem pergunta clara"}`,
      "## Responda",
      "EN: (demo) I maintain more than ten online stores at Agência Oásis. I update banners and pages, fix bugs, and integrate tools every week.",
      "PT: (demo) Eu mantenho mais de dez lojas virtuais na Agência Oásis. Atualizo banners e páginas, corrijo bugs e integro ferramentas toda semana.",
      "## Pontos de apoio",
      "- EN: (demo) More than ten stores on Wake, plus Nuvemshop. (PT: mais de dez lojas na Wake, e Nuvemshop.)",
    ].join("\n");
  }
  if (/Sugestão de fala AGORA/.test(user) || /sugere o que a pessoa pode falar/.test(system)) {
    return [
      "## O que falar agora",
      "Posso resumir o recorte desta semana e o que ainda está aberto. Se fizer sentido, eu fico com o rascunho e devolvo na data que vocês citarem.",
      "",
      "## Dados reais pesquisados",
      "- (demonstração) Sem busca real neste modo; em produção o HELIOS pesquisa fatos, números e regras na hora.",
      "- (demonstração) Os dados citados viriam da busca em tempo real ou da transcrição.",
    ].join("\n");
  }
  if (/pesquisa rapidamente um assunto/.test(system)) {
    return "- O que é: (demonstração) Conceito técnico citado na conversa.\n- Ponto-chave: Reduz latência evitando reprocessamento desnecessário.\n- Como falar agora: Podemos validar esse ponto no escopo antes de fechar o prazo.";
  }
  if (/três parágrafos curtos: Fato/.test(user)) {
    return "Fato: o grupo quer fechar o recorte da semana.\nAberto: dono e prazo do rascunho, se alguém citar.\nSugestão: pergunte quem escreve o próximo texto e até quando.";
  }
  if (/Até 4 perguntas curtas/.test(user)) {
    return "- Qual é o recorte que já está fechado?\n- O que ainda impede o envio?\n- Quem escreve o próximo rascunho, se já foi dito?\n- Quando vocês querem olhar de novo?";
  }
  if (/Live Coding do HELIOS/.test(system)) {
    return [
      "### 1. Preparar no VS Code",
      "- Pasta: `src/hooks`",
      "- Arquivo: `useDebounce.ts`",
      "- Terminal: nenhuma",
      "",
      "### 2. Passo a passo do que digitar",
      "Passo 2.1: Imports e tipagem",
      "```ts",
      "import { useEffect, useState } from \"react\";",
      "```",
      "Passo 2.2: Função principal",
      "```ts",
      "export function useDebounce<T>(value: T, delayMs = 300) {",
      "  const [debounced, setDebounced] = useState(value);",
      "  useEffect(() => {",
      "    const t = setTimeout(() => setDebounced(value), delayMs);",
      "    return () => clearTimeout(t);",
      "  }, [value, delayMs]);",
      "  return debounced;",
      "}",
      "```",
      "Passo 2.3: Onde chamar no componente",
      "```ts",
      "const debouncedQuery = useDebounce(query, 300);",
      "```",
      "Tempo: O(1) por render · Espaço: O(1) — um timer e um estado por instância do hook.",
      "",
      "### 3. O que falar enquanto digita",
      "- No Passo 2.1: \"Vou isolar o debounce num hook reutilizável.\"",
      "- No Passo 2.2: \"O useEffect limpa o timer a cada mudança, então só o último valor passa adiante.\"",
      "- No Passo 2.3: \"Agora só consumo o valor estabilizado na busca.\"",
    ].join("\n");
  }
  if (/pesquisa rapidamente um assunto/.test(system)) {
    return "- O que é: (demonstração) Conceito técnico citado na conversa.\n- Ponto-chave: Reduz latência evitando reprocessamento desnecessário.\n- Como falar agora: Podemos validar esse ponto no escopo antes de fechar o prazo.";
  }
  if (/Use exatamente quatro seções/.test(system)) {
    return "## Resumo\nExemplo de demonstração (não é uma reunião real): o time falou em fechar o recorte da semana.\n\n## Decisões\n- Manter o recorte atual até a próxima conversa.\n\n## Pendências\n- Você: enviar o rascunho até sexta\n\n## Próximos passos\n- Outro(s): devolver comentários depois do rascunho";
  }
  return "(demonstração) Resposta simulada em português: nenhuma chamada de IA foi feita. Isto não é uma reunião real.";
}

const MOCK_PREVIEW = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#222"/><text x="160" y="95" fill="#d9b04a" font-family="sans-serif" font-size="16" text-anchor="middle">Prévia simulada da tela</text></svg>')}`;

module.exports = { mockTranscribe, mockChat, resetMock, MOCK_PREVIEW, SCRIPT, toPt };
