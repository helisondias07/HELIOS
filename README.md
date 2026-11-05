# HELIOS

Assistente pessoal de desktop do Helison, em português. A v0.1 junta num aplicativo só o chat com agente, o cofre de senhas, os conectores MCP, a pesquisa com fonte e o modo de reunião (tradução, transcrição, sugestões e livecoding).

O HELIOS roda no Windows. A janela principal fica na bandeja. O modo de reunião é uma pílula flutuante, fora da barra de tarefas e excluída da captura de tela.

A marca (sol em ouro e teal) fica em `build/brand/`. O aplicativo, a bandeja e o instalador usam `build/icon.png`, `build/icon.ico` e `build/tray.png`. A interface lê as cópias em `renderer/assets/`. `npm run icons` não substitui esses arquivos quando a marca oficial já está em `build/brand/`.

## O que tem na v0.1

- **Conversas.** O agente usa a conta do Cursor. No modo Auto, uma conversa ou um ajuste pequeno vai para o Composer 2.5. Um projeto grande vai para o Grok 4.5. Sem conta, a resposta fica no modo demonstração, para você ver o fluxo.
- **Aprovação.** Enviar, apagar, pagar ou publicar pede um cartão na conversa. Nada disso acontece antes do seu ok.
- **Cofre.** Logins, tokens e as chaves Groq e Gemini ficam cifrados com o `safeStorage` do Electron (DPAPI no Windows). A senha não entra no prompt, no log nem no chat. O agente só conhece o nome do login. Quando você pede para preencher, o aplicativo digita na janela em foco pelo PowerShell, pede ao Windows para não guardar o texto no histórico da área de transferência e limpa a área de transferência logo depois (detalhes e limite em “Segurança: área de transferência, ambiente do MCP e tamanho”).
- **Conectores.** Você adiciona um servidor MCP por comando (stdio) ou por URL (http). O status só fica online depois de um `initialize` e um `tools/list` de verdade.
- **Pesquisa.** A busca na web mostra título, trecho e o endereço da fonte.
- **Memória e rotinas.** Fatos estáveis ficam em disco. Um horário ou um intervalo dispara um pedido na conversa. Segredo não entra na memória.
- **Modo de reunião.** O botão na janela principal abre a pílula. Ela ouve o som do computador (e o microfone, se você deixar), transcreve com o Groq Whisper, traduz, sugere o que falar em inglês ou em português, resume e guarda o histórico. A janela usa `setContentProtection(true)` e `skipTaskbar: true`.
- **Livecoding.** Fica na aba Livecoding dessa mesma pílula. O HELIOS mostra um roteiro em português para o Helison digitar à mão com um estagiário: visão geral, arquivos e um passo de cada vez. Nada é gravado em disco e nenhum editor abre.
- **Ditado global.** Atalho opcional, desligado por padrão, que transcreve o microfone e digita na janela em foco. O texto falado não fica salvo.
- **Skills.** Pacotes de instrução no estilo SKILL.md. O agente lê quando precisa. Importar mostra uma prévia, tira o que parece segredo e não executa nada.
- **Montar time.** Um objetivo vira uma proposta dos assistentes que já existem. Só o clique cria.
- **Digest da manhã.** Rotina pausada, às 08:00, só de leitura: o resumo fica na conversa e o Helison é quem age fora dela.

Os dados ficam em `%APPDATA%\HELIOS`. O servidor local escuta em `127.0.0.1:47331` (ou na porta de `HELIOS_PORT`). Ele não escuta em `0.0.0.0`. A janela do aplicativo manda um token próprio em toda chamada `/api`. Outro processo, sem esse token, recebe 401. Esse token não é o do MCP e não aparece na tela.

## Modo de voz

O HELIOS lê as respostas em voz alta e também conversa por voz. Tudo fica na aba **Conversas**.

- **Ouvir uma resposta.** Cada resposta do HELIOS tem um botão **Ouvir**. Enquanto ele fala, o botão vira **Parar**. Marque **Ler respostas automaticamente** para ouvir toda resposta nova (a escolha fica salva neste computador). O texto é limpo antes da leitura: sem markdown, links nem blocos de código.
- **Voz.** O padrão é a melhor voz em português do Brasil que o Windows tiver (sem configurar nada). O seletor **Voz** troca para a voz do Gemini, mais natural, que usa a chave Gemini do Cofre. Se a cota acabar ou der erro, o HELIOS volta sozinho para a voz do Windows.
- **Modo conversa.** O botão **Conversar por voz**, ao lado de Enviar, liga o microfone. Você fala, o HELIOS percebe quando você termina (cerca de 0,8 s de silêncio), transcreve, manda como uma mensagem comum e fala a resposta. Depois volta a ouvir. Se você falar enquanto ele fala, ele para e te escuta. O indicador mostra **Ouvindo**, **Transcrevendo**, **Pensando** ou **Falando**.
- **Parar.** Clique de novo no botão, aperte **Esc** ou troque de aba. O Esc também interrompe uma leitura em andamento.
- **Aprovações.** O HELIOS não lê cartões de aprovação em voz alta. Se houver um pendente, ele só avisa: "Há uma aprovação pendente na tela."

Requisitos: chave da **Groq** no Cofre (aba Cofre, "Chaves de reunião") para o modo conversa, e permissão de microfone do Windows. Use fones de ouvido se puder: a voz do Windows sai pelo sistema e o microfone pode ouvir o próprio HELIOS.

Privacidade: o áudio do modo conversa só vai à Groq, para transcrever, e não é guardado. A leitura com a voz do Windows não sai do computador. Com a voz Gemini, só o texto da resposta é enviado ao Gemini. As chaves ficam no processo principal e nunca chegam à tela.

## Caixa de entrada, autonomia e assistentes

**Caixa de entrada.** A aba junta, numa lista só, todas as aprovações e perguntas pendentes de todas as conversas e rotinas, com um contador na aba. Cada item deixa aprovar, ajustar, negar (ou responder a pergunta) sem sair dali, e abre a conversa de origem. A lista vem de `GET /api/inbox`; a resposta a uma pergunta vai em `POST /api/conversations/:id/questions/:qid`. O agente faz uma pergunta com a ferramenta `perguntar_ao_helison`.

