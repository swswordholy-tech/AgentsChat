"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentschatLocalBridge", {
  isDesktopApp: true,
  platform: process.platform,
  getBootstrapSession: () => ipcRenderer.invoke("desktop:get-local-bootstrap"),
  getServerStatus: () => ipcRenderer.invoke("desktop:get-local-server-status"),
  toggleAllowLan: (allowLan) => ipcRenderer.invoke("desktop:toggle-allow-lan", Boolean(allowLan)),
  activateDiscoveredProfile: (profileName) => ipcRenderer.invoke("desktop:activate-local-profile", profileName),
  switchToCloud: (targetPath) => ipcRenderer.invoke("desktop:open-cloud-path", targetPath || "/"),
  copyText: (text) => ipcRenderer.invoke("desktop:copy-text", text),
});
