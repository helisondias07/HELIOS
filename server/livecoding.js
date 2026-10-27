"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { newId, nowIso, readJson, writeJson } = require("./util");

/**
 * Roteiro guiado do livecoding. O HELIOS mostra o que digitar e por quê.
 * Não cria pasta de projeto, não grava os arquivos da aula e não abre editor.
 * O único arquivo em disco é o estado da sessão (sessions.json), para retomar depois de fechar.
 */

function clipTitle(text) {
  return String(text || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function clipPedido(text) {
  return String(text || "").trim().replace(/\s+/g, " ").slice(0, 240);
}

function langOf(rel) {
  const ext = String(rel).split(".").pop();
  if (ext === "html") return "html";
  if (ext === "css") return "css";
  if (ext === "js") return "js";
  return ext || "texto";
}

function safeRel(rel) {
  const cleaned = String(rel || "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (!cleaned || cleaned.includes("..") || cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) return null;
  if (!/^[\w./-]+$/.test(cleaned)) return null;
  if (cleaned.split("/").some((part) => part.startsWith("."))) return null;
  return cleaned;
}

function safeJoin(folder, rel) {
  const target = path.resolve(folder, String(rel || ""));
  const diff = path.relative(path.resolve(folder), target);
  if (!rel || !diff || diff.startsWith("..") || path.isAbsolute(diff)) return null;
  return target;
}

function arquivo(rel, papel) {
  return { path: rel, papel, linguagem: langOf(rel) };
}

function pageRoteiro(description) {
  const pedido = clipPedido(description) || "uma página simples";
  const title = clipTitle(description) || "Página de exemplo";
  return {
    title,
    visao: `Vamos construir uma página pequena sobre “${pedido}”. São 1 HTML, 1 CSS e 1 JS. O HTML organiza, o CSS pinta e o JavaScript reage ao clique. Você digita; o HELIOS não grava arquivo e não abre editor.`,
    arquivos: [
      arquivo("index.html", "Esqueleto: título, um texto e um botão."),
      arquivo("style.css", "Cores e espaçamento, separados do conteúdo."),
      arquivo("script.js", "O clique mostra ou esconde a explicação."),
    ],
    secoes: [
      {
        titulo: "Escrever o esqueleto",
        explicacao: "O primeiro arquivo só marca as partes da página. Ainda sem cor, para o estagiário ver a estrutura. Pedido original: " + pedido + ".",
        arquivo: "index.html",
        onde: "Arquivo novo index.html, o conteúdo inteiro.",
        codigo: `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>${title.replace(/[<>]/g, "")}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <p class="kicker">Aula ao vivo</p>
    <h1>${title.replace(/[<>]/g, "")}</h1>
    <p id="texto">Estrutura pronta. O estilo entra no próximo bloco.</p>
    <button id="mais" type="button">Mostrar a explicação</button>
    <p id="extra" hidden>Cada arquivo faz uma coisa só.</p>
  </main>
  <script src="script.js"></script>
</body>
</html>
`,
      },
      {
        titulo: "Pintar com CSS",
        explicacao: "A cor mora no CSS, não no meio do texto. Assim dá para mudar o visual sem reescrever o conteúdo.",
        arquivo: "style.css",
        onde: "Arquivo novo style.css, o conteúdo inteiro.",
        codigo: `body { margin: 0; font-family: "Segoe UI", sans-serif; background: #f6f1e8; color: #221c16; }
main { max-width: 40rem; margin: 8vh auto; padding: 2rem; }
.kicker { letter-spacing: .08em; text-transform: uppercase; font-size: .75rem; color: #8a5a2a; }
h1 { font-size: 2rem; line-height: 1.2; margin: .2rem 0 1rem; }
button { background: #221c16; color: #fff; border: 0; border-radius: 999px; padding: .7rem 1.1rem; font: inherit; cursor: pointer; }
#extra { margin-top: 1rem; }
`,
      },
      {
        titulo: "Reagir ao clique",
        explicacao: "Pouco código: o botão revela uma frase. Leia em voz alta o que cada linha faz e só então peça para o estagiário copiar.",
        arquivo: "script.js",
        onde: "Arquivo novo script.js, o conteúdo inteiro.",
        codigo: `const botao = document.querySelector("#mais");
const extra = document.querySelector("#extra");
botao.addEventListener("click", () => {
  extra.hidden = !extra.hidden;
  botao.textContent = extra.hidden ? "Mostrar a explicação" : "Esconder a explicação";
});
`,
      },
      {
        titulo: "Revisar junto e parar",
        explicacao: "Peça ao estagiário para dizer o papel de cada arquivo. O HELIOS não avança sozinho e não salva nada.",
        arquivo: "",
        onde: "",
        codigo: "",
      },
    ],
  };
}

function apiRoteiro(description) {
  const pedido = clipPedido(description) || "importação de API";
  return {
    title: clipTitle(pedido) || "Importação de API",
    visao: `Vamos montar uma página que busca dados (${pedido}). São 2 HTML, 2 JS e 1 CSS. A busca fica num arquivo, o desenho da tela em outro. Você digita cada bloco; o HELIOS não grava disco e não abre editor.`,
    arquivos: [
      arquivo("index.html", "Página principal, onde a lista aparece."),
      arquivo("sobre.html", "Segunda página, para mostrar um link entre telas."),
      arquivo("js/api.js", "Função que busca o JSON e devolve os dados."),
      arquivo("js/ui.js", "Desenha o resultado na página."),
      arquivo("css/estilo.css", "Visual largo, legível numa tela compartilhada."),
    ],
    secoes: [
      {
        titulo: "A página que a pessoa abre",
        explicacao: "O HTML só reserva o lugar da lista e aponta para os outros arquivos. A busca ainda não mora aqui, para o estagiário separar estrutura de comportamento.",
        arquivo: "index.html",
        onde: "Arquivo novo index.html, o conteúdo inteiro.",
        codigo: `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Lista da API</title>
  <link rel="stylesheet" href="css/estilo.css">
</head>
<body>
  <main>
    <p class="kicker">Aula · importação de API</p>
    <h1>O que a API devolveu</h1>
    <p><a href="sobre.html">Sobre esta página</a></p>
    <button id="carregar" type="button">Carregar</button>
    <p id="aviso"></p>
    <ul id="lista"></ul>
  </main>
  <script src="js/api.js"></script>
  <script src="js/ui.js"></script>
</body>
</html>
`,
      },
      {
        titulo: "A função que busca",
        explicacao: "Um arquivo só para falar com a API. Se a rede falhar, a função avisa em vez de quebrar a página. Troque o endereço pelo da aula quando for usar dados de verdade.",
        arquivo: "js/api.js",
        onde: "Arquivo novo js/api.js, o conteúdo inteiro.",
        codigo: `async function buscarItens(url) {
  const resposta = await fetch(url);
  if (!resposta.ok) throw new Error("A API respondeu " + resposta.status);
  const dados = await resposta.json();
  return Array.isArray(dados) ? dados : [];
}
`,
      },
      {
        titulo: "Desenhar a lista",
        explicacao: "Outro arquivo decide o que aparece na tela. Assim dá para explicar a busca sem misturar com o HTML montado na hora.",
        arquivo: "js/ui.js",
        onde: "Arquivo novo js/ui.js, o conteúdo inteiro.",
        codigo: `const botao = document.querySelector("#carregar");
const lista = document.querySelector("#lista");
const aviso = document.querySelector("#aviso");

botao.addEventListener("click", async () => {
  aviso.textContent = "Buscando…";
  lista.innerHTML = "";
  try {
    const itens = await buscarItens("https://jsonplaceholder.typicode.com/todos?_limit=5");
    for (const item of itens) {
      const li = document.createElement("li");
      li.textContent = item.title;
      lista.append(li);
    }
    aviso.textContent = itens.length + " itens.";
  } catch (erro) {
    aviso.textContent = "Não deu para buscar: " + erro.message;
  }
});
`,
      },
      {
        titulo: "A segunda página",
        explicacao: "Um segundo HTML mostra que um site pequeno já tem navegação. O link volta para a lista.",
        arquivo: "sobre.html",
        onde: "Arquivo novo sobre.html, o conteúdo inteiro.",
        codigo: `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Sobre</title>
  <link rel="stylesheet" href="css/estilo.css">
</head>
<body>
  <main>
    <h1>Sobre</h1>
    <p>Esta página não busca a API. Ela existe para o estagiário ver dois HTML no mesmo trabalho.</p>
    <p><a href="index.html">Voltar à lista</a></p>
  </main>
</body>
</html>
`,
      },
      {
        titulo: "O visual para projetar",
        explicacao: "Fonte grande e contraste alto, porque a aula vai para uma tela compartilhada. A cor não muda o que a API devolve.",
        arquivo: "css/estilo.css",
        onde: "Arquivo novo css/estilo.css, o conteúdo inteiro.",
        codigo: `body { margin: 0; font-family: "Segoe UI", sans-serif; font-size: 18px; line-height: 1.45; background: #f6f1e8; color: #221c16; }
main { max-width: 42rem; margin: 6vh auto; padding: 1.5rem; }
.kicker { letter-spacing: .08em; text-transform: uppercase; font-size: .8rem; color: #8a5a2a; }
a { color: #0f766e; }
button { background: #221c16; color: #fff; border: 0; border-radius: 999px; padding: .6rem 1rem; font: inherit; cursor: pointer; }
li { margin: .4rem 0; }
`,
      },
      {
        titulo: "Revisar e parar",
        explicacao: "Peça para o estagiário apontar qual arquivo busca, qual desenha e qual só liga um no outro. Nada foi salvo pelo HELIOS.",
        arquivo: "",
        onde: "",
        codigo: "",
      },
    ],
  };
}

function buildPlan(description) {
  const text = String(description || "");
  if (/\b(api|fetch|importa)/i.test(text)) return apiRoteiro(text);
  return pageRoteiro(text);
}

function draftPlanFromRequest(description) {
  return buildPlan(description);
}

function normalizePlan(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = clipTitle(raw.title || raw.titulo);
  const visao = String(raw.visao || raw.overview || "").trim().slice(0, 800);
  const arquivosIn = Array.isArray(raw.arquivos) ? raw.arquivos : [];
  const secoesIn = Array.isArray(raw.secoes) ? raw.secoes : [];
  if (!title || visao.length < 8 || arquivosIn.length < 1 || secoesIn.length < 2) return null;
  const arquivos = [];
  for (const file of arquivosIn.slice(0, 8)) {
    const rel = safeRel(file?.path || file?.caminho);
    const papel = String(file?.papel || file?.role || "").trim().slice(0, 200);
    if (!rel || papel.length < 3) return null;
    arquivos.push({ path: rel, papel, linguagem: langOf(rel) });
  }
  const known = new Set(arquivos.map((item) => item.path));
  const secoes = [];
  for (const sec of secoesIn.slice(0, 12)) {
    const titulo = String(sec?.titulo || sec?.title || "").trim().slice(0, 140);
    const explicacao = String(sec?.explicacao || sec?.explanation || "").trim().slice(0, 800);
    const arquivoRel = sec?.arquivo || sec?.path ? safeRel(sec.arquivo || sec.path) : "";
    if (sec?.arquivo || sec?.path) {
      if (!arquivoRel || !known.has(arquivoRel)) return null;
    }
    const onde = String(sec?.onde || sec?.where || "").trim().slice(0, 240);
    const codigo = String(sec?.codigo || sec?.code || "");
    if (!titulo || explicacao.length < 8) return null;
    if (codigo && !arquivoRel) return null;
    secoes.push({ titulo, explicacao, arquivo: arquivoRel || "", onde, codigo: codigo.slice(0, 8000) });
  }
  return secoes.length >= 2 ? { title, visao, arquivos, secoes } : null;
}

function parsePlanJson(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function totalOf(session) {
  const n = Array.isArray(session.secoes) ? session.secoes.length : 0;
  return Math.max(1, n + 1);
}

function view(session) {
  const secoes = Array.isArray(session.secoes) ? session.secoes : [];
  const total = totalOf(session);
  const cursor = Math.min(Math.max(0, Number(session.cursor) || 0), total - 1);
  const tela = cursor === 0 ? "mapa" : "secao";
  const atual = tela === "secao" ? { n: cursor, ...secoes[cursor - 1] } : null;
  return {
    id: session.id,
    title: session.title,
    description: session.description || "",
    status: session.status,
    cursor,
    total,
    tela,
    visao: session.visao || "",
    arquivos: session.arquivos || [],
    atual,
    progresso: total <= 1 ? 1 : cursor / (total - 1),
    gravouDisco: false,
    abriuEditor: false,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function createLivecoding({ rootDir, proposePlan = null } = {}) {
  fs.mkdirSync(rootDir, { recursive: true });
  const file = path.join(rootDir, "sessions.json");
  let sessions = readJson(file, []);
  if (!Array.isArray(sessions)) sessions = [];
  const save = () => writeJson(file, sessions);
  let reset = false;
  for (const session of sessions) {
    if (session && session.status === "running") {
      session.status = "paused";
      reset = true;
    }
  }
  if (reset) save();

  function get(id) {
    return sessions.find((session) => session.id === id) || null;
  }

  async function start(description) {
    let plan = null;
    if (typeof proposePlan === "function") {
      try {
        plan = normalizePlan(await proposePlan(description));
      } catch {
        plan = null;
      }
    }
    if (!plan) plan = buildPlan(description);
    const session = {
      id: newId("live"),
      title: plan.title,
      description: clipPedido(description),
      visao: plan.visao,
      arquivos: plan.arquivos,
      secoes: plan.secoes,
      cursor: 0,
      status: "paused",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    sessions.unshift(session);
    save();
    return view(session);
  }

  function move(id, delta) {
    const session = get(id);
    if (!session) throw Object.assign(new Error("sessão não encontrada"), { status: 404 });
    const total = totalOf(session);
    const next = Math.min(total - 1, Math.max(0, (Number(session.cursor) || 0) + delta));
    session.cursor = next;
    session.status = next >= total - 1 && delta > 0 ? "done" : "paused";
    if (delta < 0) session.status = "paused";
    session.updatedAt = nowIso();
    save();
    return view(session);
  }

  return {
    start,
    next: (id) => move(id, 1),
    prev: (id) => move(id, -1),
    get: (id) => { const session = get(id); return session ? view(session) : null; },
    list: () => sessions.map(view),
    rootDir,
  };
}

module.exports = {
  createLivecoding, buildPlan, draftPlanFromRequest, normalizePlan, parsePlanJson, safeJoin, safeRel,
};