**Autonomia por ação.** Em Autonomia, para cada tipo (enviar, pagar, apagar, publicar, ler e pesquisar, preencher login, escrever arquivo) você escolhe “Pedir antes” ou “Sozinho”. O padrão é “Pedir antes”, menos ler e pesquisar. **Pagar e preencher login (usar segredo do cofre) são travados em “Pedir antes”**: a tela não oferece outra opção e o servidor recusa (erro 400) e ignora o valor mesmo num arquivo editado à mão. A regra vale nas conversas, nas rotinas e no servidor MCP local. Uma ação feita sozinha deixa um registro na conversa. Os ajustes ficam em `%APPDATA%\HELIOS\autonomy.json` (`GET`/`POST /api/autonomy`).

**Assistentes.** Cada assistente tem nome, função, instruções, memória própria, conectores MCP permitidos e, se quiser, autonomia própria (que também não destrava pagar nem preencher login). Há seis modelos: Caixa de entrada, Estudos, Código, Pesquisa, Finanças da casa e Agenda. Toda conversa e toda rotina pertence a um assistente; o prompt e a memória de um não aparecem para o outro. O assistente padrão (HELIOS) é o de sempre: usa o `memory.json` atual e não pode ser editado nem removido. Conversas antigas viram dele sozinhas na primeira abertura, com uma cópia em `conversations.pre-assistentes.json`. Os outros ficam em `assistants.json` e `memory-<id>.json`. Ao remover um assistente, as conversas voltam para o padrão e a memória dele é apagada. Rotas: `GET`/`POST /api/assistants`, `POST`/`DELETE /api/assistants/:id`, e `?assistant=<id>` em `/api/memory`. No MCP local, `helios_enviar_mensagem` e `helios_consultar_memoria` aceitam o campo `assistente` (nome ou id).

## Cofre com a API assíncrona do `safeStorage`

A documentação do Electron marca `safeStorage.encryptString` e `decryptString` (as versões síncronas) como obsoletas a partir do Electron 45 e removidas no 46. A API nova é assíncrona: `isAsyncEncryptionAvailable()`, `encryptStringAsync()` e `decryptStringAsync()`, que devolve `{ shouldReEncrypt, result }`. Ela já existe no Electron 44.9.3 deste projeto, e dado cifrado pela API síncrona abre com `decryptStringAsync`.

O HELIOS usa a API assíncrona quando existe e cai para a síncrona só se faltar (`src/vault-crypto.js`). O formato antigo do `vault.json` continua abrindo. Ao abrir um cofre antigo, o HELIOS faz uma cópia em `%APPDATA%\HELIOS\backups\vault.pre-async.json` (uma vez só) antes de regravar no formato novo (`version: 2`). Antes de gravar, ele cifra, decifra de volta e compara; se não bater, não grava. Nenhum segredo vai para log ou mensagem de erro. As leituras (`getLogin`, `getKey`…) continuam síncronas; as gravações (`saveLogin`, `setKey`…) agora são `async`.

**Cofre ilegível.** Se o `vault.json` existe mas não abre (não descriptografa, ou não é um JSON válido, ou só uma parte abre), o HELIOS **nunca o sobrescreve**, mesmo que consiga cifrar dados novos. Nesse caso:

- toda gravação é bloqueada: salvar ou remover login e token e salvar chaves devolvem uma mensagem clara em português (na aba **Cofre**, num aviso no topo, e numa janela ao abrir o aplicativo). O `vault.json` fica intacto, byte a byte;
- o HELIOS copia o arquivo que não abriu para `%APPDATA%\HELIOS\backups\vault.unreadable.json` (uma vez só) já na abertura;
- a orientação é: reinicie o HELIOS; se continuar, feche o HELIOS e troque `vault.json` por `backups\vault.pre-async.json` (ou `vault.unreadable.json`) e abra de novo;
- só por ação explícita sua, o botão **Começar um cofre novo** (com confirmação) cria um cofre vazio. Antes ele copia o arquivo ilegível para `backups\vault.unreadable-<data>.json` e confere o tamanho da cópia; se a cópia falhar, nada muda. Logins, tokens e chaves do cofre antigo ficam fora do HELIOS (recuperáveis só manualmente, pela cópia);
- enquanto o cofre está bloqueado, os tokens da sessão (API local e MCP) vivem só na memória e mudam ao reiniciar, e chaves vindas do `.env` valem só para esta sessão.

Limite: os testes usam um `safeStorage` simulado. A leitura do cofre real com `decryptStringAsync` só se confirma abrindo o aplicativo no Windows.

## Segurança: área de transferência, ambiente do MCP e tamanho

**Área de transferência ao preencher login (`src/vault-inject.js`).** O texto entra na área de transferência do Windows num objeto que também leva os formatos `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory` = 0 e `CanUploadToCloudClipboard` = 0. Isso pede ao Windows para não guardar no histórico (Win+V), não sincronizar com a nuvem e não deixar monitores processarem. Depois de colar, a área de transferência é limpa, também quando algo falha. Usuário e senha vão ao PowerShell só pelo stdin (em base64); o script vai por `-EncodedCommand` e não tem segredo; a saída do PowerShell nem é lida, então a senha não aparece em log nem em retorno. **Limites honestos:** (1) esses formatos são um pedido que o Windows e os programas respeitam; um programa que leia a área de transferência nos décimos de segundo entre copiar e limpar ainda vê o texto; (2) o preenchimento usa Ctrl+V na janela em foco, então a senha passa pela área de transferência por esse instante; (3) o histórico e a nuvem da área de transferência dependem das configurações do Windows (em versões sem esses recursos, os formatos são simplesmente ignorados).

