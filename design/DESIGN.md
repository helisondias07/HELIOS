# HELIOS — Guia de design (siga ao pé da letra)

Assistente pessoal desktop. Tema: o sol (Hélios) no zênite. Visual noturno, sóbrio, com ouro como único acento.
Fonte da verdade dos valores: `tokens.css` (ou `tailwind.helios.js`). Nunca invente cores fora desta paleta.

## Regras de ouro
1. Interface **sempre escura**. Fundo `--helios-eclipse`; cartões `--helios-obsidiana`; elevados `--helios-basalto`; bordas `--helios-brasa`.
2. **Ouro (`--helios-ouro`) é o único acento.** Use para ação primária, foco, item ativo, marca. Máximo 1 elemento dourado preenchido por tela.
3. Texto principal `--helios-marfim`; secundário `--helios-nevoa`. Texto sobre ouro: `--helios-eclipse`.
4. Sem gradientes coloridos, sem emojis na UI, ícones em traço fino (stroke 1.5–2px).
5. Brilho solar (`--helios-brilho`) só em foco de campo, estado de escuta de voz e na tela inicial.

## Tipografia
- **Cinzel** (500–700): somente wordmark e títulos de marca. Caixa alta, letter-spacing +0,2em.
- **Inter** (400/500/600): toda a interface. Título 28/600, corpo 15/400, rótulo 14/500, legenda 12/400.

## Logo
- Símbolo: `helios-mark.svg` (16 raios alternados + núcleo anelado). Wordmark: "HELIOS" em Cinzel 600, tracking .24em, ouro.
- Fundo escuro: ouro `#E8B23A`. Fundo claro: símbolo `#9A6A14`, texto `#2A1D08`.
- Ícone de app: quadrado arredondado (raio ≈ 22% do lado), dourado com símbolo `#0B0B0D`, ou escuro com borda `#3A3A42` e símbolo dourado.
- Não girar, distorcer, recolorir fora desta lista, nem usar abaixo de 16 px. Respiro mínimo = raio do núcleo.

## Componentes
- **Botão primário:** h44, raio 10, fundo ouro, texto eclipse 600/14. Hover: `--helios-ambar`.
- **Botão secundário:** h44, raio 10, fundo basalto, borda brasa, texto marfim 500/14.
- **Botão contorno:** igual ao secundário, borda ouro, fundo transparente (ex.: "Conversar por voz").
- **Campo:** h48, raio 12, fundo obsidiana, borda brasa; em foco borda ouro + `--helios-brilho`. Placeholder nevoa.
- **Chip:** raio 8, padding 6×12, fundo da cor a 14% de opacidade, texto na cor (ouro/sucesso/alerta/erro) 600/12.
- **Item de menu:** h40, raio 10; ativo = fundo basalto + barra esquerda 3px ouro; inativo = texto nevoa.
- **Mensagens:** usuário = bolha basalto (raio 14, canto inferior direito 4); HELIOS = sem bolha, avatar do símbolo 28px à esquerda.
- **Tela inicial:** símbolo 96px com `drop-shadow(0 0 18px rgba(232,178,58,.5))`, "Como posso ajudar?" Inter 26/500, campo centralizado.

## Espaçamento e movimento
- Escala de 8px (8, 16, 24, 32…). Raios: 10 controles, 12 campos, 16 cartões.
- Transições 180ms ease-out. Modo voz: pulso lento do brilho (2.4s). Respeite `prefers-reduced-motion`.

## Acessibilidade
- Contraste mínimo 4,5:1 para texto. Alvos de toque ≥ 44px. Foco sempre visível (borda ouro + brilho).

## Checklist antes de entregar
- [ ] Só cores do `tokens.css`  - [ ] Ouro em no máximo 1 preenchimento por tela  - [ ] Cinzel apenas em marca/títulos
- [ ] Foco visível em tudo que é interativo  - [ ] Símbolo carregado de `helios-mark.svg`, nunca redesenhado


## Decisão do Helison (30/10 21:19)
Manter os dois temas. O CLARO é o tema PRINCIPAL (padrão). Tema claro: símbolo #9A6A14, texto #2A1D08, ouro como único acento; derivar tokens claros equivalentes (fundo, superfície, elevado, borda, texto) coerentes com o kit. O escuro segue os tokens do kit.
