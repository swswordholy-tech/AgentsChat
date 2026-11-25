"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentschatShell", {
  platform: process.platform,
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  switchWorkspace: (workspace) => ipcRenderer.invoke("desktop:switch-workspace", workspace),
  setTheme: (theme) => ipcRenderer.invoke("desktop:set-theme", theme),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke("desktop:set-always-on-top", Boolean(enabled)),
  setNotificationsMuted: (muted) => ipcRenderer.invoke("desktop:set-notifications-muted", Boolean(muted)),
  toggleLocalServer: (enabled) => ipcRenderer.invoke("desktop:toggle-local-server", enabled),
  updateSettings: (patch) => ipcRenderer.invoke("desktop:update-settings", patch),
  copyText: (text) => ipcRenderer.invoke("desktop:copy-text", text),
  captureScreenshot: () => ipcRenderer.invoke("desktop:capture-screenshot"),
  navigateCloudRoute: (route) => ipcRenderer.invoke("desktop:navigate-cloud-route", route),
  cloudHistory: (direction) => ipcRenderer.invoke("desktop:cloud-history", direction),
  reloadActiveView: () => ipcRenderer.invoke("desktop:reload-active"),
  resetZoom: () => ipcRenderer.invoke("desktop:reset-zoom"),
  copyCurrentCloudUrl: () => ipcRenderer.invoke("desktop:copy-cloud-url"),
  openCurrentCloudInBrowser: () => ipcRenderer.invoke("desktop:open-cloud-browser"),
  onStateChanged: (cb) => {
    const handler = (_ev, state) => cb(state);
    ipcRenderer.on("desktop:state-changed", handler);
    return () => ipcRenderer.removeListener("desktop:state-changed", handler);
  },
});
