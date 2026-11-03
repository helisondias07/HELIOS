# HANDOFF — prompt para colar num bot novo (Grok Bot / Cursor em outra conta)

Cole o bloco abaixo como primeira mensagem. Não omita as regras de porta/AppData.

---

Você retoma o **HELIOS**, assistente Electron local do Helison.

## Contexto

- Repo: `C:\Users\HelisonDias\Repositorios\HELIOS` (Windows, PowerShell).
- Dono: Helison. Design: `design/DESIGN.md` + `AGENTS.md` (tema claro principal).
- Última leva feita: **R2** (modelos grátis ultra + Chefe LLM + planFillLlm no fill). Backup: `.backup-levaR2\`. Antes: R (free-llm), Q6/Q5 (cookies/Gupy), Q3 (sessão única).
- Leva **P** (conectores MCP OAuth) ficou **incompleta** — UI OAuth desligada (`HELIOS_OAUTH_MCP_UI`); tokens manuais em Avançado.
- Progresso: `C:\Users\HelisonDias\Desktop\HELIOS-progresso-20261030.md`
- Docs: `docs\operacao\` (leia `estado-atual.md`, `acessos.md`, `conectores-oauth.md`, `mcp.md`, `proximos-passos.md`, `regras.md`).

## Hierarquia

Grok Bot (presidente, via MCP remoto quando o túnel estiver ligado) → Chefe (vice no HELIOS) → Vagas, Pesquisa, Oasis, Portfólio. Comunicação pelo **quadro** SQLite. Sem esteira.

## Máquina / regras duras

- Nunca porta **47331** em teste; nunca `%APPDATA%\HELIOS`; nunca o app instalado.
- Testes: `HELIOS_MOCK=1`, userData próprio, `HELIOS_TEST_OFFSCREEN=1`, portas 47921+ / 48101+ (P) / 48161+ (P3) / 48221+ (Q), uma instância, `taskkill` só no PID do teste.
- Sem `electron -e`. Sem gerar instalador sem aval.
- CPF só no cofre. LinkedIn **nunca postar**. Nunca inventar números. Nunca logar segredos. Uso na tela só em % (nunca $).
- Backup `.backup-levaX\<yyyyMMdd-HHmmss>` antes de mudar.
- `npm test` + `npm run lint` passando; criar `test/levaX.test.js`.

## Como trabalhar

1. Ler `docs/operacao/estado-atual.md` e o prompt da leva em `%USERPROFILE%\leva*.md` se existir.
2. Preferir o agent CLI / Cursor no repo local; commits só se o Helison pedir.
3. Atualizar `docs/operacao/CHANGELOG.md`, `historico.md`, progresso no Desktop e `%TEMP%\levaX-report.md`.

## Próxima leva (PENDENTE)

1. **Completar conectores MCP OAuth da Leva P** (ClickUp/GitHub Device Flow/Vercel) e ligar `HELIOS_OAUTH_MCP_UI=1` na UI.
2. Polir barra de uso P2 (pools/tooltip) se a P3 mínima não bastar.
3. Túnel + MCP remoto em produção **só com aval**.
4. (Opcional) UI para disparar `/api/vagas/login-todas` e ver pendências do lote Q.

## Conectores (estado P3)

- Ajustes › Conectores: OAuth MCP **pausado**; use **Tokens manuais** em Avançado (ClickUp / GitHub / Vercel).
- Backend OAuth (discovery/DCR/PKCE/device) permanece no código, atrás da flag.
- Docs: `conectores-oauth.md`.

## Vagas — login em lote (Q) + sessão única (Q3)

- `POST /api/vagas/login-todas` `{ reserva?, plataformas? }` → `{ iniciado: true }` (background).
- `GET /api/vagas/login-todas` → progresso/`resultados` (`logado|pendente`, email principal/reserva, motivo).
- Silencioso: sem janela/aviso; senha só no main (`jobs-host`); nunca no JSON.
- Partição compartilhada **`persist:vagas`** (um Google login vale para todas). Migração no boot; marcador `vagas-sessao-unica.json`.
- `POST /api/vagas/abrir-login` `{ url:"https://accounts.google.com/" }` ou `{ plataforma }` / `{ plataformas }`.

## MCP remoto (túnel do HELIOS)

1. HELIOS ligado; token remoto **definido** (UI Conta); checkbox **Ligar MCP remoto**.
2. `.\scripts\tunel.ps1 -Port <porta>` (quick) ou `-Named` (hostname estável).
3. No Grok Bot: URL `https://<host>/mcp` + header `Authorization: Bearer <token-remoto>` (nunca imprimir o valor).
4. Allowlist: quadro + chefe + status. Ver `mcp.md` e `tunel.md`.

---

Fim do prompt de handoff.

- Leva Q2: janelas de login das plataformas pendentes abrem por POST /api/vagas/abrir-login; o Helison entra manualmente; GET /api/vagas/sessoes confere. Pendentes em 02/11: LinkedIn, Indeed, Nerdin, InfoJobs (captcha), Gupy, Quickin, GitHub vagas, Lovel (senha), Vagas.com (tempo).
- Leva Q3: sessão única `persist:vagas`; migração de cookies; abrir `accounts.google.com` na mesma partição.

- Leva Q4: login com Google das plataformas usa popup OAuth na sessao persist:vagas (isOAuthPopupUrl em src/jobs-host.js).

## Leva Q5 (2026-11-02) - cookies da persist:vagas salvos em disco
- Novo src/vagas-cookies.js: flushStore + flushStorageData ao esconder/fechar janela de vagas, no before-quit (ate 3 s) e a cada 60 s.
- Cookies de sessao dos dominios das plataformas viram persistentes (30 dias).
- Teste: test/levaQ5.test.js. Backup: .backup-levaQ5.
- Operacao: parar o app primeiro sem /F; /F so se nao fechar.

