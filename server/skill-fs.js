"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { newId, nowIso, readJson, writeJson } = require("./util");
const {
  KNOWN_SKILL_SOURCES,
  installFromSpec,
  installKnown,
  installAllKnown,
  installLocalFolder,
} = require("./skill-install");

const BAD_KEY = new Set(["__proto__", "constructor", "prototype"]);

function parseFrontmatter(markdown) {
  const text = String(markdown || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split("\n")) {
    const found = line.match(/^([A-Za-z][\w-]{0,40}):\s*(.*)$/);
    if (!found) continue;
    if (BAD_KEY.has(found[1])) return null;
    meta[found[1]] = found[2].trim();
  }
  return {
    name: meta.name || "",
    description: meta.description || "",
    license: meta.license || "",
    body: match[2].trim(),
  };
}

function defaultAssignments() {
  const wakePortfolio = [
    "impeccable",
    "frontend-design",
    "design-taste-frontend",
    "react-best-practices",
    "accessibility-compliance",
    "agent-browser",
    "revenue-centric-design",
    "de-slop-ui",
  ];
  return {
    "lojas-wake": [...wakePortfolio],
    portfolio: [...wakePortfolio],
    default: [
      "impeccable",
      "frontend-design",
      "design-taste-frontend",
      "react-best-practices",
      "accessibility-compliance",
      "agent-browser",
      "de-slop-ui",
    ],
    vagas: ["agent-browser"],
  };
}

