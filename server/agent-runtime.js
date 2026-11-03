"use strict";

/**
 * LEVA I: agentes autônomos de verdade. Cada agente é um registro persistente (dataDir/agentes/<id>.json) que roda
 * em segundo plano no processo principal, independente da tela aberta e da janela minimizada na bandeja.
 * O "cérebro" é o agente local do @cursor/sdk (Agent.create/send/stream/wait/cancel, resume pelo agentId).
 * As ferramentas embutidas do SDK (shell, edit, delete) ficam desligadas porque não passam por aprovação;
 * no lugar delas o agente recebe ferramentas do HELIOS (customTools), todas passando por este gate:
 * PowerShell, arquivos, navegador próprio, pergunta e conclusão. Ação crítica vira cartão na Caixa de entrada/Telegram.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");
const { unwrapStreamEvent, extractAssistantText } = require("./sdk-events");
const { digestOf } = require("./approval-preview");
const { classifyToolDetailed } = require("./irreversible");

const STATUS = ["queued", "working", "waiting_you", "paused", "done", "error"];
const DEFAULT_LIMITS = { concorrencia: 3, maxPassos: 200, maxMinutos: 120 };
const MAX_STEPS_KEPT = 400;
const OUT_MAX = 6000;

const clip = (text, n = 300) => {
  const value = String(text ?? "");
  return value.length > n ? `${value.slice(0, n - 1)}…` : value;
};

/** Nome curto a partir da primeira instrução (sem pontuação final, até 48 caracteres). */
function nameFromTask(task) {
  const first = String(task || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] || "Agente";
  const cut = first.length > 48 ? `${first.slice(0, 47).replace(/\s+\S*$/, "")}…` : first;
  return cut.replace(/[.!?:;,]+$/, "").replace(/^./, (c) => c.toUpperCase()) || "Agente";
}

