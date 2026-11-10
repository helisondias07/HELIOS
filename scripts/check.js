"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const errors = [];

function fail(message) {
  errors.push(message);
}

const required = [
  "package.json",
  "README.md",
  ".env.example",
  ".github/workflows/helios.yml",
  "src/main.js",
  "src/vault-store.js",
  "src/vault-crypto.js",
  "src/meeting-window.js",
  "src/meeting-host.js",
  "server/index.js",
  "server/meetings-store.js",
  "renderer/index.html",
  "renderer/app.js",
  "renderer/meeting/index.html",
  "renderer/meeting/app.js",
  "build/icon.ico",
  "build/icon.png",
  "build/tray.png",
];

for (const file of required) {
  const full = path.join(root, file);
  if (!fs.existsSync(full) || fs.statSync(full).size === 0) fail(`falta ${file}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.version !== "0.2.0") fail("a versão do pacote precisa ser 0.2.0");
for (const script of ["start", "test", "lint", "check", "dist:win"]) {
  if (!pkg.scripts[script]) fail(`falta o script ${script}`);
}
if (pkg.dependencies && pkg.dependencies["@cursor/sdk"]) fail("o @cursor/sdk não faz parte do assistente de reuniões");

const banned = ["vagas", "livecoding", "ditado", "candidatura", "prova na tela"];
const surfaces = ["src/main.js", "renderer/index.html", "renderer/app.js", "renderer/meeting/index.html", "README.md"];
for (const file of surfaces) {
  const text = fs.readFileSync(path.join(root, file), "utf8").toLowerCase();
  for (const word of banned) {
    if (text.includes(word)) fail(`${file} ainda cita "${word}"`);
  }
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "release" || entry.name === "work") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const sources = [
  ...walk(path.join(root, "server")),
  ...walk(path.join(root, "src")),
  ...walk(path.join(root, "renderer")),
  ...walk(path.join(root, "test")),
  ...walk(path.join(root, "scripts")),
];

for (const file of sources) {
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (checked.status !== 0) fail(`${path.relative(root, file)} não analisa: ${checked.stderr.trim()}`);
  const text = fs.readFileSync(file, "utf8");
  if (/gsk_[A-Za-z0-9]{20,}/.test(text) || /AIza[0-9A-Za-z_-]{20,}/.test(text)) {
    fail(`${path.relative(root, file)} parece ter uma chave real`);
  }
}

const meeting = fs.readFileSync(path.join(root, "src", "meeting-window.js"), "utf8");
if (!meeting.includes("setContentProtection")) fail("a janela de reunião precisa chamar setContentProtection");
if (!meeting.includes("setSkipTaskbar")) fail("a janela de reunião precisa sair da barra de tarefas");

if (fs.existsSync(path.join(root, ".env"))) fail("o .env não pode ficar no projeto versionado");

if (errors.length) {
  for (const message of errors) console.error(`- ${message}`);
  process.exit(1);
}
console.log("HELIOS ok");
