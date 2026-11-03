"use strict";

/**
 * Leva E: preenchimento automático de candidatura. Tudo aqui é puro (testável) ou é script que roda na página.
 * Regra de ouro: o que não dá para preencher com segurança vira CASO CRÍTICO. Nunca chuta.
 */

const norm = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Lê "Chave: valor" do contexto.md e junta com o perfil salvo na aba Vagas (o perfil da aba ganha). */
function profileFrom(contextText, perfil = {}) {
  const out = {};
  const pick = (re) => {
    const line = String(contextText || "").split(/\r?\n/).find((l) => re.test(norm(l.replace(/^[#>*\-\s]+/, ""))));
    if (!line) return "";
    const value = line.split(/:\s*/).slice(1).join(":").trim();
    return /\[preencher\]/i.test(value) ? "" : value;
  };
  out.nome = pick(/^nome( completo)?\s*:/);
  out.email = pick(/^e-?mail\s*:/);
  out.telefone = pick(/^(telefone|celular|whatsapp)\s*:/);
  out.cidade = pick(/^(cidade|localizacao|local)\s*:/);
  out.linkedin = pick(/^linkedin\s*:/);
  out.portfolio = pick(/^(portfolio|site|github)\s*:/);
  out.pretensao = pick(/^(pretensao( salarial)?|salario)\s*:/);
  out.cvPath = pick(/^(cv|curriculo)\s*:/);
  for (const [key, value] of Object.entries(perfil || {})) if (value !== "" && value !== undefined && value !== null) out[key] = value;
  return out;
}

// Sinais de caso crítico na página inteira.
const PAGE_CRITICAL = [
  [/(teste (tecnico|online|de logica|de perfil|de ingles)|realize o teste|faca o teste|assessment|desafio tecnico|hackerrank|codility|questionario de personalidade)/, "A candidatura tem teste ou assessment."],
  [/(pagamento|cartao de credito|taxa de inscricao|pix|boleto|payment|credit card)/, "A página pede pagamento."],
  // LEVA M
  [/(question\s*\d+\s*of\s*\d+|tempo restante|cronometro|minutos restantes|timed (test|assessment)|timer\b)/, "Teste com tempo — não ajudar durante a prova."],
  [/(dedicacao exclusiva|full[- ]time exclusive|sair do (emprego|trabalho) atual|exclusividade (de )?contrato)/, "Dedicação exclusiva — perguntar ao usuário."],
];

const RACE_GENDER = /(raca|etnia|genero|sexo biologico|orientacao sexual|race\/ethnicity|gender identity|^gender$)/;
const CPF_FIELD = /\bcpf\b/;

const FIELD_RULES = [
  { re: /(primeiro nome|first name|given name)/, value: (p) => String(p.nome || "").split(" ")[0] },
  { re: /(sobrenome|ultimo nome|last name|family name|surname)/, value: (p) => String(p.nome || "").split(" ").slice(1).join(" ") },
  { re: /(nome completo|full name|^nome$|^name$|seu nome|your name)/, value: (p) => p.nome },
  { re: /(e-?mail)/, value: (p) => p.email },
  { re: /(telefone|celular|phone|mobile|whatsapp)/, value: (p) => p.telefone },
  { re: /(linkedin)/, value: (p) => p.linkedin },
  { re: /(portfolio|website|site pessoal|github)/, value: (p) => p.portfolio },
  { re: /(cidade|city|localizacao|location|onde voce mora)/, value: (p) => p.cidade },
  { re: /(^estado$|^uf$|estado \(uf\))/, value: (p) => p.estado || "" },
];

const SALARY = /(pretensao|salari|salary|remuneracao|compensation|expected pay)/;
const RELOCATION = /(mudar de cidade|mudanca|relocat|reloca|presencial|on-?site|hibrido|hybrid|disponibilidade para (trabalhar|atuar) em)/;
const TERMS = /(termo|politica de privacidade|privacy|consent|concordo|aceito|li e)/;
const CV = /(curriculo|\bcv\b|resume|résumé)/;
const SENSITIVE = /(cpf|rg\b|documento de identidade|passaporte|data de nascimento|date of birth|genero|gender|raca|etnia|deficiencia|disability)/;

/**
 * Plano de preenchimento. fields: [{ sel, tag, type, label, name, required, options:[{value,text}], checked, value }].
 * Devolve { acoes: [{ sel, kind: "text"|"select"|"check"|"file", valor }], criticos: [texto] }.
 * `secrets` (ex.: { cpf }) só para injeção no formulário — nunca persistir (padrão vault-inject).
 */
function planFill(fields, profile = {}, respostas = {}, page = {}, secrets = {}) {
  const acoes = [];
  const criticos = [];
  const pageText = norm(page.text || "");
  for (const [re, why] of PAGE_CRITICAL) if (re.test(pageText)) criticos.push(why);
  if (page.captcha) criticos.push("O site mostrou captcha ou 2FA.");
  const saved = (label) => {
    const key = norm(label).slice(0, 160);
    const hit = Object.entries(respostas || {}).find(([k]) => norm(k) === key);
    return hit ? hit[1] : "";
  };
  for (const f of fields || []) {
    const label = norm(`${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`);
    const type = String(f.type || f.tag || "").toLowerCase();
    if (!label && !f.required) continue;
    if (type === "hidden" || type === "submit" || type === "button") continue;
    const ask = (why) => criticos.push(`${why}: "${(f.label || f.name || "campo sem nome").slice(0, 120)}"`);
    if (type === "file") {
      if (CV.test(label) || (!label && f.required)) {
        if (!profile.cvPath) ask("Falta o caminho do CV no perfil");
        else acoes.push({ sel: f.sel, kind: "file", valor: profile.cvPath });
      } else if (f.required) ask("Pede upload de documento além do CV");
      continue;
    }
    if (type === "checkbox" && TERMS.test(label)) {
      if (f.required && !f.checked) ask("Termos legais novos para aceitar");
      continue;
    }
    // LEVA M: CPF pode vir do cofre (secrets.cpf) — preenchimento automático autorizado.
    if (CPF_FIELD.test(label)) {
      const cpf = String(secrets.cpf || saved(f.label || f.name) || "").trim();
      if (cpf) acoes.push({ sel: f.sel, kind: "text", valor: cpf });
      else if (f.required) ask("CPF ausente no cofre");
      continue;
    }
    if (RACE_GENDER.test(label)) {
      const answer = saved(f.label || f.name);
      if (answer) acoes.push({ sel: f.sel, kind: type === "select" ? "select" : "text", valor: answer });
      else if (f.required) ask("Pergunta de raça/gênero — perguntar ao usuário");
      continue;
    }
    if (SENSITIVE.test(label)) {
      const answer = saved(f.label || f.name);
      if (answer) acoes.push({ sel: f.sel, kind: type === "select" ? "select" : "text", valor: answer });
      else if (f.required) ask("Dado pessoal que o perfil não tem");
      continue;
    }
    if (SALARY.test(label)) {
      const answer = String(page.salaryAnswer || profile.pretensao || saved(f.label || f.name) || "").trim();
      if (!answer) { ask("Pretensão salarial sem valor no seu contexto"); continue; }
      acoes.push({ sel: f.sel, kind: type === "select" || type === "combobox" ? (type === "combobox" ? "combobox" : "select") : "text", valor: String(answer) });
      continue;
    }
    if (RELOCATION.test(label)) {
      const answer = saved(f.label || f.name) || (profile.aceitaPresencial ? "Sim" : "");
      if (!answer) { ask("Mudança de cidade ou presencial fora do perfil"); continue; }
      acoes.push({ sel: f.sel, kind: type === "select" ? "select" : type === "radio" ? "radio" : "text", valor: answer });
      continue;
    }
    if (f.value && String(f.value).trim()) continue; // o site já preencheu (ex.: e-mail da conta)
    const rule = FIELD_RULES.find((r) => r.re.test(label));
    let value = rule ? rule.value(profile) : "";
    if (!value) value = saved(f.label || f.name);
    if (!value) {
      if (f.required) ask("Pergunta que o perfil não responde");
      continue;
    }
    if (type === "select" || type === "radio" || type === "combobox") {
      const options = (f.options || []).map((o) => ({ ...o, n: norm(o.text || o.value) }));
      const want = norm(value);
      const hit = options.find((o) => o.n === want) || options.find((o) => o.n && (o.n.includes(want) || want.includes(o.n)));
      if (!hit) { if (f.required) ask("Nenhuma opção bate com o perfil"); continue; }
      acoes.push({ sel: f.sel, kind: type === "combobox" ? "combobox" : type, valor: hit.value, texto: hit.text || hit.value });
      continue;
    }
    acoes.push({ sel: f.sel, kind: "text", valor: String(value) });
  }
  return { acoes, criticos: [...new Set(criticos)] };
}

/** Script da página: lista os campos visíveis do formulário de candidatura (com um seletor estável para cada um). */
const INSPECT_SCRIPT = `(() => {
  const root = document.querySelector('.jobs-easy-apply-modal, [data-test-modal], [role="dialog"] form, form[action*="apply" i], form') || document;
  const vis = (el) => el.offsetParent !== null || el.type === "file";
  const labelOf = (el) => {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText; }
    const wrap = el.closest('label, fieldset, .fb-dash-form-element, [data-test-form-element], .form-group, div');
    const legend = el.closest('fieldset')?.querySelector('legend');
    return (el.getAttribute('aria-label') || legend?.innerText || wrap?.querySelector('label, span, legend')?.innerText || '').trim();
  };
  let n = 0;
  const fields = [];
  const seenRadio = new Set();
  for (const el of root.querySelectorAll('input, select, textarea')) {
    if (!vis(el) || el.disabled) continue;
    const type = (el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text')).toLowerCase();
    if (type === 'radio') { if (seenRadio.has(el.name)) continue; seenRadio.add(el.name); }
    const tag = 'helios-' + (n++);
    el.setAttribute('data-helios', tag);
    const options = type === 'select' ? [...el.options].map((o) => ({ value: o.value, text: o.text }))
      : type === 'radio' ? [...root.querySelectorAll('input[type=radio][name="' + CSS.escape(el.name) + '"]')].map((r) => { const t = 'helios-' + (n++); r.setAttribute('data-helios', t); return { value: t, text: labelOf(r) || r.value }; }) : [];
    fields.push({ sel: '[data-helios="' + tag + '"]', type, label: labelOf(el).slice(0, 200), name: el.name || '', placeholder: el.placeholder || '', required: el.required || el.getAttribute('aria-required') === 'true', checked: !!el.checked, value: type === 'file' ? '' : (el.value || ''), options });
  }
  const text = (document.body.innerText || '').slice(0, 6000);
  const captcha = !!document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha');
  return { fields, page: { text, captcha, url: location.href } };
})()`;

/** Script que aplica o plano (texto, select, rádio, checkbox). Arquivo é com o depurador, fora daqui. */
function applyScript(acoes) {
  return `(() => {
    const acoes = ${JSON.stringify((acoes || []).filter((a) => a.kind !== "file"))};
    const setVal = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); };
    let done = 0;
    for (const a of acoes) {
      if (a.kind === 'radio') { const r = document.querySelector('[data-helios="' + a.valor + '"]'); if (r) { r.click(); done++; } continue; }
      const el = document.querySelector(a.sel);
      if (!el) continue;
      if (a.kind === 'check') { if (!el.checked) el.click(); done++; continue; }
      setVal(el, a.valor); done++;
    }
    return done;
  })()`;
}

// Botões por texto (PT/EN). Ordem: enviar > revisar > avançar > abrir candidatura.
const BUTTONS = {
  submit: /(enviar candidatura|enviar inscricao|finalizar candidatura|finalizar inscricao|concluir candidatura|submit application|submit application now|send application|finish application|submit)/,
  review: /(revisar candidatura|revisar inscricao|review application|review)/,
  next: /(avancar|proximo|proxima\b|proxima etapa|ir para a proxima etapa|continuar candidatura|salvar e continuar|salvar e avancar|\bcontinuar\b|seguir|next|continue|save and continue)/,
  apply: /(candidatar-se|candidatura simplificada|candidatar|aplicar|quero me candidatar|easy apply|apply now|apply|inscrever-se|candidate-se)/,
};

/**
 * Script que encontra o botão por texto, aria-label, title ou atributos de
 * teste. Sites modernos escondem o texto em spans e usam div[role=button];
 * também pontuamos candidatos para não clicar em um link lateral parecido.
 */
function clickScript(kind) {
  if (!BUTTONS[kind]) throw new Error(`Tipo de botão desconhecido: ${kind}`);
  return `(() => {
    const re = new RegExp(${JSON.stringify(BUTTONS[kind].source)}, 'i');
    const n = (t) => String(t || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const textOf = (b) => n([
      b.innerText, b.textContent, b.value, b.getAttribute('aria-label'), b.getAttribute('title'),
      b.getAttribute('data-testid'), b.getAttribute('data-test-id'), b.getAttribute('data-qa'),
      b.getAttribute('name'), b.getAttribute('id'),
    ].filter(Boolean).join(' '));
    const roots = [];
    const collect = (root) => {
      if (!root || roots.includes(root)) return;
      roots.push(root);
      for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) if (el.shadowRoot) collect(el.shadowRoot);
    };
    collect(document);
    const nodes = roots.flatMap((root) => [...root.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a.btn, a, [data-testid*="button" i], [data-test*="button" i], [data-qa*="button" i]')]);
    const visible = (b) => b.getClientRects().length > 0 && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
      && getComputedStyle(b).visibility !== 'hidden' && getComputedStyle(b).display !== 'none';
    const semantic = (b) => /apply|application|candidate|candidatar|inscri|submit|enviar|continue|continuar|next|proxim|avanc|salvar/i.test([
      b.getAttribute('data-testid'), b.getAttribute('data-test-id'), b.getAttribute('data-qa'), b.getAttribute('name'), b.id,
    ].filter(Boolean).join(' '));
    const candidates = nodes
      .filter(visible).map((b) => {
        const t = textOf(b); let score = 0;
        if (/(mensagem|inmail|\\bmessage\\b|recrutador|continuar com google|cancelar|voltar|fechar|follow|compartilh)/.test(t) && !/(enviar candidatura|submit application)/.test(t)) return { b, score: -1, t };
        if (!re.test(t) && !semantic(b)) return { b, score: -1, t };
        if (b.tagName === 'BUTTON' || b.getAttribute('role') === 'button' || b.type === 'submit') score += 4;
        if (/modal|dialog|apply|candidate|application|submit|continue|next/i.test(String(b.closest('[role="dialog"], form, [data-test-modal], .modal')?.className || ''))) score += 3;
        if (b.matches(':not(a[href])')) score += 1;
        if (semantic(b)) score += 3;
        if (re.test(t)) score += 5;
        score += Math.max(0, 2 - Math.floor(t.length / 80));
        return { b, score, t };
      }).filter((x) => x.score >= 0).sort((a, z) => z.score - a.score);
    let hit = candidates[0];
    // Alguns formulários Gupy renderizam o botão sem texto útil, mas deixam
    // um submit no formulário/modal. Só usamos esse fallback dentro de um
    // formulário visível, para não clicar em ações laterais da página.
    if (!hit && (kind === 'next' || kind === 'submit')) {
      const fallback = nodes.find((b) => visible(b) && (b.type === 'submit' || b.getAttribute('data-testid')?.match(/submit|continue|next/i)) && b.closest('form, [role="dialog"], [data-test-modal], .modal'));
      if (fallback) hit = { b: fallback, score: 1, t: textOf(fallback) || (kind + ' sem rotulo') };
    }
    if (!hit) return '';
    hit.b.scrollIntoView({ block: 'center', inline: 'nearest' });
    hit.b.focus?.({ preventScroll: true });
    hit.b.click();
    return hit.t.slice(0, 160);
  })()`;
}

const SUCCESS = /(candidatura (foi )?enviada|inscricao (foi )?(realizada|enviada|concluida)|application (was )?(sent|submitted)|you applied|voce se candidatou|candidatura realizada|obrigado por se candidatar|thank you for applying|thanks for applying|we received your application|recebemos sua candidatura)/;
const isSuccess = (pageText) => SUCCESS.test(norm(pageText));

module.exports = { profileFrom, planFill, INSPECT_SCRIPT, applyScript, clickScript, isSuccess, BUTTONS, norm };
