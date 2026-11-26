"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentschatSettings", {
  platform: process.platform,
  getState: () => ipcRenderer.invoke("desktop:get-settings-state"),
  saveSettings: (patch) => ipcRenderer.invoke("desktop:save-desktop-settings", patch),
  copyDiagnostics: () => ipcRenderer.invoke("desktop:copy-diagnostics"),
  openDataFolder: () => ipcRenderer.invoke("desktop:open-data-folder"),
  closeWindow: () => ipcRenderer.invoke("desktop:close-settings-window"),
  onStateChanged: (cb) => {
    const handler = (_ev, state) => cb(state);
    ipcRenderer.on("desktop:settings-state-changed", handler);
    return () => ipcRenderer.removeListener("desktop:settings-state-changed", handler);
  },
});
