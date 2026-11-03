"use strict";
// LEVA O1: quadro compartilhado + Chefe + MCP remoto preparado.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createQuadro } = require("../server/quadro");
const { createChefe } = require("../server/chefe");
const { createAssistants } = require("../server/assistants");
const { createMissions } = require("../server/missions");
const { createMcpServer, createMcpRemoteConfig, REMOTE_ALLOWLIST, bearerOk } = require("../server/mcp-server");
const { createVault } = require("../src/vault-store");
const { boot, json, rpcCall, TOKEN } = require("./helpers-ideias");

const tmp = (prefix = "helios-levaO1-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const XOR = 0x5a;
const xor = (text) => Buffer.from(String(text), "utf8").map((byte) => byte ^ XOR);
const unxor = (buf) => Buffer.from(buf).map((byte) => byte ^ XOR).toString("utf8");
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: xor,
    decryptString: unxor,
  };
}

test("levaO1: quadro postar/ler/atualizarStatus + oasis isolado", () => {
  const dir = tmp();
  const q = createQuadro(dir);
  const a = q.postar({ de: "vagas", para: "chefe", tipo: "achado", assunto: "Vaga React", corpo: "Junior React em SP" });
  assert.equal(a.status, "aberto");
  assert.ok(a.id.startsWith("qd"));
  const lista = q.ler({ para: "chefe", status: "aberto" });
  assert.equal(lista.length, 1);
  const done = q.atualizarStatus(a.id, "feito");
  assert.equal(done.status, "feito");
  assert.throws(() => q.postar({
    de: "vagas",
    para: "oasis",
    tipo: "pedido",
    assunto: "Candidatura LinkedIn",
    corpo: "Inscrição em vaga de emprego",
  }), /emprego|Oasis/i);
  q.close();
});

test("levaO1: Chefe ordem → quadro → ciclo delega; crítico pede aprovação; status sem inventar", async () => {
  const dir = tmp();
  const assistants = createAssistants(dir);
  assistants.seedBuiltins();
  const missions = createMissions(dir);
  const quadro = createQuadro(dir);
  const chefe = createChefe(dir, { quadro, missions, assistants, orchestration: null });
  chefe.seedPapeis();
  assert.ok(assistants.find("chefe"));
  assert.ok(assistants.find("pesquisa"));
  assert.ok(assistants.find("oasis"));
  assert.ok(assistants.find("portfolio"));
  assert.ok(assistants.find("vagas"));

  const out = await chefe.ordem("Priorize vagas de React e peça pesquisa das skills pedidas.");
  assert.ok(out.item.id);
  assert.equal(out.ciclo.ok, true);
  assert.ok(out.ciclo.delegados.length >= 1 || out.ciclo.lidos >= 1);

  const critico = quadro.postar({
    de: "helison",
    para: "chefe",
    tipo: "pedido",
    assunto: "Publicar no LinkedIn e pagar anúncio",
    corpo: "Quero publicar um post e pagar boost.",
  });
  const c2 = await chefe.ciclo({ forcar: true });
  assert.ok(c2.aprovacoes.some((a) => a.id === critico.id) || c2.aprovacoes.length >= 1);

  const st = chefe.status();
  assert.equal(typeof st.itensAbertos, "number");
  assert.ok(Array.isArray(st.agentes));
  assert.equal(st.agentes.length, 4);
  assert.ok(!("tokensInventados" in st));
  assert.equal(chefe.agenteStatus("vagas").id, "vagas");
  quadro.close();
});

test("levaO1: Chefe não transforma resultado recebido em novo pedido", async () => {
  const dir = tmp();
  const assistants = createAssistants(dir);
  assistants.seedBuiltins();
  const missions = createMissions(dir);
  const quadro = createQuadro(dir);
  const chefe = createChefe(dir, { quadro, missions, assistants });
  const retorno = quadro.postar({
    de: "vagas", para: "chefe", tipo: "resultado", assunto: "Resultado Vagas (ciclo)", corpo: "Busca concluída.",
  });
  const out = await chefe.ciclo({ forcar: true });
  assert.equal(out.delegados.length, 0);
  assert.ok(out.ignorados.some((item) => item.id === retorno.id && item.motivo === "retorno_recebido"));
  assert.equal(quadro.get(retorno.id).status, "feito");
  assert.equal(quadro.ler({ para: "vagas", status: "aberto" }).length, 0);
  quadro.close();
});

test("levaO1: Chefe encerra achado dos agentes sem delegá-lo de volta", async () => {
  const dir = tmp();
  const assistants = createAssistants(dir);
  assistants.seedBuiltins();
  const missions = createMissions(dir);
  const quadro = createQuadro(dir);
  const chefe = createChefe(dir, { quadro, missions, assistants });
  const achado = quadro.postar({
    de: "vagas", para: "chefe", tipo: "achado", assunto: "Achados Vagas: 2", corpo: "Duas vagas compatíveis.",
  });
  const out = await chefe.ciclo({ forcar: true });
  assert.equal(out.delegados.length, 0);
  assert.ok(out.ignorados.some((item) => item.id === achado.id && item.motivo === "retorno_recebido"));
  assert.equal(quadro.get(achado.id).status, "feito");
  quadro.close();
});

