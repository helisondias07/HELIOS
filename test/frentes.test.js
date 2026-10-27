"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cleanDictation } = require("../server/dictation");
const { createDictationPrefs } = require("../server/dictation-prefs");
const { createDictationStats, cleanAppName } = require("../server/dictation-stats");
const { createDictationSession } = require("../src/dictation-session");
const { parseAccelerator, watchRelease, releaseScript, startReleaseWatch } = require("../src/dictation-keys");
const { injectText, TEXT_SCRIPT, SCRIPT, encodeScript } = require("../src/vault-inject");
const { createSkills } = require("../server/skills");
const { createOnboarding } = require("../server/onboarding");
const { createAssistants } = require("../server/assistants");
const { createRoutines, dispatchDue, MORNING_PROMPT, MORNING_MODEL } = require("../server/routines");
const { createStore } = require("../server/store");
const { HELPER_TOOLS } = require("../server/delegation");
const { startServer } = require("../server/index");

test("ditado limpa vícios sem segunda chamada de modelo", () => {
  const cleaned = cleanDictation("ééé preciso, na verdade quero o botão azul", { style: "padrao" });
  assert.match(cleaned.text, /botão azul/i);
  assert.equal(cleaned.text.includes("na verdade"), false);
  assert.ok(cleaned.fixes >= 1);
  const email = cleanDictation("vc vai pra reunião", { style: "email" });
  assert.match(email.text, /você/i);
  assert.match(email.text, /para/);
  const raw = cleanDictation("ééé assim mesmo", { cleanup: false });
  assert.match(raw.text, /ééé/);
  const glossary = cleanDictation("chame a oasis hoje", { glossary: "oasis = Agência Oasis\nsk_segredo = nao" });
  assert.match(glossary.text, /Agência Oasis/);
  assert.equal(glossary.text.includes("sk_segredo"), false);
});

test("preferência do ditado nasce desligada e recusa atalho da reunião", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-ditado-"));
  const prefs = createDictationPrefs(dir);
  assert.equal(prefs.view().enabled, false);
  assert.equal(prefs.view().accelerator, "CommandOrControl+Shift+D");
  assert.throws(() => prefs.update({ accelerator: "CommandOrControl+Shift+Space" }), /atalho/i);
  const saved = prefs.update({ enabled: true, mode: "segurar", style: "email" });
  assert.equal(saved.enabled, true);
  assert.equal(saved.mode, "segurar");
});

test("estatística do ditado não aceita o texto falado", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-uso-"));
  const stats = createDictationStats(dir, { now: () => Date.parse("2026-10-27T12:00:00Z") });
  assert.throws(() => stats.record({ text: "segredo falado", words: 2 }), /não guarda/);
  assert.equal(cleanAppName("Code.exe"), "Code");
  assert.equal(cleanAppName("sk-super-secreto"), "desconhecido");
  const view = stats.record({ words: 12, chars: 40, fixes: 1, durationMs: 6000, app: "notepad.exe" });
  assert.equal(view.hoje.words, 12);
  assert.equal(JSON.stringify(view).includes("segredo"), false);
});

test("a sessão de ditado não devolve a transcrição e só conta depois de digitar", async () => {
  const seen = [];
  const session = createDictationSession({
    transcribe: async () => ({ ok: true, text: "frase secreta do helison" }),
    clean: (text) => ({ text, fixes: 1 }),
    inject: async (text) => {
      seen.push(text);
      return { ok: true };
    },
    record: async (stats) => {
      assert.equal(stats.text, undefined);
      assert.equal(stats.words, 4);
    },
    appName: () => "bloco",
  });
  await session.begin();
  const done = await session.deliver({ audio: Buffer.from("abc"), mime: "audio/webm", durationMs: 1000 });
  assert.equal(done.ok, true);
  assert.equal(JSON.stringify(done).includes("frase secreta"), false);
  assert.equal(seen.length, 1);

  const fail = createDictationSession({
    transcribe: async () => ({ ok: false, error: "frase secreta do helison" }),
    clean: (text) => ({ text, fixes: 0 }),
    inject: async () => ({ ok: true }),
    record: async () => { throw new Error("não devia contar"); },
  });
  await fail.begin();
  const bad = await fail.deliver({ audio: Buffer.from("a") });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /transcrever/);
  assert.equal(bad.error.includes("frase secreta"), false);
});

