# Estado atual (pós-Q3, 02/11/2026)

## Pronto

- Quadro compartilhado (`quadro.sqlite`, API, MCP) com postagem **idempotente por `ref`**
- Chefe interno (seed, ciclo pausável, ordem, status, pausa por agente, aprovações)
- Interface clean: tela Chefe + 4 cartões + uso % (sem inventar) + Ajustes › Avançado
- **O9 polimento:** feed deduplicado; estado "Chefe pausado/ativo"; AGENTES só no centro; textos curtos; sem postar vazio
- **Agente Vagas (O3):** rotinas LinkedIn 2x/dia + plataformas 1x/dia; aprovação 20; filtro; quadro; NUNCA postar
- **Leva Q:** login em lote `POST/GET /api/vagas/login-todas` (silencioso + reserva; senha só no main)
- **Leva Q3:** partição única `persist:vagas` + migração de sessões + `abrir-login` do Google
- **Agente Pesquisa (O4/O9):** skills por nível com % reais; lacunas → Portfólio; sem vagas → "Sem vagas lidas ainda"
- **Agente Portfólio (O5/P):** lacuna → repo local → aprovação; GitHub MCP + Vercel CLI/token
- **Agente Oasis (O6/P):** ClickUp MCP (API compat) → plano → execução/comentário com aprovação
- **Observabilidade (O7):** tokens + % por agente; limite diário; resumo matinal; sem $ na tela
- **MCP remoto + túnel (O8):** token separado, allowlist, rate limit, desligado por padrão; `scripts/tunel.ps1`
- **Leva P:** Entrar com ClickUp/GitHub/Vercel (OAuth MCP); Device Flow GH; DCR vivo aceito CU+Vercel
- Builtins: Chefe, Vagas, Pesquisa, Oasis, Portfólio (+ Lojas Wake)
- Documentação em `docs/operacao/` (+ `conectores-oauth.md`)
- Testes `test/levaO1.test.js` … `test/levaO9.test.js` + `test/levaP.test.js` + `test/levaQ.test.js` + `test/levaQ3.test.js`

## Ainda não

- Login OAuth completo do usuário nas contas reais (só discovery/DCR testado ao vivo)
- Túnel nomeado com DNS estável (requer login Cloudflare do usuário; script pronto)
- Ligar o túnel + MCP remoto HELIOS em produção (só com aval; após reinstalar)
- Novo instalador desde N5

## Máquina

- Repo: `C:\Users\HelisonDias\Repositorios\HELIOS`
- Progresso Desktop: `HELIOS-progresso-20261030.md`
- App instalado: porta 47331 + `%APPDATA%\HELIOS` (não mexer em teste)
- Plano: `docs/operacao/plano-reforma-agentes.md`
- Backup P: `.backup-levaP\20261102-103725`
- Backup Q: `.backup-levaQ\20261102-212633`
- Backup Q3: `.backup-levaQ3\20261102-220035`
- cloudflared: `2026.7.3` (winget; update disponível 2026.10.7 opcional)
