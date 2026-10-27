"use strict";

/**
 * Preenche usuário e senha na janela em foco, no Windows, pelo PowerShell.
 *
 * Segredo: o script (fixo, sem segredo nenhum) vai por -EncodedCommand; usuário e senha vão só pelo stdin
 * (em base64 de um JSON UTF-8), nunca por argumento, log ou retorno. A saída do PowerShell não é lida:
 * só o código de saída conta.
 *
 * Área de transferência: o texto entra num DataObject que também leva os formatos que o Windows reconhece
 * para NÃO guardar o conteúdo no histórico (Win+V), NÃO sincronizar com a nuvem e NÃO ser processado por
 * monitores de área de transferência:
 *   - ExcludeClipboardContentFromMonitorProcessing
 *   - CanIncludeInClipboardHistory = 0 (DWORD)
 *   - CanUploadToCloudClipboard = 0 (DWORD)
 * Logo depois de colar, a área de transferência é limpa, também quando algo falha.
 * Limite: esses formatos são um pedido que o Windows e os programas respeitam; um programa que leia a área
 * de transferência nos poucos décimos de segundo entre o "copiar" e o "limpar" ainda consegue ver o texto.
 */
const CLIPBOARD_HELPERS = `
function New-ProtectedClipData([string]$texto) {
  $d = New-Object System.Windows.Forms.DataObject
  $d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $true, $texto)
  $zero = [byte[]](0, 0, 0, 0)
  $d.SetData('ExcludeClipboardContentFromMonitorProcessing', (New-Object System.IO.MemoryStream (, $zero)))
  $d.SetData('CanIncludeInClipboardHistory', (New-Object System.IO.MemoryStream (, $zero)))
  $d.SetData('CanUploadToCloudClipboard', (New-Object System.IO.MemoryStream (, $zero)))
  return $d
}
function Set-ProtectedClipboard([string]$texto) {
  [System.Windows.Forms.Clipboard]::SetDataObject((New-ProtectedClipData $texto), $true, 10, 100)
}
`.trim();

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
${CLIPBOARD_HELPERS}
$code = 0
try {
  $raw = [Console]::In.ReadToEnd().Trim()
  $in = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw)) | ConvertFrom-Json
  if ($in.usuario) {
    Set-ProtectedClipboard ([string]$in.usuario)
    Start-Sleep -Milliseconds 60
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 60
  }
  if ($in.senha) {
    if ($in.usuario) { [System.Windows.Forms.SendKeys]::SendWait('{TAB}'); Start-Sleep -Milliseconds 60 }
    Set-ProtectedClipboard ([string]$in.senha)
    Start-Sleep -Milliseconds 60
    [System.Windows.Forms.SendKeys]::SendWait('^v')
  }
  Start-Sleep -Milliseconds 80
} catch {
  $code = 1
} finally {
  $in = $null
  $raw = $null
  try { [System.Windows.Forms.Clipboard]::Clear() } catch { $code = 1 }
}
exit $code
`.trim();

/** -EncodedCommand pede UTF-16 LE em base64. */
function encodeScript(text = SCRIPT) {
  return Buffer.from(text, "utf16le").toString("base64");
}

function injectLogin(entry, deps = {}) {
  const platform = deps.platform || process.platform;
  const usuario = String(entry?.usuario || "");
  const senha = String(entry?.senha || "");
  if (!usuario && !senha) return Promise.resolve({ ok: false, error: "Esse login está incompleto." });
  if (platform === "win32") {
    const spawnImpl = deps.spawn || require("node:child_process").spawn;
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encodeScript()], {
          stdio: ["pipe", "ignore", "ignore"],
          windowsHide: true,
        });
      } catch {
        resolve({ ok: false, error: "Não consegui preparar o preenchimento." });
        return;
      }
      child.on("error", () => resolve({ ok: false, error: "Não consegui preparar o preenchimento." }));
      child.on("close", (code) => {
        resolve(code === 0
          ? { ok: true, method: "teclas" }
          : { ok: false, error: "Não consegui digitar na janela em foco." });
      });
      child.stdin.on?.("error", () => {});
      child.stdin.write(Buffer.from(JSON.stringify({ usuario, senha }), "utf8").toString("base64"));
      child.stdin.end();
    });
  }
  if (deps.clipboard) {
    if (usuario) deps.clipboard.writeText(usuario);
    if (senha) deps.clipboard.writeText(senha);
    deps.clipboard.clear();
    return Promise.resolve({ ok: true, method: "clipboard" });
  }
  return Promise.resolve({ ok: false, error: "O preenchimento automático por teclado está disponível no Windows." });
}

module.exports = { injectLogin, SCRIPT, CLIPBOARD_HELPERS, encodeScript };