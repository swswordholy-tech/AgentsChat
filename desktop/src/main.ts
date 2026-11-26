import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  screen,
  shell,
  Tray,
  WebContentsView,
} from "electron";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateDownloadProgress,
  buildCloudThemeSyncScript,
  buildLocalChannelUrl,
  buildOfflineThemeSyncScript,
  buildSelectionLookupInfo,
  checkLatestDesktopRelease,
  clampDesktopZoomFactor,
  classifyCloudRailSection,
  computeCenteredWindowBounds,
  computeDisplayReclampedBounds,
  computeDownloadProgress,
  computeFindBarBounds,
  createSerialTaskQueue,
  formatCopyableCloudUrl,
  formatDesktopDiagnostics,
  formatDesktopWindowTitle,
  formatDownloadCompleteNotice,
  formatFindMatchCounter,
  formatLocalMcpCommand,
  formatTrayTooltip,
  isAllowedLocalViewNavigation,
  isCloudOfflinePageUrl,
  isLocalStoppedPageUrl,
  isOAuthPopupUrl,
  isTrustedCloudThemeOrigin,
  parseDeepLink,
  parseUnreadCountFromTitle,
  resolveBeforeInputShortcut,
  resolveCloudHistoryCommand,
  resolveCloudQuickRoute,
  resolveOfflineRetryUrl,
  resolveRestoredWindowBounds,
  resolveSmartReloadAction,
  resolveWorkspaceCopyAction,
  sanitizeFindSeedText,
  sanitizeLocalProfileName,
  shouldGrantWebPermission,
  type CloudQuickRoute,
} from "./desktop-helpers.js";
import { GlobalIdentityAuthority, resolveHomeDir } from "./identity-authority.js";
import { LocalMiniServer } from "./local-server.js";
import { DesktopSettingsStore } from "./settings-store.js";
import type { DesktopSettings, LocalServerStatus } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui");
const ASSETS_DIR = join(__dirname, "..", "assets");
const RAIL_WIDTH = 72;

// Fallback 16x16 PNG data URL if tray-icon.png is unavailable
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVQ4T2NkoBAwUqifYdQABgZGBv8MDAz/yWLD////GXG5DF0DsiF4XYYugM9l2AxgxOcybAbgcxk2Awi5DFcAIZfhCiDkMlwBhFyGK2B0GDAyMDAwAABnTRkR6z51AAAAAElFTkSuQmCC";

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let cloudView: WebContentsView | null = null;
let localView: WebContentsView | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let localUnreadCount = 0;
let cloudUnreadCount = 0;
let cloudLoading = false;
let lastCloudFailedUrl: string | null = null;
let pendingDeepLinkUrl: string | null = null;
let screenshotInFlight = false;

async function captureScreenshotToChat(): Promise<{ ok: boolean; pasted?: boolean; reason?: string }> {
  if (screenshotInFlight) return { ok: false, reason: "in_flight" };
  if (process.platform !== "darwin") {
    return { ok: false, reason: "unsupported_platform" };
  }
  screenshotInFlight = true;
  try {
    const beforePng = clipboard.readImage().toPNG();
    const exitCode = await new Promise<number>((resolve) => {
      execFile("/usr/sbin/screencapture", ["-i", "-c"], { timeout: 120_000 }, (err) => {
        resolve(err ? 1 : 0);
      });
    });
    if (exitCode !== 0) return { ok: false, reason: "cancelled" };
    const afterImg = clipboard.readImage();
    if (afterImg.isEmpty()) return { ok: false, reason: "empty" };
    const afterPng = afterImg.toPNG();
    if (beforePng.length > 0 && beforePng.equals(afterPng)) {
      return { ok: false, reason: "cancelled" };
    }
    showMainWindow();
    if (
      settings.activeWorkspace === "cloud" &&
      cloudView &&
      !cloudView.webContents.isDestroyed() &&
      !isCloudOfflinePageUrl(cloudView.webContents.getURL())
    ) {
      cloudView.webContents.focus();
      setTimeout(() => {
        if (cloudView && !cloudView.webContents.isDestroyed()) {
          cloudView.webContents.paste();
        }
      }, 90);
      return { ok: true, pasted: true };
    }
    // In local workspace, keep image on clipboard and notify user
    if (Notification.isSupported()) {
      new Notification({
        title: "截图已复制到剪贴板",
        body: "切换到云端聊天室按 ⌘V 即可直接粘贴发送",
        silent: settings.notificationsMuted === true,
      }).show();
    }
    return { ok: true, pasted: false };
  } finally {
    screenshotInFlight = false;
  }
}
let boundsSaveTimer: NodeJS.Timeout | null = null;
let findView: WebContentsView | null = null;
let findBarOpen = false;
let findQueryText = "";
let findMatchCase = false;
let findActiveOrdinal = 0;
let findTotalMatches = 0;
const smokeRendererErrors: string[] = [];

const isSmokeTest = process.env.AGENTSCHAT_DESKTOP_SMOKE_TEST === "1";
const startHidden = !isSmokeTest && process.argv.includes("--hidden");
const desktopDataDir =
  process.env.AGENTSCHAT_DESKTOP_DATA_DIR?.trim() ||
  join(resolveHomeDir(), ".agentschat", "desktop");
const settingsFilePath = join(desktopDataDir, "settings.json");
const settingsStore = new DesktopSettingsStore(settingsFilePath);
let settings: DesktopSettings = settingsStore.load();
let localServer: LocalMiniServer | null = null;
const runLocalServerOp = createSerialTaskQueue();

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function syncUnreadBadge(): void {
  const effectiveLocalUnread = settings.showLocalWorkspace ? localUnreadCount : 0;
  const totalUnread = Math.max(0, effectiveLocalUnread + cloudUnreadCount);
  const st = settings.showLocalWorkspace ? localServer?.getStatus() : null;
  try {
    if (typeof app.setBadgeCount === "function") {
      app.setBadgeCount(totalUnread);
    }
  } catch {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(
      formatDesktopWindowTitle({
        activeWorkspace: settings.activeWorkspace,
        cloudSection: getCloudNavState().section,
        cloudUnread: cloudUnreadCount,
        localUnread: effectiveLocalUnread,
        localRunning: Boolean(st?.running),
        localPort: st?.port,
      }),
    );
  }
  if (tray) {
    try {
      tray.setToolTip(
        formatTrayTooltip({
          cloudUnread: cloudUnreadCount,
          localUnread: effectiveLocalUnread,
          showLocalWorkspace: settings.showLocalWorkspace,
          localRunning: Boolean(st?.running),
          localPort: st?.port,
          localOnlineCount: st?.connectedAgents?.length || 0,
          notificationsMuted: settings.notificationsMuted === true,
          audioMuted: settings.audioMuted === true,
        }),
      );
    } catch {}
  }
}

function applyDesktopZoom(nextFactor: number): void {
  const clamped = clampDesktopZoomFactor(nextFactor);
  settings = settingsStore.save({ zoomFactor: clamped });
  if (cloudView && !cloudView.webContents.isDestroyed()) {
    try { cloudView.webContents.setZoomFactor(clamped); } catch {}
  }
  if (localView && !localView.webContents.isDestroyed()) {
    try { localView.webContents.setZoomFactor(clamped); } catch {}
  }
  broadcastState();
}

function reloadWebContentsSmart(
  wc: Electron.WebContents,
  workspace: "cloud" | "local",
  ignoreCache = false,
): boolean {
  if (!wc || wc.isDestroyed()) return false;
  const st = localServer?.getStatus();
  const action = resolveSmartReloadAction({
    workspace,
    currentUrl: wc.getURL() || "",
    lastCloudFailedUrl,
    remoteServerUrl: settings.remoteServerUrl,
    localRunning: Boolean(st?.running),
    localHttpUrl: st?.httpUrl ?? null,
  });
  if (action.kind === "loadUrl") {
    void wc.loadURL(action.url);
    return true;
  }
  if (ignoreCache) {
    wc.reloadIgnoringCache();
  } else {
    wc.reload();
  }
  return true;
}

function reloadActiveView(): boolean {
  const workspace = settings.activeWorkspace === "local" ? "local" : "cloud";
  const target = workspace === "local" ? localView : cloudView;
  if (target && !target.webContents.isDestroyed()) {
    return reloadWebContentsSmart(target.webContents, workspace);
  }
  return false;
}

function forceReloadActiveView(): boolean {
  const workspace = settings.activeWorkspace === "local" ? "local" : "cloud";
  const target = workspace === "local" ? localView : cloudView;
  if (target && !target.webContents.isDestroyed()) {
    return reloadWebContentsSmart(target.webContents, workspace, true);
  }
  return false;
}

async function clearCloudWebCache(): Promise<boolean> {
  if (!cloudView || cloudView.webContents.isDestroyed()) return false;
  try {
    await cloudView.webContents.session.clearCache();
    reloadWebContentsSmart(cloudView.webContents, "cloud", true);
    return true;
  } catch {
    return false;
  }
}

function getCurrentSafeCloudUrl(): string | null {
  if (!cloudView || cloudView.webContents.isDestroyed()) return null;
  return formatCopyableCloudUrl(cloudView.webContents.getURL(), settings.remoteServerUrl);
}

function copyCurrentCloudUrl(notify = true): string | null {
  const url = getCurrentSafeCloudUrl();
  if (!url) return null;
  clipboard.writeText(url);
  if (notify && Notification.isSupported()) {
    new Notification({
      title: "已复制当前页面链接",
      body: url,
      silent: true,
    }).show();
  }
  return url;
}

function copyActiveWorkspaceLinkOrCommand(notify = true): string | null {
  const st = localServer?.getStatus();
  const action = resolveWorkspaceCopyAction({
    activeWorkspace: settings.activeWorkspace,
    cloudUrl: cloudView && !cloudView.webContents.isDestroyed() ? cloudView.webContents.getURL() : null,
    remoteServerUrl: settings.remoteServerUrl,
    localHttpUrl: st?.httpUrl,
    localRunning: Boolean(st?.running),
  });
  if (!action) return null;
  clipboard.writeText(action.text);
  if (notify && Notification.isSupported()) {
    new Notification({
      title: action.title,
      body: action.text,
      silent: true,
    }).show();
  }
  return action.text;
}

function openCurrentCloudUrlInBrowser(): boolean {
  const url = getCurrentSafeCloudUrl();
  if (!url) return false;
  void shell.openExternal(url);
  return true;
}

const permissionSessionsAttached = new WeakSet<Electron.Session>();

function attachSessionPermissionGuards(wc: Electron.WebContents, workspace: "cloud" | "local"): void {
  const ses = wc.session;
  if (!ses || permissionSessionsAttached.has(ses)) return;
  permissionSessionsAttached.add(ses);
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = (details as { requestingUrl?: string } | undefined)?.requestingUrl || webContents.getURL();
    callback(
      shouldGrantWebPermission({
        workspace,
        permission,
        requestingOrigin: origin,
        remoteServerUrl: settings.remoteServerUrl,
        notificationsMuted: settings.notificationsMuted === true,
      }),
    );
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    shouldGrantWebPermission({
      workspace,
      permission,
      requestingOrigin,
      remoteServerUrl: settings.remoteServerUrl,
      notificationsMuted: settings.notificationsMuted === true,
    }),
  );
}

const downloadSessionsAttached = new WeakSet<Electron.Session>();
const activeDownloadItems = new Set<Electron.DownloadItem>();

function syncDownloadProgressBar(): void {
  if (isSmokeTest || !mainWindow || mainWindow.isDestroyed()) return;
  if (activeDownloadItems.size === 0) {
    try { mainWindow.setProgressBar(-1); } catch {}
    return;
  }
  const samples = Array.from(activeDownloadItems).map((it) => ({
    receivedBytes: it.getReceivedBytes(),
    totalBytes: it.getTotalBytes(),
    state: it.getState(),
  }));
  const progress =
    samples.length === 1 && samples[0].state === "progressing"
      ? computeDownloadProgress(samples[0].receivedBytes, samples[0].totalBytes)
      : aggregateDownloadProgress(samples);
  try { mainWindow.setProgressBar(progress); } catch {}
}

function attachDownloadFeedback(wc: Electron.WebContents): void {
  const ses = wc.session;
  if (!ses || downloadSessionsAttached.has(ses)) return;
  downloadSessionsAttached.add(ses);
  ses.on("will-download", (_ev, item) => {
    activeDownloadItems.add(item);
    syncDownloadProgressBar();
    item.on("updated", () => {
      syncDownloadProgressBar();
    });
    item.once("done", (_doneEv, state) => {
      activeDownloadItems.delete(item);
      syncDownloadProgressBar();
      if (isSmokeTest || state !== "completed") return;
      const savePath = item.getSavePath();
      if (!savePath || !Notification.isSupported()) return;
      const notice = formatDownloadCompleteNotice(item.getFilename() || savePath);
      const notif = new Notification({
        title: notice.title,
        body: notice.body,
        silent: settings.notificationsMuted === true,
      });
      notif.on("click", () => {
        try { shell.showItemInFolder(savePath); } catch {}
      });
      notif.show();
    });
  });
}