function createSkillFs(opts = {}) {
  const repoRoot = opts.repoRoot || path.join(__dirname, "..");
  const skillsDir = opts.skillsDir || path.join(os.homedir(), "Documents", "HELIOS", "skills");
  const bundleDir = opts.bundleDir || path.join(repoRoot, "design", "skills");
  const dataDir = opts.dataDir || path.join(path.dirname(skillsDir));
  const assignmentsFile = path.join(dataDir, "skill-assignments.json");
  const pendingFile = path.join(dataDir, "pending-skill-installs.json");
  const manifestFile = path.join(skillsDir, "manifest.json");

  const store = {
    skillsDir,
    bundleDir,
    dataDir,
    parseFrontmatter,
    writeManifestEntry: null,
  };

  function readManifest() {
    const data = readJson(manifestFile, { version: 1, updatedAt: null, skills: [] });
    if (!Array.isArray(data.skills)) data.skills = [];
    return data;
  }

  function writeManifest(data) {
    fs.mkdirSync(skillsDir, { recursive: true });
    data.version = 1;
    data.updatedAt = nowIso();
    writeJson(manifestFile, data);
  }

  function writeManifestEntry(entry) {
    const data = readManifest();
    const skills = data.skills.filter((item) => item.name !== entry.name);
    skills.push(entry);
    data.skills = skills;
    writeManifest(data);
    return entry;
  }

  store.writeManifestEntry = writeManifestEntry;

  function listManifest() {
    return readManifest().skills;
  }

  function skillInstalledOk(name) {
    const row = listManifest().find((item) => item.name === name);
    return !row || row.status === "ok";
  }

  function listSkillRoots() {
    const map = new Map();
    const scan = (root, source) => {
      if (!fs.existsSync(root)) return;
      for (const name of fs.readdirSync(root)) {
        if (name.startsWith(".")) continue;
        const folder = path.join(root, name);
        if (!fs.existsSync(path.join(folder, "SKILL.md"))) continue;
        if (!map.has(name)) map.set(name, { name, dir: folder, source });
      }
    };
    scan(skillsDir, "installed");
    scan(bundleDir, "bundle");
    return map;
  }

  function resolveDir(name) {
    const installed = path.join(skillsDir, name);
    if (fs.existsSync(path.join(installed, "SKILL.md"))) return installed;
    const bundled = path.join(bundleDir, name);
    if (fs.existsSync(path.join(bundled, "SKILL.md"))) return bundled;
    return null;
  }

  function readAssignmentsMap() {
    const map = readJson(assignmentsFile, {});
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  }

  function saveAssignmentsMap(map) {
    writeJson(assignmentsFile, map);
  }

  function assignments(assistantId) {
    const map = readAssignmentsMap();
    if (assistantId === undefined) return map;
    return map[String(assistantId)] || [];
  }

  function assign(assistantId, skillNames) {
    const map = readAssignmentsMap();
    map[String(assistantId)] = [...new Set((skillNames || []).map(String))];
    saveAssignmentsMap(map);
    return map[String(assistantId)];
  }

  function expandAssistantDefaults(assistantId, base) {
    const names = [...base];
    if (assistantId === "lojas-wake" || assistantId === "portfolio") {
      if (resolveDir("web-design-guidelines") && skillInstalledOk("web-design-guidelines")) {
        names.push("web-design-guidelines");
      }
    }
    return names;
  }

  function ensureDefaults() {
    const defs = defaultAssignments();
    const map = readAssignmentsMap();
    let changed = false;
    for (const [assistantId, base] of Object.entries(defs)) {
      if (!map[assistantId] || map[assistantId].length === 0) {
        map[assistantId] = expandAssistantDefaults(assistantId, base);
        changed = true;
      }
    }
    if (changed) saveAssignmentsMap(map);
    return map;
  }

  function catalog() {
    const lines = [];
    for (const { name, dir } of listSkillRoots().values()) {
      const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
      const parsed = parseFrontmatter(md);
      if (!parsed) continue;
      lines.push(`${parsed.name || name}: ${parsed.description}`);
    }
    return lines;
  }

  function promptIndex(assistantId) {
    ensureDefaults();
    const assigned = new Set(assignments(assistantId || "default"));
    const lines = [];
    for (const { name, dir } of listSkillRoots().values()) {
      if (!assigned.has(name)) continue;
      const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
      const parsed = parseFrontmatter(md);
      if (!parsed) continue;
      lines.push(`${parsed.name || name}: ${parsed.description}`);
    }
    return lines;
  }

  function loadBody(name) {
    const dir = resolveDir(name);
    if (!dir) return null;
    const parsed = parseFrontmatter(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
    return parsed ? parsed.body : null;
  }

  function loadReferences(name) {
    const dir = resolveDir(name);
    if (!dir) return [];
    const refDir = path.join(dir, "references");
    if (!fs.existsSync(refDir)) return [];
    return fs.readdirSync(refDir).filter((file) => {
      const full = path.join(refDir, file);
      try {
        return fs.statSync(full).isFile() && !file.startsWith(".");
      } catch {
        return false;
      }
    });
  }

  function readReference(name, file) {
    const dir = resolveDir(name);
    if (!dir) return null;
    const safe = path.normalize(String(file || "")).replace(/^(\.\.(\/|\\|$))+/, "");
    if (!safe || safe.includes("..")) return null;
    const full = path.join(dir, "references", safe);
    if (!full.startsWith(path.join(dir, "references"))) return null;
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, "utf8");
  }

  function readPending() {
    const list = readJson(pendingFile, []);
    return Array.isArray(list) ? list : [];
  }

  function writePending(list) {
    writeJson(pendingFile, list);
  }

  function requestInstallApproval(spec) {
    const approvalId = newId("skillap");
    const entry = {
      approvalId,
      spec,
      source: spec.sourceUrl || spec.name,
      license: spec.licenseExpected || "",
      createdAt: nowIso(),
    };
    const list = readPending();
    list.push(entry);
    writePending(list);
    return { pending: true, approvalId, source: entry.source, license: entry.license };
  }

  function listPendingInstalls() {
    return readPending();
  }

  async function confirmInstall(approvalId, helpers) {
    const list = readPending();
    const idx = list.findIndex((item) => item.approvalId === approvalId);
    if (idx < 0) throw new Error("Aprovação não encontrada.");
    const { spec } = list[idx];
    list.splice(idx, 1);
    writePending(list);
    return installFromSpec(store, spec, { ...helpers, approve: true });
  }

  function rejectInstall(approvalId) {
    const list = readPending();
    const idx = list.findIndex((item) => item.approvalId === approvalId);
    if (idx < 0) return false;
    list.splice(idx, 1);
    writePending(list);
    return true;
  }

  return {
    skillsDir,
    bundleDir,
    dataDir,
    readManifest,
    writeManifestEntry,
    listManifest,
    assign,
    assignments,
    defaultAssignments,
    ensureDefaults,
    catalog,
    promptIndex,
    loadBody,
    loadReferences,
    readReference,
    installFromSpec: (spec, helpers) => installFromSpec(store, spec, helpers),
    installKnown: (name, helpers) => installKnown(store, name, helpers),
    installAllKnown: (helpers) => installAllKnown(store, helpers),
    installLocalFolder: (srcDir, name, meta) => installLocalFolder(store, srcDir, name, meta),
    requestInstallApproval,
    confirmInstall,
    rejectInstall,
    listPendingInstalls,
  };
}

module.exports = {
  createSkillFs,
  parseFrontmatter,
  KNOWN_SKILL_SOURCES,
};
