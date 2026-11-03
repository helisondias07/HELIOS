# HELIOS — regras para agentes de código

- **Design:** toda mudança de interface segue `design/DESIGN.md` ao pé da letra (kit do Helison), inclusive a decisão anexada no fim (tema CLARO é o principal; o escuro usa os tokens do kit).
- Cores só de `design/tokens.css` / `renderer/tokens.css` (`--helios-*`). Nada de cor inventada, gradiente colorido ou emoji na UI.
- Ouro é o único acento; no máximo 1 elemento preenchido de ouro por tela.
- Cinzel só no wordmark/títulos de marca; Inter em toda a interface (fontes locais em `renderer/assets/fonts`, OFL).
- O símbolo é sempre `renderer/assets/helios-mark.svg` (classe `.hx-mark`), nunca redesenhado.
- Componentes: ver `renderer/kit.css` (botões h44 r10, campos h48 r12 com brilho no foco, chips a 14%, itens de menu h40).
- Escala de 8px, transições 180ms ease-out, respeitar `prefers-reduced-motion`, foco sempre visível, contraste ≥ 4,5:1.
- Antes de entregar: rode o checklist do fim de `design/DESIGN.md`, `npm test` e `npm run lint`.
