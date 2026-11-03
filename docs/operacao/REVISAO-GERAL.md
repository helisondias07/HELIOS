# Revisão geral — agente de Vagas

Texto para o Helison. Descreve o que o HELIOS faz hoje, onde ele pede aprovação, onde ele não vê a tela, a cadeia de modelos e o plano da rotação de contas do Cursor. A implementação desta rodada segue este desenho.

## Como as vagas funcionam de ponta a ponta

1. O app abre o navegador persistente (`persist:vagas`) e visita LinkedIn (feed, publicações salvas, vagas salvas, notificações, busca) e os quadros (Gupy, Indeed, Glassdoor e os demais).
2. Um script lê links e cartões no HTML e grava as vagas no `vagas.json`, com nota e as regras do dono (remoto, júnior/pleno, stack, empresas evitadas).
3. A fila automática pega as vagas `nova` dentro do limite por hora e chama `runApplication` no `jobs-host`.
4. Esse laço tira um retrato da página (campos, botões e, quando há modelo, a foto), decide o próximo passo, clica ou preenche, e olha de novo.
5. Só vira `enviada` se o site mostrar uma frase de confirmação. Captcha visível e login que o HELIOS não completa param e entram no relatório. O resto é falha técnica.
6. No fim, o disparo `--force-vagas` grava um JSON com contagens, sem senha e sem token.

O estado mora no HELIOS: fila, histórico, memória e checkpoints. Nenhuma conta do Cursor guarda essa fila.

## Onde ainda pedia o dono — e o que sai

Estes caminhos existiam e, para Vagas, deixam de ser o comportamento:

- Modo "com aprovação" e o seletor na tela. O único modo é o automático.
- Botão "Preparar inscrição" e o cartão "Aprovar inscrição".
- A vaga parada em `aguardando_aprovacao` volta para a fila no próximo ciclo.
- O registro não ganha mais a linha "automático começou" antes do resultado. O que aparece é o desfecho: enviada, falha técnica, ou precisa de você.
- E-mail de candidatura não abre cartão de aprovação. Se a vaga pede currículo por e-mail, o envio segue com o CV, depois de checar se aquele endereço já está nos Enviados.

O que continua indo para o dono, só no relatório (não como cartão que trava o ciclo):

- Um desafio de captcha de verdade, visível na tela (checkbox, iframe de desafio ou quebra-cabeça), e confirmado pela visão quando há modelo. O selo do rodapé "protegido pelo reCAPTCHA" não conta.
- Login ou 2FA que o cofre não conseguiu terminar.

## Onde isso ainda não é um agente que vê a tela

Um agente de computador fotografa, decide, age e fotografa de novo, em qualquer site. O HELIOS, na maior parte do tempo, lia o HTML com uma lista de rótulos. Se o botão não estava na lista, ele desistia em cerca de dois segundos e não anotava o que havia na página.

Nesta rodada o laço de envio passa a pedir a foto e o texto da página ao modelo primeiro. A regra de DOM só acelera quando não há modelo, ou quando o modelo não escolhe uma ação segura. A confirmação continua sendo a frase do site, nunca a palavra do modelo.

A carta de apresentação sai do perfil (nome, cargo, cidade) e é digitada no campo. O Indeed em "Adicionar documentos de apoio" segue para Continuar. Vaga híbrida ou com cidade fora do remoto (Florianópolis, por exemplo) é descartada antes do clique. Post do feed com nota na mínima vira vaga na fila, ou e-mail com o CV quando o texto traz um endereço e nenhum link de candidatura. A lista "Vagas encontradas" não tem mais "Preparar inscrição": nota na mínima entra no automático.

Limites que permanecem: iframe de outro domínio não é lido; a foto só ajuda se o modelo de visão aceitar a imagem; o HELIOS não resolve captcha.

## Cadeia de modelos

1. Modelos grátis (NVIDIA e, em seguida, Gemini), na ordem já definida em `server/free-llm.js`. Visão usa o papel `visao` e, se a foto falhar, o papel `extracao` só com o texto.
2. Se nenhum grátis responder, o Cursor entra como último recurso.
3. Nome, e-mail, telefone e CPF não vão no prompt. O modelo devolve placeholders; o código coloca o valor do cofre ou do perfil.

## Rotação das contas do Cursor

O dono tem até três contas. A chave fica só no cofre (DPAPI/safeStorage). A troca automática que já existia respeitava um interruptor e não reexecutava o pedido.

Para o agente de Vagas, limite de uso ou taxa (429) numa conta marca essa conta, ativa a próxima que ainda tem chave e repete o mesmo pedido. A fila, a memória e o checkpoint não mudam de lugar: continuam no HELIOS. O log registra só o apelido da conta, nunca a chave.
