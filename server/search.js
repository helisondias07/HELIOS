"use strict";

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeUrl(url) {
  const raw = String(url || "").replace(/&amp;/g, "&");
  try {
    const parsed = new URL(raw, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return uddg;
  } catch {
    /* segue o endereço como veio */
  }
  return raw;
}

/** Extrai até 5 resultados do HTML do DuckDuckGo. */
function parseDdg(html) {
  const results = [];
  const re = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const url = decodeUrl(match[1]);
    const title = stripTags(match[2]);
    const after = html.slice(match.index, match.index + 6000);
    const snippetMatch = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|span|div)>/i);
    const snippet = stripTags(snippetMatch ? snippetMatch[1] : "");
    if (!title || !/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, snippet });
    if (results.length >= 5) break;
  }
  return results;
}

function formatResults(query, results) {
  if (!results.length) return `Não encontrei resultados para “${query}”.`;
  return results.map((item, i) => `${i + 1}. ${item.title}\n${item.url}\n${item.snippet || ""}`.trim()).join("\n\n");
}

async function searchWeb(query, { fetchImpl = globalThis.fetch } = {}) {
  const q = String(query || "").trim().slice(0, 200);
  if (!q) return { query: q, results: [], error: "Escreva o que você quer pesquisar." };
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": "HELIOS/0.1 (assistente pessoal)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { query: q, results: [], error: `A busca respondeu HTTP ${res.status}.` };
    const html = await res.text();
    if (!String(html || "").trim()) return { query: q, results: [], error: "A busca devolveu uma página vazia." };
    const results = parseDdg(html);
    return { query: q, results, error: results.length ? "" : "A busca não devolveu fontes desta vez." };
  } catch {
    return { query: q, results: [], error: "Não consegui consultar a web agora." };
  }
}

module.exports = { parseDdg, searchWeb, formatResults, stripTags };
