"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { nowIso } = require("./util");

const BAD_EXT = /\.(exe|ps1|js|bat|cmd|sh|dll)$/i;

const KNOWN_SKILL_SOURCES = [
  {
    name: "frontend-design",
    kind: "github-subdir",
    sourceUrl: "https://github.com/anthropics/skills/tree/main/skills/frontend-design",
    licenseExpected: "Apache-2.0",
    licenseHint: "LICENSE.txt",
  },
  {
    name: "design-taste-frontend",
    kind: "github-repo",
    sourceUrl: "https://github.com/Leonxlnx/taste-skill",
    licenseExpected: "MIT",
    discoverSkill: true,
  },
  {
    name: "react-best-practices",
    kind: "github-subdir",
    sourceUrl: "https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices",
    licenseExpected: "MIT",
    licenseFromFrontmatter: true,
  },
  {
    name: "web-design-guidelines",
    kind: "github-subdir",
    sourceUrl: "https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines",
    licenseExpected: null,
  },
  {
    name: "accessibility-compliance",
    kind: "github-subdir",
    sourceUrl: "https://github.com/wshobson/agents/tree/main/plugins/ui-design/skills/accessibility-compliance",
    licenseExpected: "MIT",
  },
  {
    name: "agent-browser",
    kind: "github-subdir",
    sourceUrl: "https://github.com/vercel-labs/agent-browser/tree/main/skills/agent-browser",
    licenseExpected: "Apache-2.0",
  },
  {
    name: "impeccable",
    kind: "github-repo",
    sourceUrl: "https://github.com/pbakaus/impeccable",
    licenseExpected: "Apache-2.0",
    discoverSkill: true,
  },
  {
    name: "revenue-centric-design",
    kind: "github-repo",
    sourceUrl: "https://github.com/heliocosta-dev/revenue-centric-design",
    licenseExpected: "custom-educational",
  },
  {
    name: "de-slop-ui",
    kind: "local",
    sourceUrl: "bundle:de-slop-ui",
    licenseExpected: "local (sem licença externa)",
    bundleName: "de-slop-ui",
  },
];

function parseGithubTreeUrl(url) {
  const m = String(url || "").match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3] || "main", subPath: m[4] || "" };
}

function copyTree(src, dest, { skipBad = true } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to, { skipBad });
    else {
      if (skipBad && BAD_EXT.test(entry.name)) continue;
      fs.copyFileSync(from, to);
    }
  }
}

function readLicenseText(dir) {
  for (const name of ["LICENSE", "LICENSE.txt", "LICENSE.md", "License", "LICENCE", "LICENCE.txt"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return fs.readFileSync(file, "utf8");
  }
  return "";
}

/** Sobe pastas até achar LICENSE (skill → skills → repo). */
function findLicenseUp(startDir, stopAt) {
  let cur = path.resolve(startDir);
  const stop = stopAt ? path.resolve(stopAt) : null;
  for (let i = 0; i < 8; i += 1) {
    const text = readLicenseText(cur);
    if (text.trim()) return text;
    const up = path.dirname(cur);
    if (up === cur) break;
    if (stop && (up === stop || !cur.startsWith(stop))) break;
    cur = up;
  }
  return "";
}

function licenseMatches(expected, text, frontmatterLicense) {
  if (!expected) return Boolean(text.trim() || frontmatterLicense);
  const blob = `${text}\n${frontmatterLicense || ""}`.toLowerCase();
  if (expected === "MIT") return blob.includes("mit");
  if (expected === "Apache-2.0") return blob.includes("apache");
  if (expected === "custom-educational") {
    return blob.includes("educational") || blob.includes("revenue") || blob.includes("gambling") || blob.length > 80;
  }
  return blob.includes(String(expected).toLowerCase());
}

function discoverSkillRoot(repoDir) {
  const preferred = [
    path.join(repoDir, "skill"),
    path.join(repoDir, "skills"),
    path.join(repoDir, "SKILL.md"),
  ];
  for (const p of preferred) {
    if (p.endsWith("SKILL.md") && fs.existsSync(p)) return repoDir;
    if (fs.existsSync(path.join(p, "SKILL.md"))) return p;
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        const folder = path.join(p, name);
        if (fs.existsSync(path.join(folder, "SKILL.md"))) return folder;
      }
    }
  }
  const queue = [];
  const walk = (d, depth) => {
    if (depth > 5 || queue.length >= 20) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      // Prefere pastas públicas; só entra em .agents/.cursor se nada mais existir.
      if (e.name.startsWith(".") && depth === 0) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === "SKILL.md") queue.push(path.dirname(full));
    }
  };
  walk(repoDir, 0);
  if (queue.length) return queue[0];
  // Último recurso: skills empacotadas sob pastas ocultas (impeccable).
  for (const hidden of [".agents", ".agent", ".cursor"]) {
    const base = path.join(repoDir, hidden, "skills");
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const folder = path.join(base, name);
      if (fs.existsSync(path.join(folder, "SKILL.md"))) return folder;
    }
  }
  return null;
}

function installLocalFolder(store, srcDir, name, { license = "", source = "local" } = {}) {
  const dest = path.join(store.skillsDir, name);
  if (!fs.existsSync(path.join(srcDir, "SKILL.md"))) {
    throw new Error("Pasta local sem SKILL.md.");
  }
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(srcDir, dest);
  const md = fs.readFileSync(path.join(dest, "SKILL.md"), "utf8");
  const parsed = store.parseFrontmatter(md);
  store.writeManifestEntry({
    name,
    source,
    commit: null,
    license: license || parsed.license || "",
    installedAt: nowIso(),
    status: "ok",
  });
  return { ok: true, name, path: dest };
}

