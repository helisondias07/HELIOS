# Changelog

## 0.3.0 — baixa latência, copiloto ao vivo, modo código e zero perda

- **Zero perda de transcrição:** gravação incremental (`syncLines`) a cada fala, persistência em disco antes do LLM ao encerrar, escrita atômica resistente a `EPERM` no Windows e botão **Regenerar ata** no histórico.
- **Ocultar real e foco preservado:** `Ctrl+Shift+Espaço` / `Ctrl+\` apenas oculta/mostra o painel sem interromper a captura; novos atalhos `Alt+S`, `Alt+P`, `Alt+C` e `Ctrl+Shift+S` com `showInactive()` sem tirar o foco da chamada.
- **STT &lt; 2 s + PT/EN/Auto + Glossário:** corte rápido em pausas (`550 ms`) com sobreposição de `400 ms` sem buraco entre blocos, injeção de `glossario.md` no Whisper, seletor `PT / EN / Auto` com tradução em tempo real e pergunta por voz somente com gatilho explícito (`"Helios…"` ou botão dedicado).
- **Gemini em streaming SSE real:** respostas multimodais com contexto de tela via `:streamGenerateContent?alt=sse`, seletor de microfone (`deviceId`) e escolha de monitor ou janela específica.
- **Três modos de assistência rápida:** sugestão direta de fala (`Alt+S`), consulta instantânea de conceitos/assuntos (`Alt+P`) e modo **Código / Pair Programming** (`Alt+C`) com raciocínio, implementação + complexidade `O(...)` e diagnóstico de erros/edge cases.
- **Estilo Granola + Reuniões de 60+ min + Playbooks:** bloco de notas híbrido com carimbo de tempo fundido à ata, `rollingSummary` automático, fechamento em blocos para transcrições longas (&gt; 12 mil caracteres), 5 Playbooks nativos, checklists interativos e exportação Markdown (`.md`).
- **Pacote enxuto:** `electronLanguages` restrito a `pt-BR` e `en-US` e exclusão de assets PNG redundantes do `app.asar`.

## 0.2.0 — assistente só de reuniões

- Janela principal: preparar, iniciar, histórico e ajustes.
- Painel compacto: ouvir/pausar, transcrição, ajuda, perguntas, encerrar com duração.
- Fechamento local (resumo, decisões, pendências, próximos passos) sem envio externo.
- Removidos chat geral, agentes, conectores, rotinas, busca de trabalho e servidor HTTP/MCP.
- Cofre permanece só para chaves Groq/Gemini.
