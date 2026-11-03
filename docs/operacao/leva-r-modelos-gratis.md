# Leva R — modelos grátis (NVIDIA NIM + Gemini)

- Módulo: `server/free-llm.js` (provedor OpenAI-compatível, loop com tool calling, reserva em 429).
- Modelos (todos conferidos em GET /v1/models, 02/11/2026; lista configurável em ROLE_MODELS / opts.roleModels): Chefe e Vagas `nvidia/nemotron-3-ultra-550b-a55b`; difícil `nvidia/nemotron-3-ultra-550b-a55b`; extração `nvidia/nemotron-3.5-lightning-30b-a3b` ou `deepseek-ai/deepseek-v4.1-flash`; visão `nvidia/nemotron-3.5-super-vl-120b-a12b`; embeddings `nvidia/nemotron-3.5-embed-1b`; reservas (ordem) `minimaxai/minimax-m3.1-flash`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `z-ai/glm-5.3-flash`, `deepseek-ai/deepseek-v4.1-flash`, `moonshotai/kimi-k2.6`; depois `gemini-3.8-flash` e por fim Cursor. Timeout por chamada: 45 s.
- Agentes: Vagas e Pesquisa = grátis; Oasis e Portfólio = Cursor.
- 429: espera Retry-After (máx. 20 s), tenta de novo, passa ao próximo modelo e, por último, Cursor (se configurado).
- Chaves: cofre (`nvidia`, `gemini`). Importadas de HELIOS_NVIDIA_KEY / HELIOS_GEMINI_KEY na 1ª abertura e apagadas do ambiente. Servidor recebe só via `getLlmKey`; nunca vão a log, prompt ou erro.
- Privacidade (`server/fill-privacy.js`): o modelo vê só a vaga e os rótulos dos campos; CPF, telefone, endereço, e-mail, nome e CV viram `{{CPF}}` etc. e o código preenche do cofre. Teste: `test/free-llm.test.js` + `test/levaR2.test.js`.
- Triagem: `/api/vagas/match` usa o grátis como scorer quando há chave. Status: `GET /api/llm-gratis/status`.
- Termos: NIM trial registra entradas — por isso nenhum dado pessoal vai ao prompt.


## Teste ao vivo (02/11/2026, 23:10 BRT, prompt sem dados pessoais)
- 200: nemotron-3-ultra (tool calling OK, 3,3 s), minimax-m3.1-flash, nemotron-3.5-super-vl, nemotron-3.5-lightning; embed-1b (2048 dims).
- 404 'Function not found for account': nemotron-3-super e kimi-k2.6 (listados no /v1/models, mas não liberados nesta conta).
- Timeout: deepseek-v4.1-flash (60 s) e glm-5.3-flash (45 s).
- Chefe padrão: super 404 -> glm timeout -> minimax respondeu com tool calling (97 s). Timeout por chamada: 45 s.


## Leva R2 (02/11/2026)
- ROLE_MODELS: chefe/vagas/pesquisa = `nvidia/nemotron-3-ultra-550b-a55b` (super e kimi dão 404 nesta conta).
- Reservas na ordem: minimax-m3.1-flash → lightning-30b → glm-5.3-flash → deepseek-v4.1-flash → kimi-k2.6; depois Gemini; Cursor por último. Sem duplicatas na cadeia. `REQUEST_TIMEOUT_MS` = 45000.
- Chefe (`server/chefe.js`): `ciclo`/`ordem` chamam o roteador gratis (`llm.chat` agent `chefe`); fallback da cadeia; sem chave ou falha total → regras atuais. Prompt higienizado (`scrubPii`: CPF, e-mail, telefone, endereço). LLM injetável (`createChefe(..., { llm })`).
- Fill (`src/jobs-host.js`): `planFillLlm` no preenchimento de candidatura aprovada; modelo vê só vaga + rótulos; dados pessoais só do cofre/perfil via `resolveFill`. Para antes de enviar (`paradoAntesDeEnviar`). LLM falha → `planFill` atual. `registerJobs({ freeLlm })`; `main.js` cria com `getKey` do vault (`nvidia`/`gemini`), sem logar.
- IPC `vagas:preencher`; testes `test/levaR2.test.js`.
