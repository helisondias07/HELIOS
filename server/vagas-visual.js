"use strict";

/**
 * Catálogo de busca visual. Cada site abre no navegador persistente;
 * um adaptador que falha não remove os outros da rodada.
 * URLs de busca são ponto de partida: o campo visual da página manda.
 */

function searchUrl(base) {
  return (term) => `${base}${base.includes("?") ? "&" : "?"}q=${encodeURIComponent(term || "")}`;
}

const VISUAL_PLATFORMS = [
  { id: "linkedin", label: "LinkedIn", home: "https://www.linkedin.com/jobs/", searchUrl: (term, location) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(term || "")}&location=${encodeURIComponent(location || "Brasil")}&f_WT=2` },
  { id: "gupy", label: "Gupy", home: "https://portal.gupy.io/", searchUrl: (term) => `https://portal.gupy.io/job-search/term=${encodeURIComponent(term || "")}` },
  { id: "infojobs", label: "InfoJobs", home: "https://www.infojobs.com.br/", searchUrl: searchUrl("https://www.infojobs.com.br/vagas-de-emprego.aspx") },
  { id: "indeed", label: "Indeed", home: "https://br.indeed.com/", searchUrl: (term) => `https://br.indeed.com/jobs?q=${encodeURIComponent(term || "")}&l=Brasil` },
  { id: "glassdoor", label: "Glassdoor", home: "https://www.glassdoor.com.br/Vaga/index.htm", searchUrl: searchUrl("https://www.glassdoor.com.br/Vaga/index.htm") },
  { id: "catho", label: "Catho", home: "https://www.catho.com.br/vagas/", searchUrl: searchUrl("https://www.catho.com.br/vagas/") },
  { id: "coodesh", label: "Coodesh", home: "https://coodesh.com/vagas", searchUrl: searchUrl("https://coodesh.com/vagas") },
  { id: "geekhunter", label: "GeekHunter", home: "https://www.geekhunter.com.br/vagas", searchUrl: searchUrl("https://www.geekhunter.com.br/vagas") },
  { id: "programathor", label: "ProgramaThor", home: "https://programathor.com.br/jobs", searchUrl: searchUrl("https://programathor.com.br/jobs") },
  { id: "trampos", label: "trampos.co", home: "https://trampos.co/oportunidades", searchUrl: searchUrl("https://trampos.co/oportunidades") },
  { id: "nerdin", label: "Nerdin", home: "https://www.nerdin.com.br/vagas", searchUrl: searchUrl("https://www.nerdin.com.br/vagas") },
  { id: "bossabox", label: "BossaBox", home: "https://app.bossabox.com/vagas", searchUrl: searchUrl("https://app.bossabox.com/vagas") },
  { id: "remotar", label: "Remotar", home: "https://remotar.com.br/", searchUrl: searchUrl("https://remotar.com.br/") },
];

function catalog() {
  return VISUAL_PLATFORMS.map((item) => ({ ...item }));
}

function termsFor(platformId, terms) {
  const list = Array.isArray(terms) ? terms.filter(Boolean) : [];
  const cap = platformId === "linkedin" || platformId === "gupy" ? 3 : 1;
  return (list.length ? list : ["desenvolvedor front-end"]).slice(0, cap);
}

const JOB_LINK = /linkedin\.com\/jobs\/view|gupy\.io\/(?:job|jobs)\/|indeed\.|glassdoor\.|catho\.com|infojobs\.|coodesh\.com|geekhunter\.|programathor\.|trampos\.co|nerdin\.|bossabox\.|remotar\.com|greenhouse\.io|ashbyhq\.com|lever\.co|\/(?:vaga|vagas|job|jobs|oportunidade|oportunidades)\b/i;

const AD_URL = /pagead\/clk|doubleclick\.|googleadservices|\/aclk\b|\/rc\/clk/i;

