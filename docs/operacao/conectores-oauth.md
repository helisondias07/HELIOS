# Conectores OAuth / MCP remoto (Leva P)

Objetivo: entrar com **um botão** (ClickUp, GitHub, Vercel) sem colar token quando o provedor permitir. Tokens e refresh ficam **só no cofre** (safeStorage); nunca em log, prompt ou JSON público.

## Fluxo genérico (MCP + OAuth 2.1)

1. `GET` na URL MCP → `WWW-Authenticate` com `resource_metadata` (RFC 9728).
2. Metadata do resource + do authorization server (RFC 8414).
3. Se houver `registration_endpoint`: **DCR** (RFC 7591) com `token_endpoint_auth_method: none`, redirect `http://127.0.0.1:<porta>/callback`.
4. **PKCE S256**, `state` anti-CSRF, parâmetro `resource` quando o AS exige.
5. Browser padrão (`shell.openExternal`); callback em loopback efêmero; timeout ~5 min.
6. Refresh automático perto do vencimento e em **401** do MCP.
7. Desconectar: tenta revogar (se houver endpoint) e apaga do cofre.

## Por provedor

| Provedor | MCP | Como entrar | Limite | Fallback (Avançado) |
|----------|-----|-------------|--------|---------------------|
| **ClickUp** | `https://mcp.clickup.com/mcp` | **Entrar com ClickUp** (DCR + PKCE + navegador) | Allowlist de clientes possível; DCR testado ao vivo em 02/11/2026: **aceito** com redirect loopback | Token `pk_…` no cofre (compat O6) |
| **GitHub** | `https://api.githubcopilot.com/mcp/` | **Entrar com GitHub** = **Device Flow** (`/login/device/code` + poll). **Sem client_secret**. | **Sem DCR** (nunca). Exige OAuth App próprio uma vez (só Client ID). | PAT em Avançado |
| **Vercel** | `https://mcp.vercel.com` | **Entrar com Vercel** (DCR + PKCE se allowlist aceitar) | DCR ao vivo 02/11/2026: **aceito** neste teste; em geral pode recusar `invalid_redirect_uri` se o cliente não estiver aprovado | (a) Vercel CLI já logado (Portfólio usa CLI sem ler o token); (b) colar token em Avançado |

### GitHub — Client ID (uma vez)

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Homepage `http://127.0.0.1`; callback `http://127.0.0.1/callback` (não usada no device flow).
3. Copie só o **Client ID** (não é segredo; device flow não exige secret).
4. Cole no cartão GitHub (Configurar) ou em Conectores › Avançado.
5. **Entrar com GitHub** mostra o código curto e abre `github.com/login/device`.

### Vercel — se DCR for recusado

1. Preferir `vercel login` no terminal do usuário; o Portfólio usa o CLI (`vercel deploy`) sem ler o token do CLI.
2. Ou gerar token em [vercel.com/account/tokens](https://vercel.com/account/tokens) e colar em Avançado.
3. Opcional: pedir aprovação de cliente OAuth no formulário de review da Vercel (próximo passo).

## Agentes

- **Oasis:** ferramentas do ClickUp MCP (listar atribuídas; comentar/status só com aprovação). Sem conector/token → botão **Entrar com ClickUp**.
- **Portfólio:** GitHub MCP (criar repo) e Vercel (CLI/token) **só com aprovação**. Sem acesso → **Entrar com GitHub/Vercel**.

## UI

- Grade: um botão por cartão (`Entrar com…` / `Conectado como <nome>` / `Reconectar`).
- Campos de token **só** em **Avançado**.
- Sem emojis; tema claro principal; tokens `--helios-*`.
