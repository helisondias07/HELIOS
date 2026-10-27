"use strict";

/**
 * Ditado global. Atalho separado dos atalhos da reunião.
 * A janela do microfone fica escondida e sem proteção de captura (não é a pílula).
 * O texto falado não volta para o renderer principal e não entra na estatística.
 */

const path = require("node:path");
const { createVoiceHandlers } = require("./voice-host");
const { injectText } = require("./vault-inject");
const { cleanDictation } = require("../server/dictation");
const { cleanAppName } = require("../server/dictation-stats");
const { createDictationSession } = require("./dictation-session");
const { parseAccelerator, startReleaseWatch, watchRelease } = require("./dictation-keys");

function registerDictation({
  ipcMain,
  globalShortcut,
  BrowserWindow,
  vault,
  serverUrl,
  getApiToken,
  getMainWindow,
  platform = process.platform,
  spawn = require("node:child_process").spawn,
  spawnSync = require("node:child_process").spawnSync,
}) {
  let prefs = { enabled: false, mode: "alternar", accelerator: "", cleanup: true, style: "padrao", glossary: "", snippets: "" };
  let bound = "";
  let phase = "idle";
  let capture = null;
  let pending = null;
  let release = null;
  let holdWarningSent = false;
  const handlers = createVoiceHandlers({ getKey: (name) => vault.getKey(name) });

  function tell(next) {
    phase = next;
    const win = getMainWindow?.();
    if (win && !win.isDestroyed?.()) win.webContents.send("dictation:phase", next);
  }

  async function api(method, pathname, body) {
    const res = await fetch(`${serverUrl()}${pathname}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${getApiToken()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "O ditado não respondeu.");
    return data;
  }

  function foregroundApp() {
    if (platform !== "win32") return "desconhecido";
    try {
      const encoded = Buffer.from(`
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class HeliosFg { [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid); }'
$procId = [uint32]0
$handle = [HeliosFg]::GetForegroundWindow()
[HeliosFg]::GetWindowThreadProcessId($handle, [ref]$procId) | Out-Null
if ($procId -gt 0) { (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName }
`.trim(), "utf16le").toString("base64");
      const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        encoding: "utf8",
        timeout: 1500,
        windowsHide: true,
      });
      return cleanAppName(String(out.stdout || "").trim().split(/\r?\n/).pop());
    } catch {
      return "desconhecido";
    }
  }

  const session = createDictationSession({
    transcribe: (audio, mime) => handlers.transcribe(audio, mime),
    clean: (text) => cleanDictation(text, prefs),
    inject: (text) => injectText({ texto: text }, { platform }),
    record: (stats) => api("POST", "/api/ditado/uso", stats),
    appName: foregroundApp,
  });

  function ensureCapture() {
    if (capture && !capture.isDestroyed?.()) return capture;
    capture = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 320,
      height: 180,
      webPreferences: {
        preload: path.join(__dirname, "preload-dictation.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    capture.loadFile(path.join(__dirname, "..", "renderer", "dictation.html"));
    return capture;
  }

  function whenReady(win) {
    if (!win.webContents.isLoading()) return Promise.resolve();
    return new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  }

  async function startRecording() {
    if (phase !== "idle") return false;
    phase = "recording";
    const begun = await session.begin();
    if (!begun.ok) {
      tell("idle");
      return false;
    }
    tell("recording");
    const win = ensureCapture();
    await whenReady(win);
    pending = { started: Date.now() };
    win.webContents.send("dictation:record");
    return true;
  }

  function stopRecording() {
    if (release) {
      release.stop();
      release = null;
    }
    if (phase !== "recording") return;
    const win = capture;
    if (win && !win.isDestroyed?.()) win.webContents.send("dictation:stop");
    else session.cancel();
  }

  async function onAudio(_event, buf, mime) {
    if (phase !== "recording") return;
    tell("transcribing");
    const durationMs = pending ? Date.now() - pending.started : 0;
    pending = null;
    const result = await session.deliver({ audio: buf, mime, durationMs });
    tell("idle");
    const win = getMainWindow?.();
    if (result && result.ok === false && win && !win.isDestroyed?.()) {
      win.webContents.send("dictation:notice", result.error || "O ditado não foi.");
    }
  }

  async function onShortcut() {
    if (!prefs.enabled) return;
    if (prefs.mode === "segurar") {
      if (phase !== "idle") return;
      const parsed = parseAccelerator(prefs.accelerator);
      const started = await startRecording();
      if (!started) return;
      release = platform === "win32"
        ? startReleaseWatch({ vks: parsed?.vks || [], spawn, onRelease: stopRecording, platform })
        : watchRelease({ platform, onRelease: stopRecording });
      if (release && !release.watching && !holdWarningSent) {
        holdWarningSent = true;
        const win = getMainWindow?.();
        if (win && !win.isDestroyed?.()) win.webContents.send("dictation:notice", release.warning);
      }
      return;
    }
    if (phase === "recording") stopRecording();
    else if (phase === "idle") await startRecording();
  }

  function bind() {
    if (bound) {
      try { globalShortcut.unregister(bound); } catch { /* o atalho já saiu */ }
      bound = "";
    }
    if (!prefs.enabled || !prefs.accelerator) return { ok: true };
    try {
      const ok = globalShortcut.register(prefs.accelerator, onShortcut);
      if (!ok) return { ok: false, error: "Não consegui registrar esse atalho. Ele pode estar em uso." };
      bound = prefs.accelerator;
      return { ok: true };
    } catch {
      return { ok: false, error: "Não consegui registrar esse atalho." };
    }
  }

  async function refresh() {
    const data = await api("GET", "/api/ditado");
    prefs = data.prefs || prefs;
    return bind();
  }

  ipcMain.handle("dictation:refresh", () => refresh().catch((err) => ({ ok: false, error: err.message })));
  ipcMain.on("dictation:audio", (event, buf, mime) => {
    onAudio(event, buf, mime).catch(() => tell("idle"));
  });
  ipcMain.on("dictation:failed", () => {
    session.cancel();
    tell("idle");
    const win = getMainWindow?.();
    if (win && !win.isDestroyed?.()) win.webContents.send("dictation:notice", "Não consegui usar o microfone.");
  });

  refresh().catch(() => {});
  return { refresh, bind };
}

module.exports = { registerDictation };
