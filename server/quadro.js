"use strict";

/**
 * LEVA O1: quadro compartilhado entre Chefe e agentes (Vagas, Pesquisa, Oasis, Portfólio).
 * SQLite via node:sqlite (mesmo stack da memória híbrida). Arquivo dedicado quadro.sqlite
 * para não disputar o handle de memory.sqlite.
 */
const fs = require("node:fs");
const path = require("node:path");
const { newId, nowIso, redact } = require("./util");

const TIPOS = new Set(["achado", "pedido", "resultado", "alerta"]);
const STATUS = new Set(["aberto", "em_andamento", "feito", "cancelado"]);
const AGENTES = new Set(["chefe", "vagas", "pesquisa", "oasis", "portfolio", "helison", "sistema"]);

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function openDb(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS quadro (
      id TEXT PRIMARY KEY,
      de TEXT NOT NULL,
      para TEXT NOT NULL,
      tipo TEXT NOT NULL,
      assunto TEXT NOT NULL,
      corpo TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'aberto',
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL,
      ref TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quadro_para ON quadro(para);
    CREATE INDEX IF NOT EXISTS idx_quadro_de ON quadro(de);
    CREATE INDEX IF NOT EXISTS idx_quadro_status ON quadro(status);
    CREATE INDEX IF NOT EXISTS idx_quadro_tipo ON quadro(tipo);
  `);
  return db;
}

function rowView(row) {
  if (!row) return null;
  return {
    id: row.id,
    de: row.de,
    para: row.para,
    tipo: row.tipo,
    assunto: row.assunto,
    corpo: row.corpo,
    status: row.status,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    ref: row.ref || null,
  };
}

function cleanActor(value, fallback = "sistema") {
  const key = String(value || fallback).trim().toLowerCase().slice(0, 40);
  if (!key) return fallback;
  if (AGENTES.has(key)) return key;
  // aceita ids de assistente conhecidos sem inventar papéis novos perigosos
  return key.replace(/[^a-z0-9_-]/g, "").slice(0, 40) || fallback;
}

function createQuadro(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "quadro.sqlite");
  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    throw Object.assign(new Error(`SQLite indisponível para o quadro (${err.message}).`), { cause: err });
  }

  const insertStmt = db.prepare(`INSERT INTO quadro (id, de, para, tipo, assunto, corpo, status, criado_em, atualizado_em, ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateStatusStmt = db.prepare(`UPDATE quadro SET status = ?, atualizado_em = ? WHERE id = ?`);

  function porRef(ref) {
    const key = String(ref || "").slice(0, 120);
    if (!key) return [];
    return db.prepare("SELECT * FROM quadro WHERE ref = ? ORDER BY criado_em DESC LIMIT 20").all(key).map(rowView);
  }

  function postar(input = {}) {
    const de = cleanActor(input.de, "sistema");
    const para = cleanActor(input.para, "chefe");
    const tipo = String(input.tipo || "").trim().toLowerCase();
    if (!TIPOS.has(tipo)) throw fail("tipo deve ser achado, pedido, resultado ou alerta.");
    const assunto = redact(String(input.assunto || "").replace(/\s+/g, " ").trim()).slice(0, 160);
    if (assunto.length < 2) throw fail("Informe o assunto.");
    const corpo = redact(String(input.corpo || "").trim()).slice(0, 4000);
    if (corpo.length < 1) throw fail("Informe o corpo.");
    // Oasis isolado: itens de emprego não vão para oasis e vice-versa.
    const emprego = /vaga|emprego|candidatura|linkedin|curriculo|cv\b|salar/i;
    if (para === "oasis" && emprego.test(`${assunto} ${corpo}`) && de !== "oasis" && de !== "chefe") {
      throw fail("Itens de emprego não vão para o Oasis. Use Vagas, Pesquisa ou Portfólio.");
    }
    if (de === "oasis" && ["vagas", "pesquisa", "portfolio"].includes(para) && emprego.test(`${assunto} ${corpo}`)) {
      throw fail("Oasis não mistura itens de emprego com os outros agentes.");
    }
    const status = STATUS.has(String(input.status || "").toLowerCase()) ? String(input.status).toLowerCase() : "aberto";
    const ref = input.ref != null ? String(input.ref).slice(0, 120) : null;
    // LEVA O9: idempotência por ref (ex.: semana:2026-W44) — devolve o existente.
    if (input.idempotente && ref) {
      const hit = db.prepare(
        "SELECT * FROM quadro WHERE ref = ? AND de = ? AND para = ? AND tipo = ? ORDER BY criado_em DESC LIMIT 1",
      ).get(ref, de, para, tipo);
      if (hit) return rowView(hit);
    }
    const now = nowIso();
    const id = newId("qd");
    insertStmt.run(id, de, para, tipo, assunto, corpo, status, now, now, ref);
    return rowView(db.prepare("SELECT * FROM quadro WHERE id = ?").get(id));
  }

  function ler(filtros = {}) {
    const where = [];
    const params = [];
    if (filtros.para) { where.push("para = ?"); params.push(cleanActor(filtros.para)); }
    if (filtros.de) { where.push("de = ?"); params.push(cleanActor(filtros.de)); }
    if (filtros.status) {
      const st = String(filtros.status).toLowerCase();
      if (!STATUS.has(st)) throw fail("status inválido.");
      where.push("status = ?");
      params.push(st);
    }
    if (filtros.tipo) {
      const tp = String(filtros.tipo).toLowerCase();
      if (!TIPOS.has(tp)) throw fail("tipo inválido.");
      where.push("tipo = ?");
      params.push(tp);
    }
    const limite = Math.min(200, Math.max(1, Number(filtros.limite) || 50));
    const sql = `SELECT * FROM quadro${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY criado_em DESC LIMIT ?`;
    params.push(limite);
    return db.prepare(sql).all(...params).map(rowView);
  }

  function atualizarStatus(id, status) {
    const st = String(status || "").toLowerCase();
    if (!STATUS.has(st)) throw fail("status deve ser aberto, em_andamento, feito ou cancelado.");
    const item = db.prepare("SELECT * FROM quadro WHERE id = ?").get(String(id || ""));
    if (!item) throw fail("Item do quadro não encontrado.", 404);
    updateStatusStmt.run(st, nowIso(), item.id);
    return rowView(db.prepare("SELECT * FROM quadro WHERE id = ?").get(item.id));
  }

  function get(id) {
    return rowView(db.prepare("SELECT * FROM quadro WHERE id = ?").get(String(id || "")));
  }

  function resumo() {
    const abertos = db.prepare("SELECT COUNT(*) AS n FROM quadro WHERE status IN ('aberto','em_andamento')").get().n;
    const porStatus = db.prepare("SELECT status, COUNT(*) AS n FROM quadro GROUP BY status").all()
      .map((r) => ({ status: r.status, n: r.n }));
    const porPara = db.prepare("SELECT para, COUNT(*) AS n FROM quadro WHERE status IN ('aberto','em_andamento') GROUP BY para").all()
      .map((r) => ({ para: r.para, n: r.n }));
    const ultimos = ler({ limite: 8 });
    return { abertos, porStatus, porPara, ultimos };
  }

  function close() {
    try { db.close(); } catch { /* ok */ }
  }

  return { postar, ler, porRef, atualizarStatus, get, resumo, close, dbPath, TIPOS: [...TIPOS], STATUS: [...STATUS] };
}

module.exports = { createQuadro, TIPOS: [...TIPOS], STATUS: [...STATUS], AGENTES: [...AGENTES] };
