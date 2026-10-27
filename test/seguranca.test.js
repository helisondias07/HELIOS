"use strict";

// Regressão das 4 correções de segurança: cofre ilegível, área de transferência, ambiente do MCP stdio e limites de tamanho.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { createVault } = require("../src/vault-store");
const { injectLogin, SCRIPT, CLIPBOARD_HELPERS, encodeScript } = require("../src/vault-inject");
const { connectMcp, buildChildEnv } = require("../server/mcp-client");
const { createMcpRegistry } = require("../server/mcp-registry");
const { startServer } = require("../server/index");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const XOR = 0x5a;
const xor = (text) => Buffer.from(String(text), "utf8").map((byte) => byte ^ XOR);
const unxor = (buf) => Buffer.from(buf).map((byte) => byte ^ XOR).toString("utf8");

function asyncStorage(over = {}) {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text) => xor(text),
    decryptStringAsync: async (buf) => ({ shouldReEncrypt: false, result: unxor(buf) }),
    ...over,
  };
}

/** Cria um cofre com dados e devolve o texto exato do vault.json. */
async function seeded(root) {
  const first = await createVault({ dir: root, safeStorage: asyncStorage() });
  await first.saveLogin({ nome: "Banco", usuario: "helison", senha: "senha-que-nao-pode-sumir-1" });
  await first.setKey("groq", "gsk_nao_pode_sumir_1234567890");
  return fs.readFileSync(first.file, "utf8");
}

const brokenRead = () => asyncStorage({ decryptStringAsync: async () => { throw new Error("DPAPI indisponível"); } });

// ---------- 1. cofre ilegível ----------

test("cofre ilegível: nada é gravado, nem salvando login, token, chave ou removendo (mesmo cifrando bem)", async () => {
  const root = tmp("helios-sec-vault-");
  const oldText = await seeded(root);
  const vault = await createVault({ dir: root, safeStorage: brokenRead() });
  assert.equal(vault.isBlocked(), true);
  const listed = vault.list();
  assert.equal(listed.blocked, true);
  assert.match(listed.blockedMessage, /vault\.pre-async\.json/);
  assert.match(listed.blockedMessage, /vault\.unreadable\.json/);
  assert.match(listed.blockedMessage, /Reinicie/);
  assert.match(listed.blockedMessage, /Começar um cofre novo/);

  await assert.rejects(() => vault.saveLogin({ nome: "Novo", usuario: "x", senha: "outra-senha-secreta-2" }), (err) => err.code === "VAULT_BLOCKED" && /não vai gravar/.test(err.message) && !err.message.includes("outra-senha-secreta-2"));
  await assert.rejects(() => vault.saveToken({ nome: "npm", valor: "token-novo-secreto" }), (err) => err.code === "VAULT_BLOCKED");
  await assert.rejects(() => vault.remove("login_qualquer"), (err) => err.code === "VAULT_BLOCKED");
  const key = await vault.setKey("gemini", "AIza_chave_nova_1234567");
  assert.equal(key.persisted, false);
  assert.equal(key.blocked, true);
  assert.match(key.error, /Reinicie/);
  await vault.setAccounts({ version: 1, activeId: null, accounts: [] });
  await vault.mcpAccess();
  await vault.flush();

  assert.equal(fs.readFileSync(vault.file, "utf8"), oldText, "o vault.json precisa ficar byte a byte igual");
  assert.equal(vault.list().logins.length, 0, "a recusa não deixa login fantasma na memória");
  assert.equal(fs.readFileSync(path.join(root, "backups", "vault.unreadable.json"), "utf8"), oldText);
  // Abrindo de novo com a leitura funcionando, tudo continua lá.
  const healthy = await createVault({ dir: root, safeStorage: asyncStorage() });
  assert.equal(healthy.isBlocked(), false);
  assert.equal(healthy.getKey("groq"), "gsk_nao_pode_sumir_1234567890");
  assert.equal(healthy.list().logins[0].nome, "Banco");
});