## Leva Q6 (2026-11-02) - Gupy desconectando; rotas de diagnostico e saida
- GET /api/vagas/diagnostico?dominio=X: nomes/dominios/validade de cookies da persist:vagas e chaves (nao valores) de localStorage/sessionStorage das janelas abertas; UA.
- POST /api/app/sair: fecha o HELIOS normalmente (before-quit faz flush dos cookies). Usar nos reinstalls no lugar de taskkill /F.
- UA da persist:vagas sem Electron/ e HELIOS/.
- abrir-login nao recarrega a tela de login se a janela ja esta no site (evita derrubar sessao recem-feita).
- Teste: test/levaQ6.test.js. Backup: .backup-levaQ6.
- Q6 (correcao Gupy): na persist:vagas nao havia cookie nem token de login da Gupy, so analytics, socialProvider, last_candidate_auth_subdomain (4 h) e candidate_redirect_url. Suspeita: a conversao a cada 60 s (Q5) fazia get->set e podia regravar um token ja rotacionado. Agora a conversao acontece no evento cookies 'changed' (valor mais novo; remocoes respeitadas). O timer so faz flushStore/flushStorageData, e o before-quit converte o restante (final:true).
- NAO reinstalado (fica junto com a Leva R).

## Estado 02/11/2026 ~23:30 (BRT) - teste ao vivo modelos gratis

- Build R2+Q6 instalado; app aberto (1 instancia); chave NVIDIA e Gemini salvas no cofre; temporarios da chave apagados.
- /api/llm-gratis/status: 8 modelos disponiveis; chefe/vagas/pesquisa = nemotron-3-ultra-550b-a55b; Cursor nao e passado (so gratis).
- Chamada minima (/api/vagas/match, vaga ficticia): 200 em 13,5 s, resposta do modelo valida. A resposta nao informa QUAL modelo atendeu (pendente: expor model id/latencia/429 no retorno).
- POST /api/app/sair: OK (fechou em <6 s); app reaberto; janela Gupy aberta via abrir-login {plataforma:"gupy"}.
- Rodada unica (nada enviado):
  - /api/agente/vagas/ciclo: 4 varreduras LinkedIn puladas (sem_html_nem_runner) MAS o slot 09:40 de 03/11 foi marcado feito (bug: nao marcar quando pulado).
  - /api/vagas/buscar: 5 novas, 0 erros, todas Gupy (1,2 s). Outras plataformas: 0 novas.
  - Triagem: 5 com score 90-100 (pre-filtro por palavras-chave, sem LLM). 15 antigas descartadas.
  - Preparadas: 5 (10-47 ms cada = sem LLM, template com placeholders), na fila de aprovacao. modo=aprovacao, faltam 20 revisoes.
  - 429: nenhum visto. Erros: nenhum retornado.
- Pendencias: (1) matchScore recebeu perfil sem skills ("Habilidades nao informadas") -> preencher perfil.skills; (2) LLM nao usado na triagem/preparo da rodada; (3) ciclo sem runner LinkedIn no servidor; (4) bug do slot marcado feito; (5) retorno com modelo usado.

## Decisoes do Helison
- (t143u) Inscricoes ficarao 100% com HELIOS + Chefe, sem aprovacao dele, SO depois que o teste dos modelos gratis passar (ainda nao passou por completo: LLM nao participou da triagem/preparo).
- Ideias AI Hero para depois: fluxo Vagas fixo (deterministico), testes de qualidade com Evalite, arquivo de handoff do Chefe.

## Leva S - 02/11/2026 ~23:50 (BRT) - estado e PASSO A PASSO para continuar

Feito (backup .backup-levaS\20261102-233204; dados HELIOS-backup-reinstalar-20261102-233451; 610 pass/0 fail; lint ok; instalado):
- Skills do perfil: 41 extraidas do CV+portfolio pelo nemotron-3-ultra (13,3 s), sem CPF/telefone/endereco/email no prompt. Salvas em prefs.perfil.skills.
- free-llm.vagasScorer: skills objeto -> nome; devolve `modelo`.
- agent-vagas: slot so vira "feito" se alguma varredura rodou de verdade (bug corrigido); triagem do ciclo usa scorer gratis.
- Rota POST /api/vagas/triagem-llm: nota com modelo gratis (vaga+skills). Rota POST /api/vagas/leva-s/enviar {autorizado:true, ids:[...], porHora}: liga automatico so durante a rodada e devolve ao modo anterior.
- main.js: vagasRunner (LinkedIn so leitura via scanLinkedInKind, persist:vagas) e runAutoVagas. Feed rola 25x (~2 min).
- runAuto registra via/modelo (llm|rules) por vaga.

Resultado da rodada real (sem Cursor):
- Gupy: 5 vagas. Triagem LLM: 55, 85, 82, 84, 66 (11-24 s cada; total 91 s). Todas >= notaMinima 40.
- LinkedIn: busca leu 10 (0 novas, ja vistas). feed/salvos/notificacoes FALHARAM: "Este site so entra pelo Google." (ensureLinkedInSession acha que precisa login).
- Plataformas (buscar): 0 novas.
- Envio (autorizado pelo Helison): 0 enviadas. 3 criticas (vaga_6baea8d990, vaga_1515d08181, vaga_86b4e8bff9): "O login nao confirmou (senha errada ou passo extra)" - login(gupy) do cofre falhou mesmo com sessao manual. 2 nao processadas (limite/hora): vaga_d3acab47ba, vaga_f1fc3cf8e9 (status nova).
- 429: nenhum.