const sameCase = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
/** `child` está dentro de `root` (ou é ele)? */
function insideRoot(child, root) {
  if (!child || !root) return false;
  const rel = path.relative(sameCase(path.resolve(root)), sameCase(path.resolve(child)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Arquivo que pode guardar segredo: nunca é lido nem mostrado ao modelo. */
const SECRET_FILE = /(^|[\\/])(\.env(\.[^\\/]*)?|id_(rsa|ed25519|ecdsa)[^\\/]*|[^\\/]*\.(pem|key|pfx|p12|kdbx)|credentials(\.json)?|auth\.json|vault[^\\/]*\.(json|bin|dat)|\.npmrc|\.git-credentials)$/i;
function isSecretPath(p) { return SECRET_FILE.test(String(p || "")); }

/**
 * PowerShell: o que precisa de cartão. null = pode rodar sozinho.
 * `segredo` nunca roda (ler .env, variáveis de chave, cofre).
 */
function classifyShell(command) {
  const c = String(command || "");
  if (/\.env\b|\.ssh\b|id_(rsa|ed25519|ecdsa|dsa)\b|\.pem\b|\.pfx\b|\.p12\b|\bcredentials?\b|Login Data|Cookies\b|\.git-credentials|\$env:[\w]*(KEY|TOKEN|SECRET|PASS|SENHA)|Get-Credential|ConvertFrom-SecureString|safeStorage|vault/i.test(c)) return { tipo: "segredo", motivo: "mexe com segredo (chave, senha, .env ou cofre)" };
  if (/\b(winget|choco|scoop|msiexec|Install-Package|Install-Module|Add-AppxPackage|pip3?\s+install)\b|\b(npm|pnpm|yarn)\s+(i|install|add)\s+(?!-)[\w@./-]|(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)\b|npx\s+-y\b|\.msi\b|setup\.exe/i.test(c)) return { tipo: "instalar", motivo: "instala software" };
  if (/\breg(\.exe)?\s+(add|delete|import|load)\b|HKLM:|HKCU:|Registry::|(New|Set|Remove)-ItemProperty|Set-ExecutionPolicy|\bbcdedit\b|\bnetsh\b|\bshutdown\b|Restart-Computer|Stop-Computer|\bschtasks\b|\bsc(\.exe)?\s+(create|delete|config|stop)\b|Set-Service|Stop-Process|\btaskkill\b|Disable-|Enable-WindowsOptionalFeature|\bformat\b\s+[a-z]:/i.test(c)) return { tipo: "sistema", motivo: "mexe no sistema (registro, serviços, processos ou energia)" };
  if (/\b(Remove-Item|rm|rmdir|rd|del|erase|Clear-Content|Clear-RecycleBin)\b|git\s+(clean|reset\s+--hard|push\s+.*--force)|Format-Volume/i.test(c)) return { tipo: "apagar", motivo: "apaga arquivos ou dados" };
  if (/Send-MailMessage|\bgit\s+push\b|\bnpm\s+publish\b|Invoke-(WebRequest|RestMethod)[^|;]*-Method\s+(Post|Put|Patch|Delete)|\bcurl(\.exe)?\b[^|;]*(-X\s*(POST|PUT|PATCH|DELETE)|\s-d\s|--data)/i.test(c)) return { tipo: "enviar", motivo: "envia dados para fora (e-mail, push, publicação ou POST)" };
  return null;
}

/** Clique no navegador: o que precisa de cartão (pagar, termos novos, enviar mensagem, publicar). */
function classifyClick(label, pageText = "") {
  const l = String(label || "").toLowerCase();
  const page = String(pageText || "").toLowerCase();
  if (/(pagar|pagamento|finalizar (a )?(compra|pedido)|comprar agora|fechar pedido|assinar (o )?plano|place order|pay now|buy now|checkout|confirmar compra)/.test(l)) return { tipo: "pagar", motivo: "parece um pagamento" };
  if (/(aceito|concordo|i agree|i accept|accept (all|the)|aceitar (os )?termos)/.test(l) && /(termos|terms|política|policy|privacidade|privacy|contrato)/.test(`${l} ${page}`)) return { tipo: "termos", motivo: "aceita termos legais novos" };
  if (/(enviar candidatura|candidatar|submit application|apply now|enviar inscri)/.test(l)) return { tipo: "enviar", motivo: "envia uma candidatura" };
  if (/(enviar mensagem|send message|mandar mensagem|^enviar$|^send$|responder|reply|enviar e-?mail|send email)/.test(l)) return { tipo: "enviar", motivo: "envia uma mensagem" };
  if (/(publicar|postar|^post$|tweet|compartilhar|share)/.test(l)) return { tipo: "publicar", motivo: "publica algo" };
  return null;
}

/** Tipos que nunca rodam sozinhos, nem com Autonomia liberada. */
const ALWAYS_ASK = new Set(["pagar", "termos", "instalar", "sistema", "segredo", "preencher"]);

/** Tipos de cartão que exigem segurar o botão para aprovar. */
const HOLD_REQUIRED = new Set(["pagar", "termos", "instalar", "sistema", "apagar", "segredo"]);

const TOOL_FRIENDLY = {
  pc_powershell: "PowerShell",
  perguntar_ao_helison: "pergunta",
  consultar_agente: "consulta",
  concluir: "conclusão",
};

function shortToolName(raw) {
  return String(raw || "").replace(/^.*[.:/]/, "");
}

function friendlyToolLabel(name) {
  const n = shortToolName(name);
  if (n.startsWith("navegador_")) return "navegador";
  if (n.startsWith("arquivo_")) return "arquivos";
  return TOOL_FRIENDLY[n] || n;
}

function toolsLabelFrom(used = []) {
  const seen = new Set();
  const labels = [];
  for (const t of used) {
    const label = friendlyToolLabel(t);
    if (!seen.has(label)) { seen.add(label); labels.push(label); }
  }
  return labels.join(", ");
}

/**
 * Pendência do usuário no agente: handoff (captcha/2FA), aprovação, pergunta ou decisão de missão.
 * O status público vira waiting_you enquanto qualquer uma estiver aberta — mesmo se o worker já terminou (done).
 */
function hasUserPending(rec, missionPending = null) {
  if (!rec) return false;
  if ((rec.approvals || []).some((a) => a.state === "pending")) return true;
  if ((rec.questions || []).some((q) => q.state === "pending")) return true;
  if (rec.browserHandoff && rec.browserHandoff.state === "waiting") return true;
  const localMissions = rec.missionDecisions || [];
  if (localMissions.some((d) => d.state === "aberta")) return true;
  // Callback de missão só conta se o agente ainda não rastreia decisões locais (já respondidas = resolvido).
  if (localMissions.length === 0 && typeof missionPending === "function") {
    try { if (missionPending(rec)) return true; } catch { /* missões opcionais */ }
  }
  return false;
}

function pendingMotivo(rec) {
  if (rec.browserHandoff && rec.browserHandoff.state === "waiting") return "navegador";
  if ((rec.approvals || []).some((a) => a.state === "pending")) return "aprovação";
  if ((rec.questions || []).some((q) => q.state === "pending")) return "pergunta";
  if ((rec.missionDecisions || []).some((d) => d.state === "aberta")) return "missão";
  return "aguardando você";
}

/** Status exibido no card: prioriza pendência do usuário sobre o status real do worker. */
function derivedStatus(rec, missionPending = null) {
  if (hasUserPending(rec, missionPending)) return "waiting_you";
  return rec.status;
}

function acaoExataOf(action) {
  const a = action || {};
  if (a.op === "shell") return String(a.comando || "");
  if (a.op === "escrever") return `${a.caminho || ""}\n${clip(String(a.conteudo ?? ""), 300)}`.trim();
  if (a.op === "clicar") return [a.seletor, a.texto].filter(Boolean).join(" · ") || "clique";
  if (a.op === "apagar") return String(a.caminho || "");
  if (a.op === "mcp") return `${a.servidor || ""}.${a.ferramenta || ""}\n${clip(JSON.stringify(a.argumentos || {}), 300)}`.trim();
  if (a.op === "memory_forget") return `memória ${a.id || ""}`.trim();
  return clip(JSON.stringify(a), 400);
}

function trackTool(rec, rawName) {
  const name = shortToolName(rawName);
  if (!name) return;
  if (!rec.toolsUsed) rec.toolsUsed = [];
  if (!rec.toolsUsed.includes(name)) rec.toolsUsed.push(name);
}

function humanStep(name, args = {}) {
  const a = args || {};
  const map = {
    navegador_abrir: () => `Abrindo ${clip(a.url, 80)}`,
    navegador_ler: () => "Lendo a página",
    navegador_clicar: () => `Clicando em ${clip(a.texto || a.seletor, 60)}`,
    navegador_digitar: () => `Digitando em ${clip(a.seletor || a.campo, 60)}`,
    navegador_selecionar: () => `Escolhendo ${clip(a.valor, 40)}`,
    navegador_enviar_arquivo: () => `Anexando ${path.basename(String(a.caminho || ""))}`,
    navegador_esperar: () => "Esperando a página",
    navegador_print: () => "Tirando print",
    navegador_login: () => `Entrando em ${clip(a.plataforma, 40)}`,
    navegador_codigo: () => "Buscando o código no Gmail",
    pc_powershell: () => `PowerShell: ${clip(a.comando, 90)}`,
    arquivo_ler: () => `Lendo ${clip(a.caminho, 80)}`,
    arquivo_escrever: () => `Gravando ${clip(a.caminho, 80)}`,
    arquivo_editar: () => `Editando ${clip(a.caminho, 80)}`,
    arquivo_buscar: () => `Buscando "${clip(a.texto || a.padrao, 50)}"`,
    arquivo_listar: () => `Listando ${clip(a.pasta || ".", 80)}`,
    arquivo_apagar: () => `Apagando ${clip(a.caminho, 80)}`,
    mcp_chamar: () => `Usando ${clip(`${a.servidor || ""}.${a.ferramenta || ""}`, 90)}`,
    pesquisar_web: () => `Pesquisando "${clip(a.consulta, 70)}"`,
    memory_save: () => "Guardando uma lembrança",
    memory_context: () => "Consultando a memória",
    memory_forget: () => `Esquecendo ${clip(a.id, 60)}`,
    perguntar_ao_helison: () => "Perguntando a você",
    concluir: () => "Concluindo",
  };
  return redact((map[name] || (() => `Usando ${name}`))());
}

function defaultShell({ command, cwd, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const bin = isWin ? "powershell.exe" : "sh";
    const args = isWin ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`] : ["-c", command];
    execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: scrubEnv(process.env) }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") + (err && err.killed ? "\n[tempo esgotado]" : "") });
    });
  });
}

/** O PowerShell do agente não herda chaves do HELIOS. */
function scrubEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!/KEY|TOKEN|SECRET|PASS|SENHA|CURSOR_API|GROQ|GEMINI|DEEPGRAM|TELEGRAM/i.test(k)) out[k] = v;
  return out;
}

function hasGit(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(path.join(cur, ".git"))) return true;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
  return false;
}

function agentPrompt(rec, { assistantText = "", allowedRoots = [] } = {}) {
  return [
    "Você é um agente autônomo do HELIOS, assistente pessoal do Helison (pt-BR). Trabalhe sozinho até terminar a tarefa.",
    "Ferramentas: navegador próprio (navegador_*), pesquisa web (pesquisar_web), conectores (mcp_chamar), memória (memory_*), PowerShell no PC (pc_powershell), arquivos (arquivo_*), perguntar_ao_helison e concluir.",
    `Sua pasta de trabalho: ${rec.workDir}. Pastas liberadas: ${allowedRoots.join("; ") || "nenhuma além da sua"}.`,
    "Regras: não pergunte o que dá para descobrir sozinho. Só pergunte em caso crítico (pagamento, salário, mudança de cidade, termos legais novos, captcha, informação que você não tem).",
    "Apagar fora da sua pasta, instalar programas, mexer no registro/sistema, enviar mensagens ou e-mails e pagar viram um cartão de aprovação: se a ferramenta responder PENDENTE, pare e espere.",
    "Nunca peça, mostre ou grave senhas, tokens ou códigos. Logins usam navegador_login (o cofre preenche) e códigos usam navegador_codigo (o Gmail digita).",
    "Em código: leia antes de editar, rode os testes (npm test) depois de mudar e diga o que mudou.",
    "Ao terminar, chame concluir com um resumo curto (o que fez, o que achou, o que falta).",
    assistantText ? `## Contexto do assistente\n${assistantText}` : "",
    `## Tarefa do agente\n${rec.task}`,
  ].filter(Boolean).join("\n\n");
}

function createAgentRuntime(opts = {}) {
  const {
    dataDir,
    workRoot,
    allowedRoots: initialRoots = [],
    blockedRoots = [],
    openWorker,
    assistantText = () => "",
    autonomyMode = () => "pedir",
    browser = null,
    searchWeb = null,
    mcp = null,
    assistantMcp = () => null,
    memoryFor = null,
    notify = () => {},
    onChange = () => {},
    shell = defaultShell,
    now = () => Date.now(),
    log = () => {},
    approvalTtlMin = 10,
    onLesson = null,
    consult = null,
    onUsage = null,
    missionPending = null,
  } = opts;
  const approvalTtlMs = () => Math.max(1, Number(approvalTtlMin) || 10) * 60000;
  const dir = path.join(dataDir, "agentes");
  fs.mkdirSync(dir, { recursive: true });
  const prefsFile = path.join(dir, "_ajustes.json");
  let prefs = { ...DEFAULT_LIMITS, pastas: initialRoots.slice(), ...readJson(prefsFile, {}) };
  const agents = new Map();
  const live = new Map(); // id -> { agent, run, stopReason }
  const thumbs = new Map();

  const fileOf = (id) => path.join(dir, `${id}.json`);
  const save = (rec) => { rec.updatedAt = nowIso(); writeJson(fileOf(rec.id), rec); };
  const changed = (rec) => { try { onChange(rec ? publicView(rec) : null); } catch { /* tela */ } };

  // Boot: o que estava trabalhando quando o app fechou fica pausado como "interrompido" (botão Retomar).
  for (const name of fs.readdirSync(dir)) {
    if (!/^agt_[\w-]+\.json$/.test(name)) continue;
    const rec = readJson(path.join(dir, name), null);
    if (!rec || !rec.id) continue;
    if (rec.status === "working" || rec.status === "queued") {
      rec.status = "paused";
      rec.motivo = "interrompido";
      rec.steps.push({ at: nowIso(), kind: "info", label: "O HELIOS foi fechado no meio. Toque em Retomar para continuar." });
      writeJson(fileOf(rec.id), rec);
    }
    agents.set(rec.id, rec);
  }

  function allowedRoots() { return (prefs.pastas || []).filter(Boolean); }
  function setPrefs(patch = {}) {
    const next = { ...prefs };
    if (Number(patch.concorrencia) >= 1) next.concorrencia = Math.min(8, Math.round(Number(patch.concorrencia)));
    if (Number(patch.maxPassos) >= 10) next.maxPassos = Math.min(2000, Math.round(Number(patch.maxPassos)));
    if (Number(patch.maxMinutos) >= 5) next.maxMinutos = Math.min(24 * 60, Math.round(Number(patch.maxMinutos)));
    if (Array.isArray(patch.pastas)) next.pastas = patch.pastas.map((p) => path.resolve(String(p))).filter((p) => !blockedRoots.some((b) => insideRoot(p, b) || insideRoot(b, p))).slice(0, 20);
    prefs = next;
    writeJson(prefsFile, prefs);
    pump();
    return { ...prefs };
  }

  function step(rec, kind, label, detail = "") {
    rec.steps.push({ at: nowIso(), kind, label: redact(clip(label, 240)), ...(detail ? { detail: redact(clip(detail, 1200)) } : {}) });
    if (rec.steps.length > MAX_STEPS_KEPT) rec.steps.splice(0, rec.steps.length - MAX_STEPS_KEPT);
    save(rec);
    changed(rec);
  }

  function fmtElapsed(ms) {
    const m = Math.round(ms / 60000);
    return m < 1 ? `${Math.max(0, Math.round(ms / 1000))} s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }

  function expireApprovals() {
    const cutoff = now();
    for (const rec of agents.values()) {
      if (rec.removed) continue;
      let touched = false;
      for (const a of rec.approvals || []) {
        if (a.state !== "pending" || !a.expiresAt) continue;
        if (Date.parse(a.expiresAt) > cutoff) continue;
        a.state = "expired";
        touched = true;
        step(rec, "info", `Cartão expirado: ${a.resumo}`);
        if (rec.waitingFor === a.id) {
          rec.waitingFor = null;
          enqueue(rec, `O cartão ${a.id} expirou (${a.tipo}). Nada foi executado. Continue sem isso ou peça de novo.`);
        }
      }
      if (touched) save(rec);
    }
  }

  function requestBrowserHandoff(rec, reason) {
    rec.browserHandoff = { reason: redact(String(reason || "intervenção no navegador")), at: nowIso(), state: "waiting" };
    save(rec);
  }

  async function startHandoff(id, reason) {
    const rec = get(id);
    requestBrowserHandoff(rec, reason);
    rec.waitingFor = `handoff:${rec.id}`;
    rec.status = "waiting_you";
    rec.motivo = "navegador";
    step(rec, "wait", `Precisa de você no navegador: ${clip(reason, 120)}`);
    await cancelLive(rec, "handoff");
    try {
      notify({ kind: "browser_handoff", agent: publicView(rec), reason: redact(String(reason || "")), id: rec.id });
    } catch { /* aviso */ }
    if (browser && typeof browser.requestStream === "function") {
      try { await browser.requestStream(rec); } catch { /* stream opcional */ }
    }
    save(rec);
    changed(rec);
    return publicView(rec, { full: true });
  }

  function resolveHandoff(id) {
    const rec = get(id);
    const finished = rec.status === "done" || Boolean(rec.result);
    rec.browserHandoff = null;
    rec.waitingFor = null;
    step(rec, "you", "Você resolveu no navegador");
    // Se o worker já tinha terminado, só tira a pendência e volta ao status real (done).
    if (finished && !hasUserPending(rec, missionPending)) {
      rec.status = "done";
      rec.motivo = "";
      save(rec);
      changed(rec);
      return publicView(rec, { full: true });
    }
    enqueue(rec, "Continue a tarefa no navegador de onde parou.");
    return publicView(rec, { full: true });
  }

  function usageOf(id) {
    const rec = get(id);
    return rec.usage ?? null;
  }
  function publicView(rec, { full = false } = {}) {
    expireApprovals();
    const handoffPend = rec.browserHandoff && rec.browserHandoff.state === "waiting" ? 1 : 0;
    const localMissionOpen = (rec.missionDecisions || []).filter((d) => d.state === "aberta").length;
    const missionViaCb = localMissionOpen === 0 && !(rec.missionDecisions || []).length
      && typeof missionPending === "function" && missionPending(rec) ? 1 : 0;
    const missionPend = localMissionOpen + missionViaCb;
    const pend = (rec.approvals || []).filter((a) => a.state === "pending").length
      + (rec.questions || []).filter((q) => q.state === "pending").length
      + handoffPend + missionPend;
    const status = derivedStatus(rec, missionPending);
    const motivo = status === "waiting_you" ? (rec.motivo || pendingMotivo(rec)) : (rec.motivo || "");
    const used = rec.toolsUsed || [];
    let currentTool = "";
    if (rec.status === "working") {
      for (let i = rec.steps.length - 1; i >= 0; i -= 1) {
        if (rec.steps[i].kind === "tool") { currentTool = rec.steps[i].label; break; }
      }
    }
    const base = {
      id: rec.id, name: rec.name, task: rec.task, assistantId: rec.assistantId, modelo: rec.modelo || "", status, statusReal: rec.status, motivo,
      createdAt: rec.createdAt, updatedAt: rec.updatedAt, stepCount: rec.stepCount, pendentes: pend, result: rec.result || "",
      last: rec.steps.length ? rec.steps[rec.steps.length - 1].label : "", temNavegador: Boolean(rec.browserUsed), workDir: rec.workDir,
      toolsUsed: used.slice(), toolsLabel: toolsLabelFrom(used), elapsed: fmtElapsed(rec.elapsedMs || 0), elapsedMs: rec.elapsedMs || 0,
      currentTool, live: ["working", "queued", "waiting_you"].includes(status),
    };
    if (!full) return {
      ...base,
      steeringPending: Array.isArray(rec.steering) ? rec.steering.filter((s) => s.state === "queued").length : 0,
      parentId: rec.parentId || null,
      childIds: Array.isArray(rec.childIds) ? rec.childIds.slice() : [],
      taskSessionId: rec.taskSessionId || null,
    };
    return {
      ...base,
      steps: rec.steps.slice(-200), artifacts: rec.artifacts || [], fila: (rec.pending || []).length,
      approvals: (rec.approvals || []).slice(-20), questions: (rec.questions || []).slice(-20),
      missionDecisions: (rec.missionDecisions || []).filter((d) => d.state === "aberta").slice(-10),
      budget: { maxPassos: rec.budget.maxPassos, maxMinutos: rec.budget.maxMinutos, minutos: Math.round((rec.elapsedMs || 0) / 60000) },
      thumb: thumbs.get(rec.id) || "", streamThumb: thumbs.get(rec.id) || "", url: rec.browserUrl || "",
      handoff: rec.browserHandoff || null, usage: rec.usage || null,
      elapsed: fmtElapsed(rec.elapsedMs || 0), summary: rec.result || "", error: rec.status === "error" ? rec.error || rec.motivo || "" : "",
      steering: Array.isArray(rec.steering) ? rec.steering.slice(-10) : [],
      steeringPending: Array.isArray(rec.steering) ? rec.steering.filter((s) => s.state === "queued").length : 0,
      parentId: rec.parentId || null,
      childIds: Array.isArray(rec.childIds) ? rec.childIds.slice() : [],
      taskSessionId: rec.taskSessionId || null,
    };
  }

  /** Aplica correções de rumo enfileiradas no limite de passo (antes do próximo tool_call afetado). */
  function drainSteering(rec) {
    if (!Array.isArray(rec.steering) || !rec.steering.length) return "";
    const queued = rec.steering.filter((s) => s.state === "queued");
    if (!queued.length) return "";
    const texts = [];
    for (const s of queued) {
      s.state = "applied";
      s.appliedAt = nowIso();
      texts.push(s.text);
      step(rec, "you", `Corrigir rumo: ${clip(s.text, 120)}`);
    }
    save(rec);
    return texts.join("\n\n");
  }

  function get(id) {
    const rec = agents.get(String(id || ""));
    if (!rec) throw Object.assign(new Error("Agente não encontrado."), { status: 404 });
    return rec;
  }

  function list() {
    expireApprovals();
    return [...agents.values()].filter((r) => !r.removed).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map((r) => publicView(r));
  }

  function create({ tarefa, assistantId = "default", nome = "", particao = "", parentId = null, taskSession = false } = {}) {
    const task = redact(String(tarefa || "").trim()).slice(0, 8000);
    if (task.length < 3) throw Object.assign(new Error("Escreva a tarefa do agente."), { status: 400 });
    const id = newId("agt");
    const workDir = path.join(workRoot, id);
    fs.mkdirSync(workDir, { recursive: true });
    const mainPart = particao ? String(particao).slice(0, 60) : `persist:agente-${id}`;
    const taskSessionId = taskSession ? newId("tsk") : null;
    const rec = {
      id, name: redact(String(nome || "").trim()).slice(0, 60) || nameFromTask(task), task, assistantId: String(assistantId || "default"),
      status: "queued", motivo: "", createdAt: nowIso(), updatedAt: nowIso(), steps: [], artifacts: [], pending: [], approvals: [], questions: [], missionDecisions: [],
      stepCount: 0, elapsedMs: 0, result: "", error: "", workDir, partition: mainPart,
      mainPartition: mainPart,
      budget: { maxPassos: prefs.maxPassos, maxMinutos: prefs.maxMinutos }, sdkAgentId: null, started: false,
      toolsUsed: [], browserHandoff: null,
      // LEVA L: correção de rumo (aplicada no próximo limite de passo), árvore de delegação, sessão de tarefa.
      steering: [], parentId: parentId ? String(parentId) : null, childIds: [], taskSessionId, consultLog: [],
    };
    agents.set(id, rec);
    if (parentId && agents.has(String(parentId))) {
      const parent = agents.get(String(parentId));
      parent.childIds = Array.isArray(parent.childIds) ? parent.childIds : [];
      parent.childIds.push(id);
      save(parent);
    }
    step(rec, "info", taskSessionId ? `Na fila (sessão de tarefa ${taskSessionId})` : "Na fila");
    pump();
    return publicView(rec, { full: true });
  }

  // ---------- caminhos ----------
  function resolveIn(rec, p) {
    const raw = String(p || "").trim();
    if (!raw) throw new Error("Falta o caminho.");
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rec.workDir, raw);
    return abs;
  }
  function access(rec, abs) {
    if (blockedRoots.some((b) => insideRoot(abs, b))) return { ok: false, motivo: "pasta protegida do HELIOS" };
    if (isSecretPath(abs)) return { ok: false, motivo: "arquivo de segredo (.env, chave ou credencial)" };
    if (insideRoot(abs, rec.workDir)) return { ok: true, own: true };
    if (allowedRoots().some((r) => insideRoot(abs, r))) return { ok: true, own: false };
    return { ok: false, motivo: `fora das pastas liberadas (${allowedRoots().join("; ") || "só a pasta do agente"})` };
  }
  function addArtifact(rec, abs, title = "") {
    rec.artifacts = rec.artifacts || [];
    if (!rec.artifacts.some((a) => a.path === abs)) rec.artifacts.push({ path: abs, title: clip(title || path.basename(abs), 80), at: nowIso() });
    if (rec.artifacts.length > 60) rec.artifacts.shift();
  }
  function backupBefore(rec, abs) {
    if (!fs.existsSync(abs) || insideRoot(abs, rec.workDir) || hasGit(path.dirname(abs))) return "";
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    const dest = path.join(rec.workDir, "backups", stamp, abs.replace(/^([a-z]):/i, "$1").replace(/[\\/:]+/g, "_"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    return dest;
  }

  // ---------- ações com efeito (podem virar cartão) ----------
  async function perform(rec, action) {
    const a = action || {};
    if (a.op === "shell") {
      const cwd = a.pasta ? resolveIn(rec, a.pasta) : rec.workDir;
      const out = await shell({ command: a.comando, cwd, timeoutMs: 180000 });
      const text = `saída (código ${out.code}):\n${clip(out.stdout, OUT_MAX)}${out.stderr.trim() ? `\nerros:\n${clip(out.stderr, 2000)}` : ""}`;
      return redact(text);
    }
    if (a.op === "apagar") {
      const abs = resolveIn(rec, a.caminho);
      const ok = access(rec, abs);
      if (!ok.ok) return `Recusado: ${ok.motivo}.`;
      const bk = backupBefore(rec, abs);
      fs.rmSync(abs, { recursive: true, force: true });
      return `Apagado: ${abs}${bk ? ` (cópia em ${bk})` : ""}`;
    }
    if (a.op === "escrever") return writeFile(rec, a.caminho, a.conteudo);
    if (a.op === "mcp") {
      if (!mcp || typeof mcp.call !== "function") return "Conectores indisponíveis neste processo.";
      try {
        const result = await mcp.call(String(a.servidor || ""), String(a.ferramenta || ""), a.argumentos || {});
        return redact(clip(typeof result === "string" ? result : JSON.stringify(result), OUT_MAX));
      } catch (err) {
        return `Erro no conector: ${redact(String(err?.message || err)).slice(0, 800)}`;
      }
    }
    if (a.op === "memory_forget") {
      const memory = typeof memoryFor === "function" ? memoryFor(rec.assistantId) : null;
      return memory && typeof memory.forget === "function" && memory.forget(String(a.id || "")) ? "Memória esquecida." : "Não achei essa memória.";
    }
    if (a.op === "clicar") {
      if (!browser) return "Navegador indisponível neste processo.";
      const r = await browser.exec(rec, "clicar", { seletor: a.seletor, texto: a.texto });
      return redact(r.text || (r.ok ? "Cliquei." : r.error || "Não deu."));
    }
    return "Ação desconhecida.";
  }

  function writeFile(rec, caminho, conteudo) {
    const abs = resolveIn(rec, caminho);
    const ok = access(rec, abs);
    if (!ok.ok) return `Recusado: ${ok.motivo}.`;
    const body = String(conteudo ?? "");
    if (redact(body) !== body) return "Recusado: o conteúdo tem um segredo conhecido do HELIOS.";
    const bk = backupBefore(rec, abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
    addArtifact(rec, abs);
    return `Gravado: ${abs} (${Buffer.byteLength(body)} bytes)${bk ? `. Cópia de antes em ${bk}` : ""}`;
  }

  /** Único caminho de ação com efeito: roda já (Autonomia "sozinho" e não crítico) ou vira cartão e o agente para. */
  async function gate(rec, { tipo, resumo, detalhe = "", action, forceCard = false }) {
    const mode = forceCard || ALWAYS_ASK.has(tipo) ? "pedir" : autonomyMode(tipo, rec.assistantId);
    if (tipo === "segredo") return "Recusado: agentes não leem segredos. Use navegador_login ou navegador_codigo.";
    if (mode === "sozinho") {
      const out = await perform(rec, action);
      step(rec, "tool", `Feito sozinho (Autonomia): ${resumo}`, out);
      return out;
    }
    const id = newId("apr");
    const expiresAt = new Date(now() + approvalTtlMs()).toISOString();
    const exata = redact(acaoExataOf(action));
    const holdRequired = HOLD_REQUIRED.has(tipo);
    const digest = digestOf({ action, detail: exata });
    const card = {
      id, tipo, resumo: redact(clip(resumo, 240)), detalhe: redact(clip(detalhe, 1500)), action, state: "pending", at: nowIso(),
      expiresAt, acaoExata: exata, holdRequired, digest,
    };
    rec.approvals.push(card);
    rec.waitingFor = id;
    step(rec, "wait", `Aguardando aprovação: ${resumo}`);
    try {
      notify({
        kind: "approval", agent: publicView(rec), id, tipo, resumo: redact(resumo), detalhe: redact(clip(detalhe, 600)),
        expiresAt, acaoExata: exata, holdRequired, digest,
      });
    } catch { /* aviso */ }
    return `PENDENTE — cartão ${id} na Caixa de entrada do Helison (${tipo}). Pare agora, não repita a chamada; você continua quando ele decidir.`;
  }

  // ---------- ferramentas do agente ----------
  function tool(description, properties, required, execute) {
    return { description, inputSchema: { type: "object", properties, required }, execute };
  }
  function browserTool(rec, op) {
    return async (args) => {
      if (!browser) return "Navegador indisponível neste processo.";
      rec.browserUsed = true;
      const r = await browser.exec(rec, op, args || {});
      if (r.needsHuman) {
        requestBrowserHandoff(rec, r.reason || "captcha ou verificação no navegador");
        rec.waitingFor = rec.waitingFor || `handoff:${rec.id}`;
        return `PRECISA DE VOCÊ no navegador: ${redact(String(r.reason || "intervenção manual"))}. Pare agora; o Helison continua quando resolver.`;
      }
      if (r.thumb) thumbs.set(rec.id, r.thumb);
      if (r.file) addArtifact(rec, r.file, "print do navegador");
      if (r.partition) rec.partition = r.partition;
      if (r.url) rec.browserUrl = redact(clip(r.url, 300));
      return redact(clip(r.text || (r.ok ? "ok" : r.error || "Não deu."), OUT_MAX));
    };
  }

  function makeTools(rec) {
    const s = { type: "string" };
    const tools = {
      navegador_abrir: tool("Abre uma URL no navegador próprio deste agente (sessão salva).", { url: s }, ["url"], browserTool(rec, "abrir")),
      navegador_ler: tool("Lê a página atual: título, URL, texto visível e lista de campos, botões e links com seletores.", { foco: s }, [], browserTool(rec, "ler")),
      navegador_clicar: tool("Clica num elemento pelo seletor CSS ou pelo texto visível.", { seletor: s, texto: s }, [], async (args) => {
        if (!browser) return "Navegador indisponível neste processo.";
        rec.browserUsed = true;
        const info = await browser.exec(rec, "inspecionar", args || {});
        if (!info.ok) return redact(info.error || "Não achei o elemento.");
        const risk = classifyClick(info.label, info.page);
        if (risk) return gate(rec, { tipo: risk.tipo, resumo: `Clicar em "${clip(info.label, 60)}" (${risk.motivo})`, detalhe: `Página: ${info.url}\nBotão: ${info.label}`, action: { op: "clicar", seletor: args.seletor, texto: args.texto } });
        return browserTool(rec, "clicar")(args);
      }),
      navegador_digitar: tool("Digita texto num campo (seletor CSS). Não use para senha ou código.", { seletor: s, texto: s, enter: { type: "boolean" } }, ["seletor", "texto"], async (args) => {
        if (/senha|password|token|c[oó]digo de verifica/i.test(String(args?.seletor || ""))) return "Recusado: senha e código usam navegador_login e navegador_codigo.";
        return browserTool(rec, "digitar")(args);
      }),
      navegador_selecionar: tool("Escolhe uma opção num <select> ou rádio.", { seletor: s, valor: s }, ["seletor", "valor"], browserTool(rec, "selecionar")),
      navegador_enviar_arquivo: tool("Anexa um arquivo do PC num campo de arquivo.", { seletor: s, caminho: s }, ["seletor", "caminho"], async (args) => {
        const abs = resolveIn(rec, args.caminho);
        const ok = access(rec, abs);
        if (!ok.ok && !/curr[ií]culo|cv/i.test(path.basename(abs))) return `Recusado: ${ok.motivo}.`;
        return browserTool(rec, "arquivo")({ ...args, caminho: abs });
      }),
      navegador_esperar: tool("Espera um seletor aparecer ou alguns segundos (máx. 30).", { seletor: s, segundos: { type: "number" } }, [], browserTool(rec, "esperar")),
      navegador_print: tool("Tira um print da página e guarda nos artefatos.", {}, [], browserTool(rec, "print")),
      navegador_login: tool("Entra numa plataforma salva no Cofre (Cofre › Plataformas). A senha nunca passa por você.", { plataforma: s }, ["plataforma"], browserTool(rec, "login")),
      navegador_codigo: tool("Busca no Gmail o código de verificação que acabou de chegar e digita na página. O código não passa por você.", { remetente: s }, [], browserTool(rec, "codigo")),
      pesquisar_web: tool("Pesquisa na web e devolve títulos, URLs e trechos. Use para buscar informação atual e cite as fontes no resumo.", { consulta: s }, ["consulta"], async (args) => {
        if (typeof searchWeb !== "function") return "Pesquisa web indisponível neste processo.";
        const consulta = String(args?.consulta || "").trim();
        if (consulta.length < 2) return "Informe o que pesquisar.";
        try {
          const result = await searchWeb(consulta);
          return redact(clip(JSON.stringify(result), OUT_MAX));
        } catch (err) {
          return `Erro na pesquisa: ${redact(String(err?.message || err)).slice(0, 800)}`;
        }
      }),
      mcp_chamar: tool("Chama uma ferramenta MCP já configurada. Leitura reconhecida pode seguir a Autonomia; envio, escrita, exclusão, publicação, login e ferramentas desconhecidas pedem aprovação.", { servidor: s, ferramenta: s, argumentos: { type: "object" } }, ["servidor", "ferramenta"], async (args) => {
        if (!mcp || typeof mcp.findTool !== "function" || typeof mcp.call !== "function") return "Conectores indisponíveis neste processo.";
        const servidor = String(args?.servidor || "").trim();
        const ferramenta = String(args?.ferramenta || "").trim();
        const allowed = typeof assistantMcp === "function" ? assistantMcp(rec.assistantId) : null;
        if (Array.isArray(allowed) && !allowed.includes(servidor)) return `Este agente não tem acesso ao conector "${clip(servidor)}".`;
        const known = mcp.findTool(servidor, ferramenta);
        if (!known) return `Não achei ${servidor}.${ferramenta} numa lista já testada. Teste o conector antes de chamar.`;
        const kind = classifyToolDetailed(ferramenta, known.description || "");
        const action = { op: "mcp", servidor, ferramenta, argumentos: args?.argumentos || {} };
        if (kind.tipo === "ler" && !kind.forceCard && autonomyMode("ler", rec.assistantId) === "sozinho") return perform(rec, action);
        return gate(rec, { tipo: kind.tipo, forceCard: kind.forceCard, resumo: `${servidor}.${ferramenta}`, detalhe: JSON.stringify(args?.argumentos || {}).slice(0, 500), action });
      }),
      memory_context: tool("Consulta a memória durável deste assistente, sem expor segredos.", { texto: s }, [], async (args) => {
        const memory = typeof memoryFor === "function" ? memoryFor(rec.assistantId) : null;
        if (!memory || typeof memory.context !== "function") return "Memória indisponível neste processo.";
        return redact(clip(memory.context({ text: String(args?.texto || rec.task || ""), maxChars: 3000 }).text || "Nenhuma lembrança relevante.", 3000));
      }),
      memory_save: tool("Guarda um fato ou preferência sem senha, token, e-mail ou credencial.", { texto: s, tipo: s }, ["texto"], async (args) => {
        const memory = typeof memoryFor === "function" ? memoryFor(rec.assistantId) : null;
        if (!memory || typeof memory.remember !== "function") return "Memória indisponível neste processo.";
        try {
          const saved = memory.remember({ text: args.texto, kind: args.tipo || "fato", source: `agente:${rec.id}` });
          return saved.updated ? "Atualizei uma lembrança parecida." : "Guardei na memória.";
        } catch (err) { return redact(String(err?.message || err)).slice(0, 500); }
      }),
      memory_forget: tool("Esquece uma lembrança pelo id mem_…; pede aprovação antes de apagar.", { id: s }, ["id"], async (args) => {
        const id = String(args?.id || "").trim();
        if (!/^mem_[\w-]+$/.test(id)) return "Informe um id de memória válido.";
        const memory = typeof memoryFor === "function" ? memoryFor(rec.assistantId) : null;
        if (!memory || typeof memory.list !== "function") return "Memória indisponível neste processo.";
        const item = memory.list().find((entry) => entry.id === id);
        if (!item) return "Não achei essa memória.";
        return gate(rec, { tipo: "apagar", resumo: `Esquecer memória ${id}`, detalhe: clip(item.text, 500), action: { op: "memory_forget", id } });
      }),
      pc_powershell: tool("Roda um comando PowerShell no PC do Helison (pasta do agente por padrão). Saída até 6000 caracteres.", { comando: s, pasta: s }, ["comando"], async (args) => {
        const comando = String(args?.comando || "").trim();
        if (!comando) return "Falta o comando.";
        if (args.pasta) {
          const ok = access(rec, resolveIn(rec, args.pasta));
          if (!ok.ok) return `Recusado: ${ok.motivo}.`;
        }
        const risk = classifyShell(comando);
        if (risk) return gate(rec, { tipo: risk.tipo, resumo: `PowerShell que ${risk.motivo}`, detalhe: comando, action: { op: "shell", comando, pasta: args.pasta || "" } });
        return perform(rec, { op: "shell", comando, pasta: args.pasta || "" });
      }),
      arquivo_ler: tool("Lê um arquivo de texto (até 60 mil caracteres).", { caminho: s, inicio: { type: "number" } }, ["caminho"], async (args) => {
        const abs = resolveIn(rec, args.caminho);
        const ok = access(rec, abs);
        if (!ok.ok) return `Recusado: ${ok.motivo}.`;
        if (!fs.existsSync(abs)) return "Arquivo não existe.";
        const text = fs.readFileSync(abs, "utf8");
        const start = Math.max(0, Number(args.inicio) || 0);
        return redact(text.slice(start, start + 60000)) + (text.length > start + 60000 ? `\n[… mais ${text.length - start - 60000} caracteres; use inicio]` : "");
      }),
      arquivo_escrever: tool("Grava um arquivo inteiro. Na pasta do agente roda sozinho; em outras pastas liberadas segue a Autonomia (com cópia de antes se não for git).", { caminho: s, conteudo: s }, ["caminho", "conteudo"], async (args) => {
        const abs = resolveIn(rec, args.caminho);
        const ok = access(rec, abs);
        if (!ok.ok) return `Recusado: ${ok.motivo}.`;
        if (ok.own || autonomyMode("escrever", rec.assistantId) === "sozinho") return writeFile(rec, abs, args.conteudo);
        return gate(rec, { tipo: "escrever", resumo: `Gravar ${abs}`, detalhe: clip(String(args.conteudo || ""), 1500), action: { op: "escrever", caminho: abs, conteudo: String(args.conteudo ?? "") } });
      }),
      arquivo_editar: tool("Troca um trecho exato de um arquivo por outro.", { caminho: s, procurar: s, substituir: s }, ["caminho", "procurar", "substituir"], async (args) => {
        const abs = resolveIn(rec, args.caminho);
        const ok = access(rec, abs);
        if (!ok.ok) return `Recusado: ${ok.motivo}.`;
        if (!fs.existsSync(abs)) return "Arquivo não existe.";
        const text = fs.readFileSync(abs, "utf8");
        const find = String(args.procurar || "");
        const count = find ? text.split(find).length - 1 : 0;
        if (count !== 1) return count ? `O trecho aparece ${count} vezes; mande um trecho único.` : "Não achei o trecho.";
        const next = text.replace(find, () => String(args.substituir ?? ""));
        if (ok.own || autonomyMode("escrever", rec.assistantId) === "sozinho") return writeFile(rec, abs, next);
        return gate(rec, { tipo: "escrever", resumo: `Editar ${abs}`, detalhe: `- ${clip(find, 600)}\n+ ${clip(args.substituir, 600)}`, action: { op: "escrever", caminho: abs, conteudo: next } });
      }),
      arquivo_listar: tool("Lista arquivos e pastas.", { pasta: s }, [], async (args) => {
        const abs = resolveIn(rec, args.pasta || ".");
        const ok = access(rec, abs);
        if (!ok.ok) return `Recusado: ${ok.motivo}.`;
        if (!fs.existsSync(abs)) return "Pasta não existe.";
        return fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.name !== "node_modules").slice(0, 300).map((d) => `${d.isDirectory() ? "[pasta] " : ""}${d.name}`).join("\n") || "(vazia)";
      }),
      arquivo_buscar: tool("Procura um texto nos arquivos de uma pasta (sem node_modules).", { texto: s, pasta: s }, ["texto"], async (args) => {
        const root = resolveIn(rec, args.pasta || ".");
        const ok = access(rec, root);
        if (!ok.ok) return `Recusado: ${ok.motivo}.`;
        const needle = String(args.texto || "").toLowerCase();
        const hits = [];
        const walk = (d, depth) => {
          if (hits.length >= 80 || depth > 8) return;
          let entries = [];
          try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (/^(node_modules|\.git|release|dist|\.backup.*)$/.test(e.name)) continue;
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full, depth + 1);
            else if (!isSecretPath(full)) {
              try {
                if (fs.statSync(full).size > 1_000_000) continue;
                fs.readFileSync(full, "utf8").split(/\r?\n/).forEach((line, i) => { if (hits.length < 80 && line.toLowerCase().includes(needle)) hits.push(`${path.relative(root, full)}:${i + 1}: ${clip(line.trim(), 160)}`); });
              } catch { /* binário */ }
            }
          }
        };
        walk(root, 0);
        return redact(hits.join("\n") || "Nada encontrado.");
      }),
      arquivo_apagar: tool("Apaga um arquivo. Na pasta do agente roda sozinho; fora dela pede aprovação.", { caminho: s }, ["caminho"], async (args) => {
        const abs = resolveIn(rec, args.caminho);
        const ok = access(rec, abs);
        if (!ok.ok) return `Recusado: ${ok.motivo}.`;
        if (ok.own) return perform(rec, { op: "apagar", caminho: abs });
        return gate(rec, { tipo: "apagar", resumo: `Apagar ${abs}`, detalhe: abs, action: { op: "apagar", caminho: abs } });
      }),
      perguntar_ao_helison: tool("Pergunta ao Helison (só em caso crítico). Depois de chamar, pare.", { pergunta: s, opcoes: { type: "array", items: s } }, ["pergunta"], async (args) => {
        const question = redact(String(args?.pergunta || "").trim()).slice(0, 500);
        if (question.length < 3) return "Escreva a pergunta.";
        const id = newId("qst");
        const options = (Array.isArray(args.opcoes) ? args.opcoes : []).map((o) => redact(String(o)).slice(0, 80)).filter(Boolean).slice(0, 5);
        rec.questions.push({ id, question, options, state: "pending", answer: "", at: nowIso() });
        rec.waitingFor = id;
        step(rec, "wait", `Pergunta: ${question}`);
        try { notify({ kind: "question", agent: publicView(rec), id, question, options }); } catch { /* aviso */ }
        return `PERGUNTA ${id} enviada. Pare agora; a resposta chega como nova instrução.`;
      }),
      concluir: tool("Encerra a tarefa com um resumo curto.", { resumo: s }, ["resumo"], async (args) => {
        rec.concluded = redact(String(args?.resumo || "Pronto.")).slice(0, 3000);
        return "Ok. Pare agora.";
      }),
    };
    if (consult && typeof consult.consultar === "function") {
      tools.consultar_agente = tool(
        "Consultar outro assistente (ex. Portfólio) sem marcar o Helison. Use para pedir projetos, textos ou fatos. Falha da consulta NÃO encerra você: trate o erro e adapte.",
        { assistente: s, pergunta: s },
        ["assistente", "pergunta"],
        async (args) => {
          const toAssistantId = String(args?.assistente || "").trim();
          const pergunta = String(args?.pergunta || "").trim();
          if (!toAssistantId || pergunta.length < 2) return "Informe assistente e pergunta.";
          try {
            const out = await consult.consultar({ fromAgentId: rec.id, toAssistantId, pergunta, parentAgentId: rec.id });
            // Contido: se a subtarefa falhou, devolve erro ao pai sem derrubá-lo.
            if (out && out.ok === false) {
              rec.consultLog = rec.consultLog || [];
              rec.consultLog.push({ at: nowIso(), toAssistantId, ok: false, error: out.error || "falha" });
              return `Consulta falhou (contida): ${redact(String(out.error || "erro")).slice(0, 500)}. Adapte a abordagem; NÃO trate como sucesso.`;
            }
            const text = typeof out === "string" ? out : (out?.resposta || out?.text || JSON.stringify(out));
            return redact(String(text ?? ""));
          } catch (err) {
            rec.consultLog = rec.consultLog || [];
            rec.consultLog.push({ at: nowIso(), toAssistantId, ok: false, error: String(err.message || err) });
            return `Consulta falhou (contida): ${redact(String(err.message || err)).slice(0, 500)}. Continue sem essa resposta ou peça ajuda.`;
          }
        },
      );
    }
    // LEVA L: abrir/fechar sessão de navegador por tarefa
    if (browser) {
      tools.navegador_tarefa_abrir = tool(
        "Abre uma sessão de navegador isolada para uma subtarefa (descartada ao fechar).",
        { tarefaId: s },
        [],
        async (args) => {
          const tid = String(args?.tarefaId || newId("tsk")).slice(0, 40);
          rec.taskSessionId = tid;
          rec.mainPartition = rec.mainPartition || rec.partition;
          const r = await browser.exec(rec, "abrir_tarefa", { taskSessionId: tid });
          return r.ok ? r.text : `Erro: ${r.error}`;
        },
      );
      tools.navegador_tarefa_fechar = tool(
        "Descarta a sessão de navegador da subtarefa atual.",
        {},
        [],
        async () => {
          const tid = rec.taskSessionId;
          if (!tid) return "Nenhuma sessão de tarefa aberta.";
          const r = await browser.exec(rec, "fechar_tarefa", { taskSessionId: tid });
          rec.taskSessionId = null;
          return r.ok ? r.text : `Erro: ${r.error}`;
        },
      );
    }
    for (const [name, t] of Object.entries(tools)) {
      const run = t.execute;
      t.execute = async (args) => { trackTool(rec, name); return run(args); };
    }
    return tools;
  }

  // ---------- execução ----------
  const workingCount = () => [...agents.values()].filter((r) => r.status === "working").length;

  function pump() {
    expireApprovals();
    const free = Math.max(0, prefs.concorrencia - workingCount());
    const queued = [...agents.values()].filter((r) => r.status === "queued" && !r.removed).sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)));
    for (const rec of queued.slice(0, free)) start(rec);
  }

  function enqueue(rec, message) {
    if (message) rec.pending.push(redact(String(message)).slice(0, 8000));
    if (rec.status !== "working") {
      rec.status = "queued";
      rec.motivo = "";
      rec.queuedAt = nowIso();
      save(rec);
      changed(rec);
      pump();
    } else save(rec);
  }

  function start(rec) {
    rec.status = "working";
    rec.motivo = "";
    save(rec);
    changed(rec);
    loop(rec).catch((err) => {
      log(`[agente ${rec.id}] ${redact(String(err && err.message || err))}`);
      rec.status = "error";
      rec.error = redact(err.message || String(err));
      step(rec, "erro", `Erro: ${rec.error}`);
    }).finally(() => { live.delete(rec.id); pump(); });
  }

  async function loop(rec) {
    let message;
    if (!rec.started) {
      rec.started = true;
      message = agentPrompt(rec, { assistantText: assistantText(rec.assistantId), allowedRoots: allowedRoots() });
    } else {
      const extra = rec.pending.splice(0);
      message = extra.length ? `## Instrução do Helison\n${extra.join("\n\n")}` : "## Instrução do Helison\nContinue a tarefa de onde parou.";
      if (!live.get(rec.id)?.agent) message = `${agentPrompt(rec, { assistantText: assistantText(rec.assistantId), allowedRoots: allowedRoots() })}\n\n## Passos já feitos\n${rec.steps.slice(-25).map((s) => `- ${s.label}`).join("\n")}\n\n${message}`;
    }
    step(rec, "info", "Trabalhando");
    while (true) {
      const outcome = await runOnce(rec, message);
      if (outcome !== "again") return;
      const extra = rec.pending.splice(0);
      message = `## Instrução do Helison\n${extra.join("\n\n")}`;
      step(rec, "info", "Nova instrução recebida");
    }
  }

  async function runOnce(rec, message) {
    const slot = live.get(rec.id) || {};
    live.set(rec.id, slot);
    if (!slot.agent) {
      const opened = await openWorker({ name: `HELIOS · ${rec.name}`, tools: makeTools(rec), cwd: rec.workDir, text: rec.task, agentId: rec.sdkAgentId, assistantId: rec.assistantId, maxSteps: rec.budget.maxPassos });
      slot.agent = opened.agent;
      slot.selection = opened.selection;
      rec.sdkAgentId = opened.agent.agentId || rec.sdkAgentId;
      if (opened.label) rec.modelo = opened.label;
    }
    const startedAt = now();
    rec.concluded = null;
    rec.waitingFor = null;
    let streamed = "";
    let sayStep = null;
    const run = await slot.agent.send(message, slot.selection ? { model: slot.selection } : {});
    slot.run = run;
    const maxMs = rec.budget.maxMinutos * 60000;
    const overBudget = () => (rec.stepCount >= rec.budget.maxPassos ? "passos" : (rec.elapsedMs || 0) + (now() - startedAt) >= maxMs ? "tempo" : "");
    const timer = setInterval(() => { if (overBudget() && !slot.stopReason) { slot.stopReason = `limite de ${overBudget()}`; run.cancel?.().catch?.(() => {}); } }, 5000);
    timer.unref?.();
    try {
      if (typeof run.supports !== "function" || run.supports("stream")) {
        for await (const raw of run.stream()) {
          const msg = unwrapStreamEvent(raw);
          if (!msg) continue;
          if (msg.type === "assistant") {
            const chunk = extractAssistantText(msg);
            if (!chunk) continue;
            streamed = chunk.startsWith(streamed) ? chunk : streamed + chunk;
            if (!sayStep) { sayStep = { at: nowIso(), kind: "say", label: "" }; rec.steps.push(sayStep); }
            sayStep.label = redact(clip(streamed, 240));
            save(rec);
            changed(rec);
          } else if (msg.type === "tool_call" && msg.status === "running") {
            // LEVA L: limite de passo — aplica "corrigir rumo" antes de continuar ferramentas.
            const steered = drainSteering(rec);
            if (steered) {
              slot.stopReason = "corrigir";
              try { await run.cancel?.(); } catch { /* ok */ }
              rec.pending.unshift(`## Corrigir rumo (Helison)\n${steered}\n\nIncorpore esta correção e continue a tarefa.`);
              break;
            }
            sayStep = null;
            streamed = "";
            rec.stepCount += 1;
            trackTool(rec, msg.name);
            step(rec, "tool", humanStep(shortToolName(msg.name), msg.args));
            const over = overBudget();
            if (over && !slot.stopReason) { slot.stopReason = `limite de ${over}`; await run.cancel?.(); }
          } else if (msg.type === "tool_call" && msg.status === "completed" && msg.result) {
            const last = rec.steps[rec.steps.length - 1];
            if (last && last.kind === "tool" && !last.detail) { last.detail = redact(clip(typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result), 600)); save(rec); }
          }
        }
      }
      const result = await run.wait();
      if (onUsage && slot.agent) {
        try {
          const usage = await onUsage(slot.agent, rec);
          if (usage != null) rec.usage = usage;
        } catch { /* métricas opcionais */ }
      }
      rec.elapsedMs = (rec.elapsedMs || 0) + (now() - startedAt);
      const reason = slot.stopReason;
      slot.stopReason = null;
      slot.run = null;
      if (reason === "parado") return finish(rec, "done", "Parado por você.");
      if (reason === "corrigir") return "again";
      if (reason === "pausa") { rec.status = "paused"; rec.motivo = "pausado"; step(rec, "info", "Pausado"); return "end"; }
      if (reason && reason.startsWith("limite")) {
        rec.status = "paused";
        rec.motivo = reason;
        step(rec, "info", `Pausado: ${reason} (${rec.stepCount} passos). Retomar dá mais fôlego.`);
        rec.budget.maxPassos = Math.max(rec.budget.maxPassos, rec.stepCount + prefs.maxPassos);
        try { notify({ kind: "info", agent: publicView(rec), texto: `Agente "${rec.name}" pausou: ${reason}.` }); } catch { /* aviso */ }
        return "end";
      }
      if (result?.status === "error") return finish(rec, "error", redact(String(result.error?.message || result.result || "O modelo falhou.")));
      // Pendência do usuário (handoff/aprovação/missão) tem prioridade: nunca vira "done" na UI.
      if (rec.waitingFor || hasUserPending(rec, missionPending)) {
        if (rec.concluded && !rec.waitingFor) {
          // Worker encerrou a vez, mas ainda há pendência → guarda o resultado real; status público deriva waiting_you.
          rec.status = "done";
          rec.result = rec.concluded;
          rec.motivo = pendingMotivo(rec);
          step(rec, "fim", rec.result);
        } else {
          rec.status = "waiting_you";
          rec.motivo = pendingMotivo(rec);
        }
        save(rec);
        changed(rec);
        return "end";
      }
      if (rec.pending.length) return "again";
      return finish(rec, "done", rec.concluded || redact(String(result?.result || streamed || "Pronto.").trim()).slice(0, 3000));
    } finally {
      clearInterval(timer);
    }
  }

  function finish(rec, status, text) {
    // Status real do worker; se ainda há pendência do usuário, publicView deriva waiting_you.
    rec.status = status;
    rec.motivo = hasUserPending(rec, missionPending) ? pendingMotivo(rec) : "";
    if (status === "error") rec.error = text; else rec.result = text;
    step(rec, status === "error" ? "erro" : "fim", status === "error" ? `Erro: ${text}` : text);
    if (status === "error" && typeof onLesson === "function") {
      try {
        onLesson({ type: "error", agentId: rec.id, assistantId: rec.assistantId, resumo: rec.task, motivo: text });
      } catch { /* lição opcional */ }
    }
    const view = publicView(rec);
    try {
      notify({
        kind: view.status === "waiting_you" ? "waiting_you" : (status === "error" ? "error" : "done"),
        agent: view,
        texto: text,
      });
    } catch { /* aviso */ }
    dispose(rec.id);
    return "end";
  }

  async function dispose(id) {
    const slot = live.get(id);
    if (!slot || slot.run) return;
    const agent = slot.agent;
    slot.agent = null;
    try { if (agent && typeof agent[Symbol.asyncDispose] === "function") await agent[Symbol.asyncDispose](); else agent?.close?.(); } catch { /* ok */ }
  }

  // ---------- controles ----------
  function instruct(id, text) {
    const rec = get(id);
    const clean = redact(String(text || "").trim());
    if (!clean) throw Object.assign(new Error("Escreva a instrução."), { status: 400 });
    step(rec, "you", clean);
    // Pergunta aberta: a instrução vale como resposta.
    for (const q of rec.questions) if (q.state === "pending") { q.state = "answered"; q.answer = clean; }
    enqueue(rec, clean);
    return publicView(rec, { full: true });
  }

  /**
   * LEVA L: "Corrigir rumo" — enfileira correção aplicada no próximo limite de passo.
   * Diferente de instruct: não vira mensagem ordinária imediata; espera o boundary.
   */
  function steer(id, text) {
    const rec = get(id);
    const clean = redact(String(text || "").trim()).slice(0, 2000);
    if (!clean) throw Object.assign(new Error("Escreva a correção de rumo."), { status: 400 });
    if (["done", "error"].includes(rec.status)) {
      throw Object.assign(new Error("Esse agente já terminou. Use uma nova tarefa ou Retomar."), { status: 409 });
    }
    rec.steering = Array.isArray(rec.steering) ? rec.steering : [];
    const entry = { id: newId("str"), text: clean, state: "queued", at: nowIso(), appliedAt: null };
    rec.steering.push(entry);
    step(rec, "info", `Corrigir rumo na fila (${clip(clean, 80)})`);
    // Se não está em execução ativa, aplica já no próximo ciclo.
    if (rec.status !== "working") {
      const steered = drainSteering(rec);
      if (steered) enqueue(rec, `## Corrigir rumo (Helison)\n${steered}\n\nIncorpore esta correção e continue a tarefa.`);
    } else {
      save(rec);
      changed(rec);
    }
    return publicView(rec, { full: true });
  }

  async function cancelLive(rec, reason) {
    const slot = live.get(rec.id);
    if (slot && slot.run) { slot.stopReason = reason; try { await slot.run.cancel?.(); } catch { /* ok */ } return true; }
    return false;
  }

  async function pause(id) {
    const rec = get(id);
    if (rec.status === "queued") { rec.status = "paused"; rec.motivo = "pausado"; step(rec, "info", "Pausado"); return publicView(rec, { full: true }); }
    if (!(await cancelLive(rec, "pausa")) && rec.status === "working") { rec.status = "paused"; rec.motivo = "pausado"; step(rec, "info", "Pausado"); }
    return publicView(rec, { full: true });
  }

  function resume(id) {
    const rec = get(id);
    if (!["paused", "error", "done", "waiting_you"].includes(rec.status)) return publicView(rec, { full: true });
    if (rec.status === "done" || rec.status === "error") rec.budget.maxPassos = Math.max(rec.budget.maxPassos, rec.stepCount + prefs.maxPassos);
    step(rec, "info", "Retomado");
    enqueue(rec, rec.pending.length ? "" : "Continue a tarefa de onde parou.");
    return publicView(rec, { full: true });
  }

  async function stop(id, { cascade = true, fromParent = false } = {}) {
    const rec = get(id);
    for (const a of rec.approvals) if (a.state === "pending") a.state = "expired";
    for (const q of rec.questions) if (q.state === "pending") q.state = "expired";
    if (rec.browserHandoff && rec.browserHandoff.state === "waiting") rec.browserHandoff = { ...rec.browserHandoff, state: "cancelled" };
    rec.waitingFor = null;
    if (Array.isArray(rec.missionDecisions)) {
      for (const d of rec.missionDecisions) if (d.state === "aberta") d.state = "cancelada";
    }
    rec.pending = [];
    rec.steering = (rec.steering || []).map((s) => (s.state === "queued" ? { ...s, state: "cancelled" } : s));
    // Cascata: subtarefas / consultas delegadas
    if (cascade && Array.isArray(rec.childIds)) {
      for (const childId of [...rec.childIds]) {
        if (!agents.has(childId)) continue;
        await stop(childId, { cascade: true, fromParent: true });
      }
    }
    if (rec.taskSessionId && browser && typeof browser.closeTask === "function") {
      try { browser.closeTask(rec.id, rec.taskSessionId); } catch { /* ok */ }
    }
    const label = fromParent ? "Cancelado com o agente pai." : "Parado por você.";
    const hadLive = await cancelLive(rec, "parado");
    if (!["done", "error"].includes(rec.status)) {
      // Cascata e stop explícito: encerra já (o cancel do run só reforça).
      finish(rec, "done", label);
    } else if (hadLive) {
      step(rec, "info", label);
    }
    return publicView(rec, { full: true });
  }

  async function stopAll() {
    const busy = [...agents.values()].filter((r) => ["working", "queued", "waiting_you"].includes(r.status));
    for (const rec of busy) await stop(rec.id);
    if (browser && typeof browser.closeAll === "function") browser.closeAll();
    return busy.length;
  }

  async function remove(id) {
    const rec = get(id);
    if (["working", "queued"].includes(rec.status)) await stop(id);
    rec.removed = true;
    save(rec);
    if (browser && typeof browser.close === "function") browser.close(rec.id);
    await dispose(rec.id);
    changed(null);
    return { ok: true };
  }

  function restore(id) { const rec = get(id); rec.removed = false; save(rec); changed(rec); return publicView(rec); }

  async function decide(id, approvalId, decision, { motivo } = {}) {
    expireApprovals();
    const rec = get(id);
    const card = rec.approvals.find((a) => a.id === approvalId);
    if (!card) throw Object.assign(new Error("Esse cartão não está mais aberto."), { status: 409 });
    if (card.state === "expired") throw Object.assign(new Error("Esse cartão expirou."), { status: 409 });
    if (card.state !== "pending") throw Object.assign(new Error("Esse cartão não está mais aberto."), { status: 409 });
    if (decision === "approve") {
      card.state = "approved";
      let out;
      try { out = await perform(rec, card.action); } catch (err) { out = `Erro: ${redact(err.message || err)}`; }
      card.result = clip(out, 600);
      step(rec, "tool", `Aprovado: ${card.resumo}`, out);
      enqueue(rec, `O Helison APROVOU "${card.resumo}". Já executei. Resultado:\n${clip(out, 3000)}\nContinue a tarefa.`);
    } else {
      card.state = "denied";
      step(rec, "info", `Negado: ${card.resumo}`);
      const why = motivo ? redact(String(motivo).trim()).slice(0, 500) : "";
      if (why && typeof onLesson === "function") {
        try { onLesson({ type: "deny", agentId: rec.id, assistantId: rec.assistantId, resumo: card.resumo, motivo: why }); } catch { /* lição opcional */ }
      }
      enqueue(rec, `O Helison NEGOU "${card.resumo}".${why ? ` Motivo: ${why}.` : ""} Nada foi feito. Siga sem isso ou conclua.`);
    }
    return publicView(rec, { full: true });
  }

  function answer(id, questionId, text) {
    const rec = get(id);
    const q = rec.questions.find((item) => item.id === questionId);
    if (!q || q.state !== "pending") throw Object.assign(new Error("Essa pergunta já foi respondida."), { status: 409 });
    q.state = "answered";
    q.answer = redact(String(text || "").trim()).slice(0, 2000);
    step(rec, "you", `Resposta: ${q.answer}`);
    enqueue(rec, `Resposta do Helison à pergunta "${q.question}": ${q.answer}`);
    return publicView(rec, { full: true });
  }

  /** Responde decisão de missão ligada ao agente; se o worker já tinha terminado, volta ao status real. */
  function answerMission(id, decisionId, answer) {
    const rec = get(id);
    const finished = rec.status === "done" || Boolean(rec.result);
    rec.missionDecisions = Array.isArray(rec.missionDecisions) ? rec.missionDecisions : [];
    const d = rec.missionDecisions.find((item) => item.id === decisionId);
    if (!d || d.state !== "aberta") throw Object.assign(new Error("Essa decisão não está aberta."), { status: 409 });
    const pick = redact(String(answer || "").trim()).slice(0, 120);
    if (!pick) throw Object.assign(new Error("Escolha uma resposta."), { status: 400 });
    if (Array.isArray(d.options) && d.options.length && !d.options.includes(pick)) {
      throw Object.assign(new Error("Resposta precisa ser uma das opções."), { status: 400 });
    }
    d.state = "respondida";
    d.answer = pick;
    d.at = nowIso();
    step(rec, "you", `Decisão de missão: ${pick}`);
    if (finished && !hasUserPending(rec, missionPending)) {
      rec.status = "done";
      rec.motivo = "";
      save(rec);
      changed(rec);
      return publicView(rec, { full: true });
    }
    enqueue(rec, `O Helison decidiu na missão "${d.question || ""}": ${pick}. Continue.`);
    return publicView(rec, { full: true });
  }

  /** Itens para a Caixa de entrada (mesmo formato do buildInbox). */
  function inboxItems() {
    expireApprovals();
    const items = [];
    for (const rec of agents.values()) {
      if (rec.removed) continue;
      for (const a of rec.approvals) {
        if (a.state !== "pending") continue;
        items.push({
          id: a.id, kind: "approval", tipo: a.tipo, summary: a.resumo, detail: a.detalhe, options: [], at: a.at,
          expiresAt: a.expiresAt, holdRequired: Boolean(a.holdRequired), acaoExata: a.acaoExata || "", digest: a.digest || "",
          agentId: rec.id, convId: null, convTitle: rec.name, origin: "agente", originLabel: "Agente", assistantId: rec.assistantId, assistantName: "HELIOS",
        });
      }
      for (const q of rec.questions) if (q.state === "pending") items.push({ id: q.id, kind: "question", tipo: "pergunta", summary: q.question, detail: "", options: q.options, at: q.at, agentId: rec.id, convId: null, convTitle: rec.name, origin: "agente", originLabel: "Agente", assistantId: rec.assistantId, assistantName: "HELIOS" });
      if (rec.browserHandoff?.state === "waiting") {
        items.push({
          id: `handoff:${rec.id}`, kind: "browser_handoff", tipo: "navegador", summary: rec.browserHandoff.reason, detail: "", options: [],
          at: rec.browserHandoff.at, agentId: rec.id, convId: null, convTitle: rec.name, origin: "browser_handoff", originLabel: "Navegador",
          assistantId: rec.assistantId, assistantName: "HELIOS",
        });
      }
    }
    return items;
  }

  /** Acha um cartão aberto pelo id inteiro ou pelos últimos 6+ caracteres (código curto do Telegram). */
  function findCard(code) {
    const c = String(code || "").trim().toLowerCase();
    if (c.length < 6) return null;
    const hit = (id) => id === c || id.endsWith(c);
    for (const rec of agents.values()) {
      const a = rec.approvals.find((x) => x.state === "pending" && hit(x.id));
      if (a) return { agentId: rec.id, kind: "approval", id: a.id };
      const q = rec.questions.find((x) => x.state === "pending" && hit(x.id));
      if (q) return { agentId: rec.id, kind: "question", id: q.id };
    }
    return null;
  }

  async function close() {
    for (const rec of agents.values()) if (rec.status === "working") await cancelLive(rec, "pausa").catch(() => {});
  }

  pump();
  return {
    list, create, instruct, steer, pause, resume, stop, stopAll, remove, restore, decide, answer, answerMission, inboxItems, findCard, close,
    expireApprovals, startHandoff, resolveHandoff, usageOf, drainSteering,
    view: (id) => publicView(get(id), { full: true }), prefs: () => ({ ...prefs }), setPrefs, setThumb: (id, t) => thumbs.set(id, t),
    _tools: (id) => makeTools(get(id)),
    _agents: agents,
  };
}

module.exports = {
  createAgentRuntime, classifyShell, classifyClick, isSecretPath, insideRoot, nameFromTask, humanStep, agentPrompt, scrubEnv,
  acaoExataOf, toolsLabelFrom, shortToolName, STATUS, DEFAULT_LIMITS,
  hasUserPending, derivedStatus, pendingMotivo,
};
