"use strict";

/**
 * Atalho do ditado. Segurar a tecla só é observado no Windows, e só enquanto a gravação dura.
 * Fora do Windows, o mesmo atalho alterna ligar e desligar.
 */

const VK = { control: 0x11, shift: 0x10, alt: 0x12 };

function parseAccelerator(accel) {
  const parts = String(accel || "").split("+").filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts.pop();
  if (!/^[A-Za-z0-9]$/.test(key)) return null;
  const mods = [];
  for (const part of parts) {
    const name = part.toLowerCase();
    if (name === "commandorcontrol" || name === "control" || name === "ctrl" || name === "command") mods.push("control");
    else if (name === "shift") mods.push("shift");
    else if (name === "alt") mods.push("alt");
    else return null;
  }
  const unique = [...new Set(mods)];
  if (!unique.length) return null;
  const vks = unique.map((name) => VK[name]);
  vks.push(key.toUpperCase().charCodeAt(0));
  return { mods: unique, key: key.toUpperCase(), vks };
}

const HOLD_WARNING = "Segurar a tecla só funciona no Windows. O atalho alterna ligar e desligar.";

function watchRelease({ vks, poll, onRelease, intervalMs = 40, platform = "win32" } = {}) {
  if (platform !== "win32") return { watching: false, warning: HOLD_WARNING, stop() {} };
  const keys = Array.isArray(vks) ? vks : [];
  if (!keys.length || typeof poll !== "function") return { watching: false, warning: HOLD_WARNING, stop() {} };
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const down = keys.every((vk) => poll(vk));
    if (!down) {
      stopped = true;
      clearInterval(timer);
      if (typeof onRelease === "function") onRelease();
    }
  }, intervalMs);
  return {
    watching: true,
    warning: "",
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function releaseScript(vks) {
  const list = (Array.isArray(vks) ? vks : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0 && n < 256);
  return `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class HeliosKeyPoll { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey); }'
$keys = @(${list.join(", ")})
while ($true) {
  $down = $true
  foreach ($k in $keys) { if (([HeliosKeyPoll]::GetAsyncKeyState($k) -band 0x8000) -eq 0) { $down = $false } }
  if (-not $down) { exit 0 }
  Start-Sleep -Milliseconds 40
}
`.trim();
}

function startReleaseWatch({ vks, spawn, onRelease, platform = "win32" } = {}) {
  if (platform !== "win32") return { watching: false, warning: HOLD_WARNING, stop() {} };
  const script = releaseScript(vks);
  if (!/@\(\d/.test(script) || typeof spawn !== "function") return { watching: false, warning: HOLD_WARNING, stop() {} };
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let child;
  try {
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    return { watching: false, warning: HOLD_WARNING, stop() {} };
  }
  let stopped = false;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    if (typeof onRelease === "function") onRelease();
  };
  child.on?.("exit", finish);
  child.on?.("error", finish);
  return {
    watching: true,
    warning: "",
    stop() {
      stopped = true;
      try { child.kill(); } catch { /* já saiu */ }
    },
  };
}

module.exports = { parseAccelerator, watchRelease, releaseScript, startReleaseWatch, HOLD_WARNING, VK };