function attachNativeContextMenu(wc: Electron.WebContents): void {
  wc.on("context-menu", (_ev, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    const hasSelection = Boolean(params.selectionText && params.selectionText.trim().length > 0);
    const hasSafeLink = Boolean(params.linkURL && isAllowedExternalUrl(params.linkURL));
    const hasImage = params.mediaType === "image";
    const hasSafeImageUrl = Boolean(hasImage && params.srcURL && isAllowedExternalUrl(params.srcURL));

    if (params.isEditable) {
      if (params.misspelledWord) {
        if (Array.isArray(params.dictionarySuggestions) && params.dictionarySuggestions.length > 0) {
          for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
            items.push({
              label: suggestion,
              click: () => {
                try { wc.replaceMisspelling(suggestion); } catch {}
              },
            });
          }
        }
        items.push({
          label: "Add to Dictionary",
          click: () => {
            try { wc.session.addWordToSpellCheckerDictionary(params.misspelledWord); } catch {}
          },
        });
        items.push({ type: "separator" });
      }
      items.push(
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut", enabled: hasSelection },
        { role: "copy", enabled: hasSelection },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { type: "separator" },
        { role: "selectAll" },
      );
    } else if (hasSelection) {
      const lookup = buildSelectionLookupInfo(params.selectionText);
      if (lookup) {
        if (process.platform === "darwin") {
          items.push({
            label: `Look Up “${lookup.label}”`,
            click: () => {
              try { wc.showDefinitionForSelection(); } catch {}
            },
          });
        }
        if (lookup.searchUrl) {
          const searchUrl = lookup.searchUrl;
          items.push({
            label: "Search with Google",
            click: () => void shell.openExternal(searchUrl),
          });
        }
        const findSeed = sanitizeFindSeedText(params.selectionText);
        if (findSeed) {
          items.push({
            label: `Find “${lookup.label}” on Page`,
            click: () => {
              openFindBar({ seedQuery: findSeed, triggerSearch: true });
            },
          });
        }
        if (items.length > 0) items.push({ type: "separator" });
      }
      items.push({ role: "copy" });
    }

    if (hasSafeLink) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push(
        {
          label: "Copy Link Address",
          click: () => clipboard.writeText(params.linkURL),
        },
        {
          label: "Open Link in Browser",
          click: () => void shell.openExternal(params.linkURL),
        },
      );
    }

    if (hasImage) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push({
        label: "Copy Image",
        click: () => {
          try { wc.copyImageAt(params.x, params.y); } catch {}
        },
      });
      if (hasSafeImageUrl) {
        items.push(
          {
            label: "Copy Image Link",
            click: () => clipboard.writeText(params.srcURL),
          },
          {
            label: "Save Image As…",
            click: () => {
              try { wc.downloadURL(params.srcURL); } catch {}
            },
          },
          {
            label: "Open Image in Browser",
            click: () => void shell.openExternal(params.srcURL),
          },
        );
      }
    }

    if (items.length === 0) {
      const canBack = wc.navigationHistory?.canGoBack?.() ?? false;
      const canFwd = wc.navigationHistory?.canGoForward?.() ?? false;
      const safePageUrl = formatCopyableCloudUrl(wc.getURL(), settings.remoteServerUrl);
      const targetWorkspace: "cloud" | "local" =
        localView && !localView.webContents.isDestroyed() && wc === localView.webContents ? "local" : "cloud";
      items.push(
        { label: "Back", enabled: canBack, click: () => wc.navigationHistory.goBack() },
        { label: "Forward", enabled: canFwd, click: () => wc.navigationHistory.goForward() },
        { label: "Reload", click: () => { reloadWebContentsSmart(wc, targetWorkspace); } },
      );
      if (safePageUrl) {
        items.push(
          { type: "separator" },
          {
            label: "Copy Page Link",
            click: () => clipboard.writeText(safePageUrl),
          },
          {
            label: "Open Page in Browser",
            click: () => void shell.openExternal(safePageUrl),
          },
        );
      } else if (localView && !localView.webContents.isDestroyed() && wc === localView.webContents) {
        const st = localServer?.getStatus();
        if (st?.running) {
          items.push(
            { type: "separator" },
            {
              label: "Copy Local MCP Command",
              click: () => clipboard.writeText(formatLocalMcpCommand(st.httpUrl)),
            },
          );
        }
      }
    }

    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: mainWindow ?? undefined });
  });
}

function clearLocalUnread(): void {
  if (localUnreadCount !== 0) {
    localUnreadCount = 0;
    syncUnreadBadge();
    broadcastState();
  }
}

async function ensureLocalServerStarted(): Promise<LocalServerStatus | null> {
  if (!settings.showLocalWorkspace || !settings.localServerEnabled) {
    if (localServer) {
      await localServer.closeAll();
      localServer = null;
    }
    return null;
  }
  if (localServer) {
    return localServer.getStatus();
  }

  const createInstance = (port: number) =>
    new LocalMiniServer({
      port,
      host: settings.allowLan ? "0.0.0.0" : "127.0.0.1",
      dbPath: join(desktopDataDir, "local-hub.sqlite"),
      upstreamUrl: settings.remoteServerUrl,
      staticUiDir: UI_DIR,
      onMessageReceived: (msg, channelName) => {
        const winFocusedOnLocal = Boolean(
          mainWindow &&
          !mainWindow.isDestroyed() &&
          mainWindow.isFocused() &&
          settings.activeWorkspace === "local",
        );
        if (!winFocusedOnLocal && msg.sender_type === "agent") {
          localUnreadCount += 1;
          syncUnreadBadge();
          if (settings.notificationsMuted !== true && Notification.isSupported()) {
            const notif = new Notification({
              title: `${msg.sender_name || msg.sender_id} · #${channelName} (Local)`,
              body: msg.content.slice(0, 140),
            });
            notif.on("click", () => {
              showMainWindow();
              void openLocalChannel(msg.channel_id);
            });
            notif.show();
          }
        }
        broadcastState();
      },
    });

  try {
    localServer = createInstance(isSmokeTest ? 0 : settings.localServerPort);
    return await localServer.start();
  } catch {
    // Port busy — fall back cleanly to an ephemeral loopback port
    localServer = createInstance(0);
    return await localServer.start();
  }
}

function getCloudNavState() {
  if (!cloudView || cloudView.webContents.isDestroyed()) {
    return { section: "lobby" as CloudQuickRoute, canGoBack: false, canGoForward: false, isLoading: false };
  }
  const currentUrl = cloudView.webContents.getURL();
  return {
    section: classifyCloudRailSection(currentUrl, settings.remoteServerUrl),
    canGoBack: cloudView.webContents.navigationHistory?.canGoBack?.() ?? false,
    canGoForward: cloudView.webContents.navigationHistory?.canGoForward?.() ?? false,
    isLoading: cloudLoading,
  };
}

function getCombinedState() {
  const showLocal = settings.showLocalWorkspace === true;
  return {
    platform: process.platform,
    isFullScreen: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()),
    settingsWindowOpen: Boolean(settingsWindow && !settingsWindow.isDestroyed()),
    settings,
    localServer: showLocal && localServer ? localServer.getStatus() : null,
    localUnreadCount: showLocal ? localUnreadCount : 0,
    cloudUnreadCount,
    cloudNav: getCloudNavState(),
    discoveredProfiles: showLocal ? GlobalIdentityAuthority.discoverLocalAgentProfiles() : [],
  };
}

function getSettingsWindowState() {
  return {
    ...getCombinedState(),
    settingsFilePath,
    appVersion: app.getVersion() || "0.1.0",
  };
}

function syncThemeToCloudView(nextTheme: "light" | "dark"): void {
  if (!cloudView || cloudView.webContents.isDestroyed()) return;
  try {
    const currentUrl = cloudView.webContents.getURL();
    if (!currentUrl) return;
    if (isCloudOfflinePageUrl(currentUrl)) {
      void cloudView.webContents.executeJavaScript(buildOfflineThemeSyncScript(nextTheme), true).catch(() => {});
      return;
    }
    if (!isTrustedCloudThemeOrigin(currentUrl, settings.remoteServerUrl)) return;
    void cloudView.webContents.executeJavaScript(buildCloudThemeSyncScript(nextTheme), true).catch(() => {});
  } catch {}
}

function syncThemeToLocalView(nextTheme: "light" | "dark"): void {
  if (!localView || localView.webContents.isDestroyed()) return;
  try {
    const currentUrl = localView.webContents.getURL();
    if (isLocalStoppedPageUrl(currentUrl)) {
      void localView.webContents.executeJavaScript(buildOfflineThemeSyncScript(nextTheme), true).catch(() => {});
      return;
    }
    localView.webContents.send("desktop:theme-changed", nextTheme);
  } catch {}
}

async function loadLocalStoppedPage(): Promise<void> {
  if (!localView || localView.webContents.isDestroyed() || isSmokeTest) return;
  await localView.webContents.loadFile(join(UI_DIR, "local-stopped.html"), {
    query: {
      theme: settings.theme || "light",
      port: String(settings.localServerPort || 8787),
    },
  });
}

function applyDesktopTheme(nextTheme: "light" | "dark", opts?: { skipCloudSync?: boolean }): void {
  settings = settingsStore.save({ theme: nextTheme });
  try {
    nativeTheme.themeSource = nextTheme;
  } catch {}
  const bg = nextTheme === "dark" ? "#232323" : "#e9eaec";
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setBackgroundColor(bg);
    } catch {}
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try {
      settingsWindow.setBackgroundColor(nextTheme === "dark" ? "#1c1c1e" : "#f3f4f6");
    } catch {}
  }
  if (findView && !findView.webContents.isDestroyed()) {
    try {
      findView.setBackgroundColor(nextTheme === "dark" ? "#262629" : "#ffffff");
    } catch {}
    syncFindBarState();
  }
  syncThemeToLocalView(nextTheme);
  if (!opts?.skipCloudSync) {
    syncThemeToCloudView(nextTheme);
  }
  broadcastState();
}

function broadcastState(): void {
  const snapshot = getCombinedState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:state-changed", snapshot);
    mainWindow.setTitle(
      formatDesktopWindowTitle({
        activeWorkspace: settings.activeWorkspace,
        cloudSection: snapshot.cloudNav.section,
        cloudUnread: cloudUnreadCount,
        localUnread: snapshot.localUnreadCount,
        localRunning: Boolean(snapshot.localServer?.running),
        localPort: snapshot.localServer?.port,
      }),
    );
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("desktop:settings-state-changed", {
      ...snapshot,
      settingsFilePath,
      appVersion: app.getVersion() || "0.1.0",
    });
  }
  rebuildTrayMenu();
  rebuildDockMenu();
}

function getActiveWorkspaceWebContents(): Electron.WebContents | null {
  const showLocal = settings.showLocalWorkspace === true;
  const target = settings.activeWorkspace === "local" && showLocal ? localView : cloudView;
  if (!target || target.webContents.isDestroyed()) return null;
  return target.webContents;
}

function syncFindBarState(): void {
  if (!findView || findView.webContents.isDestroyed()) return;
  try {
    findView.webContents.send("desktop:find-state", {
      theme: settings.theme || "light",
      matches: findTotalMatches,
      matchCase: findMatchCase,
      counterText: formatFindMatchCounter(findActiveOrdinal, findTotalMatches, findQueryText.length > 0),
    });
  } catch {}
}

function openFindBar(opts?: { seedQuery?: string | null; triggerSearch?: boolean }): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || !findView || findView.webContents.isDestroyed()) return false;
  if (!isSmokeTest) showMainWindow();
  const seed = opts?.seedQuery !== undefined ? sanitizeFindSeedText(opts.seedQuery) : null;
  findBarOpen = true;
  layoutViews();
  let alreadySearched = false;
  if (seed) {
    findQueryText = seed;
    if (opts?.triggerSearch !== false) {
      alreadySearched = runFindInPage(seed, findMatchCase);
    }
  }
  try {
    findView.webContents.focus();
    findView.webContents.send("desktop:find-focus", {
      theme: settings.theme || "light",
      matches: findTotalMatches,
      matchCase: findMatchCase,
      counterText: formatFindMatchCounter(findActiveOrdinal, findTotalMatches, findQueryText.length > 0),
      ...(seed ? { seedQuery: seed, alreadySearched } : {}),
    });
  } catch {}
  return true;
}