test("levaO1: MCP ferramentas quadro/chefe + remoto allowlist e desligado", async () => {
  const dir = tmp();
  const app = await boot({ dataDir: dir, chefeMs: 0, getMcpRemoteToken: () => "remote-token-levaO1-xxxxxxxx" });
  try {
    const list = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => r.json());
    const names = list.result.tools.map((t) => t.name);
    for (const n of ["helios_quadro_postar", "helios_quadro_ler", "helios_quadro_status", "helios_chefe_ordem", "helios_chefe_status", "helios_agente_status"]) {
      assert.ok(names.includes(n), n);
    }

    const post = await rpcCall(app, "helios_quadro_postar", {
      de: "vagas", para: "chefe", tipo: "achado", assunto: "Achado teste", corpo: "corpo do achado O1",
    });
    assert.ok(post.item?.id);

    const ordem = await rpcCall(app, "helios_chefe_ordem", { texto: "Delegue ao Vagas a varredura matinal." });
    assert.ok(ordem.item?.id);

    const status = await rpcCall(app, "helios_chefe_status", {});
    assert.ok(status.agentes?.length === 4);

    // Remoto desligado: token remoto deve falhar mesmo em loopback
    const remoteOff = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer remote-token-levaO1-xxxxxxxx" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.ok(remoteOff.status === 403 || remoteOff.status === 401);

    const cfg = await json(app, "/api/mcp/remoto");
    assert.equal(cfg.body.enabled, false);
    await json(app, "/api/mcp/remoto", { method: "POST", body: { enabled: true } });

    const remoteOn = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer remote-token-levaO1-xxxxxxxx" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    }).then((r) => r.json());
    const remoteNames = remoteOn.result.tools.map((t) => t.name);
    assert.deepEqual(new Set(remoteNames), new Set(REMOTE_ALLOWLIST));
    assert.ok(!remoteNames.includes("helios_consultar_memoria"));
    assert.ok(!remoteNames.includes("helios_enviar_mensagem"));

    const blocked = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer remote-token-levaO1-xxxxxxxx" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "helios_consultar_memoria", arguments: { consulta: "cpf" } },
      }),
    }).then((r) => r.json());
    const blockedText = blocked.result.content[0].text;
    assert.match(blockedText, /indisponível|remoto/i);
  } finally {
    await app.close();
  }
});

test("levaO1: token remoto separado no cofre; UI view só 'definido'", async () => {
  const dir = tmp("helios-vault-o1-");
  const vault = await createVault({ dir, safeStorage: fakeSafeStorage() });
  assert.equal(vault.hasMcpRemoteToken(), false);
  assert.equal(vault.mcpRemoteView().definido, false);
  const local = vault.mcpToken();
  const gen = await vault.generateMcpRemoteToken();
  assert.ok(gen.token);
  assert.notEqual(gen.token, local);
  assert.equal(vault.hasMcpRemoteToken(), true);
  assert.equal(vault.mcpRemoteView().definido, true);
  assert.ok(!("token" in vault.mcpRemoteView()));
  await vault.revokeMcpRemoteToken();
  assert.equal(vault.hasMcpRemoteToken(), false);
  await vault.flush();
});

test("levaO1: API quadro/chefe e seed de builtins O1", async () => {
  const dir = tmp();
  const app = await boot({ dataDir: dir, chefeMs: 0 });
  try {
    const asst = await json(app, "/api/assistants");
    const ids = (asst.body.assistants || []).map((a) => a.id);
    for (const id of ["chefe", "pesquisa", "oasis", "vagas", "portfolio"]) {
      assert.ok(ids.includes(id), `builtin ${id}`);
    }

    const post = await json(app, "/api/quadro", {
      method: "POST",
      body: { de: "pesquisa", para: "chefe", tipo: "resultado", assunto: "Lacuna Docker", corpo: "Docker pedido em 3 vagas lidas; evidência ausente no perfil." },
    });
    assert.equal(post.status, 201);
    assert.ok(post.body.item.id);

    const chefeSt = await json(app, "/api/chefe");
    assert.equal(chefeSt.status, 200);
    assert.ok(chefeSt.body.agentes.length === 4);
    assert.equal(typeof chefeSt.body.itensAbertos, "number");

    const ordem = await json(app, "/api/chefe/ordem", { method: "POST", body: { texto: "Peça ao Portfólio um mini-projeto com Docker." } });
    assert.equal(ordem.status, 200);
    assert.ok(ordem.body.ciclo);
  } finally {
    await app.close();
  }
});

test("levaO1: docs/operacao existem", () => {
  const root = path.join(__dirname, "..", "docs", "operacao");
  for (const name of [
    "README.md", "agentes.md", "quadro.md", "mcp.md", "acessos.md", "regras.md",
    "testes-e-instalacao.md", "tunel.md", "historico.md", "estado-atual.md",
    "proximos-passos.md", "HANDOFF.md", "CHANGELOG.md", "plano-reforma-agentes.md", "limpeza-repositorio.md",
  ]) {
    assert.ok(fs.existsSync(path.join(root, name)), name);
  }
});

test("levaO1: bearerOk e createMcpRemoteConfig padrão desligado", () => {
  const dir = tmp();
  const cfg = createMcpRemoteConfig(dir);
  assert.equal(cfg.isEnabled(), false);
  cfg.setEnabled(true);
  assert.equal(cfg.isEnabled(), true);
  assert.ok(bearerOk("Bearer abc", "abc"));
  assert.equal(bearerOk("Bearer abc", "xyz"), false);
  assert.ok(REMOTE_ALLOWLIST.includes("helios_chefe_ordem"));
  // createMcpServer mínimo só para garantir export
  assert.equal(typeof createMcpServer, "function");
});