**Ambiente dos conectores MCP stdio (`server/mcp-client.js`).** O servidor stdio é iniciado com um ambiente mínimo: `PATH`, `SystemRoot`, `windir`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOME*`, `ProgramFiles*`, `ProgramData`, `NODE_*`, `LC_*`, `LANG` e poucas outras do sistema. As chaves `CURSOR_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY` e qualquer variável com `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`, `COOKIE` ou `SESSION` no nome **nunca são herdadas**. Variáveis que você quiser dar a um conector ficam no campo “Variáveis só deste conector” (NOME=valor, uma por linha); só elas entram por cima, e a lista de conectores mostra apenas os nomes. Cada linha de resposta do servidor stdio tem limite de 1 MB (acima disso o processo é encerrado com erro claro) e o stderr guarda só os últimos 2000 caracteres.

**Limites de tamanho do servidor local.** Corpo de requisição acima de 1 MB recebe **413** com mensagem clara (o resto é lido e descartado, sem derrubar a conexão). Mensagem de chat acima de 20.000 caracteres recebe **413** (pela API e pelo MCP `helios_enviar_mensagem`) e nada é gravado; até 20.000 vai inteira, sem truncar. `POST /api/livecoding` sem descrição (vazia, só espaços ou que não seja texto) recebe **400**.

## Segurança: correções da auditoria de 25/10/2026

- **Ferramentas do agente (SDK):** todo agente local abre com `tools: ["mcp"]` (só as ferramentas do HELIOS, que passam pelo cartão) e `disallowedTools` para `shell`, `edit`, `delete`, `applyAgentDiff`, `task`, `webFetch`, `webSearch` e `generateImage` (`server/sdk-safety.js`). O agente que só planeja o livecoding não recebe ferramenta nenhuma. Esse plano é um roteiro na pílula: não cria pasta de aula, não grava `PLANO.md` e não abre o VS Code. As restrições não são gravadas na sessão, então valem também em `Agent.resume`. O HELIOS pede o sandbox do SDK (`sandboxOptions.enabled`). Se o SDK responder que o isolamento não existe neste computador — no Windows isso acontece sem `~/.cursor/sandbox.json` —, a mesma sessão segue sem sandbox, a tela Autonomia avisa em uma linha e o motivo vai para `%APPDATA%\HELIOS\logs\helios.log`. Cartões, autonomia e a trava de pagar/preencher login em “Pedir antes” não mudam.
- **Cartão com a ação real:** o cartão mostra o conector e os argumentos (chaves como `token`, `senha` e valores que parecem segredo aparecem como `[segredo]`), o arquivo e o começo do conteúdo, ou o caminho a apagar. O que roda é exatamente o que foi aprovado: o cartão guarda uma impressão digital (sha256) da ação e do texto mostrado, e aprovar recusa se algo mudou depois.
- **`helios_acao` não aceita `mcp`, `loginId` nem `conteudo`:** só `tipo`, `resumo`, `alvo` e `texto`. Escrever e preencher login têm ferramentas próprias. Ao executar um conector, o HELIOS reconfere a lista de conectores do assistente e se a ferramenta ainda existe.
- **Rotinas:** `agendar_rotina` vira cartão de aprovação. Limites em Atividade › Limites: máximo de rotinas (`rotinasMax`, padrão 20) e intervalo mínimo para rotinas criadas pelo bot (`rotinaIntervaloMin`, padrão 15 min).
- **Teto global de gasto:** `usoGlobalChamadasDia` (padrão 500 chamadas por dia, somando todos os assistentes; 0 desliga). Aparece em Atividade › Limites e em `/api/uso`.
- **Classificador que falha fechado:** só vira "ler" (automático) uma ferramenta cujo verbo é de leitura conhecido. Nome desconhecido ou que executa, aprova, autentica ou instala sempre pede cartão, mesmo com a Autonomia liberada.
- **Credenciais de conectores MCP** (`env` e `headers`) ficam cifradas com o `safeStorage` do cofre (`secretsEnc` no `mcp.json`); o arquivo antigo em texto aberto é migrado ao abrir. Os valores nunca vão para a tela. Se o Windows não conseguir abrir o bloco, o conector fica bloqueado e o bloco cifrado é preservado.
- **Electron empacotado:** fuses `runAsNode`, `enableNodeOptionsEnvironmentVariable` e `enableNodeCliInspectArguments` desligadas; `enableEmbeddedAsarIntegrityValidation` e `onlyLoadAppFromAsar` ligadas (só valem no instalador; ainda não conferido num build real). **Assinatura de código** precisa de um certificado e não foi feita.
- **Outros:** `escrever`/`apagar` resolvem o caminho real (junction/symlink não escapam da pasta de projetos nem `:` de fluxo alternativo); o cartão de login avisa que vale a janela em foco; só páginas dentro de `renderer/` podem chamar os canais IPC e navegar (`src/ipc-guard.js`); `/mcp` confere o token antes de ler o corpo; o livecoding recusa arquivos e pastas ocultos.
- **Testes:** `test/seguranca-aprovacao.test.js` e `test/seguranca-sistema.test.js`.
## Orquestração: ajudantes, consultas e contexto

Modelo mental: o assistente principal é o corpo de um assunto; os **ajudantes** são braços efêmeros, um por tarefa.

- **`criar_ajudante(tarefa, instrucoes_curtas, ferramentas_permitidas?)`.** Abre uma sessão nova só com a tarefa (sem histórico nem memória do pai) e devolve um relatório curto padronizado (`FEITO`, `ACHEI`, `PENDENTE`; “nada encontrado” vale), de no máximo 1500 caracteres. Depois a sessão é descartada, e o assistente principal decide o próximo ajudante. O ajudante recebe no máximo as ferramentas do pai e nunca as de gestão (memória, rotinas, criar assistente, arquivar). Pagar e preencher login continuam “Pedir antes”. Aprovações de um ajudante aparecem na Caixa de entrada como “ajudante de <assistente>”, e o ajudante herda no máximo a autonomia do pai.
- **`consultar_assistente(assistente, pergunta)`.** Sessão nova no contexto do outro assistente (perfil, memória e contexto ativo dele), resposta curta. Consulta a si mesmo, ciclo (A→B→A) e correntes além do limite são bloqueados com mensagem em português.
- **`criar_assistente(nome, funcao, instrucoes, conectores?)`.** Gera um **pedido de aprovação** na Caixa de entrada: o assistente só passa a existir (e a aparecer na lista) depois de você aprovar. Fica marcado “criado por <pai>”, nunca herda mais conectores nem autonomia que o pai, e pagar/preencher seguem travados. Assistente criado por bot não cria outro (profundidade 1).
- **Contexto por assistente.** Cada assistente tem um contexto ativo (`contexto[-id].json`) e um arquivo (`arquivo[-id].json`). `contexto_registrar` e `arquivar_item(item, motivo)` mantêm o ativo enxuto, e a compactação move os itens mais antigos para o arquivo até caber no limite (padrão 6000 caracteres). O arquivo nunca entra no prompt: só a ferramenta `buscar_arquivo`, sob demanda, lê dele. Segredos são recusados.
- **Resumo corrido.** Passando de N mensagens ou M caracteres, a conversa vira “resumo + últimas mensagens” e o chip “contexto resumido” aparece no topo da conversa (com o resumo na dica). Limitação do SDK: uma sessão já aberta guarda o próprio histórico e não dá para encurtá-la; por isso, quando o resumo é atualizado, o HELIOS abre uma sessão nova do agente. Entre uma atualização e outra a sessão cresce. Em modo demonstração o resumo é extrativo (sem modelo).
- **Aba Atividade.** Lista os ajudantes (ativos e recentes, com tarefa, assistente-pai, duração e estado) com o botão **Encerrar**, os contadores, o tamanho do contexto de cada assistente com **Compactar agora**, e o editor de limites.
- **Custo aproximado.** Contagem de ajudantes e consultas por assistente. Tokens só aparecem quando o SDK informa o uso da execução (nem sempre informa; o modo demonstração nunca informa), e a tela diz quando são só contagens. Os contadores por conversa (ajudantes e consultas) zeram ao reiniciar o aplicativo.
- **Limites** (`orquestracao.json`, editáveis na aba; padrão, mínimo e máximo): ajudantes simultâneos 3 (1–20); profundidade 1 (1–2); ajudantes por conversa 10; tempo máximo por ajudante 120 s; consultas encadeadas 2; assistentes criados por bots 5; resumo após 24 mensagens ou 12000 caracteres; contexto ativo 6000 caracteres. Ao estourar, o agente recebe um erro claro em português.
- **MCP local.** Só leitura: `helios_listar_ajudantes`. Nada cria, encerra ajudante ou assistente pelo MCP.

## Prompt padrão e briefing

- **Modelo padrão (`server/prompt-template.js`).** Todo prompt (assistente, consulta, ajudante e verificador) sai do mesmo montador, com as seções sempre na mesma ordem: papel, contexto, regras e limites, formato de saída e objetivo (o pedido do momento fica por último). O prompt do assistente e o da consulta continuam idênticos aos de antes; o do ajudante e o do verificador ganham títulos fixos (`## Papel`, `## Contexto`, `## Regras e limites`, `## Formato de saída`, `## Tarefa do ajudante`).
- **Briefing de 4 campos.** `criar_ajudante` exige `pergunta` (o que responder), `fontes` (onde procurar), `formato` (como entregar) e `fronteira` (o que NÃO fazer e onde parar), além da `tarefa`. Se faltar um (ou vier curto demais), a ferramenta devolve um erro claro em português e **nada é executado nem contado** nos limites. O briefing entra no prompt do ajudante: pergunta e fontes em "Contexto", fronteira em "Regras e limites", formato em "Formato de saída".
- **Registro de fontes (`registro-fontes.json`).** O relatório do ajudante termina com as afirmações separadas em **acordadas** (fonte primária ou fontes que concordam), **contestadas** (fontes divergem) e **não verificadas** (sem fonte ou só o ajudante afirma), cada uma com a fonte (`- afirmação | fonte`). Afirmação "acordada" ou "contestada" sem fonte vira "não verificada". O assistente principal recebe um resumo junto do relatório e lê o detalhe com `registro_fontes`; a aba Atividade mostra "Registro de fontes: N acordadas · N contestadas · N não verificadas" em cada ajudante (abre para ver as afirmações). Leitura por API: `GET /api/registro-fontes` e `GET /api/registro-fontes/:id`. Guarda só texto curto, já sem segredos; mantém os últimos 100 registros.
- **Verificador independente (opcional, desligado por padrão).** Afirmações marcadas `[IMPORTANTE]` começam como `needs_validation`. Com o limite "Verificador independente" ligado (Atividade › Limites, 0 ou 1), o assistente pode chamar `verificar_afirmacao(registro, afirmacao)`: **um** outro ajudante, só com pesquisa e diferente de quem achou, tenta desmentir e o registro passa para `confirmed`, `rejected` ou continua `needs_validation`. Nada roda sozinho: cada verificação é uma chamada explícita, conta como um ajudante nos limites e pode ser encerrada na aba Atividade.

