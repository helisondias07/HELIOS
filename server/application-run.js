"use strict";

/**
 * O mesmo laço que o processo principal usa para se candidatar.
 * Primeiro as regras do DOM. Se não houver botão seguro, pede a próxima
 * ação ao modelo (texto da página e, se existir, a foto). CAPTCHA e login
 * param para o dono. Enviada só com confirmação do site.
 */

const nav = require("./form-navigator");
const vision = require("./form-vision");
const regras = require("./vagas-regras");
const { desafioVisivel } = require("./captcha-visivel");
const { cartaDeApresentacao } = require("./jobs-fill");
const { sendEmailApply } = require("./vagas-email-apply");

function summarize(snapshot = {}) {
  return {
    url: String(snapshot.url || "").slice(0, 300),
    titulo: String(snapshot.title || "").slice(0, 120),
    botoes: (snapshot.buttons || []).slice(0, 15).map((button) => String(button.text || button.ariaLabel || button.testId || "").replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean),
    campos: (snapshot.fields || []).slice(0, 15).map((field) => String(field.label || field.name || "").replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean),
    frames: Number(snapshot.frames) || 0,
    frameDiagnostico: (snapshot.frameDiagnostics || []).slice(0, 8),
    erroScript: String(snapshot.erroScript || "").slice(0, 180),
  };
}

function note(evidence, kind, detail) {
  evidence.push({ kind, detail: String(detail || "").slice(0, 500), at: new Date().toISOString() });
}

function pack(evidence, out, estado) {
  return {
    ...out,
    estado,
    classe: regras.classeFalha(out),
    evidencia: evidence.slice(-12),
    via: out.via || "rules",
    model: out.model || null,
  };
}

function captchaBloqueia(snapshot = {}) {
  return desafioVisivel(snapshot);
}

function visaoNegaCaptcha(action) {
  if (!action) return false;
  if (["clicar", "preencher", "rolar", "esperar", "email"].includes(action.acao)) return true;
  if (action.acao === "pausar" && !/captcha|rob|puzzle|desafio|human|imagens/i.test(`${action.motivo} ${action.alvo}`)) return true;
  return false;
}

