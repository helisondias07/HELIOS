"use strict";

/**
 * Importa o fixture de candidaturas passadas para o dedupe de repetirDias.
 * Uso: node scripts/importar-candidaturas.js [pasta-de-dados]
 * Sem pasta, só conta as linhas e não grava. Não imprime empresa, URL nem data.
 */
const path = require("node:path");
const rows = require("../test/fixtures/candidaturas-importadas.json");

function main() {
  const dataDir = process.argv[2];
  if (!dataDir) {
    console.log(`linhas=${rows.length} gravado=0`);
    return;
  }
  const { createJobs } = require("../server/jobs");
  const jobs = createJobs(path.resolve(dataDir));
  const out = jobs.importHistory(rows);
  console.log(`linhas=${rows.length} importados=${out.importados} total=${out.total}`);
}

main();
