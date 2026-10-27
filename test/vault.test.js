"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createVault, editorView } = require("../src/vault-store");
const { importKeyFile } = require("../src/import-keys");
const { injectLogin, SCRIPT } = require("../src/vault-inject");

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "helios-vault-"));
}

const XOR = 0x5a;
const xor = (text) => Buffer.from(String(text), "utf8").map((byte) => byte ^ XOR);
const unxor = (buf) => Buffer.from(buf).map((byte) => byte ^ XOR).toString("utf8");

/** safeStorage de antes (só síncrono), como o Electron 44 já aceitava. */
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: xor,
    decryptString: unxor,
  };
}

/** safeStorage com a API assíncrona. `sync: false` simula o Electron 46, sem a API síncrona. */
function fakeAsyncStorage({ sync = true, rotate = false, calls = [] } = {}) {
  const api = {
    calls,
    isAsyncEncryptionAvailable: async () => true,
    async encryptStringAsync(text) {
      calls.push("encAsync");
      return xor(text);
    },
    async decryptStringAsync(buf) {
      calls.push("decAsync");
      return { shouldReEncrypt: rotate && calls.filter((item) => item === "decAsync").length % 2 === 1, result: unxor(buf) };
    },
  };
  if (sync) {
    api.isEncryptionAvailable = () => true;
    api.encryptString = (text) => { calls.push("encSync"); return xor(text); };
    api.decryptString = (buf) => { calls.push("decSync"); return unxor(buf); };
  }
  return api;
}

const NO_CRYPTO = {
  isEncryptionAvailable: () => false,
  encryptString() { throw new Error("não"); },
  decryptString() { throw new Error("não"); },
};

test("o cofre grava cifrado e a lista não devolve senha", async () => {
  const root = dir();
  const vault = await createVault({ dir: root, safeStorage: fakeSafeStorage() });
  const login = await vault.saveLogin({ nome: "GitHub", usuario: "helison", senha: "senha-muito-secreta", url: "https://github.com" });
  await vault.setKey("groq", "gsk_abcdef1234567890");
  const listed = vault.list();
  assert.equal(listed.persisted, true);
  assert.equal(listed.logins[0].senha, undefined);
  assert.equal(listed.keys.hasGroqKey, true);
  assert.equal(JSON.stringify(listed).includes("senha-muito-secreta"), false);
  const disk = fs.readFileSync(vault.file, "utf8");
  assert.equal(disk.includes("senha-muito-secreta"), false);
  assert.equal(disk.includes("gsk_abcdef1234567890"), false);
  const editor = editorView(vault.getLogin(login.id));
  assert.equal(editor.usuario, "helison");
  assert.equal(editor.senha, undefined);
  assert.equal(JSON.stringify(editor).includes("senha-muito-secreta"), false);
  await vault.saveToken({ nome: "npm", valor: "token-muito-secreto" });
  const token = vault.list().tokens[0];
  const tokenEditor = editorView(vault.getToken(token.id));
  assert.equal(tokenEditor.valor, undefined);
  assert.equal(JSON.stringify(tokenEditor).includes("token-muito-secreto"), false);
  const again = await createVault({ dir: root, safeStorage: fakeSafeStorage() });
  assert.equal(again.getLogin(login.id).senha, "senha-muito-secreta");
  assert.equal(again.getKey("groq"), "gsk_abcdef1234567890");
  assert.equal(again.list().logins[0].usuario, "helison");
});

test("o token de acesso do MCP fica cifrado e fora da lista", async () => {
  const root = dir();
  const vault = await createVault({ dir: root, safeStorage: fakeSafeStorage() });
  await assert.rejects(() => vault.setKey("mcp", "nao-entra-por-aqui"), /desconhecida/);
  const access = await vault.mcpAccess();
  assert.equal(access.persisted, true);
  assert.ok(access.token.length >= 32);
  assert.equal(vault.mcpToken(), access.token);
  assert.equal(JSON.stringify(vault.list()).includes(access.token), false);
  assert.equal(JSON.stringify(vault.index()).includes(access.token), false);
  assert.equal(fs.readFileSync(vault.file, "utf8").includes(access.token), false);
  const next = await vault.regenerateMcpToken();
  assert.notEqual(next.token, access.token);
  const again = await createVault({ dir: root, safeStorage: fakeSafeStorage() });
  assert.equal((await again.mcpAccess()).token, next.token);
});

test("o token da API local fica fora da lista", async () => {
  const root = dir();
  const vault = await createVault({ dir: root, safeStorage: fakeSafeStorage() });
  const access = await vault.apiAccess();
  assert.equal(access.persisted, true);
  assert.equal(JSON.stringify(vault.list()).includes(access.token), false);
  assert.equal(JSON.stringify(vault.index()).includes(access.token), false);
  assert.notEqual(access.token, (await vault.mcpAccess()).token);
});