## Novidades de autonomia, uso e reunião

### Princípio: o assistente nunca recebe a credencial, só pede o preenchimento ao app
Segredos nunca vão ao modelo nem a logs. Pagar e preencher login continuam travados em "Pedir antes": o assistente só pede o preenchimento, e quem usa a credencial é o app, nunca o modelo. Texto com cara de segredo (chave, senha, e-mail) é recusado antes de ir a qualquer prompt, inclusive no contexto da reunião e no glossário.

### Estacionar uma tarefa
Quando falta uma decisão sua, o assistente chama `estacionar_tarefa` em vez de ficar parado: salva objetivo, o que já foi feito, o que falta e o motivo (`estacionadas.json`) e abre uma pergunta na Caixa de entrada. Ajudantes que estouram o tempo também estacionam sozinhos. Responder "Retomar" (ou deixar em branco) continua de onde parou. Lista: `GET /api/estacionadas`.

### Aprovações que expiram
Cartões de aprovação vindos de rotinas e ajudantes valem por 10 minutos (limite `aprovacaoExpiraMin`, de 1 a 1440, em `orquestracao.json`). Depois viram "Expirados" na Caixa de entrada, com **Reabrir** ou **Descartar**. Conversas que você está usando nunca expiram. Itens expirados há mais de 7 dias somem.

### Bot rascunha, humano envia, paga e apaga
Em rotinas e ajudantes, enviar, apagar e publicar sempre pedem aprovação, mesmo se o assistente estiver em "sozinho". Há uma caixa em Autonomia, "Rotinas e ajudantes", para desligar isso (`automaticoPede`). Pagar e preencher login não têm essa opção: ficam sempre travados.

### Painel de uso
Em Atividade, o "Painel de uso" mostra por assistente as chamadas, ajudantes, consultas, resumos, caracteres e tempo de hoje e no total (`uso.json`). Você pode definir um limite de chamadas por dia e/ou de tokens por dia, com alerta em 80% e, se quiser, bloqueio ao chegar no limite (0 = sem limite). O uso é aproximado: tokens só entram quando o SDK os informa. Rotas: `GET /api/uso`, `POST /api/uso/:id/limite`.

### Chefe de gabinete (só sugere)
O botão "Quem cuida disso?" na conversa, a rota `POST /api/roteador` e a ferramenta MCP `helios_sugerir_assistente` indicam qual assistente combina com o pedido (nome, função, instruções e dicas dos modelos), com confiança, motivo e alternativas. Não cria conversa nem executa nada sozinho; "Abrir conversa com X" é um clique seu.