test("segurar a tecla só observa no Windows e o script não leva texto", async () => {
  const parsed = parseAccelerator("CommandOrControl+Shift+D");
  assert.deepEqual(parsed.vks, [0x11, 0x10, 0x44]);
  const script = releaseScript(parsed.vks);
  assert.match(script, /0x11|17/);
  assert.equal(script.includes("frase"), false);
  const warned = watchRelease({ platform: "linux", onRelease() {} });
  assert.equal(warned.watching, false);
  assert.match(warned.warning, /Windows/);
  let spawned = 0;
  const held = startReleaseWatch({ platform: "linux", spawn() { spawned += 1; }, onRelease() {} });
  assert.equal(held.watching, false);
  assert.equal(spawned, 0);
  await new Promise((resolve) => {
    watchRelease({ vks: [1], platform: "win32", intervalMs: 5, poll: () => false, onRelease: resolve });
  });
});

test("digitar texto vazio não mexe na área de transferência", async () => {
  let spawned = 0;
  const empty = await injectText({ texto: "   " }, { platform: "win32", spawn() { spawned += 1; } });
  assert.equal(empty.ok, false);
  assert.equal(spawned, 0);
  assert.match(TEXT_SCRIPT, /ExcludeClipboardContentFromMonitorProcessing/);
  assert.match(TEXT_SCRIPT, /Clipboard]::Clear/);
  assert.equal(encodeScript(), encodeScript(SCRIPT));
  assert.notEqual(TEXT_SCRIPT, SCRIPT);
});

test("skill é prévia, não executa e recusa programa ou caminho", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-skill-"));
  const skills = createSkills(dir);
  const preview = skills.preview({
    markdown: "---\nname: aula\ndescription: explicar uma página\n---\nEnsine o botão. Token sk-1234567890abcdefghijklmnopqrstuv.\n",
  });
  assert.equal(preview.executed, false);
  assert.equal(preview.instrucoes.includes("sk-1234567890abcdefghijklmnopqrstuv"), false);
  assert.throws(() => skills.apply({ markdown: preview.instrucoes, confirmar: false }));
  assert.throws(() => skills.preview({ arquivos: [{ caminho: "../segredo.md", conteudo: "texto de instrução longo" }] }));
  assert.throws(() => skills.preview({ arquivos: [{ caminho: "bin/rodar.exe", conteudo: "texto de instrução longo" }] }));
  assert.throws(() => skills.preview(JSON.parse('{"__proto__":{"admin":true},"nome":"Ruim","instrucoes":"texto de instrução longo"}')));
  const saved = skills.apply({ markdown: "---\nname: aula\ndescription: explicar uma página\n---\nEnsine o botão com calma e um exemplo.\n", confirmar: true });
  assert.equal(skills.read(saved.id).instrucoes.includes("botão"), true);
  const oasis = skills.installOasis();
  assert.equal(oasis.origem, "pagina-oasis");
  assert.equal(skills.installOasis().id, oasis.id);
  assert.equal(HELPER_TOOLS.includes("ler_skill"), false);
});

