# Assinatura de código (pendente)

Status: o HELIOS ainda NÃO é assinado. Falta um certificado de assinatura de código (Authenticode).
Sem ele, o Windows SmartScreen pode avisar "editor desconhecido" ao instalar.

## Quando houver certificado
1. Obter um certificado de assinatura de código (OV ou EV) em uma autoridade (ex.: DigiCert, Sectigo, SSL.com), ou usar o Azure Trusted Signing.
2. Nunca guardar o .pfx nem a senha no repositório. Usar variáveis de ambiente na máquina de build:
   - `CSC_LINK` = caminho do .pfx (ou base64)
   - `CSC_KEY_PASSWORD` = senha do certificado
3. O electron-builder assina sozinho no `npm run dist:win` quando essas variáveis existem.
   Opcional no `package.json` > `build.win`: `"signingHashAlgorithms": ["sha256"]` e `"rfc3161TimeStampServer": "http://timestamp.digicert.com"`.
4. Conferir: botão direito no `HELIOS-Setup-*.exe` > Propriedades > Assinaturas Digitais, ou `Get-AuthenticodeSignature`.

## Já feito (leva D)
- Actions do CI fixadas por SHA em `.github/workflows/helios.yml`.
- Fusíveis do Electron (runAsNode desligado, integridade do asar) já estavam ativos.