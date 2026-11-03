"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { newId, nowIso, readJson, writeJson } = require("./util");

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function agentRoot(dataDir, agentId) {
  const id = String(agentId || "").slice(0, 40);
  if (!id) throw fail("Informe o agente.");
  return path.join(dataDir, "drive", id);
}

function artifactDir(dataDir, agentId, artifactId) {
  return path.join(agentRoot(dataDir, agentId), String(artifactId));
}

function metaPath(dataDir, agentId, artifactId) {
  return path.join(artifactDir(dataDir, agentId, artifactId), "meta.json");
}

function versionPath(dataDir, agentId, artifactId, version) {
  return path.join(artifactDir(dataDir, agentId, artifactId), `v${version}`, "content");
}

function createAgentDrive(dataDir) {
  const root = path.join(dataDir, "drive");
  fs.mkdirSync(root, { recursive: true });

  function loadMeta(agentId, artifactId) {
    return readJson(metaPath(dataDir, agentId, artifactId), null);
  }

  function saveMeta(agentId, artifactId, meta) {
    writeJson(metaPath(dataDir, agentId, artifactId), meta);
  }

  function findByName(agentId, name) {
    const base = agentRoot(dataDir, agentId);
    if (!fs.existsSync(base)) return null;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = loadMeta(agentId, entry.name);
      if (meta && meta.name === name) return meta;
    }
    return null;
  }

  function put({ agentId, name, content, mime = "text/plain" }) {
    const cleanName = String(name || "").trim().slice(0, 120);
    if (cleanName.length < 1) throw fail("Informe o nome do artefato.");
    const body = String(content ?? "");
    let meta = findByName(agentId, cleanName);
    if (!meta) {
      meta = {
        id: newId("art"),
        name: cleanName,
        mime: String(mime || "text/plain").slice(0, 80),
        currentVersion: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
    }
    const next = meta.currentVersion + 1;
    const target = versionPath(dataDir, agentId, meta.id, next);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, { encoding: "utf8", mode: 0o600 });
    meta.currentVersion = next;
    meta.mime = String(mime || meta.mime || "text/plain").slice(0, 80);
    meta.updatedAt = nowIso();
    saveMeta(agentId, meta.id, meta);
    return { ...meta, version: next };
  }

  function list(agentId) {
    const base = agentRoot(dataDir, agentId);
    if (!fs.existsSync(base)) return [];
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => loadMeta(agentId, entry.name))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((meta) => ({ id: meta.id, name: meta.name, mime: meta.mime, currentVersion: meta.currentVersion, updatedAt: meta.updatedAt }));
  }

  function versions(agentId, artifactId) {
    const meta = loadMeta(agentId, artifactId);
    if (!meta) throw fail("Artefato não encontrado.", 404);
    const out = [];
    for (let v = 1; v <= meta.currentVersion; v += 1) {
      const file = versionPath(dataDir, agentId, artifactId, v);
      if (fs.existsSync(file)) out.push({ version: v, at: fs.statSync(file).mtime.toISOString() });
    }
    return out;
  }

  function read(agentId, artifactId, version) {
    const meta = loadMeta(agentId, artifactId);
    if (!meta) throw fail("Artefato não encontrado.", 404);
    const v = version !== undefined ? Number(version) : meta.currentVersion;
    if (!Number.isInteger(v) || v < 1 || v > meta.currentVersion) throw fail("Versão inválida.");
    const file = versionPath(dataDir, agentId, artifactId, v);
    if (!fs.existsSync(file)) throw fail("Conteúdo desta versão não existe.", 404);
    return { ...meta, version: v, content: fs.readFileSync(file, "utf8") };
  }

  function restore(agentId, artifactId, version) {
    const snap = read(agentId, artifactId, version);
    return put({ agentId, name: snap.name, content: snap.content, mime: snap.mime });
  }

  return { put, list, versions, restore, read, root };
}

module.exports = { createAgentDrive };
