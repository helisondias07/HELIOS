# HANDOFF — HELIOS reuniões

Produto: overlay + janela principal só para reuniões. Persistência em `server/meetings-store.js`. Captura e IA em `src/meeting-host.js`. UI do painel em `renderer/meeting/`. Preparação em `renderer/app.js`.

Não reintroduzir fluxos fora de reunião. Não enviar follow-up. Tela só com flag da sessão. Encerrar chama `abortInflight` e para trilhas de áudio.

Testes: `npm test && npm run lint && npm run check`.
