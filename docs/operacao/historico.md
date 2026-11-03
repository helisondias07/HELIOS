# Histórico das levas

Fonte: `Desktop\HELIOS-progresso-20261030.md` + pastas `.backup-leva*`. Datas em BRT.

## Q3 — 02/11/2026 (`.backup-levaQ3`)

Sessão única do navegador das vagas (`persist:vagas`): migração de cookies das partições antigas, `abrir-login` do Google allowlist, testes `test/levaQ3.test.js`. Sem instalador.

## Q — 02/11/2026 (`.backup-levaQ`)

Login automático em lote nas plataformas (`POST/GET /api/vagas/login-todas`): sequência silenciosa no main, opção `reserva`, progresso via GET. Sem senha/cookies no JSON. `test/levaQ.test.js`. Sem instalador.

## P — 02/11/2026 (`.backup-levaP`)

Conectores MCP remoto oficiais com OAuth no navegador (ClickUp DCR+PKCE, GitHub Device Flow, Vercel DCR/CLI/token). Oasis/Portfólio usam MCP com aprovação. Discovery ao vivo: DCR ClickUp e Vercel aceitos. `test/levaP.test.js` (9). Sem instalador.

## Antes das levas B+

Fases 0–3, redesign, modo reunião, Conta Cursor (3 contas), instância única, login navegador (corrigido).

## B — 30/10 (`.backup-levaB`)

Memória enxuta; Second Brain; rotinas com gatilho; Morning Brief + Monitor. Testes ~352.

## C — 30/10 (`.backup-levaC`)

Reunião: Encerrar e salvar; bot de vagas com cartão. ~360 testes.

## D — 30/10 (`.backup-levaD`)

Reserva de modelo; eval; CI por SHA; máscara de cartões; docs assinatura. ~366 testes.

### Reinstalação B+C+D (30/10 ~19:36)

Backup AppData `HELIOS-backup-reinstalar-20261030-193546`; `dist:win` + Setup `/S`; health 47331 OK.

## E — Telegram + vagas automático (`.backup-levaE`)

## F / G / H / I / J / K

Evolução de assistentes de fábrica, cofre async, reunião ajustes, agentes SDK (I), etc. Backups: `.backup-levaF` … `.backup-levaK`. Skills leva K.

## L — 30/10 (`.backup-levaL`)

Navegador por tarefa; gatilhos; corrigir rumo; memória híbrida SQLite. ~451 testes.

## M — 31/10 (`.backup-levaM`)

Agente Vagas real: import vagas-helison, adapters, CPF cofre, e-mail apply. Sem teto diário. ~465 testes.

## N — 31/10 (`.backup-levaN`)

Barra de uso por conta (limite manual + SDK). ~473 testes.

## N2 — 31/10 (`.backup-levaN2`)

Uso real Cursor API (exchange + GetCurrentPeriodUsage). ~479 testes.

## N3 / N3b — 31/10 (`.backup-levaN3`, `N3b`)

Rótulo pt-BR da barra; fix tidy que escondia label. ~484 / ~487 testes.

## N4 / N4b — 31/10 (`.backup-levaN4`, `N4b`)

Card de uso estilo oasis; remoção “Saiba mais” anônimo. ~495 / ~499 testes.

## N5 — 31/10 (`.backup-levaN5`)

Barra aceita `%` sem `limitCents`; motivo curto em falha. Contas login reais diagnosticadas. ~503 testes. Sem instalador.

### Instalações 30/10 e 31/10

- 30/10: reinstalar B+C+D (Setup `/S`, AppData backup).
- 31/10: levas M–N5 **sem** novo instalador (só código + testes mock); AppData de produção não tocado pelos testes.

## O1 — 02/11 (`.backup-levaO1`)

Quadro SQLite + Chefe + MCP remoto preparado + documentação `docs/operacao/`. Sem instalador, sem túnel.

## O2 — 02/11 (`.backup-levaO2`)

Interface clean: tela Chefe + 4 cartões + aprovações + uso % (sem inventar) + Ajustes › Avançado. ~515 testes. Sem instalador.

## O3 — 02/11 (`.backup-levaO3`)

Agente Vagas: LinkedIn 2x/dia + plataformas 1x/dia, horários aleatórios, teto/hora, aprovação nas primeiras 20, filtro, quadro, NUNCA postar. Fixtures HTML sem rede. ~522 testes. Sem instalador.

## O4 — 02/11 (`.backup-levaO4`)

Agente Pesquisa: skills júnior/pleno com % reais; `perfil.skills` + evidência; lacunas → pedido semanal ao Portfólio; vagas-helison só leitura. ~530 testes. Sem instalador.

## O5 — 02/11 (`.backup-levaO5`)

Agente Portfólio: lacuna do quadro → 1 projeto → repo local `portfolio-<slug>` (README + mockup) → aprovação antes de GitHub/Vercel → evidência em `perfil.skills`. ~536 testes. Sem instalador.

## O6 — 02/11 (`.backup-levaO6`)

Agente Oasis: ClickUp atribuídas → plano → execução no repo com aprovação → comentário/status ClickUp com aprovação; card se token/conector ausente; isolado de emprego. ~542 testes. Sem instalador.

## O7 — 02/11 (`.backup-levaO7`)

Observabilidade: tokens + % da conta por agente; limite diário (pausa + alerta no quadro); resumo matinal do Chefe; sem $ na tela. ~549 testes. Sem instalador.

## O8 — 02/11 (`.backup-levaO8`)

MCP remoto finalizado (rate limit vivo, allowlist, log sem segredos, off por padrão) + cloudflared + `scripts/tunel.ps1` + docs para Grok Bot. Túnel não ligado contra o instalado. ~556 testes. Sem instalador.

## O9 — 02/11 (`.backup-levaO9`)

Polimento UI Chefe: dedupe feed, idempotência por ref, textos curtos, sem postar vazio, AGENTES só no centro, estado ativo/pausado, uso muted, prints. ~562 testes. Sem instalador.