test("montar o time só cria o que foi escolhido", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-time-"));
  const assistants = createAssistants(dir);
  const routines = createRoutines(dir);
  const team = createOnboarding({ dataDir: dir, assistants, routines });
  const vague = team.propose("quero um time");
  assert.equal(vague.executed, false);
  assert.deepEqual(vague.propostas.map((item) => item.id), ["caixa-de-entrada", "agenda", "pesquisa"]);
  const fiscal = team.propose("preciso emitir nota fiscal e cuidar de marketplace");
  assert.match(fiscal.aviso, /Nota fiscal/);
  assert.equal(fiscal.propostas.every((item) => item.id !== "nota-fiscal"), true);
  const applied = team.aplicar(["agenda"]);
  assert.equal(applied.created.length, 1);
  assert.equal(applied.created[0].template, "agenda");
  const again = team.aplicar(["agenda"]);
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped.length, 1);
  team.mark({ voz: true });
  const check = team.checklist();
  assert.equal(check.itens.find((item) => item.id === "voz").done, true);
  assert.equal(check.itens.find((item) => item.id === "time").done, true);
});

test("digest da manhã entra pausado e a conversa fica só leitura", async () => {
  assert.ok(MORNING_PROMPT.length <= 1000);
  assert.equal(/\b(enviar|envia|mandar|apagar|apague|excluir|pagar|pague|publicar)\b/i.test(MORNING_PROMPT), false);
  assert.equal(/\bpesquis/.test(MORNING_PROMPT), false);
  assert.equal(/preencher login|escrever arquivo|grav\w+\s+(?:o\s+)?arquivo/i.test(MORNING_PROMPT), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-manha-"));
  const routines = createRoutines(dir);
  const store = createStore(dir);
  const first = routines.installMorning();
  assert.equal(first.enabled, false);
  assert.equal(first.readOnly, true);
  assert.equal(first.modelo, MORNING_MODEL);
  assert.equal(first.clock, "08:00");
  assert.equal(routines.installMorning().id, first.id);
  routines.update(first.id, { enabled: true });
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(8, 0, 0, 0);
  let convId = "";
  dispatchDue({
    routines,
    store,
    at: at.getTime(),
    send(id) { convId = id; },
  });
  assert.equal(store.get(convId).readOnly, true);

  const app = await startServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "helios-manha-api-")), port: 0, mock: true, routineMs: 0, getMcpToken: () => "tok-manha", getApiToken: () => "api-manha" });
  try {
    const headers = { "content-type": "application/json", authorization: "Bearer api-manha" };
    const installed = await fetch(`${app.url}/api/routines/digest-manha`, { method: "POST", headers, body: "{}" }).then((res) => res.json());
    const routineId = installed.routine.id;
    await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-manha" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "helios_rodar_rotina", arguments: { id: routineId } } }),
    });
    const list = await fetch(`${app.url}/api/conversations`, { headers }).then((res) => res.json());
    const conv = list.conversations.find((item) => item.title.includes("Digest"));
    assert.ok(conv, "a rotina não abriu conversa");
    assert.equal(conv.readOnly, true);
    let fresh = null;
    for (let i = 0; i < 80; i += 1) {
      fresh = await fetch(`${app.url}/api/conversations/${conv.id}`, { headers }).then((res) => res.json());
      if (!fresh.conversation.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fresh.conversation.busy, false);
    assert.equal(fresh.conversation.messages.some((message) => message.role === "approval"), false);
    const sent = await fetch(`${app.url}/api/conversations/${conv.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "pagar a conta agora" }) });
    assert.equal(sent.status, 202);
    let after = null;
    for (let i = 0; i < 40; i += 1) {
      after = await fetch(`${app.url}/api/conversations/${conv.id}`, { headers }).then((res) => res.json());
      if (!after.conversation.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(after.conversation.messages.some((message) => message.role === "approval"), false);
  } finally {
    await app.close();
  }
});

test("o agente que planeja o roteiro continua sem ferramenta e em sandbox", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "bot.js"), "utf8");
  assert.match(src, /withCustomTools:\s*false/);
  assert.match(src, /sandboxOptions:\s*\{\s*enabled:\s*true\s*\}/);
  assert.equal(src.includes("writeFiles"), false);
  const meeting = fs.readFileSync(path.join(__dirname, "..", "renderer", "meeting", "app.js"), "utf8");
  assert.equal(/VS Code/.test(meeting), false);
});
