"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LineUtil = require("../renderer/meeting/lineutil");
const rolling = require("../src/rolling-summary");
const { PLAYBOOKS, getPlaybook, normalizePlaybook } = require("../src/playbooks");
const prompts = require("../src/meeting-prompts");
const wrapupLib = require("../src/meeting-wrapup");
const mctx = require("../src/meeting-context");
const { readGeminiSSE } = require("../src/providers");
const { createMeetingsStore } = require("../server/meetings-store");
const { createSettings } = require("../src/settings-store");
const { createVault } = require("../src/vault-store");
const { registerMeeting, transcribeLang } = require("../src/meeting-host");
const { writeJson, readJson } = require("../server/util");

test("lineutil: corte rápido < 2s (550ms silêncio), sobreposição 400ms e costura trimOverlap", () => {
  assert.equal(LineUtil.SILENCE_MS, 550);
  assert.equal(LineUtil.OVERLAP_MS, 400);
  assert.equal(LineUtil.shouldCut({ elapsedMs: 1400, maxMs: 5000, voicedMs: 300, silentMs: 550 }), true);
  assert.equal(LineUtil.shouldCut({ elapsedMs: 1400, maxMs: 5000, voicedMs: 300, silentMs: 400 }), false);
  assert.equal(LineUtil.shouldCutVoice({ elapsedMs: 750, voicedMs: 250, silentMs: 550 }), true);
  assert.equal(LineUtil.shouldStartOverlap({ elapsedMs: 4600, maxMs: 5000 }), true);
  assert.equal(LineUtil.shouldStartOverlap({ elapsedMs: 3000, maxMs: 5000 }), false);
  assert.equal(
    LineUtil.trimOverlap("vamos revisar o checkout agora", "o checkout agora na loja Wake"),
    "na loja Wake"
  );
});

test("lineutil: pergunta por voz exige wake-word explícita Helios e ignora perguntas feitas ao interlocutor", () => {
  assert.equal(LineUtil.isVoiceQuestion("Qual gateway vocês usam hoje na loja?"), false);
  assert.equal(LineUtil.isVoiceQuestion("Quando podemos homologar na Wake?"), false);
  assert.equal(LineUtil.isVoiceQuestion("Por que o frete subiu ontem?"), false);
  assert.equal(LineUtil.isVoiceQuestion("Helios, qual foi o prazo que ele acabou de citar?"), true);
  assert.equal(
    LineUtil.extractVoiceQuestion("Ei Hélios, como eu explico Storefront SSR em inglês?"),
    "como eu explico Storefront SSR em inglês?"
  );
});

test("transcribeLang respeita PT, EN e Auto sem travar inglês", () => {
  assert.equal(transcribeLang("auto", "them", "pt"), "pt");
  assert.equal(transcribeLang("auto", "them", "en"), "en");
  assert.equal(transcribeLang("en", "me", "en"), "auto");
  assert.equal(transcribeLang("auto", "them", "auto"), "auto");
});

test("whisperPrompt injeta termos do glossário e ignora segredos", () => {
  const parsed = mctx.parseGlossary("Wake = e-commerce\nScriban = template\ntoken = sk-abcdefghijklmnopqrstuvwxyz0123456789");
  const wp = mctx.whisperPrompt(parsed.entries);
  assert.match(wp, /Wake/);
  assert.match(wp, /Scriban/);
  assert.doesNotMatch(wp, /sk-/);
});

test("readGeminiSSE entrega deltas incrementais em tempo real", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Sugestão: Vamos "}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"validar o checkout na Wake."}]}}]}\n\n',
  ];
  const body = (async function* () {
    for (const c of chunks) yield encoder.encode(c);
  })();
  const deltas = [];
  const final = await readGeminiSSE({ body }, (acc) => deltas.push(acc));
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0], "Sugestão: Vamos ");
  assert.equal(final, "Sugestão: Vamos validar o checkout na Wake.");
});

