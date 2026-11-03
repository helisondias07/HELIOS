"use strict";

/**
 * LEVA L: memória híbrida — SQLite (node:sqlite) com FTS5 + vetores locais simples.
 *
 * Escolha: `node:sqlite` (DatabaseSync) do Node embutido no Electron 44.
 * Motivo: process.versions.sqlite presente, FTS5 compilado (verificado), zero rebuild
 * nativo (melhor-sqlite3 / sqlite3 quebram fácil no Electron). Sem dependência extra.
 *
 * Embeddings: vetor local bag-of-tokens (hash em 64 dims, TF normalizado). Sem rede.
 * Se no futuro houver provedor de embedding, `embedFn` pode ser injetado.
 *
 * Busca: rank fusion (RRF) entre FTS5 e similaridade cosseno.
 * Correções: editar/apagar com histórico (versão anterior + motivo); revisão por evidência.
 */
const fs = require("node:fs");
const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");
const { unsafeReason, tokens, overlap, MAX_ITEMS, LEAN_MAX_ACTIVE } = require("./memory");

const KINDS = ["fato", "preferencia", "regra", "pendencia"];
const DIM = 64;

function embedLocal(text) {
  const vec = new Float64Array(DIM);
  const toks = tokens(text);
  if (!toks.length) return Array.from(vec);
  for (const t of toks) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i += 1) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % DIM;
    vec[idx] += 1;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => v / norm);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