### Modo reunião: traduzir passando o contexto
- **Contexto da reunião**: campo na aba Chat (vaga, empresa, assunto). Pode ser editado antes e durante a reunião e vai junto na tradução, nas respostas, no resumo e nas explicações.
- **Glossário**: `Documentos\HELIOS\glossario.md`, criado a partir de um modelo. Uma linha por termo (`termo = tradução`); só entram no prompt os termos que aparecem na fala. Também dá para editar em Configurações.
- **Falas anteriores**: as últimas N falas (0 a 6, padrão 3) seguem como contexto, marcadas para não serem traduzidas de novo.
- **Tom**: neutro, formal ou informal.
- **Velocidade**: o bloco de contexto tem teto de caracteres (300 a 3000, padrão 1200). Sem contexto nem glossário, o prompt é idêntico ao anterior.
- **2 opções (EN + PT)**: duas respostas possíveis, cada uma em inglês e português.
- **Pesquisar com contexto**: monta uma consulta do Google com o termo selecionado (ou o da última fala) e palavras do contexto. Só mostra a consulta; abrir no navegador é um clique seu.
## Fase 2: pacote de contexto (exportar, importar, fontes e pastas)

Tela **Contexto** (menu lateral). Serve para levar o seu contexto de uma conta/instalação para outra sem re-explicar tudo.

- **Exportar**: gera `helios-contexto-AAAA-MM-DD.json` (formato `helios-contexto`, `versao: 1`) com memória e contexto do padrão, assistentes (função e instruções, com a memória e o contexto de cada um), rotinas, preferências (só informativas), lista de conectores e conversas resumidas (opcional). **Nunca entram** o cofre, senhas, tokens, `env` nem cabeçalhos de conectores: dos conectores vão só o nome, o tipo, o comando, a URL sem parâmetros e os **nomes** das variáveis. Tudo passa pelo `redact()` (`server/util.js`) mais uma checagem extra de tokens longos (`server/secret-scan.js`); o que for mascarado vem avisado, e se ainda sobrar algo com cara de segredo a exportação é bloqueada.
- **Importar** (sempre aditivo): escolha o arquivo, veja a **prévia** (novo / duplicado / conflito / recusado / só informativo) e só então **Confirmar**. Nada seu é sobrescrito ou apagado; duplicados são ignorados; assistente com o mesmo nome e conteúdo diferente fica como está (há a opção de importar com o nome "... (importado)"). Segredos no pacote são recusados item a item. Rotinas entram **pausadas**, assistentes entram sem autonomia própria, autonomia e limites **não** são importados, conectores só viram uma lista "para configurar" (`conectores-sugeridos.json`) e conversas entram como uma conversa de consulta (resumo e trechos curtos, marcada como dado, não como instrução). O arquivo é validado (formato, versão, tamanho de 700 mil caracteres, chaves de caminho como `caminho`/`path`/`arquivo` e `__proto__` são rejeitados) e nada nele é executado.
- **Fontes só de leitura (ClickUp, e-mail)**: usa os conectores MCP que você já cadastrou. Só ferramentas classificadas como leitura (`classifyToolDetailed`) rodam; o resultado vira uma prévia de importação, como qualquer pacote. **Ponto de extensão**: `SOURCE_KINDS` em `server/context-sources.js` (um novo tipo é uma entrada com nome e palavras que reconhecem o conector).
- **Pastas permitidas do PC**: você escolhe a pasta no seletor do Windows (não há como informar um caminho por texto). Leitura e escrita só dentro dela, com a mesma checagem de caminho real da NV-3 (atalhos/junctions que levam para fora são recusados, também se a pasta for trocada depois). Raiz do disco, a pasta de dados do HELIOS (onde fica o cofre) e pastas do sistema são recusadas. **Apagar vai sempre para a Lixeira** (`shell.trashItem`); sem Lixeira, nada é apagado. Arquivos lidos passam pelo `redact()`.

Limites conhecidos: não há `.zip` (só JSON); as pastas permitidas e as fontes ainda não são ferramentas do assistente, só tela/API (`/api/pacote/*`, `/api/pastas/*`); o "apagar" de arquivos de **projetos** (`actions.js`) continua permanente, como antes, e o preview avisa disso.
## Fase 3: credenciais que o modelo nunca vê

Princípio: o assistente trabalha com **referências** (o nome ou o id de um login do cofre), nunca com o valor.

- **Referências opacas.** O prompt traz só os nomes dos logins (`vaultPrompt`/`agentIndex`); usuário, senha, tokens e chaves não entram. Um nome que pareça segredo também é mascarado.
- **Preencher só no processo local.** `helios_preencher_login` recebe só o nome, abre um cartão (sempre "pedir antes", irreversível) e, depois do seu OK, o processo principal digita usuário e senha na janela em foco. O valor não volta ao modelo: a resposta é só "Preenchi o login X".
- **Saídas de conectores.** A resposta de um conector MCP, as mensagens de erro e as descrições das ferramentas passam por `redact()` na origem (`mcp-registry`), antes de entrar no contexto, no histórico, nos logs ou no registro de fontes.
- **Valores conhecidos.** Senhas e tokens do cofre, chaves (Groq, Gemini, Cursor, token local) e os valores de env/headers com cara de segredo dos conectores ficam registrados **só em memória** (`server/secret-values.js`). Se qualquer um aparecer num texto que vai ao modelo, ao histórico, a um log ou a um cartão, o `redact()` o troca por `[segredo]`.
- **Segredo digitado no chat.** `screenUserText` mascara a mensagem antes de ela ir ao modelo e ao `conversations.json`, e a bolha mostra um aviso para guardar o segredo na aba Cofre. Vale para tudo o que entra por `bot.send`: chat, rotinas e o servidor MCP local.
- **Cofre na tela.** A edição de um item nunca mostra o valor salvo: só "definido". Não existe "revelar".
- **Montagem do prompt.** Assistente, memória, contexto, resumo e histórico passam por `redact()` na montagem final; a memória também recusa texto com cara de senha ou chave.

O que a Fase 3 **não** cobre: chave aleatória sem rótulo nem prefixo conhecido que o Helison digite no chat (a regra é por padrão); argumentos de ações de conector já gravados em conversas antigas (`action.mcp.args`); segredos que o próprio modelo invente; tela, clipboard e teclado do Windows durante o preenchimento (o texto passa pela área de transferência por décimos de segundo, como descrito em "Segurança: área de transferência"); e uma isolação por processo/sandbox por assistente (fica para a fase de sandbox).

