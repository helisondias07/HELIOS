"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { redact } = require("../server/util");
const { describeAction } = require("../server/approval-preview");

const MASK = "[segredo]";
const E = "\u00e9"; // "é"

test("m\u00e1scara: senha em texto livre perde o valor e mant\u00e9m a palavra", () => {
  assert.equal(redact("a senha: hunter2secret"), `a senha: ${MASK}`);
  assert.equal(redact(`a senha ${E} hunter2secret.`), `a senha ${E} ${MASK}.`);
  assert.equal(redact("the password is hunter2"), `the password is ${MASK}`);
  assert.equal(redact("pwd=abc123 e mais"), `pwd=${MASK} e mais`);
  assert.equal(redact("passwd: Zq9!x"), `passwd: ${MASK}`);
  assert.equal(redact("segredo: maça123"), `segredo: ${MASK}`);
  assert.equal(redact('senha: "minha frase longa"'), `senha: "${MASK}"`);
  assert.ok(!redact("a senha: hunter2secret").includes("hunter2"));
});

test("m\u00e1scara: pares KEY=VALUE de env e nomes compostos", () => {
  assert.equal(redact("OPENAI_API_KEY=abc12345"), `OPENAI_API_KEY=${MASK}`);
  assert.equal(redact("DB_PASSWORD=p4ss"), `DB_PASSWORD=${MASK}`);
  assert.equal(redact("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx1234"), `GITHUB_TOKEN=${MASK}`);
  assert.equal(redact("accessKey: Z9y8x7"), `accessKey: ${MASK}`);
  assert.equal(redact("api-key = abc-12345"), `api-key = ${MASK}`);
  assert.equal(redact('{"key":"abc123"}'), `{"key":"${MASK}"}`);
});

test("m\u00e1scara: Authorization e Bearer", () => {
  assert.equal(redact("Authorization: Bearer abcdef.123456"), `Authorization: Bearer ${MASK}`);
  assert.equal(redact("Authorization: Basic dXNlcjpwYXNz"), `Authorization: Basic ${MASK}`);
  assert.equal(redact("curl -H 'authorization: tok_1234567'"), `curl -H 'authorization: ${MASK}'`);
  assert.equal(redact("usei Bearer abc123def456 ontem"), `usei Bearer ${MASK} ontem`);
});

test("m\u00e1scara: tokens longos conhecidos", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_DEF-123";
  for (const token of [
    "ghp_abcdefghijklmnopqrstuvwx1234",
    "gho_abcdefghijklmnopqrstuvwx1234",
    "xoxb-1234567890-abcdefghij",
    "xoxp-1234567890-abcdefghij",
    "xoxa-1234567890-abcdefghij",
    "AKIAABCDEFGHIJKLMNOP",
    jwt,
    "sk-ant-abcdefghijklmnop",
    "github_pat_11ABCDEFG0abcdefghijkl"
  ]) {
    assert.equal(redact(`veja ${token} agora`), `veja ${MASK} agora`, token);
  }
  assert.equal(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"), MASK);
});

test("m\u00e1scara: sem falsos positivos \u00f3bvios", () => {
  for (const text of [
    "monkey: banana",
    "keyboard: curto",
    "a chave " + E + " importante",
    "the key is to wait",
    "a senha " + E + " pessoal",
    "chave: valor",
    "key: value",
    "token: obrigat\u00f3rio",
    "senha: [segredo]",
    "token: $TOKEN",
    "api_key: <sua chave>",
    "Digite a senha",
    "o token expira em breve",
    "tokens de entrada e sa\u00edda",
    "Chave de API n\u00e3o configurada",
    "Authorization: required"
  ]) {
    assert.equal(redact(text), text, text);
  }
});

test("m\u00e1scara: idempotente e aceita entradas estranhas", () => {
  const once = redact("senha: hunter2secret e token=abc123xyz");
  assert.equal(redact(once), once);
  assert.equal(redact(null), "");
  assert.equal(redact(undefined), "");
  assert.equal(redact(12345), "12345");
});

test("cart\u00e3o de aprova\u00e7\u00e3o: senha em texto livre n\u00e3o aparece nos argumentos", () => {
  const clean = {
    mcp: { server: "mail", tool: "send", args: { corpo: "oi, a senha: hunter2secret e o resto", para: "a@b.com", key: "abc123" } }
  };
  const text = describeAction(clean);
  assert.ok(!text.includes("hunter2secret"), text);
  assert.ok(!text.includes("abc123"), text);
  assert.ok(text.includes("a senha:"), text);
  assert.ok(text.includes("a@b.com"), text);
  const escrever = describeAction({ tipo: "escrever", alvo: "C:\\x\\a.env", conteudo: "API_KEY=abc12345\nSENHA = hunter2secret" });
  assert.ok(!escrever.includes("abc12345") && !escrever.includes("hunter2secret"), escrever);
});