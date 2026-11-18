"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createVault, editorView } = require("../src/vault-store");
const { createRendererGuard } = require("../src/ipc-guard");
const { redact } = require("../server/util");
const { isDuplicate } = require("../renderer/meeting/lineutil");

function fakeSafe() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text, "utf8"),
    decryptString: (buf) => Buffer.from(buf).toString("utf8"),
  };
}

test("cofre guarda chave e a tela só vê se está definida", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-vault-"));
  const vault = await createVault({ dir, safeStorage: fakeSafe() });
  await vault.setKey("groq", "gsk_dummy_not_a_real_key");
  assert.equal(vault.list().keys.hasGroqKey, true);
  assert.equal(vault.getKey("groq"), "gsk_dummy_not_a_real_key");
  const json = fs.readFileSync(vault.file, "utf8");
  assert.doesNotMatch(json, /gsk_dummy_not_a_real_key/);
});

test("editor nunca devolve senha em claro", () => {
  const view = editorView({ id: "1", nome: "x", senha: "segredo-123", valor: "tok" });
  assert.equal(view.senhaDefinida, true);
  assert.equal(view.senha, undefined);
  assert.equal(view.valor, undefined);
});

test("redact mascara chave no texto que iria ao modelo", () => {
  assert.match(redact("senha: hunter2tokenXYZ"), /\[segredo\]/);
});

test("guarda de IPC só aceita páginas do renderer", () => {
  const guard = createRendererGuard(path.join(__dirname, "..", "renderer"));
  const ok = path.join(__dirname, "..", "renderer", "index.html");
  const { pathToFileURL } = require("node:url");
  assert.equal(guard.isAllowedUrl(pathToFileURL(ok).href), true);
  assert.equal(guard.isAllowedUrl("https://evil.example/"), false);
});

test("falas repetidas não entram de novo na transcrição", () => {
  assert.equal(isDuplicate(["vamos alinhar o recorte agora sim"], "vamos alinhar o recorte agora sim"), true);
  assert.equal(isDuplicate(["olá"], "boa tarde pessoal"), false);
});
