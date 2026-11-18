# Changelog

## 0.3.1 — silêncio total na escuta, 2 abas focadas e guia VS Code mastigado

- **Silêncio total durante a reunião:** o HELIOS apenas escuta e transcreve; removidos o auto-disparo do detector de perguntas e o wake-word de voz. Pergunta por voz só quando o microfone é armado manualmente (`#btnVoiceAsk`).
- **Duas abas principais no overlay:** **Respostas** (`Alt+S`) e **Live Coding** (`Alt+C`), com Consultar (`Alt+P`), Ajuda, Notas e Falas como apoio.
- **Busca em tempo real obrigatória:** `ai:suggest`, `ai:ask`, `ai:research` e `ai:livecode` passam `search: true` (Google Search no Gemini / browser_search no Groq gpt-oss).
- **Respostas com dados reais:** formato fixo em 2 seções — *O que falar agora* (fala pronta em 1ª pessoa) + *Dados reais pesquisados* (até 3 fatos, números ou regras concretas).
- **Live Coding vira tutorial mastigado para o VS Code:** só sob demanda (botão **Gerar Guia** ou `Alt+C`); entrega **1. Preparar no VS Code** (pasta, arquivo e comando exatos), **2. Passo a passo do que digitar** (micro-passos numerados na ordem de digitação, código limpo por bloco com botão Copiar e complexidade `O(...)`) e **3. O que falar enquanto digita** (1 frase natural por passo).
- **Bateria de estresse anti-reembolso** (`test/stress-cluely-parity.test.js`): 120 linhas contínuas sem card automático e com filas/cache limitados, alternância de abas, garantia de `search: true`, formato do guia e persistência sem perda em erro 429.

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
