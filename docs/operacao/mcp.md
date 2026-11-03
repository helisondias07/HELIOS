# MCP do HELIOS

Endpoint: `POST http://127.0.0.1:<porta>/mcp`  
Protocolo: JSON-RPC MCP `2025-06-18`.  
**Nenhuma ferramenta lê o cofre.** Ações irreversíveis voltam `pendente`.

## Local vs remoto

| | Local | Remoto |
|--|-------|--------|
| Token | `keys.mcp` no cofre (nasce sozinho) | `keys.mcpRemote` (só após gerar) |
| Rede | só loopback | túnel cloudflared; exige flag ligada |
| Ferramentas | lista completa abaixo | **allowlist** só quadro+chefe+status |
| Padrão | sempre disponível em 127.0.0.1 | **desligado** |
| Rate limit | — | ~30 req/min (configurável) |
| Log | — | `mcp-remote-access.json` (sem segredos) |

Tokens **nunca** se misturam: Bearer local ≠ Bearer remoto.

## Allowlist remota

- `helios_quadro_postar`
- `helios_quadro_ler`
- `helios_quadro_status`
- `helios_chefe_ordem`
- `helios_chefe_status`
- `helios_agente_status`

Sem memória, conversas, rotinas, tarefas, cofre, CPF, arquivos.

## Ferramentas locais (todas)

### Legado
- `helios_criar_tarefa` — `{ titulo, detalhe? }`
- `helios_listar_tarefas`
- `helios_atualizar_tarefa` — `{ id, status }`
- `helios_listar_rotinas`
- `helios_rodar_rotina` — `{ id, esperarMs? }`
- `helios_listar_ajudantes`
- `helios_buscar_conversas` — `{ consulta? }`
- `helios_ler_conversa` — `{ id }`
- `helios_consultar_memoria` — `{ consulta?, assistente? }`
- `helios_sugerir_assistente` — `{ pedido }`
- `helios_enviar_mensagem` — `{ texto, esperarMs?, assistente? }`

### O1
- `helios_quadro_postar` — `{ de?, para, tipo, assunto, corpo, ref? }`
- `helios_quadro_ler` — `{ para?, de?, status?, tipo?, limite? }`
- `helios_quadro_status` — `{ id, status }`
- `helios_chefe_ordem` — `{ texto }` (cria item + ciclo)
- `helios_chefe_status` — resumo
- `helios_agente_status` — `{ agente? }`

## Config remota

Arquivo `mcp-remote.json`: `{ enabled: false, ratePerMin: 30 }`.  
API: `GET/POST /api/mcp/remoto` (nunca devolve o valor do token).  
UI (Ajustes › Conta › MCP): estado “definido”, gerar/revogar, copiar, checkbox ligar.

## Túnel

Passos exatos em `tunel.md` + `scripts/tunel.ps1`. Quick tunnel para teste; named tunnel com login Cloudflare do usuário. Grok Bot: URL `https://<host>/mcp` + header `Authorization: Bearer <token-remoto>` (nunca logar o valor).

## MCP remotos de terceiros (Leva P)

O HELIOS também **consome** MCPs oficiais com OAuth no navegador:

| Serviço | URL MCP | Auth |
|---------|---------|------|
| ClickUp | `https://mcp.clickup.com/mcp` | OAuth 2.1 + DCR + PKCE |
| GitHub | `https://api.githubcopilot.com/mcp/` | Device Flow (Client ID) → Bearer |
| Vercel | `https://mcp.vercel.com` | OAuth 2.1 + DCR (fallback CLI/token) |

Fluxos e limites: `conectores-oauth.md`. Tokens só no cofre; Oasis/Portfólio usam as ferramentas com aprovação.
