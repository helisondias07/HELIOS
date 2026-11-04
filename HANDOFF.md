
## Estado atual — 03/11/2026

O trabalho continuou além da Leva R2. A referência completa está em
`docs/operacao/HANDOFF.md`; este arquivo é apenas o ponto de entrada.

- Chefe operacional conectado ao runtime de agentes e aos modelos grátis quando há chave disponível.
- Agentes autônomos têm navegador, PowerShell, leitura/escrita/edição de arquivos, pesquisa web, memória, MCP e cartões de aprovação.
- Ferramentas MCP respeitam allowlist por assistente e classificação de risco; leitura pode ser automática e escrita/envio/exclusão/publicação pode pedir decisão.
- Candidaturas usam máquina de estados e só registram envio com evidência do site; o modo automático envia, enquanto o fluxo aprovado para antes do envio para revisão.
- Os snapshots `.backup-*` foram removidos da raiz e preservados em `C:\Users\HelisonDias\Repositorios\HELIOS-archive\`.
- Após uma nova alteração, repetir `npm test`, `npm run lint`, `npm run check`, gerar o instalador e reinstalar o HELIOS; nesta Leva V2, os testes dirigidos, lint/check, build e reinstalação já foram feitos.

## Leva V2 — rodada manual completa de Vagas (03/11/2026)

- O agente Vagas ganhou `completa:true` em `/api/agente/vagas/ciclo`. Essa execução manual não depende dos horários já consumidos no dia: cobre as fontes de leitura do LinkedIn (`feed`, `salvos`, `notificacoes` e `busca`) e a busca agregada das plataformas.
- Foi incluído um disparo operacional explícito no processo principal (`HELIOS_FORCE_VAGAS=1`, com `HELIOS_FORCE_VAGAS_REPORT` para o caminho do relatório). O token permanece somente no processo principal; o arquivo de relatório contém apenas contagens, plataformas, estados, críticas, falhas e resumo do Chefe.
- O relatório solicitado pelo Helison deve ser considerado válido somente quando `work/force-vagas-report.json` estiver com `ok:true`. O arquivo atualmente contém apenas a tentativa auxiliar anterior, que falhou por não conseguir decifrar o cofre fora do processo principal; isso não é resultado de busca e não deve ser apresentado como tal.
- Testes após a alteração: `node --test test/levaO3.test.js` — 10 pass, 0 fail; `npm run lint` — verde; `npm run check` — verde; `npm run dist:win` — instalador gerado com sucesso.
- Instalador gerado em `release\HELIOS-Setup-0.1.0.exe` e reinstalado silenciosamente. O app instalado foi iniciado com o disparo operacional explícito, mas a rodada ainda não foi confirmada por relatório válido quando esta atualização foi feita.
- A tentativa de usar um processo Electron auxiliar foi abandonada: o cofre usa DPAPI/safeStorage e só o processo principal do app deve executar a rodada real. Não reutilizar esse auxiliar para inferir token ou resultado.
- Pendência imediata para a próxima sessão: ler `work\force-vagas-report.json`; se `ok:true`, entregar ao Helison as contagens de encontradas, plataformas, inscrições confirmadas, críticas (CAPTCHA/2FA/login) e falhas. Se não houver `ok:true`, verificar o log/processo principal e repetir o disparo pelo app instalado, sem declarar candidaturas realizadas.

## Leva V — operação contínua e modelos grátis (03/11/2026)
- O modo operacional do app inicia Chefe e Vagas ativos em instalações novas; uma pausa salva pelo Helison continua vencendo.
- O app instala uma rotina persistente `Vagas: operação contínua` a cada 30 minutos. Ela chama o ciclo real de LinkedIn/plataformas e depois processa a fila automática.
- O resultado de cada candidatura preserva via, modelo, estado e evidências também nos casos críticos.
- O executor de formulário ganhou fallback para botões Gupy modernos, `shadowRoot`, atributos `data-testid`/`data-qa` e submits dentro de formulário visível.
- Em produção, Chefe/Vagas/Pesquisa não caem silenciosamente no Cursor: usam o worker grátis; sem chave grátis, o estado fica explicitamente indisponível para correção no cofre.
- Validação anterior da leva: 624 testes, 623 pass, 0 fail, 1 skip; lint e `npm run check` verdes. A Leva V2 adicionou um teste dirigido (10/10); a suíte completa pós-V2 ainda deve ser rodada na próxima sessão se for necessária uma contagem global final.

## Leva V3 — diagnóstico do ciclo contínuo e fila do Chefe (03/11/2026)

- A causa dos cartões `Aprovar inscrição ... (0/20 revisões)` foi identificada: eram itens históricos do `quadro.sqlite` com `status: cancelado`, criados antes do modo automático. O renderer do Chefe agora não exibe itens cancelados.
- O Chefe não reabre mais um pedido quando recebe `resultado` ou `achado` de um agente. Esses retornos são encerrados como `feito`, eliminando o ciclo duplicado `achado → Chefe → Vagas`.
- A rotina persistente `Vagas: operação contínua` agora chama `agentVagas.ciclo({ completa: true })`, permitindo nova busca mesmo depois dos slots diários já consumidos, sempre respeitando o limite operacional por hora.
- Estado esperado: `pausado:false`, `modo:automatico`, `revisoesNecessarias:0`; o Chefe opera em `operacional; só bloqueios críticos pedem você`.
- Os bloqueios reais restantes são CAPTCHA, formulário sem botão/campo reconhecido, sessão/login ausente e repetição da mesma empresa em 30 dias. Sem evidência do site, o HELIOS não conta a inscrição como enviada.
- Validação final desta correção: `npm test` — 627 testes, 626 pass, 0 fail, 1 skip; `npm run lint` — verde; `npm run check` — `HELIOS ok`. O instalador foi gerado e reinstalado em `C:\Program Files\HELIOS\HELIOS.exe`.
- O disparo diagnóstico `HELIOS_FORCE_VAGAS` foi tentado após a reinstalação, mas não gerou um relatório novo; o arquivo antigo continua sendo inválido. Não tratar isso como rodada real. O próximo teste operacional deve ser iniciado pela própria UI/servidor da instância principal, não por uma segunda instância Electron.
- Snapshot após a reinstalação: Vagas `automatico`, não pausado, 2 itens `nova`, 6 `critica` e 2 `falhou`. As críticas atuais são principalmente botão/campo não reconhecido; uma é CAPTCHA. As falhas indicam envio interrompido/app fechado e devem ser conferidas no site antes de qualquer repetição.

## Leva V4 — orquestração monitorada e diagnóstico real (03/11/2026)

- O disparo operacional agora aceita `--force-vagas` na instância principal, além da variável anterior, e grava checkpoints desde o início em `work\force-vagas-report-*.json`.
- O carregamento de páginas do navegador de vagas ganhou timeout de 30 segundos e retorna `timeout/carregamento` em vez de deixar o ciclo pendurado indefinidamente.
- A fila automática ganhou diagnóstico por vaga (`candidatura_recente_na_vaga_ou_empresa`, empresa evitada, nota mínima ou limite por hora), para o Chefe não mostrar apenas “fila vazia”.
- Rodada v6 concluída: LinkedIn `feed`, `salvos`, `notificacoes` e `busca` executados; 0 novas vagas; plataformas executadas com erro `Remotar: HTTP 404`; 2 vagas Quality Digital ficaram fora da fila por candidatura recente; 0 inscrições confirmadas.
- Os bloqueios antigos registrados continuam: botão/campo de formulário não reconhecido, CAPTCHA e envios interrompidos. CAPTCHA não deve ser burlado; o comportamento correto é detectar, mostrar a janela e pedir que Helison resolva, mantendo o restante do ciclo.
- Relatório sanitizado da rodada: `work\force-vagas-report-v6-run.json`. Não contém token nem credenciais.

## Leva R2 (2026-11-02)
- Cadeia: chefe/vagas = nemotron-3-ultra; reservas minimax→lightning→glm→deepseek→kimi; Gemini; Cursor. Timeout 45 s.
- Chefe usa free-llm (agent chefe) com fallback; sem chave → regras. Prompt sem PII.
- planFillLlm ligado em jobs-host (vaga aprovada; para antes de enviar; fallback planFill). freeLlm injetável; main.js lê nvidia/gemini do vault.
- Testes: test/levaR2.test.js. Backup: .backup-levaR2\. Doc: docs/operacao/leva-r-modelos-gratis.md (seção Leva R2).

## Leva R
- Feito: server/free-llm.js, server/fill-privacy.js, test/free-llm.test.js, cofre nvidia, rota /api/llm-gratis/status.
- R2 ligou planFillLlm no jobs-host e o Chefe no roteador gratis.

- Reinstalação e chave no cofre ficam para a reinstalação única (junto com a correção da Gupy). Instalador de 23:00 já está desatualizado (free-llm mudou depois).

## Leva V5 — navegação visual real de vagas e ciclo monitorado (03/11/2026)

### Diagnóstico confirmado

- O ciclo anterior não estava fazendo a busca visual completa nas plataformas. O caminho de plataformas chamava `GET /api/vagas/prefs`, rota inexistente; o fallback do servidor interpretava `prefs` como ID de vaga e retornava `Vaga não encontrada.`.
- O LinkedIn carregava páginas, mas os seletores antigos eram estreitos e não registravam diagnósticos suficientes. A busca de vagas retornava links, mas feed/salvos/notificações podiam virar falso zero.
- Publicações salvas (`/my-items/saved-posts/`) e vagas salvas são áreas distintas. A conta usada na rodada redirecionou `/my-items/saved-jobs/` para `/jobs-tracker/`, sem links de vagas expostos; isso ficou registrado como diagnóstico, não como “nenhuma vaga existe”.
- O filtro do servidor exigia igualdade literal do termo (“desenvolvedor front-end”), descartando variações legítimas (“front end”, hífen e texto localizado). A ingestão do navegador agora confia no resultado da busca feita na página e registra o termo para auditoria.

### Alterações implementadas

- `src/jobs-host.js`: busca visual em LinkedIn/Gupy com campo de busca, clique/Enter, rolagem humana, captura de cards/links, HTML limitado e diagnóstico de URL/título/contagem. A captura é feita no navegador persistente; o POST local serve apenas para armazenar e pontuar o que o navegador viu.
- `src/jobs-host.js`: o ciclo LinkedIn agora cobre feed, publicações salvas, vagas salvas, notificações e busca por palavras-chave. Links diretos `/linkedin.com/jobs/view/` em feed/publicações salvas podem alimentar a fila.
- `server/index.js` + `server/jobs.js`: criada a ingestão local `/api/vagas/ingest-browser`, com parser da plataforma, deduplicação, compatibilidade com o perfil e persistência na mesma fila automática.
- `server/agent-vagas.js`: a rodada completa inclui a nova fonte de vagas salvas; o Chefe continua em modo automático, sem `0/20` e sem reabrir resultados como aprovações.
- `src/jobs-host.js`: login da fila automática passou a usar modo silencioso com timeout de 45 s. O HELIOS ainda tenta preencher 2FA por e-mail pelo MCP, mas CAPTCHA/login Google/timeout viram bloqueio daquela vaga e a fila segue para as demais, sem deixar o relatório pendurado.
- Também corrigido o leitor de preferências de `preencherAprovada`, que usava a mesma rota inexistente `/api/vagas/prefs`.

### Rodadas reais

- `work\force-vagas-report-browser-v7.json`: execução anterior ainda usava o caminho antigo; confirmou que LinkedIn carregava, mas plataformas falhava com `Vaga não encontrada.`.
- `work\force-vagas-report-browser-v8.json`: executado pela versão instalada após a correção da busca visual. LinkedIn: 10 links na busca; busca visual capturou 5 novas. Gupy: 10 cards capturados e 6 novas. Total: 11 novas vagas, 0 erros de coleta, 0 inscrições confirmadas nessa rodada inicial. A fila automática iniciou e registrou bloqueios antigos por candidatura recente.
- `work\force-vagas-report-browser-v9.json`: executado após o ajuste do login silencioso e reinstalação. Como as vagas da v8 já estavam persistidas, foram 0 novas por deduplicação; 0 inscrições confirmadas; 1 novo bloqueio por não localizar com segurança o próximo botão do formulário; 4 vagas permaneceram na fila. O Chefe fechou o ciclo com `ok:true`.
- A v8 é a evidência da descoberta visual; a v9 é a evidência do fechamento do executor sem ficar preso no login. Nenhuma candidatura é chamada de enviada sem estado `enviada` e evidência do site.

### Validação e instalação

- `npm test`: 627 testes, 626 pass, 0 fail, 1 skip.
- `npm run lint`: verde.
- `npm run check`: `HELIOS ok`.
- `npm run dist:win`: verde.
- Instalador final usado: `release\HELIOS-Setup-0.1.0.exe`.
- Instalação confirmada em `C:\Program Files\HELIOS\HELIOS.exe`, atualizada antes da rodada v9.
- Após a v9, os seletores de busca foram ampliados para `Pesquisar`, `competência`, `vaga` e `oportunidade`; o instalador foi gerado e reinstalado novamente, com o executável instalado atualizado em 03/11/2026 10:09 BRT. A suíte completa foi repetida depois dessa última alteração: 627 testes, 626 pass, 0 fail, 1 skip.

### Pendências honestas para a próxima sessão

- Melhorar o executor de candidatura para reconhecer os formulários atuais de Gupy/LinkedIn sem depender de um seletor fixo; os casos existentes ainda param com “Não achei o próximo botão do formulário com segurança”.
- Investigar o redirecionamento da página de vagas salvas do LinkedIn (`jobs-tracker`) e, se necessário, navegar pela UI até o filtro/aba que revela as vagas salvas; não assumir que publicações salvas equivalem a vagas salvas.
- CAPTCHA continua exigindo intervenção humana; não implementar bypass. O comportamento correto é marcar a vaga, preservar a evidência e seguir o restante da fila.
- Conferir cada candidatura crítica no site antes de repetir, principalmente o caso com CAPTCHA e o caso com campos `Nome/Estado/Cidade/Mensagem` ausentes.

## Plano V6 — concluir inscrições operacionais sem falsos envios (03/11/2026)

### O que está resolvido

A etapa de descoberta deixou de depender de consulta externa para LinkedIn/Gupy: o HELIOS abre o navegador persistente, carrega a página, tenta usar o campo visual de busca, rola a página, lê os cards e persiste as vagas capturadas localmente. O ciclo do LinkedIn cobre feed, publicações salvas, notificações, busca por palavras-chave e tentativa de leitura da área de vagas salvas. A rodada v8 comprovou 5 vagas novas no LinkedIn e 6 na Gupy.

Isso não significa que toda plataforma está resolvida: plataformas com adaptador quebrado (por exemplo, Remotar HTTP 404) continuam separadas e devem ser corrigidas por plataforma. Busca geral no Google como fonte adicional ainda é uma extensão planejada, não deve ser apresentada como parte já validada do ciclo de Vagas.

### O que ainda trava a inscrição

- O executor às vezes não identifica com segurança o botão “Próximo/Continuar/Enviar” em formulários Gupy ou no fluxo externo aberto pelo LinkedIn.
- Alguns formulários usam React/Angular, `shadowRoot`, modal, iframe ou elementos que só aparecem depois de uma mudança de estado; ler o DOM uma vez não basta.
- A resolução de campos ainda pode falhar em labels indiretos, comboboxes, máscaras, selects customizados, perguntas repetidas e campos obrigatórios que aparecem em etapas posteriores.
- CAPTCHA e alguns logins/Google verification não podem ser burlados. O HELIOS deve pausar somente aquela candidatura, mostrar a janela e seguir as demais; o envio só conta com evidência positiva.
- Existem vagas antigas com URLs inválidas ou empresas que exigem repetição bloqueada por `repetirDias`; não repetir automaticamente sem conferir o histórico.

### Solução planejada para a próxima implementação

1. Criar um `form-navigator` orientado a estados: `abrir vaga → detectar candidatura → descobrir etapa → preencher → validar obrigatórios → avançar → confirmar envio → coletar evidência`. Após cada clique ou preenchimento, recapturar DOM/URL/texto e nunca reutilizar seletores antigos.
2. Criar um resolvedor semântico de campos. Ele deve pontuar label visível, `for`, `aria-label`, `aria-labelledby`, `name`, `id`, `autocomplete`, placeholder, texto próximo, tipo e contexto do formulário. Deve reconhecer input, textarea, select, combobox, radio, checkbox e componentes dentro de `shadowRoot`/iframes permitidos.
3. Criar um resolvedor de ações com vocabulário por etapa: `continuar`, `próximo`, `salvar e continuar`, `candidatar-se`, `enviar candidatura`, `finalizar`, `submit`. A ação só ocorre se o botão estiver visível, habilitado, dentro do formulário/modal correto e tiver score mínimo; caso contrário, registrar diagnóstico em vez de clicar às cegas.
4. Implementar um ciclo de validação: depois de preencher, procurar mensagens de erro, campos obrigatórios vazios, máscara inválida, mudança de URL, avanço de etapa e confirmação visual. Se o botão não avançar, tentar apenas alternativas seguras e limitadas; depois marcar `critica` com screenshot/HTML sanitizado e pergunta objetiva.
5. Separar estratégias por plataforma: Gupy, LinkedIn/ATS externo e cada plataforma adicional terão seletores e regras próprios, mas usarão a mesma máquina de estados. Um erro 404 de um adaptador não pode derrubar as fontes de navegador.
6. Melhorar o perfil estruturado e respostas: mapear explicitamente nome, e-mail, telefone, cidade, estado, experiência, pretensão, disponibilidade, links e CV; dados pessoais continuam saindo somente do cofre/perfil local. O modelo grátis pode sugerir o campo, mas não recebe CPF, senha, telefone ou endereço em texto aberto.
7. Manter 2FA por e-mail via MCP, com expiração, domínio/remetente esperado e preenchimento somente no navegador da plataforma. CAPTCHA fica como handoff humano obrigatório.
8. Adicionar idempotência e evidência: antes de iniciar, gravar vaga/empresa/URL/horário; durante o fluxo, gravar etapas; só marcar `enviada` se aparecer confirmação inequívoca ou estado equivalente do site. Timeout, fechamento, botão ausente ou erro de rede ficam `critica`/`falhou`, nunca `enviada`.
9. Construir fixtures de testes para cada falha real já observada: Henry Schein, Stefanini, LinkedIn BairesDev, abler, VAAS e Click Interativo. Cada fixture terá campos, botão, erro, CAPTCHA e confirmação simulados; o teste deve provar que o HELIOS preenche, avança, pausa ou conclui corretamente.
10. Só depois dos testes de fixture, fazer uma rodada real limitada a poucas vagas, monitorar visualmente e comparar o relatório do Chefe com evidência persistida. Não repetir automaticamente vagas críticas antigas.

### Critério de conclusão da próxima leva

Uma inscrição só será considerada resolvida quando o executor conseguir, em fixtures e em uma rodada real controlada, reconhecer campos e botões dinâmicos, preencher os dados do perfil, avançar todas as etapas, parar em CAPTCHA/ambiguidade e registrar confirmação real de envio. O relatório deverá separar `enviada`, `critica`, `falhou`, `captcha` e `duplicada/bloqueada` por plataforma.

## Leva V6 / 03-11-2026

> **STATUS (atualizado em 03/11/2026, 15:41, horário de Brasília/America/Sao_Paulo): AS INSCRIÇÕES AINDA ESTÃO FALHANDO.**
> Até agora, nenhuma candidatura chegou a `enviada` com confirmação do site. A v12 (15:14–15:20) terminou com 0 enviadas e 3 falhas. O `vagas.json` soma 34 falhas e 527 descartadas. A v13 está em teste agora.

### Código
- PR https://github.com/helisondias07/HELIOS/pull/2, branch `cursor/form-navigator-vagas-d573`, cloud agent `bc-99f05991-79c9-5da0-b34c-0525410bd573`. Mergeado localmente por fast-forward na `helios-levas-v-v5`.
- Testes: 653 no total, 652 pass, 0 fail, 1 skip.

### Regras sincronizadas no `vagas.json`
Backups: `vagas.json.bak-20261103`, `vagas.json.bak-preimport` e `vagas.json.bak-pre-v12`.
- Empresas evitadas: Quality, Quality Digital, Micro1/Micro Um, BairesDev, NeoWork, Workana, Strider e Lovel.
- 9 termos de busca.
- Exclusões: angular, vídeo/loom, PcD/afirmativa, inglês fluente, kubernetes e superior completo.
- Só remoto.
- Pretensão: R$ 3.500 para júnior e R$ 8.000 para pleno.
- Não falar com recrutadores.
- Importadas 12 das 16 candidaturas (`scripts/importar-candidaturas.js`).

### Objetivo do produto
O agente de Vagas deve ser 100% autônomo, como o Grok Bot: enxerga a tela, se candidata, manda e-mail com o CV e entrega um relatório no final, sem aprovações. Só pausam um CAPTCHA visível ou um login impossível. Modelos grátis vêm primeiro e o Cursor por último, com rotação entre as 3 contas do Cursor mantendo o contexto. Os agentes de Portfólio e de Projetos só vêm depois.

### Problemas e correções, em ordem
1. v10: `fetch failed` / `via:rules`, com falha em uns 2 s.
2. v11: loop no feed do LinkedIn (corrigido).
3. Falso CAPTCHA: o selo "protegido pelo reCAPTCHA" (VAAS, Indeed BBChain). Agora só conta como CAPTCHA um desafio visível.
4. Vaga híbrida de Florianópolis: agora é descartada.
5. "Preparar inscrição" removido: a vaga entra na fila automática.
6. Carta de apresentação do Indeed gerada a partir do perfil.
7. Posts do feed viram candidatura ou e-mail com o CV.
8. Causa raiz das 34 falhas ("Não achei o próximo botão do formulário com segurança"): o snapshot pegava o menu e o cabeçalho do site, e não o formulário. **Corrigido no código, ainda não validado no Windows.**
9. O questions-module do Indeed agora é preenchido.
10. "Security" do Glassdoor tratado como login.
11. BairesDev barrada pela descrição da vaga.
12. InfoJobs, ProgramaThor e BossaBox com URLs corrigidas.
13. Mocks removidos.
14. No máximo 1 nova tentativa por vaga.
15. Perfil: Bom Jardim/RJ e LinkedIn com https.
16. Teste `levah.test.js` ajustado para `\r\n` no Windows.

### Layout
- A barra da direita e o botão Pausar saíram do Chefe (já instalado).
- As telas de Vagas e dos outros agentes ficam em estilo de chat, com tabela de inscrições, e as configurações vão para Ajustes > Vagas. Isso está pronto no PR e falta instalar.

### Pendências
- Validar uma `enviada` real no Windows.
- O iframe de outro domínio ainda não é lido.
- O e-mail com CV depende de o Gmail ter permissão de envio.
- A rotação das contas do Cursor e o loop completo por visão ainda não foram confirmados em produção.
- Os avisos de ClickUp/GitHub/Vercel são dos agentes Oasis e Portfólio.
- Ver também `docs/operacao/REVISAO-GERAL.md`.

## Leva V7 — percepção e execução dentro de iframes (03/11/2026)

### Diagnóstico

O executor já tinha sido alterado para pedir snapshot textual e screenshot ao modelo, mas a execução ainda assumia que todos os campos e botões estavam no documento principal. Muitos ATS/Gupy/fluxos externos do LinkedIn hospedam a candidatura em iframe de outra origem. Nesse cenário, a tela podia estar visível para o navegador, mas o HELIOS procurava o botão no documento errado e devolvia “Não achei o próximo botão do formulário com segurança”. A captura também podia ocorrer com a janela oculta e sem renderização completa.

### Correções implementadas

- `src/jobs-host.js` agora enumera `webContents.mainFrame.framesInSubtree`, captura o snapshot do documento principal e avalia diretamente frames de outra origem.
- Campos e botões capturados recebem `frameId`; o `server/form-navigator.js` preserva esse identificador nas ações geradas pelo preenchimento.
- `server/application-run.js` passa o `frameId` para clique, preenchimento e upload, mantendo decisão e execução no mesmo contexto visual.
- A captura de screenshot mostra a janela de forma não focada quando necessário, espera a renderização e só então usa `capturePage`; a janela volta a ficar oculta quando era oculta.
- O relatório de evidência agora registra quantidade e URLs sanitizadas dos frames vistos, facilitando saber se a tela real foi alcançada.
- O teste real que depende de `google-chrome` foi marcado como skip somente no Windows por ausência do binário Linux; não mascara falhas do executor Electron. Foi adicionado teste unitário para preservar `frameId` nas ações.

### Validação e instalação

- `npm test`: 654 testes, 652 pass, 0 fail, 2 skip.
- `npm run lint`: verde.
- `npm run check`: `HELIOS ok`.
- `npm run dist:win`: verde.
- Instalador `release\HELIOS-Setup-0.1.0.exe` aplicado novamente.
- `C:\Program Files\HELIOS\HELIOS.exe` atualizado em 03/11/2026 às 15:52 BRT.

### Próximo teste operacional

Executar uma rodada limitada em uma vaga Gupy/ATS conhecida por usar iframe e verificar no relatório `evidencia` se aparecem `frames` e `frameDiagnostico`. Só depois testar uma vaga real da fila. Se ainda falhar, o próximo diagnóstico deve distinguir: screenshot vazio, frame não carregado, campo sem label, botão presente mas bloqueado, ou confirmação ausente. CAPTCHA continua sendo pausa humana; não será contornado.

## Leva V11 — fila de revisita, reconhecimento de botões e ciclo reinstalado (03/11/2026)

- O defeito estrutural da fila foi corrigido em `server/jobs.js`: `autoQueue(..., { revisitar: true })` podia devolver falhas técnicas antigas, mas `autoStart()` rejeitava qualquer vaga que não estivesse `nova`. Agora falhas técnicas elegíveis podem ser reabertas, sem apagar histórico e sem repetir candidaturas confirmadas.
- A fila automática passou a priorizar LinkedIn, Gupy, Indeed e plataformas de candidatura antes do Glassdoor, que frequentemente entrega apenas uma página protegida/navegação sem CTA. O limite persistido antigo de 3 por hora migra para 50; o teto continua configurável.
- `server/form-navigator.js` e `server/form-vision.js` reconhecem `Revisar meu currículo`, `Continuar para candidatura`, `Usar este currículo`, atributos de acessibilidade/test id e correspondência aproximada de rótulos. O clique sempre recaptura o snapshot e mantém o `frameId`, inclusive em shadow DOM/iframe.
- O fechamento do ciclo agora tem limite de 45s para o resumo do Chefe, para que uma chamada de modelo não deixe o relatório eternamente em execução. O estado da busca e da fila é persistido antes do resumo.
- CAPTCHA continua sendo handoff humano obrigatório; o HELIOS não tenta contornar proteção. Login/OAuth e Gmail sem conta conectada também continuam bloqueios reais.

### Validação desta leva

- `npm test`: 654 testes, 652 aprovados, 0 falhas, 2 ignorados por dependerem de navegador real.
- `npm run lint`: verde.
- `npm run check`: `HELIOS ok`.
- `npm run dist:win`: concluído.
- Instalador aplicado em `C:\Users\HelisonDias\AppData\Local\HELIOS` com `ExitCode=0`; hash do `resources\app.asar` instalado igual ao build `676FDD776F5105D8FF5C2037A7F09D8B85B6E275283914E2DCD71C9FF9565972`. A cópia antiga em `C:\Program Files\HELIOS` não foi usada neste teste.

### Ciclos operacionais após a correção

- v27, antes da leva: 6 encontradas, 1 tentativa, 0 confirmadas; o Indeed chegou à etapa Gupy `Acompanhar candidatura/Revisar meu currículo` e o executor não reconheceu a continuação.
- v28, artefato novo direto: a busca percorreu feed, salvos, salvos-vagas, notificações e plataformas; a fila reabriu uma vaga técnica, mas o fechamento ficou pendente no resumo do Chefe. A evidência confirmou que a fila não estava mais vazia.
- v29, instalação de usuário: o ciclo visual percorreu LinkedIn e plataformas e tentou 19 registros no estado persistido. Resultado observado: 17 falhas técnicas/validação, 2 descartes legítimos por presencial/híbrido, 0 confirmações positivas. O resultado não deve ser apresentado como sucesso: ainda há bloqueios reais.
- Evidências principais de v29:
  - Gupy abriu o formulário, identificou `Responder agora`, campos e `Salvar e continuar`, mas retornou `Campo obrigatório`; o problema restante é validação/controle obrigatório não preenchido, não ausência de vaga.
  - Indeed abriu o SmartApply, carregou currículo e chegou a `Responda às perguntas de seleção`; em uma vaga faltou conteúdo/controle detectável no snapshot e em outra a navegação retornou `ERR_ABORTED`.
  - Glassdoor continuou entregando páginas com menu/campos de busca, sem botão de candidatura/ATS exposto; essas falhas não devem ser confundidas com falha genérica de reconhecer qualquer botão.

### Estado para a próxima sessão

1. Conectar/validar uma conta Gmail com permissão de envio no cofre para liberar as vagas por e-mail.
2. Corrigir o caso Gupy de `Campo obrigatório`: capturar radio/select/file requerido e não clicar `Salvar e continuar` enquanto houver requisito sem valor.
3. Adicionar espera/diagnóstico específico do SmartApply para pergunta dinâmica que aparece depois do carregamento.
4. Rodar uma vaga Gupy ativa conhecida e exigir confirmação textual positiva antes de contar `enviada`.

## Leva V12 — controles customizados Gupy e espera do SmartApply (04/11/2026)

- O snapshot de formulário agora inclui `[role='radio']` e `[role='checkbox']`, além de `aria-checked`, `aria-required` e opções mínimas para o planejador. Isso cobre controles React/MUI da Gupy que apareciam visualmente como `RadioButtonUncheckedIcon`, mas não entravam como campos.
- O `applyScript` continua clicando o controle pelo seletor capturado no mesmo frame, preservando shadow DOM/iframe.
- O `settle()` do executor aumenta a espera do Indeed SmartApply para 30 recapturas com intervalo de 900 ms quando a etapa de perguntas ainda está carregando.
- Foi adicionado teste unitário para rádio obrigatório customizado da Gupy.
- Validação: 655 testes, 653 pass, 0 fail, 2 skip; lint e check verdes.
- Novo build empacotado. A reinstalação NSIS desta tentativa ficou presa e deixou a pasta de usuário parcial; o `app.asar` foi atualizado de forma controlada em `C:\Users\HelisonDias\AppData\Local\HELIOS\resources\app.asar` e o hash instalado bateu com o build `662280D73873455439C616ADDB2D1D16DD305A760E1FCDC9C9C4E42519A55458`.
- O ciclo v30 percorreu novamente LinkedIn e plataformas, mas não produziu nova confirmação positiva. O estado anterior continua com Gupy em `Campo obrigatório`, Indeed em pergunta dinâmica/erro de rede e Glassdoor sem CTA exposto. Ainda não declarar o fluxo como resolvido.
## Leva V8 — limpeza operacional da interface e rastreabilidade (03/11/2026)

### Correções da tela

- A tabela de inscrições agora usa `historicoHelios` e só mostra registros criados pelo executor HELIOS (`origem/executor: helios`). Registros importados ou sem origem confiável não são apagados: ficam preservados no histórico bruto, mas deixam de poluir a tela operacional.
- Novos registros gerados por `record()` recebem `origem: helios` e `executor: helios`; `importHistory()` marca os antigos/importados como `origem: externo`.
- A conversa de agente não abre mais automaticamente uma rotina antiga com título `Rotina:`. O layout `hx-chefe-solo` passou a ocupar uma única coluna e o feed ignora cancelados e itens com mais de 72 horas.
- Os botões nativos de minimizar/maximizar/fechar continuam sendo controlados pelo `titleBarOverlay` do Electron/Windows; as cores da sobreposição são definidas por tema em `src/meeting-window.js`.

### Rodada operacional v14 após a instalação V7

- Executável: `C:\Program Files\HELIOS\HELIOS.exe`; relatório: `work\force-vagas-report-v14.json`.
- Terminou com `ok: true` em 03/11/2026 às 18:59 BRT.
- Encontradas: 9 oportunidades: Indeed 1, GeekHunter 1 e Glassdoor 7.
- Inscrições confirmadas: 0. A única tentativa efetiva foi uma URL do Indeed que respondeu `Não encontrada | Indeed`; a visão escolheu um botão de retorno e depois um botão que desapareceu antes do clique. Foi registrada como `falhou`, não como enviada.
- GeekHunter/Glassdoor foram descartadas pelas regras de compatibilidade; a fila terminou com um bloqueio recente de candidatura na Gupy.

### Próximas ações

1. Reabrir Vagas e confirmar que as linhas Grok/importadas de 20/27/29-10 não aparecem mais.
2. Rodar uma vaga ativa conhecida, não uma URL 404/“não encontrada”, e verificar `frames`/`frameDiagnostico`.
3. Bloquear URLs mortas do Indeed antes da visão e exigir confirmação textual antes do clique.
4. Só contar sucesso com confirmação da plataforma e registro `enviada_auto` de origem HELIOS.

### Validação final da Leva V8

- `npm test`: 654 testes, 652 pass, 0 fail, 2 skip esperados no Windows.
- `npm run lint` e `npm run check`: verdes.
- `npm run dist:win`: concluído.
- Instalador aplicado novamente; `C:\Program Files\HELIOS\HELIOS.exe` atualizado em 03/11/2026 às 16:04 BRT.

## Leva V9 — correção de tela, reprocessamento técnico e rodada v20 (03/11/2026)

- O snapshot já atravessava `shadowRoot`, mas `clickScript` e `applyScript` usavam apenas `document.querySelector`. O HELIOS podia enxergar um botão/campo e falhar ao acioná-lo. Agora ambos percorrem as raízes de sombra e executam no mesmo frame capturado.
- O reconhecimento foi ampliado para `inscrever-me`, `inscrever nesta vaga`, `candidatar-me`, `aplicar agora`, `continuar inscrição` e atributos `testId`, `action`, `title` e `name`.
- Depois de cada clique há espera e novo snapshot (`settleAfterAction`) para formulários React/Angular dinâmicos.
- O automático aceita `revisitar:true`: reabre somente falhas técnicas antigas de botão/formulário/rede/carregamento, no máximo uma tentativa, sem repetir envio, candidatura recente, CAPTCHA, login ou 2FA.
- Testes: `npm test` — 654 testes, 652 pass, 0 fail, 2 skips esperados; lint e check verdes.
- O instalador foi gerado em `release\HELIOS-Setup-0.1.0.exe`, mas a reinstalação formal ficou pendente: o NSIS permaneceu aguardando elevação e a cópia em `C:\Program Files\HELIOS` foi recusada. O binário instalado ainda é anterior à Leva V9.

### Rodada real v20

- Relatório: `work\force-vagas-report-v20.json`; fechou com `ok:true` às 17:09:39 BRT.
- 16 encontradas: Gupy 4, Glassdoor 3, LinkedIn 2, Remotar 3, GeekHunter 2, Nerdin 1 e e-mail 1.
- 0 confirmadas e 3 falhas. A publicação salva de Integrações foi encontrada e reprocessada, mas o envio ficou bloqueado por `Nenhuma conta Gmail conectada`; isso prova que o problema é a disponibilidade do canal de envio, não a descoberta da vaga. Outra falha foi botão dinâmico que sumiu no LinkedIn.
- A fila terminou com 1 item. Não declarar nenhuma candidatura como enviada sem confirmação do site/Gmail.

### Próxima sessão

1. Instalar o novo setup com elevação do Windows.
2. Conectar uma conta Gmail com permissão de envio no Cofre/MCP.
3. Rodar o ciclo com `revisitar:true` e conferir a evidência de frame/shadowRoot.
4. Confirmar pelo menos uma candidatura positiva no site ou no Gmail.
## Leva V10.2 — reinstalação, rodada v23–v25 e diagnóstico final (2026-11-03)

- Implementado no fluxo de candidatura:
  - aviso informativo da Gupy sobre respostas não editáveis não é mais tratado como bloqueio automático;
  - snapshot de formulário passou a guardar `href` dos links e o Glassdoor tenta seguir somente links reais de candidatura para ATS externo;
  - falso positivo `Conta gratuita de empresa`/`Área da empresa` foi excluído;
  - cliques orientados por visão e por regras reacquirem o snapshot imediatamente antes do clique, com uma tentativa segura de recuperação se o DOM mudou;
  - relatório da rodada passou a reler o estado final e contar vagas realmente processadas pelo ciclo, mesmo quando já estavam em `falhou` antes.
- Validação: `npm test` = 654 testes, 652 aprovados, 0 falhas, 2 ignorados por dependerem de navegador real; `npm run lint` verde; `npm run check` = `HELIOS ok`.
- Instalador reconstruído e reinstalado com sucesso (`ExitCode=0`); hash de `release/win-unpacked/resources/app.asar` igual ao instalado em `C:\Program Files\HELIOS\resources\app.asar`.
- Rodadas reais no build instalado:
  - v23: busca visual completa, 21 novas oportunidades, 0 confirmadas; revelou falso positivo do Glassdoor e relatório ainda subcontava tentativas.
  - v24: após a correção do falso positivo, 9 novas oportunidades (Glassdoor 6, Remotar 2, Catho 1), 0 confirmadas; Glassdoor não seguiu links reais porque a página não expôs botão de candidatura.
  - v25: após a correção do relatório, 26 oportunidades encontradas (Glassdoor 1, Remotar 25), 3 tentativas contabilizadas, 3 falhas de botão/formulário e 0 inscrições confirmadas. Relatório: `work/force-vagas-report-v25.json`.
- Diagnóstico atual: a busca visual está operacional; o bloqueio de inscrição não é mais “fila vazia”. Glassdoor entrega páginas com navegação e campos de busca, mas não expõe o CTA da vaga; Indeed chega a abrir o SmartApply, mas em alguns casos muda para etapa sem campos/botões detectáveis; posts salvos do LinkedIn que pedem e-mail continuam bloqueados porque o runtime informa `Nenhuma conta Gmail conectada.`; `/my-items/saved-jobs/` continua expirando.
- CAPTCHA continua sendo handoff humano por segurança; não há bypass implementado.

## Leva V13 — identidade de campos, radios agrupados e teste interrompido (04/11/2026)

- Seguindo a ordem recomendada por Claude (`T4.1 → T0.0 → T0.1 → T0.2 → T0.3 → T0.4 → T0.6 → T1.1 → T1.3`), foi aplicada a primeira parte do plano no executor:
  - `.gitattributes` normaliza texto para LF e preserva scripts Windows em CRLF;
  - `fieldKey()` usa frame, tipo, rótulo, nome/id e ocorrência apenas como desempate; o seletor DOM não é identidade persistente;
  - tentativas de preenchimento são limitadas por identidade semântica e o snapshot atual é consultado antes de repetir;
  - rádios nativos são agrupados por `name` e rádios ARIA por `radiogroup/fieldset`, com prompt do grupo e opções `data-helios-opt` independentes;
  - o executor de rádio não cai mais para o seletor do grupo; checkbox ARIA considera `aria-checked`;
  - o snapshot agora expõe `requiredHint`, `hasFile` e `invalidos` com rótulo/mensagem;
  - o fluxo pausa quando há campo obrigatório sem resposta possível e não avança silenciosamente;
  - a regra de remoto reconhece variações como “aceita trabalhar remotamente”, sem confundir experiência remota passada.
- Foram adicionados testes para identidade entre etapas, grupo de rádio, opção “Sim”, obrigatórios sem resposta e aplicação por opção. A suíte completa passou: `npm test` = 658 testes, 656 aprovados, 0 falhas, 2 ignorados; `npm run lint`, `npm run check` e `git diff --check` verdes.
- Reinstalação concluída com `release\\HELIOS-Setup-0.1.0.exe`, `ExitCode=0`, no diretório de teste único `C:\\Users\\HelisonDias\\AppData\\Local\\HELIOS`. O binário foi aberto e respondeu; a tela Vagas passou a mostrar apenas `Nenhuma inscrição enviada`, sem as linhas antigas importadas.
- Rodada operacional iniciada no build reinstalado pelo relatório `work\\force-vagas-report-20261103.json`. A navegação visual confirmou LinkedIn `feed`, `salvos`, `salvos-vagas`, `notificacoes` e `busca`; depois entrou nas plataformas e registrou LinkedIn, InfoJobs, Indeed e Programathor/Trampos.
- A rodada foi encerrada a pedido do Helison antes da fila de candidaturas e do resumo do Chefe. O relatório foi marcado `interrompido: true`; não houve confirmação de inscrição nesta rodada e nenhum clique final deve ser interpretado como envio.
- Próximo passo obrigatório: retomar a rodada com o processo controlado, coletar a conclusão da busca e observar a primeira vaga Gupy/ATS até o último passo. Só considerar T1.3 concluído com confirmação textual positiva do site; CAPTCHA permanece intervenção humana.

### Rodada retomada após a Leva V13

- Relatório: `work\\force-vagas-report-20261104.json`; terminou com `ok: true`.
- Busca visual concluída em LinkedIn, Gupy, Indeed, Glassdoor, Catho, Coodesh, GeekHunter, Programathor, Trampos, Nerdin, BossaBox e Remotar.
- LinkedIn: feed, posts salvos, notificações e busca foram lidos. `salvos-vagas` expirou ao carregar `my-items/saved-jobs`.
- Encontradas nesta rodada: 184 registros no estado final, distribuídos entre Glassdoor 8, LinkedIn 15, Remotar 17, Nerdin 24, Trampos 21, Programathor 33, GeekHunter 33, Coodesh 6, Catho 14, Indeed 3 e Gupy 10.
- Tentativas: 2. Confirmações positivas: 0. As duas falharam no Glassdoor porque a página da vaga expôs apenas navegação/menu, sem CTA de candidatura seguro; o executor não inventou um clique.
- Fila restante: 1 vaga. O bloqueio registrado foi candidatura recente na vaga/empresa La Moda; não é erro de descoberta.
- O Chefe fechou o ciclo com 0 aprovações e 1 bloqueio.
- Conclusão do plano: T0.0/T0.1/T0.2/T0.3/T0.4/T0.6 e a reinstalação estão concluídos e cobertos por testes. T1.3 ainda não está concluído, pois nenhuma candidatura real recebeu confirmação textual do site. Permanecem pendentes a correção específica do CTA/ATS do Glassdoor, o timeout de `salvos-vagas` e uma candidatura Gupy/ATS confirmada.

### Estado publicado após a rodada

- A rodada final foi registrada no commit `eaf2163` (`corrige executor de formularios e registra rodada de vagas`).
- Push concluído para `origin/helios-levas-v-v5`.
- O commit inclui o executor corrigido, os testes, `.gitattributes`, este handoff e `work\\force-vagas-report-20261104.json`.
- Os relatórios antigos em `work\\` continuam fora do commit para não aumentar o repositório com artefatos históricos não relacionados.
- Estado honesto para retomada: descoberta visual funcionando; preenchimento e validação reforçados; ainda sem candidatura confirmada. O próximo teste deve priorizar uma vaga Gupy/ATS ativa e registrar `frames`, `frameDiagnostico`, campos obrigatórios e confirmação textual final.