test("arquivo de chaves solto só some depois de persistir", async () => {
  const root = dir();
  const file = path.join(root, "keys.json");
  fs.writeFileSync(file, JSON.stringify({ groq: "gsk_arquivo_local_12345678" }));
  const locked = await createVault({ dir: path.join(root, "sem-cifra"), safeStorage: NO_CRYPTO });
  const kept = await importKeyFile(file, locked);
  assert.equal(kept.removed, false);
  assert.equal(fs.existsSync(file), true);
  const open = await createVault({ dir: path.join(root, "com-cifra"), safeStorage: fakeSafeStorage() });
  const removed = await importKeyFile(file, open);
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(open.getKey("groq"), "gsk_arquivo_local_12345678");
});

test("sem criptografia o token MCP não vai para o disco", async () => {
  const vault = await createVault({ dir: dir(), safeStorage: NO_CRYPTO });
  const access = await vault.mcpAccess();
  assert.equal(access.persisted, false);
  assert.equal(fs.existsSync(vault.file), false);
  assert.equal((await vault.mcpAccess()).token, access.token);
  assert.equal(JSON.stringify(vault.list()).includes(access.token), false);
});

test("sem criptografia do sistema o cofre não grava segredo em disco", async () => {
  const root = dir();
  const vault = await createVault({ dir: root, safeStorage: NO_CRYPTO });
  await vault.saveLogin({ nome: "GitHub", usuario: "helison", senha: "outra-senha-secreta" });
  assert.equal(vault.list().persisted, false);
  assert.equal(fs.existsSync(vault.file), false);
  assert.equal(vault.list().logins[0].senha, undefined);
});

test("o cofre prefere a API assíncrona e funciona sem a síncrona (Electron 46)", async () => {
  const root = dir();
  const calls = [];
  const vault = await createVault({ dir: root, safeStorage: fakeAsyncStorage({ sync: false, calls }) });
  assert.equal(vault.mode, "async");
  await vault.saveLogin({ nome: "GitHub", usuario: "helison", senha: "senha-assincrona-secreta" });
  await vault.setKey("gemini", "chave_assincrona_123456");
  assert.ok(calls.includes("encAsync"));
  assert.equal(calls.includes("encSync"), false);
  const body = JSON.parse(fs.readFileSync(vault.file, "utf8"));
  assert.equal(body.version, 2);
  assert.equal(JSON.stringify(body).includes("senha-assincrona-secreta"), false);
  const again = await createVault({ dir: root, safeStorage: fakeAsyncStorage({ sync: false }) });
  assert.equal(again.getLogin(vault.list().logins[0].id).senha, "senha-assincrona-secreta");
  assert.equal(again.getKey("gemini"), "chave_assincrona_123456");
});

test("sem a API assíncrona o cofre cai para a síncrona e mantém o formato antigo", async () => {
  const root = dir();
  const vault = await createVault({ dir: root, safeStorage: fakeSafeStorage() });
  assert.equal(vault.mode, "sync");
  await vault.setKey("groq", "gsk_formato_antigo_12345678");
  assert.equal(JSON.parse(fs.readFileSync(vault.file, "utf8")).version, 1);
  assert.equal(fs.existsSync(path.join(root, "backups")), false);
});

test("o cofre no formato antigo abre pela API assíncrona, é regravado e deixa cópia", async () => {
  const root = dir();
  const legacy = await createVault({ dir: root, safeStorage: fakeSafeStorage() });
  await legacy.saveLogin({ nome: "GitHub", usuario: "helison", senha: "senha-do-formato-antigo" });
  await legacy.setKey("groq", "gsk_do_formato_antigo_123456");
  const oldText = fs.readFileSync(legacy.file, "utf8");
  assert.equal(JSON.parse(oldText).version, 1);

  const migrated = await createVault({ dir: root, safeStorage: fakeAsyncStorage({ sync: false }) });
  assert.equal(migrated.mode, "async");
  assert.equal(migrated.getLogin(migrated.list().logins[0].id).senha, "senha-do-formato-antigo");
  assert.equal(migrated.getKey("groq"), "gsk_do_formato_antigo_123456");
  const backup = path.join(root, "backups", "vault.pre-async.json");
  assert.equal(fs.readFileSync(backup, "utf8"), oldText);
  assert.equal(JSON.parse(fs.readFileSync(migrated.file, "utf8")).version, 2);

  // A cópia nunca é sobrescrita por regravações seguintes.
  await migrated.setKey("gemini", "chave_depois_da_migracao_123");
  assert.equal(fs.readFileSync(backup, "utf8"), oldText);
  const reopened = await createVault({ dir: root, safeStorage: fakeAsyncStorage({ sync: false }) });
  assert.equal(reopened.getKey("gemini"), "chave_depois_da_migracao_123");
  assert.equal(reopened.getKey("groq"), "gsk_do_formato_antigo_123456");
});