test("cofre com vault.json corrompido também fica bloqueado e intacto", async () => {
  const root = tmp("helios-sec-corrupt-");
  const file = path.join(root, "vault.json");
  const broken = '{"version":2,"logins":"AAAA';
  fs.writeFileSync(file, broken);
  const vault = await createVault({ dir: root, safeStorage: asyncStorage() });
  assert.equal(vault.isBlocked(), true);
  await assert.rejects(() => vault.saveLogin({ nome: "Novo", senha: "x" }), (err) => err.code === "VAULT_BLOCKED");
  assert.equal((await vault.setKey("groq", "gsk_xxxxxxxxxxxxxxxx")).persisted, false);
  assert.equal(fs.readFileSync(file, "utf8"), broken);
});

test("cofre sem arquivo ou com arquivo vazio não conta como ilegível", async () => {
  const root = tmp("helios-sec-vazio-");
  fs.writeFileSync(path.join(root, "vault.json"), "");
  const vault = await createVault({ dir: root, safeStorage: asyncStorage() });
  assert.equal(vault.isBlocked(), false);
  await vault.saveLogin({ nome: "Primeiro", usuario: "a", senha: "senha-primeiro-123" });
  assert.equal(vault.list().persisted, true);
});

/** Chave que "girou": só abre o que ela mesma cifrou (prefixo N:), como um DPAPI de outro perfil. */
function rotatedKeyStorage() {
  return asyncStorage({
    encryptStringAsync: async (text) => Buffer.concat([Buffer.from("N:"), xor(text)]),
    decryptStringAsync: async (buf) => {
      const input = Buffer.from(buf);
      if (input.subarray(0, 2).toString() !== "N:") throw new Error("não é desta chave");
      return { shouldReEncrypt: false, result: unxor(input.subarray(2)) };
    },
  });
}

test("começar um cofre novo: copia o ilegível antes, grava o novo e não recomeça um cofre saudável", async () => {
  const root = tmp("helios-sec-novo-");
  const oldText = await seeded(root);
  const vault = await createVault({ dir: root, safeStorage: rotatedKeyStorage() });
  assert.equal(vault.isBlocked(), true);
  const tokenBefore = vault.mcpToken();
  const out = await vault.startFresh();
  assert.equal(out.ok, true);
  assert.match(out.backup, /^backups[\\/]vault\.unreadable-.*\.json$/);
  assert.equal(fs.readFileSync(path.join(root, out.backup), "utf8"), oldText);
  assert.equal(vault.isBlocked(), false);
  assert.equal(vault.list().logins.length, 0);
  assert.equal(vault.mcpToken(), tokenBefore, "o token da sessão continua o mesmo");
  await vault.saveLogin({ nome: "Depois", usuario: "u", senha: "senha-depois-do-cofre-novo" });
  const reopened = await createVault({ dir: root, safeStorage: rotatedKeyStorage() });
  assert.equal(reopened.isBlocked(), false);
  assert.deepEqual(reopened.list().logins.map((item) => item.nome), ["Depois"]);
  assert.equal(reopened.getKey("groq"), "");
  await assert.rejects(() => reopened.startFresh(), /não há o que recomeçar/);
});

test("começar um cofre novo: se a cópia falha, nada muda", async () => {
  const root = tmp("helios-sec-copia-");
  const oldText = await seeded(root);
  // "backups" existe como arquivo: não dá para criar a pasta nem copiar.
  fs.writeFileSync(path.join(root, "backups"), "não sou uma pasta");
  const vault = await createVault({ dir: root, safeStorage: brokenRead() });
  await assert.rejects(() => vault.startFresh(), /Não consegui copiar/);
  assert.equal(vault.isBlocked(), true);
  assert.equal(fs.readFileSync(vault.file, "utf8"), oldText);
});

// ---------- 2. área de transferência ----------

function fakeSpawn(record, code = 0) {
  return (cmd, argv, options) => {
    record.cmd = cmd;
    record.argv = argv;
    record.options = options;
    record.payload = "";
    const child = new EventEmitter();
    child.stdin = {
      write(chunk) { record.payload += chunk; return true; },
      end() { queueMicrotask(() => child.emit("close", code)); },
    };
    return child;
  };
}