Pendencias (ordem):
1. runAuto: antes de login(platform), testar se a sessao persist:vagas ja esta logada (Gupy entra pelo Google) e so logar se nao estiver. Em jobs-host.js runAuto (bloco `if (!mock && !loggedIn.has(...))`).
2. ensureLinkedInSession: falso "so entra pelo Google" no feed/salvos/notificacoes (busca funciona). Conferir deteccao em jobs-host.js.
3. triagem-llm: gravar a nota (chamar save do jobs; hoje so muda em memoria e se perde ao reiniciar) e o `modelo` vem null (matchScore descarta o campo) -> propagar.
4. Revoltar as 3 criticas para "nova" e rodar de novo: POST /api/vagas/leva-s/enviar {"autorizado":true,"porHora":5,"ids":[...5 ids...]}.
5. Rodar o ciclo LinkedIn: POST /api/agente/vagas/ciclo {"forcar":true}.
Como chamar a API local: script electron com vault.apiToken() (ver historico: helios-api.js, apagar depois; nunca imprimir token). Testes: HELIOS_MOCK=1 HELIOS_TEST_OFFSCREEN=1 npm test - NUNCA abrir o app com HELIOS_MOCK no ambiente (ele grava dados demo no userData real; aconteceu e foi restaurado do backup).

## Leva S2 - 02/11/2026 23:52 (BRT) - estado e como continuar (outro editor / modelos gratis)

Codigo pronto NO REPO (testes 610/0, lint ok; backup .backup-levaS2\20261102-234901), build gerado em release\ mas NAO instalado ainda (instalacao interrompida). App pode estar FECHADO: abrir %LOCALAPPDATA%\Programs\HELIOS\HELIOS.exe (nunca com HELIOS_MOCK no ambiente).
- jobs.setTriagem grava nota+modelo em disco; triagem-llm devolve `modelo`.
- jobs-host.sessaoAtiva(plataforma): Gupy (candidate_secure_token/candidate_logged_in) e LinkedIn (li_at). runAuto pula login do cofre se a sessao ja existe. ensureLinkedInSession devolve erro claro se nao houver li_at.
- leva-s/enviar tambem reabre vagas "critica".
- Diagnostico: LinkedIn em persist:vagas NAO tem cookie li_at = deslogado de verdade (busca publica funciona; feed/salvos/notificacoes exigem login). Helison precisa entrar no LinkedIn pela janela do HELIOS.

Pendencias (t147u):
(a) Senha da Gupy no cofre: vault.savePlatform({nome:"Gupy", url:"https://login.gupy.io/candidates/signin", usuario:<email>, senha:<lida de arquivo temp>}) via script electron (createVault com await); apagar o temp; nunca imprimir.
(b) Leitura do LinkedIn em janela oculta separada: em jobs-host scanFeed/scanLinkedInKind usar getWin("linkedin-leitura") (mesma particao persist:vagas) em vez de getWin("linkedin"), que e a janela visivel de login.
(c) Modo automatico (decisao t143u/t145u): em server/agent-vagas.js trocar `revisoesNecessarias: REVISOES_INICIAIS` por `Number.isFinite(saved.revisoesNecessarias) ? saved.revisoesNecessarias : REVISOES_INICIAIS`; gravar revisoesNecessarias 0 no estado do agente e jobs prefs modo "automatico"; limpar cartoes "Aprovar inscricao" pendentes do quadro do Chefe.
(d) Sidebar: clicar Vagas/Pesquisa/Oasis/Portfolio pisca e volta ao Chefe. Ver renderer/agents.js e chefe.js (window.heliosSetMode / HeliosChefe.open sendo chamado depois do setView; provavel polling do Chefe reabrindo a view).
Depois: instalar (POST /api/app/sair, release\HELIOS-Setup-0.1.0.exe /S), POST /api/vagas/triagem-llm, POST /api/vagas/leva-s/enviar {"autorizado":true,"porHora":5,"ids":["vaga_1515d08181","vaga_6baea8d990","vaga_d3acab47ba","vaga_f1fc3cf8e9","vaga_86b4e8bff9"]}, depois POST /api/agente/vagas/ciclo {"forcar":true}.

Como continuar com outro editor usando NVIDIA NIM (gratis):
- Base URL: https://integrate.api.nvidia.com/v1 (API compativel OpenAI, rota /chat/completions).
- Modelo: nvidia/nemotron-3-ultra-550b-a55b (reservas: nvidia/nemotron-3.5-lightning-30b-a3b, minimaxai/minimax-m3.1-flash).
- Chave: a sua chave NVIDIA (build.nvidia.com), configurada no editor como "OpenAI compatible"; NUNCA colar em arquivo do repo.
- Regras: backup antes; HELIOS_MOCK=1 HELIOS_TEST_OFFSCREEN=1 npm test e npm run lint devem passar; nao rodar o app em mock; seguir design/DESIGN.md.

## Proxima leva: Chefe com poderes completos (decisao t150u)

