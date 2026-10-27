"use strict";

const { appendHeliosLog } = require("./util");

/** O texto que o @cursor/sdk lança quando o binário de sandbox não existe neste computador. */
const SANDBOX_UNSUPPORTED_RE = /sandboxing is not supported|Disable local\.sandboxOptions\.enabled/i;

function sandboxUnsupported(err) {
  const text = `${err?.message || ""} ${err?.cause?.message || ""}`;
  return SANDBOX_UNSUPPORTED_RE.test(text);
}

function withSandbox(opts, enabled) {
  return {
    ...opts,
    local: { ...(opts.local || {}), sandboxOptions: { enabled: Boolean(enabled) } },
  };
}

/**
 * Pede o sandbox do SDK e, se ele recusar, segue sem esse isolamento.
 * Não mexe em tools, disallowedTools, cartões nem na trava de pagar/preencher login.
 */
function createSandboxGate({ log = () => {}, dataDir = null, platform = process.platform } = {}) {
  let supported = null;
  let noted = false;

  function notice() {
    if (supported !== false) return "";
    const where = platform === "win32" ? "neste Windows" : "neste computador";
    return `O isolamento do SDK do Cursor não está disponível ${where}. As aprovações continuam valendo: pagar e preencher login seguem em Pedir antes.`;
  }

  function note(err) {
    if (!sandboxUnsupported(err)) return false;
    supported = false;
    if (noted) return true;
    noted = true;
    const where = platform === "win32" ? "Windows" : platform;
    const detail = String(err?.message || err || "").split(/\r?\n/)[0].slice(0, 220);
    const line = `[sandbox] O isolamento do SDK não está disponível (${where}). Seguindo sem sandbox. As aprovações do HELIOS continuam. ${detail}`;
    try { log(line); } catch { /* o log da tela não pode impedir o fallback */ }
    appendHeliosLog(dataDir, line);
    return true;
  }

  async function run({ create, resume = null, opts }) {
    const attempt = async (enabled, useResume) => {
      const next = withSandbox(opts, enabled);
      if (useResume && resume) return resume(next);
      return create(next);
    };
    if (supported === false) return attempt(false, true);
    try {
      const agent = await attempt(true, true);
      supported = true;
      return agent;
    } catch (err) {
      if (!note(err)) throw err;
      if (resume) {
        try { return await attempt(false, true); }
        catch (again) {
          if (!sandboxUnsupported(again)) throw again;
        }
      }
      return attempt(false, false);
    }
  }

  function status() {
    return { available: supported, notice: notice() };
  }

  return { run, note, status, notice };
}

module.exports = { createSandboxGate, sandboxUnsupported, withSandbox };