async function useSelectionForFind(): Promise<boolean> {
  const wc = getActiveWorkspaceWebContents();
  if (!wc) return openFindBar();
  try {
    const raw = await wc.executeJavaScript(
      `(() => { try { return String(window.getSelection?.() || ""); } catch { return ""; } })()`,
      true,
    );
    const seed = sanitizeFindSeedText(raw);
    if (seed) {
      return openFindBar({ seedQuery: seed, triggerSearch: true });
    }
  } catch {}
  return openFindBar();
}

function closeFindBar(opts?: { restoreFocus?: boolean }): boolean {
  const wasOpen = findBarOpen;
  findBarOpen = false;
  findActiveOrdinal = 0;
  findTotalMatches = 0;
  for (const view of [cloudView, localView]) {
    if (view && !view.webContents.isDestroyed()) {
      try {
        view.webContents.stopFindInPage("clearSelection");
      } catch {}
    }
  }
  layoutViews();
  syncFindBarState();
  if (wasOpen && opts?.restoreFocus !== false) {
    const activeWc = getActiveWorkspaceWebContents();
    if (activeWc) {
      try { activeWc.focus(); } catch {}
    }
  }
  return wasOpen;
}

function runFindInPage(rawQuery: unknown, matchCase: boolean): boolean {
  const query = typeof rawQuery === "string" ? rawQuery.slice(0, 500) : "";
  findQueryText = query;
  findMatchCase = Boolean(matchCase);
  const wc = getActiveWorkspaceWebContents();
  if (!wc) return false;
  if (!query) {
    findActiveOrdinal = 0;
    findTotalMatches = 0;
    try { wc.stopFindInPage("clearSelection"); } catch {}
    syncFindBarState();
    return true;
  }
  try {
    wc.findInPage(query, { forward: true, findNext: false, matchCase: findMatchCase });
    return true;
  } catch {
    return false;
  }
}

function stepFindInPage(forward: boolean): boolean {
  if (!findQueryText) {
    return openFindBar();
  }
  const wc = getActiveWorkspaceWebContents();
  if (!wc) return false;
  if (!findBarOpen) {
    findBarOpen = true;
    layoutViews();
  }
  try {
    wc.findInPage(findQueryText, { forward: Boolean(forward), findNext: true, matchCase: findMatchCase });
    return true;
  } catch {
    return false;
  }
}

function attachFindInPageResults(wc: Electron.WebContents, workspace: "cloud" | "local"): void {
  wc.on("found-in-page", (_ev, result) => {
    if (!findBarOpen) return;
    const activeWs: "cloud" | "local" =
      settings.activeWorkspace === "local" && settings.showLocalWorkspace === true ? "local" : "cloud";
    if (workspace !== activeWs) return;
    findActiveOrdinal = Number(result?.activeMatchOrdinal || 0);
    findTotalMatches = Number(result?.matches || 0);
    syncFindBarState();
  });
}

function layoutViews(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const bounds = {
    x: RAIL_WIDTH,
    y: 0,
    width: Math.max(320, width - RAIL_WIDTH),
    height: Math.max(240, height),
  };
  if (cloudView) {
    cloudView.setBounds(settings.activeWorkspace === "cloud" ? bounds : { x: RAIL_WIDTH, y: 0, width: 0, height: 0 });
    cloudView.setVisible(settings.activeWorkspace === "cloud");
  }
  if (localView) {
    localView.setBounds(settings.activeWorkspace === "local" ? bounds : { x: RAIL_WIDTH, y: 0, width: 0, height: 0 });
    localView.setVisible(settings.activeWorkspace === "local");
  }
  if (findView) {
    if (findBarOpen) {
      findView.setBounds(computeFindBarBounds(width, height, RAIL_WIDTH));
      findView.setVisible(true);
    } else {
      findView.setBounds({ x: RAIL_WIDTH, y: 0, width: 0, height: 0 });
      findView.setVisible(false);
    }
  }
}

async function readCloudTokenIfSameOrigin(): Promise<string | null> {
  if (!cloudView || cloudView.webContents.isDestroyed()) return null;
  try {
    const currentUrl = cloudView.webContents.getURL();
    if (!currentUrl) return null;
    const expectedOrigin = new URL(settings.remoteServerUrl).origin;
    if (new URL(currentUrl).origin !== expectedOrigin) return null;
    const token = await cloudView.webContents.executeJavaScript(
      `(() => { try { return localStorage.getItem('ac_token') || ''; } catch { return ''; } })()`,
      true,
    );
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

async function switchWorkspace(target: "cloud" | "local"): Promise<void> {
  if (findBarOpen) closeFindBar({ restoreFocus: false });
  const effectiveTarget: "cloud" | "local" =
    target === "local" && settings.showLocalWorkspace ? "local" : "cloud";
  settings = settingsStore.save({ activeWorkspace: effectiveTarget });
  if (effectiveTarget === "local") {
    localUnreadCount = 0;
    syncUnreadBadge();
    const st = await runLocalServerOp(() => ensureLocalServerStarted());
    if (st && localView && !localView.webContents.isDestroyed()) {
      const currentUrl = localView.webContents.getURL();
      if (!currentUrl.startsWith(st.httpUrl)) {
        await localView.webContents.loadURL(st.httpUrl);
      } else {
        localView.webContents.send("desktop:workspace-activated");
      }
    } else if (!st && localView && !localView.webContents.isDestroyed()) {
      if (!isLocalStoppedPageUrl(localView.webContents.getURL())) {
        await loadLocalStoppedPage();
      }
    }
  }
  layoutViews();
  if (!isSmokeTest) {
    const activeView = effectiveTarget === "local" ? localView : cloudView;
    if (activeView && !activeView.webContents.isDestroyed()) {
      try { activeView.webContents.focus(); } catch {}
    }
  }
  broadcastState();
}

async function navigateCloudQuickRoute(route: unknown): Promise<boolean> {
  const targetUrl = resolveCloudQuickRoute(route, settings.remoteServerUrl);
  if (!targetUrl) return false;
  await switchWorkspace("cloud");
  if (!cloudView || cloudView.webContents.isDestroyed()) return false;
  const currentUrl = cloudView.webContents.getURL();
  const currentSection = classifyCloudRailSection(currentUrl, settings.remoteServerUrl);
  // Clicking Lobby when already on Lobby/Chat preserves the active room without reloading
  if (route === "lobby" && currentSection === "lobby" && currentUrl.startsWith(new URL(settings.remoteServerUrl).origin)) {
    broadcastState();
    return true;
  }
  await cloudView.webContents.loadURL(targetUrl);
  broadcastState();
  return true;
}

function navigateCloudHistory(direction: "back" | "forward"): boolean {
  if (settings.activeWorkspace !== "cloud") return false;
  if (!cloudView || cloudView.webContents.isDestroyed()) return false;
  const nav = cloudView.webContents.navigationHistory;
  if (!nav) return false;
  if (direction === "back" && nav.canGoBack()) {
    nav.goBack();
    return true;
  }
  if (direction === "forward" && nav.canGoForward()) {
    nav.goForward();
    return true;
  }
  return false;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openLocalChannel(channelId?: string | null): Promise<void> {
  await switchWorkspace("local");
  const st = localServer?.getStatus();
  if (!st || !localView || localView.webContents.isDestroyed()) return;
  const targetUrl = buildLocalChannelUrl(st.httpUrl, channelId);
  if (targetUrl) {
    await localView.webContents.loadURL(targetUrl);
  }
}

async function handleDeepLinkUrl(rawUrl: string): Promise<void> {
  const parsed = parseDeepLink(rawUrl);
  if (!parsed) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingDeepLinkUrl = rawUrl;
    return;
  }
  showMainWindow();
  if (parsed.workspace === "local") {
    if (!settings.showLocalWorkspace) {
      await switchWorkspace("cloud");
      await openDesktopSettingsWindow();
      return;
    }
    await openLocalChannel(parsed.channelId);
    return;
  }
  await switchWorkspace("cloud");
  if (parsed.path && cloudView && !cloudView.webContents.isDestroyed()) {
    const targetUrl = new URL(parsed.path, settings.remoteServerUrl).toString();
    await cloudView.webContents.loadURL(targetUrl);
  }
}

let checkingForUpdates = false;

async function showDesktopMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return dialog.showMessageBox(mainWindow, options);
  }
  return dialog.showMessageBox(options);
}

function copyDesktopDiagnostics(): string {
  const st = settings.showLocalWorkspace ? localServer?.getStatus() : null;
  const text = formatDesktopDiagnostics({
    appVersion: app.getVersion() || "0.1.0",
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    activeWorkspace: settings.activeWorkspace,
    showLocalWorkspace: settings.showLocalWorkspace,
    theme: settings.theme === "dark" ? "dark" : "light",
    zoomFactor: settings.zoomFactor ?? 1,
    localRunning: Boolean(st?.running),
    localPort: st?.port ?? settings.localServerPort,
    allowLan: settings.allowLan === true,
    localOnlineCount: st?.connectedAgents?.length || 0,
    notificationsMuted: settings.notificationsMuted === true,
    audioMuted: settings.audioMuted === true,
  });
  clipboard.writeText(text);
  if (!isSmokeTest && Notification.isSupported()) {
    new Notification({
      title: "已复制桌面端诊断信息",
      body: `v${app.getVersion() || "0.1.0"} · Electron ${process.versions.electron || ""}`,
      silent: true,
    }).show();
  }
  return text;
}

async function promptCheckForUpdates(): Promise<void> {
  if (checkingForUpdates) return;
  checkingForUpdates = true;
  try {
    const currentVersion = app.getVersion() || "0.1.0";
    const result = await checkLatestDesktopRelease(currentVersion);
    if (!result.checked) {
      const { response } = await showDesktopMessageBox({
        type: "info",
        title: "Check for Updates",
        message: `Current version: v${currentVersion}`,
        detail: result.error
          ? `Could not reach GitHub Releases (${result.error}).`
          : "Unable to check for updates right now.",
        buttons: ["Open Releases Page", "Close"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response === 0) void shell.openExternal(result.releaseUrl);
      return;
    }
    if (result.hasUpdate && result.latestVersion) {
      const { response } = await showDesktopMessageBox({
        type: "info",
        title: "AgentsChat Desktop Update Available",
        message: `AgentsChat Desktop v${result.latestVersion} is available!`,
        detail: `You are currently running v${currentVersion}. Download the latest macOS / Windows installer from GitHub Releases.`,
        buttons: ["Download Update", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        void shell.openExternal(result.releaseUrl);
      }
      return;
    }
    await showDesktopMessageBox({
      type: "info",
      title: "Up to Date",
      message: `AgentsChat Desktop v${currentVersion} is up to date.`,
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    });
  } finally {
    checkingForUpdates = false;
  }
}

function applyLaunchAtLoginSetting(): void {
  if (isSmokeTest) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin === true,
      openAsHidden: true,
      args: ["--hidden"],
    });
  } catch {}
}

function applyAlwaysOnTop(enabled: boolean): boolean {
  const next = Boolean(enabled);
  settings = settingsStore.save({ alwaysOnTop: next });
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (next) mainWindow.setAlwaysOnTop(true, "floating");
      else mainWindow.setAlwaysOnTop(false);
    } catch {}
  }
  setupApplicationMenu();
  broadcastState();
  return next;
}

function applyNotificationsMuted(muted: boolean): boolean {
  const next = Boolean(muted);
  settings = settingsStore.save({ notificationsMuted: next });
  setupApplicationMenu();
  syncUnreadBadge();
  broadcastState();
  return next;
}

function applyAudioMutedToViews(muted: boolean): void {
  for (const view of [cloudView, localView]) {
    if (view && !view.webContents.isDestroyed()) {
      try {
        view.webContents.setAudioMuted(muted);
      } catch {}
    }
  }
}

function applyAudioMuted(muted: boolean): boolean {
  const next = Boolean(muted);
  settings = settingsStore.save({ audioMuted: next });
  applyAudioMutedToViews(next);
  setupApplicationMenu();
  syncUnreadBadge();
  broadcastState();
  return next;
}

function resetWindowSizeAndCenter(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    const applyCenteredBounds = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      if (mainWindow.isMinimized()) mainWindow.restore();
      const curBounds = mainWindow.getBounds();
      const disp = screen.getDisplayMatching(curBounds);
      const nextBounds = computeCenteredWindowBounds(disp.workArea, 1320, 860, 880, 560);
      mainWindow.setBounds(nextBounds, true);
      mainWindow.show();
      mainWindow.focus();
      layoutViews();
      settings = settingsStore.save({ windowBounds: nextBounds });
    };
    if (mainWindow.isFullScreen()) {
      mainWindow.once("leave-full-screen", applyCenteredBounds);
      mainWindow.setFullScreen(false);
    } else {
      applyCenteredBounds();
    }
    return true;
  } catch {
    return false;
  }
}

