# Túnel MCP remoto (O8)

Objetivo: o **Grok Bot** (presidente) alcançar o HELIOS no PC do Helison via Cloudflare Tunnel + token remoto separado.

## Pré-requisitos

1. HELIOS rodando com porta conhecida (produção instalada: **47331**; testes: **48061+** / userData próprio).
2. Token remoto **gerado** em Ajustes › Conta › MCP remoto — estado “definido”; copiado **uma vez** (a UI não mostra o valor).
3. Checkbox **Ligar MCP remoto** ativado.
4. Allowlist fixa (quadro + chefe + status) — ver `mcp.md`.
5. `cloudflared` no PATH (`cloudflared --version`).

## Instalar cloudflared (Windows)

```powershell
winget install --id Cloudflare.cloudflared -e
```

Alternativa: MSI oficial em https://developers.cloudflare.com/tunnel/downloads/

Conferir:

```powershell
cloudflared --version
```

## Quick tunnel (teste)

Ephemeral `*.trycloudflare.com`. Sem conta Cloudflare. URL muda a cada execução.

```powershell
# No repo — porta do HELIOS de TESTE (nunca 47331 em ensaio):
.\scripts\tunel.ps1 -Port 48061
```

Equivalente manual:

```powershell
cloudflared tunnel --url http://127.0.0.1:48061
```

Anote a URL HTTPS impressa pelo cloudflared (ex.: `https://xxxx.trycloudflare.com`).

## Named tunnel (hostname estável)

Requer login Cloudflare do **usuário** (não automatizar credenciais de terceiros).

1. `cloudflared tunnel login` (abre o navegador; conta Cloudflare do Helison).
2. `cloudflared tunnel create helios-mcp`
3. Criar DNS / public hostname no painel apontando o hostname escolhido para `http://127.0.0.1:<porta>` (ou config YAML local).
4. Rodar:

```powershell
.\scripts\tunel.ps1 -Port 47331 -Named -TunnelName helios-mcp
# ou: cloudflared tunnel run helios-mcp
```

Detalhes oficiais: https://developers.cloudflare.com/tunnel/

## Como o Grok Bot se conecta

| Campo | Valor |
|-------|--------|
| URL | `https://<host-do-tunel>/mcp` |
| Método | `POST` (JSON-RPC MCP `2025-06-18`) |
| Header | `Authorization: Bearer <token-remoto>` |

O `<token-remoto>` é o de **MCP remoto** no cofre (não o token local, não o da API).  
**Nunca** cole o token em chat, issue, print ou log. Copie só da UI (Copiar) para o cliente.

Exemplo de pedido (sem revelar o token):

```http
POST /mcp HTTP/1.1
Host: <host-do-tunel>
Authorization: Bearer <token-remoto>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

Resposta esperada: só as 6 ferramentas da allowlist (`helios_quadro_*`, `helios_chefe_*`, `helios_agente_status`).

Ordem inofensiva de teste:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"helios_chefe_ordem","arguments":{"texto":"Status dos agentes, sem ação externa."}}}
```

## Segurança

- Token remoto ≠ token local. Revogar invalida o acesso pelo túnel.
- Rate limit (~30 req/min, configurável); log em `mcp-remote-access.json` **sem** segredos.
- MCP remoto **desligado por padrão**; sem checkbox, mesmo com túnel aberto a auth remota falha (403).
- PC ligado + HELIOS aberto.
- Desligar o checkbox ou revogar o token corta o acesso.
- Não exponha a API `/api/*` de propósito: o túnel deve apontar só para a porta do HELIOS; o cliente usa **apenas** `/mcp` + Bearer remoto.

## Script

`scripts/tunel.ps1` — `-Port` obrigatória; `-Named` opcional. Não imprime o Bearer.

## O que a O1/O8 prepararam

- Cofre: `generateMcpRemoteToken` / `revoke` / `peek` (cópia)
- Config: `mcp-remote.json` (`enabled: false` por padrão)
- Auth dual no `/mcp` + rate limit vivo + log sem segredos
- `cloudflared` instalado na máquina; documentação e script prontos

**Não** deixe o túnel ligado contra o HELIOS instalado sem o Helison pedir; em levas de teste use porta/userData próprios.
