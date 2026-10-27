"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dictation", {
  onStart: (cb) => ipcRenderer.on("dictation:record", () => cb()),
  onStop: (cb) => ipcRenderer.on("dictation:stop", () => cb()),
  audio: (buf, mime) => ipcRenderer.send("dictation:audio", buf, mime),
  failed: () => ipcRenderer.send("dictation:failed"),
});