async function materializeSpec(store, spec, { gitCloneFn }) {
  if (spec.kind === "local" || spec.bundleName) {
    const folder = spec.bundleName || spec.name;
    const src = path.join(store.bundleDir, folder);
    if (!fs.existsSync(src)) throw new Error(`Bundle local ausente: ${folder}`);
    return { skillRoot: src, commit: null, source: spec.sourceUrl || `bundle:${folder}` };
  }
  const parsed = parseGithubTreeUrl(spec.sourceUrl);
  if (!parsed) throw new Error("URL de origem inválida.");
  const cloneUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  const tmp = await gitCloneFn(cloneUrl, { branch: parsed.branch });
  const repoDir = tmp.dir || tmp;
  const commit = tmp.commit || null;
  let skillRoot = repoDir;
  if (spec.kind === "github-subdir" && parsed.subPath) {
    skillRoot = path.join(repoDir, ...parsed.subPath.split("/"));
  } else if (spec.kind === "github-repo" || spec.discoverSkill) {
    skillRoot = discoverSkillRoot(repoDir);
    if (!skillRoot) throw new Error("Não achei SKILL.md no repositório.");
  }
  if (!fs.existsSync(path.join(skillRoot, "SKILL.md"))) throw new Error("Origem sem SKILL.md.");
  return { skillRoot, commit, source: spec.sourceUrl };
}

async function installFromSpec(store, spec, { gitCloneFn, approve } = {}) {
  const name = spec.name;
  if (!name) throw new Error("Skill sem nome.");
  if (spec.mcpDiscovered && approve !== true) {
    return store.requestInstallApproval(spec);
  }
  if (spec.licenseExpected === null && spec.name === "web-design-guidelines") {
    store.writeManifestEntry({
      name,
      source: spec.sourceUrl,
      commit: null,
      license: "",
      installedAt: nowIso(),
      status: "skipped",
      reason: "sem licença",
    });
    return { skipped: true, reason: "sem licença" };
  }
  if (!gitCloneFn && spec.kind !== "local" && !spec.bundleName) {
    throw new Error("gitCloneFn obrigatório para instalação remota.");
  }
  let skillRoot;
  let commit;
  let source;
  if (spec.kind === "local" || spec.bundleName) {
    ({ skillRoot, commit, source } = await materializeSpec(store, spec, { gitCloneFn }));
  } else {
    ({ skillRoot, commit, source } = await materializeSpec(store, spec, { gitCloneFn }));
  }
  const md = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const parsed = store.parseFrontmatter(md) || { name: "", description: "", license: "", body: md };
  const combined = findLicenseUp(skillRoot);
  const fmLicense = (parsed && parsed.license) || "";
  const expected = spec.licenseExpected;
  // Bundle local HELIOS (de-slop-ui): sempre instala; licença do kit.
  if (spec.kind === "local" || spec.bundleName) {
    const dest = path.join(store.skillsDir, name);
    fs.mkdirSync(store.skillsDir, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    copyTree(skillRoot, dest);
    const license = fmLicense || expected || "HELIOS-kit";
    store.writeManifestEntry({ name, source, commit, license, installedAt: nowIso(), status: "ok" });
    return { ok: true, name, path: dest, license };
  }
  const hasLicense = Boolean((combined && combined.trim()) || fmLicense || expected === "custom-educational");
  if (!hasLicense || expected === null) {
    store.writeManifestEntry({
      name, source, commit, license: "", installedAt: nowIso(), status: "skipped", reason: "sem licença",
    });
    return { skipped: true, reason: "sem licença" };
  }
  if (expected && expected !== "custom-educational" && !licenseMatches(expected, combined, fmLicense)) {
    // Se o esperado veio do nosso manifesto e o frontmatter bate, aceita.
    if (!(fmLicense && licenseMatches(expected, "", fmLicense))) {
      store.writeManifestEntry({
        name, source, commit, license: fmLicense || "", installedAt: nowIso(), status: "skipped", reason: "licença incompatível",
      });
      return { skipped: true, reason: "licença incompatível" };
    }
  }
  const dest = path.join(store.skillsDir, name);
  fs.mkdirSync(store.skillsDir, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(skillRoot, dest);
  // Copia LICENSE do repo se a pasta da skill não tiver.
  if (!readLicenseText(dest) && combined) {
    fs.writeFileSync(path.join(dest, "LICENSE"), combined.slice(0, 20000), "utf8");
  }
  const license = fmLicense || expected || (combined.trim().slice(0, 40)) || "declarada";
  store.writeManifestEntry({ name, source, commit, license, installedAt: nowIso(), status: "ok" });
  return { ok: true, name, path: dest, license, commit };
}

function installKnown(store, name, helpers) {
  const spec = KNOWN_SKILL_SOURCES.find((item) => item.name === name);
  if (!spec) throw new Error(`Skill desconhecida: ${name}`);
  return installFromSpec(store, spec, helpers);
}

function installAllKnown(store, helpers) {
  return Promise.all(KNOWN_SKILL_SOURCES.map((item) => installKnown(store, item.name, helpers)));
}

module.exports = {
  KNOWN_SKILL_SOURCES,
  installFromSpec,
  installKnown,
  installAllKnown,
  installLocalFolder,
  copyTree,
};