test("rollingSummary preserva contexto de reuniões de 60+ min no transcriptBlock", async () => {
  const manyLines = Array.from({ length: 45 }, (_, i) => ({
    id: i + 1,
    who: i % 2 === 0 ? "them" : "me",
    text: `Ponto discutido número ${i + 1}: orçamento aprovado de R$ ${(i + 1) * 1000} e integração com Nuvemshop e Supabase.`,
  }));
  const rec = prompts.recent(manyLines);
  assert.ok(rec.length < manyLines.length, "janela recente não carrega todas as 45 falas cruas");

  const fallbackRoll = rolling.effectiveRollingSummary({ lines: manyLines, recentLines: rec });
  assert.match(fallbackRoll, /Ponto discutido número 1/);

  const advanced = await rolling.advanceRollingState({
    lines: manyLines,
    recentCount: rec.length,
    savedSummary: "",
    summarizedCount: 0,
    chatFn: async () => ({ text: "- Orçamento inicial citado no minuto 1: R$ 1000\n- Escopo: Nuvemshop + Supabase" }),
  });
  assert.equal(advanced.updated, true);
  assert.ok(advanced.count > 0);

  const block = prompts.transcriptBlock(manyLines, { rollingSummary: advanced.summary });
  assert.match(block, /Orçamento inicial citado no minuto 1/);
  assert.match(block, /Ponto discutido número 45/);
});

test("generateWrapup sumariza em blocos quando transcrição passa de 12.000 caracteres e funde notas humanas", async () => {
  const longLines = Array.from({ length: 140 }, (_, i) => ({
    id: i + 1,
    who: i % 2 === 0 ? "them" : "me",
    text: `Bloco longo ${i + 1}: alinhamento detalhado sobre arquitetura Storefront SSR, Scriban, cache de vitrine e homologação com cliente.`,
  }));
  const calls = [];
  const fakeChat = async (msgs, opts) => {
    calls.push({ sys: msgs[0].content, user: msgs[1].content, fast: Boolean(opts && opts.fast) });
    if (opts && opts.fast) return { text: `- Fato extraído do bloco ${calls.length}`, provider: "mock" };
    return {
      text: "## Resumo\nReunião longa coberta do início ao fim.\n\n## Decisões\n- Aprovar vitrine SSR\n\n## Pendências\n- Você: publicar homologação até quarta\n\n## Próximos passos\n- Validar métricas",
      provider: "mock",
    };
  };
  const res = await wrapupLib.generateWrapup(longLines, {
    title: "Arquitetura Loja",
    notes: "[03:15] Cliente pediu destaque para kits na PDP",
    playbook: "ecommerce",
  }, fakeChat);
  assert.ok(calls.length >= 3, "executou sumarização por blocos + síntese final");
  const finalCall = calls[calls.length - 1];
  assert.match(finalCall.user, /Notas humanas registradas pelo usuário/);
  assert.match(finalCall.user, /kits na PDP/);
  assert.match(finalCall.user, /Síntese factual completa por blocos/);
  assert.match(res.text, /Aprovar vitrine SSR/);
});

