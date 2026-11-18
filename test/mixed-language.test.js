"use strict";

/**
 * Roteiro de idiomas para a reunião mista PT/EN — entrevista Talent Works RH
 * (18/11, 13:30, vaga LHX7966: Dev Web Shopify e E-commerce, PJ part-time).
 * Cobertura: Auto misto (linha EN traduz + Alt+S em EN; linha PT + Alt+S em PT),
 * modo só EN, modo só PT sem disparo automático, perguntas típicas da vaga
 * (Shopify, loja, prazo, pretensão, inglês) e tradução real do lote EN→PT.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LineUtil = require("../renderer/meeting/lineutil");
const prompts = require("../src/meeting-prompts");
const { createMeetingsStore } = require("../server/meetings-store");
const { createSettings } = require("../src/settings-store");
const { createVault } = require("../src/vault-store");
const { registerMeeting } = require("../src/meeting-host");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (t) => Buffer.from(t, "utf8"),
  decryptString: (b) => Buffer.from(b).toString("utf8"),
};
const L = (rows) => rows.map(([who, text], i) => ({ id: i + 1, who, text }));

test("Auto misto: linha EN do interlocutor traduz; linha PT não; Alt+S segue a última fala deles", () => {
  const enLine = { id: 1, who: "them", text: "Can we ship the PDP this week?", lang: "en", pt: "" };
  const ptLine = { id: 2, who: "them", text: "Perfeito, então fechamos o escopo hoje.", lang: "pt", pt: "" };
  // Tradução: só o inglês ganha tradução em tempo real no Auto.
  assert.equal(LineUtil.shouldTranslate(enLine, "auto"), true, "linha EN traduz no Auto");
  assert.equal(LineUtil.shouldTranslate(ptLine, "auto"), false, "linha PT não traduz no Auto");
  assert.equal(LineUtil.shouldTranslate({ ...enLine, pt: "Podemos entregar a PDP esta semana?" }, "auto"), false, "linha já traduzida não reenfileira");
  // Alt+S: idioma da sugestão acompanha a última fala do interlocutor.
  assert.equal(LineUtil.replyLang([enLine], "auto"), "en", "depois de fala EN, sugestão em EN");
  assert.equal(LineUtil.replyLang([enLine, ptLine], "auto"), "pt", "depois de fala PT, sugestão em PT");
  assert.equal(LineUtil.replyLang([ptLine, enLine], "auto"), "en", "misto terminando em EN, sugestão em EN");
  assert.equal(LineUtil.replyLang([], "auto"), "pt", "sem falas ainda, sugestão em PT");
  // A própria fala do usuário nunca decide o idioma da sugestão (fora de entrevista).
  assert.equal(LineUtil.replyLang([{ id: 1, who: "me", text: "ok", lang: "en" }], "auto", false), "pt");

  // O renderer usa exatamente esta lógica (delegação em LineUtil).
  const app = read("renderer", "meeting", "app.js");
  assert.match(app, /return LineUtil\.shouldTranslate\(line, currentLang\(\), isInterviewSession\(\)\);/);
  assert.match(app, /return LineUtil\.replyLang\(state\.lines, currentLang\(\), isInterviewSession\(\)\);/);
  assert.match(app, /state\.settings\.meetingLang \|\| "auto"/);
});

test("Alt+S em EN devolve fala pronta em inglês + até 3 dados reais pesquisados; em PT, só português", () => {
  const en = prompts.suggest([{ who: "them", text: "What is your rate for this project?" }], { lang: "en" }).map((m) => m.content).join("\n");
  assert.match(en, /## O que falar agora/);
  assert.match(en, /EN: <fala pronta em 1ª pessoa>/);
  assert.match(en, /PT: <tradução fiel em português>/);
  assert.match(en, /## Dados reais pesquisados/);
  const pt = prompts.suggest([{ who: "them", text: "Qual o prazo para a PDP?" }], { lang: "pt" }).map((m) => m.content).join("\n");
  assert.match(pt, /## O que falar agora/);
  assert.match(pt, /## Dados reais pesquisados/);
  assert.doesNotMatch(pt, /^EN: </m, "sugestão PT não pede bloco EN");
});

test("Modo só EN: tudo que não for PT traduz e a sugestão sai em inglês", () => {
  assert.equal(LineUtil.shouldTranslate({ who: "them", lang: "en", pt: "" }, "en"), true);
  assert.equal(LineUtil.shouldTranslate({ who: "them", lang: "pt", pt: "" }, "en"), false);
  assert.equal(LineUtil.shouldTranslate({ who: "me", lang: "en", pt: "" }, "en"), false, "microfone próprio nunca traduz (fora de entrevista)");
  assert.equal(LineUtil.replyLang([{ who: "them", text: "oi", lang: "pt" }], "en"), "en");
});

test("Modo só PT: nada traduz, sugestão em português e nenhum card automático dispara", () => {
  assert.equal(LineUtil.shouldTranslate({ who: "them", lang: "en", pt: "" }, "pt"), false);
  assert.equal(LineUtil.replyLang([{ who: "them", text: "hello", lang: "en" }], "pt"), "pt");
  const app = read("renderer", "meeting", "app.js");
  assert.doesNotMatch(app, /detectQuestion|api\.detect/);
  assert.match(app, /who === "me" && state\.armVoiceAsk\) maybeVoiceAsk\(line\.text\)/);
});

test("Entrevista viva-voz: microfone EN também traduz e define o idioma da resposta", () => {
  const micEn = { id: 1, who: "me", text: "So, can you tell me about your experience?", lang: "en", pt: "" };
  assert.equal(LineUtil.shouldTranslate(micEn, "auto", true), true, "viva-voz EN pelo microfone traduz");
  assert.equal(LineUtil.shouldTranslate(micEn, "auto", false), false, "fora de entrevista, microfone não traduz");
  assert.equal(LineUtil.shouldTranslate({ ...micEn, lang: "pt" }, "auto", true), false, "microfone PT não traduz nem em entrevista");
  assert.equal(LineUtil.replyLang([micEn], "auto", true), "en", "sem fala them, microfone EN decide idioma");
  assert.equal(LineUtil.replyLang([micEn], "auto", false), "pt");
});

test("vaga Talent Works (Shopify, PJ part-time): perguntas típicas viram fala pronta EN curta, sem inventar CV", () => {
  // Perguntas-chave da vaga (Shopify, loja, prazo, pretensão, inglês) em EN e PT.
  const qs = [
    [["them", "Do you have any experience with Shopify and Liquid?"], /Shopify and Liquid\?/],
    [["them", "Can you tell me about a store you maintain today?"], /store you maintain today\?/],
    [["them", "What is your salary expectation for this part-time role?"], /salary expectation/],
    [["them", "How is your spoken English?"], /spoken English\?/],
    [["them", "How soon can you start?"], /How soon can you start\?/],
    [["them", "Qual a sua pretensão salarial?"], /pretensão salarial\?/],
    [["them", "Você já trabalhou com Shopify em produção?"], /Shopify em produção\?/],
    [["them", "Quantas horas por semana você consegue dedicar?"], /horas por semana/],
  ];
  for (const [rows, re] of qs) assert.match(prompts.latestQuestion(L([rows])), re);

  const msgs = prompts.suggest(L([["them", "Do you have any experience with Shopify?"]]), { lang: "en", interview: true });
  const blob = msgs.map((m) => m.content).join("\n");
  assert.match(blob, /"""Do you have any experience with Shopify\?"""/);
  // Anti-invenção: emprego, salário e anos só vêm do perfil verificado, nunca do modelo.
  assert.match(blob, /Nunca invente empresa, cliente, número, prazo, salário ou ferramenta/);
  assert.match(blob, /Use só fatos do Perfil/);
  // Fala pronta em inglês: 1ª pessoa, curta e pronunciável.
  assert.match(blob, /## Responda\nEN: </);
  assert.match(blob, /1ª pessoa, frases curtas e fáceis de pronunciar/);

  // Conversa social da recrutadora continua curta, sem pitch.
  const social = prompts.suggest(L([["them", "Nice to meet you, Helison."]]), { lang: "en", interview: true }).map((m) => m.content).join("\n");
  assert.match(social, /1 frase curta e simpática/);
  assert.doesNotMatch(social, /## Pontos de apoio/);
});

test("host: lote de tradução EN→PT funciona na hora (linha do interlocutor em inglês)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-misto-"));
  const meetings = createMeetingsStore(dir);
  const settings = createSettings(dir);
  const vault = await createVault({ dir, safeStorage: fakeSafeStorage });
  const handlers = new Map();
  registerMeeting({
    getWin: () => null, getMain: () => null, closeMeeting: () => {}, settings, vault, meetings, quit: () => {}, mock: true,
    electron: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
      shell: { openExternal: async () => {}, openPath: async () => "" },
      desktopCapturer: { getSources: async () => [] },
      screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }), getDisplayMatching: () => ({ workArea: { height: 1000 } }) },
      dialog: { showSaveDialog: async () => ({ canceled: true }) },
      clipboard: { readText: () => "" },
      app: { getPath: () => dir },
    },
  });
  const r = await handlers.get("ai:translateBatch")(null, [{ id: 1, text: "Thanks for joining. Let's lock the scope for this week." }], [], 0);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.match(r.items[0].pt, /Obrigado por entrar/);
  assert.match(r.items[0].pt, /recorte desta semana/);
});
