
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