async function openDesktopSettingsWindow(): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const isMac = process.platform === "darwin";
  const prefWidth = 480;
  const prefHeight = 640;
  let pos: { x?: number; y?: number } = {};
  try {
    const refBounds =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : screen.getPrimaryDisplay().workArea;
    const disp = screen.getDisplayMatching(refBounds) || screen.getPrimaryDisplay();
    const centered = computeCenteredWindowBounds(disp.workArea, prefWidth, prefHeight, prefWidth, prefHeight);
    pos = { x: centered.x, y: centered.y };
  } catch {}

  settingsWindow = new BrowserWindow({
    width: prefWidth,
    height: prefHeight,
    ...pos,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: !isSmokeTest,
    title: "桌面端配置",
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    backgroundColor: settings.theme === "dark" ? "#1c1c1e" : "#f3f4f6",
    ...(isMac ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 } } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: join(UI_DIR, "settings-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWindow.webContents.on("will-navigate", (ev) => {
    ev.preventDefault();
  });
  if (isSmokeTest) {
    settingsWindow.webContents.on("console-message", (_ev, level, message) => {
      if (level >= 3) smokeRendererErrors.push(`[settings] ${message}`);
    });
  }
  settingsWindow.on("closed", () => {
    settingsWindow = null;
    broadcastState();
  });

  await settingsWindow.loadFile(join(UI_DIR, "settings.html"));
  broadcastState();
  if (!isSmokeTest && settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
  }
}

function setupApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const showLocal = settings.showLocalWorkspace === true;
  const toggleActiveDevTools = () => {
    const target = settings.activeWorkspace === "local" && showLocal ? localView : cloudView;
    if (target && !target.webContents.isDestroyed()) {
      if (target.webContents.isDevToolsOpened()) target.webContents.closeDevTools();
      else target.webContents.openDevTools({ mode: "detach" });
    }
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              {
                label: "Check for Updates…",
                click: () => void promptCheckForUpdates(),
              },
              { type: "separator" as const },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => {
                  showMainWindow();
                  void openDesktopSettingsWindow();
                },
              },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              {
                label: "Quit AgentsChat",
                accelerator: "Cmd+Q",
                click: () => {
                  isQuitting = true;
                  app.quit();
                },
              },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { type: "separator" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Find in Page…",
          accelerator: "CmdOrCtrl+F",
          click: () => { openFindBar(); },
        },
        {
          label: "Find Next",
          accelerator: "CmdOrCtrl+G",
          click: () => { stepFindInPage(true); },
        },
        {
          label: "Find Previous",
          accelerator: "CmdOrCtrl+Shift+G",
          click: () => { stepFindInPage(false); },
        },
        {
          label: "Use Selection for Find",
          accelerator: "CmdOrCtrl+E",
          click: () => { void useSelectionForFind(); },
        },
      ],
    },
    {
      label: "Workspace",
      submenu: [
        {
          label: "AgentsChat Cloud (Lobby)",
          accelerator: "CmdOrCtrl+1",
          click: () => void navigateCloudQuickRoute("lobby"),
        },
        ...(showLocal
          ? [
              {
                label: "Local Mini-Server",
                accelerator: "CmdOrCtrl+2",
                click: () => void switchWorkspace("local"),
              },
            ]
          : []),
        { type: "separator" },
        {
          label: "Cloud Studio (算力工坊)",
          accelerator: "CmdOrCtrl+3",
          click: () => void navigateCloudQuickRoute("cloud-agents"),
        },
        {
          label: "OKR Board",
          accelerator: "CmdOrCtrl+4",
          click: () => void navigateCloudQuickRoute("okr-board"),
        },
        {
          label: "Bot Market",
          accelerator: "CmdOrCtrl+5",
          click: () => void navigateCloudQuickRoute("marketplace"),
        },
        {
          label: "Dashboard",
          accelerator: "CmdOrCtrl+6",
          click: () => void navigateCloudQuickRoute("dashboard"),
        },
        { type: "separator" },
        {
          label: "Back",
          accelerator: "CmdOrCtrl+[",
          click: () => void navigateCloudHistory("back"),
        },
        {
          label: "Forward",
          accelerator: "CmdOrCtrl+]",
          click: () => void navigateCloudHistory("forward"),
        },
        {
          label: showLocal ? "Copy Current Link / Local MCP Command" : "Copy Current Page Link",
          accelerator: "CmdOrCtrl+Shift+C",
          click: () => { copyActiveWorkspaceLinkOrCommand(true); },
        },
        {
          label: "Open Current Page in Browser",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => { openCurrentCloudUrlInBrowser(); },
        },
        ...(showLocal
          ? [
              { type: "separator" as const },
              {
                label: "Local Mini-Server Running",
                type: "checkbox" as const,
                checked: settings.localServerEnabled === true,
                accelerator: "CmdOrCtrl+Shift+L",
                click: () => {
                  void setLocalServerEnabled(!(settings.localServerEnabled === true));
                },
              },
              {
                label: "Allow LAN Access (0.0.0.0)",
                type: "checkbox" as const,
                checked: settings.allowLan === true,
                click: () => {
                  void setAllowLan(!settings.allowLan);
                },
              },
            ]
          : []),
        { type: "separator" },
        ...(!isMac
          ? [
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => {
                  showMainWindow();
                  void openDesktopSettingsWindow();
                },
              },
              { type: "separator" as const },
            ]
          : []),
        {
          label: "Toggle Light / Dark Appearance",
          accelerator: "CmdOrCtrl+Shift+D",
          click: () => applyDesktopTheme(settings.theme === "dark" ? "light" : "dark"),
        },
        {
          label: "Mute Local Notifications",
          type: "checkbox",
          checked: settings.notificationsMuted === true,
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => applyNotificationsMuted(!(settings.notificationsMuted === true)),
        },
        {
          label: "Mute Workspace Audio",
          type: "checkbox",
          checked: settings.audioMuted === true,
          accelerator: "CmdOrCtrl+Shift+U",
          click: () => applyAudioMuted(!(settings.audioMuted === true)),
        },
        ...(isMac
          ? [
              {
                label: "Capture Screenshot to Chat",
                accelerator: "CmdOrCtrl+Shift+X",
                click: () => void captureScreenshotToChat(),
              },
            ]
          : []),
        { type: "separator" },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          click: () => applyDesktopZoom((settings.zoomFactor ?? 1) + 0.1),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: () => applyDesktopZoom((settings.zoomFactor ?? 1) - 0.1),
        },
        {
          label: "Actual Size (100%)",
          accelerator: "CmdOrCtrl+0",
          click: () => applyDesktopZoom(1),
        },
        { type: "separator" },
        {
          label: "Reload Active View",
          accelerator: "CmdOrCtrl+R",
          click: () => { reloadActiveView(); },
        },
        {
          label: "Force Reload (Ignore Cache)",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => { forceReloadActiveView(); },
        },
        {
          label: "Toggle Developer Tools",
          accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: toggleActiveDevTools,
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Keep Window on Top",
          type: "checkbox",
          checked: settings.alwaysOnTop === true,
          accelerator: "CmdOrCtrl+Shift+T",
          click: () => applyAlwaysOnTop(!(settings.alwaysOnTop === true)),
        },
        {
          label: "Reset Window Size & Center",
          accelerator: "CmdOrCtrl+Shift+0",
          click: () => { resetWindowSizeAndCenter(); },
        },
        ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : []),
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Check for Updates…",
          click: () => void promptCheckForUpdates(),
        },
        {
          label: "Copy Diagnostics Info",
          click: () => { copyDesktopDiagnostics(); },
        },
        {
          label: "Open Local Data Folder",
          click: () => void shell.openPath(desktopDataDir),
        },
        { type: "separator" },
        {
          label: "Bot Market (Rent / Monetize Bots)",
          click: () => {
            showMainWindow();
            void navigateCloudQuickRoute("marketplace");
          },
        },
        {
          label: "AgentsChat Documentation",
          click: () => void shell.openExternal("https://agents-chat.com/join"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const isMac = process.platform === "darwin";
  const showLocal = settings.showLocalWorkspace === true;
  const st = showLocal ? localServer?.getStatus() : null;
  const effectiveLocalUnread = showLocal ? localUnreadCount : 0;
  const totalUnread = cloudUnreadCount + effectiveLocalUnread;
  tray.setToolTip(
    formatTrayTooltip({
      cloudUnread: cloudUnreadCount,
      localUnread: effectiveLocalUnread,
      showLocalWorkspace: showLocal,
      localRunning: Boolean(st?.running),
      localPort: st?.port,
      localOnlineCount: st?.connectedAgents?.length || 0,
      notificationsMuted: settings.notificationsMuted === true,
      audioMuted: settings.audioMuted === true,
    }),
  );
  const menu = Menu.buildFromTemplate([
    {
      label: totalUnread > 0 ? `Open AgentsChat (${totalUnread} unread)` : "Open AgentsChat",
      click: () => showMainWindow(),
    },
    ...(isMac
      ? [
          {
            label: "Capture Screenshot to Chat (⌘⇧X)",
            click: () => void captureScreenshotToChat(),
          },
        ]
      : []),
    {
      label: "Keep Window on Top",
      type: "checkbox",
      checked: settings.alwaysOnTop === true,
      click: () => {
        showMainWindow();
        applyAlwaysOnTop(!(settings.alwaysOnTop === true));
      },
    },
    {
      label: "Mute Local Notifications",
      type: "checkbox",
      checked: settings.notificationsMuted === true,
      click: () => {
        applyNotificationsMuted(!(settings.notificationsMuted === true));
      },
    },
    {
      label: "Mute Workspace Audio",
      type: "checkbox",
      checked: settings.audioMuted === true,
      click: () => {
        applyAudioMuted(!(settings.audioMuted === true));
      },
    },
    { type: "separator" },
    {
      label: cloudUnreadCount > 0
        ? `Cloud Workspace (${cloudUnreadCount} unread)`
        : "Cloud Workspace (agents-chat.com)",
      type: "radio",
      checked: !showLocal || settings.activeWorkspace === "cloud",
      click: () => {
        showMainWindow();
        void switchWorkspace("cloud");
      },
    },
    {
      label: isMac ? "  Cloud Studio (⌘3)" : "  Cloud Studio (Ctrl+3)",
      click: () => {
        showMainWindow();
        void navigateCloudQuickRoute("cloud-agents");
      },
    },
    {
      label: isMac ? "  OKR Board (⌘4)" : "  OKR Board (Ctrl+4)",
      click: () => {
        showMainWindow();
        void navigateCloudQuickRoute("okr-board");
      },
    },
    {
      label: isMac ? "  Bot Market (⌘5)" : "  Bot Market (Ctrl+5)",
      click: () => {
        showMainWindow();
        void navigateCloudQuickRoute("marketplace");
      },
    },
    {
      label: isMac ? "  Dashboard (⌘6)" : "  Dashboard (Ctrl+6)",
      click: () => {
        showMainWindow();
        void navigateCloudQuickRoute("dashboard");
      },
    },
    ...(showLocal
      ? [
          {
            label: st
              ? `Local Server (${st.httpUrl} · ${st.connectedAgents.length} online${localUnreadCount > 0 ? ` · ${localUnreadCount} unread` : ""})`
              : "Local Server (Stopped)",
            type: "radio" as const,
            checked: settings.activeWorkspace === "local",
            click: () => {
              showMainWindow();
              void switchWorkspace("local");
            },
          },
          { type: "separator" as const },
          {
            label: "Copy Local MCP Command",
            enabled: Boolean(st?.running),
            click: () => {
              clipboard.writeText(formatLocalMcpCommand(st?.httpUrl || `http://127.0.0.1:${settings.localServerPort}`));
            },
          },
          {
            label: settings.localServerEnabled ? "Stop Local Server" : "Start Local Server",
            click: () => {
              void setLocalServerEnabled(!settings.localServerEnabled);
            },
          },
          {
            label: "Allow LAN Access (0.0.0.0)",
            type: "checkbox" as const,
            checked: settings.allowLan,
            click: () => {
              void setAllowLan(!settings.allowLan);
            },
          },
        ]
      : []),
    { type: "separator" },
    {
      label: isMac ? "Settings… (⌘,)" : "Settings… (Ctrl+,)",
      click: () => {
        showMainWindow();
        void openDesktopSettingsWindow();
      },
    },
    {
      label: "Check for Updates…",
      click: () => void promptCheckForUpdates(),
    },
    { type: "separator" },
    {
      label: "Quit AgentsChat",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function rebuildDockMenu(): void {
  if (process.platform !== "darwin" || !app.dock || isSmokeTest) return;
  const showLocal = settings.showLocalWorkspace === true;
  const st = showLocal ? localServer?.getStatus() : null;
  const dockMenu = Menu.buildFromTemplate([
    {
      label: "AgentsChat Cloud (Lobby)",
      click: () => {
        showMainWindow();
        void navigateCloudQuickRoute("lobby");
      },
    },
    {
      label: "Cloud Studio (算力工坊)",
      click: () => {
        showMainWindow();
        void navigateCloudQuickRoute("cloud-agents");
      },
    },
    {
      label: "OKR Board",
      click: () => {
        showMainWindow();
        void navigateCloudQuickRoute("okr-board");
      },
    },
    {
      label: "Bot Market",
      click: () => {
        showMainWindow();
        void navigateCloudQuickRoute("marketplace");
      },
    },
    {
      label: "Dashboard",
      click: () => {
        showMainWindow();
        void navigateCloudQuickRoute("dashboard");
      },
    },
    ...(showLocal
      ? [
          { type: "separator" as const },
          {
            label: st?.running ? `Local Server (:${st.port})` : "Local Server (Stopped)",
            click: () => {
              showMainWindow();
              void switchWorkspace("local");
            },
          },
        ]
      : []),
    { type: "separator" },
    {
      label: "Capture Screenshot to Chat (⌘⇧X)",
      click: () => void captureScreenshotToChat(),
    },
    {
      label: "Keep Window on Top",
      type: "checkbox",
      checked: settings.alwaysOnTop === true,
      click: () => {
        showMainWindow();
        applyAlwaysOnTop(!(settings.alwaysOnTop === true));
      },
    },
    {
      label: "Mute Notifications",
      type: "checkbox",
      checked: settings.notificationsMuted === true,
      click: () => applyNotificationsMuted(!(settings.notificationsMuted === true)),
    },
    {
      label: "Mute Workspace Audio",
      type: "checkbox",
      checked: settings.audioMuted === true,
      click: () => applyAudioMuted(!(settings.audioMuted === true)),
    },
    { type: "separator" },
    {
      label: "Settings… (⌘,)",
      click: () => {
        showMainWindow();
        void openDesktopSettingsWindow();
      },
    },
  ]);
  try {
    app.dock.setMenu(dockMenu);
  } catch {}
}

async function setShowLocalWorkspace(enabled: boolean): Promise<LocalServerStatus | null> {
  return runLocalServerOp(async () => {
    const nextEnabled = Boolean(enabled);
    if (nextEnabled) {
      settings = settingsStore.save({
        showLocalWorkspace: true,
        localServerEnabled: true,
      });
      const st = await ensureLocalServerStarted();
      if (st && localView && !localView.webContents.isDestroyed()) {
        await localView.webContents.loadURL(st.httpUrl);
      } else if (!st) {
        await loadLocalStoppedPage();
      }
      setupApplicationMenu();
      syncUnreadBadge();
      broadcastState();
      return st;
    }
    localUnreadCount = 0;
    settings = settingsStore.save({
      showLocalWorkspace: false,
      localServerEnabled: false,
      activeWorkspace: "cloud",
    });
    await ensureLocalServerStarted();
    layoutViews();
    setupApplicationMenu();
    syncUnreadBadge();
    broadcastState();
    return null;
  });
}

async function setLocalServerEnabled(enabled: boolean): Promise<LocalServerStatus | null> {
  return runLocalServerOp(async () => {
    const nextEnabled = settings.showLocalWorkspace && Boolean(enabled);
    settings = settingsStore.save({ localServerEnabled: nextEnabled });
    const nextStatus = await ensureLocalServerStarted();
    if (nextStatus && localView && !localView.webContents.isDestroyed()) {
      await localView.webContents.loadURL(nextStatus.httpUrl);
    } else if (!nextStatus && settings.showLocalWorkspace) {
      await loadLocalStoppedPage();
    }
    setupApplicationMenu();
    broadcastState();
    return nextStatus;
  });
}

async function setAllowLan(allowLan: boolean): Promise<LocalServerStatus | null> {
  return runLocalServerOp(async () => {
    const changed = Boolean(allowLan) !== settings.allowLan;
    settings = settingsStore.save({ allowLan: Boolean(allowLan) });
    if (changed && localServer) {
      await localServer.closeAll();
      localServer = null;
    }
    const st = await ensureLocalServerStarted();
    if (st && localView && !localView.webContents.isDestroyed()) {
      const cur = localView.webContents.getURL();
      if (!cur.startsWith(st.httpUrl)) {
        await localView.webContents.loadURL(st.httpUrl);
      }
    }
    setupApplicationMenu();
    broadcastState();
    return st;
  });
}

async function createDesktopWindow(): Promise<void> {
  const isMac = process.platform === "darwin";
  const windowIconPath = join(ASSETS_DIR, "icon.png");

  // Restore saved bounds safely, clamping into the connected display's workArea
  let restoredBounds: { width: number; height: number; x?: number; y?: number } = {
    width: settings.windowBounds?.width || 1320,
    height: settings.windowBounds?.height || 860,
  };
  try {
    const saved = settings.windowBounds;
    const probeRect = {
      x: saved?.x ?? 0,
      y: saved?.y ?? 0,
      width: saved?.width || 1320,
      height: saved?.height || 860,
    };
    const disp =
      saved?.x !== undefined && saved?.y !== undefined
        ? screen.getDisplayMatching(probeRect)
        : screen.getPrimaryDisplay();
    restoredBounds = resolveRestoredWindowBounds(saved, disp?.workArea, 1320, 860, 880, 560);
  } catch {
    restoredBounds = resolveRestoredWindowBounds(settings.windowBounds, null, 1320, 860, 880, 560);
  }
  const initialWidth = restoredBounds.width;
  const initialHeight = restoredBounds.height;
  const initialPos: { x?: number; y?: number } =
    restoredBounds.x !== undefined && restoredBounds.y !== undefined
      ? { x: restoredBounds.x, y: restoredBounds.y }
      : {};

  try {
    nativeTheme.themeSource = settings.theme === "dark" ? "dark" : "light";
  } catch {}

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    ...initialPos,
    minWidth: 880,
    minHeight: 560,
    show: !isSmokeTest && !startHidden,
    title: "AgentsChat",
    ...(existsSync(windowIconPath) ? { icon: windowIconPath } : {}),
    backgroundColor: settings.theme === "dark" ? "#232323" : "#e9eaec",
    ...(isMac ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 10, y: 15 } } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: join(UI_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (settings.alwaysOnTop === true) {
    try {
      mainWindow.setAlwaysOnTop(true, "floating");
    } catch {}
  }

  await mainWindow.loadFile(join(UI_DIR, "shell.html"));
  mainWindow.webContents.on("will-navigate", (ev) => {
    ev.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  cloudView = new WebContentsView({
    webPreferences: {
      partition: "persist:agentschat-cloud",
      preload: join(UI_DIR, "cloud-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  localView = new WebContentsView({
    webPreferences: {
      partition: "persist:agentschat-local",
      preload: join(UI_DIR, "local-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  findView = new WebContentsView({
    webPreferences: {
      preload: join(UI_DIR, "find-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    findView.setBackgroundColor(settings.theme === "dark" ? "#262629" : "#ffffff");
  } catch {}
  findView.setVisible(false);

  mainWindow.contentView.addChildView(cloudView);
  mainWindow.contentView.addChildView(localView);
  mainWindow.contentView.addChildView(findView);
  findView.webContents.on("will-navigate", (ev) => ev.preventDefault());
  findView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await findView.webContents.loadFile(join(UI_DIR, "find.html"));
  syncFindBarState();

  if (isSmokeTest) {
    const captureErrors = (label: string, wc: Electron.WebContents) => {
      wc.on("console-message", (_ev, level, message) => {
        // level 3 = error (includes uncaught JS exceptions & CSP violations)
        if (level >= 3) smokeRendererErrors.push(`[${label}] ${message}`);
      });
    };
    captureErrors("shell", mainWindow.webContents);
    captureErrors("local", localView.webContents);
    captureErrors("find", findView.webContents);
  }

  const remoteOrigin = new URL(settings.remoteServerUrl).origin;
  cloudView.webContents.setWindowOpenHandler(({ url }) => {
    if (isOAuthPopupUrl(url, remoteOrigin)) {
      let popupPos: { x?: number; y?: number } = {};
      try {
        const refBounds =
          mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : screen.getPrimaryDisplay().workArea;
        const disp = screen.getDisplayMatching(refBounds) || screen.getPrimaryDisplay();
        const centered = computeCenteredWindowBounds(disp.workArea, 540, 700, 540, 700);
        popupPos = { x: centered.x, y: centered.y };
      } catch {}
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 540,
          height: 700,
          ...popupPos,
          autoHideMenuBar: true,
          backgroundColor: settings.theme === "dark" ? "#191919" : "#ffffff",
          webPreferences: {
            partition: "persist:agentschat-cloud",
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  cloudView.webContents.on("did-create-window", (childWin) => {
    try {
      attachNativeContextMenu(childWin.webContents);
      childWin.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedExternalUrl(url)) {
          void shell.openExternal(url);
        }
        return { action: "deny" };
      });
    } catch {}
  });

  localView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const attachBeforeInputShortcuts = (wc: Electron.WebContents, workspace: "cloud" | "local") => {
    wc.on("before-input-event", (ev, input) => {
      const cmd = findBarOpen
        ? resolveBeforeInputShortcut(input, { findBarOpen: true })
        : resolveBeforeInputShortcut(input);
      if (!cmd) return;
      if (cmd === "close-find") {
        ev.preventDefault();
        closeFindBar({ restoreFocus: true });
      } else if (cmd === "reload" || cmd === "force-reload") {
        ev.preventDefault();
        reloadWebContentsSmart(wc, workspace, cmd === "force-reload");
      } else if (workspace === "cloud") {
        ev.preventDefault();
        navigateCloudHistory(cmd);
      }
    });
  };
  attachBeforeInputShortcuts(cloudView.webContents, "cloud");
  attachBeforeInputShortcuts(localView.webContents, "local");

  const initialZoom = clampDesktopZoomFactor(settings.zoomFactor ?? 1);
  attachSessionPermissionGuards(cloudView.webContents, "cloud");
  attachSessionPermissionGuards(localView.webContents, "local");
  attachNativeContextMenu(cloudView.webContents);
  attachNativeContextMenu(localView.webContents);
  attachDownloadFeedback(cloudView.webContents);
  attachDownloadFeedback(localView.webContents);
  attachFindInPageResults(cloudView.webContents, "cloud");
  attachFindInPageResults(localView.webContents, "local");

  cloudView.webContents.on("did-start-loading", () => {
    cloudLoading = true;
    broadcastState();
  });
  cloudView.webContents.on("did-stop-loading", () => {
    cloudLoading = false;
    broadcastState();
  });
  cloudView.webContents.on("dom-ready", () => {
    syncThemeToCloudView(settings.theme || "light");
    try { cloudView?.webContents.setZoomFactor(clampDesktopZoomFactor(settings.zoomFactor ?? 1)); } catch {}
    broadcastState();
  });
  cloudView.webContents.on("did-navigate", () => {
    if (findBarOpen) closeFindBar({ restoreFocus: false });
    broadcastState();
  });
  cloudView.webContents.on("did-navigate-in-page", () => broadcastState());
  localView.webContents.on("dom-ready", () => {
    try { localView?.webContents.setZoomFactor(clampDesktopZoomFactor(settings.zoomFactor ?? 1)); } catch {}
    syncThemeToLocalView(settings.theme || "light");
  });
  localView.webContents.on("did-navigate", () => {
    if (findBarOpen) closeFindBar({ restoreFocus: false });
  });
  localView.webContents.on("will-navigate", (ev, navUrl) => {
    const currentUrl = localView?.webContents.getURL() || "";
    if (isLocalStoppedPageUrl(currentUrl)) {
      if (navUrl === "agentschat-action://start-local") {
        ev.preventDefault();
        void setLocalServerEnabled(true);
        return;
      }
      if (navUrl === "agentschat-action://switch-cloud") {
        ev.preventDefault();
        void switchWorkspace("cloud");
        return;
      }
    }
    const localHttpUrl = localServer?.getStatus()?.httpUrl;
    if (!isAllowedLocalViewNavigation(navUrl, localHttpUrl)) {
      ev.preventDefault();
      if (isAllowedExternalUrl(navUrl)) {
        void shell.openExternal(navUrl);
      }
    }
  });
  cloudView.webContents.on("render-process-gone", (_ev, details) => {
    if (isSmokeTest || details.reason === "clean-exit") return;
    cloudLoading = false;
    const retryUrl = resolveOfflineRetryUrl(cloudView?.webContents.getURL() || lastCloudFailedUrl, settings.remoteServerUrl);
    lastCloudFailedUrl = retryUrl;
    void cloudView?.webContents.loadFile(join(UI_DIR, "cloud-offline.html"), {
      query: {
        remote: retryUrl,
        reason: `RENDERER_${String(details.reason || "GONE").toUpperCase()}`,
        theme: settings.theme || "light",
        local: settings.showLocalWorkspace ? "1" : "0",
      },
    });
    broadcastState();
  });
  localView.webContents.on("render-process-gone", (_ev, details) => {
    if (isSmokeTest || details.reason === "clean-exit" || !settings.showLocalWorkspace) return;
    const runningStatus = localServer?.getStatus();
    if (runningStatus?.running) {
      void localView?.webContents.loadURL(runningStatus.httpUrl);
    } else {
      void loadLocalStoppedPage();
    }
  });
  localView.webContents.on("did-fail-load", (_ev, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || isSmokeTest || !settings.showLocalWorkspace) return;
    if (validatedURL && isLocalStoppedPageUrl(validatedURL)) return;
    void loadLocalStoppedPage();
  });
  cloudView.webContents.on("page-title-updated", (_ev, title) => {
    const nextCloudUnread = parseUnreadCountFromTitle(title);
    if (nextCloudUnread !== cloudUnreadCount) {
      cloudUnreadCount = nextCloudUnread;
      syncUnreadBadge();
      broadcastState();
    }
  });
  try {
    cloudView.webContents.setZoomFactor(initialZoom);
    localView.webContents.setZoomFactor(initialZoom);
  } catch {}
  applyAudioMutedToViews(settings.audioMuted === true);

  cloudView.webContents.on("did-fail-load", (_ev, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      cloudLoading = false;
      broadcastState();
    }
    if (!isMainFrame || errorCode === -3 || isSmokeTest) return;
    if (validatedURL && validatedURL.includes("cloud-offline.html")) return;
    const retryUrl = resolveOfflineRetryUrl(validatedURL, settings.remoteServerUrl);
    lastCloudFailedUrl = retryUrl;
    void cloudView?.webContents.loadFile(join(UI_DIR, "cloud-offline.html"), {
      query: {
        remote: retryUrl,
        reason: errorDescription || `ERR_${errorCode}`,
        theme: settings.theme || "light",
        local: settings.showLocalWorkspace ? "1" : "0",
      },
    });
  });

  cloudView.webContents.on("did-finish-load", () => {
    const cur = cloudView?.webContents.getURL() || "";
    if (!isCloudOfflinePageUrl(cur)) {
      lastCloudFailedUrl = null;
    }
  });

  cloudView.webContents.on("will-navigate", (ev, navUrl) => {
    const currentUrl = cloudView?.webContents.getURL() || "";
    if (!currentUrl.startsWith("file://") || !currentUrl.includes("cloud-offline.html")) return;
    if (navUrl === "agentschat-action://retry-cloud") {
      ev.preventDefault();
      const targetUrl = resolveOfflineRetryUrl(lastCloudFailedUrl, settings.remoteServerUrl);
      void cloudView?.webContents.loadURL(targetUrl);
    } else if (navUrl === "agentschat-action://switch-local") {
      ev.preventDefault();
      if (settings.showLocalWorkspace) {
        void switchWorkspace("local");
      }
    }
  });

  if (!isSmokeTest) {
    void cloudView.webContents.loadURL(settings.remoteServerUrl);
  }
  if (settings.showLocalWorkspace) {
    const st = await ensureLocalServerStarted();
    if (st) {
      await localView.webContents.loadURL(st.httpUrl);
    } else {
      await loadLocalStoppedPage();
    }
  }

  const scheduleBoundsSave = () => {
    if (
      isSmokeTest ||
      !mainWindow ||
      mainWindow.isDestroyed() ||
      mainWindow.isMinimized() ||
      mainWindow.isFullScreen() ||
      mainWindow.isMaximized()
    ) {
      return;
    }
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        mainWindow.isMinimized() ||
        mainWindow.isFullScreen() ||
        mainWindow.isMaximized()
      ) {
        return;
      }
      const b = mainWindow.getBounds();
      settings = settingsStore.save({ windowBounds: { width: b.width, height: b.height, x: b.x, y: b.y } });
    }, 400);
    boundsSaveTimer.unref?.();
  };

  layoutViews();
  mainWindow.on("resize", () => {
    layoutViews();
    scheduleBoundsSave();
  });
  mainWindow.on("move", () => scheduleBoundsSave());
  mainWindow.on("focus", () => {
    if (settings.activeWorkspace === "local") {
      clearLocalUnread();
    }
  });
  mainWindow.on("enter-full-screen", () => {
    layoutViews();
    broadcastState();
  });
  mainWindow.on("leave-full-screen", () => {
    layoutViews();
    broadcastState();
  });
  mainWindow.on("swipe", (_ev, direction) => {
    const dir = resolveCloudHistoryCommand(direction);
    if (dir) navigateCloudHistory(dir);
  });
  mainWindow.on("app-command", (_ev, cmd) => {
    const dir = resolveCloudHistoryCommand(cmd);
    if (dir) navigateCloudHistory(dir);
  });

  mainWindow.on("close", (ev) => {
    if (!isQuitting && settings.minimizeToTray) {
      ev.preventDefault();
      mainWindow?.hide();
    }
  });

  broadcastState();
}

// ── IPC Handlers ──────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:get-state", () => getCombinedState());

  ipcMain.handle("desktop:switch-workspace", async (_ev, ws: unknown) => {
    await switchWorkspace(ws === "local" ? "local" : "cloud");
    return getCombinedState();
  });

  ipcMain.handle("desktop:set-theme", (ev, theme: unknown) => {
    const nextTheme = theme === "dark" ? "dark" : "light";
    // Allow shell window or local mini-server view only
    const senderUrl = ev.sender.getURL() || "";
    const st = localServer?.getStatus();
    const isShell = Boolean(mainWindow && !mainWindow.isDestroyed() && ev.sender === mainWindow.webContents);
    const isLocal = Boolean(st && senderUrl.startsWith(st.httpUrl));
    if (!isShell && !isLocal) return { ok: false };
    applyDesktopTheme(nextTheme);
    return { ok: true, theme: nextTheme };
  });

  ipcMain.handle("desktop:set-always-on-top", (ev, enabled: unknown) => {
    const isShell = Boolean(mainWindow && !mainWindow.isDestroyed() && ev.sender === mainWindow.webContents);
    if (!isShell) return { ok: false };
    const pinned = applyAlwaysOnTop(Boolean(enabled));
    return { ok: true, alwaysOnTop: pinned };
  });

  ipcMain.handle("desktop:set-notifications-muted", (ev, muted: unknown) => {
    const isShell = Boolean(mainWindow && !mainWindow.isDestroyed() && ev.sender === mainWindow.webContents);
    if (!isShell) return { ok: false };
    const nextMuted = applyNotificationsMuted(Boolean(muted));
    return { ok: true, notificationsMuted: nextMuted };
  });

  ipcMain.on("desktop:cloud-theme-observed", (ev, rawTheme: unknown) => {
    if (rawTheme !== "light" && rawTheme !== "dark") return;
    if (!cloudView || cloudView.webContents.isDestroyed() || ev.sender !== cloudView.webContents) return;
    if (!isTrustedCloudThemeOrigin(ev.sender.getURL(), settings.remoteServerUrl)) return;
    if (rawTheme === settings.theme) return;
    applyDesktopTheme(rawTheme, { skipCloudSync: true });
  });

  ipcMain.handle("desktop:open-settings-window", async (ev) => {
    const isShell = Boolean(mainWindow && !mainWindow.isDestroyed() && ev.sender === mainWindow.webContents);
    if (!isShell) return false;
    await openDesktopSettingsWindow();
    return true;
  });

  ipcMain.handle("desktop:get-settings-state", (ev) => {
    const isSettingsWin = Boolean(settingsWindow && !settingsWindow.isDestroyed() && ev.sender === settingsWindow.webContents);
    if (!isSettingsWin) return null;
    return getSettingsWindowState();
  });

  ipcMain.handle("desktop:save-desktop-settings", async (ev, patch: any) => {
    const isSettingsWin = Boolean(settingsWindow && !settingsWindow.isDestroyed() && ev.sender === settingsWindow.webContents);
    if (!isSettingsWin) return { ok: false, error: "Forbidden" };

    const safePatch: Partial<DesktopSettings> = {};
    if (patch?.showLocalWorkspace !== undefined) {
      safePatch.showLocalWorkspace = Boolean(patch.showLocalWorkspace);
      if (!safePatch.showLocalWorkspace) {
        safePatch.localServerEnabled = false;
        safePatch.activeWorkspace = "cloud";
      } else if (patch?.localServerEnabled === undefined) {
        safePatch.localServerEnabled = true;
      }
    }
    if (patch?.localServerEnabled !== undefined) {
      const targetShow = safePatch.showLocalWorkspace ?? settings.showLocalWorkspace;
      safePatch.localServerEnabled = targetShow && Boolean(patch.localServerEnabled);
    }
    if (patch?.localServerPort !== undefined) {
      const port = Number(patch.localServerPort);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return { ok: false, error: "端口范围须为 1024 - 65535" };
      }
      safePatch.localServerPort = port;
    }
    if (patch?.allowLan !== undefined) safePatch.allowLan = Boolean(patch.allowLan);
    if (patch?.minimizeToTray !== undefined) safePatch.minimizeToTray = Boolean(patch.minimizeToTray);
    if (patch?.launchAtLogin !== undefined) safePatch.launchAtLogin = Boolean(patch.launchAtLogin);
    if (patch?.alwaysOnTop !== undefined) safePatch.alwaysOnTop = Boolean(patch.alwaysOnTop);
    if (patch?.notificationsMuted !== undefined) safePatch.notificationsMuted = Boolean(patch.notificationsMuted);
    if (patch?.audioMuted !== undefined) safePatch.audioMuted = Boolean(patch.audioMuted);
    if (patch?.theme === "light" || patch?.theme === "dark") safePatch.theme = patch.theme;
    if (patch?.zoomFactor !== undefined) safePatch.zoomFactor = clampDesktopZoomFactor(patch.zoomFactor);

    await runLocalServerOp(async () => {
      const prevShowLocal = settings.showLocalWorkspace;
      const portOrHostChanged =
        (safePatch.localServerPort !== undefined && safePatch.localServerPort !== settings.localServerPort) ||
        (safePatch.allowLan !== undefined && safePatch.allowLan !== settings.allowLan);
      settings = settingsStore.save(safePatch);

      if (safePatch.theme !== undefined) {
        applyDesktopTheme(safePatch.theme);
      }
      if (safePatch.zoomFactor !== undefined) {
        applyDesktopZoom(safePatch.zoomFactor);
      }
      if (safePatch.launchAtLogin !== undefined) {
        applyLaunchAtLoginSetting();
      }
      if (safePatch.audioMuted !== undefined) {
        applyAudioMutedToViews(settings.audioMuted === true);
      }
      if (safePatch.alwaysOnTop !== undefined && mainWindow && !mainWindow.isDestroyed()) {
        try {
          if (settings.alwaysOnTop) mainWindow.setAlwaysOnTop(true, "floating");
          else mainWindow.setAlwaysOnTop(false);
        } catch {}
      }
      if (!settings.showLocalWorkspace) {
        localUnreadCount = 0;
      }
      if (portOrHostChanged && localServer) {
        await localServer.closeAll();
        localServer = null;
      }
      const st = await ensureLocalServerStarted();
      if (settings.showLocalWorkspace) {
        if (st && localView && !localView.webContents.isDestroyed()) {
          const cur = localView.webContents.getURL();
          if (!cur.startsWith(st.httpUrl)) {
            await localView.webContents.loadURL(st.httpUrl);
          }
        } else if (!st && localView && !localView.webContents.isDestroyed()) {
          await loadLocalStoppedPage();
        }
      } else if (prevShowLocal) {
        layoutViews();
      }
      setupApplicationMenu();
      syncUnreadBadge();
      broadcastState();
    });
    return { ok: true, state: getSettingsWindowState() };
  });

  ipcMain.handle("desktop:copy-diagnostics", (ev) => {
    const isSettingsWin = Boolean(settingsWindow && !settingsWindow.isDestroyed() && ev.sender === settingsWindow.webContents);
    if (!isSettingsWin) return false;
    copyDesktopDiagnostics();
    return true;
  });

  ipcMain.handle("desktop:open-data-folder", async (ev) => {
    const isSettingsWin = Boolean(settingsWindow && !settingsWindow.isDestroyed() && ev.sender === settingsWindow.webContents);
    if (!isSettingsWin) return false;
    await shell.openPath(desktopDataDir);
    return true;
  });

  ipcMain.handle("desktop:close-settings-window", (ev) => {
    const isSettingsWin = Boolean(settingsWindow && !settingsWindow.isDestroyed() && ev.sender === settingsWindow.webContents);
    if (!isSettingsWin) return false;
    settingsWindow?.close();
    return true;
  });

  ipcMain.handle("desktop:clear-cloud-cache", async (ev) => {
    const isSettingsWin = Boolean(settingsWindow && !settingsWindow.isDestroyed() && ev.sender === settingsWindow.webContents);
    if (!isSettingsWin) return false;
    return await clearCloudWebCache();
  });

  ipcMain.handle("desktop:check-updates", async (ev) => {
    const isSettingsWin = Boolean(settingsWindow && !settingsWindow.isDestroyed() && ev.sender === settingsWindow.webContents);
    if (!isSettingsWin) return false;
    void promptCheckForUpdates();
    return true;
  });

  ipcMain.handle("desktop:reset-window-layout", (ev) => {
    const isSettingsWin = Boolean(settingsWindow && !settingsWindow.isDestroyed() && ev.sender === settingsWindow.webContents);
    if (!isSettingsWin) return false;
    return resetWindowSizeAndCenter();
  });

  ipcMain.handle("desktop:find-query", (ev, query: unknown, opts: any) => {
    const isFindBar = Boolean(findView && !findView.webContents.isDestroyed() && ev.sender === findView.webContents);
    if (!isFindBar) return false;
    return runFindInPage(query, Boolean(opts?.matchCase));
  });

  ipcMain.handle("desktop:find-step", (ev, forward: unknown) => {
    const isFindBar = Boolean(findView && !findView.webContents.isDestroyed() && ev.sender === findView.webContents);
    if (!isFindBar) return false;
    return stepFindInPage(Boolean(forward));
  });

  ipcMain.handle("desktop:find-close", (ev) => {
    const isFindBar = Boolean(findView && !findView.webContents.isDestroyed() && ev.sender === findView.webContents);
    if (!isFindBar) return false;
    return closeFindBar({ restoreFocus: true });
  });

  ipcMain.handle("desktop:toggle-local-server", async (_ev, enabled: unknown) => {
    await setLocalServerEnabled(Boolean(enabled));
    return getCombinedState();
  });

  ipcMain.handle("desktop:update-settings", async (ev, patch: any) => {
    const isShell = Boolean(mainWindow && !mainWindow.isDestroyed() && ev.sender === mainWindow.webContents);
    if (!isShell) return getCombinedState();
    await runLocalServerOp(async () => {
      const portOrHostChanged =
        (patch?.localServerPort !== undefined && Number(patch.localServerPort) !== settings.localServerPort) ||
        (patch?.allowLan !== undefined && Boolean(patch.allowLan) !== settings.allowLan);
      settings = settingsStore.save(patch || {});
      if (portOrHostChanged && localServer) {
        await localServer.closeAll();
        localServer = null;
      }
      const st = await ensureLocalServerStarted();
      if (settings.showLocalWorkspace && st && localView && !localView.webContents.isDestroyed()) {
        await localView.webContents.loadURL(st.httpUrl);
      } else if (!settings.showLocalWorkspace) {
        localUnreadCount = 0;
        layoutViews();
      }
      setupApplicationMenu();
      syncUnreadBadge();
      broadcastState();
    });
    return getCombinedState();
  });

  ipcMain.handle("desktop:copy-text", (_ev, text: unknown) => {
    if (typeof text === "string" && text.length <= 16_000) {
      clipboard.writeText(text);
      return true;
    }
    return false;
  });

  ipcMain.handle("desktop:capture-screenshot", async () => {
    return captureScreenshotToChat();
  });

  ipcMain.handle("desktop:navigate-cloud-route", async (_ev, route: unknown) => {
    return navigateCloudQuickRoute(route);
  });

  ipcMain.handle("desktop:cloud-history", (_ev, direction: unknown) => {
    if (direction === "back" || direction === "forward") {
      return navigateCloudHistory(direction);
    }
    return false;
  });

  ipcMain.handle("desktop:reload-active", (ev) => {
    const isShell = Boolean(mainWindow && !mainWindow.isDestroyed() && ev.sender === mainWindow.webContents);
    if (!isShell) return false;
    return reloadActiveView();
  });

  ipcMain.handle("desktop:reset-zoom", (ev) => {
    const isShell = Boolean(mainWindow && !mainWindow.isDestroyed() && ev.sender === mainWindow.webContents);
    if (!isShell) return false;
    applyDesktopZoom(1);
    return true;
  });

  ipcMain.handle("desktop:copy-cloud-url", (ev) => {
    const isShell = Boolean(mainWindow && !mainWindow.isDestroyed() && ev.sender === mainWindow.webContents);
    if (!isShell) return null;
    return copyCurrentCloudUrl(false);
  });

  ipcMain.handle("desktop:open-cloud-browser", (ev) => {
    const isShell = Boolean(mainWindow && !mainWindow.isDestroyed() && ev.sender === mainWindow.webContents);
    if (!isShell) return false;
    return openCurrentCloudUrlInBrowser();
  });

  ipcMain.handle("desktop:open-cloud-path", async (_ev, targetPath: unknown) => {
    const safePath = typeof targetPath === "string" && targetPath.startsWith("/") ? targetPath : "/";
    await switchWorkspace("cloud");
    if (cloudView && !cloudView.webContents.isDestroyed()) {
      const targetUrl = new URL(safePath, settings.remoteServerUrl).toString();
      await cloudView.webContents.loadURL(targetUrl);
    }
    return true;
  });

  ipcMain.handle("desktop:get-local-server-status", (ev) => {
    const st = localServer?.getStatus();
    if (!st || !ev.sender.getURL().startsWith(st.httpUrl)) {
      return { ok: false };
    }
    return { ok: true, allowLan: settings.allowLan, settings, status: st };
  });

  ipcMain.handle("desktop:toggle-allow-lan", async (ev, allowLan: unknown) => {
    const cur = localServer?.getStatus();
    if (!cur || !ev.sender.getURL().startsWith(cur.httpUrl)) {
      return { ok: false };
    }
    const nextStatus = await setAllowLan(Boolean(allowLan));
    return { ok: true, allowLan: settings.allowLan, settings, status: nextStatus };
  });

  ipcMain.handle("desktop:update-local-settings", async (ev, patch: any) => {
    const cur = localServer?.getStatus();
    if (!cur || !ev.sender.getURL().startsWith(cur.httpUrl)) {
      return { ok: false };
    }
    const safePatch: Partial<DesktopSettings> = {};
    if (patch?.localServerPort !== undefined) safePatch.localServerPort = Number(patch.localServerPort);
    if (patch?.allowLan !== undefined) safePatch.allowLan = Boolean(patch.allowLan);
    if (patch?.minimizeToTray !== undefined) safePatch.minimizeToTray = Boolean(patch.minimizeToTray);
    if (patch?.launchAtLogin !== undefined) safePatch.launchAtLogin = Boolean(patch.launchAtLogin);

    const nextStatus = await runLocalServerOp(async () => {
      const restartNeeded =
        (safePatch.localServerPort !== undefined && safePatch.localServerPort !== settings.localServerPort) ||
        (safePatch.allowLan !== undefined && safePatch.allowLan !== settings.allowLan);
      settings = settingsStore.save(safePatch);
      if (safePatch.launchAtLogin !== undefined) {
        applyLaunchAtLoginSetting();
      }
      if (restartNeeded && localServer) {
        await localServer.closeAll();
        localServer = null;
      }
      const st = await ensureLocalServerStarted();
      if (st && localView && !localView.webContents.isDestroyed()) {
        const currentUrl = localView.webContents.getURL();
        if (!currentUrl.startsWith(st.httpUrl)) {
          await localView.webContents.loadURL(st.httpUrl);
        }
      }
      setupApplicationMenu();
      broadcastState();
      return st;
    });
    return { ok: true, settings, status: nextStatus };
  });

  // Hand off verified Cloud identity (`ac_token` from agents-chat.com) to the Local Chat view
  // so Cloud <-> Local switching uses the exact same global human account without re-login!
  ipcMain.handle("desktop:get-local-bootstrap", async (ev) => {
    const st = localServer?.getStatus();
    if (!st || !ev.sender.getURL().startsWith(st.httpUrl)) {
      return { ok: false };
    }
    const cloudToken = await readCloudTokenIfSameOrigin();
    if (cloudToken && localServer) {
      const verified = await localServer.authority.verifyToken(cloudToken);
      if (verified) {
        return {
          ok: true,
          token: cloudToken,
          principal: verified,
          httpUrl: st.httpUrl,
          wsUrl: st.wsUrl,
          upstreamUrl: st.upstreamUrl,
        };
      }
    }
    return {
      ok: true,
      token: null,
      principal: null,
      httpUrl: st.httpUrl,
      wsUrl: st.wsUrl,
      upstreamUrl: st.upstreamUrl,
    };
  });

  // Safely verify & register a local `~/.agentschat/<name>.json` profile into the Local Server SQLite cache
  // from the Main Process (never exposing other files or symlinks to renderer JS).
  ipcMain.handle("desktop:activate-local-profile", async (ev, profileName: unknown) => {
    const st = localServer?.getStatus();
    if (!st || !localServer || !ev.sender.getURL().startsWith(st.httpUrl)) {
      return { ok: false, error: "Forbidden" };
    }
    if (typeof profileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,48}$/.test(profileName) || profileName.includes("..")) {
      return { ok: false, error: "Invalid profile name" };
    }
    const candidates = GlobalIdentityAuthority.discoverLocalAgentProfiles();
    const matched = candidates.find((p) => p.profile_name === profileName);
    if (!matched || !existsSync(matched.file_path)) {
      return { ok: false, error: "Profile not found" };
    }
    try {
      const lst = lstatSync(matched.file_path);
      if (lst.isSymbolicLink() || !lst.isFile()) {
        return { ok: false, error: "Refusing symlinked profile" };
      }
      const raw = JSON.parse(readFileSync(matched.file_path, "utf8"));
      const verified = await localServer.authority.verifyToken(raw.token, raw.agent_id, raw.capabilities);
      if (!verified) {
        return {
          ok: false,
          error: `Profile '${profileName}' could not be verified against ${st.upstreamUrl}`,
        };
      }
      localServer.store.addMember("welcome", verified.id, "member");
      return {
        ok: true,
        principal: verified,
        mcp_command: `npx -y agentschat-mcp@latest --profile ${matched.profile_name} --url ${st.httpUrl}`,
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || "Failed to activate profile") };
    }
  });

  // One-click global agent registration: allocates globally unique agent_id + ac_ token via
  // `https://agents-chat.com/api/account/register`, saves to `~/.agentschat/profiles/<name>.json`
  // with 0o600 permissions, and joins `#welcome` on the local server.
  ipcMain.handle("desktop:register-local-agent", async (ev, req: any) => {
    const st = localServer?.getStatus();
    if (!st || !localServer || !ev.sender.getURL().startsWith(st.httpUrl)) {
      return { ok: false, error: "Forbidden" };
    }
    const displayName = String(req?.displayName || "").trim();
    const rawProfileName = String(req?.profileName || "").trim();
    const safeProfileName = sanitizeLocalProfileName(rawProfileName, displayName, Date.now().toString(36));
    if (!displayName || displayName.length > 64) {
      return { ok: false, error: "Display name (1-64 chars) is required" };
    }
    try {
      const upstream = await localServer.authority.registerAgentViaUpstream({
        name: displayName,
        capabilities: ["chat", "code"],
      });
      if (upstream.status < 200 || upstream.status >= 300 || !upstream.data?.id || !upstream.data?.key) {
        return {
          ok: false,
          error: String(upstream.data?.error || `Upstream registration failed (${upstream.status})`),
        };
      }
      const saved = GlobalIdentityAuthority.saveLocalAgentProfile({
        profileName: safeProfileName,
        agentId: String(upstream.data.id),
        displayName: String(upstream.data.name || displayName),
        token: String(upstream.data.key),
        serverUrl: st.upstreamUrl,
      });
      localServer.store.addMember("welcome", String(upstream.data.id), "member");
      broadcastState();
      return {
        ok: true,
        profile_name: saved.profileName,
        agent_id: String(upstream.data.id),
        display_name: String(upstream.data.name || displayName),
        claim_url: typeof upstream.data.claim_url === "string" ? upstream.data.claim_url : null,
        mcp_command: `npx -y agentschat-mcp@latest --profile ${saved.profileName} --url ${st.httpUrl}`,
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || "Failed to register local agent") };
    }
  });
}

// ── App Lifecycle (Single-Instance on macOS & Windows) ────────────────────

const gotSingleInstanceLock = isSmokeTest ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const argvDeepLink = process.argv.find((a) => typeof a === "string" && a.startsWith("agentschat://"));
  if (argvDeepLink) pendingDeepLinkUrl = argvDeepLink;

  app.on("open-url", (ev, url) => {
    ev.preventDefault();
    void handleDeepLinkUrl(url);
  });

  app.on("second-instance", (_ev, commandLine) => {
    showMainWindow();
    const deep = commandLine.find((a) => typeof a === "string" && a.startsWith("agentschat://"));
    if (deep) void handleDeepLinkUrl(deep);
  });

  app.whenReady().then(async () => {
    try {
      app.setName("AgentsChat");
    } catch {}
    if (process.platform === "darwin" && app.dock) {
      try {
        const dockIconPath = join(ASSETS_DIR, "icon.png");
        if (existsSync(dockIconPath)) {
          const dockImg = nativeImage.createFromPath(dockIconPath);
          if (!dockImg.isEmpty()) app.dock.setIcon(dockImg);
        }
      } catch {}
    }
    registerIpcHandlers();
    if (!isSmokeTest) {
      try {
        app.setAsDefaultProtocolClient("agentschat");
      } catch {}
      applyLaunchAtLoginSetting();
      setupApplicationMenu();
      if (process.platform === "darwin") {
        try {
          globalShortcut.register("CmdOrCtrl+Shift+X", () => {
            void captureScreenshotToChat();
          });
        } catch {}
      }
      try {
        const trayIconPath = join(UI_DIR, "tray-icon.png");
        const trayImg = existsSync(trayIconPath)
          ? nativeImage.createFromPath(trayIconPath)
          : nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
        if (process.platform === "darwin") {
          trayImg.setTemplateImage(true);
        }
        tray = new Tray(trayImg);
        tray.setToolTip("AgentsChat Desktop");
        tray.on("click", () => showMainWindow());
      } catch {}
    }
    await createDesktopWindow();
    if (!isSmokeTest && pendingDeepLinkUrl) {
      const toOpen = pendingDeepLinkUrl;
      pendingDeepLinkUrl = null;
      void handleDeepLinkUrl(toOpen);
    }

    if (isSmokeTest) {
      try {
        // 1. Verify Cloud-only default on fresh startup (Local UI hidden & LocalMiniServer stopped)
        const startedLocalByDefault = Boolean(localServer);
        const defaultShellProbe = await mainWindow?.webContents.executeJavaScript(
          `(async () => {
            const st = await window.agentschatShell?.getState?.();
            return {
              hasShellBridge: Boolean(window.agentschatShell),
              showLocalWorkspace: Boolean(st?.settings?.showLocalWorkspace),
              running: Boolean(st?.localServer?.running),
              localBtnHidden: Boolean(document.getElementById("btn-local")?.hidden),
              portBadgeHidden: Boolean(document.getElementById("local-port-badge")?.hidden),
              powerBtnHidden: Boolean(document.getElementById("btn-power")?.hidden),
              hasSettingsBtn: Boolean(document.getElementById("btn-shell-settings")),
              hasUnreadBadge: Boolean(document.getElementById("local-unread-badge")),
              hasCloudUnreadBadge: Boolean(document.getElementById("cloud-unread-badge")),
            };
          })()`,
          true,
        );
        if (
          startedLocalByDefault ||
          !defaultShellProbe?.hasShellBridge ||
          defaultShellProbe?.showLocalWorkspace ||
          defaultShellProbe?.running ||
          !defaultShellProbe?.localBtnHidden ||
          !defaultShellProbe?.portBadgeHidden ||
          !defaultShellProbe?.powerBtnHidden ||
          !defaultShellProbe?.hasSettingsBtn ||
          !defaultShellProbe?.hasUnreadBadge ||
          !defaultShellProbe?.hasCloudUnreadBadge
        ) {
          throw new Error(`Cloud-only default smoke check failed: ${JSON.stringify(defaultShellProbe)}`);
        }

        // 2. Open Preferences window and verify default state
        await openDesktopSettingsWindow();
        const settingsProbe = await settingsWindow?.webContents.executeJavaScript(
          `(async () => {
            const st = await window.agentschatSettings?.getState?.();
            return {
              hasSettingsBridge: Boolean(window.agentschatSettings),
              showLocalChecked: Boolean(document.getElementById("pref-show-local")?.checked),
              advancedHidden: Boolean(document.getElementById("local-advanced-panel")?.hidden),
              hasZoomControl: Boolean(document.getElementById("btn-zoom-value")),
              hasMuteAudioToggle: Boolean(document.getElementById("pref-mute-audio")),
              hasCopyDiagBtn: Boolean(document.getElementById("btn-copy-diag")),
              hasSettingsPath: Boolean(st?.settingsFilePath),
            };
          })()`,
          true,
        );
        if (
          !settingsProbe?.hasSettingsBridge ||
          settingsProbe?.showLocalChecked ||
          !settingsProbe?.advancedHidden ||
          !settingsProbe?.hasZoomControl ||
          !settingsProbe?.hasMuteAudioToggle ||
          !settingsProbe?.hasCopyDiagBtn ||
          !settingsProbe?.hasSettingsPath
        ) {
          throw new Error(`Settings window smoke check failed: ${JSON.stringify(settingsProbe)}`);
        }

        // 2b. Verify floating Find-in-Page WebContentsView opens, exposes scoped bridge, and closes cleanly
        const openedFind = openFindBar();
        const findProbe = await findView?.webContents.executeJavaScript(
          `({
            hasFindBridge: Boolean(window.agentschatFind),
            hasInput: Boolean(document.getElementById("find-input")),
            hasClear: Boolean(document.getElementById("btn-clear")),
            hasCaseToggle: Boolean(document.getElementById("btn-case")),
            hasPrevNext: Boolean(document.getElementById("btn-prev") && document.getElementById("btn-next")),
            hasClose: Boolean(document.getElementById("btn-close")),
          })`,
          true,
        );
        const closedFind = closeFindBar({ restoreFocus: false });
        if (
          !openedFind ||
          !closedFind ||
          !findProbe?.hasFindBridge ||
          !findProbe?.hasInput ||
          !findProbe?.hasClear ||
          !findProbe?.hasCaseToggle ||
          !findProbe?.hasPrevNext ||
          !findProbe?.hasClose
        ) {
          throw new Error(`Find bar smoke check failed: ${JSON.stringify(findProbe)}`);
        }

        // 3. Opt-in to Local Workspace and verify LocalMiniServer + Rail reveal + Local Chat DOM/modal
        const st = await setShowLocalWorkspace(true);
        if (!st || !st.running) {
          throw new Error("LocalMiniServer failed to start after enabling showLocalWorkspace");
        }
        const healthRes = await fetch(`${st.httpUrl}/health`);
        const health = (await healthRes.json()) as any;
        const enabledShellProbe = await mainWindow?.webContents.executeJavaScript(
          `(async () => {
            await new Promise((r) => setTimeout(r, 80));
            const st = await window.agentschatShell?.getState?.();
            return {
              showLocalWorkspace: Boolean(st?.settings?.showLocalWorkspace),
              running: Boolean(st?.localServer?.running),
              localBtnVisible: !document.getElementById("btn-local")?.hidden,
              portBadgeVisible: !document.getElementById("local-port-badge")?.hidden,
              powerBtnVisible: !document.getElementById("btn-power")?.hidden,
            };
          })()`,
          true,
        );
        const localProbe = await localView?.webContents.executeJavaScript(
          `(async () => {
            const st = await window.agentschatLocalBridge?.getServerStatus?.();
            const requiredIds = [
              "btn-copy-mcp", "btn-local-settings", "btn-register-agent",
              "search-input", "btn-export-md", "msg-input",
              "connect-dialog", "settings-dialog", "registered-dialog"
            ];
            const missingIds = requiredIds.filter((id) => !document.getElementById(id));
            document.getElementById("btn-copy-mcp")?.click();
            await new Promise((r) => setTimeout(r, 80));
            const connectOpen = Boolean(document.getElementById("connect-dialog")?.open);
            const snippetText = document.getElementById("mcp-snippet-box")?.textContent || "";
            document.getElementById("btn-close-connect")?.click();
            return {
              title: document.title,
              hasLocalBridge: Boolean(window.agentschatLocalBridge),
              ipcOk: Boolean(st?.ok && st?.status?.running),
              missingIds,
              connectOpen,
              hasClaudeSnippet: snippetText.includes("claude mcp add agentschat-local"),
            };
          })()`,
          true,
        );
        if (
          healthRes.status !== 200 ||
          health?.mode !== "desktop_local_minimal" ||
          !enabledShellProbe?.showLocalWorkspace ||
          !enabledShellProbe?.running ||
          !enabledShellProbe?.localBtnVisible ||
          !enabledShellProbe?.portBadgeVisible ||
          !enabledShellProbe?.powerBtnVisible ||
          localProbe?.title !== "AgentsChat Local Server" ||
          !localProbe?.hasLocalBridge ||
          !localProbe?.ipcOk ||
          (localProbe?.missingIds?.length ?? 1) > 0 ||
          !localProbe?.connectOpen ||
          !localProbe?.hasClaudeSnippet ||
          smokeRendererErrors.length > 0
        ) {
          throw new Error(
            `Smoke audit failed: shell=${JSON.stringify(enabledShellProbe)} local=${JSON.stringify(localProbe)} errors=${JSON.stringify(smokeRendererErrors)}`,
          );
        }
        console.log(
          `[desktop-smoke] OK: Electron ${process.versions.electron}, Cloud-only default + Preferences window + LocalMiniServer=${st.httpUrl} verified (0 console/CSP errors)`,
        );
        isQuitting = true;
        if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
        await localServer?.closeAll();
        localServer = null;
        app.exit(0);
      } catch (err: any) {
        console.error("[desktop-smoke] FAILED:", err?.message || err);
        isQuitting = true;
        if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
        await localServer?.closeAll();
        localServer = null;
        app.exit(1);
      }
      return;
    }

    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        void createDesktopWindow();
      } else {
        showMainWindow();
      }
    });

    if (!isSmokeTest) {
      const clampMainWindowToVisibleDisplay = () => {
        if (
          !mainWindow ||
          mainWindow.isDestroyed() ||
          mainWindow.isMinimized() ||
          mainWindow.isFullScreen() ||
          mainWindow.isMaximized()
        ) {
          return;
        }
        try {
          const curBounds = mainWindow.getBounds();
          const disp = screen.getDisplayMatching(curBounds) || screen.getPrimaryDisplay();
          const reclamped = computeDisplayReclampedBounds(curBounds, disp.workArea, 880, 560);
          if (reclamped) {
            mainWindow.setBounds(reclamped, true);
            layoutViews();
            settings = settingsStore.save({ windowBounds: reclamped });
          }
        } catch {}
      };
      screen.on("display-removed", clampMainWindowToVisibleDisplay);
      screen.on("display-metrics-changed", clampMainWindowToVisibleDisplay);

      let resumeTimer: ReturnType<typeof setTimeout> | null = null;
      powerMonitor.on("resume", () => {
        if (resumeTimer) clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          if (cloudView && !cloudView.webContents.isDestroyed() && isCloudOfflinePageUrl(cloudView.webContents.getURL())) {
            const targetUrl = resolveOfflineRetryUrl(lastCloudFailedUrl, settings.remoteServerUrl);
            void cloudView.webContents.loadURL(targetUrl).catch(() => {});
          }
          const st = localServer?.getStatus();
          if (st?.running && localView && !localView.webContents.isDestroyed()) {
            const cur = localView.webContents.getURL();
            if (cur.startsWith(st.httpUrl)) {
              void localView.webContents
                .executeJavaScript("window.dispatchEvent(new Event('online'))", true)
                .catch(() => {});
            }
          }
        }, 1200);
        resumeTimer.unref?.();
      });
    }
  });

  app.on("will-quit", () => {
    try {
      globalShortcut.unregisterAll();
    } catch {}
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
      settingsWindow = null;
    }
    if (localServer) {
      void localServer.closeAll();
      localServer = null;
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !settings.minimizeToTray) {
      app.quit();
    }
  });
}