function openDb(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'aberto',
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'bot',
      embedding TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      archive_reason TEXT,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      text,
      content='items',
      content_rowid='rowid'
    );
    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      action TEXT NOT NULL,
      prev_text TEXT,
      next_text TEXT,
      reason TEXT,
      evidence TEXT,
      actor TEXT,
      at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
    END;
    CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, text) VALUES('delete', OLD.rowid, OLD.text);
    END;
    CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, text) VALUES('delete', OLD.rowid, OLD.text);
      INSERT INTO items_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
    END;
  `);
  return db;
}

function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    text: row.text,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at || undefined,
    archiveReason: row.archive_reason || undefined,
    embedding: row.embedding ? JSON.parse(row.embedding) : null,
  };
}

function createHybridMemory(dataDir, fileName = "memory.json", { embedFn = embedLocal } = {}) {
  const base = fileName.replace(/\.json$/i, "");
  const dbPath = path.join(dataDir, `${base}.sqlite`);
  const jsonFile = path.join(dataDir, fileName);
  const archiveFile = jsonFile.replace(/\.json$/, ".arquivo.json");
  fs.mkdirSync(dataDir, { recursive: true });

  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    throw Object.assign(new Error(`SQLite indisponível (${err.message}). HELIOS precisa do node:sqlite do Electron 44.`), { cause: err });
  }

  const insertStmt = db.prepare(`INSERT INTO items (id, kind, status, text, source, embedding, created_at, updated_at, closed_at, archive_reason, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  const updateTextStmt = db.prepare(`UPDATE items SET text = ?, kind = ?, source = ?, embedding = ?, updated_at = ? WHERE id = ? AND deleted = 0`);
  const hardForgetStmt = db.prepare(`UPDATE items SET deleted = 1, status = 'apagado', closed_at = ?, archive_reason = ?, updated_at = ? WHERE id = ?`);
  const restoreStmt = db.prepare(`UPDATE items SET deleted = 0, status = 'aberto', closed_at = NULL, archive_reason = NULL, updated_at = ? WHERE id = ?`);
  const histStmt = db.prepare(`INSERT INTO history (id, item_id, action, prev_text, next_text, reason, evidence, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function addHistory({ itemId, action, prevText = "", nextText = "", reason = "", evidence = "", actor = "user" }) {
    histStmt.run(newId("mh"), itemId, action, prevText, nextText, redact(String(reason || "")).slice(0, 400), redact(String(evidence || "")).slice(0, 800), String(actor || "user").slice(0, 40), nowIso());
  }

  /** Migra memory.json + arquivo sem perder dados (só se a tabela estiver vazia). */
  function migrateFromJson() {
    const count = db.prepare("SELECT COUNT(*) AS n FROM items").get().n;
    if (count > 0) return { migrated: 0 };
    let migrated = 0;
    const load = (file, archived) => {
      const data = readJson(file, { version: 1, items: [] });
      for (const item of data.items || []) {
        if (!item || !item.text) continue;
        const id = item.id || newId("mem");
        const emb = embedFn(item.text);
        try {
          insertStmt.run(
            id,
            KINDS.includes(item.kind) ? item.kind : "fato",
            archived ? "fechado" : (item.status || "aberto"),
            String(item.text).slice(0, 400),
            String(item.source || "bot").slice(0, 40),
            JSON.stringify(emb),
            item.createdAt || nowIso(),
            item.updatedAt || nowIso(),
            archived ? (item.closedAt || nowIso()) : null,
            archived ? (item.archiveReason || "migrado") : null,
          );
          migrated += 1;
        } catch {
          /* id duplicado: ignora */
        }
      }
    };
    if (fs.existsSync(jsonFile)) load(jsonFile, false);
    if (fs.existsSync(archiveFile)) load(archiveFile, true);
    // Backup JSON após migração (não apaga).
    if (migrated) {
      try {
        if (fs.existsSync(jsonFile)) fs.copyFileSync(jsonFile, `${jsonFile}.pre-hybrid.bak`);
        if (fs.existsSync(archiveFile)) fs.copyFileSync(archiveFile, `${archiveFile}.pre-hybrid.bak`);
      } catch { /* backup best-effort */ }
      // Espelha lista ativa de volta ao JSON para leitores legados.
      mirrorJson();
    }
    return { migrated };
  }

  function withoutEmbedding(item) {
    const { embedding: _emb, ...rest } = item;
    void _emb;
    return rest;
  }

  function mirrorJson() {
    const active = list();
    const archived = archivedList();
    writeJson(jsonFile, { version: 2, hybrid: true, items: active.map(withoutEmbedding) });
    writeJson(archiveFile, { version: 2, hybrid: true, items: archived.map(withoutEmbedding) });
  }

  migrateFromJson();

  function list() {
    const rows = db.prepare(`SELECT * FROM items WHERE deleted = 0 AND status != 'fechado' AND status != 'apagado' ORDER BY updated_at DESC`).all();
    return rows.map(rowToItem);
  }

  function archivedList() {
    const rows = db.prepare(`SELECT * FROM items WHERE (status = 'fechado' OR deleted = 1) AND status != 'apagado' ORDER BY closed_at DESC`).all();
    return rows.map(rowToItem);
  }

  function remember({ text, kind = "fato", source = "bot" }) {
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (clean.length < 6) throw Object.assign(new Error("texto curto demais para lembrar"), { status: 400 });
    const bad = unsafeReason(clean);
    if (bad) throw Object.assign(new Error(`Não guardo isso na memória: ${bad}.`), { status: 400 });
    const k = KINDS.includes(kind) ? kind : "fato";
    const existing = list();
    const same = existing.find((item) => overlap(item.text, clean) >= 0.75);
    if (same) {
      const emb = embedFn(clean);
      updateTextStmt.run(clean, k, source, JSON.stringify(emb), nowIso(), same.id);
      addHistory({ itemId: same.id, action: "atualizar", prevText: same.text, nextText: clean, reason: "sobreposição", actor: source });
      mirrorJson();
      return { item: { ...same, text: clean, kind: k, source, updatedAt: nowIso(), embedding: emb }, updated: true };
    }
    const item = {
      id: newId("mem"),
      kind: k,
      status: "aberto",
      text: clean,
      source: String(source || "bot").slice(0, 40),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      embedding: embedFn(clean),
    };
    insertStmt.run(item.id, item.kind, item.status, item.text, item.source, JSON.stringify(item.embedding), item.createdAt, item.updatedAt, null, null);
    addHistory({ itemId: item.id, action: "criar", nextText: clean, actor: source });
    if (list().length > LEAN_MAX_ACTIVE) compact();
    mirrorJson();
    return { item, updated: false };
  }

  function addImported({ text, kind = "fato" }) {
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (clean.length < 6) throw Object.assign(new Error("texto curto demais para lembrar"), { status: 400 });
    const bad = unsafeReason(clean);
    if (bad) throw Object.assign(new Error(`Não guardo isso na memória: ${bad}.`), { status: 400 });
    if (list().length >= MAX_ITEMS) throw Object.assign(new Error(`A memória está cheia (limite ${MAX_ITEMS}).`), { status: 409 });
    if (list().some((item) => overlap(item.text, clean) >= 0.75)) return { item: null, duplicate: true };
    // Importação aditiva: não passa por remember (que enxuga) — só acrescenta até o teto.
    const item = {
      id: newId("mem"),
      kind: KINDS.includes(kind) ? kind : "fato",
      status: "aberto",
      text: clean,
      source: "importado",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      embedding: embedFn(clean),
    };
    insertStmt.run(item.id, item.kind, item.status, item.text, item.source, JSON.stringify(item.embedding), item.createdAt, item.updatedAt, null, null);
    addHistory({ itemId: item.id, action: "criar", nextText: clean, actor: "importado" });
    mirrorJson();
    return { item, duplicate: false };
  }

  function forget(id, { reason = "esquecido", actor = "user" } = {}) {
    const row = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id);
    if (!row || row.deleted) return false;
    hardForgetStmt.run(nowIso(), reason, nowIso(), id);
    addHistory({ itemId: id, action: "apagar", prevText: row.text, reason, actor });
    mirrorJson();
    return true;
  }

  /** Correção manual: edita texto e guarda versão anterior + motivo. */
  function edit(id, { text, kind, reason = "", evidence = "", actor = "user" } = {}) {
    const row = db.prepare(`SELECT * FROM items WHERE id = ? AND deleted = 0`).get(id);
    if (!row) throw Object.assign(new Error("Memória não encontrada."), { status: 404 });
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (clean.length < 6) throw Object.assign(new Error("texto curto demais"), { status: 400 });
    const bad = unsafeReason(clean);
    if (bad) throw Object.assign(new Error(`Não guardo isso na memória: ${bad}.`), { status: 400 });
    if (!String(reason || "").trim()) throw Object.assign(new Error("Informe o motivo da correção."), { status: 400 });
    const k = kind && KINDS.includes(kind) ? kind : row.kind;
    const emb = embedFn(clean);
    updateTextStmt.run(clean, k, row.source, JSON.stringify(emb), nowIso(), id);
    addHistory({ itemId: id, action: "corrigir", prevText: row.text, nextText: clean, reason, evidence, actor });
    mirrorJson();
    return rowToItem(db.prepare(`SELECT * FROM items WHERE id = ?`).get(id));
  }

  /** Revisão por nova evidência (não recria a partir de evidência rejeitada). */
  function reviseWithEvidence(id, { text, evidence, actor = "agent" } = {}) {
    const ev = String(evidence || "").trim();
    if (ev.length < 6) throw Object.assign(new Error("Informe a evidência nova."), { status: 400 });
    const hist = history(id);
    const rejected = hist.filter((h) => h.action === "corrigir" || h.action === "apagar").map((h) => h.prevText).filter(Boolean);
    const restoringRejected = rejected.some((t) => overlap(t, text) >= 0.85);
    const evidenceIsOld = rejected.some((t) => overlap(ev, t) >= 0.75);
    if (restoringRejected && evidenceIsOld) {
      throw Object.assign(new Error("Essa evidência já foi rejeitada numa correção anterior."), { status: 409 });
    }
    return edit(id, { text, reason: "nova evidência", evidence: ev, actor });
  }

  function history(itemId, limit = 30) {
    const rows = db.prepare(`SELECT * FROM history WHERE item_id = ? ORDER BY at DESC LIMIT ?`).all(itemId, limit);
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      action: r.action,
      prevText: r.prev_text,
      nextText: r.next_text,
      reason: r.reason,
      evidence: r.evidence,
      actor: r.actor,
      at: r.at,
    }));
  }

  function close(id, reason = "fechado") {
    const row = db.prepare(`SELECT * FROM items WHERE id = ? AND deleted = 0`).get(id);
    if (!row) return false;
    db.prepare(`UPDATE items SET status = 'fechado', closed_at = ?, archive_reason = ?, updated_at = ? WHERE id = ?`).run(nowIso(), reason, nowIso(), id);
    addHistory({ itemId: id, action: "fechar", prevText: row.text, reason });
    mirrorJson();
    return true;
  }

  function restore(id) {
    const row = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id);
    if (!row) return false;
    restoreStmt.run(nowIso(), id);
    addHistory({ itemId: id, action: "reabrir", nextText: row.text });
    mirrorJson();
    return true;
  }

  function compact({ maxActive = LEAN_MAX_ACTIVE } = {}) {
    let moved = 0;
    for (const item of list().filter((e) => e.status === "fechado")) {
      close(item.id, "fechado");
      moved += 1;
    }
    const active = list();
    const extra = active.length - maxActive;
    if (extra > 0) {
      const old = active
        .filter((e) => e.kind !== "regra")
        .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
        .slice(0, extra);
      for (const item of old) { close(item.id, "antigo"); moved += 1; }
    }
    return { moved, active: list().length, archived: archivedList().length };
  }

  /**
   * Busca híbrida: FTS5 + cosseno, fusão RRF.
   * Cada resultado inclui fonte.
   */
  function search(query, { limit = 8 } = {}) {
    const q = String(query || "").trim();
    if (!q) return [];
    const ftsHits = [];
    try {
      const toks = tokens(q);
      const matchExpr = toks.length
        ? toks.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ")
        : `"${q.replace(/"/g, "").slice(0, 80)}"`;
      const rows = db.prepare(`
        SELECT i.*, bm25(items_fts) AS rank
        FROM items_fts
        JOIN items i ON i.rowid = items_fts.rowid
        WHERE items_fts MATCH ? AND i.deleted = 0 AND i.status = 'aberto'
        ORDER BY rank
        LIMIT 20
      `).all(matchExpr);
      ftsHits.push(...rows);
    } catch {
      /* query FTS inválida: segue só com vetor */
    }
    const qEmb = embedFn(q);
    const all = db.prepare(`SELECT * FROM items WHERE deleted = 0 AND status = 'aberto'`).all();
    const vecHits = all
      .map((row) => {
        const emb = row.embedding ? JSON.parse(row.embedding) : embedFn(row.text);
        return { row, score: cosine(qEmb, emb) };
      })
      .filter((r) => r.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    // Reciprocal Rank Fusion
    const scores = new Map();
    const bump = (id, rank, weight = 1) => {
      const prev = scores.get(id) || 0;
      scores.set(id, prev + weight / (60 + rank));
    };
    ftsHits.forEach((row, i) => bump(row.id, i + 1, 1.2));
    vecHits.forEach((hit, i) => bump(hit.row.id, i + 1, 1));

    const byId = new Map(all.map((r) => [r.id, r]));
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => {
        const item = rowToItem(byId.get(id));
        return item ? { ...item, score, source: item.source } : null;
      })
      .filter(Boolean);
  }

  function context({ text = "", maxChars = 800 } = {}) {
    const hits = search(text, { limit: 8 });
    const lines = [];
    const ids = [];
    let used = 0;
    for (const row of hits) {
      const line = `- (${row.kind}) ${row.text} · fonte: ${row.source}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      ids.push(row.id);
      used += line.length;
    }
    // Fallback lexical se busca vazia
    if (!lines.length && text) {
      const wanted = new Set(tokens(text));
      for (const item of list()) {
        const own = tokens(item.text);
        let score = 0;
        for (const t of own) if (wanted.has(t)) score += 1;
        if (!wanted.size || score > 0) {
          const line = `- (${item.kind}) ${item.text} · fonte: ${item.source}`;
          if (used + line.length > maxChars) break;
          lines.push(line);
          ids.push(item.id);
          used += line.length;
        }
        if (lines.length >= 8) break;
      }
    }
    return { text: lines.length ? `Memória sobre o Helison:\n${lines.join("\n")}` : "", ids };
  }

  function relevant(query, n = 8) {
    return search(query, { limit: n }).map((r) => ({ tipo: r.kind, texto: r.text, fonte: r.source, score: r.score }));
  }

  return {
    list,
    remember,
    addImported,
    forget,
    edit,
    reviseWithEvidence,
    history,
    context,
    search,
    relevant,
    close,
    restore,
    archived: archivedList,
    compact,
    file: jsonFile,
    archiveFile,
    dbPath,
    maxItems: MAX_ITEMS,
    maxActive: LEAN_MAX_ACTIVE,
    embedLocal,
    backend: "node:sqlite+fts5+local-embeddings",
    _db: db,
  };
}

function createHybridMemories(dataDir, opts = {}) {
  const cache = new Map();
  const keyOf = (id) => {
    const value = String(id || "default");
    if (value === "default") return "default";
    if (!/^[\w-]{3,40}$/.test(value)) throw Object.assign(new Error("assistente inválido"), { status: 400 });
    return value;
  };
  const fileOf = (key) => (key === "default" ? "memory.json" : `memory-${key}.json`);

  function forAssistant(id) {
    const key = keyOf(id);
    if (!cache.has(key)) cache.set(key, createHybridMemory(dataDir, fileOf(key), opts));
    return cache.get(key);
  }

  function drop(id) {
    const key = keyOf(id);
    if (key === "default") return false;
    const mem = cache.get(key);
    cache.delete(key);
    try { mem?._db?.close?.(); } catch { /* ok */ }
    const base = fileOf(key).replace(/\.json$/, "");
    for (const f of [fileOf(key), fileOf(key).replace(/\.json$/, ".arquivo.json"), `${base}.sqlite`, `${base}.sqlite-wal`, `${base}.sqlite-shm`]) {
      try { fs.rmSync(path.join(dataDir, f), { force: true }); } catch { /* ok */ }
    }
    return true;
  }

  function closeAll() {
    for (const mem of cache.values()) {
      try { mem?._db?.close?.(); } catch { /* ok */ }
    }
    cache.clear();
  }

  return { for: forAssistant, drop, closeAll, backend: "hybrid-sqlite" };
}

module.exports = {
  createHybridMemory,
  createHybridMemories,
  embedLocal,
  cosine,
  DIM,
};
