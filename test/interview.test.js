"use strict";

/**
 * Entrevista (RH / recrutador, PT ou EN): sugestões respondem só a ÚLTIMA pergunta,
 * não repetem respostas anteriores, não buscam na web e traduzem o viva-voz.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const prompts = require("../src/meeting-prompts");
const providers = require("../src/providers");
const { PLAYBOOKS, getPlaybook, isInterview } = require("../src/playbooks");
const { createMeetingsStore } = require("../server/meetings-store");
const { createSettings } = require("../src/settings-store");
const { createVault } = require("../src/vault-store");
const { registerMeeting } = require("../src/meeting-host");

const L = (rows) => rows.map(([who, text], i) => ({ id: i + 1, who, text }));
const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (t) => Buffer.from(t, "utf8"),
  decryptString: (b) => Buffer.from(b).toString("utf8"),
};

async function setupHost(dir) {
  const meetings = createMeetingsStore(dir);
  const settings = createSettings(dir);
  const vault = await createVault({ dir, safeStorage: fakeSafeStorage });
  const handlers = new Map();
  registerMeeting({
    getWin: () => null, getMain: () => null, closeMeeting: () => {}, settings, vault, meetings, quit: () => {}, mock: false,
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
  return { meetings, settings, vault, handlers };
}

test("playbook de entrevista RH existe, é estilo entrevista e aparece no renderer", () => {
  const pb = getPlaybook("entrevista-rh");
  assert.equal(pb.id, "entrevista-rh");
  assert.equal(pb.style, "interview");
  assert.equal(isInterview("entrevista-rh"), true);
  assert.equal(isInterview("entrevista"), true);
  assert.equal(isInterview("daily"), false);
  assert.ok(PLAYBOOKS.some((p) => p.id === "entrevista-rh"));
  assert.match(read("renderer", "app.js"), /id: "entrevista-rh"/);
});

test("latestQuestion: só a última pergunta, costura pergunta cortada entre blocos", () => {
  assert.equal(prompts.latestQuestion(L([["them", "So can you tell me"], ["them", "about your experience with Shopify?"]])), "So can you tell me about your experience with Shopify?");
  const q = prompts.latestQuestion(L([["them", "Tell me about yourself."], ["me", "I work at Agência Oásis."], ["them", "Great. Why do you want this part-time role?"]]));
  assert.match(q, /part-time role/);
  assert.doesNotMatch(q, /yourself/);
  // Follow-up que referencia a resposta anterior
  assert.match(prompts.latestQuestion(L([["them", "What platforms do you use?"], ["me", "Mostly Wake and Nuvemshop."], ["them", "And how did you handle the migration you mentioned?"]])), /migration you mentioned/);
  // Recrutadora em português
  assert.match(prompts.latestQuestion(L([["them", "Legal. Me conta como você faz manutenção numa loja virtual?"]])), /manutenção numa loja/);
  // Mistura PT/EN
  assert.match(prompts.latestQuestion(L([["them", "Perfeito, vamos falar em inglês agora."], ["them", "How is your English?"]])), /How is your English\?/);
  // Viva-voz: tudo pelo microfone
  assert.match(prompts.latestQuestion(L([["me", "What is your availability?"]])), /availability/);
  // Silêncio / ruído
  assert.equal(prompts.latestQuestion([]), "");
  assert.equal(prompts.latestQuestion(L([["them", "   "]])), "");
  // Monólogo longo sem pergunta: pega só o final, com limite de tamanho
  const mono = Array.from({ length: 30 }, (_, i) => `We have point number ${i} about the store.`).join(" ");
  const tail = prompts.latestQuestion(L([["them", mono]]));
  assert.ok(tail.length <= 400);
  assert.match(tail, /point number 29/);
});

test("small talk não vira pitch completo", () => {
  assert.equal(prompts.isSmallTalk("Hi Helison, how are you?"), true);
  assert.equal(prompts.isSmallTalk("Can you hear me okay?"), true);
  assert.equal(prompts.isSmallTalk("Bom dia, tudo bem?"), true);
  assert.equal(prompts.isSmallTalk("Tell me about your experience with Shopify."), false);
  const blob = prompts.suggest(L([["them", "Hi Helison, how are you?"]]), { lang: "en", interview: true }).map((m) => m.content).join("\n");
  assert.match(blob, /conversa social/);
  assert.match(blob, /1 frase curta e simpática/);
  assert.doesNotMatch(blob, /## Pontos de apoio/);
});

test("prompt de entrevista: só a última pergunta, sem repetir, com substância e formato EN/PT", () => {
  const previous = [{ question: "Tell me about yourself.", answer: "EN: I maintain more than ten stores at Agência Oásis." }];
  const msgs = prompts.suggest(L([["them", "Tell me about yourself."], ["me", "I maintain more than ten stores."], ["them", "What experience do you have with Shopify?"]]), { lang: "en", interview: true, previous });
  const blob = msgs.map((m) => m.content).join("\n");
  assert.match(blob, /Responda SOMENTE a última pergunta/);
  assert.match(blob, /não junte várias respostas/);
  assert.match(blob, /NÃO repetir/);
  assert.match(blob, /I maintain more than ten stores at Agência Oásis/);
  assert.match(blob, /Nunca raso/);
  assert.match(blob, /fatos concretos do Perfil/);
  assert.match(blob, /situação, o que EU fiz e resultado/);
  assert.match(blob, /tamanho definido pela pergunta/);
  assert.doesNotMatch(blob, /\d a \d frases curtas/, "sem contagem fixa de frases");
  assert.match(blob, /resposta direta vem PRIMEIRO/);
  assert.match(blob, /## Pontos de apoio/);
  assert.match(blob, /ÚLTIMA PERGUNTA a responder[^"]*"""What experience do you have with Shopify\?"""/);
  assert.match(blob, /## Pergunta\nPT:/);
  assert.match(blob, /## Responda\nEN:/);
  assert.doesNotMatch(blob, /Dados reais pesquisados/);
  // PT continua possível
  const pt = prompts.suggest(L([["them", "Por que você quer essa vaga?"]]), { lang: "pt", interview: true }).map((m) => m.content).join("\n");
  assert.doesNotMatch(pt, /## Responda\nEN:/);
});

test("host: entrevista não usa busca, usa o modelo principal e lembra a última resposta para não repetir", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-interview-"));
  const { meetings, vault, handlers } = await setupHost(dir);
  await vault.setKey("groq", "gsk-test-interview");
  const created = meetings.create({ title: "Entrevista", playbook: "entrevista-rh", consented: true });
  await handlers.get("meetings:start")(null, created.id);

  const captured = [];
  const original = providers.groqChat;
  providers.groqChat = async (opts) => {
    captured.push(opts);
    return "## Pergunta\nPT: Fale de você.\n## Responda\nEN: I maintain more than ten stores at Agência Oásis.\nPT: Eu mantenho mais de dez lojas.\n## Se quiser completar\nEN: Which platform do you use?";
  };
  try {
    await handlers.get("ai:suggest")(null, L([["them", "Tell me about yourself."]]), "en", 0, false);
    await handlers.get("ai:suggest")(null, L([["them", "Tell me about yourself."], ["me", "I maintain stores."], ["them", "And what about Shopify?"]]), "en", 0, false);
  } finally {
    providers.groqChat = original;
  }
  assert.equal(captured.length, 2);
  assert.ok(captured.every((c) => c.search === false), "entrevista não busca na web");
  assert.equal(captured[0].model, "openai/gpt-oss-120b");
  const second = captured[1].messages.map((m) => m.content).join("\n");
  assert.match(second, /Respostas já sugeridas/);
  assert.match(second, /I maintain more than ten stores at Agência Oásis/);
  assert.match(second, /"""And what about Shopify\?"""/);
});

test("renderer: entrevista traduz o microfone em inglês e tem atalho EN: para dizer em inglês", () => {
  const app = read("renderer", "meeting", "app.js");
  assert.match(app, /function isInterviewSession\(\)/);
  assert.match(app, /LineUtil\.shouldTranslate\(line, currentLang\(\), isInterviewSession\(\)\)/);
  assert.match(app, /LineUtil\.replyLang\(state\.lines, currentLang\(\), isInterviewSession\(\)\)/);
  assert.match(app, /class="ans-pt"/);
  assert.match(app, /api\.sayEn\(sayMatch\[1\]\.trim\(\), rid\)/);
});

test("rede de segurança: número que não está no perfil vira aviso", () => {
  const src = "Mais de 10 lojas na Wake desde abr/2024. Estácio dez/2027.";
  const ok = prompts.flagUnsupportedNumbers("## Pergunta\nPT: x\n## Responda\nEN: I maintain more than 10 stores since 2024.", src);
  assert.doesNotMatch(ok, /Confira antes de falar/);
  const bad = prompts.flagUnsupportedNumbers("## Responda\nEN: Load time dropped from 4.2 to 2.1 seconds, about 20 % faster.", src);
  assert.match(bad, /Confira antes de falar: 4\.2, 2\.1, 20/);
});

test("ruído / fala incompleta não vira resposta longa", () => {
  const blob = prompts.suggest(L([["them", "uh... hmm"]]), { lang: "en", interview: true }).map((m) => m.content).join("\n");
  assert.match(blob, /parece ruído/);
  assert.doesNotMatch(blob, /## Pontos de apoio/);
  const real = prompts.suggest(L([["them", "Why Shopify?"]]), { lang: "en", interview: true }).map((m) => m.content).join("\n");
  assert.doesNotMatch(real, /parece ruído/);
  assert.match(real, /PROIBIDO inventar/);
});

test("entrevista: 429 no modelo principal cai na hora para o Gemini, sem esperar retry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-interview-429-"));
  const { meetings, vault, handlers } = await setupHost(dir);
  await vault.setKey("groq", "gsk-test-interview");
  await vault.setKey("gemini", "gm-test-interview");
  const created = meetings.create({ title: "Entrevista", playbook: "entrevista-rh", consented: true });
  await handlers.get("meetings:start")(null, created.id);
  const calls = [];
  const og = providers.groqChat;
  const ogm = providers.geminiChat;
  providers.groqChat = async (opts) => {
    calls.push({ p: "groq", m: opts.model, tries: opts.tries });
    throw Object.assign(new Error("HTTP 429"), { status: 429 });
  };
  providers.geminiChat = async (opts) => {
    calls.push({ p: "gemini", m: opts.model });
    return "## Pergunta\nPT: x\n## Responda\nEN: I maintain more than ten stores.\nPT: y";
  };
  let r;
  try {
    r = await handlers.get("ai:suggest")(null, L([["them", "Tell me about yourself."]]), "en", 0, false);
  } finally {
    providers.groqChat = og;
    providers.geminiChat = ogm;
  }
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.p), ["groq", "gemini"]);
  assert.equal(calls[0].tries, 1);
  assert.equal(calls[1].m, "gemini-flash-lite-latest");
  assert.match(r.provider, /Gemini/);
});
