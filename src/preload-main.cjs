"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("helios", {
  request: (method, pathname, body) => ipcRenderer.invoke("api", { method, pathname, body }),
  openMeeting: () => ipcRenderer.invoke("meeting:open"),
  // Leva H: as configurações do modo reunião saíram da janela flutuante e ficam em Ajustes › Reunião.
  meetingSettings: () => ipcRenderer.invoke("settings:get"),
  meetingSettingsSet: (patch) => ipcRenderer.invoke("settings:set", patch),
  meetingTestKeys: () => ipcRenderer.invoke("settings:test"),
  setTheme: (theme) => ipcRenderer.send("window:theme", theme === "light" ? "light" : "dark"),
  openExternal: (url) => ipcRenderer.invoke("shell:open", url),
  contextSave: (nome, texto) => ipcRenderer.invoke("contexto:salvar", { nome, texto }),
  vaultList: () => ipcRenderer.invoke("vault:list"),
  vaultGet: (id) => ipcRenderer.invoke("vault:get", id),
  vaultSave: (entry) => ipcRenderer.invoke("vault:save", entry),
  vaultRemove: (id) => ipcRenderer.invoke("vault:remove", id),
  vaultStartFresh: () => ipcRenderer.invoke("vault:start-fresh"),
  setKey: (name, value) => ipcRenderer.invoke("vault:set-key", { name, value }),
  vagasLogin: (platform) => ipcRenderer.invoke("vagas:login", platform),
  vagasAbrir: (id) => ipcRenderer.invoke("vagas:abrir", id),
  vagasJanela: () => ipcRenderer.invoke("vagas:janela"),
  vagasAuto: () => ipcRenderer.invoke("vagas:auto"),
  vagasFeed: () => ipcRenderer.invoke("vagas:feed"),
  mcpAccess: () => ipcRenderer.invoke("mcp:access"),
  mcpRegenerate: () => ipcRenderer.invoke("mcp:regenerate"),
  mcpRemoteStatus: () => ipcRenderer.invoke("mcp:remote-status"),
  mcpRemoteGenerate: () => ipcRenderer.invoke("mcp:remote-generate"),
  mcpRemoteRevoke: () => ipcRenderer.invoke("mcp:remote-revoke"),
  mcpRemoteCopy: () => ipcRenderer.invoke("mcp:remote-copy"),
  mcpRemoteSet: (patch) => ipcRenderer.invoke("mcp:remote-set", patch),
  voiceStatus: () => ipcRenderer.invoke("voice:status"),
  voiceTranscribe: (buf, mime) => ipcRenderer.invoke("voice:transcribe", buf, mime),
  voiceSpeak: (text) => ipcRenderer.invoke("voice:speak", text),
  dictationRefresh: () => ipcRenderer.invoke("dictation:refresh"),
  onDictationPhase: (cb) => ipcRenderer.on("dictation:phase", (_event, phase) => cb(phase)),
  onDictationNotice: (cb) => ipcRenderer.on("dictation:notice", (_event, text) => cb(text)),
});
