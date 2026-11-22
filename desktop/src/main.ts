import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
  WebContentsView,
} from "electron";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLatestDesktopRelease, parseDeepLink } from "./desktop-helpers.js";
import { GlobalIdentityAuthority, resolveHomeDir } from "./identity-authority.js";
import { LocalMiniServer } from "./local-server.js";
import { DesktopSettingsStore } from "./settings-store.js";
import type { DesktopSettings, LocalServerStatus } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui");
const ASSETS_DIR = join(__dirname, "..", "assets");
const RAIL_WIDTH = 68;

// Fallback 16x16 PNG data URL if tray-icon.png is unavailable
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVQ4T2NkoBAwUqifYdQABgZGBv8MDAz/yWLD////GXG5DF0DsiF4XYYugM9l2AxgxOcybAbgcxk2Awi5DFcAIZfhCiDkMlwBhFyGK2B0GDAyMDAwAABnTRkR6z51AAAAAElFTkSuQmCC";

let mainWindow: BrowserWindow | null = null;
let cloudView: WebContentsView | null = null;
let localView: WebContentsView | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let localUnreadCount = 0;
let pendingDeepLinkUrl: string | null = null;
let boundsSaveTimer: NodeJS.Timeout | null = null;
const smokeRendererErrors: string[] = [];

const isSmokeTest = process.env.AGENTSCHAT_DESKTOP_SMOKE_TEST === "1";
const startHidden = !isSmokeTest && process.argv.includes("--hidden");
const desktopDataDir =
  process.env.AGENTSCHAT_DESKTOP_DATA_DIR?.trim() ||
  join(resolveHomeDir(), ".agentschat", "desktop");
const settingsStore = new DesktopSettingsStore(join(desktopDataDir, "settings.json"));
let settings: DesktopSettings = settingsStore.load();
let localServer: LocalMiniServer | null = null;

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isOAuthPopupUrl(rawUrl: string, remoteOrigin: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.origin === remoteOrigin) return true;
    const h = parsed.hostname.toLowerCase();
    return (
      h === "accounts.google.com" ||
      h.endsWith(".google.com") ||
      h === "appleid.apple.com" ||
      h === "github.com"
    );
  } catch {
    return false;
  }
}

function syncUnreadBadge(): void {
  try {
    if (typeof app.setBadgeCount === "function") {
      app.setBadgeCount(localUnreadCount);
    }
  } catch {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(localUnreadCount > 0 ? `(${localUnreadCount}) AgentsChat` : "AgentsChat");
  }
}

function clearLocalUnread(): void {
  if (localUnreadCount !== 0) {
    localUnreadCount = 0;
    syncUnreadBadge();
    broadcastState();
  }
}

