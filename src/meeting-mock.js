"use strict";

/**
 * Modo demonstração do modo de reunião (HELIOS_MOCK=1): nada sai do computador e não precisa de chave.
 * A "transcrição" devolve falas de exemplo em inglês, na ordem; se o áudio recebido começar com "MOCK:",
 * o texto depois dele vira a fala (usado nos testes). A tradução e as respostas são fixas e previsíveis.
 */
const SCRIPT = [
  { en: "Hi Helison, thanks for joining. I'm Sarah, I lead the e-commerce engineering team here.", pt: "Oi Helison, obrigada por entrar. Eu sou a Sarah e lidero o time de engenharia de e-commerce aqui." },
  { en: "Can you tell me about your experience building storefronts on Wake?", pt: "Você pode me contar sobre sua experiência construindo lojas na Wake?" },
  { en: "What was the hardest performance problem you solved, and how did you approach it?", pt: "Qual foi o problema de performance mais difícil que você resolveu e como você abordou?" },
  { en: "We work with a distributed team. How do you handle code reviews and communication?", pt: "Nós trabalhamos com um time distribuído. Como você lida com revisões de código e comunicação?" },
  { en: "Great. Do you have any questions for us about the role?", pt: "Ótimo. Você tem alguma pergunta para nós sobre a vaga?" },
];
let cursor = 0;

function resetMock() { cursor = 0; seen429.clear(); }

const seen429 = new Set();

function mockTranscribe(audio) {
  let forced = "";
  try {
    const head = Buffer.from(audio || []).subarray(0, 400).toString("utf8");
    if (head.startsWith("MOCK:")) forced = head.slice(5).trim();
    // simula o limite da Groq: "MOCK429:" sempre falha; "MOCK429ONCE:" falha só na primeira vez
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

/** Resposta falsa para cada tipo de prompt do modo de reunião. Reconhece o tipo pelo texto do prompt. */
function mockChat(messages) {
  const system = String((messages[0] && messages[0].content) || "");
  const user = String((messages[messages.length - 1] && messages[messages.length - 1].content) || "");
  if (/Traduza cada linha numerada/.test(system)) {
    return user.split(/\r?\n/).map((line) => {
      const m = line.match(/^\s*(\d+)\|\s*(.+)$/);
      return m ? `${m[1]}| ${toPt(m[2])}` : "";
    }).filter(Boolean).join("\n");
  }
  if (/traduz do português para o inglês/i.test(system)) {
    const said = (user.match(/"""([\s\S]*?)"""/) || ["", user])[1].trim();
    return `EN: (demo) ${said}\nPT: ${said}`;
  }
  if (/Pesquise na web \(somente leitura\)/.test(user)) {
    return "A Wake é uma plataforma brasileira de e-commerce (demonstração, nenhuma pesquisa real foi feita).\nFontes:\nhttps://example.com/wake-plataforma\nhttps://example.com/wake-docs";
  }
  if (/OPÇÃO 1/.test(user)) {
    if (/EN: </.test(user)) {
      return [
        "OPÇÃO 1 (direta)",
        "EN: I have three years building Wake storefronts, mostly focused on speed.",
        "PT: Tenho três anos construindo lojas na Wake, com foco em velocidade.",
        "OPÇÃO 2 (mais elaborada)",
        "EN: I built and tuned Wake storefronts, and I usually start by measuring the page before I change anything.",
        "PT: Eu construí e ajustei lojas na Wake e costumo começar medindo a página antes de mudar qualquer coisa.",
      ].join("\n");
    }
    return [
      "OPÇÃO 1 (direta)",
      "PT: Tenho três anos de experiência com lojas na Wake, focado em velocidade.",
      "OPÇÃO 2 (mais elaborada)",
      "PT: Eu construí e ajustei lojas na Wake e costumo começar medindo a página antes de mudar qualquer coisa.",
    ].join("\n");
  }
  return "(demonstração) Resposta simulada em português: nenhuma chamada de IA foi feita.";
}
const MOCK_PREVIEW = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#222"/><text x="160" y="95" fill="#d9b04a" font-family="sans-serif" font-size="16" text-anchor="middle">Prévia simulada da tela</text></svg>')}`;

module.exports = { mockTranscribe, mockChat, resetMock, MOCK_PREVIEW, SCRIPT };
