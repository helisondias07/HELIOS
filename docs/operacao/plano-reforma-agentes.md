# Reforma do HELIOS: 1 chefe + 4 agentes (rascunho, 02/11/2026)

## Modelo
- 4 agentes donos do próprio trabalho (Vagas, Pesquisa, Oasis, Portfólio), cada um com missão, rotina, ferramentas e memória própria.
- Chefe "VP" acima deles: lê o quadro, define prioridades, delega e aprova o que é crítico. Subagentes curtos só dentro de um agente quando a tarefa pede (ex.: Portfólio planeja, codifica e revisa).
- Nada de esteira fixa de micro-agentes no começo: gasta tokens e dificulta rastrear (crítica levantada na thread do WillDobrev).

## Comunicação: quadro compartilhado (SQLite já existente)
- Tabela `quadro`: id, de, para, tipo (achado|pedido|resultado|alerta), assunto, corpo, status, criado_em.
- Fluxo: Vagas registra as vagas -> Pesquisa agrega as skills pedidas (ex.: Docker 40%, ausente no perfil) -> pedido ao Portfólio ("projeto com Docker") -> o Portfólio entrega o repo -> Vagas atualiza o perfil e o pitch.
- Oasis só lê e escreve itens do Oasis; não mistura com os itens de emprego.
- Uma única fonte de perfil: `perfil.skills` com evidência (link do projeto) por skill.

## Levas
- **O1: Quadro + chefe.** Tabela quadro, papéis dos 4 agentes em `assistants`/`missions`, `orchestration.js` como despachante. Ferramentas MCP: `helios_quadro_ler/escrever`, `helios_agente_status`.
- **O2: Interface simples.** Uma tela de chat com o chefe, cards de aprovação e um painel com 4 cartões de agente (status + último resultado + botão pausar). Mover ajustes avançados para "Avançado". Sem formulários longos: o chefe pergunta só o que faltar.
- **O3: Agente Vagas.** Plataformas 1x/dia; LinkedIn 2x/dia (feed, salvos, notificações, palavras-chave) com teto por hora, horários aleatórios, só sessão logada pelo próprio usuário, sem raspar em massa. Começa em modo aprovação.
- **O4: Agente Pesquisa.** Lê as vagas coletadas e conta skills por nível (júnior/pleno). Gera "lacunas" comparando com o perfil/vagas-helison e as envia ao quadro semanalmente.
- **O5: Agente Portfólio.** Recebe a lacuna, propõe 1 projeto pequeno, cria o repo local (GitHub só com OK), README com mockup (shots.so etc.) e evidência no perfil.
- **O6: Agente Oasis.** ClickUp: lê as tarefas atribuídas, propõe um plano e executa no repo da tarefa com aprovação. Reaproveita o fluxo do oasis-bot, mas com revisão humana.
- **O7: Observabilidade.** Log de custo por agente (`ledger.js`/`usage.js`), limite diário de tokens por agente, resumo matinal.
- **O8 (opcional): Chefe = Grok Bot** via MCP remoto (Cloudflare Tunnel + token remoto + lista mínima de ferramentas).

## Reaproveitar
`agent-runtime`, `delegation`, `orchestration`, `missions`, `routines`/`triggers`, `jobs`, `vagas-*`, `memory-hybrid`, `ledger`/`usage`, `mcp-server`, `telegram`, `autonomy`/`irreversible`, cofre, `account-usage`.

## Simplificar ou remover (avaliar)
- Telas/forms de configuração detalhada: ficam em "Avançado".
- `gabinete`, `parking`, `inbox` e `briefing` duplicados: fundir no quadro + resumo do chefe.
- Modo reunião e livecoding: manter, mas fora da tela principal.

## Riscos
- **Banimento no LinkedIn:** automação viola os termos. Volume baixo, ritmo humano, nada em massa, Easy Apply com aprovação no início; aceitar o risco conscientemente.
- **Custo de tokens:** 4 agentes + chefe com rotinas multiplicam o uso. Usar um modelo barato para coleta/triagem e um forte só para decisão/código. Limite por agente.
- **Qualidade das inscrições:** filtro de compatibilidade mínimo + revisão das primeiras 20.
- **Segurança:** CPF/senhas só no cofre; o túnel só com token remoto separado.

## Chefe: Grok Bot vs. interno
| | Grok Bot (Super) | Chefe interno no HELIOS |
|---|---|---|
| Prós | Já existe, conversa natural, roda 24/7 na nuvem, pesquisa web/X, rotinas | Funciona offline do Grok, sem túnel, um custo só, controle total |
| Contras | Precisa de túnel + MCP remoto exposto; PC do Helison ligado; gasta o limite Grok em cada orquestração | Precisa construir UX de chat e o raciocínio do chefe; consome o modelo do HELIOS |
Recomendação: começar com o chefe interno simples (O1-O2) e expor o MCP para o Grok Bot depois (O8), para ele também conseguir comandar quando quiser.
