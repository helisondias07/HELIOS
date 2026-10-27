"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { newId, nowIso, readJson, writeJson } = require("./util");

function slug(text) {
  const base = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "projeto"}-${Date.now().toString(36)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function buildPlan(description) {
  const title = String(description || "").trim().replace(/\s+/g, " ").slice(0, 80) || "PÃ¡gina de exemplo";
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <p class="kicker">HELIOS Â· livecoding</p>
    <h1>${escapeHtml(title)}</h1>
    <p id="texto">Estrutura pronta. O estilo entra no prÃ³ximo passo.</p>
    <button id="mais" type="button">Mostrar a explicaÃ§Ã£o</button>
    <p id="extra" hidden>Cada arquivo faz uma coisa sÃ³: HTML organiza, CSS pinta, JavaScript reage ao clique.</p>
  </main>
  <script src="script.js"></script>
</body>
</html>
`;
  const css = `/* Visual simples de propÃ³sito, para ler com um estagiÃ¡rio. */
body { margin: 0; font-family: "Segoe UI", sans-serif; background: #f6f1e8; color: #221c16; }
main { max-width: 38rem; margin: 10vh auto; padding: 2rem; }
.kicker { letter-spacing: .08em; text-transform: uppercase; font-size: .75rem; color: #8a5a2a; }
h1 { font-size: 2.2rem; line-height: 1.15; margin: .2rem 0 1rem; }
button { background: #221c16; color: #fff; border: 0; border-radius: 999px; padding: .7rem 1.1rem; font: inherit; cursor: pointer; }
#extra { margin-top: 1rem; }
`;
  const js = `// Mostra o parÃ¡grafo escondido. Um passo de cada vez.
const botao = document.querySelector("#mais");
const extra = document.querySelector("#extra");
botao.addEventListener("click", () => {
  extra.hidden = !extra.hidden;
  botao.textContent = extra.hidden ? "Mostrar a explicaÃ§Ã£o" : "Esconder a explicaÃ§Ã£o";
});
`;
  return {
    title,
    steps: [
      {
        n: 1,
        titulo: "Criar a estrutura HTML",
        explicacao: "O primeiro arquivo Ã© o esqueleto: tÃ­tulo, um texto e um botÃ£o. Ainda sem cor. No VS Code, abra index.html e leia a estrutura com o estagiÃ¡rio.",
        files: [{ path: "index.html", contents: html }],
      },
      {
        n: 2,
        titulo: "Pintar a pÃ¡gina com CSS",
        explicacao: "O visual fica num arquivo separado. Mostre que o HTML sÃ³ aponta para o style.css â€” a cor nÃ£o mora no meio do conteÃºdo.",
        files: [{ path: "style.css", contents: css }],
      },
      {
        n: 3,
        titulo: "Reagir ao clique com JavaScript",
        explicacao: "Pouco cÃ³digo: o botÃ£o revela uma frase. Leia o script.js linha a linha. O clique no navegador fica para depois da revisÃ£o.",
        files: [{ path: "script.js", contents: js }],
      },
      {
        n: 4,
        titulo: "Revisar junto e parar",
        explicacao: "Pare aqui. PeÃ§a ao estagiÃ¡rio para explicar o que cada arquivo faz. O HELIOS nÃ£o avanÃ§a sozinho.",
        files: [],
      },
    ],
  };
}

function safeRel(rel) {
  const cleaned = String(rel || "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (!cleaned || cleaned.includes("..") || cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) return null;
  if (!/^[\w./-]+$/.test(cleaned)) return null;
  // Nada de arquivo ou pasta oculta (.git, .vscode, .env...): o livecoding sÃ³ cria arquivos de pÃ¡gina.
  if (cleaned.split("/").some((part) => part.startsWith("."))) return null;
  return cleaned;
}

function normalizePlan(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title || raw.titulo || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const incoming = Array.isArray(raw.steps) ? raw.steps : [];
  if (!title || incoming.length < 2) return null;
  const steps = [];
  for (const step of incoming.slice(0, 6)) {
    const titulo = String(step?.titulo || step?.title || "").trim().slice(0, 140);
    const explicacao = String(step?.explicacao || step?.explanation || "").trim().slice(0, 800);
    if (!titulo || !explicacao) return null;
    const files = [];
    for (const file of step.files || []) {
      const rel = safeRel(file?.path);
      if (!rel || typeof file.contents !== "string") return null;
      files.push({ path: rel, contents: file.contents.slice(0, 20000) });
    }
    steps.push({ n: steps.length + 1, titulo, explicacao, files });
  }
  return steps.length >= 2 ? { title, steps } : null;
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

/** Plano local quando nÃ£o hÃ¡ modelo: o pedido entra nos passos, e o primeiro arquivo continua sendo index.html. */
function draftPlanFromRequest(description) {
  const plan = buildPlan(description);
  const pedido = String(description || "").trim().replace(/\s+/g, " ").slice(0, 240);
  if (!pedido) return plan;
  const titulos = [
    `HTML do pedido: ${pedido}`.slice(0, 140),
    `CSS do pedido: ${pedido}`.slice(0, 140),
    `JavaScript do pedido: ${pedido}`.slice(0, 140),
    `Revisar o pedido: ${pedido}`.slice(0, 140),
  ];
  plan.steps.forEach((step, index) => {
    step.titulo = titulos[index] || step.titulo;
    step.explicacao = `${step.explicacao} Pedido original: ${pedido}.`;
  });
  return plan;
}

function planMarkdown(plan) {
  const lines = [`# ${plan.title}`, "", "Plano do livecoding. Avance um passo por vez.", ""];
  for (const step of plan.steps) lines.push(`${step.n}. **${step.titulo}** â€” ${step.explicacao}`, "");
  return lines.join("\n");
}

function safeJoin(folder, rel) {
  const target = path.resolve(folder, String(rel || ""));
  const diff = path.relative(path.resolve(folder), target);
  if (!rel || !diff || diff.startsWith("..") || path.isAbsolute(diff)) return null;
  return target;
}

function writeFiles(folder, files) {
  for (const file of files || []) {
    const target = safeJoin(folder, file.path);
    if (!target) throw new Error(`caminho recusado: ${file.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.contents, "utf8");
  }
}

function openInVSCode(folder, spawnImpl = spawn) {
  const cmd = process.platform === "win32" ? "code.cmd" : "code";
  try {
    const child = spawnImpl(cmd, [folder], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.on?.("error", () => {});
    child.unref?.();
    return { ok: true, cmd, folder };
  } catch (err) {
    return { ok: false, cmd, folder, error: err.message || `NÃ£o achei o VS Code (${cmd}).` };
  }
}

function stepStatus(session, index) {
  if (index < session.cursor) return "done";
  if (session.status !== "done" && index === session.cursor) return "current";
  return "pending";
}

function view(session) {
  return {
    id: session.id,
    title: session.title,
    description: session.description,
    folder: session.folder,
    status: session.status,
    cursor: session.cursor,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastNote: session.lastNote || "",
    via: session.via || "",
    editor: session.editor || null,
    steps: session.steps.map((step, index) => ({
      n: step.n,
      titulo: step.titulo,
      explicacao: step.explicacao,
      status: stepStatus(session, index),
    })),
  };
}

function createLivecoding({ rootDir, openEditor = openInVSCode, runAgentStep = null, proposePlan = null }) {
  fs.mkdirSync(rootDir, { recursive: true });
  const file = path.join(rootDir, "sessions.json");
  let sessions = readJson(file, []);
  if (!Array.isArray(sessions)) sessions = [];
  const save = () => writeJson(file, sessions);
  // Passo "running" salvo antes de um fechamento nunca terminaria: a sessÃ£o ficava presa em 409.
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
    const folder = path.join(rootDir, slug(plan.title));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "PLANO.md"), planMarkdown(plan), "utf8");
    let editor;
    try {
      editor = await Promise.resolve(openEditor(folder));
      if (!editor || typeof editor !== "object") editor = { ok: true, folder };
    } catch (err) {
      editor = { ok: false, folder, error: String(err.message || err) };
    }
    const session = {
      id: newId("live"),
      title: plan.title,
      description: String(description || "").slice(0, 400),
      folder,
      steps: plan.steps,
      cursor: 0,
      status: "paused",
      lastNote: editor?.ok === false
        ? `Plano pronto em ${folder}. NÃ£o abri o VS Code (${editor.error || "comando code"}). Aperte PrÃ³ximo passo para criar o primeiro arquivo.`
        : "Plano pronto. A pasta foi aberta no VS Code. Nada foi codado ainda â€” aperte PrÃ³ximo passo.",
      via: "",
      editor: { ok: editor?.ok !== false, error: editor?.error || "", cmd: editor?.cmd || "" },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    sessions.unshift(session);
    save();
    return view(session);
  }

  async function next(id) {
    const session = get(id);
    if (!session) throw Object.assign(new Error("sessÃ£o nÃ£o encontrada"), { status: 404 });
    if (session.status === "done" || session.cursor >= session.steps.length) {
      session.status = "done";
      save();
      return view(session);
    }
    if (session.status === "running") throw Object.assign(new Error("jÃ¡ tem um passo em andamento"), { status: 409 });
    const step = session.steps[session.cursor];
    session.status = "running";
    session.updatedAt = nowIso();
    save();
    let applied = null;
    try {
      if (runAgentStep) applied = await runAgentStep({ folder: session.folder, step });
      const missing = (step.files || []).filter((item) => !fs.existsSync(path.join(session.folder, item.path)));
      if (missing.length) {
        writeFiles(session.folder, missing);
        applied = { via: applied ? "agente+plano" : "plano", text: applied?.text || step.explicacao };
      } else if (!applied) {
        applied = { via: "plano", text: step.explicacao };
      }
    } catch (err) {
      session.status = "paused";
      session.lastNote = `O passo parou antes de gravar: ${err.message || err}`;
      session.updatedAt = nowIso();
      save();
      throw err;
    }
    session.cursor += 1;
    session.status = session.cursor >= session.steps.length ? "done" : "paused";
    session.via = applied.via || "plano";
    session.lastNote = applied.text || step.explicacao;
    session.updatedAt = nowIso();
    save();
    return view(session);
  }

  return { start, next, get: (id) => { const session = get(id); return session ? view(session) : null; }, list: () => sessions.map(view), rootDir };
}

module.exports = {
  createLivecoding, buildPlan, draftPlanFromRequest, normalizePlan, parsePlanJson, openInVSCode, safeJoin, safeRel, writeFiles, planMarkdown,
};
