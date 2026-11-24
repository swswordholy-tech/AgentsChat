"use strict";

/**
 * Zero-privilege sandboxed preload for the remote Cloud WebContentsView.
 *
 * Security invariants:
 * - Never calls `contextBridge.exposeInMainWorld` — remote web pages receive
 *   ZERO new globals or Electron IPC capabilities.
 * - Only observes DOM theme classes (`html.light` / `body.light`) and
 *   `ac_theme` storage mutations inside the isolated preload world and sends
 *   a validated `"light" | "dark"` string to the main process so the Desktop
 *   rail, Local workspace, and native menus stay in instant two-way sync.
 */
const { ipcRenderer } = require("electron");

(function () {
  let lastSent = null;

  function isHttpOrigin() {
    return location.protocol === "https:" || location.protocol === "http:";
  }

  function readObservedTheme() {
    try {
      const stored = localStorage.getItem("ac_theme");
      if (stored === "light" || stored === "dark") return stored;
    } catch {}
    const html = document.documentElement;
    const body = document.body;
    const isLight = Boolean(
      (body && body.classList && body.classList.contains("light")) ||
        (html && html.classList && html.classList.contains("light")),
    );
    return isLight ? "light" : "dark";
  }

  function notifyIfUserChanged() {
    if (!isHttpOrigin()) return;
    const html = document.documentElement;
    if (!html || html.dataset.acDesktopThemeReady !== "1") return;
    if (html.dataset.acDesktopSyncing === "1") return;
    const next = readObservedTheme();
    if (next === lastSent) return;
    lastSent = next;
    try {
      ipcRenderer.send("desktop:cloud-theme-observed", next);
    } catch {}
  }

  function startObserving() {
    if (!isHttpOrigin()) return;
    const html = document.documentElement;
    if (!html) return;

    const observer = new MutationObserver(() => {
      if (html.dataset.acDesktopSyncing === "1") {
        lastSent = readObservedTheme();
        return;
      }
      notifyIfUserChanged();
    });

    observer.observe(html, { attributes: true, attributeFilter: ["class", "data-ac-desktop-theme-ready"] });
    if (document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    }

    window.addEventListener("storage", (ev) => {
      if (ev && ev.key === "ac_theme" && (ev.newValue === "light" || ev.newValue === "dark")) {
        if (html.dataset.acDesktopSyncing === "1" || html.dataset.acDesktopThemeReady !== "1") return;
        if (ev.newValue === lastSent) return;
        lastSent = ev.newValue;
        try {
          ipcRenderer.send("desktop:cloud-theme-observed", ev.newValue);
        } catch {}
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserving, { once: true });
  } else {
    startObserving();
  }
})();
