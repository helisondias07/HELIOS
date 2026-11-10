"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("helios", {
  info: () => ipcRenderer.invoke("app:info"),
  listMeetings: () => ipcRenderer.invoke("meetings:list"),
  getMeeting: (id) => ipcRenderer.invoke("meetings:get", id),
  createMeeting: (input) => ipcRenderer.invoke("meetings:create", input),
  updateMeeting: (id, patch) => ipcRenderer.invoke("meetings:update", id, patch),
  deleteMeeting: (id) => ipcRenderer.invoke("meetings:delete", id),
  startMeeting: (id) => ipcRenderer.invoke("meetings:start", id),
  openMeeting: (id) => ipcRenderer.invoke("meeting:open", id),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  testKeys: () => ipcRenderer.invoke("settings:test"),
  setTheme: (theme) => ipcRenderer.send("window:theme", theme === "light" ? "light" : "dark"),
  openExternal: (url) => ipcRenderer.invoke("shell:open", url),
  openPersonal: () => ipcRenderer.invoke("personal:open"),
  personalInfo: () => ipcRenderer.invoke("personal:info"),
  glossaryGet: () => ipcRenderer.invoke("glossary:get"),
  glossarySet: (text) => ipcRenderer.invoke("glossary:set", text),
  glossaryOpen: () => ipcRenderer.invoke("glossary:open"),
  onMeetingsChanged: (cb) => ipcRenderer.on("meetings:changed", (_event, info) => cb(info)),
});
