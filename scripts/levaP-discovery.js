"use strict";
/**
 * Leva P: descoberta ao vivo (.well-known + UMA tentativa de DCR) para ClickUp e Vercel.
 * NÃO completa login; NÃO guarda tokens. Uma tentativa de register por provedor.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const OUT = process.env.HELIOS_LEVAP_DISCOVERY || path.join(os.tmpdir(), "levaP-discovery.json");

async function readJson(res) {
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, body: JSON.parse(text) }; } catch {
    return { ok: res.ok, status: res.status, body: { raw: text.slice(0, 240) } };
  }
}

async function discoverOne(name, mcpUrl) {
  const result = { name, mcpUrl, probe: null, resource: null, as: null, dcr: null, erro: "" };
  try {
    const probe = await fetch(mcpUrl, { method: "GET", headers: { accept: "application/json" }, redirect: "manual" });
    const www = probe.headers.get("www-authenticate") || "";
    result.probe = { status: probe.status, wwwAuthenticate: www.slice(0, 300) };
    const metaMatch = /resource_metadata="([^"]+)"/i.exec(www);
    let resourceUrl = metaMatch ? metaMatch[1] : "";
    if (!resourceUrl) {
      const u = new URL(mcpUrl);
      const p = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
      resourceUrl = `${u.origin}/.well-known/oauth-protected-resource${p}`;
    }
    const resMeta = await readJson(await fetch(resourceUrl, { headers: { accept: "application/json" } }));
    result.resource = { url: resourceUrl, ...resMeta };
    const issuer = Array.isArray(resMeta.body?.authorization_servers) ? resMeta.body.authorization_servers[0] : "";
    if (!issuer) {
      result.erro = "sem authorization_servers";
      return result;
    }
    const issuerUrl = new URL(issuer);
    const pathPart = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "");
    const candidates = [
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${pathPart}`,
      `${issuerUrl.origin}${pathPart}/.well-known/oauth-authorization-server`,
    ];
    for (const candidate of candidates) {
      const as = await readJson(await fetch(candidate, { headers: { accept: "application/json" } }));
      if (as.ok) {
        result.as = {
          url: candidate,
          authorization_endpoint: as.body.authorization_endpoint || "",
          token_endpoint: as.body.token_endpoint || "",
          registration_endpoint: as.body.registration_endpoint || "",
          device_authorization_endpoint: as.body.device_authorization_endpoint || "",
          code_challenge_methods_supported: as.body.code_challenge_methods_supported || [],
        };
        break;
      }
    }
    if (!result.as) {
      result.erro = "AS metadata não encontrada";
      return result;
    }
    if (!result.as.registration_endpoint) {
      result.dcr = { status: "sem_endpoint", mensagem: "Provedor sem registration_endpoint (sem DCR)." };
      return result;
    }
    // UMA tentativa — redirect de loopback efêmero típico
    const reg = await fetch(result.as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "HELIOS-discovery",
        redirect_uris: ["http://127.0.0.1:48111/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const body = await readJson(reg);
    if (body.ok && body.body?.client_id) {
      result.dcr = {
        status: "aceito",
        mensagem: "DCR aceitou o cliente (client_id recebido; não persistido).",
        // NÃO grava client_id em disco de forma útil — só indica presença
        temClientId: true,
      };
    } else {
      result.dcr = {
        status: "recusado",
        http: body.status,
        mensagem: String(body.body?.error_description || body.body?.error || body.body?.raw || `HTTP ${body.status}`).slice(0, 240),
      };
    }
  } catch (err) {
    result.erro = String(err && err.message ? err.message : err).slice(0, 240);
  }
  return result;
}

async function main() {
  const clickup = await discoverOne("ClickUp", "https://mcp.clickup.com/mcp");
  const vercel = await discoverOne("Vercel", "https://mcp.vercel.com");
  const out = {
    em: new Date().toISOString(),
    nota: "Só descoberta + 1× DCR cada. Sem login completo. Sem tokens persistidos.",
    clickup,
    vercel,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  console.log(JSON.stringify({
    out: OUT,
    clickupDcr: clickup.dcr?.status || clickup.erro,
    vercelDcr: vercel.dcr?.status || vercel.erro,
  }));
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
