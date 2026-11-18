"use strict";

/**
 * Bateria de estresse anti-reembolso — HELIOS v0.3.1 (padrão Cluely Pro).
 * Cobertura: silêncio total na escuta, 2 abas principais (Respostas / Live Coding),
 * busca em tempo real obrigatória, tutorial mastigado de 3 seções e persistência
 * sem perda em erro 429/timeout.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LineUtil = require("../renderer/meeting/lineutil");
const prompts = require("../src/meeting-prompts");
const providers = require("../src/providers");
const { createMeetingsStore } = require("../server/meetings-store");
const { createSettings } = require("../src/settings-store");
const { createVault } = require("../src/vault-store");
const { registerMeeting, makeCache } = require("../src/meeting-host");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (t) => Buffer.from(t, "utf8"),
  decryptString: (b) => Buffer.from(b).toString("utf8"),
};

function fakeElectron(dir) {
  const handlers = new Map();
  return {
    handlers,
    electron: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
      shell: { openExternal: async () => {}, openPath: async () => "" },
      desktopCapturer: { getSources: async () => [] },
      screen: {
        getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }),
        getDisplayMatching: () => ({ workArea: { height: 1000 } }),
      },
      dialog: { showSaveDialog: async () => ({ canceled: true }) },
      clipboard: { readText: () => "const query = useSearch();" },
      app: { getPath: () => dir },
    },
  };
}

async function setupHost(dir, mock = false) {
  const meetings = createMeetingsStore(dir);
  const settings = createSettings(dir);
  const vault = await createVault({ dir, safeStorage: fakeSafeStorage });
  const { handlers, electron } = fakeElectron(dir);
  registerMeeting({
    getWin: () => null,
    getMain: () => null,
    closeMeeting: () => {},
    settings,
    vault,
    meetings,
    quit: () => {},
    mock,
    electron,
  });
  return { meetings, settings, vault, handlers };
}

test("silêncio total: escuta apenas transcreve, sem card automático e sem wake-word", () => {
  const app = read("renderer", "meeting", "app.js");
  const html = read("renderer", "meeting", "index.html");
  const preload = read("src", "preload-meeting.cjs");
  const host = read("src", "meeting-host.js");
  // Nenhum detector de pergunta automático, nenhum chip de pergunta, nenhum ai:detect.
  assert.doesNotMatch(app, /detectQuestion/);
  assert.doesNotMatch(app, /api\.detect/);
  assert.doesNotMatch(app, /LineUtil\.extractVoiceQuestion/);
  assert.doesNotMatch(app, /chipQ/);
  assert.doesNotMatch(html, /id="chipQ"/);
  assert.doesNotMatch(preload, /ai:detect/);
  assert.doesNotMatch(host, /ai:detect/);
  // A pergunta por voz só existe quando o usuário arma o microfone em #btnVoiceAsk.
  assert.match(app, /who === "me" && state\.armVoiceAsk\) maybeVoiceAsk\(line\.text\)/);
  // A escuta em si nunca abre balão sozinha.
  assert.doesNotMatch(app, /openCard\(true\);\s*\}\s*\r?\n\s*function hideQuestion/);
});

test("estresse: 120 linhas contínuas sem disparar nada e sem crescimento descontrolado", () => {
  // Fila de STT nunca passa do teto (chunks velhos caem, nada pendura na memória).
  let q = [];
  let dropped = 0;
  for (let i = 0; i < 120; i++) {
    const packed = LineUtil.enqueueStt(q, { blob: i, retry: false }, 4);
    q = packed.queue;
    if (packed.dropped) dropped += 1;
  }
  assert.ok(q.length <= 4, "fila de STT precisa ter teto duro");
  assert.ok(dropped > 0, "com 120 chunks seguidos, os mais velhos são descartados");

  // Costura de 120 linhas contínuas (overlap) sem acumular estado entre iterações.
  let prev = "";
  for (let i = 0; i < 120; i++) {
    const text = `Ponto ${i} ${i % 2 ? "decisão de arquitetura Storefront SSR" : "pendente de integração Nuvemshop Supabase"}.`;
    const stitched = prev ? LineUtil.trimOverlap(prev, text) : text;
    assert.ok(typeof stitched === "string" && stitched.length > 0);
    prev = stitched;
  }
  assert.equal(LineUtil.isDuplicate(["Vamos fechar o escopo da PDP hoje na Wake"], "Vamos fechar o escopo da PDP hoje na Wake"), true);
  assert.equal(LineUtil.isDuplicate(["Vamos fechar o escopo da PDP hoje na Wake"], "Cliente pediu destaque para kits na PDP"), false);

  // Cache LRU do host tem teto duro mesmo sob rajada.
  const cache = makeCache(300);
  for (let i = 0; i < 1200; i++) cache.set(`k${i}`, i);
  assert.equal(cache.size, 300);

  // Persistência incremental das 120 linhas no store em disco.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-120-"));
  const meetings = createMeetingsStore(dir);
  const created = meetings.create({ title: "Estresse 120 linhas", consented: true });
  meetings.start(created.id);
  const lines = Array.from({ length: 120 }, (_, i) => ({
    id: i + 1,
    who: i % 2 ? "me" : "them",
    text: `Linha ${i + 1}: avanço na migração da Nuvemshop com Supabase e Fbits.`,
  }));
  meetings.syncLines(created.id, lines);
  assert.equal(meetings.get(created.id).lines.length, 120);
});

test("duas abas principais: Respostas (Alt+S) e Live Coding (Alt+C) alternam pelo mesmo roteador", () => {
  const html = read("renderer", "meeting", "index.html");
  const app = read("renderer", "meeting", "app.js");
  assert.match(html, />Respostas</);
  assert.match(html, />Live Coding</);
  assert.match(html, /id="codeBox"/);
  assert.match(html, /id="btnGenGuide"/);
  assert.match(app, /function showCode\(\)/);
  assert.match(app, /state\.codeOpen = which === "code"/);
  assert.match(app, /\$\("codeBox"\)\.classList\.toggle\("hidden", !state\.codeOpen\)/);
  // Aba Live Coding abre o painel; o guia só nasce no botão ou no Alt+C — nunca automático.
  assert.match(app, /\$\("chipCode"\)\.onclick = \(\) => \{ openCard\(true\); showCode\(\); \};/);
  assert.match(app, /\$\("btnGenGuide"\)\.onclick = \(\) => runLiveCode\(\);/);
  assert.match(app, /else if \(n === "code"\) runLiveCode\(\);/);
  // Alternância rápida: todos os painéis passam por setActivePanel, mutuamente exclusivos.
  const router = app.slice(app.indexOf("function setActivePanel"), app.indexOf("function showTranscript"));
  assert.match(router, /which === "transcript"/);
  assert.match(router, /which === "notes"/);
  assert.match(router, /which === "code"/);
  assert.match(router, /which !== "answer"/);
});

test("busca em tempo real obrigatória: suggest, ask, research e livecode passam search: true ao provedor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-search-"));
  const { vault, handlers } = await setupHost(dir);
  await vault.setKey("groq", "gsk-stress-search");

  const captured = [];
  const original = providers.groqChat;
  providers.groqChat = async (opts) => {
    captured.push({ search: opts.search, model: opts.model });
    return { text: "ok" };
  };
  try {
    const lines = [{ id: 1, who: "them", text: "What is the current rate limit of the Groq API in production?" }];
    await handlers.get("ai:suggest")(null, lines, "pt", 0, false);
    await handlers.get("ai:ask")(null, lines, "qual é o limite atual?", false, 0);
    await handlers.get("ai:research")(null, lines, "Groq rate limit", 0);
    await handlers.get("ai:livecode")(null, lines, { promptHint: "two sum", useScreen: false }, 0);
  } finally {
    providers.groqChat = original;
  }
  assert.equal(captured.length, 4, "cada handler de assistência faz exatamente 1 chamada ao provedor");
  assert.ok(captured.every((c) => c.search === true), "todo handler de assistência deve pedir busca em tempo real");
});

test("suggest entrega fala pronta + dados reais pesquisados em 2 seções fixas", () => {
  const msgs = prompts.suggest([{ who: "them", text: "What is your current rate limit?" }], { lang: "pt", withScreen: true });
  const blob = msgs.map((m) => m.content).join("\n");
  assert.match(blob, /## O que falar agora/);
  assert.match(blob, /## Dados reais pesquisados/);
  assert.match(blob, /busca em tempo real/);
  assert.match(blob, /Sugestão de fala AGORA/);
  assert.match(blob, /Não invente números, prazos, fontes ou empresas/);
});

test("liveCoding entrega tutorial mastigado de 3 seções para digitar no VS Code", () => {
  const msgs = prompts.liveCoding(
    [{ who: "them", text: "Build a React hook for debounced search" }],
    { clipboardCode: "const query = useSearch();", promptHint: "hook de debounce", lang: "pt", withScreen: true }
  );
  const blob = msgs.map((m) => m.content).join("\n");
  assert.match(blob, /### 1\. Preparar no VS Code/);
  assert.match(blob, /- Pasta: <caminho exato onde entrar>/);
  assert.match(blob, /- Arquivo: <nome exato do arquivo a criar ou editar/);
  assert.match(blob, /- Terminal: <comando para instalar dependência/);
  assert.match(blob, /### 2\. Passo a passo do que digitar/);
  assert.match(blob, /Passo 2\.1: Imports e URL base/);
  assert.match(blob, /SEM comentários artificiais de IA/);
  assert.match(blob, /Tempo: O\(\.\.\.\) · Espaço: O\(\.\.\.\)/);
  assert.match(blob, /### 3\. O que falar enquanto digita/);
  assert.match(blob, /useSearch/);
  assert.match(blob, /busca em tempo real/);
});

test("anti-reembolso: erro 429 no encerramento não perde transcrição, notas nem prazo; ata segue regenerável", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-429-"));
  const { meetings, vault, handlers } = await setupHost(dir);
  await vault.setKey("groq", "gsk-stress-429");

  const created = meetings.create({ title: "Call Crítica 429", consented: true, notes: "[02:10] Cliente citou prazo de sexta" });
  await handlers.get("meetings:start")(null, created.id);
  const lines = [
    { id: 1, who: "them", text: "Precisamos da PDP pronta até sexta." },
    { id: 2, who: "me", text: "Fechado, subo a homologação amanhã." },
    { id: 3, who: "them", text: "Perfeito, avisa no grupo quando publicar." },
  ];
  meetings.syncLines(created.id, lines);

  const original = providers.groqChat;
  providers.groqChat = async () => {
    throw Object.assign(new Error("HTTP 429 (limite do plano gratuito atingido)"), { status: 429 });
  };
  let failed;
  try {
    failed = await handlers.get("meeting:wrapup")(null, lines, 1, 187000);
  } finally {
    providers.groqChat = original;
  }
  assert.equal(failed.ok, false);
  assert.equal(failed.rate, true);

  const saved = meetings.get(created.id);
  assert.equal(saved.status, "ended");
  assert.equal(saved.durationMs, 187000);
  assert.equal(saved.lines.length, 3);
  assert.equal(saved.notes, "[02:10] Cliente citou prazo de sexta");
  assert.match(saved.warn, /Regenerar ata/);
});