/** Troca o rastreador de anúncio pelo endereço da vaga. Indeed precisa do parâmetro jk. */
function canonicalJobUrl(href) {
  const raw = String(href || "");
  if (!/^https:\/\//i.test(raw)) return "";
  const jk = (raw.match(/[?&]jk=([a-z0-9]+)/i) || [])[1];
  if (AD_URL.test(raw)) {
    if (jk && /indeed\./i.test(raw)) return `https://br.indeed.com/viewjob?jk=${jk}`;
    return "";
  }
  try {
    const u = new URL(raw);
    if (/indeed\./i.test(u.hostname) && jk) return `${u.origin}/viewjob?jk=${jk}`;
    u.hash = "";
    if (!/indeed\./i.test(u.hostname)) u.search = "";
    return u.href;
  } catch {
    return "";
  }
}

function itemsFromAnchors(anchors = []) {
  const map = new Map();
  for (const anchor of anchors) {
    const href = String(anchor.href || anchor.url || "");
    const url = canonicalJobUrl(href);
    if (!url || !JOB_LINK.test(url)) continue;
    if (map.has(url)) continue;
    const title = String(anchor.title || anchor.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!title) continue;
    const extId = (href.match(/(?:jobs\/view|jobs|job)\/(\d+)/i) || [])[1] || url;
    map.set(url, {
      extId,
      title,
      company: String(anchor.company || "").slice(0, 120),
      url,
      description: String(anchor.description || anchor.text || "").replace(/\s+/g, " ").trim().slice(0, 1500),
    });
  }
  return [...map.values()].slice(0, 40);
}

const CAPTURE_SCRIPT = `(() => {
  const jobLink = ${JOB_LINK.toString()};
  const anchors = [...document.querySelectorAll("a[href]")].filter((a) => jobLink.test(a.href));
  const items = [];
  const seen = new Set();
  for (const a of anchors) {
    const jk = (a.href.match(/[?&]jk=([a-z0-9]+)/i) || [])[1];
    let url = a.href.split("#")[0];
    if (/pagead\\/clk|doubleclick|googleadservices|\\/aclk\\b|\\/rc\\/clk/i.test(a.href)) {
      if (!(jk && /indeed\\./i.test(a.href))) continue;
      url = "https://br.indeed.com/viewjob?jk=" + jk;
    } else if (jk && /indeed\\./i.test(a.href)) url = a.href.split("/").slice(0, 3).join("/") + "/viewjob?jk=" + jk;
    else url = url.split("?")[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const card = a.closest("article, li, [data-job-id], [data-testid*='job' i], div");
    const text = (card && card.innerText || a.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 1800);
    const heading = card && card.querySelector("h1,h2,h3,h4,[class*='title' i]");
    const title = (heading && heading.innerText || a.innerText || text).trim().slice(0, 200);
    if (!title) continue;
    const ext = (a.href.match(/(?:jobs\\/view|jobs|job)\\/(\\d+)/i) || [])[1] || url;
    items.push({ extId: ext, title, company: "", url, description: text });
    if (items.length >= 40) break;
  }
  return { items, diagnostics: { anchors: anchors.length, itemCount: items.length, title: document.title, url: location.href, bodyChars: (document.body && document.body.innerText || "").length } };
})()`;

const SAVED_TAB_SCRIPT = `(() => {
  const url = location.href || "";
  const redirected = /jobs-tracker/i.test(url);
  const norm = (v) => String(v || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase();
  const tabs = [...document.querySelectorAll("button, a, [role='tab']")];
  const tab = tabs.find((el) => /salvos|saved jobs|vagas salvas/.test(norm(el.innerText || el.getAttribute("aria-label") || "")));
  let clicked = "";
  if (redirected && tab && tab.getAttribute("aria-selected") !== "true") {
    tab.click();
    clicked = norm(tab.innerText || tab.getAttribute("aria-label") || "").slice(0, 40);
  }
  return { redirected, clicked, url };
})()`;

const SAVED_JOBS_SCRIPT = `(() => {
  const anchors = [...document.querySelectorAll("a[href*='/jobs/view/']")];
  const items = [];
  const seen = new Set();
  for (const a of anchors) {
    const id = (a.href.match(/\\/jobs\\/view\\/(\\d+)/i) || [])[1];
    const url = a.href.split("?")[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const card = a.closest("li, article, [data-job-id], div");
    const title = (a.innerText || (card && card.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, 200);
    items.push({ extId: id, title: title || ("Vaga " + id), company: "", url, description: ((card && card.innerText) || title).replace(/\\s+/g, " ").trim().slice(0, 1500) });
  }
  return { items, diagnostics: { url: location.href, redirected: /jobs-tracker/i.test(location.href), jobLinks: anchors.length, itemCount: items.length, title: document.title } };
})()`;

function tabSalvos(html) {
  const buttons = [...String(html || "").matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
  for (const button of buttons) {
    const text = button[2].replace(/<[^>]+>/g, " ");
    if (!/salvos|saved jobs|vagas salvas/i.test(text)) continue;
    return { found: true, selected: /aria-selected=["']true["']/i.test(button[1]) };
  }
  return { found: false, selected: false };
}

function parseSavedJobsPage(html) {
  const raw = String(html || "");
  const redirected = /jobs-tracker/i.test(raw);
  const tab = tabSalvos(raw);
  const jobs = [];
  const seen = new Set();
  const re = /href=["'](https:\/\/[^"']*linkedin\.com\/jobs\/view\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match = re.exec(raw);
  while (match) {
    const id = match[2];
    if (!seen.has(id)) {
      seen.add(id);
      const title = match[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      jobs.push({
        extId: id,
        title: title || `Vaga ${id}`,
        company: "",
        url: match[1].split("?")[0],
        description: title,
      });
    }
    match = re.exec(raw);
  }
  return {
    redirected,
    needsTab: redirected && tab.found && !tab.selected,
    jobs: jobs.slice(0, 40),
  };
}

module.exports = {
  VISUAL_PLATFORMS,
  catalog,
  termsFor,
  JOB_LINK,
  canonicalJobUrl,
  itemsFromAnchors,
  CAPTURE_SCRIPT,
  SAVED_TAB_SCRIPT,
  SAVED_JOBS_SCRIPT,
  parseSavedJobsPage,
};
