# HELIOS — arquitetura (operação)

Documento vivo da Leva O1 em diante. Atualize a cada leva (`CHANGELOG.md`).

## O que é

HELIOS é o assistente pessoal de desktop do Helison: app **Electron** local (Windows), com servidor HTTP só em `127.0.0.1`, cofre DPAPI, contas Cursor, agentes, quadro compartilhado e MCP.

## Peças

| Peça | Onde | Papel |
|------|------|--------|
| Electron (main) | `src/main.js` | Janela, tray, cofre, IPC, sobe o servidor |
| Servidor local | `server/index.js` | API `/api/*`, MCP `/mcp`, rotinas, jobs |
| Renderer | `renderer/` | UI (tema claro principal; tokens `--helios-*`) |
| Memória | `server/memory-hybrid.js` | SQLite (`node:sqlite`) + FTS5 + embeddings locais |
| Quadro | `server/quadro.js` → `quadro.sqlite` | Comunicação entre Chefe e 4 agentes |
| Chefe | `server/chefe.js` | Vice interno: prioriza, delega, pede aprovação |
| Cofre | `src/vault-store.js` | Logins, tokens, chaves, tokens MCP local/remoto |
| Contas Cursor | `server/accounts.js` + `account-usage.js` | Até 3 contas; barra de uso real |
| MCP local | `/mcp` + token local do cofre | Loopback; ferramentas completas (sem cofre) |
| MCP remoto | mesmo `/mcp` + token remoto | Desligado por padrão; allowlist mínima |
| Rotinas / gatilhos | `routines.js` / `triggers.js` | Horário, intervalo, eventos |
| Agentes SDK | `agent-runtime.js` | Agentes autônomos em segundo plano |
| Vagas | `jobs.js`, `vagas-*` | Busca/inscrição com paradas críticas |

## Hierarquia de comando (O1+)

```
Grok Bot (presidente, nuvem)  --MCP remoto futuro-->  Chefe (vice no HELIOS)
                                                         |
                    +------------------------------------+------------------------------------+
                    |                  |                  |                                    |
                  Vagas             Pesquisa            Oasis                             Portfólio
```

Comunicação interna: **quadro compartilhado** (não há esteira fixa de micro-agentes).

## Dados no disco

- Instalado: `%APPDATA%\HELIOS\` (nunca tocar em testes)
- Teste: `HELIOS_USER_DATA` próprio (ex.: `%TEMP%\helios-levaO1-ud`)
- Projetos / skills / contexto: `Documentos\HELIOS\`

## Porta

- Produção instalada: **47331** (não usar em testes)
- Testes: `47921+` (ou `port: 0` nos unitários)

## Próximas levas

Ver `proximos-passos.md` (O3–O9 ✅; ligar túnel em produção só com aval).
