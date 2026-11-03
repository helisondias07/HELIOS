# CHANGELOG (operações HELIOS)

Regra: **atualizar a cada leva.**

## R2 — 2026-11-02

- Modelos grátis: chefe/vagas = `nemotron-3-ultra-550b-a55b`; reservas minimax → lightning → glm → deepseek → kimi; Gemini; Cursor. Timeout 45 s. Sem duplicatas.
- Chefe chama o roteador gratis (fallback da cadeia); sem chave/falha → regras. Prompt sem CPF/telefone/endereço/e-mail.
- `jobs-host`: `planFillLlm` no fill de candidatura aprovada; dados pessoais só do cofre; para antes de enviar. `freeLlm` injetável; `main.js` com chaves do vault.
- Testes `test/levaR2.test.js`; backup `.backup-levaR2\`; docs `leva-r-modelos-gratis.md`
- Sem instalador, sem dist, sem tocar `%APPDATA%\HELIOS`

## Q3 — 2026-11-02

- Sessão única do navegador das vagas: `partitionFor` → sempre `persist:vagas` (legado em `legacyPartitionFor`)
- Migração única no boot (cookies + LS/IDB da 1ª pasta); marcador `vagas-sessao-unica.json`; pastas antigas ficam de backup
- `POST /api/vagas/abrir-login` aceita `{ url: "https://accounts.google.com/" }` (allowlist); demais URLs 400
- Testes `test/levaQ3.test.js`; backup `.backup-levaQ3\`; docs em `acessos.md`
- Sem instalador, sem tocar `%APPDATA%\HELIOS`

## Q — 2026-11-02

- Login automático em lote nas plataformas (Cofre › Plataformas): `POST/GET /api/vagas/login-todas`
- Main expõe `login` / `loginTodas` ao server (mesmo padrão de `runVagasAuto`); cofre e senha só no processo principal
- Modo silencioso no lote: sem abrir janela, sem notificar; só login (nada de inscrição/post)
- `reserva: true` tenta e-mail reserva só quando o principal falha por senha/e-mail (sem gravar no cofre)
- Resultado: `logado|pendente` + motivo (captcha, 2FA, Google, formulário, senha); nunca senha/cookies/token
- Testes `test/levaQ.test.js`; backup `.backup-levaQ\`; docs em `acessos.md` e `testes-e-instalacao.md`
- Sem instalador, sem túnel

## P3 — 2026-11-02

- Chefe estilo Grok Bot: sem painel direito de cartões de agentes; status = ponto na lateral (nome + 1 linha)
- Removidos card "Configure o ClickUp" e subtítulos ("O Chefe prioriza…"); aviso curto no chat quando faltar conector
- Painel de detalhes oculto por padrão (abre pelo botão do topo)
- Lateral enxuta: lista Agentes do Chefe; assistentes escondidos; tarefas autônomas só se houver
- Barra de uso fina sob o composer (% da conta Cursor ativa + "Renova em N dias", dourada, tooltip sem $/R$; sem "Uso: sem dados")
- OAuth MCP (Entrar com ClickUp/GitHub/Vercel) **desligado na UI** (`HELIOS_OAUTH_MCP_UI=1` para religar); Tokens manuais em Avançado seguem
- Prints `%TEMP%\helios-levaP3-shots`; backup `.backup-levaP3\`; testes `test/levaP3.test.js`
- **PENDENTE:** completar OAuth MCP real da Leva P; polir barra P2 (mais detalhes/pools) se precisar

## P — 2026-11-02

- Conectores MCP remoto oficiais com OAuth no navegador: **Entrar com ClickUp / GitHub / Vercel**
- Cliente genérico: discovery (RFC 9728/8414), DCR, PKCE S256, loopback efêmero, refresh + 401, cofre
- GitHub: Device Flow (sem secret); Client ID uma vez; PAT só em Avançado
- Vercel: DCR + fallbacks CLI logado / token em Avançado
- Oasis usa ClickUp MCP (API v2 compat); Portfólio: GitHub MCP + Vercel CLI/token com aprovação
- Discovery ao vivo (1× DCR): ClickUp **aceito**, Vercel **aceito** (sem login completo)
- Docs: `conectores-oauth.md`, `acessos.md`, `mcp.md`; testes `test/levaP.test.js` (9); mock OAuth+MCP
- Prints `%TEMP%\helios-levaP-shots`; backup `.backup-levaP\`
- Sem instalador, sem túnel

## O9 — 2026-11-02

- Polimento UI Chefe: dedupe do feed (de/tipo/assunto/período) + idempotência no quadro por `ref` (`idempotente: true`)
- Pesquisa: sem vagas → "Sem vagas lidas ainda" e **não** posta resultado vazio; textos curtos; 1 post/semana
- Painel direito: seção AGENTES oculta na tela do Chefe (cartões só no centro)
- Estado explícito "Chefe pausado" / "Chefe ativo"; cartões "Uso: sem dados" muted / "Uso 12%"
- Prints `%TEMP%\helios-levaO9-shots` (Chefe light/dark + Ajustes colapsado/Avançado)
- Revisão: sem $/R$ na tela principal; LinkedIn sem postar; CPF só no cofre; sem números inventados
- Testes: `test/levaO9.test.js` (6); porta prompt 48081+
- Sem instalador, sem túnel

## O8 — 2026-11-02

- MCP remoto finalizado: rate limit **vivo** (getter), allowlist mínima, log `mcp-remote-access.json` sem segredos, desligado por padrão
- `cloudflared` na máquina (`cloudflared version 2026.7.3`); **não** abriu túnel contra o HELIOS instalado
- `scripts/tunel.ps1` (quick tunnel + named documentado; `-Port` obrigatória; nunca imprime Bearer)
- Docs `tunel.md` / `mcp.md`: passos exatos + como o Grok Bot conecta (`URL /mcp` + `Authorization: Bearer <token-remoto>`)
- UI Conta: título “MCP remoto (túnel)” aponta para `tunel.md` + script
- Testes: `test/levaO8.test.js` (7); porta de ensaio 48061+ no prompt
- Sem instalador; túnel não deixado ligado

## O7 — 2026-11-02

- Observabilidade por agente (`usage.js`): tokens reais do SDK + `%` do uso da conta ativa atribuído a cada um dos 4 (nunca inventa; sem $ na tela)
- Limite diário de tokens por agente em Ajustes › Avançado › Atividade; ao atingir → pausa o agente + alerta no quadro (1×/dia)
- Resumo matinal do Chefe (`[chefe-resumo-matinal]`): o que cada agente fez, pendências e uso em %; API `/api/chefe/resumo-matinal` + `/api/chefe/observabilidade`
- Cartões do gabinete: `usoPct` = fatia da conta (tokens); sem dados → "sem dados"
- Testes: `test/levaO7.test.js` (7); porta de teste 48041+ no prompt (suite usa `port: 0`)
- Sem instalador, sem túnel

## O6 — 2026-11-02

- Agente Oasis (`server/agent-oasis.js`): lê tarefas atribuídas no ClickUp (token no cofre nome ClickUp ou conector); sem config → card pedindo configurar
- Propõe plano (estilo oasis-bot); executa no repo da tarefa (grava `.helios/oasis-plano.md`) só com aprovação; comenta/atualiza status no ClickUp só com segunda aprovação
- Isolado de emprego no quadro; NUNCA loga tokens
- API `/api/agente/oasis/*` + rotina `[oasis-ciclo]`; UI Chefe com card de config + aprovações Oasis
- `getVaultToken` no main para github/vercel/clickup
- Testes: `test/levaO6.test.js` (6); porta de teste 48021+ no prompt (suite usa `port: 0`)
- Sem instalador, sem túnel

## O5 — 2026-11-02

- Agente Portfólio (`server/agent-portfolio.js`): recebe lacuna do quadro, propõe 1 projeto pequeno, cria repo LOCAL em `Repositorios/portfolio-<slug>` com README + espaço de mockup
- GitHub/Vercel só após aprovação explícita; tokens só do cofre/CLI do usuário (nunca de outros apps; nunca logados)
- Ao concluir: resultado no quadro + evidência em `perfil.skills` (file:// local; URL remota se publicar)
- Subagentes curtos: planejar → codificar → revisar; rotina `[portfolio-ciclo]`
- API `/api/agente/portfolio/*` + `/api/routines/portfolio-ciclo`
- Testes: `test/levaO5.test.js` (6); porta de teste 48001+ no prompt (suite usa `port: 0`)
- Sem instalador, sem túnel

## O4 — 2026-11-02

- Agente Pesquisa (`server/agent-pesquisa.js`): agrega skills pedidas nas vagas por nível (júnior/pleno) com % só dos dados reais
- Fonte única `perfil.skills` com evidência (link) por skill; amostra pequena → aviso com n (nunca inventar %)
- Compara com vagas-helison **somente leitura**; gera lacunas e posta pedido ao Portfólio no quadro
- Rotina semanal (`[pesquisa-semanal]`) + API `/api/agente/pesquisa/*` e `/api/routines/pesquisa-semanal`
- Testes: `test/levaO4.test.js` + fixture `test/fixtures/pesquisa/vagas-amostra.json`
- Sem instalador, sem túnel; porta de teste 47981+ no prompt (suite usa `port: 0`)

## O3 — 2026-11-02

- Agente Vagas (`server/agent-vagas.js`): LinkedIn 2x/dia (feed, salvos, notificações, busca) + plataformas 1x/dia
- Horários aleatórios na janela 08–20h, gap mínimo, teto por hora, máx. 15 itens/varredura (sem massa)
- Sessão só na partição HELIOS `persist:vagas-linkedin`; NUNCA postar/comentar/reagir
- Inscrição começa em modo **aprovação**; automático bloqueado até 20 revisões manuais
- Filtro de compatibilidade (`vagas-match` + nota mínima); achados/resultados no quadro
- API `/api/agente/vagas/*` + ingestão HTML (fixtures/sessão); parsers + `jobs.ingestParsedJobs`
- Host: `vagas:salvos`, `vagas:notificacoes`, `vagas:busca-li`
- Testes: `test/levaO3.test.js` + fixtures `test/fixtures/linkedin/*` (sem rede)
- Sem instalador, sem túnel; porta de teste 47961+ no prompt (suite usa `port: 0`)

## O2 — 2026-11-02

- Tela principal: chat com o Chefe, cards de aprovação, painel com 4 cartões (Vagas, Pesquisa, Oasis, Portfólio)
- Uso por agente em % (ledger/usage real); sem dado → "sem dados"; nunca inventar
- Pausar/retomar por agente; aprovar/negar pendências do Chefe
- Ajustes: Conta/Aparência/Autonomia básicos; resto em **Avançado**
- Gabinete/parking/inbox fundidos no resumo do Chefe + quadro (API inbox mantida)
- Reunião/livecoding permanece fora da tela principal (rodapé)
- Testes: `test/levaO2.test.js`; prints em `%TEMP%\helios-levaO2-shots`
- Sem instalador, sem túnel

## O1 — 2026-11-02

- Quadro compartilhado SQLite (`server/quadro.js`, `quadro.sqlite`)
- Agente Chefe (`server/chefe.js`): ciclo, ordem, status, seed de papéis/missões
- Builtins: Chefe, Pesquisa, Oasis (além de Vagas/Portfólio)
- MCP: `helios_quadro_*`, `helios_chefe_*`, `helios_agente_status`
- MCP remoto preparado: token separado no cofre, allowlist, rate limit, desligado; UI “definido”/gerar/revogar/copiar
- Docs em `docs/operacao/` + HANDOFF
- Testes: `test/levaO1.test.js`
- Sem instalador, sem túnel

## N5 — 2026-10-31

Barra de uso aceita `%` sem `limitCents`; motivo curto sob “indisponível”.

## N4 / N4b — 2026-10-31

Card de uso estilo oasis; fix “Saiba mais” / tidy.

## N3 / N3b — 2026-10-31

Rótulo US$ pt-BR; fix label invisível.

## N2 — 2026-10-31

Uso real via API Cursor (exchange + period usage).

## N — 2026-10-31

Barra de uso por conta + limite manual + auto-troca opcional.

## M — 2026-10-31

Agente Vagas real (import, adapters, CPF cofre, e-mail).

## L — 2026-10-30

Navegador por tarefa, gatilhos, memória híbrida SQLite.

## K … B — 2026-10-30

Ver `historico.md` (skills, agentes SDK, Telegram, vagas, reunião, memória, Second Brain).

## B+C+D reinstalar — 2026-10-30

Setup `/S` com backup de AppData.

- Leva Q (fix 02/11 21:5x): plataformas do cofre com dom�nio .com.br colidiam em mergePlatforms (dom�nio 'com.br'); agora usa dom�nio registr�vel (baseDomain). Teste em test/levaQ.test.js. URLs de login de ProgramaThor, Nerdin, S�lides, Remotar, Revelo, Vagas.com, InfoJobs, Catho, Lovel e BairesDev gravadas no Cofre.

- Leva Q2 (02/11 22h): POST /api/vagas/abrir-login {plataformas:[...]} abre a janela de login visivel na sessao do HELIOS (sem preencher nada) e GET /api/vagas/sessoes lista as janelas e se ainda pedem senha. Protegidas pelo token da API.

- Leva Q4 (02/11 22h): popup 'Entrar com Google' nas janelas de vagas agora abre com action allow na mesma particao persist:vagas (mantem window.opener); permitidos accounts.google.com, apis.google.com, *.gstatic.com, *.googleusercontent.com e about:blank. Demais popups seguem negados (abrem na propria janela). Teste em test/levaQ.test.js.

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