async function ensureLocalServerStarted(): Promise<LocalServerStatus | null> {
  if (!settings.localServerEnabled) {
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
          if (Notification.isSupported()) {
            const notif = new Notification({
              title: `${msg.sender_name || msg.sender_id} · #${channelName} (Local)`,
              body: msg.content.slice(0, 140),
            });
            notif.on("click", () => {
              showMainWindow();
              void switchWorkspace("local");
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

function getCombinedState() {
  return {
    platform: process.platform,
    settings,
    localServer: localServer ? localServer.getStatus() : null,
    localUnreadCount,
    discoveredProfiles: GlobalIdentityAuthority.discoverLocalAgentProfiles(),
  };
}

function broadcastState(): void {
  const snapshot = getCombinedState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:state-changed", snapshot);
  }
  rebuildTrayMenu();
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
  settings = settingsStore.save({ activeWorkspace: target });
  if (target === "local") {
    localUnreadCount = 0;
    syncUnreadBadge();
    const st = await ensureLocalServerStarted();
    if (st && localView && !localView.webContents.isDestroyed()) {
      const currentUrl = localView.webContents.getURL();
      if (!currentUrl.startsWith(st.httpUrl)) {
        await localView.webContents.loadURL(st.httpUrl);
      } else {
        localView.webContents.send("desktop:workspace-activated");
      }
    }
  }
  layoutViews();
  broadcastState();
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
    await switchWorkspace("local");
    const st = localServer?.getStatus();
    if (st && parsed.channelId && localView && !localView.webContents.isDestroyed()) {
      await localView.webContents.loadURL(`${st.httpUrl}/#channel=${encodeURIComponent(parsed.channelId)}`);
    }
    return;
  }
  await switchWorkspace("cloud");
  if (parsed.path && cloudView && !cloudView.webContents.isDestroyed()) {
    const targetUrl = new URL(parsed.path, settings.remoteServerUrl).toString();
    await cloudView.webContents.loadURL(targetUrl);
  }
}

async function promptCheckForUpdates(): Promise<void> {
  const currentVersion = app.getVersion() || "0.1.0";
  const result = await checkLatestDesktopRelease(currentVersion);
  if (!result.checked) {
    await dialog.showMessageBox({
      type: "info",
      title: "Check for Updates",
      message: `Current version: v${currentVersion}`,
      detail: result.error
        ? `Could not reach GitHub Releases (${result.error}).`
        : "Unable to check for updates right now.",
      buttons: ["Open Releases Page", "Close"],
      defaultId: 1,
    }).then(({ response }) => {
      if (response === 0) void shell.openExternal(result.releaseUrl);
    });
    return;
  }
  if (result.hasUpdate && result.latestVersion) {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "AgentsChat Desktop Update Available",
      message: `AgentsChat Desktop v${result.latestVersion} is available!`,
      detail: `You are currently running v${currentVersion}. Download the latest macOS / Windows installer from GitHub Releases.`,
      buttons: ["Download Update", "Later"],
      defaultId: 0,
    });
    if (response === 0) {
      void shell.openExternal(result.releaseUrl);
    }
    return;
  }
  await dialog.showMessageBox({
    type: "info",
    title: "Up to Date",
    message: `AgentsChat Desktop v${currentVersion} is up to date.`,
    buttons: ["OK"],
  });
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

function setupApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const reloadActiveView = () => {
    const target = settings.activeWorkspace === "local" ? localView : cloudView;
    if (target && !target.webContents.isDestroyed()) {
      target.webContents.reload();
    }
  };
  const toggleActiveDevTools = () => {
    const target = settings.activeWorkspace === "local" ? localView : cloudView;
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
        { role: "selectAll" },
      ],
    },
    {
      label: "Workspace",
      submenu: [
        {
          label: "☁️ AgentsChat Cloud",
          accelerator: "CmdOrCtrl+1",
          click: () => void switchWorkspace("cloud"),
        },
        {
          label: "🏠 Local Mini-Server",
          accelerator: "CmdOrCtrl+2",
          click: () => void switchWorkspace("local"),
        },
        { type: "separator" },
        {
          label: "Reload Active View",
          accelerator: "CmdOrCtrl+R",
          click: reloadActiveView,
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
          label: "Open Local Data Folder",
          click: () => void shell.openPath(desktopDataDir),
        },
        { type: "separator" },
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
  const st = localServer?.getStatus();
  const menu = Menu.buildFromTemplate([
    {
      label: "Open AgentsChat",
      click: () => showMainWindow(),
    },
    { type: "separator" },
    {
      label: "☁️ Cloud Workspace (agents-chat.com)",
      type: "radio",
      checked: settings.activeWorkspace === "cloud",
      click: () => {
        showMainWindow();
        void switchWorkspace("cloud");
      },
    },
    {
      label: st
        ? `🏠 Local Server (${st.httpUrl} · ${st.connectedAgents.length} online)`
        : "🏠 Local Server (Stopped)",
      type: "radio",
      checked: settings.activeWorkspace === "local",
      click: () => {
        showMainWindow();
        void switchWorkspace("local");
      },
    },
    { type: "separator" },
    {
      label: settings.localServerEnabled ? "Stop Local Server" : "Start Local Server",
      click: () => {
        void (async () => {
          settings = settingsStore.save({ localServerEnabled: !settings.localServerEnabled });
          await ensureLocalServerStarted();
          broadcastState();
        })();
      },
    },
    {
      label: "🌐 Allow LAN Access (0.0.0.0)",
      type: "checkbox",
      checked: settings.allowLan,
      click: () => {
        void setAllowLan(!settings.allowLan);
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

async function setAllowLan(allowLan: boolean): Promise<LocalServerStatus | null> {
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
  broadcastState();
  return st;
}

async function createDesktopWindow(): Promise<void> {
  const isMac = process.platform === "darwin";
  const windowIconPath = join(ASSETS_DIR, "icon.png");

  // Restore saved bounds only if the saved position is still visible on a connected display
  let initialWidth = settings.windowBounds?.width || 1320;
  let initialHeight = settings.windowBounds?.height || 860;
  let initialPos: { x?: number; y?: number } = {};
  if (settings.windowBounds?.x !== undefined && settings.windowBounds?.y !== undefined) {
    try {
      const targetRect = {
        x: settings.windowBounds.x,
        y: settings.windowBounds.y,
        width: initialWidth,
        height: initialHeight,
      };
      const disp = screen.getDisplayMatching(targetRect);
      const wa = disp.workArea;
      const intersects =
        targetRect.x < wa.x + wa.width - 80 &&
        targetRect.x + targetRect.width > wa.x + 80 &&
        targetRect.y < wa.y + wa.height - 60 &&
        targetRect.y + targetRect.height > wa.y + 40;
      if (intersects) {
        initialPos = { x: targetRect.x, y: targetRect.y };
      }
    } catch {}
  }

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    ...initialPos,
    minWidth: 880,
    minHeight: 560,
    show: !isSmokeTest && !startHidden,
    title: "AgentsChat",
    ...(existsSync(windowIconPath) ? { icon: windowIconPath } : {}),
    backgroundColor: "#0b0f19",
    ...(isMac ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 } } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: join(UI_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await mainWindow.loadFile(join(UI_DIR, "shell.html"));

  cloudView = new WebContentsView({
    webPreferences: {
      partition: "persist:agentschat-cloud",
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

  mainWindow.contentView.addChildView(cloudView);
  mainWindow.contentView.addChildView(localView);

  if (isSmokeTest) {
    const captureErrors = (label: string, wc: Electron.WebContents) => {
      wc.on("console-message", (_ev, level, message) => {
        // level 3 = error (includes uncaught JS exceptions & CSP violations)
        if (level >= 3) smokeRendererErrors.push(`[${label}] ${message}`);
      });
    };
    captureErrors("shell", mainWindow.webContents);
    captureErrors("local", localView.webContents);
  }

  const remoteOrigin = new URL(settings.remoteServerUrl).origin;
  cloudView.webContents.setWindowOpenHandler(({ url }) => {
    if (isOAuthPopupUrl(url, remoteOrigin)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 540,
          height: 700,
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

  localView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  cloudView.webContents.on("did-fail-load", (_ev, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || isSmokeTest) return;
    if (validatedURL && validatedURL.includes("cloud-offline.html")) return;
    void cloudView?.webContents.loadFile(join(UI_DIR, "cloud-offline.html"), {
      query: {
        remote: settings.remoteServerUrl,
        reason: errorDescription || `ERR_${errorCode}`,
      },
    });
  });

  cloudView.webContents.on("will-navigate", (ev, navUrl) => {
    const currentUrl = cloudView?.webContents.getURL() || "";
    if (!currentUrl.startsWith("file://") || !currentUrl.includes("cloud-offline.html")) return;
    if (navUrl === "agentschat-action://retry-cloud") {
      ev.preventDefault();
      void cloudView?.webContents.loadURL(settings.remoteServerUrl);
    } else if (navUrl === "agentschat-action://switch-local") {
      ev.preventDefault();
      void switchWorkspace("local");
    }
  });

  if (!isSmokeTest) {
    void cloudView.webContents.loadURL(settings.remoteServerUrl);
  }
  const st = await ensureLocalServerStarted();
  if (st) {
    await localView.webContents.loadURL(st.httpUrl);
  }

  const scheduleBoundsSave = () => {
    if (isSmokeTest || !mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
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

  mainWindow.on("close", (ev) => {
    if (!isQuitting && settings.minimizeToTray && settings.localServerEnabled) {
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

  ipcMain.handle("desktop:toggle-local-server", async (_ev, enabled: unknown) => {
    settings = settingsStore.save({ localServerEnabled: Boolean(enabled) });
    const st = await ensureLocalServerStarted();
    if (st && localView && !localView.webContents.isDestroyed()) {
      await localView.webContents.loadURL(st.httpUrl);
    }
    broadcastState();
    return getCombinedState();
  });

  ipcMain.handle("desktop:update-settings", async (_ev, patch: any) => {
    const portOrHostChanged =
      (patch?.localServerPort !== undefined && Number(patch.localServerPort) !== settings.localServerPort) ||
      (patch?.allowLan !== undefined && Boolean(patch.allowLan) !== settings.allowLan);
    settings = settingsStore.save(patch || {});
    if (portOrHostChanged && localServer) {
      await localServer.closeAll();
      localServer = null;
    }
    const st = await ensureLocalServerStarted();
    if (st && localView && !localView.webContents.isDestroyed()) {
      await localView.webContents.loadURL(st.httpUrl);
    }
    broadcastState();
    return getCombinedState();
  });

  ipcMain.handle("desktop:copy-text", (_ev, text: unknown) => {
    if (typeof text === "string" && text.length <= 16_000) {
      clipboard.writeText(text);
      return true;
    }
    return false;
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
    const nextStatus = await ensureLocalServerStarted();
    if (nextStatus && localView && !localView.webContents.isDestroyed()) {
      const currentUrl = localView.webContents.getURL();
      if (!currentUrl.startsWith(nextStatus.httpUrl)) {
        await localView.webContents.loadURL(nextStatus.httpUrl);
      }
    }
    broadcastState();
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
    const safeProfileName =
      rawProfileName ||
      displayName
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) ||
      `Agent-${Date.now().toString(36)}`;
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
    registerIpcHandlers();
    if (!isSmokeTest) {
      try {
        app.setAsDefaultProtocolClient("agentschat");
      } catch {}
      applyLaunchAtLoginSetting();
      setupApplicationMenu();
      try {
        const trayIconPath = join(UI_DIR, "tray-icon.png");
        const trayImg = existsSync(trayIconPath)
          ? nativeImage.createFromPath(trayIconPath)
          : nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
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
      const st = localServer?.getStatus();
      if (!st || !st.running) {
        console.error("[desktop-smoke] LocalMiniServer failed to start");
        app.exit(1);
        return;
      }
      try {
        const healthRes = await fetch(`${st.httpUrl}/health`);
        const health = (await healthRes.json()) as any;
        const shellProbe = await mainWindow?.webContents.executeJavaScript(
          `(async () => {
            const st = await window.agentschatShell?.getState?.();
            return {
              hasShellBridge: Boolean(window.agentschatShell),
              running: Boolean(st?.localServer?.running),
              hasLocalBtn: Boolean(document.getElementById("btn-local")),
              hasUnreadBadge: Boolean(document.getElementById("local-unread-badge")),
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
          !shellProbe?.hasShellBridge ||
          !shellProbe?.running ||
          !shellProbe?.hasLocalBtn ||
          !shellProbe?.hasUnreadBadge ||
          localProbe?.title !== "AgentsChat Local Server" ||
          !localProbe?.hasLocalBridge ||
          !localProbe?.ipcOk ||
          (localProbe?.missingIds?.length ?? 1) > 0 ||
          !localProbe?.connectOpen ||
          !localProbe?.hasClaudeSnippet ||
          smokeRendererErrors.length > 0
        ) {
          throw new Error(
            `Smoke audit failed: shell=${JSON.stringify(shellProbe)} local=${JSON.stringify(localProbe)} errors=${JSON.stringify(smokeRendererErrors)}`,
          );
        }
        console.log(
          `[desktop-smoke] OK: Electron ${process.versions.electron}, LocalMiniServer=${st.httpUrl}, shell+local bridges & DOM modal verified (0 console/CSP errors)`,
        );
        isQuitting = true;
        await localServer?.closeAll();
        localServer = null;
        app.exit(0);
      } catch (err: any) {
        console.error("[desktop-smoke] FAILED:", err?.message || err);
        isQuitting = true;
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
  });

  app.on("before-quit", () => {
    isQuitting = true;
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
