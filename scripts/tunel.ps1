#Requires -Version 5.1
<#
.SYNOPSIS
  Abre um Cloudflare Tunnel apontando para o MCP do HELIOS em 127.0.0.1:<porta>.

.DESCRIPTION
  Quick tunnel (padrao): URL efemera *.trycloudflare.com — bom para teste.
  Named tunnel: requer login Cloudflare do usuario e TUNNEL_NAME / config.

  NAO imprime token MCP. O Bearer fica so no cofre / area de transferencia do HELIOS.
  Antes de ligar: HELIOS rodando, token remoto GERADO, checkbox "Ligar MCP remoto" ON.
  Nao use a porta 47331 (app instalado) em testes — use a porta do userData de teste.

.PARAMETER Port
  Porta local do HELIOS (obrigatoria). Ex.: 48061 em teste.

.PARAMETER Named
  Se definido, roda `cloudflared tunnel run <nome>` (tunel nomeado).
  Requer `cloudflared tunnel login` previo e tunel criado no painel/CLI.

.PARAMETER TunnelName
  Nome do tunel Cloudflare (so com -Named). Padrao: helios-mcp.

.EXAMPLE
  # Quick tunnel de teste (HELIOS de teste na 48061):
  .\scripts\tunel.ps1 -Port 48061

.EXAMPLE
  # Tunel nomeado (producao / hostname estavel):
  .\scripts\tunel.ps1 -Port 47331 -Named -TunnelName helios-mcp
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,

  [switch]$Named,

  [string]$TunnelName = "helios-mcp"
)

$ErrorActionPreference = "Stop"

function Assert-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Write-Host "cloudflared nao encontrado no PATH."
    Write-Host "Instale: winget install --id Cloudflare.cloudflared -e"
    Write-Host "Ou baixe o MSI em https://developers.cloudflare.com/tunnel/downloads/"
    exit 1
  }
  & cloudflared --version
}

Assert-Cloudflared

$target = "http://127.0.0.1:$Port"
Write-Host ""
Write-Host "HELIOS MCP tunnel"
Write-Host "  Alvo local : $target/mcp"
Write-Host "  Modo       : $(if ($Named) { "named ($TunnelName)" } else { "quick (trycloudflare)" })"
Write-Host ""
Write-Host "No Grok Bot / cliente MCP remoto, use:"
Write-Host "  URL    : https://<host-do-tunel>/mcp"
Write-Host "  Header : Authorization: Bearer <token-remoto-do-cofre>"
Write-Host "  (o valor do token NUNCA aparece aqui — copie em Ajustes > Conta > MCP remoto)"
Write-Host ""
Write-Host "Checklist: HELIOS ligado | token remoto definido | MCP remoto ligado | allowlist so quadro/chefe/status"
Write-Host "Ctrl+C encerra o tunel."
Write-Host ""

if ($Named) {
  # Tunel nomeado: exige conta Cloudflare + tunel ja criado com hostname apontando para 127.0.0.1:<porta>.
  # Ver docs/operacao/tunel.md (secao Named tunnel).
  & cloudflared tunnel run $TunnelName
  exit $LASTEXITCODE
}

# Quick tunnel: hostname muda a cada execucao; sem conta Cloudflare.
& cloudflared tunnel --url $target
exit $LASTEXITCODE
