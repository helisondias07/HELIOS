# Limpeza e arquivo do repositório

O código de produção fica no repositório. Backups de etapas, screenshots e
artefatos gerados não ficam misturados com ele.

## Política

- `.backup-*`, `release/`, `dist/` e `node_modules/` não fazem parte da árvore
  versionada.
- Uma limpeza deve começar por uma cópia externa datada, antes de mover
  qualquer coisa.
- O descarte padrão é mover para `C:\Users\HelisonDias\Repositorios\HELIOS-archive\`
  e só apagar definitivamente depois de uma rodada verde de testes e uma
  confirmação do Helison.
- Arquivos de `server/`, `src/`, `renderer/` e `test/` só podem ser removidos
  após busca de imports, uso em build e uso em testes.

## Limpeza de 03/11/2026

Foi criada a baseline externa `baseline-20261103-002212` e os 62 diretórios
`.backup-*` foram movidos para `backups-20261103-002212`. Nada foi apagado
definitivamente. A raiz do HELIOS agora não contém snapshots históricos.

Para reproduzir uma limpeza futura, faça a baseline primeiro, registre o
manifesto e rode `npm test`, `npm run lint` e `npm run check` antes de instalar
o aplicativo.
