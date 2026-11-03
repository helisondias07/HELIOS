# Regras operacionais (obrigatórias)

1. **LinkedIn nunca postar** — só leitura / candidatura com aprovação.
2. **CPF só no cofre** — nunca em perfil JSON, logs, prompt, fixtures reais.
3. **Paradas críticas** — pagamento, termos novos, anexos extras, teste com tempo, dados sensíveis, produção, force-push: cartão (e Telegram se ligado). Nada executa antes.
4. **Nunca inventar números** — tokens, custo, %, contagens: só o que a ferramenta/API devolveu.
5. **Testes**
   - `HELIOS_MOCK=1`, `HELIOS_USER_DATA` próprio, `HELIOS_TEST_OFFSCREEN=1`
   - Portas **47921+** (ou `port: 0`); **nunca 47331**
   - Uma instância por vez; `taskkill /T /F` só no PID exato do teste
   - **Nunca** tocar no HELIOS instalado nem em `%APPDATA%\HELIOS`
   - **Sem** `electron -e`
6. **vagas-helison** — somente leitura na importação; fixtures sem dados reais.
7. **Backups** — antes de cada leva: `.backup-levaX\<yyyyMMdd-HHmmss>`
8. **Segredos** — nunca imprimir/logar tokens, senhas, CPF, Authorization.
9. **MCP remoto** — desligado por padrão; token separado; allowlist mínima; sem cloudflared nesta leva.
10. **Design** — `design/DESIGN.md`; tema claro principal; cores `--helios-*`; no máx. 1 ouro preenchido por tela; sem emoji na UI.
11. **Instalador** — só com aval explícito; levas O **não** geram instalador sem aval.
12. **Oasis isolado** de itens de emprego no quadro.
