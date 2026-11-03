# Agentes — papéis e hierarquia

## Hierarquia

1. **Presidente — Grok Bot** (conta nuvem): comanda pelo MCP remoto (túnel futuro).
2. **Vice — Chefe** (dentro do HELIOS): lê o quadro, prioriza, delega, pede aprovação no crítico.
3. **4 agentes donos** (cada um dono do próprio trabalho; sem esteira):

| Id | Nome | Missão | Entradas | Saídas |
|----|------|--------|----------|--------|
| `vagas` | Vagas | Buscar/filtrar/candidatar (front-end), ritmo humano, paradas críticas; O3: LI 2x/dia + plataformas 1x/dia, aprovação nas 20 primeiras | Preferências, perfil, plataformas, pedidos no quadro, sessão HELIOS | Achados, resultados de inscrição, alertas |
| `pesquisa` | Pesquisa | Contar skills pedidas vs perfil; lacunas (O4: % reais por júnior/pleno, rotina semanal) | Achados de Vagas, `perfil.skills`, vagas-helison (leitura) | Lacunas, pedidos ao Portfólio |
| `oasis` | Oasis | ClickUp atribuídas; plano + execução + comentário só com aprovação (O6) | Tarefas ClickUp, pedidos Oasis | Planos, resultados Oasis, escritas ClickUp aprovadas |
| `portfolio` | Portfólio | Projetos pequenos como evidência (O5: repo local + aprovação GH/Vercel) | Lacunas / pedidos de Pesquisa | Repos locais, pendências de publicação, evidências em `perfil.skills` |

**Oasis isolado:** não lê/escreve itens de emprego no quadro.

## Chefe (vice)

- Arquivo: `server/chefe.js`; estado em `chefe.json`.
- Começa **pausado**; intervalo padrão 30 min (configurável 5–240).
- Ferramentas MCP: `helios_chefe_ordem`, `helios_chefe_status`, `helios_agente_status`.
- Ciclo: lê itens `para=chefe` abertos → prioriza (alerta > crítico > pedido > …) → delega (postagem `pedido` ao destino) ou abre pendência de aprovação.
- **Nunca inventa números** (tokens, custo, %): só o que está no quadro/estado.

## Assistentes de fábrica (seed)

Em `server/assistants.js` (`BUILTINS`): `chefe`, `vagas`, `pesquisa`, `oasis`, `lojas-wake`, `portfolio`. Seed uma vez; se o Helison apagar, não volta sozinho.

## Missões

`server/missions.js` — o Chefe cria missões contínuas por agente na seed. Decisões abertas exigem resposta humana.

## Ferramentas (visão geral)

- Quadro: `helios_quadro_*`
- Orquestração/delegação existentes (`orchestration`, `delegation`) como despachante leve
- Vagas: `helios_ajustes` / jobs / adapters
- Crítico: cartões de aprovação + Telegram (`irreversible` / `ALWAYS_ASK`)
