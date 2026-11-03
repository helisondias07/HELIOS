# Quadro compartilhado

## Esquema (`quadro.sqlite`)

| Coluna | Tipo | Notas |
|--------|------|--------|
| id | TEXT PK | `qd_…` |
| de | TEXT | quem postou (`chefe`, `vagas`, `pesquisa`, `oasis`, `portfolio`, `helison`, `sistema`, …) |
| para | TEXT | destinatário |
| tipo | TEXT | `achado` \| `pedido` \| `resultado` \| `alerta` |
| assunto | TEXT | até 160 |
| corpo | TEXT | até 4000 (redact) |
| status | TEXT | `aberto` \| `em_andamento` \| `feito` \| `cancelado` |
| criado_em | TEXT ISO | |
| atualizado_em | TEXT ISO | |
| ref | TEXT opcional | id relacionado |

Módulo: `server/quadro.js` — `postar` / `ler` (filtros para/de/status/tipo/limite) / `atualizarStatus` / `resumo`.

## Fluxo exemplo (emprego)

1. **Vagas** posta `achado` → `chefe` (ou direto `pesquisa`).
2. **Chefe** ciclo → `pedido` → `pesquisa`.
3. **Pesquisa** posta `resultado` (lacuna Docker) → `chefe`.
4. **Chefe** → `pedido` → `portfolio`.
5. **Portfólio** entrega `resultado` com link → Vagas atualiza pitch/perfil.

## Oasis

Itens com cara de emprego **não** podem ir para `para=oasis` (exceto origem chefe em casos controlados — a regra bloqueia misturas de vagas→oasis). Oasis só fala de Oasis.

## MCP

- `helios_quadro_postar` — `{ de?, para, tipo, assunto, corpo, ref? }`
- `helios_quadro_ler` — filtros
- `helios_quadro_status` — `{ id, status }`

## API local

- `GET /api/quadro?para=&de=&status=&tipo=&limite=`
- `POST /api/quadro`
- `POST /api/quadro/:id/status` body `{ status }`
