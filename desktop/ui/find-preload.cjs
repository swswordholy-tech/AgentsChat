"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentschatFind", {
  platform: process.platform,
  search: (query, opts) => ipcRenderer.invoke("desktop:find-query", query, opts),
  step: (forward) => ipcRenderer.invoke("desktop:find-step", Boolean(forward)),
  close: () => ipcRenderer.invoke("desktop:find-close"),
  onState: (cb) => {
    const handler = (_ev, state) => cb(state);
    ipcRenderer.on("desktop:find-state", handler);
    return () => ipcRenderer.removeListener("desktop:find-state", handler);
  },
  onFocus: (cb) => {
    const handler = (_ev, payload) => cb(payload);
    ipcRenderer.on("desktop:find-focus", handler);
    return () => ipcRenderer.removeListener("desktop:find-focus", handler);
  },
});
