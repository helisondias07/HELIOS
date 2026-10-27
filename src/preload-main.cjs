"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("helios", {
  request: (method, pathname, body) => ipcRenderer.invoke("api", { method, pathname, body }),
  openMeeting: () => ipcRenderer.invoke("meeting:open"),
  setTheme: (theme) => ipcRenderer.send("window:theme", theme === "light" ? "light" : "dark"),
  openExternal: (url) => ipcRenderer.invoke("shell:open", url),
  contextSave: (nome, texto) => ipcRenderer.invoke("contexto:salvar", { nome, texto }),
  vaultList: () => ipcRenderer.invoke("vault:list"),
  vaultGet: (id) => ipcRenderer.invoke("vault:get", id),
  vaultSave: (entry) => ipcRenderer.invoke("vault:save", entry),
  vaultRemove: (id) => ipcRenderer.invoke("vault:remove", id),
  vaultStartFresh: () => ipcRenderer.invoke("vault:start-fresh"),
  setKey: (name, value) => ipcRenderer.invoke("vault:set-key", { name, value }),
  mcpAccess: () => ipcRenderer.invoke("mcp:access"),
  mcpRegenerate: () => ipcRenderer.invoke("mcp:regenerate"),
  voiceStatus: () => ipcRenderer.invoke("voice:status"),
  voiceTranscribe: (buf, mime) => ipcRenderer.invoke("voice:transcribe", buf, mime),
  voiceSpeak: (text) => ipcRenderer.invoke("voice:speak", text),
});
