"use strict";

const PLAYBOOKS = [
  {
    id: "geral",
    label: "Geral",
    defaultLang: "auto",
    objectivePlaceholder: "O que precisa ficar decidido nesta conversa",
    agendaTemplate: "",
    liveHint: "",
    wrapupHint: "",
  },
  {
    id: "ecommerce",
    label: "Cliente E-commerce (Wake / Nuvemshop)",
    defaultLang: "pt",
    objectivePlaceholder: "Alinhar escopo técnico, layout e publicação da loja",
    agendaTemplate: [
      "Escopo de vitrine, PDP, PLP ou checkout",
      "Aprovações pendentes e assets",
      "Integrações e plataforma (Wake, Scriban, Nuvemshop, VTEX, Fbits)",
      "Prazo de homologação e entrada no ar",
    ].join("\n"),
    liveHint: "Reunião de e-commerce: priorize clareza sobre escopo de loja (PDP, PLP, vitrine, checkout, Storefront SSR, Scriban, Nuvemshop, VTEX, Fbits), dependências de terceiros, homologação e o que fica fora do escopo.",
    wrapupHint: "Destaque no Resumo e Decisões o escopo técnico aprovado (páginas, plataforma, integrações) e o que ficou fora do escopo, somente se citado.",
  },
  {
    id: "daily",
    label: "Daily Agência",
    defaultLang: "pt",
    objectivePlaceholder: "Sincronizar entregas, foco do dia e bloqueios do time",
    agendaTemplate: [
      "O que foi entregue ontem",
      "Foco técnico de hoje",
      "Bloqueios, revisões de PR ou dependências",
    ].join("\n"),
    liveHint: "Reunião ágil de agência: mantenha respostas curtas e objetivas focadas em entregas concluídas, prioridade do dia, PRs, deploys e desbloqueios.",
    wrapupHint: "No Resumo, sintetize entregas citadas, foco do dia e bloqueios reais mencionados na conversa.",
  },
  {
    id: "entrevista",
    label: "Entrevista Técnica (PT / EN)",
    defaultLang: "auto",
    style: "interview",
    objectivePlaceholder: "Apresentar experiência real em frontend, e-commerce e automação com clareza",
    agendaTemplate: [
      "Apresentação objetiva da trajetória",
      "Projetos reais em produção e decisões técnicas",
      "Perguntas sobre o time, arquitetura e próximos passos",
    ].join("\n"),
    liveHint: "Conversa técnica profissional (PT ou EN): sugira falas diretas em 1ª pessoa conectando a pergunta apenas à experiência real descrita no perfil e na conversa. Se a fala vier em inglês, responda com EN: e PT:.",
    wrapupHint: "No Resumo e Decisões, registre os temas técnicos abordados, requisitos comentados pelo entrevistador e etapas futuras mencionadas.",
  },
  {
    id: "entrevista-rh",
    label: "Entrevista RH / Recrutador (EN)",
    defaultLang: "auto",
    style: "interview",
    objectivePlaceholder: "Passar na triagem com respostas honestas, curtas e em inglês simples",
    agendaTemplate: [
      "Apresentação (pitch de 60s)",
      "Experiência real em e-commerce e projetos",
      "Inglês, disponibilidade part-time e modelo PJ",
      "Minhas perguntas: plataforma, média de horas, próximos passos",
    ].join("\n"),
    liveHint: [
      "Entrevista de RH/recrutador (pessoas e cultura), provavelmente em inglês. Sem live coding.",
      "A pessoa entrevistada fala inglês avançado na leitura/escrita, mas está enferrujada na conversação: sugira frases curtas, simples e fáceis de falar em voz alta.",
      "Use só experiências reais do perfil e das notas. Se o perfil não sustentar algo, responda com honestidade e mostre como a experiência real se transfere. Nunca invente empresa, cliente, número, tempo de casa ou ferramenta.",
    ].join(" "),
    wrapupHint: "No Resumo, registre o que a recrutadora contou da vaga e do cliente, horas/remuneração citadas, dúvidas em aberto e próximas etapas mencionadas.",
  },
  {
    id: "saas",
    label: "Discovery SaaS",
    defaultLang: "pt",
    objectivePlaceholder: "Mapear dores operacionais, impacto e validação de produto (Ronda / Prancheta)",
    agendaTemplate: [
      "Fluxo atual da operação e gargalos",
      "Frequência e custo do problema hoje",
      "Demonstração focada na dor principal",
      "Critérios de decisão e próximo passo",
    ].join("\n"),
    liveHint: "Reunião de discovery/demo de SaaS: ajude a investigar a dor real do interlocutor, frequência do problema, objeções citadas e validação prática antes de falar de funcionalidades.",
    wrapupHint: "Destaque dores relatadas pelo interlocutor, objeções levantadas, sinais de valor percebido e o próximo passo combinado, sem inventar métricas.",
  },
];

const BY_ID = new Map(PLAYBOOKS.map((p) => [p.id, p]));

function normalizePlaybook(id) {
  const key = String(id || "").trim().toLowerCase();
  return BY_ID.has(key) ? key : "geral";
}

function getPlaybook(id) {
  return BY_ID.get(normalizePlaybook(id));
}

function isInterview(id) {
  const pb = getPlaybook(id);
  return Boolean(pb && pb.style === "interview");
}

module.exports = { PLAYBOOKS, normalizePlaybook, getPlaybook, isInterview };