test("se o cofre antigo não abre, o arquivo não é regravado vazio", async () => {
  const root = dir();
  const legacy = await createVault({ dir: root, safeStorage: fakeSafeStorage() });
  await legacy.setKey("groq", "gsk_nao_pode_se_perder_12345");
  const oldText = fs.readFileSync(legacy.file, "utf8");
  const broken = fakeAsyncStorage({ sync: false });
  broken.decryptStringAsync = async () => { throw new Error("chave indisponível"); };
  const vault = await createVault({ dir: root, safeStorage: broken });
  assert.equal(vault.getKey("groq"), "");
  assert.equal(fs.readFileSync(vault.file, "utf8"), oldText);
  assert.equal(fs.existsSync(path.join(root, "backups", "vault.pre-async.json")), false);
  // Nem uma gravação nova troca o arquivo se a conferência de leitura falha.
  const saved = await vault.setKey("gemini", "AIza_chave_nova_1234567");
  assert.equal(saved.persisted, false);
  assert.equal(fs.readFileSync(vault.file, "utf8"), oldText);
});

test("se só uma parte do cofre não abre, o original fica guardado e nada é regravado", async () => {
  const root = dir();
  const legacy = await createVault({ dir: root, safeStorage: fakeSafeStorage() });
  await legacy.saveLogin({ nome: "Alvo", usuario: "x", senha: "senha-alvo-123456" });
  await legacy.setKey("groq", "gsk_parte_boa_1234567890");
  const oldText = fs.readFileSync(legacy.file, "utf8");
  const partial = fakeAsyncStorage({ sync: false });
  partial.decryptStringAsync = async (buf) => {
    const text = unxor(buf);
    if (text.includes("senha-alvo-123456")) throw new Error("parte ilegível");
    return { shouldReEncrypt: false, result: text };
  };
  const vault = await createVault({ dir: root, safeStorage: partial });
  assert.equal(vault.getKey("groq"), "gsk_parte_boa_1234567890");
  assert.equal(fs.readFileSync(vault.file, "utf8"), oldText);
  // A cópia do que não abriu é feita na abertura, e nenhuma gravação troca o arquivo (veja seguranca.test.js).
  assert.equal(fs.readFileSync(path.join(root, "backups", "vault.unreadable.json"), "utf8"), oldText);
  const saved = await vault.setKey("gemini", "AIza_chave_nova_1234567");
  assert.equal(saved.persisted, false);
  assert.equal(saved.blocked, true);
  assert.equal(fs.readFileSync(vault.file, "utf8"), oldText);
});

test("quando o sistema pede para regravar (shouldReEncrypt), o cofre abre de novo e regrava", async () => {
  const root = dir();
  const first = await createVault({ dir: root, safeStorage: fakeAsyncStorage({ sync: false }) });
  await first.setKey("groq", "gsk_chave_girada_12345678");
  const calls = [];
  const rotating = await createVault({ dir: root, safeStorage: fakeAsyncStorage({ sync: false, rotate: true, calls }) });
  assert.equal(rotating.getKey("groq"), "gsk_chave_girada_12345678");
  assert.ok(calls.filter((item) => item === "decAsync").length >= 8);
  assert.ok(calls.includes("encAsync"));
});

test("gravações em sequência não se atropelam e o cofre guarda a última", async () => {
  const root = dir();
  const vault = await createVault({ dir: root, safeStorage: fakeAsyncStorage({ sync: false }) });
  await Promise.all([
    vault.saveLogin({ nome: "Um", usuario: "a", senha: "senha-um-123456" }),
    vault.saveLogin({ nome: "Dois", usuario: "b", senha: "senha-dois-123456" }),
    vault.setKey("groq", "gsk_sequencia_123456789"),
  ]);
  await vault.flush();
  const again = await createVault({ dir: root, safeStorage: fakeAsyncStorage({ sync: false }) });
  assert.equal(again.list().logins.length, 2);
  assert.equal(again.getKey("groq"), "gsk_sequencia_123456789");
});

test("o aviso e as mensagens do cofre nunca trazem o segredo", async () => {
  const root = dir();
  const vault = await createVault({ dir: root, safeStorage: fakeAsyncStorage({ sync: false }) });
  const saved = await vault.saveLogin({ nome: "Banco", usuario: "helison", senha: "senha-que-nao-vaza-99" });
  assert.equal(JSON.stringify(saved).includes("senha-que-nao-vaza-99"), false);
  await assert.rejects(() => vault.saveLogin({ nome: "x" }), (err) => !String(err.message).includes("senha-que-nao-vaza-99"));
  assert.equal(JSON.stringify(vault.list()).includes("senha-que-nao-vaza-99"), false);
});

test("a senha entra pelo stdin do PowerShell e sai do retorno", async () => {
  let payload = "";
  let args = [];
  const result = await injectLogin({ usuario: "helison", senha: "senha-muito-secreta" }, {
    platform: "win32",
    spawn(_cmd, argv) {
      args = argv;
      const child = new EventEmitter();
      child.stdin = {
        write(chunk) { payload += chunk; return true; },
        end() { queueMicrotask(() => child.emit("close", 0)); },
      };
      return child;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes("senha-muito-secreta"), false);
  assert.equal(args.join(" ").includes("senha-muito-secreta"), false);
  assert.equal(JSON.parse(Buffer.from(payload, "base64").toString("utf8")).senha, "senha-muito-secreta");
  assert.match(SCRIPT, /Clipboard]::Clear/);
  assert.equal(SCRIPT.includes("senha-muito-secreta"), false);
});
