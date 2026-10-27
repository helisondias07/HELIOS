"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");
const { maskSecrets, findSecret } = require("../server/secret-scan");
const { safeUrl, safeArgs, MAX_PACKAGE_CHARS } = require("../server/context-pack");
const { createSafeFolders } = require("../server/safe-folders");
const { createContextHost } = require("../src/context-host");
const { createMemory } = require("../server/memory");

const SEGREDOS = ["hunter2secret99", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "sk-live-1234567890abcdefXYZ", "senha-super-secreta", "tokenDaURL12345"];
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-f2-${name}-`));

async function boot(extra = {}) {
  const dataDir = extra.dataDir || tmp("dados");
  const app = await startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    getVaultIndex: () => [{ id: "login_1", tipo: "login", nome: "GitHub", senha: "senha-super-secreta" }],
    onFillLogin: async () => ({ ok: true }),
    ...extra,
  });
  return app;
}

async function json(app, pathname, opts = {}) {
  const res = await fetch(`${app.url}${pathname}`, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const post = (app, p, body) => json(app, p, { method: "POST", body });

/** Dados de exemplo no disco ANTES de subir o servidor (inclui segredos de propósito, para provar que a exportação os barra). */
function seed(dataDir) {
  const at = "2026-10-01T12:00:00.000Z";
  fs.writeFileSync(path.join(dataDir, "memory.json"), JSON.stringify({ version: 1, items: [
    { id: "mem_a", kind: "preferencia", text: "Prefiro respostas curtas em português.", source: "user", createdAt: at, updatedAt: at },
    { id: "mem_b", kind: "fato", text: "Trabalho com front-end júnior e estudo inglês toda manhã.", source: "user", createdAt: at, updatedAt: at },
    { id: "mem_c", kind: "fato", text: "Anotei que a senha: hunter2secret99 serve para o painel antigo.", source: "bot", createdAt: at, updatedAt: at },
  ] }));
  fs.writeFileSync(path.join(dataDir, "contexto.json"), JSON.stringify({ version: 1, items: [{ id: "ctx_1", text: "Revisar o PR da landing até sexta.", createdAt: at, updatedAt: at }] }));
  fs.writeFileSync(path.join(dataDir, "assistants.json"), JSON.stringify({ version: 1, items: [
    { id: "ast_aaaaaaaaaa", name: "Estudos", role: "Tutor", instructions: "Explique em passos curtos.", mcp: null, autonomy: { escrever: "sozinho" }, template: null, createdAt: at, updatedAt: at },
  ] }));
  fs.writeFileSync(path.join(dataDir, "memory-ast_aaaaaaaaaa.json"), JSON.stringify({ version: 1, items: [{ id: "mem_d", kind: "regra", text: "Sempre fechar com uma pergunta de fixação.", source: "user", createdAt: at, updatedAt: at }] }));
  fs.writeFileSync(path.join(dataDir, "routines.json"), JSON.stringify([
    { id: "rot_1", title: "Revisão semanal", prompt: "Me lembre de revisar as tarefas.", everyMinutes: null, clock: "09:30", enabled: true, assistantId: "ast_aaaaaaaaaa", lastRun: null, createdAt: at },
  ]));
  fs.writeFileSync(path.join(dataDir, "conversations.json"), JSON.stringify({ version: 2, items: [{
    id: "conv_x1", title: "Plano de estudos", assistantId: "default", busy: false, agentId: null, createdAt: at, updatedAt: at,
    summary: { text: "Falamos do plano semanal de inglês.", covered: 2, updatedAt: at },
    messages: [
      { id: "msg_1", role: "user", text: "Monte meu plano. Minha senha: hunter2secret99 e o token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ficam fora, ok?", status: "done", at },
      { id: "msg_2", role: "assistant", text: "Plano: segunda gramática, terça listening.", status: "done", at },
    ],
  }] }));
  fs.writeFileSync(path.join(dataDir, "autonomy.json"), JSON.stringify({ version: 1, modes: { enviar: "pedir", escrever: "pedir" }, automaticoPede: true }));
}

async function seededApp(extra = {}) {
  const dataDir = tmp("origem");
  seed(dataDir);
  const app = await boot({ dataDir, ...extra });
  // Conector com segredos em env e na URL: nada disso pode sair no pacote.
  await post(app, "/api/mcp", { name: "github", type: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-github --token tokenDaURL12345", env: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nOPENAI_API_KEY=sk-live-1234567890abcdefXYZ" });
  await post(app, "/api/mcp", { name: "clickup-http", type: "http", url: "https://mcp.example.com/clickup?apiKey=tokenDaURL12345", headers: { Authorization: "Bearer sk-live-1234567890abcdefXYZ" } });
  return app;
}

function pacoteMinimo(extra = {}) {
  return { formato: "helios-contexto", versao: 1, criadoEm: "2026-10-25T10:00:00.000Z", origem: "teste", ...extra };
}

// ------------------------------------------------------------------ exportação

test("exportação: tem o contexto, mas nenhum segredo (memória, conversas, conectores, URL, cofre)", async () => {
  const app = await seededApp();
  try {
    const { status, body } = await post(app, "/api/pacote/exportar", {});
    assert.equal(status, 200);
    const text = JSON.stringify(body);
    for (const segredo of SEGREDOS) assert.equal(text.includes(segredo), false, `vazou: ${segredo}`);
    const p = body.pacote;
    assert.equal(p.formato, "helios-contexto");
    assert.equal(p.versao, 1);
    assert.ok(p.padrao.memoria.some((m) => m.texto.includes("respostas curtas")));
    assert.ok(p.padrao.contexto.some((c) => c.texto.includes("PR da landing")));
    assert.equal(p.assistentes.length, 1);
    assert.equal(p.assistentes[0].nome, "Estudos");
    assert.equal(p.assistentes[0].memoria[0].texto, "Sempre fechar com uma pergunta de fixação.");
    assert.equal(p.rotinas[0].assistente, "Estudos");
    assert.equal(p.conversas.length, 1);
    assert.match(p.conversas[0].resumo, /plano semanal/);
    // conectores: só os NOMES das variáveis
    const gh = p.conectores.find((c) => c.nome === "github");
    assert.deepEqual(gh.variaveis.sort(), ["GITHUB_TOKEN", "OPENAI_API_KEY"]);
    assert.equal(JSON.stringify(gh).includes("ghp_"), false);
    const http = p.conectores.find((c) => c.nome === "clickup-http");
    assert.equal(http.url, "https://mcp.example.com/clickup");
    assert.equal(http.temCabecalhos, true);
    // o que foi mascarado vem avisado
    assert.ok(body.avisos.some((a) => /mascarad/.test(a)));
    assert.ok(body.mascarados.length >= 2);
    assert.match(body.nomeArquivo, /^helios-contexto-\d{4}-\d{2}-\d{2}\.json$/);
    // preferências vão só como informação
    assert.equal(p.preferencias.autonomia.enviar, "pedir");
  } finally {
    await app.close();
  }
});

test("exportação: sem conversas quando o usuário desmarca", async () => {
  const app = await seededApp();
  try {
    const { body } = await post(app, "/api/pacote/exportar", { conversas: false });
    assert.equal(body.pacote.conversas.length, 0);
  } finally {
    await app.close();
  }
});

test("exportação: o contexto padrão exportado não carrega nada com cara de segredo", async () => {
  const app = await seededApp();
  try {
    const out = await post(app, "/api/pacote/exportar", {});
    assert.equal(out.status, 200);
    assert.equal(findSecret(JSON.stringify(out.body.pacote)), "");
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ importação aditiva

test("importação aditiva: prévia não grava, confirmar grava, nada existente muda e rotina entra pausada", async () => {
  const origem = await seededApp();
  const { body: exp } = await post(origem, "/api/pacote/exportar", {});
  await origem.close();

  const destinoDir = tmp("destino");
  fs.writeFileSync(path.join(destinoDir, "memory.json"), JSON.stringify({ version: 1, items: [{ id: "mem_z", kind: "fato", text: "Prefiro respostas curtas em português.", source: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] }));
  fs.writeFileSync(path.join(destinoDir, "assistants.json"), JSON.stringify({ version: 1, items: [{ id: "ast_bbbbbbbbbb", name: "Estudos", role: "Outro papel", instructions: "Instrução minha, diferente.", mcp: null, autonomy: {}, template: null }] }));
  const destino = await boot({ dataDir: destinoDir });
  try {
    const pacote = JSON.parse(JSON.stringify(exp.pacote));
    pacote.preferencias.autonomia = { enviar: "sozinho", apagar: "sozinho" };
    const antes = fs.readFileSync(path.join(destinoDir, "memory.json"), "utf8");

    const previa = await post(destino, "/api/pacote/importar/previa", { pacote });
    assert.equal(previa.status, 200);
    assert.ok(previa.body.previaId);
    const by = previa.body.resumo.porStatus;
    assert.equal(by.novo, 3, "memória, contexto e conversa novos (a rotina depende do assistente em conflito)");
    assert.equal(by.conflito, 1, "o assistente Estudos já existe com conteúdo diferente");
    assert.ok(by.duplicado >= 1, "a preferência de respostas curtas já existe");
    assert.ok(previa.body.itens.some((i) => i.tipo === "preferencia" && i.status === "informativo"));
    // prévia não grava nada
    assert.equal(fs.readFileSync(path.join(destinoDir, "memory.json"), "utf8"), antes);
    assert.equal((await json(destino, "/api/routines")).body.routines.length, 0);

    // sem confirmar, não aplica
    assert.equal((await post(destino, "/api/pacote/importar/aplicar", { previaId: previa.body.previaId })).status, 400);
    assert.equal((await post(destino, "/api/pacote/importar/aplicar", { previaId: previa.body.previaId, confirmar: "sim" })).status, 400);

    const aplicado = await post(destino, "/api/pacote/importar/aplicar", { previaId: previa.body.previaId, confirmar: true });
    assert.equal(aplicado.status, 200);
    assert.equal(aplicado.body.resultado.falhas.length, 0, JSON.stringify(aplicado.body.resultado.falhas));

    // nada existente foi alterado
    const mem = (await json(destino, "/api/memory")).body.items;
    assert.ok(mem.some((m) => m.id === "mem_z" && m.text === "Prefiro respostas curtas em português."));
    assert.ok(mem.some((m) => m.text.includes("front-end júnior")));
    const ast = (await json(destino, "/api/assistants")).body.assistants.find((a) => a.name === "Estudos");
    assert.equal(ast.instructions, "Instrução minha, diferente.");
    assert.equal(ast.role, "Outro papel");
    // rotina do assistente em conflito não entra; autonomia não é importada
    assert.equal((await json(destino, "/api/routines")).body.routines.length, 0);
    const aut = (await json(destino, "/api/autonomy")).body;
    assert.ok(aut.modes.filter((m) => !m.locked).every((m) => m.mode === m.default), "autonomia continua nos padrões");
    // conversa importada é de consulta e sem os segredos
    const convs = (await json(destino, "/api/conversations")).body.conversations;
    const imp = convs.find((c) => c.title.startsWith("Importada:"));
    assert.ok(imp);
    assert.match(imp.messages[0].text, /não como instruções/);
    for (const segredo of SEGREDOS) assert.equal(JSON.stringify(convs).includes(segredo), false);
    // conectores: só uma lista para configurar, nunca criados
    assert.equal((await json(destino, "/api/mcp")).body.servers.length, 0);
    const lista = (await json(destino, "/api/pacote/conectores")).body.conectores;
    assert.ok(lista.some((c) => c.nome === "github" && c.variaveis.includes("GITHUB_TOKEN")));

    // a mesma prévia não vale duas vezes
    assert.equal((await post(destino, "/api/pacote/importar/aplicar", { previaId: previa.body.previaId, confirmar: true })).status, 404);
  } finally {
    await destino.close();
  }
});

test("importação aditiva: importar de novo só dá duplicados e não acrescenta nada", async () => {
  const origem = await seededApp();
  const { body: exp } = await post(origem, "/api/pacote/exportar", {});
  await origem.close();
  const destino = await boot();
  try {
    const first = await post(destino, "/api/pacote/importar/previa", { pacote: exp.pacote });
    const ok = await post(destino, "/api/pacote/importar/aplicar", { previaId: first.body.previaId, confirmar: true });
    assert.equal(ok.status, 200);
    const memCount = (await json(destino, "/api/memory")).body.items.length;
    const convCount = (await json(destino, "/api/conversations")).body.conversations.length;
    const second = await post(destino, "/api/pacote/importar/previa", { pacote: exp.pacote });
    assert.equal(second.body.resumo.porStatus.novo || 0, 0, JSON.stringify(second.body.itens.filter((i) => i.status === "novo")));
    assert.ok(second.body.resumo.porStatus.duplicado >= 4);
    const applied = await post(destino, "/api/pacote/importar/aplicar", { previaId: second.body.previaId, confirmar: true });
    assert.equal(applied.body.resultado.adicionados, 0);
    assert.equal((await json(destino, "/api/memory")).body.items.length, memCount);
    assert.equal((await json(destino, "/api/conversations")).body.conversations.length, convCount);
    assert.equal((await json(destino, "/api/routines")).body.routines.length, 1);
  } finally {
    await destino.close();
  }
});

test("importação aditiva: conflito de assistente só entra com outro nome quando o usuário pede", async () => {
  const destinoDir = tmp("conflito");
  fs.writeFileSync(path.join(destinoDir, "assistants.json"), JSON.stringify({ version: 1, items: [{ id: "ast_cccccccccc", name: "Estudos", role: "Meu papel", instructions: "Minhas instruções.", mcp: null, autonomy: {} }] }));
  const destino = await boot({ dataDir: destinoDir });
  try {
    const pacote = pacoteMinimo({
      assistentes: [{ nome: "Estudos", funcao: "Tutor", instrucoes: "Explique em passos curtos.", memoria: [{ tipo: "regra", texto: "Sempre fechar com uma pergunta de fixação." }], contexto: [] }],
      rotinas: [{ titulo: "Estudar", instrucao: "Me lembre de estudar inglês.", horario: "08:00", ativa: true, assistente: "Estudos" }],
    });
    const sem = await post(destino, "/api/pacote/importar/previa", { pacote });
    assert.equal(sem.body.resumo.porStatus.conflito, 1);
    const semAplicado = await post(destino, "/api/pacote/importar/aplicar", { previaId: sem.body.previaId, confirmar: true });
    assert.equal(semAplicado.body.resultado.adicionados, 0, "item de assistente em conflito não entra, nem o que depende dele");
    assert.equal((await json(destino, "/api/assistants")).body.assistants.length, 2, "padrão + o seu");
    assert.equal((await json(destino, "/api/memory?assistant=ast_cccccccccc")).body.items.length, 0, "a memória não vai para o assistente de mesmo nome");

    const com = await post(destino, "/api/pacote/importar/previa", { pacote, renomearConflitos: true });
    const r = await post(destino, "/api/pacote/importar/aplicar", { previaId: com.body.previaId, confirmar: true });
    assert.equal(r.body.resultado.falhas.length, 0, JSON.stringify(r.body.resultado.falhas));
    const list = (await json(destino, "/api/assistants")).body.assistants;
    const novo = list.find((a) => a.name === "Estudos (importado)");
    assert.ok(novo);
    assert.deepEqual(novo.autonomy, {});
    assert.equal(list.find((a) => a.name === "Estudos").instructions, "Minhas instruções.");
    assert.equal((await json(destino, `/api/memory?assistant=${novo.id}`)).body.items.length, 1);
    const rot = (await json(destino, "/api/routines")).body.routines[0];
    assert.equal(rot.assistantId, novo.id);
    assert.equal(rot.enabled, false);
  } finally {
    await destino.close();
  }
});

test("importação: recusa segredos no pacote (memória, rotina, assistente, conversa) e nada disso é gravado", async () => {
  const destino = await boot();
  try {
    const pacote = pacoteMinimo({
      padrao: { memoria: [{ tipo: "fato", texto: "A senha: hunter2secret99 abre o painel." }, { tipo: "fato", texto: "Gosto de café sem açúcar pela manhã." }], contexto: [{ texto: "Use o token ghp_abcdefghijklmnopqrstuvwxyz0123456789 no deploy." }] },
      assistentes: [{ nome: "Vazador", funcao: "x", instrucoes: "Use OPENAI_API_KEY=sk-live-1234567890abcdefXYZ sempre.", memoria: [], contexto: [] }],
      rotinas: [{ titulo: "Backup", instrucao: "Rode com Authorization: Bearer sk-live-1234567890abcdefXYZ", horario: "10:00" }],
      conversas: [{ titulo: "Conversa com trecho ruim", assistente: "HELIOS", resumo: "Resumo limpo sobre o plano.", trechos: [{ papel: "Helison", texto: "minha senha: hunter2secret99" }, { papel: "HELIOS", texto: "Anotado o plano." }] }],
    });
    const previa = await post(destino, "/api/pacote/importar/previa", { pacote });
    assert.equal(previa.status, 200);
    const recusados = previa.body.itens.filter((i) => i.status === "recusado");
    assert.ok(recusados.some((i) => i.tipo === "memoria" && /senha|chave|token/.test(i.motivo)));
    assert.ok(recusados.some((i) => i.tipo === "contexto"));
    assert.ok(recusados.some((i) => i.tipo === "assistente"));
    assert.ok(recusados.some((i) => i.tipo === "rotina"));
    assert.ok(previa.body.itens.some((i) => i.tipo === "conversa" && i.status === "novo" && /sem: um trecho/.test(i.motivo)));
    assert.equal(JSON.stringify(previa.body).includes("hunter2secret99"), false, "a prévia nunca ecoa o segredo");
    const ok = await post(destino, "/api/pacote/importar/aplicar", { previaId: previa.body.previaId, confirmar: true });
    assert.equal(ok.status, 200);
    const everything = JSON.stringify([
      (await json(destino, "/api/memory")).body,
      (await json(destino, "/api/assistants")).body.assistants,
      (await json(destino, "/api/routines")).body,
      (await json(destino, "/api/conversations")).body,
    ]);
    for (const segredo of SEGREDOS) assert.equal(everything.includes(segredo), false, `gravou: ${segredo}`);
    assert.ok(everything.includes("café sem açúcar"), "o item limpo entrou");
    assert.equal((await json(destino, "/api/assistants")).body.assistants.length, 1);
  } finally {
    await destino.close();
  }
});

test("importação: schema, versão, tamanho e caminhos inválidos são rejeitados sem gravar nada", async () => {
  const destino = await boot();
  try {
    const prev = (pacote) => post(destino, "/api/pacote/importar/previa", { pacote });
    assert.equal((await prev(undefined)).status, 400);
    assert.equal((await prev("texto")).status, 400);
    assert.equal((await prev([1, 2])).status, 400);
    assert.equal((await prev({ formato: "outro", versao: 1 })).status, 400);
    assert.equal((await prev({ formato: "helios-contexto" })).status, 400);
    assert.equal((await prev({ formato: "helios-contexto", versao: "1" })).status, 400);
    const nova = await prev({ formato: "helios-contexto", versao: 99 });
    assert.equal(nova.status, 400);
    assert.match(nova.body.error, /versão 99/);
    assert.equal((await prev(pacoteMinimo({ padrao: { memoria: "não é lista" } }))).status, 400);
    assert.equal((await prev(pacoteMinimo({ assistentes: [42] }))).status, 400);
    // caminhos de arquivo e chaves perigosas
    const caminho = await prev(pacoteMinimo({ padrao: { memoria: [], contexto: [], caminho: "C:\\Windows\\System32" } }));
    assert.equal(caminho.status, 400);
    assert.match(caminho.body.error, /caminho/);
    assert.equal((await prev(pacoteMinimo({ arquivos: [{ nome: "x" }] }))).status, 400);
    assert.equal((await prev(pacoteMinimo({ conversas: [{ titulo: "x", file: "..\\..\\x" }] }))).status, 400);
    const proto = JSON.parse('{"formato":"helios-contexto","versao":1,"padrao":{"__proto__":{"x":1}}}');
    assert.equal((await prev(proto)).status, 400);
    // tamanho
    const grande = await prev(pacoteMinimo({ padrao: { memoria: [{ tipo: "fato", texto: "x".repeat(MAX_PACKAGE_CHARS + 10) }] } }));
    assert.equal(grande.status, 413);
    // campo desconhecido é ignorado com aviso, não executado
    const extra = await prev(pacoteMinimo({ script: "alert(1)", padrao: { memoria: [{ tipo: "fato", texto: "Um fato qualquer para testar." }] } }));
    assert.equal(extra.status, 200);
    assert.ok(extra.body.avisos.some((a) => /script/.test(a)));
    assert.equal((await json(destino, "/api/memory")).body.items.length, 0);
  } finally {
    await destino.close();
  }
});

test("importação: memória cheia não apaga nada (additivo até o teto)", async () => {
  const dataDir = tmp("cheia");
  const items = Array.from({ length: 299 }, (_, i) => ({ id: `mem_${i}`, kind: "fato", text: `Fato antigo número ${i} sobre assunto${i} diferente${i}`, source: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
  fs.writeFileSync(path.join(dataDir, "memory.json"), JSON.stringify({ version: 1, items }));
  const destino = await boot({ dataDir });
  try {
    const pacote = pacoteMinimo({ padrao: { memoria: [{ tipo: "fato", texto: "Primeiro fato novo bem distinto zebra." }, { tipo: "fato", texto: "Segundo fato novo bem distinto girafa." }] } });
    const previa = await post(destino, "/api/pacote/importar/previa", { pacote });
    assert.equal(previa.body.resumo.porStatus.novo, 1);
    assert.equal(previa.body.resumo.porStatus.recusado, 1);
    await post(destino, "/api/pacote/importar/aplicar", { previaId: previa.body.previaId, confirmar: true });
    const mem = (await json(destino, "/api/memory")).body.items;
    assert.equal(mem.length, 300);
    assert.ok(mem.some((m) => m.id === "mem_0"), "o item mais antigo continua lá");
  } finally {
    await destino.close();
  }
});

test("memória: addImported nunca atualiza nem apaga item parecido", () => {
  const dir = tmp("mem");
  const mem = createMemory(dir);
  const first = mem.remember({ text: "Prefiro respostas curtas em português", kind: "preferencia" });
  const again = mem.addImported({ text: "Prefiro respostas curtas em português!", kind: "fato" });
  assert.equal(again.duplicate, true);
  assert.equal(mem.list().length, 1);
  assert.equal(mem.list()[0].kind, "preferencia");
  assert.equal(mem.list()[0].id, first.item.id);
  assert.throws(() => mem.addImported({ text: "senha: hunter2secret99" }), /Não guardo/);
});

// ------------------------------------------------------------------ fontes somente leitura

function fakeConnect(calls) {
  return async (name) => ({
    tools: [
      { name: "list_tasks", description: "Lista tarefas" },
      { name: "get_inbox", description: "Lê mensagens" },
      { name: "create_task", description: "Cria tarefa" },
      { name: "send_email", description: "Envia e-mail" },
    ],
    async call(tool, args) {
      calls.push({ name, tool, args });
      return { content: [{ type: "text", text: "Tarefa 1: revisar PR da landing\n\nTarefa 2: enviar relatório. Use token=sk-live-1234567890abcdefXYZ para a API." }] };
    },
    close() {},
  });
}

test("fontes de leitura: só ferramentas de leitura de ClickUp/e-mail rodam; o resultado vira prévia e vem mascarado", async () => {
  const calls = [];
  const app = await boot({ connect: fakeConnect(calls) });
  try {
    const add = await post(app, "/api/mcp", { name: "clickup", type: "http", url: "https://mcp.example.com/clickup" });
    await post(app, `/api/mcp/${add.body.server.id}/test`, {});
    await post(app, "/api/mcp", { name: "agenda", type: "http", url: "https://mcp.example.com/agenda" });

    const fontes = (await json(app, "/api/pacote/fontes")).body.fontes;
    assert.equal(fontes.length, 1, "só ClickUp e e-mail são fontes");
    assert.deepEqual(fontes[0].ferramentasDeLeitura.map((t) => t.nome).sort(), ["get_inbox", "list_tasks"]);

    const bloqueada = await post(app, "/api/pacote/fontes/ler", { servidor: "clickup", ferramenta: "create_task", argumentos: {} });
    assert.equal(bloqueada.status, 403);
    assert.equal((await post(app, "/api/pacote/fontes/ler", { servidor: "clickup", ferramenta: "send_email" })).status, 403);
    assert.equal((await post(app, "/api/pacote/fontes/ler", { servidor: "clickup", ferramenta: "nao_existe" })).status, 404);
    assert.equal((await post(app, "/api/pacote/fontes/ler", { servidor: "agenda", ferramenta: "list_tasks" })).status, 404);
    assert.equal(calls.length, 0, "nenhuma ferramenta de escrita ou envio foi chamada");

    const lido = await post(app, "/api/pacote/fontes/ler", { servidor: "clickup", ferramenta: "list_tasks", argumentos: { lista: "semana" } });
    assert.equal(lido.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "list_tasks");
    assert.equal(JSON.stringify(lido.body).includes("sk-live-1234567890abcdefXYZ"), false);
    assert.ok(lido.body.pacote.padrao.contexto.some((c) => c.texto.includes("(ClickUp)") && c.texto.includes("revisar PR")));

    const previa = await post(app, "/api/pacote/importar/previa", { pacote: lido.body.pacote });
    assert.equal(previa.status, 200);
    assert.ok(previa.body.resumo.porStatus.novo >= 1);
    // a leitura não gravou nada até a confirmação
    assert.equal((await json(app, "/api/contexto/default")).body.items.length, 0);
    const ok = await post(app, "/api/pacote/importar/aplicar", { previaId: previa.body.previaId, confirmar: true });
    assert.equal(ok.status, 200);
    assert.ok((await json(app, "/api/contexto/default")).body.items.some((i) => i.text.includes("(ClickUp)")));
    assert.equal(calls.length, 1, "importar não chama o conector de novo");
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ pastas seguras

function tryLink(target, link) {
  try {
    fs.symlinkSync(target, link, "junction");
    return true;
  } catch {
    return false;
  }
}

function folderSetup() {
  const dataDir = tmp("pdados");
  const raiz = tmp("pasta");
  fs.mkdirSync(path.join(raiz, "sub"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "nota.txt"), "olá, nota normal");
  fs.writeFileSync(path.join(raiz, "sub", "dentro.txt"), "dentro");
  fs.writeFileSync(path.join(raiz, "config.txt"), "api_key=sk-live-1234567890abcdefXYZ e mais texto");
  const fora = tmp("fora");
  fs.writeFileSync(path.join(fora, "segredo.txt"), "conteúdo de fora");
  const lixeira = tmp("lixeira");
  const movidos = [];
  const trashItem = async (p) => {
    movidos.push(p);
    fs.renameSync(p, path.join(lixeira, `${movidos.length}-${path.basename(p)}`));
  };
  return { dataDir, raiz, fora, lixeira, movidos, trashItem };
}

test("pastas: só dentro da lista; fora da lista, caminho com .. ou letra de unidade é recusado", async () => {
  const s = folderSetup();
  let escolhida = fs.realpathSync(s.raiz);
  const app = await boot({ dataDir: s.dataDir, pickFolder: async () => escolhida, trashItem: s.trashItem });
  try {
    assert.deepEqual((await json(app, "/api/pastas")).body.pastas, []);
    // pasta que não está na lista
    assert.equal((await json(app, "/api/pastas/pasta_inexistente/arquivos?caminho=")).status, 404);
    assert.equal((await post(app, "/api/pastas/pasta_inexistente/arquivo", { caminho: "x.txt", conteudo: "x" })).status, 404);
    const added = await post(app, "/api/pastas/escolher", {});
    assert.equal(added.status, 201);
    const id = added.body.pasta.id;
    // lista e leitura dentro
    const ls = await json(app, `/api/pastas/${id}/arquivos?caminho=`);
    assert.deepEqual(ls.body.itens.map((i) => i.nome), ["sub", "config.txt", "nota.txt"]);
    assert.equal((await json(app, `/api/pastas/${id}/arquivo?caminho=nota.txt`)).body.texto, "olá, nota normal");
    // segredo em arquivo vem mascarado
    const cfg = (await json(app, `/api/pastas/${id}/arquivo?caminho=config.txt`)).body;
    assert.equal(cfg.mascarado, true);
    assert.equal(cfg.texto.includes("sk-live"), false);
    // escrita dentro
    assert.equal((await post(app, `/api/pastas/${id}/arquivo`, { caminho: "novo/arquivo.txt", conteudo: "oi" })).status, 200);
    assert.equal(fs.readFileSync(path.join(s.raiz, "novo", "arquivo.txt"), "utf8"), "oi");
    // fora
    for (const caminho of ["..\\fora.txt", "../fora.txt", "sub/../../fora.txt", "C:\\Windows\\win.ini", "/etc/passwd", s.fora]) {
      assert.ok([403, 404].includes((await json(app, `/api/pastas/${id}/arquivo?caminho=${encodeURIComponent(caminho)}`)).status), `leitura ${caminho}`);
      const w = await post(app, `/api/pastas/${id}/arquivo`, { caminho, conteudo: "x" }); if (caminho === "/etc/passwd") { assert.equal(w.status, 200); assert.ok(fs.existsSync(path.join(s.raiz, "etc", "passwd")), "barra inicial vira caminho relativo dentro da pasta"); } else assert.ok([403, 404].includes(w.status), `escrita ${caminho} ${w.status}`);
      const l = await post(app, `/api/pastas/${id}/lixeira`, { caminho }); assert.ok(caminho === "/etc/passwd" ? [200, 404].includes(l.status) : [403, 404].includes(l.status), `lixeira ${caminho} ${l.status}`);
    }
    assert.equal(fs.existsSync(path.join(path.dirname(s.raiz), "fora.txt")), false);
    assert.equal(fs.existsSync(path.join(path.parse(s.raiz).root, "etc", "passwd")), false);
    // tirar da lista não mexe nos arquivos
    assert.equal((await json(app, `/api/pastas/${id}`, { method: "DELETE" })).body.ok, true);
    assert.equal(fs.existsSync(path.join(s.raiz, "nota.txt")), true);
    assert.equal((await json(app, `/api/pastas/${id}/arquivos?caminho=`)).status, 404);
    // não aceita pasta por corpo: o caminho só vem do seletor
    assert.equal((await post(app, "/api/pastas", { caminho: s.fora })).status, 404);
    // seletor cancelado
    escolhida = null;
    assert.equal((await post(app, "/api/pastas/escolher", {})).body.cancelado, true);
  } finally {
    await app.close();
  }
});

test("pastas: recusa raiz do disco, a pasta de dados do HELIOS (cofre) e quem a contém, relativa e inexistente", () => {
  const dataDir = tmp("pdados2");
  const folders = createSafeFolders(dataDir, { extraBlocked: [] });
  assert.throws(() => folders.add(path.parse(dataDir).root), /disco inteiro|pasta de dados/);
  assert.throws(() => folders.add(dataDir), /pasta de dados/);
  assert.throws(() => folders.add(path.dirname(dataDir)), /pasta de dados/);
  fs.mkdirSync(path.join(dataDir, "dentro"));
  assert.throws(() => folders.add(path.join(dataDir, "dentro")), /pasta de dados/);
  assert.throws(() => folders.add("relativa/pasta"), /caminho completo/);
  assert.throws(() => folders.add(path.join(os.tmpdir(), "nao-existe-helios-xyz")), /não existe/);
  const blocked = tmp("sistema");
  const withBlock = createSafeFolders(tmp("pdados3"), { extraBlocked: [blocked] });
  assert.throws(() => withBlock.add(blocked), /protegida/);
  const ok = tmp("ok");
  const added = withBlock.add(ok);
  assert.equal(withBlock.list().length, 1);
  assert.throws(() => withBlock.add(ok), /já está/);
  assert.equal(added.caminho.toLowerCase(), fs.realpathSync(ok).toLowerCase());
});

test("pastas: junction/symlink dentro da pasta permitida não leva para fora (ler, listar, gravar, lixeira)", async (t) => {
  const s = folderSetup();
  if (!tryLink(s.fora, path.join(s.raiz, "atalho"))) {
    t.skip("o sistema não deixou criar o junction/symlink de teste");
    return;
  }
  const app = await boot({ dataDir: s.dataDir, pickFolder: async () => s.raiz, trashItem: s.trashItem });
  try {
    const id = (await post(app, "/api/pastas/escolher", {})).body.pasta.id;
    assert.equal((await json(app, `/api/pastas/${id}/arquivos?caminho=atalho`)).status, 403);
    assert.equal((await json(app, `/api/pastas/${id}/arquivo?caminho=${encodeURIComponent("atalho/segredo.txt")}`)).status, 403);
    assert.equal((await post(app, `/api/pastas/${id}/arquivo`, { caminho: "atalho/novo.txt", conteudo: "x" })).status, 403);
    assert.equal(fs.existsSync(path.join(s.fora, "novo.txt")), false);
    assert.equal((await post(app, `/api/pastas/${id}/lixeira`, { caminho: "atalho/segredo.txt" })).status, 403);
    // o próprio atalho nunca vai para a lixeira (poderia arrastar o destino)
    assert.equal((await post(app, `/api/pastas/${id}/lixeira`, { caminho: "atalho" })).status, 409);
    assert.equal(s.movidos.length, 0);
    assert.equal(fs.readFileSync(path.join(s.fora, "segredo.txt"), "utf8"), "conteúdo de fora");
    // a listagem da raiz mostra o atalho como atalho, sem seguir
    const ls = (await json(app, `/api/pastas/${id}/arquivos?caminho=`)).body.itens;
    assert.equal(ls.find((i) => i.nome === "atalho").tipo, "atalho");
  } finally {
    await app.close();
  }
});

test("pastas: se a pasta permitida vira junction para outro lugar depois de adicionada, o uso é recusado", async (t) => {
  const s = folderSetup();
  const app = await boot({ dataDir: s.dataDir, pickFolder: async () => s.raiz, trashItem: s.trashItem });
  try {
    const id = (await post(app, "/api/pastas/escolher", {})).body.pasta.id;
    const guardada = fs.readFileSync(path.join(s.dataDir, "pastas.json"), "utf8");
    const trocada = path.join(path.dirname(s.raiz), `${path.basename(s.raiz)}-antiga`);
    fs.renameSync(s.raiz, trocada);
    if (!tryLink(s.fora, s.raiz)) {
      fs.renameSync(trocada, s.raiz);
      t.skip("o sistema não deixou criar o junction/symlink de teste");
      return;
    }
    assert.ok(guardada.length > 0);
    assert.equal((await json(app, `/api/pastas/${id}/arquivos?caminho=`)).status, 409);
    assert.equal((await json(app, `/api/pastas/${id}/arquivo?caminho=segredo.txt`)).status, 409);
  } finally {
    await app.close();
  }
});

test("pastas: apagar vai para a Lixeira (nunca delete permanente); sem Lixeira nada é apagado", async () => {
  const s = folderSetup();
  const app = await boot({ dataDir: s.dataDir, pickFolder: async () => s.raiz, trashItem: s.trashItem });
  try {
    const id = (await post(app, "/api/pastas/escolher", {})).body.pasta.id;
    const alvo = path.join(s.raiz, "nota.txt");
    const out = await post(app, `/api/pastas/${id}/lixeira`, { caminho: "nota.txt" });
    assert.equal(out.status, 200);
    assert.match(out.body.mensagem, /Lixeira/);
    assert.equal(fs.existsSync(alvo), false);
    assert.equal(s.movidos.length, 1);
    assert.equal(fs.readFileSync(path.join(s.lixeira, "1-nota.txt"), "utf8"), "olá, nota normal", "o arquivo existe na lixeira, restaurável");
    // pasta inteira também vai para a lixeira
    assert.equal((await post(app, `/api/pastas/${id}/lixeira`, { caminho: "sub" })).status, 200);
    assert.equal(fs.readFileSync(path.join(s.lixeira, "2-sub", "dentro.txt"), "utf8"), "dentro");
    // a própria pasta permitida não vai
    assert.equal((await post(app, `/api/pastas/${id}/lixeira`, { caminho: "" })).status, 400);
    assert.equal(fs.existsSync(s.raiz), true);
    // arquivo inexistente
    assert.equal((await post(app, `/api/pastas/${id}/lixeira`, { caminho: "nao-existe.txt" })).status, 404);
  } finally {
    await app.close();
  }

  const s2 = folderSetup();
  const app2 = await boot({ dataDir: s2.dataDir, pickFolder: async () => s2.raiz });
  try {
    const info = (await json(app2, "/api/pastas")).body;
    assert.equal(info.lixeira, false);
    const id = (await post(app2, "/api/pastas/escolher", {})).body.pasta.id;
    const out = await post(app2, `/api/pastas/${id}/lixeira`, { caminho: "nota.txt" });
    assert.equal(out.status, 501);
    assert.equal(fs.existsSync(path.join(s2.raiz, "nota.txt")), true, "sem Lixeira, nada é apagado");
  } finally {
    await app2.close();
  }
});

test("pastas: o código de apagar não usa delete permanente", () => {
  const code = fs.readFileSync(path.join(__dirname, "..", "server", "safe-folders.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(/\b(rmSync|unlinkSync|rmdirSync|rm\(|unlink\(|rmdir\()/.test(code), false);
});

// ------------------------------------------------------------------ processo principal e utilitários

test("host: ganchos de teste só valem em modo demonstração; nome do arquivo é validado; Lixeira vem do shell", async () => {
  const saved = [];
  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: ["C:\\Escolhida"] }),
    showSaveDialog: async () => ({ canceled: false, filePath: path.join(tmp("save"), "x.json") }),
  };
  const trashed = [];
  const shell = { trashItem: async (p) => { trashed.push(p); } };
  const env = { HELIOS_TEST_FOLDER: "C:\\DoTeste", HELIOS_TEST_SAVE_DIR: tmp("hook") };
  const real = createContextHost({ dialog, shell, mock: false, env, documentsDir: os.tmpdir() });
  assert.equal(await real.pickFolder(), "C:\\Escolhida", "sem mock o gancho é ignorado");
  const mock = createContextHost({ dialog, shell, mock: true, env, documentsDir: os.tmpdir() });
  assert.equal(await mock.pickFolder(), "C:\\DoTeste");
  assert.equal((await mock.saveFile({ nome: "../x.json", texto: "{}" })).ok, false);
  assert.equal((await mock.saveFile({ nome: "helios-contexto-2026-10-25.json", texto: "" })).ok, false);
  const ok = await mock.saveFile({ nome: "helios-contexto-2026-10-25.json", texto: "{\"a\":1}" });
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(ok.caminho, "utf8"), "{\"a\":1}");
  assert.equal(path.dirname(ok.caminho), path.resolve(env.HELIOS_TEST_SAVE_DIR));
  const viaDialog = await real.saveFile({ nome: "helios-contexto-2026-10-25.json", texto: "{}" });
  assert.equal(viaDialog.ok, true);
  saved.push(viaDialog.caminho);
  await real.trashItem("C:\\algo");
  assert.deepEqual(trashed, ["C:\\algo"]);
  const cancel = createContextHost({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) }, shell, mock: false, env: {} });
  assert.equal(await cancel.pickFolder(), null);
  assert.equal((await cancel.saveFile({ nome: "helios-contexto-a.json", texto: "{}" })).cancelado, true);
});

test("máscara de segredos e URL/argumentos de conector", () => {
  assert.equal(findSecret("Bom dia, tudo bem?"), "");
  assert.notEqual(findSecret("a senha: hunter2secret99"), "");
  assert.notEqual(findSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "");
  assert.equal(maskSecrets("x ghp_abcdefghijklmnopqrstuvwxyz0123456789 y").includes("ghp_"), false);
  assert.notEqual(findSecret("chave solta a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1"), "");
  assert.deepEqual(safeUrl("https://user:pw@h.com/p?token=abc#x"), { url: "https://h.com/p", trimmed: true });
  assert.deepEqual(safeUrl("https://h.com/p"), { url: "https://h.com/p", trimmed: false });
  assert.deepEqual(safeArgs(["-y", "pkg", "--api-key", "abc123", "--ok", "v"]), ["-y", "pkg", "--api-key", "[segredo]", "--ok", "v"]);
});

test("interface: a tela Contexto existe e os ids data-view anteriores continuam", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  for (const view of ["chat", "inbox", "assistants", "vault", "mcp", "search", "memory", "context", "routines", "activity", "autonomy", "account"]) {
    assert.ok(html.includes(`data-view="${view}"`), view);
  }
  assert.ok(html.includes('id="inboxBadge"') && html.includes('id="activityBadge"'));
  assert.ok(html.includes('src="contexto.js"'));
  const js = fs.readFileSync(path.join(__dirname, "..", "renderer", "contexto.js"), "utf8");
  for (const id of ["ctxExport", "ctxFile", "ctxApply", "ctxAddFolder"]) assert.ok(js.includes(id), id);
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.ok(/context: \[/.test(app));
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload-main.cjs"), "utf8");
  assert.ok(preload.includes("contexto:salvar"));
});