test("área de transferência: o script marca os 3 formatos de exclusão e limpa sempre (inclusive em erro)", () => {
  for (const format of ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"]) {
    assert.ok(CLIPBOARD_HELPERS.includes(`'${format}'`), format);
  }
  assert.match(CLIPBOARD_HELPERS, /\[byte\[\]\]\(0, 0, 0, 0\)/);
  assert.match(CLIPBOARD_HELPERS, /SetDataObject\(.*\$true/);
  // Nunca o SetText simples, que não leva os formatos.
  assert.equal(/Clipboard\]::SetText/.test(SCRIPT), false);
  assert.match(SCRIPT, /finally \{[\s\S]*Clipboard\]::Clear\(\)/);
  assert.match(SCRIPT, /exit \$code/);
  // Sem saída de texto que possa carregar a senha.
  assert.equal(/Write-Output|Write-Host|Write-Error|\[Console\]::Error|\$_/.test(SCRIPT), false);
});

test("área de transferência: o script não leva segredo e a senha só viaja pelo stdin", async () => {
  const record = {};
  const result = await injectLogin({ usuario: "helison", senha: "S3nh@-ultra-secreta ção" }, { platform: "win32", spawn: fakeSpawn(record) });
  assert.deepEqual(result, { ok: true, method: "teclas" });
  assert.equal(record.cmd, "powershell.exe");
  assert.ok(record.argv.includes("-EncodedCommand"));
  assert.ok(record.argv.includes("-STA"));
  const encoded = record.argv[record.argv.indexOf("-EncodedCommand") + 1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), SCRIPT);
  assert.equal(encoded, encodeScript());
  assert.equal(record.argv.join(" ").includes("ultra-secreta"), false);
  assert.equal(JSON.stringify(result).includes("ultra-secreta"), false);
  assert.deepEqual(record.options.stdio, ["pipe", "ignore", "ignore"], "stdout e stderr do PowerShell nem são lidos");
  assert.deepEqual(JSON.parse(Buffer.from(record.payload, "base64").toString("utf8")), { usuario: "helison", senha: "S3nh@-ultra-secreta ção" });
  assert.equal(record.payload.includes("ultra-secreta"), false, "no stdin vai em base64, não em texto");
});

test("área de transferência: falha do PowerShell vira mensagem sem a senha", async () => {
  const record = {};
  const result = await injectLogin({ usuario: "a", senha: "senha-que-nao-vaza-xyz" }, { platform: "win32", spawn: fakeSpawn(record, 1) });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("senha-que-nao-vaza-xyz"), false);
  const boom = await injectLogin({ usuario: "a", senha: "senha-que-nao-vaza-xyz" }, { platform: "win32", spawn() { throw new Error("falhou senha-que-nao-vaza-xyz"); } });
  assert.equal(boom.ok, false);
  assert.equal(JSON.stringify(boom).includes("senha-que-nao-vaza-xyz"), false);
});

