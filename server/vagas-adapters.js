"use strict";

/**
 * LEVA M: adaptadores de plataformas com interface comum.
 * search / login / apply / detectCritical
 * Indeed, Glassdoor, Revelo, Coodesh e BossaBox entram pelo navegador real.
 */

const FEED_ONLY = new Set();
const REAL_BROWSER = new Set(["indeed", "glassdoor", "revelo", "coodesh", "bossabox", "infojobs", "programathor", "geekhunter", "nerdin", "catho", "trampos"]);

function baseAdapter(meta) {
  return {
    id: meta.id,
    label: meta.label,
    mode: meta.mode || "browser", // api | browser | feed
    loginUrl: meta.loginUrl || "",
    priority: meta.priority || 99,
    realTested: Boolean(meta.realTested),
    async search() { return { ok: false, jobs: [], note: "não implementado" }; },
    async login() { return { ok: false, note: "login pelo navegador/cofre" }; },
    async apply() { return { ok: false, critico: "apply não disponível neste adaptador" }; },
    detectCritical(page = {}) {
      return detectCriticalCommon(page);
    },
  };
}

function detectCriticalCommon(page = {}) {
  const text = String(page.text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const out = [];
  if (page.captcha) out.push({ tipo: "captcha", motivo: "O site mostrou captcha ou 2FA." });
  if (/(pagamento|cartao de credito|taxa de inscricao|pix|boleto|credit card|premium)/.test(text)) {
    out.push({ tipo: "pagamento", motivo: "A página pede pagamento." });
  }
  if (/(termo|politica de privacidade|privacy policy|li e concordo|aceito os termos)/.test(text) && page.termosNovos) {
    out.push({ tipo: "termos", motivo: "Termos legais novos para aceitar." });
  }
  if (/(anexe|upload|envie).{0,40}(diploma|comprovante|portfolio pdf|carta de recomendacao|documento extra)/.test(text)) {
    out.push({ tipo: "anexo_extra", motivo: "Pede anexo além do CV." });
  }
  if (/(question\s*\d+\s*of\s*\d+|tempo restante|timer|cronometro|minutos restantes|timed test|assessment timed)/.test(text)) {
    out.push({ tipo: "teste_tempo", motivo: "Teste com tempo — não ajudar durante a prova." });
  }
  if (/(raca|etnia|genero|sexo|orientacao sexual|race\/ethnicity|gender)/.test(text) && !page.hasPreferNotToSay) {
    out.push({ tipo: "raca_genero", motivo: "Pergunta de raça/gênero — perguntar ao usuário." });
  }
  if (/(dedicacao exclusiva|full[- ]time exclusive|sair do emprego atual|exclusividade)/.test(text)) {
    out.push({ tipo: "dedicacao_exclusiva", motivo: "Dedicação exclusiva — trade-off grande; perguntar." });
  }
  return out;
}

function createRemotarAdapter({ fetchImpl = globalThis.fetch, mock = false } = {}) {
  const a = baseAdapter({
    id: "remotar",
    label: "Remotar",
    mode: "api",
    loginUrl: "https://remotar.com.br/login",
    priority: 1,
    realTested: false,
  });
  a.search = async (term = "") => {
    if (mock) {
      return {
        ok: true,
        jobs: [{
          extId: "remotar-mock-1",
          title: `${term || "Frontend"} remoto`,
          company: "Remotar Demo",
          location: "Remoto",
          url: "https://remotar.com.br/job/mock-1",
          description: "React Next.js TypeScript remoto Brasil",
        }],
        note: "fixture/mock",
      };
    }
    try {
      const res = await fetchImpl("https://remotar.com.br/api/v1/jobs", {
        headers: { accept: "application/json", "user-agent": "HELIOS" },
      });
      // A API antiga responde 404. Isso não pode derrubar o ciclo: a busca visual cobre o site.
      if (!res || !res.ok) {
        return { ok: true, jobs: [], note: "api indisponível; busca visual", visual: true, http: res && res.status };
      }
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.jobs || data.data || []);
      const q = String(term || "").toLowerCase();
      const jobs = list.slice(0, 40).map((j) => ({
        extId: String(j.id || j.slug || j.url || ""),
        title: String(j.title || j.name || ""),
        company: String(j.company || j.company_name || ""),
        location: String(j.location || "Remoto"),
        url: String(j.url || j.link || ""),
        description: String(j.description || j.tags || "").slice(0, 1500),
      })).filter((j) => j.extId && j.url && (!q || `${j.title} ${j.description}`.toLowerCase().includes(q)));
      return { ok: true, jobs, note: "api pública" };
    } catch {
      return { ok: true, jobs: [], note: "api indisponível; busca visual", visual: true };
    }
  };
  return a;
}

