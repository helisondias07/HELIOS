# Testes e instalação

## Teste unitário / integração

```powershell
cd C:\Users\HelisonDias\Repositorios\HELIOS
npm test
npm run lint
```

Leva O1: `test/levaO1.test.js` (quadro, chefe, MCP remoto, cofre, docs).

Leva Q: `test/levaQ.test.js` — login em lote `/api/vagas/login-todas` (mock, sem rede real, sem senha/cookies no JSON; `reserva` só re-tenta senha errada).

Leva Q3: `test/levaQ3.test.js` — partição única `persist:vagas`, allowlist Google em `/api/vagas/abrir-login`, migração com sessões fake (contagem + idempotência do marcador).

Helpers: `test/helpers-ideias.js` — `boot({ mock: true, port: 0, chefeMs: 0 })`.

## Teste de janela (mock)

```powershell
$ud = Join-Path $env:TEMP "helios-levaO1-ud"
Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
$env:HELIOS_MOCK = "1"
$env:HELIOS_USER_DATA = $ud
$env:HELIOS_TEST_OFFSCREEN = "1"
$env:HELIOS_PORT = "47921"
# subir Electron com esses envs; uma instância; matar só o PID do teste
```

Leva Q (ensaio manual, se precisar de janela): porta **48221+**, userData em `%TEMP%\helios-levaQ-ud`, `HELIOS_MOCK=1`, `HELIOS_TEST_OFFSCREEN=1`. Suite automatizada usa `port: 0`.

- Não use porta **47331**.
- Não abra o app instalado em paralelo com a mesma userData.

## Instalação (quando houver aval — não é O1)

1. Fechar HELIOS: `Get-Process HELIOS -ErrorAction SilentlyContinue | Stop-Process -Force`
2. Backup: copiar `%APPDATA%\HELIOS` → `%APPDATA%\HELIOS-backup-<stamp>`
3. `npm test` + `npm run lint` limpos
4. `npm run dist:win` → `release\HELIOS-Setup-0.1.0.exe`
5. `.\release\HELIOS-Setup-0.1.0.exe /S`
6. Verificar: `http://127.0.0.1:47331/api/health` → 200; vault intacto; abas abrem; 0 erros de console graves
7. Não apagar AppData no desinstalador (`deleteAppDataOnUninstall: false`)

## O que O1 não faz

- Não gera instalador
- Não instala cloudflared
- Não abre túnel
