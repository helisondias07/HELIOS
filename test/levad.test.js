"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const policy = require("../server/model-policy");
const { createStore, maskDecidedCards } = require("../server/store");
const { createVoiceHandlers } = require("../src/voice-host");
const { runAll } = require("../scripts/eval");

const ROOT = path.join(__dirname, "..");
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-${name}-`));

test("fase 8: reserva de modelo passa para o próximo e avisa em português", () => {
  assert.equal(policy.nextModel([policy.GROK]).id, policy.COMPOSER);
  assert.equal(policy.nextModel([policy.COMPOSER]).id, policy.GROK);
  assert.equal(policy.nextModel([policy.COMPOSER, policy.GROK]), null);
  assert.equal(policy.nextModel([policy.COMPOSER], [{ id: policy.COMPOSER }]), null);
  assert.ok(policy.isModelFailure(new Error("x"), { kind: "rate" }));
  assert.ok(policy.isModelFailure(new Error("model grok-4.5 is not available")));
  assert.ok(!policy.isModelFailure(new Error("x"), { kind: "auth" }));
  assert.ok(!policy.isModelFailure(new Error("ferramenta falhou")));
  const aviso = policy.fallbackNotice("Grok", "Composer", { kind: "usage" });
  assert.match(aviso, /limite de uso/);
  assert.match(aviso, /não troca de conta/);
});

test("fase 8: o bot usa a reserva sem trocar de conta", () => {
  const bot = fs.readFileSync(path.join(ROOT, "server", "bot.js"), "utf8");
  assert.match(bot, /nextModel\(triedNow, catalog\)/);
  const block = bot.slice(bot.indexOf("const fallback = async"), bot.indexOf("const fallback = async") + 900);
  assert.doesNotMatch(block, /switchAccount|setActive|accounts\.use/);
  const host = fs.readFileSync(path.join(ROOT, "src", "meeting-host.js"), "utf8");
  assert.match(host, /reserva: \$\{firstLabel\}/);
});

test("fase 8: escalonamento de voz Groq -> Gemini com aviso; sem chave do Gemini só informa o erro", async () => {
  const fail = Object.assign(new Error("HTTP 429 gsk_testkey1234"), { status: 429 });
  const api = {
    groqTranscribe: async () => { throw fail; },
    geminiTranscribe: async () => ({ text: "olá" }),
    cleanHallucination: (t) => t,
  };
  const keys = { groq: "gsk_testkey1234", gemini: "AIza_testkey" };
  const both = createVoiceHandlers({ getKey: (n) => keys[n], api });
  const out = await both.transcribe(Buffer.from("abc"), "audio/webm");
  assert.equal(out.ok, true);
  assert.equal(out.text, "olá");
  assert.match(out.aviso, /Gemini/);
  const only = createVoiceHandlers({ getKey: (n) => (n === "groq" ? "gsk_testkey1234" : ""), api });
  const err = await only.transcribe(Buffer.from("abc"), "audio/webm");
  assert.equal(err.ok, false);
  assert.doesNotMatch(err.error, /gsk_testkey1234/);
});

test("segurança: cartões antigos decididos são mascarados uma vez, com cópia; pendentes ficam intactos", () => {
  const dir = tmp("mascara");
  const file = path.join(dir, "conversations.json");
  const secret = "gsk_testkey123456789";
  const conv = {
    id: "c1", assistantId: "default", title: "t", messages: [
      { id: "a1", role: "approval", state: "approved", summary: "rodar", detail: `token ${secret}`, action: { tipo: "mcp", mcp: { args: { senha: "minhasenha", q: secret, cidade: "Rio" } } } },
      { id: "a2", role: "approval", state: "pending", detail: "x", action: { mcp: { args: { senha: "fica" } } } },
    ],
  };
  fs.writeFileSync(file, JSON.stringify({ version: 2, items: [conv] }));
  const store = createStore(dir);
  const [done, pending] = store.get("c1").messages;
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes("minhasenha"));
  assert.equal(done.action.mcp.args.cidade, "Rio");
  assert.equal(pending.action.mcp.args.senha, "fica");
  assert.ok(fs.readFileSync(path.join(dir, "conversations.pre-mascara.json"), "utf8").includes(secret));
  assert.equal(JSON.parse(raw).cartoesMascarados.cartoes, 1);
  assert.equal(maskDecidedCards([{ messages: [done] }]), 0);
});

test("segurança: actions do CI fixadas por SHA", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    for (const [, ref] of text.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(ref, /@[0-9a-f]{40}$/, `${name}: ${ref}`);
  }
});

test("fase 8: conjunto de avaliação local passa (casos llm pulados sem chave)", async () => {
  const results = await runAll(path.join(ROOT, "evals", "casos.json"));
  const failed = results.filter((r) => !r.ok);
  assert.deepEqual(failed, []);
  assert.ok(results.filter((r) => !r.skip).length >= 8);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.eval, "node scripts/eval.js");
});
