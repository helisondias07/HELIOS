"use strict";
/* Tela "Contexto" (Fase 2): exportar, importar com prévia, fontes de leitura e pastas permitidas.
   Visual mínimo, com as classes que já existem. O redesenho virá depois, pelo HELIOS Design. */

(function () {
  const STATUS = { novo: "Novo", duplicado: "Duplicado (ignorado)", conflito: "Conflito (não importo)", recusado: "Recusado", informativo: "Só informativo" };
  const TIPO = { memoria: "Memória", contexto: "Contexto", assistente: "Assistente", rotina: "Rotina", conversa: "Conversa", conector: "Conector", preferencia: "Preferência" };
  const MAX_FILE = 1_000_000;
  const MAX_ROWS = 200;

  function create({ call, shell, esc, banner, helios, doc = document }) {
    const $ = (id) => doc.getElementById(id);
    const st = { pacote: null, preview: null, rename: false, browse: null, reading: null, note: "" };

    function previewHtml() {
      const p = st.preview;
      if (!p) return "";
      const by = p.resumo.porStatus || {};
      const chips = Object.keys(STATUS).map((key) => `<span class="muted">${esc(STATUS[key])}: <strong>${by[key] || 0}</strong></span>`).join(" · ");
      const rows = p.itens.slice(0, MAX_ROWS).map((item) => `
        <div class="status-line"><div><strong>${esc(TIPO[item.tipo] || item.tipo)}</strong> · ${esc(item.rotulo)}<div class="muted">${esc(item.dono)}${item.motivo ? " · " + esc(item.motivo) : ""}</div></div><span class="muted" data-status="${esc(item.status)}">${esc(STATUS[item.status] || item.status)}</span></div>`).join("");
      const hasConflict = (by.conflito || 0) > 0;
      const novos = by.novo || 0;
      return `
        <div class="card stack" id="ctxPreview" style="margin-top:12px"><h2>Prévia da importação</h2>
          <p class="muted">Nada foi gravado ainda. Só o que está como “Novo” será acrescentado; o que você já tem não muda nem some. ${chips}</p>
          ${(p.avisos || []).map((a) => `<p class="muted">${esc(a)}</p>`).join("")}
          ${hasConflict ? `<label class="row"><input type="checkbox" id="ctxRename" style="width:auto"${st.rename ? " checked" : ""}> Importar assistentes em conflito com outro nome (“… (importado)”)</label>` : ""}
          <div>${rows || `<div class="empty">Nada para mostrar.</div>`}</div>
          ${p.itens.length > MAX_ROWS ? `<p class="muted">Mostrando os primeiros ${MAX_ROWS} de ${p.itens.length}.</p>` : ""}
          <div class="row"><button type="button" class="btn primary" id="ctxApply"${novos ? "" : " disabled"}>Confirmar e importar ${novos} item(ns)</button><button type="button" class="btn" id="ctxCancel">Cancelar</button></div>
        </div>`;
    }

    function sourcesHtml(data) {
      if (!data.fontes.length) return `<div class="empty">Nenhum conector de ClickUp ou e-mail em “Conectores”. Cadastre um e confirme para ler daqui. Só leitura: nada é enviado.</div>`;
      return data.fontes.map((src) => {
        const options = src.ferramentasDeLeitura.map((tool) => `<option value="${esc(tool.nome)}">${esc(tool.nome)}</option>`).join("");
        return `
        <div class="status-line"><div class="stack" style="flex:1">
          <div><strong>${esc(src.fonte)}</strong> · ${esc(src.servidor)} <span class="muted">(${esc(src.status)}${src.confirmado ? "" : ", não confirmado"})</span></div>
          ${options ? `<div class="row"><select data-src-tool="${esc(src.servidor)}">${options}</select></div>
            <textarea data-src-args="${esc(src.servidor)}" placeholder='Argumentos em JSON, se a ferramenta pedir. Ex.: {"query": "tarefas da semana"}'></textarea>
            <div><button type="button" class="btn" data-src-read="${esc(src.servidor)}">Ler (somente leitura) e ver prévia</button></div>`
    : `<div class="muted">Sem ferramenta de leitura testada. Teste o conector em “Conectores”.</div>`}
        </div></div>`;
      }).join("");
    }

    function foldersHtml(data) {
      const rows = data.pastas.map((folder) => `
        <div class="status-line"><div><strong>${esc(folder.nome)}</strong><div class="muted">${esc(folder.caminho)}</div></div>
          <div class="row"><button type="button" class="btn" data-folder-open="${esc(folder.id)}">Ver arquivos</button><button type="button" class="btn danger" data-folder-remove="${esc(folder.id)}">Tirar da lista</button></div></div>`).join("");
      return `${rows || `<div class="empty">Nenhuma pasta permitida. O HELIOS não mexe em pasta nenhuma do seu PC até você escolher.</div>`}`;
    }

    function browseHtml() {
      const b = st.browse;
      if (!b) return "";
      const rows = b.itens.map((item) => {
        const rel = b.rel ? `${b.rel}/${item.nome}` : item.nome;
        const open = item.tipo === "pasta" ? `<button type="button" class="btn" data-browse-dir="${esc(rel)}">Abrir</button>` : item.tipo === "arquivo" ? `<button type="button" class="btn" data-browse-read="${esc(rel)}">Ler</button>` : "";
        const trash = item.tipo === "atalho" ? "" : `<button type="button" class="btn danger" data-browse-trash="${esc(rel)}">Mover para a Lixeira</button>`;
        return `<div class="status-line"><div><strong>${esc(item.nome)}</strong> <span class="muted">${esc(item.tipo)}${item.tamanho === null || item.tamanho === undefined ? "" : " · " + esc(item.tamanho) + " bytes"}</span></div><div class="row">${open}${trash}</div></div>`;
      }).join("");
      return `
        <div class="card stack" id="ctxBrowse" style="margin-top:12px"><h2>${esc(b.nome)} / ${esc(b.rel)}</h2>
          <div class="row"><button type="button" class="btn" id="ctxUp"${b.rel ? "" : " disabled"}>Subir</button><button type="button" class="btn" id="ctxBrowseClose">Fechar</button></div>
          <div>${rows || `<div class="empty">Pasta vazia.</div>`}</div>
          ${b.text !== undefined ? `<h2>${esc(b.textName)}</h2>${b.masked ? `<p class="muted">Havia algo parecido com segredo; foi mascarado.</p>` : ""}<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(b.text)}</pre>` : ""}
          <p class="muted">Apagar sempre vai para a Lixeira do sistema; dá para restaurar por lá.</p>
        </div>`;
    }

    function pendingHtml(items) {
      if (!items.length) return "";
      return `<div class="card stack" style="margin-top:12px"><h2>Conectores para configurar</h2><p class="muted">Vieram de um pacote importado. O HELIOS não instala nem executa nada: cadastre cada um em “Conectores”, com as suas credenciais.</p>
        ${items.map((item) => `<div class="status-line"><div><strong>${esc(item.nome)}</strong> <span class="muted">${esc(item.tipo)}${item.variaveis && item.variaveis.length ? " · variáveis: " + esc(item.variaveis.join(", ")) : ""}</span></div></div>`).join("")}</div>`;
    }

    async function load() {
      const [folders, sources, pending] = await Promise.all([call("GET", "/api/pastas"), call("GET", "/api/pacote/fontes"), call("GET", "/api/pacote/conectores")]);
      shell(`
        <div class="stack">
          <div class="card stack"><h2>Exportar contexto</h2>
            <p class="muted">Gera um arquivo .json com memória, contexto, assistentes, rotinas, conectores (só os nomes, sem senhas ou tokens) e conversas resumidas. O cofre nunca entra. Qualquer coisa com cara de segredo é mascarada e avisada.</p>
            <label class="row"><input type="checkbox" id="ctxConvs" checked style="width:auto"> Incluir conversas resumidas</label>
            <div class="row"><button type="button" class="btn primary" id="ctxExport">Exportar contexto</button></div>
            <div id="ctxExportOut" class="muted">${esc(st.note)}</div>
          </div>
          <div class="card stack"><h2>Importar contexto</h2>
            <p class="muted">Escolha um pacote .json. Você vê uma prévia antes. Importar só acrescenta: nada seu é sobrescrito ou apagado, duplicados são ignorados e segredos são recusados. Rotinas entram pausadas e autonomia não é importada.</p>
            <input type="file" id="ctxFile" accept=".json,application/json">
          </div>
          <div id="ctxPreviewSlot">${previewHtml()}</div>
          <div class="card stack"><h2>Ler de ClickUp ou e-mail (somente leitura)</h2>
            <p class="muted">Usa os conectores que você já cadastrou. Só ferramentas de leitura rodam; nada é enviado ou alterado. O resultado vira uma prévia, como qualquer importação.</p>
            ${sourcesHtml(sources)}
          </div>
          <div class="card stack"><h2>Pastas permitidas do PC</h2>
            <p class="muted">O HELIOS só lê e grava dentro das pastas que você escolher aqui. Atalhos que levam para fora são recusados. Apagar manda para a Lixeira.</p>
            ${foldersHtml(folders)}
            <div class="row"><button type="button" class="btn primary" id="ctxAddFolder"${folders.seletor ? "" : " disabled"}>Adicionar pasta…</button>${folders.lixeira ? "" : `<span class="muted">Lixeira indisponível neste modo: apagar fica desligado.</span>`}</div>
          </div>
          ${browseHtml()}
          ${pendingHtml(pending.conectores)}
        </div>`);
      bind();
    }

    async function showPreview(pacote, rename = false) {
      st.pacote = pacote;
      st.rename = rename;
      st.preview = await call("POST", "/api/pacote/importar/previa", { pacote, renomearConflitos: rename });
      await load();
      const slot = $("ctxPreview");
      if (slot && slot.scrollIntoView) slot.scrollIntoView({ block: "nearest" });
    }

    function guard(fn) {
      return async (...args) => {
        try { await fn(...args); } catch (err) { banner(err.message); }
      };
    }

    async function openFolder(id, rel = "", extra = {}) {
      const folders = await call("GET", "/api/pastas");
      const folder = folders.pastas.find((item) => item.id === id);
      const data = await call("GET", `/api/pastas/${encodeURIComponent(id)}/arquivos?caminho=${encodeURIComponent(rel)}`);
      st.browse = { id, nome: folder ? folder.nome : "pasta", rel: data.caminho, itens: data.itens, ...extra };
      await load();
    }

    function bind() {
      $("ctxExport").onclick = guard(async () => {
        const out = await call("POST", "/api/pacote/exportar", { conversas: $("ctxConvs").checked });
        const text = JSON.stringify(out.pacote, null, 2);
        const saved = await helios.contextSave(out.nomeArquivo, text);
        const r = out.resumo;
        const lines = [`${r.memoria} memória(s), ${r.contexto} item(ns) de contexto, ${r.assistentes} assistente(s), ${r.rotinas} rotina(s), ${r.conectores} conector(es), ${r.conversas} conversa(s).`, ...out.avisos];
        if (saved && saved.ok) lines.unshift(`Salvo em ${saved.caminho}.`);
        else if (saved && saved.cancelado) lines.unshift("Exportação cancelada: nada foi salvo.");
        else lines.unshift(`Não consegui salvar: ${(saved && saved.error) || "erro"}`);
        st.note = lines.join(" ");
        $("ctxExportOut").textContent = st.note;
      });
      $("ctxFile").onchange = guard(async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        if (file.size > MAX_FILE) throw new Error("O arquivo é grande demais para um pacote (limite de 1 MB).");
        let pacote;
        try { pacote = JSON.parse(await file.text()); } catch { throw new Error("O arquivo não é um JSON válido."); }
        await showPreview(pacote, false);
      });
      if ($("ctxRename")) $("ctxRename").onchange = guard(async () => { await showPreview(st.pacote, $("ctxRename").checked); });
      if ($("ctxCancel")) $("ctxCancel").onclick = guard(async () => { st.preview = null; st.pacote = null; st.rename = false; await load(); });
      if ($("ctxApply")) {
        $("ctxApply").onclick = guard(async () => {
          const out = await call("POST", "/api/pacote/importar/aplicar", { previaId: st.preview.previaId, confirmar: true });
          st.preview = null;
          st.pacote = null;
          st.rename = false;
          const r = out.resultado;
          st.note = `${r.mensagem}${r.falhas.length ? ` Falhas: ${r.falhas.map((f) => f.rotulo + " (" + f.erro + ")").join("; ")}.` : ""}`;
          await load();
          banner(st.note);
        });
      }
      doc.querySelectorAll("[data-src-read]").forEach((button) => {
        button.onclick = guard(async () => {
          const name = button.dataset.srcRead;
          const tool = doc.querySelector(`[data-src-tool="${CSS.escape(name)}"]`).value;
          const raw = doc.querySelector(`[data-src-args="${CSS.escape(name)}"]`).value.trim();
          let argumentos = {};
          if (raw) { try { argumentos = JSON.parse(raw); } catch { throw new Error("Os argumentos precisam ser um JSON válido."); } }
          button.disabled = true;
          try {
            const out = await call("POST", "/api/pacote/fontes/ler", { servidor: name, ferramenta: tool, argumentos });
            await showPreview(out.pacote, false);
            banner(out.aviso);
          } finally { button.disabled = false; }
        });
      });
      if ($("ctxAddFolder")) {
        $("ctxAddFolder").onclick = guard(async () => {
          const out = await call("POST", "/api/pastas/escolher", {});
          await load();
          banner(out.cancelado ? "Nenhuma pasta escolhida." : `Pasta “${out.pasta.nome}” adicionada.`);
        });
      }
      doc.querySelectorAll("[data-folder-open]").forEach((button) => { button.onclick = guard(async () => { await openFolder(button.dataset.folderOpen, ""); }); });
      doc.querySelectorAll("[data-folder-remove]").forEach((button) => {
        button.onclick = guard(async () => {
          if (!window.confirm("Tirar esta pasta da lista? Os arquivos dela não são mexidos.")) return;
          await call("DELETE", `/api/pastas/${encodeURIComponent(button.dataset.folderRemove)}`);
          if (st.browse && st.browse.id === button.dataset.folderRemove) st.browse = null;
          await load();
        });
      });
      if ($("ctxBrowseClose")) $("ctxBrowseClose").onclick = () => { st.browse = null; load().catch((err) => banner(err.message)); };
      if ($("ctxUp")) $("ctxUp").onclick = guard(async () => { await openFolder(st.browse.id, st.browse.rel.split("/").slice(0, -1).join("/")); });
      doc.querySelectorAll("[data-browse-dir]").forEach((button) => { button.onclick = guard(async () => { await openFolder(st.browse.id, button.dataset.browseDir); }); });
      doc.querySelectorAll("[data-browse-read]").forEach((button) => {
        button.onclick = guard(async () => {
          const rel = button.dataset.browseRead;
          const out = await call("GET", `/api/pastas/${encodeURIComponent(st.browse.id)}/arquivo?caminho=${encodeURIComponent(rel)}`);
          await openFolder(st.browse.id, st.browse.rel, { text: out.texto, textName: rel, masked: out.mascarado });
        });
      });
      doc.querySelectorAll("[data-browse-trash]").forEach((button) => {
        button.onclick = guard(async () => {
          const rel = button.dataset.browseTrash;
          if (!window.confirm(`Mover “${rel}” para a Lixeira?`)) return;
          const out = await call("POST", `/api/pastas/${encodeURIComponent(st.browse.id)}/lixeira`, { caminho: rel });
          await openFolder(st.browse.id, st.browse.rel);
          banner(out.mensagem);
        });
      });
    }

    return { load };
  }

  window.HeliosContexto = { create };
})();