Objetivo: o Chefe do HELIOS faz tudo o que o Grok Bot faz, nativo no HELIOS, so com modelos gratis (NIM https://integrate.api.nvidia.com/v1, nvidia/nemotron-3-ultra-550b-a55b + reservas da cadeia em server/free-llm.js). SEM app de terceiros (nada de Aider, OpenCode, Cline).
Base: o laco de ferramentas runAgent() de server/free-llm.js (tool calls OpenAI-compat, maxSteps, chamadas registradas).

Seguranca (vale para todas as etapas): trabalhar em branch git propria; backup antes de alterar; testes (HELIOS_MOCK=1 HELIOS_TEST_OFFSCREEN=1 npm test + lint) antes de reinstalar; lista de pastas permitidas (allowlist em config, ex. Repositorios\HELIOS e o que o Helison liberar); confirmacao no chat para acoes destrutivas (apagar, git push/reset, instalar, enviar); scrubPii em todo prompt (sem CPF/telefone/endereco/senhas/tokens).

Etapas e criterios de teste:
1. Ferramentas de arquivo (ler, listar, buscar, editar por trecho, criar) restritas a allowlist.
   Teste: fora da allowlist recusa; edicao por trecho inexistente falha sem alterar; backup criado; teste unitario com pasta temp.
2. Shell (npm, git, testes) com saida visivel no chat (stream), timeout, allowlist de comandos e laco de correcao (roda teste -> le erro -> corrige -> roda de novo, max N voltas).
   Teste: comando fora da lista pede confirmacao; timeout mata processo; laco corrige um teste quebrado de exemplo em <= N voltas.
3. Navegador do HELIOS (janela oculta persist:vagas ou particao propria): abrir URL, ler texto, clicar/preencher com confirmacao; pesquisa web (busca + leitura de pagina).
   Teste: le pagina fixture; nunca posta/comenta no LinkedIn (assertNuncaPostar); pesquisa devolve fontes com link.
4. Memoria, rotinas, delegacao aos 4 agentes (Vagas, Pesquisa, Oasis, Portfolio) e relatorios; conectores ClickUp, GitHub e Vercel (tokens no cofre, nunca no prompt).
   Teste: memoria persiste entre reinicios; rotina agendada roda em mock; delegacao gera cartao no quadro e volta resultado; conector com token ausente da erro claro.
5. UI: painel do Chefe mostra plano, ferramentas chamadas, saida do shell, pedidos de confirmacao e relatorio final (seguir design/DESIGN.md).
   Teste: renderer mostra stream; botao confirmar/negar funciona; sidebar abre o agente clicado (bug (d)).

## Estado 03/11/2026 00:00 (BRT) - fim da leva S2
- INSTALADO: sessaoAtiva (Gupy/LinkedIn), setTriagem em disco, leitura LinkedIn em janela oculta "linkedin-leitura" (b), revisoesNecessarias configuravel = 0 e modo automatico (c), recentlyApplied nao conta mais "auto_iniciada". Senha Gupy salva no cofre (a). 610/0 testes.
- Envio Gupy (autorizado): login OK pela sessao; 3 vagas abriram o formulario e pararam: "Nao achei o proximo botao do formulario com seguranca" (6baea8d990, 1515d08181, 86b4e8bff9). 0 enviadas. As 2 da Quality Digital (d3acab47ba, f1fc3cf8e9) nao entraram na fila (verificar recentlyApplied por empresa/avoided).
- PENDENTE: (1) fill.clickScript("next"/"submit") nao reconhece botoes da Gupy (ver rotulos: "Continuar", "Salvar e continuar", "Candidatar-se", "Enviar candidatura") em src/fill*.js; (2) via/model null nos criticos: devolver plan.via/model tambem no critico; (3) (d) sidebar nao corrigida - ver renderer/agents.js/chefe.js; (4) limpar cartoes "Aprovar inscricao" antigos do quadro; (5) LinkedIn: Helison precisa logar (sem li_at), depois POST /api/agente/vagas/ciclo {"forcar":true}.

## Leva V — operação contínua e modelos grátis (03/11/2026)
- Corrigido o executor de botões: labels modernos, atributos semânticos de Gupy, elementos em `shadowRoot` e fallback seguro para submit dentro de formulário/modal visível.
- `autoResult` agora persiste `via`, `modelo`, `estado` e `evidencia` nos resultados e nos casos críticos.
- Em produção, Chefe/Vagas/Pesquisa usam somente o worker de modelos grátis; se não houver chave válida, o app informa indisponibilidade em vez de trocar silenciosamente para Cursor.
- Instalações novas iniciam Chefe e Vagas ativos e criam a rotina persistente `Vagas: operação contínua` a cada 30 minutos. Pausas salvas pelo Helison não são sobrescritas.
- O prompt marcado `[vagas-scan-30]` agora chama o ciclo real do agente e, depois, o processamento automático da fila.
- Validação: 624 testes, 623 pass, 0 fail, 1 skip; lint e `npm run check` verdes.

## Leva S3 (03/11 00:0x BRT)
- Passo 1a: jobs-fill.clickScript: botoes fixos/sticky eram ignorados (offsetParent null) -> usa getClientRects; aceita [role=button] e aria-disabled; next inclui 'salvar e continuar', 'proxima', 'continuar candidatura' etc. Backup .backup-levaS3\20261103-000221.
- Passo 1b: Quality Digital fora da fila e CORRETO: candidaturas enviadas para a empresa em 23 e 24/10 (regra repetirDias=30).
- Passo 2: sidebar (renderer/chefe.js agentLine) tinha data-lf-go="chefe" fixo para todos os agentes. Agora Vagas->tela vagas, Pesquisa->tela search; Oasis/Portfolio (sem tela propria) abrem o Chefe e rolam ate o cartao. Pendente: tela propria para Oasis/Portfolio.
- Passo 3: agent-vagas cancela no boot os cartoes abertos 'Aprovar inscricao' quando ja pode automatico, e nao cria mais cartao em prepararInscricao no automatico. Testes 610/0, lint ok.

## Leva U — Chefe operacional e limpeza (03/11/2026)

- `server/agent-runtime.js` passou a expor aos agentes do runtime pesquisa web, memória do assistente e MCP com allowlist e classificação de risco. Ferramentas de escrita, exclusão e conectores com efeito respeitam Autonomia/cartão; ferramentas MCP desconhecidas falham fechadas.
- `server/index.js` injeta os conectores, a pesquisa web e a memória por assistente no runtime. O worker grátis continua sendo escolhido quando existe um modelo disponível; Cursor segue como fallback configurável.
- `server/free-llm.js` para imediatamente quando uma ferramenta devolve pendência humana, evitando que o modelo prossiga e repita uma ação.
- `src/jobs-host.js` e `server/jobs-application.js` registram evidência e estado da candidatura; o automático usa o caminho de envio, e o preenchimento aprovado continua parando antes da submissão para revisão.
- UI do Chefe foi simplificada para comando por resultado, com atalhos de código/pesquisa/vagas e a Caixa de entrada renomeada para Decisões.
- A limpeza foi reversível: baseline, snapshots e `.env` estão fora do repositório em `C:\Users\HelisonDias\Repositorios\HELIOS-archive\`. O backup de handoff antigo também foi movido para `obsolete-docs-20261103-010000`.
- Validações desta leva: testes direcionados, lint e `npm run check` verdes. A validação final completa e a reinstalação devem ser feitas depois de todas as alterações.

## Leva V3 — busca contínua sem loop de aprovação (03/11/2026)

- O `0/20` mostrado no Chefe era histórico: os registros eram alertas `Aprovar inscrição` já cancelados no quadro, mas o feed os renderizava. O feed agora filtra `status: cancelado`.
- Retornos `resultado` e `achado` dos agentes agora são marcados como `feito` pelo ciclo do Chefe e não voltam para a fila como novos pedidos.
- A rotina `Vagas: operação contínua` passa `completa:true` para o agente Vagas, então continua fazendo busca depois de os slots diários terem sido consumidos. O teto por hora continua valendo.
- O modo esperado é automático (`modo: automatico`, `revisoesNecessarias: 0`, `pausado:false`). O Chefe só pede intervenção em bloqueios críticos.
- Bloqueios observados: CAPTCHA, ausência de botão/campo seguro em formulários Gupy/LinkedIn, sessão/login e regra `repetirDias:30`. Sem evidência de confirmação do site, o HELIOS não conta a inscrição como enviada.
- Verificação: `npm test` 627/626/0/1 (testes/pass/falhas/skip), `npm run lint` verde e `npm run check` verde. O instalador foi gerado e reinstalado em `C:\Program Files\HELIOS\HELIOS.exe`.
- O disparo auxiliar por `HELIOS_FORCE_VAGAS` não produziu relatório novo nesta sessão; o JSON antigo continua inválido e não comprova uma rodada. Não declarar inscrições sem evidência persistida do site.
- Snapshot persistido após a reinstalação: modo automático e agente não pausado; fila com 2 novas, 6 críticas e 2 falhas. As críticas são predominantemente formulário sem botão/campo seguro e uma ocorrência de CAPTCHA; as falhas pedem conferência no site antes de repetir.

## Leva V4 — orquestração monitorada (03/11/2026)

- A rodada real pode ser iniciada pela instância principal com `--force-vagas`; o relatório sanitizado grava checkpoints de início, busca, fila, monitoramento e final.
- `src/jobs-host.js` não deixa mais `loadURL` pendurar o ciclo: cada carregamento tem timeout de 30 segundos e informa o motivo.
- `server/jobs.js` e `/api/vagas/auto/fila` agora explicam por que uma vaga nova não entrou no automático.
- Rodada v6: as quatro fontes de leitura do LinkedIn concluíram com 0 novas; plataformas concluíram com `Remotar: HTTP 404`; duas vagas Quality Digital foram bloqueadas por candidatura recente; 0 inscrições confirmadas.
- CAPTCHA permanece handoff humano obrigatório. O HELIOS pode detectar, pausar aquele site e continuar os demais, mas não deve resolver/burlar CAPTCHA.
- Relatório: `work\force-vagas-report-v6-run.json`.

## Atualização imediata — rodada manual de Vagas (03/11/2026)

- Criada a opção `completa:true` no ciclo do agente Vagas: LinkedIn em modo somente leitura (`feed`, `salvos`, `notificacoes`, `busca`) + plataformas agregadas, mesmo quando os slots normais já foram consumidos.
- Criado disparo controlado pelo processo principal com `HELIOS_FORCE_VAGAS=1`; o relatório sai em `HELIOS_FORCE_VAGAS_REPORT` e não expõe token.
- Validação: `node --test test/levaO3.test.js` (10/10), `npm run lint`, `npm run check` e `npm run dist:win` verdes. Instalador gerado e reinstalado em `C:\Users\HelisonDias\AppData\Local\Programs\HELIOS`.
- A execução real ainda não foi confirmada: o relatório precisa estar com `ok:true`. A tentativa auxiliar anterior falhou porque o cofre DPAPI só deve ser acessado pelo processo principal do app. CAPTCHA, 2FA e qualquer parada crítica continuam exigindo evidência/ação conforme o executor.
- Próximo passo: ler o relatório válido e devolver as contagens por plataforma ao Helison; caso não exista, repetir a rodada pelo app instalado.

## Leva V5 — navegação visual real de vagas e ciclo monitorado (03/11/2026)

- Causa do falso erro `Vaga não encontrada.`: `src/jobs-host.js` chamava `GET /api/vagas/prefs`, rota que não existia; a rota genérica interpretava `prefs` como ID de vaga. Corrigido para ler `/api/vagas`.
- A busca de plataformas agora abre LinkedIn/Gupy no navegador persistente, tenta localizar o campo de busca, preenche, clica/pressiona Enter, rola a página, captura cards/links e envia apenas a captura para a ingestão local. O servidor não faz a descoberta por API externa nesse caminho.
- LinkedIn agora cobre feed, publicações salvas, vagas salvas, notificações e busca. Feed/publicações salvas também reconhecem links diretos de vagas. A página de vagas salvas da conta redirecionou para `jobs-tracker` e retornou zero links; isso está registrado como diagnóstico.
- Criada a rota `/api/vagas/ingest-browser`, com parser, deduplicação e pontuação pelo perfil. O filtro literal do termo foi removido para não descartar `front end` versus `front-end`.
- A fila automática usa login silencioso com timeout de 45 s e ainda tenta 2FA por e-mail. CAPTCHA, login Google e timeout viram bloqueio da vaga, e o executor segue a fila.
- Rodada v8 (`work\force-vagas-report-browser-v8.json`): 11 novas vagas por navegação visual, sendo 5 LinkedIn e 6 Gupy; 0 erros de coleta e 0 inscrições confirmadas.
- Rodada v9 (`work\force-vagas-report-browser-v9.json`): 0 novas por deduplicação, 0 inscrições confirmadas, 1 bloqueio novo por botão de formulário não reconhecido, 4 vagas na fila e fechamento `ok:true`.
- Validação final: `npm test` 627/626/0/1, `npm run lint` verde, `npm run check` verde e `npm run dist:win` verde. Instalador `release\HELIOS-Setup-0.1.0.exe` reinstalado em `C:\Program Files\HELIOS\HELIOS.exe` antes da v9.
- Depois da v9, os seletores do campo de busca foram ampliados para reconhecer `Pesquisar`, `competência`, `vaga` e `oportunidade`; o instalador foi gerado/reinstalado novamente e a suíte completa foi repetida: 627 testes, 626 pass, 0 fail, 1 skip.
- Pendências: melhorar reconhecimento dos formulários atuais, investigar a navegação da área `jobs-tracker` e manter CAPTCHA como handoff humano obrigatório. Não declarar candidatura enviada sem estado `enviada` e evidência do site.

## Plano V6 — concluir inscrições operacionais sem falsos envios (03/11/2026)

- Descoberta visual está validada para LinkedIn/Gupy: navegador persistente, feed, publicações salvas, notificações, buscas por palavras-chave, rolagem e captura dos cards. A v8 capturou 5 vagas LinkedIn e 6 Gupy. A busca geral no Google ainda é extensão planejada, não funcionalidade validada do ciclo atual.
- A inscrição ainda falha em botões/etapas dinâmicas, labels indiretos, comboboxes, máscaras, modais, iframes e formulários React/Angular. O próximo passo é criar `form-navigator` com máquina de estados e recaptura do DOM após cada ação.
- O resolvedor de campos deve pontuar label, `for`, `aria-*`, `name`, `id`, `autocomplete`, placeholder, texto próximo, tipo e contexto; deve atravessar `shadowRoot`/iframes permitidos e reconhecer input, textarea, select, combobox, radio e checkbox.
- O resolvedor de ações deve reconhecer `Continuar`, `Próximo`, `Salvar e continuar`, `Candidatar-se`, `Enviar candidatura` e `Finalizar`, exigindo visibilidade, habilitação, formulário/modal correto e score mínimo antes do clique.
- Depois de preencher, validar erros, obrigatórios, mudança de etapa/URL e confirmação visual. Se não houver avanço seguro, gerar crítica com diagnóstico sanitizado; nunca clicar indefinidamente.
- Separar estratégias de Gupy, LinkedIn/ATS externo e plataformas adicionais sobre a mesma máquina de estados. Erro 404 de um adaptador permanece isolado da navegação visual.
- Preservar privacidade: modelo grátis sugere mapeamento apenas por rótulos; dados pessoais continuam vindo do cofre/perfil local. 2FA por e-mail pode ser preenchido via MCP; CAPTCHA nunca deve ser burlado e exige handoff humano.
- Adicionar idempotência, estados e evidência por etapa. Só `enviada` com confirmação inequívoca do site; timeout, botão ausente, fechamento e erro ficam `critica`/`falhou`.
- Criar fixtures para Henry Schein, Stefanini, BairesDev, abler, VAAS e Click Interativo, cobrindo botão ausente, CAPTCHA, campos faltantes e confirmação. Depois executar uma rodada real pequena e monitorada, sem repetir críticas antigas.
- Critério de conclusão: fixtures verdes + rodada real controlada com separação correta de `enviada`, `critica`, `falhou`, `captcha` e `duplicada/bloqueada` por plataforma.

## Leva V6 — formulário, regras e plataformas (03/11/2026)

### Por que nenhuma candidatura confirmou

O executor lia o DOM uma vez e só aceitava rótulos longos (`salvar e continuar`, `enviar candidatura`). Na Gupy o avanço costuma ser só `Continuar`, muitas vezes sem texto útil e com `data-testid`. O LinkedIn Easy Apply e o ATS aberto a partir dele (Greenhouse e semelhantes) usam modal, iframe ou shadow. O clique em si era tratado como progresso; sem a frase do site, o certo é não contar `enviada`. A API antiga do Remotar responde HTTP 404 e esse erro aparecia no ciclo. `/my-items/saved-jobs/` redireciona para `/jobs-tracker/`; a captura antiga não lia essa tela.

### O que mudou

- `server/form-navigator.js`: a cada etapa recaptura URL, texto, campos e botões (inclui shadowRoot e iframe da mesma origem). O campo casa label, `aria-*`, nome, autocomplete e texto próximo. O botão precisa estar visível, habilitado e com score mínimo dentro do formulário ou do modal. CAPTCHA, dois avanços empatados, erro de validação ou botão que não muda a página pausam aquela vaga. `enviada` só com confirmação positiva (`candidatura enviada`, `thank you for applying` e equivalentes). O HELIOS não resolve CAPTCHA e não clica em mensagem, InMail ou conectar.
- `src/jobs-host.js` usa esse navegador no envio. O modo de aprovação preenche e para antes do botão de enviar. App fechado no meio do envio continua virando `falhou` na próxima abertura, para conferir no site — nunca vira `enviada` sozinho.
- Remotar: HTTP 404 não entra como falha do ciclo; a vaga dessa fonte sai da busca visual. Um adaptador que lança erro fica isolado.
- Busca visual, um site por vez: LinkedIn, Gupy, InfoJobs, Indeed BR, Glassdoor, Catho, Coodesh, GeekHunter, ProgramaThor, trampos.co, Nerdin, BossaBox e Remotar. A URL de busca é só o ponto de partida; o campo da página manda. Falha de um site não corta os outros.
- Vagas salvas: se a conta cair em `jobs-tracker`, o HELIOS aciona a aba Salvos e lê os links `/jobs/view/`.
- Regras do dono em `server/vagas-regras.js`, aplicadas na fila: só remoto; só júnior/pleno; frente, fullstack, Node, React, Next, TypeScript ou IA; fora Angular, Java, .NET e PHP como stack principal; pula vídeo/Loom, teste com tempo, vaga exclusiva PcD ou afirmativa, inglês fluente obrigatório, diploma completo obrigatório e Docker/Kubernetes/AWS obrigatório. Empresas evitadas com comparação flexível: Quality Digital, Micro1/Micro Um, BairesDev, NeoWork, Workana, Strider, Lovel. Pretensão respondida no formulário: R$ 3.500 júnior e R$ 8.000 pleno. Nenhuma mensagem automática a recrutador.
- Importação de candidaturas já feitas (`fonte: importado`, status `enviada`) para o `repetirDias` enxergar a empresa e o id do LinkedIn. Fixture e script: `test/fixtures/candidaturas-importadas.json` e `scripts/importar-candidaturas.js`. A rota `POST /api/vagas/historico/importar` só grava com `confirmar: true`.

### Validação desta leva

Fixtures cobrem Gupy (Continuar do modal, select customizado, salário de pleno), Easy Apply até a frase de envio, ATS externo, pausa em CAPTCHA, pausa quando há dois botões iguais, e recusa de `enviada` quando o site devolve erro depois do clique. Nesta sessão: `npm test` 639 testes, 638 pass, 0 fail, 1 skip; `npm run lint` verde; `npm run check` com `HELIOS ok`. Não houve rodada no Windows do Helison.

### O que ainda precisa da máquina do Helison

- Rodada controlada, poucas vagas, na instância principal (não num Electron auxiliar). O relatório só vale com `ok: true` e cada `enviada` com a frase guardada em `confirmacao`.
- Conferir no site as críticas e falhas antigas antes de repetir. CAPTCHA continua manual: a janela abre e o ciclo segue nas outras.
- Entrar de novo onde a sessão cair (LinkedIn `li_at`, Gupy, e os sites novos). As URLs de busca de InfoJobs, Indeed, Glassdoor, Catho, Coodesh, GeekHunter, ProgramaThor, trampos.co, Nerdin, BossaBox e Remotar são ponto de partida; a página real pode ter mudado o campo.
- O script de importação grava no diretório de dados passado na linha de comando. Sem essa pasta, ele só conta as linhas e não escreve nada. Não colocar senha, CPF ou token em código, fixture ou log.

## Por que o HELIOS não age como um agente de navegador (rodada real v10)

Um agente de navegador tira uma foto da tela, decide o próximo clique ou o que digitar, executa e fotografa de novo. Ele não precisa conhecer o site. O HELIOS, até a v10, fazia outra coisa: lia o HTML com regras fixas (`via: rules`, `modelo: null`) e desistia se o texto do botão não estivesse na lista. Isso explica a rodada de cerca de cinco minutos que terminou com `fetch failed` e candidaturas em cerca de dois segundos, sem evidência.

A partir desta correção o envio real passa por `runApplication` (o mesmo ponto que `jobs-host` usa). As regras do DOM continuam primeiro. Se não houver botão seguro, a página (texto acessível e, no app, a foto) vai para a cadeia de modelos grátis já existente, no papel `visao` e depois `extracao`. O modelo devolve a próxima ação. Nome, e-mail, telefone e CPF não entram no prompt: só placeholders, trocados no código. A resposta do modelo não marca `enviada`. Só a frase do site marca.

O que ainda não é um agente de tela cheia: iframe de outro domínio não é lido; a foto pode falhar se o modelo de visão recusar a imagem; o HELIOS não resolve CAPTCHA. Esses casos param para o dono ou viram falha técnica com URL, etapa e botões visíveis.

### Cada falha da v10, a causa e o conserto

| O que apareceu | Causa | Conserto | Teste |
|---|---|---|---|
| Relatório `ok: false`, `fetch failed`, sem checkpoint de fila, cerca de 5 min depois de `busca_completa` | O `POST /ciclo` segurava a busca visual inteira. O cliente HTTP desiste por volta de 5 min sem cabeçalho de resposta. O checkpoint era gravado antes da busca, não durante. | A busca completa volta na hora (`background: true`) e o app consulta `/api/agente/vagas/andamento`, com retry se a rede local piscar. | `levaV6 live: a busca completa devolve na hora` |
| Toda candidatura em ~2 s: "Não achei o próximo botão", `via: rules`, evidência vazia | O navegador novo estava no caminho, mas lia a página uma vez, logo após o load, e saía sem anotar os botões. Página de anúncio, login ou React ainda vazio caía na mesma frase. | Espera a página assentar, grava URL e botões em toda parada e, sem botão conhecido, pede a ação ao modelo. | `levaV6 live: o mesmo runApplication` e `sem botão conhecido a visão clica` |
| Indeed salvo como `https://br.indeed.com/pagead/clk` | O coletor guardava o link do anúncio, não a vaga. | `jk=` vira `viewjob`; rastreador sem `jk` é descartado. | `Nome * usa o perfil e o anúncio do Indeed` |
| Glassdoor / ATS externo | A listagem pede login ou um "Candidatar-se" que abre outro site. Sem botão de candidatura visível, era a mesma falha de botão. | Login vira espera humana. Botão de candidatura segue o clique; o formulário seguinte usa o mesmo laço, com visão se o rótulo for estranho. | `captcha e login param para o dono` e o fluxo de visão |
| Quality Digital e BairesDev continuavam `nova` | A regra só valia na hora de gravar a vaga nova. A fila antiga não era revista. | Cada ciclo e cada abertura da lista refiltra `nova` e tira da espera as críticas que são falha técnica. | `a fila antiga perde Quality Digital e BairesDev` |
| "Esperando sua resposta: 24" | Todo `critico`, inclusive botão e rede, virava caso para o dono. | CAPTCHA, login e pergunta sem resposta continuam "precisa de você". Botão, rede e falta de confirmação viram `falhou`. | o mesmo teste da fila e o resumo |
| Click Interativo: "Falta Nome *" | O rótulo vinha com asterisco e não casava com `nome`. | O asterisco sai antes de comparar. "Nome *" usa o nome do perfil. | `Nome * usa o perfil` |
| Gupy `ERR_NAME_NOT_RESOLVED` ou `ERR_ABORTED` | A página não abriu (DNS ou navegação interrompida) e o erro entrava no mesmo saco do formulário. | Uma nova tentativa e, se persistir, falha técnica de rede, com o código no resultado. | `captcha e login param para o dono; rede é falha técnica` |

Ainda falta uma rodada curta no Windows, na instância principal, para ver se a visão acerta os botões reais da Gupy, do Indeed e do Glassdoor. Sem a frase do site no resultado, não há candidatura enviada.

## Painel de 03/11 14:56 — captcha falso, carta e feed

O que o painel mostrou e o que o código passa a fazer:

- Os três "casos críticos" de captcha (VAAS Florianópolis, outro Frontend do LinkedIn e Indeed BBChain) vinham do selo do rodapé ou de um iframe pequeno. Captcha só para com desafio visível: frase de checkbox/puzzle, widget medido (não o selo) ou o script da página. Com modelo, a visão precisa concordar; se ela manda preencher ou continuar, a vaga segue. Um aviso antigo de captcha sem essa frase volta uma vez para a fila. Híbrido ou Florianópolis em caso crítico é descartado, sem nova tentativa.
- No Indeed, "Adicionar documentos de apoio" pede a carta. O HELIOS escreve a carta a partir do perfil e clica em Continuar. O rodapé "protegido pelo reCAPTCHA" não pausa.
- "Vagas encontradas" não tem "Preparar inscrição". Nota na mínima fica na fila e o automático se inscreve.
- Post do feed com nota na mínima e remoto vira candidatura (link de vaga ou o próprio post) ou e-mail com CV, quando o texto tem um endereço e nenhum link de inscrição. Híbrido não entra.
- O envio do e-mail usa o Gmail conectado. Se a conta só tem leitura, a vaga fica como falha técnica com o motivo, sem carta de aprovação. A chave não entra no corpo.

O que esta sessão não prova: uma `enviada` real no Windows. Iframe de outro domínio continua ilegível. A conta Gmail precisa do escopo de envio para o CV sair de verdade.

## Rodada v12 — o botão sumia porque o menu entrava no retrato

As 34 falhas com "Não achei o próximo botão do formulário com segurança" vinham do snapshot da página inteira. No Indeed os primeiros botões eram "Página inicial", "Avaliações de Empresas", "Cargos e salários" e "Mensagens". O `Candidatar-se` ficava de fora da decisão, e o laço parava em 1 a 10 segundos. No `/form/questions-module` o mesmo menu escondia as perguntas e o Continuar.

- O menu, o cabeçalho e o rodapé são marcados e ignorados. O formulário, o modal e o botão Candidatar-se / Easy Apply entram primeiro. O laço espera o botão de candidatura aparecer, em vez de parar no primeiro link do site.
- Perguntas conhecidas (nome, anos que estão no perfil, autorização de trabalho, remoto, carta, pretensão) são preenchidas. O que o perfil não tem não é inventado e, depois dos campos conhecidos, vira caso para o dono. Em seguida o HELIOS clica Continuar ou Enviar até a frase do site.
- Glassdoor em "Security | Glassdoor" para como login, com a URL na nota. BairesDev no título, na descrição ou no link é empresa evitada mesmo com `company` vazio.
- InfoJobs abre a busca por palavra-chave, não a página de ranking. ProgramaThor abre `/jobs/`. BossaBox abre o quadro público, não o `app.bossabox.com/vagas` que responde 404.
- A nota de `falhou` leva motivo, URL e quantos botões de menu foram ignorados, e aparece no registro. A mesma vaga com falha de botão ganha no máximo uma nova tentativa depois desta correção.
- Perfil padrão: Bom Jardim, RJ; pretensão R$ 3.500 júnior e R$ 8.000 pleno; LinkedIn com `https://`.
- A barra da direita e o botão Pausar saem do Chefe. Avisos de ClickUp e GitHub não entram no chat.

