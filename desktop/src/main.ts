import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  WebContentsView,
} from "electron";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalIdentityAuthority } from "./identity-authority.js";
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

const isSmokeTest = process.env.AGENTSCHAT_DESKTOP_SMOKE_TEST === "1";
const desktopDataDir =
  process.env.AGENTSCHAT_DESKTOP_DATA_DIR?.trim() ||
  join(process.env.HOME || process.env.USERPROFILE || homedir(), ".agentschat", "desktop");
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
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    show: !isSmokeTest,
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

  if (!isSmokeTest) {
    void cloudView.webContents.loadURL(settings.remoteServerUrl);
  }
  const st = await ensureLocalServerStarted();
  if (st) {
    await localView.webContents.loadURL(st.httpUrl);
  }

  layoutViews();
  mainWindow.on("resize", () => layoutViews());
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

    const restartNeeded =
      (safePatch.localServerPort !== undefined && safePatch.localServerPort !== settings.localServerPort) ||
      (safePatch.allowLan !== undefined && safePatch.allowLan !== settings.allowLan);
    settings = settingsStore.save(safePatch);
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
    if (typeof profileName !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(profileName)) {
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
}

// ── App Lifecycle (Single-Instance on macOS & Windows) ────────────────────

const gotSingleInstanceLock = isSmokeTest ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    registerIpcHandlers();
    if (!isSmokeTest) {
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
        const uiTitle = await localView?.webContents.executeJavaScript("document.title", true);
        if (healthRes.status !== 200 || health?.mode !== "desktop_local_minimal" || uiTitle !== "AgentsChat Local Server") {
          throw new Error(`Unexpected smoke check output: status=${healthRes.status}, title=${uiTitle}`);
        }
        console.log(`[desktop-smoke] OK: Electron ${process.versions.electron}, LocalMiniServer=${st.httpUrl}, UI="${uiTitle}"`);
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