Testes: `test/fase3-credenciais.test.js`.

## Modo reunião (duas abas)

Janela flutuante (`Ctrl+Shift+Espaço` abre/fecha; X e Esc também fecham e **param a captura de áudio**). Protegida contra captura de tela.

- **Reunião em português**: transcrição com falantes (Você = microfone, Outro(s) = áudio do PC), resumo, "O que eu digo?", explicar, pesquisa com contexto (somente leitura, com links de fonte) e chat. Tudo em português, sem tradução.
- **Reunião em inglês**: *Sugestão de resposta* (2 opções em inglês, com o português ao lado só para conferir), *Traduzir o que a outra pessoa disse* (só a tradução; o original fica escondido, com "Mostrar original") e o **Tradutor** (caixa embaixo: digita em português, Enter, inglês grande para ler em voz alta, copiar e histórico das últimas 5 frases).
- Motor: Groq (transcrição e texto). Bloco de áudio de 6 s (rápido). Se a Groq responder 429 (limite), o HELIOS avisa em português, sobe sozinho para blocos de 9 s só nesta sessão e tenta o mesmo áudio de novo.

### Otimizações do modo reunião (no repositório; ainda não instaladas)

- **Menos espera**: o bloco de áudio do PC é cortado cedo numa pausa de fala (depois de metade do bloco, no mínimo 3 s). O microfone, na pergunta por voz, fecha na pausa de cerca de 0,8 s (o mesmo fim de fala do modo conversa), sem esperar essa metade. A Groq é "aquecida" ao iniciar; lotes de tradução de até 3 falas; limite de tokens proporcional ao lote.
- **Streaming**: uma fala traduzida sozinha, a resposta do Tradutor e as respostas do chat aparecem palavra por palavra.
- **Sem retraduzir**: cache das últimas traduções (mesma frase não gasta nova chamada) e do Tradutor; fala já traduzida nunca volta para a fila; o resumo espera a tradução em andamento em vez de refazê-la; o bloco de contexto da reunião é reaproveitado enquanto nada muda.
- **429 da Groq**: espera curta (até 3 s, 2 tentativas) na transcrição; mesmo áudio reenviado uma vez; tradução pausa 8 s e tenta de novo (até 3 vezes por fala); aviso em português.
- **Silêncio e alucinação**: áudio minúsculo não é enviado; trechos de silêncio do Whisper são descartados; "Legendas pela comunidade Amara.org", "Thanks for watching", pontuação solta e palavra repetida não viram linha.
- **Limpeza ao fechar**: X, Esc, atalho e fechar a janela cancelam as chamadas em andamento na nuvem, limpam filas, temporizadores e trilhas de áudio.
- Conexão: reaproveita a conexão padrão do Electron (keep-alive) e faz uma chamada leve ao iniciar para abrir a conexão antes da primeira fala. Não há cliente HTTP próprio.
- **Livecoding (roteiro).** A aba pede o que construir e mostra, em português e com letra grande, a visão geral, a lista de arquivos (caminho e papel) e depois cada seção: o que ela faz, o porquê, o bloco de código e onde colar. **Próximo** e **Anterior** mudam a tela. Copiar o bloco é opcional. O único arquivo do recurso é o estado da sessão (`sessions.json`), para retomar. Os arquivos da aula não são gravados e nenhum editor é aberto. O agente que monta o roteiro continua sem ferramentas e em sandbox.
- **Tela enquanto escuta**: com a escuta ligada, o HELIOS atualiza o print sozinho, cerca de cada 2,5 s, só na memória. Não precisa dizer "vê a minha tela", nem usar Ctrl+Shift+Enter, nem confirmar prévia. Ao parar ou fechar, o print some. A pílula continua fora da captura. Sem a chave do Gemini, a pergunta segue sem a tela e a pílula avisa.
- **Pergunta por voz** (escuta ligada e microfone ativo): fale com naturalidade, por exemplo "como que eu respondo isso daqui?" ou "Helios, como que eu respondo isso daqui?". O HELIOS transcreve, usa a tela que já está atualizando e a resposta aparece **só como texto** no chat da pílula, no mesmo fluxo de quando você digita. Não há leitura em voz alta. Sem digitar, sem Enter e sem teclado. A escuta do microfone e do áudio do PC segue depois da resposta. O áudio não é gravado em disco.
- **Olhar a tela** (atalho ou ícone, opcional): ainda mostra uma prévia e só envia se você confirmar (Cancelar/Esc descartam). A pergunta por voz não usa esse caminho.
- Tempos por etapa (transcrição, tradução, resposta) aparecem discretos na barra de status.
- Modo demonstração sem chamadas de IA: `HELIOS_MOCK=1`.
- Roteiro de teste de 2 minutos: `Documents\HELIOS\teste-modo-reuniao.md`.

## Servidor MCP local