function looksLikeLogin(snapshot = {}) {
  const applyVisible = (snapshot.buttons || []).some((button) => /candidat|apply|inscrev|easy apply/i.test(`${button.text || ""} ${button.ariaLabel || ""}`));
  if (applyVisible) return false;
  const url = String(snapshot.url || "");
  const text = String(snapshot.text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (snapshot.password) return true;
  if (/login|signin|authwall|checkpoint|session/i.test(url) && !/viewjob|jobs\/view|gupy\.io\/job/i.test(url)) return true;
  return /(faca login|sign in|log in|entre para|inicie sessao|criar conta|join now)/.test(text);
}

function prontoParaCandidatura(snap = {}) {
  const buttons = (snap.buttons || []).filter((button) => !button.chrome);
  const fields = (snap.fields || []).filter((field) => !field.chrome);
  const apply = buttons.some((button) => /candidat|apply|inscrev|continuar|enviar|submit|proximo|next|easy/i.test(`${button.text || ""} ${button.ariaLabel || ""} ${button.testId || ""}`));
  return apply || fields.length > 0;
}

function paginaSeguranca(snap = {}) {
  return /security\s*\|\s*glassdoor|glassdoor\.com\/security/i.test(`${snap.title || ""} ${snap.url || ""}`);
}

function paginaSmartApply(snap = {}) {
  return /smartapply\.indeed\.com|indeedapply|indeedapply/i.test(`${snap.url || ""} ${snap.title || ""}`);
}

function avisoNaoBloqueante(snap = {}) {
  return /(as respostas? nao poderao ser editad|respostas? nao poderao ser alterad|review before submit|confira suas respostas)/i.test(String(snap.text || ""));
}

function linkCandidaturaExterna(snap = {}) {
  if (!/glassdoor\./i.test(String(snap.url || ""))) return null;
  return (snap.buttons || []).find((button) => {
    const text = `${button.text || ""} ${button.ariaLabel || ""} ${button.title || ""}`;
    return button.href
      && /candidat|candidate|apply|inscrev|company site/i.test(text)
      && !/mensagem|message|conectar|connect|seguir|follow|conta gratuita|area da empresa|empresa\/cadastre|employer/i.test(`${text} ${button.href}`);
  }) || null;
}

async function abrirAtsGlassdoor(io, snap, evidence) {
  const link = linkCandidaturaExterna(snap);
  if (!link || typeof io.load !== "function") return snap;
  note(evidence, "glassdoor-external", `${link.text || link.ariaLabel || "candidatura externa"} -> ${link.href}`);
  let href = link.href;
  try { href = new URL(href, snap.url).href; } catch { /* mantém o href para o executor registrar a falha */ }
  const loaded = await io.load(href);
  if (!loaded || !loaded.ok) return snap;
  return settle(io, evidence);
}

async function clickFresh(io, action, evidence, fallback = null) {
  let fresh = await io.snapshot().catch(() => null);
  let button = fresh && vision.buttonFor(fresh, action.alvo);
  if (!button) button = fallback;
  if (!button) return false;
  const clicked = await io.click(button.sel, button.frameId);
  if (clicked) return true;
  note(evidence, "reacquire", `botão mudou; nova tentativa: ${action.alvo}`);
  fresh = await io.snapshot().catch(() => null);
  button = fresh && vision.buttonFor(fresh, action.alvo);
  return Boolean(button && await io.click(button.sel, button.frameId));
}

function detalheFalha(motivo, snap = {}) {
  const url = String(snap.url || "").slice(0, 180);
  const form = (snap.buttons || []).filter((button) => !button.chrome).slice(0, 5).map((button) => button.text || button.ariaLabel).filter(Boolean);
  const menu = (snap.buttons || []).filter((button) => button.chrome).length;
  return `${motivo} URL: ${url || "sem url"}. Formulário: ${form.join(", ") || "nenhum botão"}. Menu ignorado: ${menu}.`.replace(/\s+/g, " ").trim().slice(0, 480);
}

async function settle(io, evidence) {
  let snap = {};
  let attempts = 8;
  let delay = 500;
  for (let i = 0; i < attempts; i += 1) {
    snap = (await io.snapshot().catch((error) => ({ erroScript: String(error && error.message || error), buttons: [], fields: [] }))) || {};
    note(evidence, "snapshot", JSON.stringify({ etapa: i + 1, ...summarize(snap) }));
    if (paginaSeguranca(snap) || prontoParaCandidatura(snap)) break;
    if (paginaSmartApply(snap) && i === 0) { attempts = 30; delay = 900; }
    if (typeof io.sleep === "function") await io.sleep(delay);
  }
  return snap;
}

async function settleAfterAction(io, evidence) {
  if (typeof io.sleep === "function") await io.sleep(700);
  return settle(io, evidence);
}

async function runApplication({ vaga = {}, profile = {}, respostas = {}, secrets = {}, enviar = true, llm = null, io, maxTurns = 20 } = {}) {
  const evidence = [];
  if ((vaga.platform === "email" || vaga.aplicarPorEmail) && vaga.emailTo) {
    if (!io || typeof io.sendEmail !== "function") {
      return pack(evidence, { critico: "A vaga pede e-mail com CV e o envio do Gmail não está disponível.", codigo: "email", classe: "tecnico" }, "failed");
    }
    try {
      const sent = await sendEmailApply({
        cargo: vaga.title,
        to: vaga.emailTo,
        body: cartaDeApresentacao(vaga, profile),
        cvPath: profile.cvPath,
        nome: profile.nome,
        send: io.sendEmail,
      });
      if (sent.ok && sent.confirmacao) {
        note(evidence, "success-text", sent.confirmacao);
        return pack(evidence, { ok: true, enviado: true, confirmacao: sent.confirmacao, via: "email" }, "submitted");
      }
      return pack(evidence, { critico: sent.error || "O e-mail não saiu.", codigo: "email", classe: "tecnico" }, "failed");
    } catch (error) {
      return pack(evidence, { critico: String(error && error.message || error).slice(0, 180), codigo: "email", classe: "tecnico" }, "failed");
    }
  }
  if (!io || typeof io.load !== "function" || typeof io.snapshot !== "function") {
    return pack(evidence, { critico: "Executor de página indisponível.", codigo: "executor", classe: "tecnico" }, "failed");
  }
  let loaded = await io.load(vaga.url);
  if (!loaded.ok && /ERR_ABORTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_TIMED_OUT|ETIMEDOUT/i.test(String(loaded.error || ""))) {
    note(evidence, "rede", String(loaded.error || "").slice(0, 180));
    if (typeof io.sleep === "function") await io.sleep(400);
    loaded = await io.load(vaga.url);
  }
  if (!loaded.ok) {
    note(evidence, "rede", `${loaded.error || "falha ao carregar"} ${vaga.url || ""}`.slice(0, 300));
    return pack(evidence, { critico: loaded.error || "A página não abriu.", codigo: "rede", classe: "tecnico" }, "failed");
  }
  if (typeof io.afterLoad === "function") {
    const early = await io.afterLoad();
    if (early) return pack(evidence, early, early.estado || "needs_user");
  }
  let snap = await settle(io, evidence);
  if (/glassdoor\./i.test(String(snap.url || ""))) snap = await abrirAtsGlassdoor(io, snap, evidence);
  if (paginaSeguranca(snap) && !prontoParaCandidatura(snap)) {
    if (typeof io.show === "function") io.show();
    return pack(evidence, { critico: detalheFalha("A página caiu na verificação de segurança do Glassdoor.", snap), codigo: "login", classe: "humano" }, "needs_user");
  }
  if (captchaBloqueia(snap) && !llm) {
    if (typeof io.show === "function") io.show();
    return pack(evidence, { critico: "O site mostrou um captcha visível. Resolva na janela; o HELIOS não contorna captcha.", codigo: "captcha", classe: "humano", via: "rules" }, "needs_user");
  }
  if (looksLikeLogin(snap) && !(snap.buttons || []).some((button) => /candidat|apply|inscrev/i.test(`${button.text || ""} ${button.ariaLabel || ""}`))) {
    if (typeof io.show === "function") io.show();
    note(evidence, "login", summarize(snap).url);
    return pack(evidence, { critico: "A página pediu login. Entre na janela do HELIOS; esta vaga fica esperando você.", codigo: "login", classe: "humano" }, "needs_user");
  }
  const secretValues = [profile.nome, profile.email, profile.telefone, secrets.cpf, secrets.telefone].filter(Boolean);
  let memory = {};
  let via = "rules";
  let model = null;
  let filledTotal = 0;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (turn > 0) {
      snap = (await io.snapshot().catch((error) => ({ ...snap, erroScript: String(error && error.message || error) }))) || snap;
      note(evidence, "snapshot", JSON.stringify({ etapa: turn + 1, ...summarize(snap) }));
    }
    let visaoPronta = null;
    if (captchaBloqueia(snap)) {
      if (!llm) {
        if (typeof io.show === "function") io.show();
        return pack(evidence, { critico: "O site mostrou um captcha visível. Resolva na janela; o HELIOS não contorna captcha.", codigo: "captcha", classe: "humano", via, model }, "needs_user");
      }
      const screenshot = typeof io.screenshot === "function" ? await io.screenshot().catch(() => "") : "";
      visaoPronta = await vision.askNextAction(llm, { ...snap, screenshot }, secretValues);
      model = (visaoPronta && visaoPronta.model) || model;
      const action = visaoPronta && visaoPronta.action;
      if (!visaoNegaCaptcha(action)) {
        if (typeof io.show === "function") io.show();
        return pack(evidence, { critico: "O site mostrou um captcha visível. Resolva na janela; o HELIOS não contorna captcha.", codigo: "captcha", classe: "humano", via: "visao", model }, "needs_user");
      }
      note(evidence, "visao", "o desafio não está na tela");
    }
    if (regras.paginaHibrida(snap, vaga)) {
      note(evidence, "regra", "página indica híbrido ou presencial");
      return pack(evidence, { critico: "A vaga não é somente remota (híbrido ou presencial na página).", codigo: "regra", classe: "tecnico", via, model }, "failed");
    }
    if (llm) {
      const screenshot = visaoPronta ? "" : (typeof io.screenshot === "function" ? await io.screenshot().catch(() => "") : "");
      const asked = visaoPronta || await vision.askNextAction(llm, { ...snap, screenshot }, secretValues);
      model = (asked && asked.model) || model;
      const action = asked && asked.action;
      if (action && action.acao === "pausar" && /captcha/i.test(`${action.motivo} ${action.alvo}`) && captchaBloqueia(snap)) {
        if (typeof io.show === "function") io.show();
        return pack(evidence, { critico: "O site mostrou um captcha visível.", codigo: "captcha", classe: "humano", via: "visao", model }, "needs_user");
      }
      if (action && action.acao === "email" && typeof io.sendEmail === "function") {
        const sent = await sendEmailApply({
          cargo: vaga.title,
          to: action.alvo,
          cvPath: profile.cvPath,
          nome: profile.nome,
          send: io.sendEmail,
        });
        if (sent.ok && sent.confirmacao) {
          note(evidence, "success-text", sent.confirmacao);
          return pack(evidence, { ok: true, enviado: true, confirmacao: sent.confirmacao, via: "visao", model }, "submitted");
        }
      }
      if (action && action.acao === "clicar") {
        if (/mensagem|inmail|recrutador|conectar/i.test(action.alvo)) {
          return pack(evidence, { critico: regras.nuncaMensagemRecrutador().motivo, codigo: "mensagem", classe: "tecnico", via: "visao", model }, "failed");
        }
        const button = vision.buttonFor(snap, action.alvo);
        if (button) {
          via = "visao";
          note(evidence, "visao", `clicar ${button.text || action.alvo}`);
          const clicked = await clickFresh(io, action, evidence, button);
          if (!clicked) return pack(evidence, { critico: "O botão indicado pela visão sumiu antes do clique.", codigo: "botao", classe: "tecnico", via, model }, "failed");
          await settleAfterAction(io, evidence);
          continue;
        }
      }
      if (action && action.acao === "preencher") {
        const field = vision.fieldFor(snap, action.alvo);
        const valor = vision.resolveValor(action.valor, profile, vaga);
        if (field && memory.filled && memory.filled[field.sel]) {
          note(evidence, "visao", `já preenchido ${field.label || action.alvo}`);
        } else if (field && valor) {
          via = "visao";
          note(evidence, "visao", `preencher ${field.label || action.alvo}`);
          filledTotal += Number(await io.apply([{ sel: field.sel, frameId: field.frameId, kind: field.type === "file" ? "file" : "text", valor }])) || 0;
          memory.filled = { ...(memory.filled || {}), [field.sel]: true };
          continue;
        }
      }
      if (action && (action.acao === "rolar" || action.acao === "esperar")) {
        via = "visao";
        note(evidence, "visao", action.acao);
        if (action.acao === "rolar" && typeof io.scroll === "function") await io.scroll();
        if (typeof io.sleep === "function") await io.sleep(500);
        continue;
      }
    }
    const decision = nav.step(snap, { profile, respostas, secrets, memory, enviar, vaga });
    memory = decision.memory || memory;
    if (decision.via && decision.via !== "rules") via = decision.via;
    if (decision.kind === "failed" && decision.codigo === "botao" && llm) {
      const screenshot = typeof io.screenshot === "function" ? await io.screenshot().catch(() => "") : "";
      const asked = await vision.askNextAction(llm, { ...snap, screenshot }, secretValues);
      model = (asked && asked.model) || model;
      const action = asked && asked.action;
      if (action && action.acao === "pausar") {
        const captcha = /captcha|rob|puzzle|desafio/i.test(`${action.motivo} ${action.alvo}`) && captchaBloqueia(snap);
        if (captcha || /login|senha|2fa/i.test(`${action.motivo} ${action.alvo}`)) {
          if (typeof io.show === "function") io.show();
          return pack(evidence, {
            critico: action.motivo || "O modelo pediu para parar nesta página.",
            codigo: captcha ? "captcha" : "login",
            classe: "humano",
            via: "visao",
            model,
          }, "needs_user");
        }
        if (avisoNaoBloqueante(snap) && !/teste|pagamento|captcha|login|senha/i.test(`${action.motivo} ${action.alvo}`)) {
          note(evidence, "aviso-informativo", "aviso de respostas não editáveis ignorado; seguindo para revisão/envio");
        } else if (action.motivo || action.alvo) {
          return pack(evidence, { critico: action.motivo || "O modelo pediu para parar nesta página.", codigo: "visao", classe: "tecnico", via: "visao", model }, "failed");
        }
      }
      if (action && action.acao === "clicar") {
        if (/mensagem|inmail|recrutador|conectar/i.test(action.alvo)) {
          return pack(evidence, { critico: regras.nuncaMensagemRecrutador().motivo, codigo: "mensagem", classe: "tecnico", via: "visao", model }, "failed");
        }
        const button = vision.buttonFor(snap, action.alvo);
        if (button) {
          via = "visao";
          note(evidence, "visao", `clicar ${button.text || action.alvo}`);
          const clicked = await clickFresh(io, action, evidence, button);
          if (!clicked) {
            return pack(evidence, { critico: "O botão indicado pela visão sumiu antes do clique.", codigo: "botao", classe: "tecnico", via, model }, "failed");
          }
          await settleAfterAction(io, evidence);
          continue;
        }
      }
      if (action && action.acao === "preencher") {
        const field = vision.fieldFor(snap, action.alvo);
        const valor = vision.resolveValor(action.valor, profile, vaga);
        if (field && valor) {
          via = "visao";
          note(evidence, "visao", `preencher ${field.label || action.alvo}`);
          filledTotal += Number(await io.apply([{ sel: field.sel, frameId: field.frameId, kind: field.type === "file" ? "file" : "text", valor }])) || 0;
          memory.filled = { ...(memory.filled || {}), [field.sel]: true };
          continue;
        }
      }
    }
    if (decision.fills && decision.fills.length && typeof io.apply === "function") {
      filledTotal += Number(await io.apply(decision.fills)) || 0;
      for (const action of decision.fills.filter((item) => item.kind === "file")) {
        if (typeof io.setFile !== "function") continue;
        try { await io.setFile(action.sel, action.valor, action.frameId); filledTotal += 1; } catch (error) {
          return pack(evidence, { critico: `Não consegui anexar o CV: ${error.message}`, codigo: "arquivo", classe: "tecnico", via, model }, "failed");
        }
      }
      if (typeof io.sleep === "function") await io.sleep(300);
    }
    if (decision.kind === "submitted") {
      note(evidence, "success-text", decision.confirmacao);
      return pack(evidence, { ok: true, enviado: true, confirmacao: decision.confirmacao, nota: `${filledTotal} campo(s) preenchido(s)`, via, model }, "submitted");
    }
    if (decision.kind === "review") {
      if (typeof io.show === "function") io.show();
      return pack(evidence, { ok: true, enviado: false, paradoAntesDeEnviar: true, nota: `${filledTotal} campo(s) preenchido(s). Nada foi enviado.`, via, model, classe: "humano" }, "review");
    }
    if (decision.kind === "pause" || decision.kind === "failed") {
      if (decision.codigo === "captcha" && typeof io.show === "function") io.show();
      note(evidence, "parada", JSON.stringify(summarize(snap)));
      return pack(evidence, {
        critico: decision.codigo === "botao" ? detalheFalha(decision.motivo, snap) : decision.motivo,
        pergunta: decision.pergunta || decision.motivo,
        codigo: decision.codigo,
        classe: decision.codigo === "captcha" || decision.codigo === "ambiguidade" ? "humano" : regras.classeFalha({ motivo: decision.motivo, codigo: decision.codigo }),
        via,
        model,
      }, decision.kind === "failed" ? "failed" : "needs_user");
    }
    if (decision.click) {
      note(evidence, decision.click.intent || "click", decision.click.text || decision.click.sel);
      let clicked = await io.click(decision.click.sel, decision.click.frameId);
      if (!clicked) {
        const fresh = await io.snapshot().catch(() => null);
        const choice = fresh && nav.chooseButton(fresh);
        if (choice && choice.button) clicked = await io.click(choice.button.sel, choice.button.frameId);
        note(evidence, "reacquire", "botão de regra reacquirido após mudança do DOM");
      }
      if (!clicked) {
        return pack(evidence, { critico: "O botão sumiu antes do clique.", codigo: "botao", classe: "tecnico", via, model }, "failed");
      }
      await settleAfterAction(io, evidence);
    }
  }
  note(evidence, "limite", JSON.stringify(summarize(snap)));
  return pack(evidence, { critico: "O formulário passou do limite de etapas sem confirmação do site.", codigo: "limite", classe: "tecnico", via, model }, "failed");
}

module.exports = { runApplication, summarize, looksLikeLogin };