function createGithubVagasAdapter({ fetchImpl = globalThis.fetch, mock = false, repo = "frontendbr/vagas" } = {}) {
  const id = repo.includes("backend") ? "github-backend-br" : "github-frontendbr";
  const a = baseAdapter({
    id,
    label: repo,
    mode: "api",
    loginUrl: "https://github.com/login",
    priority: 2,
    realTested: false,
  });
  a.search = async (term = "") => {
    if (mock) {
      return {
        ok: true,
        jobs: [{
          extId: `${id}-1`,
          title: `[Remoto] ${term || "Dev Front"}`,
          company: "GitHub Issues",
          location: "Remoto",
          url: `https://github.com/${repo}/issues/1`,
          description: "React TypeScript júnior pleno",
        }],
        note: "fixture/mock",
      };
    }
    try {
      const q = encodeURIComponent(`repo:${repo} is:open is:issue ${term || "remoto"}`);
      const res = await fetchImpl(`https://api.github.com/search/issues?q=${q}&per_page=30`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "HELIOS" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const jobs = (data.items || []).map((it) => ({
        extId: String(it.number),
        title: String(it.title || ""),
        company: repo,
        location: /remoto|remote/i.test(it.title) ? "Remoto" : "",
        url: String(it.html_url || ""),
        description: String(it.body || "").slice(0, 1500),
        postedAt: it.created_at || null,
      }));
      return { ok: true, jobs, note: "GitHub Issues API" };
    } catch (e) {
      return { ok: false, jobs: [], note: e.message };
    }
  };
  return a;
}

function createLinkedInEasyApplyAdapter({ mock = false } = {}) {
  const a = baseAdapter({
    id: "linkedin",
    label: "LinkedIn Easy Apply",
    mode: "browser",
    loginUrl: "https://www.linkedin.com/login",
    priority: 3,
    realTested: false,
  });
  a.search = async (term = "") => {
    if (mock) {
      return {
        ok: true,
        jobs: [{
          extId: "li-1",
          title: `${term || "Frontend"} pleno`,
          company: "Empresa LI",
          location: "Remoto",
          url: "https://www.linkedin.com/jobs/view/1",
          description: "React Easy Apply",
        }],
        note: "fixture/mock — real usa guest API + sessão",
      };
    }
    return { ok: false, jobs: [], note: "busca via jobs-host / sessão logada" };
  };
  a.apply = async () => ({ ok: false, note: "Easy Apply via navegador da tarefa (leva L)" });
  return a;
}

function createBrowserAdapter(meta) {
  const a = baseAdapter({ ...meta, mode: "browser", realTested: REAL_BROWSER.has(meta.id) });
  a.search = async () => ({ ok: false, jobs: [], note: "busca via navegador por tarefa + sites autorizados" });
  a.apply = async () => ({ ok: false, note: "preenchimento via jobs-fill + navegador" });
  return a;
}

function createAtsAdapter(meta) {
  const a = baseAdapter({ ...meta, mode: "browser", realTested: false });
  a.search = async () => ({ ok: false, jobs: [], note: "ATS por link da vaga" });
  a.apply = async () => ({ ok: false, note: "formulário ATS via navegador" });
  return a;
}

function createAdaptersRegistry(opts = {}) {
  const list = [
    createRemotarAdapter(opts),
    createGithubVagasAdapter({ ...opts, repo: "frontendbr/vagas" }),
    createGithubVagasAdapter({ ...opts, repo: "backend-br/vagas" }),
    createLinkedInEasyApplyAdapter(opts),
    createBrowserAdapter({ id: "geekhunter", label: "GeekHunter", loginUrl: "https://www.geekhunter.com.br/login", priority: 10 }),
    createBrowserAdapter({ id: "programathor", label: "ProgramaThor", loginUrl: "https://programathor.com.br/users/sign_in", priority: 11 }),
    createBrowserAdapter({ id: "nerdin", label: "Nerdin", loginUrl: "https://www.nerdin.com.br/login", priority: 12 }),
    createBrowserAdapter({ id: "solides", label: "Sólides", loginUrl: "https://login.solides.com.br/", priority: 13 }),
    createBrowserAdapter({ id: "vagas-com", label: "Vagas.com", loginUrl: "https://www.vagas.com.br/login", priority: 14 }),
    createBrowserAdapter({ id: "infojobs", label: "InfoJobs", loginUrl: "https://www.infojobs.com.br/candidate/login.aspx", priority: 15 }),
    createBrowserAdapter({ id: "catho", label: "Catho", loginUrl: "https://www.catho.com.br/signin/", priority: 16 }),
    createBrowserAdapter({ id: "trampos", label: "trampos", loginUrl: "https://trampos.co/login", priority: 17 }),
    createAtsAdapter({ id: "greenhouse", label: "Greenhouse", loginUrl: "https://boards.greenhouse.io/", priority: 20 }),
    createAtsAdapter({ id: "ashby", label: "Ashby", loginUrl: "https://jobs.ashbyhq.com/", priority: 21 }),
    createAtsAdapter({ id: "inhire", label: "InHire", loginUrl: "https://inhire.app/", priority: 22 }),
    createAtsAdapter({ id: "quickin", label: "Quickin", loginUrl: "https://app.quickin.io/", priority: 23 }),
    createBrowserAdapter({ id: "indeed", label: "Indeed", loginUrl: "https://secure.indeed.com/auth", priority: 30 }),
    createBrowserAdapter({ id: "glassdoor", label: "Glassdoor", loginUrl: "https://www.glassdoor.com.br/profile/login_input.htm", priority: 31 }),
    createBrowserAdapter({ id: "revelo", label: "Revelo", loginUrl: "https://app.revelo.com.br/login", priority: 32 }),
    createBrowserAdapter({ id: "coodesh", label: "Coodesh", loginUrl: "https://coodesh.com/login", priority: 33 }),
    createBrowserAdapter({ id: "bossabox", label: "BossaBox", loginUrl: "https://bossabox.com/", priority: 34 }),
  ].sort((a, b) => a.priority - b.priority);

  const byId = Object.fromEntries(list.map((a) => [a.id, a]));

  function status() {
    return list.map((a) => ({
      id: a.id,
      label: a.label,
      mode: a.mode,
      priority: a.priority,
      loginUrl: a.loginUrl,
      realTested: a.realTested,
      feedOnly: FEED_ONLY.has(a.id),
    }));
  }

  async function searchAll(term, { ids } = {}) {
    const selected = ids && ids.length ? list.filter((a) => ids.includes(a.id)) : list.filter((a) => a.mode === "api");
    const erros = [];
    const jobs = [];
    for (const a of selected) {
      try {
        const r = await a.search(term);
        if (!r || r.ok === false) erros.push(`${a.label}: ${(r && r.note) || "falhou"}`);
        for (const j of (r && r.jobs) || []) jobs.push({ ...j, platform: a.id });
      } catch (e) {
        erros.push(`${a.label}: ${e.message}`);
      }
    }
    return { ok: true, jobs, erros };
  }

  return { list, byId, status, searchAll, detectCriticalCommon, FEED_ONLY };
}

module.exports = {
  createAdaptersRegistry,
  detectCriticalCommon,
  FEED_ONLY,
  createRemotarAdapter,
  createGithubVagasAdapter,
  createLinkedInEasyApplyAdapter,
};
