"use strict";
// LEVA Q3: sessão única do navegador das vagas (persist:vagas) + migração + Google allowlist.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { startServer } = require("../server/index");
const {
  partitionFor,
  legacyPartitionFor,
  migrateVagasSession,
  isGoogleAccountsUrl,
  SHARED_VAGAS_PARTITION,
  VAGAS_SESSAO_MARKER,
} = require("../src/jobs-host");

const TOKEN = "token-de-teste-levaQ3-xxxxxxx";

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `helios-levaQ3-${name}-`));
}

async function call(server, method, pathname, body) {
  const res = await fetch(`${server.url}${pathname}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${server.apiToken()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Sessão fake em memória (sem Electron / sem rede). Nunca loga valores de cookie. */
function fakeSession(store) {
  return {
    fromPartition(name) {
      if (!store[name]) store[name] = [];
      const bag = store[name];
      return {
        cookies: {
          async get(filter = {}) {
            return bag.filter((c) => {
              if (filter.name && c.name !== filter.name) return false;
              if (filter.url) {
                const domain = String(c.domain || "").replace(/^\./, "");
                try {
                  const u = new URL(filter.url);
                  if (u.hostname !== domain && !u.hostname.endsWith(`.${domain}`)) return false;
                } catch { return false; }
              }
              return true;
            }).map((c) => ({ ...c }));
          },
          async set(details) {
            const i = bag.findIndex((c) => c.name === details.name && String(c.domain) === String(details.domain));
            const row = {
              name: details.name,
              value: details.value,
              domain: details.domain,
              path: details.path || "/",
              secure: details.secure,
              httpOnly: details.httpOnly,
              sameSite: details.sameSite,
              expirationDate: details.expirationDate,
            };
            if (i >= 0) bag[i] = row;
            else bag.push(row);
          },
        },
      };
    },
  };
}

test("levaQ3: partitionFor é sempre persist:vagas; legacyPartitionFor mantém o formato antigo", () => {
  assert.equal(SHARED_VAGAS_PARTITION, "persist:vagas");
  assert.equal(partitionFor("linkedin"), "persist:vagas");
  assert.equal(partitionFor("gupy"), "persist:vagas");
  assert.equal(partitionFor("geral"), "persist:vagas");
  assert.equal(partitionFor(""), "persist:vagas");
  assert.equal(legacyPartitionFor("linkedin"), "persist:vagas-linkedin");
  assert.equal(legacyPartitionFor("gupy"), "persist:vagas-gupy");
  assert.notEqual(legacyPartitionFor("linkedin"), partitionFor("linkedin"));
});

test("levaQ3: isGoogleAccountsUrl só aceita https://accounts.google.com", () => {
  assert.equal(isGoogleAccountsUrl("https://accounts.google.com/"), true);
  assert.equal(isGoogleAccountsUrl("https://accounts.google.com/signin"), true);
  assert.equal(isGoogleAccountsUrl("http://accounts.google.com/"), false);
  assert.equal(isGoogleAccountsUrl("https://evil.com/"), false);
  assert.equal(isGoogleAccountsUrl("https://accounts.google.com.evil/"), false);
  assert.equal(isGoogleAccountsUrl("not-a-url"), false);
});

test("levaQ3: migração copia cookies das partições antigas e é idempotente pelo marcador", async () => {
  const userData = tmp("migr");
  const parts = path.join(userData, "Partitions");
  for (const site of ["vagas-linkedin", "vagas-gupy"]) {
    fs.mkdirSync(path.join(parts, site, "Local Storage"), { recursive: true });
    fs.mkdirSync(path.join(parts, site, "IndexedDB"), { recursive: true });
    const tag = site.endsWith("linkedin") ? "li" : "gp";
    fs.writeFileSync(path.join(parts, site, "Local Storage", `from-${tag}`), tag);
    fs.writeFileSync(path.join(parts, site, "IndexedDB", `from-${tag}`), tag);
  }

  const store = {
    "persist:vagas-linkedin": [
      { name: "li", value: "1", domain: ".linkedin.com", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: 2000000000 },
    ],
    "persist:vagas-gupy": [
      { name: "gp", value: "2", domain: "gupy.io", path: "/", secure: true, httpOnly: false, sameSite: "lax", expirationDate: 2000000000 },
      { name: "old", value: "x", domain: "gupy.io", path: "/", secure: true, expirationDate: 1000 },
    ],
    "persist:vagas": [
      { name: "old", value: "keep", domain: "gupy.io", path: "/", secure: true, expirationDate: 3000000000 },
    ],
  };
  const session = fakeSession(store);
  const fixed = new Date("2026-11-02T22:00:00.000Z");

  const r1 = await migrateVagasSession({ userData, session, now: () => fixed });
  assert.equal(r1.skipped, undefined);
  assert.equal(r1.particoes, 2);
  assert.ok(r1.cookies >= 2);
  assert.equal(r1.migradoEm, "2026-11-02T22:00:00.000Z");

  const dest = store["persist:vagas"];
  assert.ok(dest.some((c) => c.name === "li"));
  assert.ok(dest.some((c) => c.name === "gp"));
  assert.equal(dest.find((c) => c.name === "old").value, "keep"); // não sobrescreve mais novo
  assert.ok(fs.existsSync(path.join(userData, VAGAS_SESSAO_MARKER)));
  // LS/IDB: só a 1ª partição que tiver a pasta vence (limitação documentada).
  const ls = fs.readdirSync(path.join(parts, "vagas", "Local Storage"));
  const idb = fs.readdirSync(path.join(parts, "vagas", "IndexedDB"));
  assert.equal(ls.length, 1);
  assert.equal(idb.length, 1);
  assert.ok(/from-(li|gp)/.test(ls[0]));
  assert.equal(ls[0], idb[0]);
  assert.ok(fs.existsSync(path.join(parts, "vagas-linkedin"))); // antigas não apagadas
  assert.ok(fs.existsSync(path.join(parts, "vagas-gupy")));

  const before = fs.readFileSync(path.join(userData, VAGAS_SESSAO_MARKER), "utf8");
  const countBefore = dest.length;
  const r2 = await migrateVagasSession({ userData, session, now: () => new Date() });
  assert.equal(r2.skipped, true);
  assert.equal(r2.particoes, 2);
  assert.equal(dest.length, countBefore);
  assert.equal(fs.readFileSync(path.join(userData, VAGAS_SESSAO_MARKER), "utf8"), before);
});

test("levaQ3: migração sem Partitions ainda grava marcador (0)", async () => {
  const userData = tmp("empty");
  const r = await migrateVagasSession({ userData, session: fakeSession({}) });
  assert.equal(r.particoes, 0);
  assert.equal(r.cookies, 0);
  assert.ok(fs.existsSync(path.join(userData, VAGAS_SESSAO_MARKER)));
  const again = await migrateVagasSession({ userData, session: fakeSession({}) });
  assert.equal(again.skipped, true);
});

test("levaQ3: POST /api/vagas/abrir-login aceita Google e rejeita outras URLs", async () => {
  const opens = [];
  const server = await startServer({
    dataDir: tmp("api"),
    mock: true,
    port: 0,
    routineMs: 0,
    chefeMs: 0,
    getApiToken: () => TOKEN,
    abrirLoginVagas: async (arg) => {
      opens.push(arg);
      if (arg && arg.url) return { ok: true, url: arg.url, mock: true, partition: "persist:vagas" };
      return { ok: true, id: String(arg), mock: true, partition: "persist:vagas" };
    },
  });
  try {
    const ok = await call(server, "POST", "/api/vagas/abrir-login", { url: "https://accounts.google.com/" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.abertas[0].ok, true);
    assert.ok(String(ok.body.abertas[0].url).includes("accounts.google.com"));
    assert.equal(opens[0].url.includes("accounts.google.com"), true);

    const bad = await call(server, "POST", "/api/vagas/abrir-login", { url: "https://evil.example/" });
    assert.equal(bad.status, 400);

    const http = await call(server, "POST", "/api/vagas/abrir-login", { url: "http://accounts.google.com/" });
    assert.equal(http.status, 400);

    const plat = await call(server, "POST", "/api/vagas/abrir-login", { plataforma: "linkedin" });
    assert.equal(plat.status, 200);
    assert.equal(plat.body.abertas[0].id, "linkedin");
  } finally {
    await server.close();
  }
});

test("levaQ3: agent-vagas e agent-browser usam partição única", () => {
  const vagas = fs.readFileSync(path.join(__dirname, "..", "server", "agent-vagas.js"), "utf8");
  assert.match(vagas, /partition:\s*"persist:vagas"/);
  assert.doesNotMatch(vagas, /persist:vagas-linkedin/);
  const browser = fs.readFileSync(path.join(__dirname, "..", "src", "agent-browser.js"), "utf8");
  assert.match(browser, /partitionFor/);
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /migrateVagasSession/);
});
