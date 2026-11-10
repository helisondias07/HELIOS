# HELIOS — regras para agentes de código

- O HELIOS é um **assistente de reuniões**. Não recrie chat geral, agentes, conectores, rotinas ou automação de PC.
- **Design:** `design/DESIGN.md` (kit do Helison). Tema claro é o principal; o escuro usa os mesmos tokens.
- Cores só de `renderer/tokens.css` (`--helios-*`). Ouro é o único acento; no máximo 1 preenchimento ouro por tela.
- Cinzel só no wordmark; Inter no restante. Símbolo: `renderer/assets/helios-mark.svg`.
- Escala de 8px, transições 180ms, `prefers-reduced-motion`, foco visível.
- Antes de entregar: `npm test`, `npm run lint`, `npm run check`.