O Cursor e o Claude Code podem criar tarefa, listar e rodar rotina, buscar e ler conversa, consultar a memória e mandar mensagem ao chat do HELIOS sem abrir o painel. A ideia veio do [touri](https://github.com/touri-ai/touri) (Apache-2.0). Nenhum código desse projeto foi copiado.

O endereço é `http://127.0.0.1:47331/mcp` (troque a porta se você mudou nas configurações; a tela **Conta Cursor** mostra o endereço certo). O HELIOS gera um token de acesso e guarda no cofre, com DPAPI no Windows. Dá para ver, copiar e gerar outro nessa mesma tela. Sem criptografia do sistema, o token fica só na memória e a tela avisa.

Nenhuma ferramenta MCP lê senha, token do cofre ou chave de API. Pedido de enviar para fora, apagar, pagar ou publicar volta `pendente`, com o id do cartão. A decisão continua na janela do HELIOS. A chamada não executa a ação sozinha.

### Cursor

No `mcp.json` do Cursor:

```json
{
  "mcpServers": {
    "helios": {
      "url": "http://127.0.0.1:47331/mcp",
      "headers": {
        "Authorization": "Bearer COLE_O_TOKEN"
      }
    }
  }
}
```

### Claude Code

```json
{
  "mcpServers": {
    "helios": {
      "type": "http",
      "url": "http://127.0.0.1:47331/mcp",
      "headers": {
        "Authorization": "Bearer COLE_O_TOKEN"
      }
    }
  }
}
```

## Requisitos

- Windows 10 ou 11, 64 bits
- [Node.js 22](https://nodejs.org/)
- Uma conta Cursor. O caminho principal é entrar pelo navegador (login oficial do SDK). A chave em [cursor.com/dashboard/api](https://cursor.com/dashboard/api) é o plano B, se o site entrar mas não emitir a chave
- Chaves Groq e Gemini, se quiser transcrição, ditado e leitura de tela na reunião

## Rodar

```bash
npm install
copy .env.example .env
npm start
```

No `.env`, preencha só o que for usar. Na primeira abertura o HELIOS grava essas chaves no cofre e tira do ambiente do processo. O arquivo `.env` não entra no git.

```
CURSOR_API_KEY=
GROQ_API_KEY=
GEMINI_API_KEY=
HELIOS_PORT=47331
```

A aba **Conectores** é a galeria: busca, cartão com o logo e um botão **Conectar**. Quem usa o HELIOS não cola client id, chave, URL nem JSON nessa tela. A aba **Conta Cursor** continua aceitando a chave colada, como plano B. As chaves Groq e Gemini ficam no **Cofre** e nas configurações da pílula.

## Conectores

No topo, a busca. Em seguida, **Conectados** lista cada conta já ligada (Gmail — pessoal, Gmail — agenciaoasis) com renomear, reconectar, remover e **Adicionar outra conta**. A grade traz Gmail, Google Calendar, Google Drive, ClickUp, GitHub, Figma, Notion, Slack, Linear e Cursor. **Conectar** abre o navegador. Quando a pessoa volta, o cartão passa a **Conectado** sozinho. Enquanto espera, o botão fica **Conectando…**. Sessão vencida vira **reautenticar**. Falha mostra uma frase curta, sem jargão.

O retorno do OAuth é `http://127.0.0.1`, no caminho `/callback`. O token e o refresh ficam cifrados no mesmo cofre (DPAPI no Windows). `conectores.json` guarda o blob, não o texto. A API local não devolve token nem client id. Sem criptografia do sistema, o acesso fica só na memória daquela sessão. O refresh é automático quando o acesso vence em menos de um minuto. O cabeçalho `Authorization` do MCP http entra na hora da chamada e não é gravado no `mcp.json`. Um fluxo ainda no navegador vive só na memória. Fechar o HELIOS no meio cancela essa tentativa.

O link **Avançado**, discreto no fim da tela, abre um conector personalizado: nome e URL de um MCP. O resto da grade não tem esse campo.

**Onde colar o client id (uma vez, quem monta o HELIOS).** O Google e o GitHub não deixam o aplicativo se cadastrar sozinho. O usuário final não vê esse campo. Preencha `config/oauth-clients.json` antes de `npm run dist:win` (o arquivo entra no instalador). Para experimentar sem gerar outro instalador, o mesmo JSON em `%APPDATA%\HELIOS\oauth-clients.json` vale mais que o do build. Variável de ambiente vale mais que os dois: `HELIOS_GOOGLE_CLIENT_ID` e `HELIOS_GITHUB_CLIENT_ID`. Enquanto o id daquele serviço estiver vazio, o cartão mostra **Em breve** e a linha “configuração do app pendente”. Não cole client secret do Google nem do GitHub. Se o valor não tiver o formato certo, o HELIOS ignora e o cartão continua em breve.

**Google (Gmail, Calendar e Drive usam o mesmo id).**

1. Em [Google Cloud Console](https://console.cloud.google.com/), crie ou escolha um projeto.
2. Ative as APIs Gmail, Google Calendar e Google Drive.
3. Em **APIs e serviços → Tela de consentimento OAuth**, configure o app (externo serve para as contas que vão entrar).
4. Em **Credenciais → Criar credenciais → ID do cliente OAuth**, escolha o tipo **Computador** (Desktop).
5. Copie só o **ID do cliente**. Ele termina em `.apps.googleusercontent.com`. Cole em `"google"` no JSON. Não cole o segredo: o retorno é PKCE em `127.0.0.1`, com `access_type=offline` e `prompt=consent`.
6. Os escopos pedidos são só leitura: `gmail.readonly`, `calendar.readonly` e `drive.readonly`, mais `openid` e `email`.

**GitHub.**

1. Em GitHub, **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Homepage URL pode ser `http://127.0.0.1`.
3. Authorization callback URL, exatamente: `http://127.0.0.1:47332/callback`. A porta é fixa para esse cadastro valer sempre.
4. Copie só o **Client ID** para `"github"`. Não cole o client secret. O HELIOS entra pelo navegador com PKCE. Escopos: `read:user`, `user:email` e `repo`.

**Cursor.** **Conectar** chama `Cursor.auth.login` do `@cursor/sdk`, o mesmo PKCE do `cursor-agent`, e abre `https://cursor.com/loginDeepControl`. O endereço só abre se for `https`, sem o parâmetro de demonstração. A chave fica no cofre do HELIOS (`store: null`). Sem uma chave de verdade o chat continua em demonstração. O `zod` entra como dependência direta porque o SDK o exige e o empacotador não copia peer dependency; sem isso o app instalado não carregava o SDK e caía na página de chaves. Os pacotes `@cursor/sdk` e `@cursor/sdk-*` (o nativo `sdk-win32-x64` no Windows) saem do asar junto com `zod`, `@bufbuild/protobuf` e `@connectrpc/connect`, para o `require` achar tudo no disco. Se a entrada falhar, o cartão mostra o erro com o código e **não** abre `https://cursor.com/dashboard/api` sozinho: isso só acontece no botão **Abrir página de chaves**. O mesmo erro vai para `%APPDATA%\HELIOS\logs\helios.log`. `HELIOS_MOCK=1` não abre o site real.

**ClickUp e Linear.** Cadastro dinâmico de cliente público e PKCE. Escopos `read` e `write`. Não precisam de id no JSON.

**Figma.** O cadastro dinâmico existe, mas a Figma restringe o MCP a clientes do catálogo. Se recusar, o cartão fica em erro e nada é marcado como conectado. Um segredo devolvido no cadastro fica cifrado no cofre.

**Notion.** O preset aponta para `https://mcp.notion.com/mcp` e descobre os endereços na hora. A descoberta pode responder 403. O cartão mostra que o serviço recusou. Nenhum endpoint é inventado.

**Slack.** O servidor não tem cadastro dinâmico e o token exige client secret (`client_secret_post`). Por isso o cartão fica **Em breve** até existirem `"slack"` e `"slackSecret"` no mesmo JSON (ou `HELIOS_SLACK_CLIENT_ID` e `HELIOS_SLACK_CLIENT_SECRET`). O segredo não aparece na tela nem na API. Não commite o `slackSecret` preenchido; prefira o arquivo em `%APPDATA%\HELIOS` ou a variável de ambiente.

Atalhos do modo de reunião:

| Atalho | Ação |
| --- | --- |
| Ctrl+Shift+Espaço | Mostrar ou ocultar a pílula |
| Ctrl+Shift+R | Começar ou parar de ouvir |
| Ctrl+Shift+1 | Sugerir resposta em inglês |
| Ctrl+Shift+2 | Sugerir resposta em português |
| Ctrl+Shift+3 | Traduzir |
| Ctrl+Shift+A | Perguntar (digitar) |
| Ctrl+Shift+Enter | Olhar a tela na hora (opcional; com a escuta ligada a tela já atualiza sozinha) |
| Ctrl+Shift+T | Deixar o clique passar pela pílula |
| Ctrl+Shift+setas | Mover a pílula |

Com a escuta ligada, a tela fica disponível sozinha. Fale a pergunta. A resposta aparece só em texto na pílula, sem leitura em voz, sem Enter e sem confirmação de print.

Fechar a janela principal manda o HELIOS para a bandeja. Sair de verdade é pelo menu da bandeja. **Fechar modo de reunião**, na pílula, esconde só essa janela.

## Instalador

```bash
npm run dist:win
```

O instalador sai em `release/HELIOS-Setup-0.1.0.exe`. Ele cria atalho na área de trabalho e no menu Iniciar. Desinstalar não apaga `%APPDATA%\HELIOS`.

## Testes

```bash
npm test
npm run lint
npm run check
```

`npm test` cobre o roteamento Auto, a memória, a pesquisa, o cofre sem vazar senha, o MCP de exemplo, o roteiro do livecoding, o ditado, as skills, o time, o digest da manhã, a proteção da pílula, o login do Cursor e o OAuth da galeria (mock). Não precisa de chave de API.

## Ditado, skills, time e manhã

**Ditado.** Em Ditado, o atalho padrão é `Ctrl+Shift+D` (`CommandOrControl+Shift+D`) e começa desligado. O modo alternar liga e desliga. Segurar a tecla só é observado no Windows, e só enquanto a gravação dura; em outro sistema o mesmo atalho alterna e a tela avisa. Uma janela escondida, sem foco e sem `setContentProtection` (isso continua só na pílula), usa o microfone. A chave da Groq fica no cofre. A limpeza de vícios, pontuação, glossário e atalhos de texto é local: o áudio não faz uma segunda viagem para um modelo. O texto entra na janela em foco pelo mesmo caminho protegido do preenchimento de login (formatos de histórico, nuvem e monitor, e a área de transferência é limpa). O que foi dito não entra em log, no histórico do chat nem na estatística. A estatística guarda palavras, correções, duração e o nome do processo, nunca o título da janela. Esses formatos de área de transferência são um pedido: um programa que leia a área nesses décimos de segundo ainda vê o texto.

**Skills.** Cada skill é texto. A importação mostra a prévia, mascara segredo, recusa caminho fora da pasta, nome oculto, `__proto__` e arquivo executável (`.exe`, `.ps1`, `.js`, `.bat`, `.cmd`, `.sh`, `.dll`). Nada é executado. `ler_skill` existe só na conversa do assistente, não no ajudante, e não aumenta ferramenta nem autonomia. O catálogo só entra no prompt quando existe skill. A skill de exemplo “página Oasis” é um texto original e só entra se você instalar. Apagar um assistente solta as skills dele para o conjunto geral. O pacote de contexto não exporta skills.

**Montar time.** A tela pergunta o objetivo e sugere modelos que já existem (os seis da tela Assistentes). Um pedido vago sugere caixa de entrada, agenda e pesquisa. Nota fiscal, logística e marketplace não viram assistente: a tela avisa. Criar é o clique em “Criar os marcados”, o mesmo efeito de criar pelo formulário. Um assistente proposto por outro bot continua no cartão.

**Digest da manhã.** O modelo `digest-manha` entra pausado, às 08:00, com a conversa marcada só leitura. Antes de a mensagem seguir, o servidor trava as ferramentas de efeito (`helios_acao`, gravar arquivo, preencher login, rotina, livecoding, criar assistente ou ajudante). Conector só roda se a ferramenta já for conhecida como leitura e não exigir cartão; no resto, falha fechada. Um ajudante dessa conversa herda o só leitura. O texto do pedido evita as palavras que o modo demonstração usaria para fingir uma aprovação.

## Visual

O canvas é quente (ouro, âmbar, amanhecer) com o teal de contraste. A barra de título continua nos hexadecimais fixos (`#0a0a0a` / `#fafafa` no escuro e o inverso no claro): o teste da barra não segue o canvas. O logo gira devagar enquanto o HELIOS pensa. Ouvir ou falar (voz do chat e ditado) acende um halo. Trocar de tela entra como um amanhecer. Uma barra fina no topo acompanha o pensamento. A pílula usa o mesmo ouro e o ponto ao vivo pulsa em ouro, sem mexer em `setContentProtection`. As animações são `transform` e `opacity`. `prefers-reduced-motion` desliga o movimento. A bolha do chat não anima a cada mensagem porque a conversa redesenha a cada meio segundo.

## Fora de escopo

Ficou de fora, de propósito: embutir Handy ou FluidVoice; o scrolljacking e o motion de marketing do Homerun; Higgsfield como conector embutido; um pacote completo de e-commerce (nota fiscal, logística, marketplace) como assistentes novos; o ciclo Plan→Deploy do pstack; clonar skills da comunidade por git (a importação é colar texto, sem rede e sem execução); uma segunda passagem de modelo para limpar o ditado; trocar o estilo do ditado sozinho conforme o aplicativo da frente (o estilo é escolha sua; o nome do processo é só estatística).

`test/seguranca.test.js` cobre o cofre ilegível, a área de transferência, o ambiente do MCP stdio e os limites de tamanho. Um teste dele, desligado por padrão, usa a área de transferência real do Windows (`HELIOS_TESTE_AREA=1 npm test`); ele troca o conteúdo da área de transferência.

`HELIOS_NO_PROTECT=1` desliga a exclusão de captura. Serve só para gravar a própria tela em desenvolvimento. No uso normal, deixe desligado.
