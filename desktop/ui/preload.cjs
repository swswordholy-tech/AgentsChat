"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentschatShell", {
  platform: process.platform,
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  switchWorkspace: (workspace) => ipcRenderer.invoke("desktop:switch-workspace", workspace),
  setTheme: (theme) => ipcRenderer.invoke("desktop:set-theme", theme),
  toggleLocalServer: (enabled) => ipcRenderer.invoke("desktop:toggle-local-server", enabled),
  updateSettings: (patch) => ipcRenderer.invoke("desktop:update-settings", patch),
  copyText: (text) => ipcRenderer.invoke("desktop:copy-text", text),
  captureScreenshot: () => ipcRenderer.invoke("desktop:capture-screenshot"),
  onStateChanged: (cb) => {
    const handler = (_ev, state) => cb(state);
    ipcRenderer.on("desktop:state-changed", handler);
    return () => ipcRenderer.removeListener("desktop:state-changed", handler);
  },
});