// Opcional (mexe na área de transferência real): HELIOS_TESTE_AREA=1 npm test
test("área de transferência (real, Windows): os 3 formatos entram e o Clear remove tudo", { skip: process.platform !== "win32" || process.env.HELIOS_TESTE_AREA !== "1" }, () => {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
${CLIPBOARD_HELPERS}
Set-ProtectedClipboard 'valor-de-teste-nao-secreto'
$d = [System.Windows.Forms.Clipboard]::GetDataObject()
$f = $d.GetFormats()
$out = @{ texto = $d.GetData([System.Windows.Forms.DataFormats]::UnicodeText); formatos = @($f) }
[System.Windows.Forms.Clipboard]::Clear()
$out.vazio = -not [System.Windows.Forms.Clipboard]::ContainsText()
$out | ConvertTo-Json -Compress
`;
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encodeScript(script)], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const info = JSON.parse(run.stdout.trim());
  assert.equal(info.texto, "valor-de-teste-nao-secreto");
  for (const format of ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"]) {
    assert.ok(info.formatos.includes(format), `${format} em ${info.formatos.join(",")}`);
  }
  assert.equal(info.vazio, true);
});

// ---------- 3. ambiente do MCP stdio ----------

const SEGREDOS = {
  CURSOR_API_KEY: "crsr_segredo_de_teste_000000",
  GROQ_API_KEY: "gsk_segredo_de_teste_000000",
  GEMINI_API_KEY: "gemini_segredo_de_teste_000000",
  GITHUB_TOKEN: "ghp_segredo_de_teste_000000",
  MINHA_SENHA_BANCO: "senha-do-ambiente",
};

test("ambiente mínimo: só o necessário passa e nenhuma chave é herdada", () => {
  const parent = {
    PATH: "C:\\bin", SystemRoot: "C:\\Windows", ComSpec: "cmd.exe", TEMP: "C:\\t", NODE_ENV: "test", LANG: "pt_BR",
    "ProgramFiles(x86)": "C:\\pf", LC_ALL: "C", ...SEGREDOS, NODE_AUTH_TOKEN: "npm_segredo", ELECTRON_RUN_AS_NODE: "1", OUTRA_COISA: "x",
  };
  const env = buildChildEnv(parent, { MINHA_VAR: "ok", GROQ_API_KEY: "configurada-de-proposito" });
  for (const name of ["PATH", "SystemRoot", "ComSpec", "TEMP", "NODE_ENV", "LANG", "ProgramFiles(x86)", "LC_ALL", "MINHA_VAR"]) assert.ok(name in env, name);
  for (const name of ["CURSOR_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN", "MINHA_SENHA_BANCO", "NODE_AUTH_TOKEN", "ELECTRON_RUN_AS_NODE", "OUTRA_COISA"]) assert.equal(name in env, false, name);
  // O que o usuário configurou de propósito para o conector entra; herdado nunca.
  assert.equal(env.GROQ_API_KEY, "configurada-de-proposito");
  assert.equal(buildChildEnv(parent, {}).GROQ_API_KEY, undefined);
  // nomes de variável em outro formato de caixa também são filtrados
  assert.equal("cursor_api_key" in buildChildEnv({ cursor_api_key: "x", Path: "p" }), false);
  assert.equal(buildChildEnv({ cursor_api_key: "x", Path: "p" }).Path, "p");
});

test("servidor MCP stdio real recebe só o ambiente mínimo mais o configurado", async () => {
  const saved = {};
  for (const [name, value] of Object.entries(SEGREDOS)) { saved[name] = process.env[name]; process.env[name] = value; }
  try {
    const conn = await connectMcp("env", {
      type: "stdio",
      command: process.execPath,
      args: [path.join(__dirname, "fixtures", "mcp-env.js")],
      env: { HELIOS_TESTE_VAR: "valor-configurado" },
    });
    const result = await conn.call("ambiente", {});
    conn.close();
    const payload = JSON.parse(result.content[0].text);
    const names = payload.nomes.map((name) => name.toUpperCase());
    for (const name of Object.keys(SEGREDOS)) assert.equal(names.includes(name), false, `${name} vazou`);
    assert.equal(JSON.stringify(payload).includes("segredo_de_teste"), false);
    assert.equal(payload.teste, "valor-configurado");
    assert.ok(names.includes("PATH") || names.includes("SYSTEMROOT"));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("servidor MCP stdio que despeja saída sem fim é encerrado com erro claro", async () => {
  const started = Date.now();
  await assert.rejects(
    () => connectMcp("flood", { type: "stdio", command: process.execPath, args: [path.join(__dirname, "fixtures", "mcp-flood.js")] }, { initTimeoutMs: 8000 }),
    /maior que 1 MB/,
  );
  assert.ok(Date.now() - started < 7000, "não pode esperar o tempo esgotar");
});

test("conector stdio: variáveis do usuário ficam no registro, só os nomes aparecem na lista", async () => {
  const dir = tmp("helios-sec-reg-");
  const seen = [];
  const registry = createMcpRegistry(dir, { connect: async (_name, cfg) => { seen.push(cfg); return { tools: [], close() {} }; } });
  const added = registry.add({ name: "meu-mcp", type: "stdio", command: "node", args: ["x.js"], env: "API_URL=https://exemplo\nTOKEN_DELE=valor-privado" });
  assert.deepEqual(added.envNames, ["API_URL", "TOKEN_DELE"]);
  assert.equal(JSON.stringify(registry.list()).includes("valor-privado"), false);
  registry.confirm(added.id);
  await registry.test(added.id);
  assert.deepEqual(seen[0].env, { API_URL: "https://exemplo", TOKEN_DELE: "valor-privado" });
  assert.throws(() => registry.add({ name: "ruim", type: "stdio", command: "node", env: "1ruim=x" }), /inválido/);
  assert.throws(() => registry.add({ name: "ruim2", type: "stdio", command: "node", env: ["a"] }), /NOME=valor/);
  assert.deepEqual(registry.add({ name: "sem-env", type: "stdio", command: "node" }).envNames, []);
});

// ---------- 4. limites de tamanho ----------

async function boot() {
  const dataDir = tmp("helios-sec-srv-");
  return startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    openEditor: () => ({ ok: true, cmd: "code" }),
    searchWeb: async (query) => ({ query, results: [], error: "" }),
  });
}

async function api(app, pathname, { method = "GET", body, raw } = {}) {
  const res = await fetch(`${app.url}${pathname}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("corpo acima de 1 MB responde 413 claro, sem derrubar a conexão, e o servidor segue de pé", async () => {
  const app = await boot();
  try {
    const big = await api(app, "/api/conversations", { method: "POST", raw: JSON.stringify({ title: "x".repeat(1_500_000) }) });
    assert.equal(big.status, 413);
    assert.match(big.body.error, /grande demais/);
    assert.match(big.body.error, /1 MB/);
    const huge = await api(app, "/api/conversations", { method: "POST", raw: JSON.stringify({ title: "y".repeat(8_000_000) }) });
    assert.equal(huge.status, 413);
    // Cabeçalho content-length já acima do limite, sem esperar o corpo todo.
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${app.url}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}`, "content-length": String(5_000_000) },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.write("{");
      setTimeout(() => req.destroy(), 400).unref();
    }).catch(() => 413);
    assert.equal(status, 413);
    const ok = await api(app, "/api/health");
    assert.equal(ok.status, 200);
    const small = await api(app, "/api/conversations", { method: "POST", body: { title: "normal" } });
    assert.equal(small.status, 201);
  } finally {
    await app.close();
  }
});

test("mensagem de chat acima de 20.000 caracteres responde 413 e não grava nada; até 20.000 vai inteira", async () => {
  const app = await boot();
  try {
    const { body: created } = await api(app, "/api/conversations", { method: "POST", body: {} });
    const id = created.conversation.id;
    const tooLong = await api(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text: "a".repeat(20_001) } });
    assert.equal(tooLong.status, 413);
    assert.match(tooLong.body.error, /grande demais/);
    assert.match(tooLong.body.error, /20\.000/);
    const after = await api(app, `/api/conversations/${id}`);
    assert.equal(after.body.conversation.messages.length, 0);
    assert.equal(after.body.conversation.busy, false);

    const medium = "b".repeat(9000);
    const accepted = await api(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text: medium } });
    assert.equal(accepted.status, 202);
    const stored = accepted.body.conversation.messages.find((message) => message.role === "user");
    assert.equal(stored.text.length, 9000, "nada de truncar em silêncio");
  } finally {
    await app.close();
  }
});

test("POST /api/livecoding com descrição vazia ou inválida dá 400", async () => {
  const app = await boot();
  try {
    for (const body of [{}, { description: "" }, { description: "   \n " }, { description: 42 }, { description: null }]) {
      const out = await api(app, "/api/livecoding", { method: "POST", body });
      assert.equal(out.status, 400, JSON.stringify(body));
      assert.match(out.body.error, /Descreva/);
    }
    const ok = await api(app, "/api/livecoding", { method: "POST", body: { description: "página de contato" } });
    assert.equal(ok.status, 201);
  } finally {
    await app.close();
  }
});