test("playbooks, checklist e exportação Markdown funcionam para todos os perfis", () => {
  assert.equal(PLAYBOOKS.length, 5);
  assert.equal(normalizePlaybook("ecommerce"), "ecommerce");
  assert.equal(normalizePlaybook("inexistente"), "geral");
  assert.match(getPlaybook("saas").liveHint, /dor real/i);

  const md = wrapupLib.formatMeetingMarkdown({
    title: "Sync Loja Wake",
    startedAt: "2026-11-18T10:00:00.000Z",
    durationMs: 185000,
    mode: "meeting",
    playbook: "ecommerce",
    objective: "Fechar escopo da PDP",
    notes: "[01:20] Confirmar ERP",
    wrapup: {
      resumo: "Escopo alinhado.",
      decisoes: ["Usar Scriban nativo"],
      pendencias: [{ text: "Você: subir branch", done: true }],
      proximosPassos: [{ text: "Cliente: validar layout", done: false }],
    },
    lines: [{ who: "them", text: "Need PDP ready", pt: "Precisamos da PDP pronta" }],
  });
  assert.match(md, /# Sync Loja Wake/);
  assert.ok(md.includes("- [x] Você: subir branch"));
  assert.ok(md.includes("- [ ] Cliente: validar layout"));
  assert.match(md, /## Notas da reunião/);
  assert.match(md, /Precisamos da PDP pronta/);
});

test("prompts de Consulta de Assunto (Alt+P) e Modo Código (Alt+C) seguem estrutura de 3 blocos", () => {
  const resMsgs = prompts.researchTopic([{ who: "them", text: "We use Scriban on Storefront SSR" }], "Scriban");
  assert.match(resMsgs[0].content, /Definição:/);
  assert.match(resMsgs[1].content, /Scriban/);

  const codeMsgs = prompts.liveCoding(
    [{ who: "them", text: "Optimize this array lookup" }],
    { clipboardCode: "function findDup(arr) { return arr; }", promptHint: "usar Set", lang: "en", withScreen: true }
  );
  const blob = codeMsgs.map((m) => m.content).join("\n");
  assert.ok(blob.includes("### 1. O que falar agora"));
  assert.ok(blob.includes("### 2. Código limpo & Complexidade"));
  assert.ok(blob.includes("### 3. Debug / Edge cases"));
  assert.match(blob, /findDup/);
});

test("persistência Zero-Perda: syncLines incremental + wrapup salva transcrição ANTES de falha 429 do LLM e regenera depois", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-zeroloss-"));
  const writeCheck = path.join(dir, "atomic.json");
  writeJson(writeCheck, { ok: true, n: 1 });
  writeJson(writeCheck, { ok: true, n: 2 });
  assert.deepEqual(readJson(writeCheck, null), { ok: true, n: 2 });

  const meetings = createMeetingsStore(dir);
  const settings = createSettings(dir);
  const vault = await createVault({
    dir,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (t) => Buffer.from(t, "utf8"),
      decryptString: (b) => Buffer.from(b).toString("utf8"),
    },
  });

  const handlers = new Map();
  const fakeElectron = {
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
    shell: { openExternal: async () => {}, openPath: async () => "" },
    desktopCapturer: { getSources: async () => [] },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }), getDisplayMatching: () => ({ workArea: { height: 1000 } }) },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    clipboard: { readText: () => "const a = 1;" },
    app: { getPath: () => dir },
  };

  registerMeeting({
    getWin: () => null,
    getMain: () => null,
    closeMeeting: () => {},
    settings,
    vault,
    meetings,
    quit: () => {},
    mock: false,
    electron: fakeElectron,
  });

  const created = await handlers.get("meetings:create")(null, { title: "Call Crítica", consented: true, notes: "[00:30] Nota vital" });
  await handlers.get("meetings:start")(null, created.id);

  // Sync incremental durante a reunião + atualização de tradução na mesma linha
  await handlers.get("meetings:sync-lines")(null, created.id, [{ id: 1, who: "them", text: "Hello team", lang: "en" }]);
  await handlers.get("meetings:sync-lines")(null, created.id, [
    { id: 1, who: "them", text: "Hello team", lang: "en", pt: "Olá time" },
    { id: 2, who: "me", text: "Vamos fechar o escopo hoje.", lang: "pt" },
  ]);
  assert.equal(meetings.get(created.id).lines.length, 2);
  assert.equal(meetings.get(created.id).lines[0].pt, "Olá time");

  // Sem chave no cofre, o LLM vai falhar no wrapup — mas a sessão e as falas DEVEM estar salvas como "ended"!
  const failedWrap = await handlers.get("meeting:wrapup")(null, meetings.get(created.id).lines, 1, 95000);
  assert.equal(failedWrap.ok, false);

  const savedAfterFailure = meetings.get(created.id);
  assert.equal(savedAfterFailure.status, "ended");
  assert.equal(savedAfterFailure.durationMs, 95000);
  assert.equal(savedAfterFailure.lines.length, 2);
  assert.match(savedAfterFailure.warn, /Regenerar ata/);

  // Agora em modo mock, testamos Regenerar ata, Consulta de Assunto e Live Coding
  const handlersMock = new Map();
  registerMeeting({
    getWin: () => null,
    getMain: () => null,
    closeMeeting: () => {},
    settings,
    vault,
    meetings,
    quit: () => {},
    mock: true,
    electron: { ...fakeElectron, ipcMain: { handle: (ch, fn) => handlersMock.set(ch, fn), on: () => {} } },
  });

  const regen = await handlersMock.get("meetings:regenerate")(null, created.id);
  assert.equal(regen.ok, true);
  assert.equal(meetings.get(created.id).warn, "");
  assert.ok(meetings.get(created.id).wrapup.resumo.length > 10);

  const research = await handlersMock.get("ai:research")(null, savedAfterFailure.lines, "Wake", 0);
  assert.equal(research.ok, true);
  assert.match(research.text, /O que é|Definição|Ponto-chave/);

  const livecode = await handlersMock.get("ai:livecode")(null, savedAfterFailure.lines, { promptHint: "two sum" }, 0);
  assert.equal(livecode.ok, true);
  assert.ok(livecode.text.includes("### 2. Código limpo & Complexidade"));
});
