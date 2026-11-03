# Acessos externos (estado e como conectar)

Credenciais sensíveis **só no cofre** (`vault.json` cifrado). Nunca no chat, prompt, logs ou fixtures reais.

| Serviço | Estado (P) | Como conectar | Onde fica |
|---------|------------|---------------|-----------|
| **ClickUp** | Ativo (Oasis) | **Entrar com ClickUp** (MCP OAuth DCR+PKCE) ou token no cofre (compat) | Conectores / Cofre › Token |
| **E-mails (Gmail)** | Parcial | OAuth Google (client id/secret no cofre) + conector Gmail; leitura de códigos/resumo | `googleClientId/Secret`, conectores |
| **LinkedIn** | Ativo (O3, só leitura + Easy Apply c/ aprovação) | Sessão logada pelo **próprio usuário** na partição compartilhada `persist:vagas`; cofre para login | Login plataforma; **NUNCA postar** |
| **Plataformas de vagas** | Ativo (adapters + agente 1x/dia + **login em lote Q** + **sessão única Q3**) | Aba Vagas / Cofre › Plataformas (URL + usuário; senha padrão); lote via API; um login Google vale para todas | Categoria `plataforma` |
| **GitHub** | Ativo (Portfólio) | **Entrar com GitHub** (Device Flow + Client ID do OAuth App) → Bearer no MCP Copilot; PAT só em Avançado | Conectores / cofre |
| **Vercel** | Ativo (Portfólio) | **Entrar com Vercel** (MCP OAuth) ou CLI logado ou token em Avançado | Conectores / CLI / cofre |
| **Telegram** | Ativo | Bot token no cofre (`telegram`) | Chave `telegram` |
| **Cursor** | Ativo | Até 3 API keys / login navegador | Contas no cofre |
| **Groq / Gemini** | Ativo (reunião/voz) | Chaves no cofre | `groq`, `gemini` |

Detalhes OAuth/MCP: `conectores-oauth.md`.

## Login em lote (Leva Q)

- `POST /api/vagas/login-todas` body opcional `{ reserva?: boolean, plataformas?: string[] }` — inicia em background; responde `{ iniciado: true }`.
- `GET /api/vagas/login-todas` — progresso/resultado do último lote (`rodando`, `atual`, `resultados[]`).
- Cada item: `{ id, label, status: "logado"|"pendente", email: "principal"|"reserva", motivo }`.
- Roda **em sequência** (main/`jobs-host.login`, modo silencioso): sem abrir janela, sem notificar, sem inscrição/post/mensagem.
- `reserva: true` — se o principal ficar pendente por senha/e-mail, tenta de novo com o e-mail reserva **sem gravar no cofre**.
- Nunca devolve/loga senha, cookies ou token. Mesmo Bearer da API local.
- Pendente típico: captcha, 2FA não lido, login só pelo Google, formulário não achado, senha errada.

## Sessão única das vagas (Leva Q3)

- Todas as janelas de vagas usam a partição **`persist:vagas`** (jobs-host, agent-browser, agent-vagas).
- Um login no Google (ou em qualquer plataforma) vale para as demais na mesma partição.
- Migração única no boot: cookies das pastas antigas `Partitions/vagas-*` → `persist:vagas`; marcador `userData/vagas-sessao-unica.json`. Partições antigas **não são apagadas**.
- Limitação: `Local Storage` / `IndexedDB` só da primeira pasta antiga que existir (demais pulam se o destino já tiver a pasta).
- `POST /api/vagas/abrir-login` `{ url: "https://accounts.google.com/" }` — abre janela visível na partição única (só esse host https; outras URLs → 400).
- Continua aceitando `{ plataforma }` / `{ plataformas: [...] }` (Q2).

## LinkedIn — regra dura

- Pode: ler feed, salvos, notificações, buscar vagas, Easy Apply **com aprovação** no início.
- **Nunca postar**, tweetar, publicar ou “share” automatizado.
- Volume baixo, ritmo humano; risco de ban consciente.

## CPF

Só no cofre (`keys.cpf`). Preenche formulário via inject no main; nunca em JSON de perfil, logs ou prompt.
