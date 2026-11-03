
## Leva U — 03/11/2026
- Worker único de agentes com tool-calling dos modelos grátis, histórico entre passos e fallback para Cursor quando não há chave grátis.
- Ordem do Chefe com runtime usa uma única sessão operacional; o ciclo legado continua disponível para o quadro sem runtime.
- Chefe ganhou orientação curta e atalhos para código, pesquisa e candidaturas.
- Candidaturas agora têm máquina de estados, evidências de confirmação e clique resiliente a aria-label, role/button, spans e atributos de teste.
- 62 snapshots `.backup-*` foram movidos, de forma recuperável, para `C:\Users\HelisonDias\Repositorios\HELIOS-archive\backups-20261103-002212`; `.env` foi preservado fora do repositório.
- Suíte: 618 pass, 1 skip; `npm run lint`, `npm run check` e `npm run dist:win` verdes. Instalador reinstalado em 03/11/2026.

## Leva R (02/11/2026)
- Provedor grátis (NIM/Gemini) com tool calling e reserva em 429; Vagas/Pesquisa no grátis; preenchimento com placeholders (dados pessoais fora do prompt). Ver docs/operacao/leva-r-modelos-gratis.md.

## Leva T (03/11/2026)
- Rack operacional do Chefe inspirado na referência do Racky: máquina local, agentes do gabinete, sessões vivas, ferramenta atual, passos, tempo e pendências.
- Nova API local `GET /api/chefe/operacao`, somente com estado público e sem segredos.
- Teste `test/levaT.test.js`; o snapshot foi arquivado externamente conforme a política de limpeza.

