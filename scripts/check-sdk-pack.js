"use strict";

/**
 * Confere o que o app instalado precisa para o Conectar do Cursor abrir o loginDeepControl.
 * O electron-builder não copia peerDependency. Sem zod direto, o require do SDK quebra no asar
 * e o HELIOS caía na página de chaves. Os padrões de asarUnpack tiram o SDK, o nativo e as
 * dependências que o bundle pede na hora de carregar.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { minimatch } = require("minimatch");

const ROOT = path.join(__dirname, "..");

const MUST_UNPACK = [
  "node_modules/@cursor/sdk/dist/cjs/index.js",
  "node_modules/@cursor/sdk-win32-x64/vendor/tree-sitter/binding.node",
  "node_modules/@cursor/sdk-linux-x64/bin/rg",
  "node_modules/zod/package.json",
  "node_modules/@bufbuild/protobuf/package.json",
  "node_modules/@connectrpc/connect/package.json",
  "node_modules/@connectrpc/connect-web/package.json",
];

function readPackage(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

function assertSdkPackaging(pkg) {
  if (!pkg.dependencies?.zod) {
    throw new Error("zod precisa ser dependência direta: o electron-builder não copia peerDependency do @cursor/sdk");
  }
  const patterns = pkg.build?.asarUnpack;
  if (!Array.isArray(patterns) || patterns.length === 0) throw new Error("build.asarUnpack ausente");
  for (const file of MUST_UNPACK) {
    if (!patterns.some((pattern) => minimatch(file, pattern, { dot: true }))) {
      throw new Error(`asarUnpack não cobre ${file}`);
    }
  }
}

function walk(dir, acc = [], base = dir) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc, base);
    else acc.push(path.relative(base, full).replace(/\\/g, "/"));
  }
  return acc;
}

function assertBuiltResources(resourcesDir) {
  const asarFile = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarFile)) throw new Error(`asar ausente: ${asarFile}`);
  const asar = require("@electron/asar");
  const listed = asar.listPackage(asarFile).map((name) => name.replace(/\\/g, "/").replace(/^\//, ""));
  const unpackedHit = walk(path.join(resourcesDir, "app.asar.unpacked"));
  const has = (suffix) => listed.some((name) => name.endsWith(suffix)) || unpackedHit.some((name) => name.endsWith(suffix));
  for (const suffix of [
    "node_modules/zod/package.json",
    "node_modules/@cursor/sdk/package.json",
    "node_modules/@bufbuild/protobuf/package.json",
    "node_modules/@connectrpc/connect/package.json",
  ]) {
    if (!has(suffix)) throw new Error(`build sem ${suffix}`);
  }
  const native = unpackedHit.find((name) => name.includes("@cursor/sdk-") && name.endsWith("binding.node"));
  if (!native) throw new Error("binding.node do @cursor/sdk-* não está em app.asar.unpacked");
  return { native };
}

function probeSdk(resourcesDir) {
  const asarFile = path.join(resourcesDir, "app.asar");
  const out = path.join(os.tmpdir(), `helios-sdk-probe-${process.pid}.json`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-sdk-probe-"));
  const electron = path.join(ROOT, "node_modules", "electron", "dist", "electron");
  const script = [
    "const Module = require('module');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const asar = process.env.HELIOS_PROBE_ASAR;",
    "const out = process.env.HELIOS_PROBE_OUT;",
    "const result = {};",
    "(async () => {",
    "  try {",
    "    const req = Module.createRequire(path.join(asar, 'server', 'accounts.js'));",
    "    const sdk = req('@cursor/sdk');",
    "    result.login = typeof (sdk.Cursor && sdk.Cursor.auth && sdk.Cursor.auth.login);",
    "    result.agent = typeof sdk.Agent;",
    "    if (result.login === 'function') {",
    "      const ac = new AbortController();",
    "      let seen = '';",
    "      const pending = sdk.Cursor.auth.login({",
    "        store: null,",
    "        apiKeyName: 'HELIOS-probe',",
    "        signal: ac.signal,",
    "        openBrowser: async (value) => { seen = String(value || ''); ac.abort(); },",
    "        onLoginUrl: (value) => { seen = String(value || ''); },",
    "      }).catch((err) => { result.after = String(err && err.code || ''); });",
    "      const deadline = Date.now() + 8000;",
    "      while (!seen && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));",
    "      ac.abort();",
    "      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 1500))]);",
    "      try {",
    "        const url = new URL(seen);",
    "        result.urlOk = url.protocol === 'https:' && url.hostname === 'cursor.com' && url.pathname === '/loginDeepControl' && url.searchParams.get('mode') === 'login' && url.searchParams.get('redirectTarget') === 'sdk' && url.searchParams.has('challenge');",
    "      } catch { result.urlOk = false; }",
    "    }",
    "  } catch (err) {",
    "    result.error = String(err && err.code || '') + ' ' + String(err && err.message || err).split('\\n')[0].slice(0, 220);",
    "  }",
    "  fs.writeFileSync(out, JSON.stringify(result));",
    "})();",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "probe.js"), script);
  const run = spawnSync(electron, [path.join(dir, "probe.js")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HELIOS_PROBE_ASAR: asarFile, HELIOS_PROBE_OUT: out },
    encoding: "utf8",
    timeout: 30000,
  });
  if (!fs.existsSync(out)) {
    throw new Error(`probe sem saída (status ${run.status}): ${(run.stderr || run.stdout || "").slice(0, 400)}`);
  }
  const result = JSON.parse(fs.readFileSync(out, "utf8"));
  fs.rmSync(out, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  if (result.login !== "function" || result.urlOk !== true) {
    throw new Error(`SDK no asar não abriu loginDeepControl: ${result.error || JSON.stringify(result)}`);
  }
  return { login: result.login, agent: result.agent, urlOk: result.urlOk };
}

function main() {
  assertSdkPackaging(readPackage());
  const resourcesFlag = process.argv.indexOf("--resources");
  if (resourcesFlag === -1) return;
  const resourcesDir = path.resolve(process.argv[resourcesFlag + 1] || "");
  const built = assertBuiltResources(resourcesDir);
  process.stdout.write(`asar ok ${built.native}\n`);
  if (process.argv.includes("--probe")) {
    const probed = probeSdk(resourcesDir);
    process.stdout.write(`probe ok login=${probed.login} urlOk=${probed.urlOk}\n`);
  }
}

module.exports = { assertSdkPackaging, assertBuiltResources, probeSdk, readPackage, MUST_UNPACK };

if (require.main === module) main();
