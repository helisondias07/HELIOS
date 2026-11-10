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
  if (/Detecte se a fala contém uma pergunta/.test(system)) {
    return /\?\s*$/.test(user.trim()) ? user.replace(/^\(demonstração\)\s*/, "").split(/\s+/).slice(0, 8).join(" ") : "NONE";
  }
  if (/Sugestão de fala AGORA/.test(user) || /sugere o que a pessoa pode falar/.test(system)) {
    return "Sugestão: Posso resumir o recorte desta semana e o que ainda está aberto. Se fizer sentido, eu fico com o rascunho e devolvo na data que vocês citarem.";
  }
  if (/três parágrafos curtos: Fato/.test(user)) {
    return "Fato: o grupo quer fechar o recorte da semana.\nAberto: dono e prazo do rascunho, se alguém citar.\nSugestão: pergunte quem escreve o próximo texto e até quando.";
  }
  if (/Até 4 perguntas curtas/.test(user)) {
    return "- Qual é o recorte que já está fechado?\n- O que ainda impede o envio?\n- Quem escreve o próximo rascunho, se já foi dito?\n- Quando vocês querem olhar de novo?";
  }
  if (/Use exatamente quatro seções/.test(system)) {
    return "## Resumo\nExemplo de demonstração (não é uma reunião real): o time falou em fechar o recorte da semana.\n\n## Decisões\n- Manter o recorte atual até a próxima conversa.\n\n## Pendências\n- Você: enviar o rascunho até sexta\n\n## Próximos passos\n- Outro(s): devolver comentários depois do rascunho";
  }
  return "(demonstração) Resposta simulada em português: nenhuma chamada de IA foi feita. Isto não é uma reunião real.";
}

const MOCK_PREVIEW = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#222"/><text x="160" y="95" fill="#d9b04a" font-family="sans-serif" font-size="16" text-anchor="middle">Prévia simulada da tela</text></svg>')}`;

module.exports = { mockTranscribe, mockChat, resetMock, MOCK_PREVIEW, SCRIPT, toPt };
