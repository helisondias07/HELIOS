# HELIOS

Assistente de reuniões para desktop, em português do Brasil. Prepara a conversa, acompanha em um painel compacto e fecha com resumo, decisões e pendências a partir do que de fato foi dito.

O HELIOS não entra na chamada. Ele roda no seu computador, ao lado do Zoom, Teams, Meet ou de uma sala. A inspiração de fluxo é um overlay enxuto (transcrição, ajuda ao vivo, encerrar com duração) — a marca, as cores e o nome continuam HELIOS.

Alvo: **Windows 10 ou 11, 64 bits**. Linux e macOS podem abrir a janela; o áudio do sistema quase sempre falta fora do Windows.

## O que o app faz

1. **Antes.** Título, objetivo, pauta e notas. Você escolhe microfone, áudio do computador e, se quiser, contexto de tela só desta reunião. Só inicia depois de confirmar que as outras pessoas sabem que a conversa pode ser transcrita.
2. **Durante.** Painel arrastável, fora da barra de tarefas e excluído da captura de tela. Estados **Ouvindo**, **Pausado** e **Encerrada**. Transcrição ao vivo, ajuda contextual, “o que digo”, perguntas (digitadas ou por voz) e prévia explícita se a tela estiver ligada.
3. **Depois.** Resumo editável, decisões, pendências e próximos passos. Responsável e prazo só aparecem se alguém citou. Nada é enviado por e-mail ou CRM.

O que o HELIOS **não** faz: assistente geral, automação do PC, leitura de tela como cola, conectores de calendário/CRM, follow-up automático, invisibilidade.

## Privacidade

- Captura só por ação sua (iniciar, ouvir, confirmar print).
- Indicador claro de escuta, pausa e encerramento.
- Encerrar (ou fechar o painel) para áudio, timers e pedidos à IA.
- Áudio vai ao provedor de transcrição (Groq) quando há chave; não gravamos arquivo de áudio. A transcrição fica em `%APPDATA%\HELIOS\meetings.json`.
- Tela só entra se você ligou o contexto nesta reunião e, no print manual, confirmou a prévia. O painel usa `setContentProtection(true)` para não aparecer na captura.
- Chaves no cofre (`safeStorage` / DPAPI no Windows). Sem chave no código. `.env` não entra no git.

## Áudio (Windows e limites)

| Fonte | Windows | Linux neste repositório |
| --- | --- | --- |
| Microfone | `getUserMedia`, permissão do sistema | Pode funcionar se o sandbox permitir |
| Áudio do computador (outras pessoas na call) | `getDisplayMedia` + loopback do Chromium | Costuma falhar (`NoAudio`). Use o microfone com o alto-falante, ou só a sua fala |

Fones ajudam: o microfone não deve ouvir o próprio HELIOS (este app não lê respostas em voz alta no painel).

Modo demonstração, sem rede: `HELIOS_MOCK=1`. As falas de exemplo vêm marcadas como demonstração.

`HELIOS_NO_PROTECT=1` desliga a exclusão de captura do painel — só para gravar a própria tela em desenvolvimento.

## Chaves

- **Groq** — transcrição (Whisper) e texto. Sem ela, o app avisa e não finge sucesso.
- **Gemini** — opcional, só para contexto de tela.

```bash
npm install
copy .env.example .env
npm start
```

No `.env`, preencha só o que for usar. Na primeira abertura as chaves vão para o cofre e saem do ambiente.

```
GROQ_API_KEY=
GEMINI_API_KEY=
```

Cole de novo em **Ajustes** se preferir não usar arquivo.

## Atalhos (painel)

| Atalho | Ação |
| --- | --- |
| Ctrl+Shift+Espaço ou Ctrl+\\ | Mostrar ou ocultar o painel |
| Ctrl+Shift+R | Ouvir ou pausar |
| Ctrl+Enter | Sugestão de fala (só com a sessão ouvindo) |
| Ctrl+Shift+Enter | Print da reunião (se o contexto de tela estiver ligado; pede confirmação) |
| Ctrl+Shift+T | Clique atravessa o painel |
| Ctrl+Shift+setas | Mover o painel |
| Esc | Fecha o painel se não estiver ouvindo |

Fechar a janela principal manda o HELIOS para a bandeja. Sair de verdade é pelo menu da bandeja.

## Dados

`%APPDATA%\HELIOS`: `settings.json`, `vault.json`, `meetings.json`, logs. Desinstalar não apaga essa pasta.

## Testes

```bash
npm test
npm run lint
npm run check
```

Não precisa de chave. `npm test` cobre preparação/consentimento, encerrar, wrapup sem inventar responsável, descarte da captura, prompts sem cola de tela e ausência dos fluxos antigos fora de reunião.

Instalador Windows: `npm run dist:win` → `release/HELIOS-Setup-0.2.0.exe`.

Este agente rodou testes em Linux. A captura de áudio do sistema e o `safeStorage` real só se confirmam no Windows.
