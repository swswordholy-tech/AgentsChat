export interface ParsedDeepLink {
  workspace: "cloud" | "local";
  path?: string;
  channelId?: string;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string;
  error?: string;
}

export const GITHUB_RELEASES_API_URL =
  "https://api.github.com/repos/swswordholy-tech/AgentsChat/releases?per_page=15";
export const GITHUB_RELEASES_WEB_URL =
  "https://github.com/swswordholy-tech/AgentsChat/releases";

/**
 * Safely parse an `agentschat://` deep link for macOS (`open-url`) and Windows (`second-instance`).
 * Examples:
 *   agentschat://cloud                -> { workspace: "cloud", path: "/" }
 *   agentschat://cloud/cloud-agents   -> { workspace: "cloud", path: "/cloud-agents" }
 *   agentschat://local                -> { workspace: "local" }
 *   agentschat://local/my-group       -> { workspace: "local", channelId: "my-group" }
 *
 * Strictly rejects open redirects (`//evil.com`, backslashes, `@`, control chars) and unknown schemes.
 */
export function parseDeepLink(rawUrl: string): ParsedDeepLink | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 512) return null;
  if (trimmed.includes("..") || /%2e%2e/i.test(trimmed) || trimmed.includes("\\") || /[\r\n\0]/.test(trimmed)) {
    return null;
  }
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "agentschat:") return null;
  if (u.username || u.password) return null;

  const host = u.hostname.toLowerCase();
  const rawPath = u.pathname || "/";
  if (rawPath.includes("//")) {
    return null;
  }

  if (host === "local") {
    const seg = rawPath.replace(/^\/+|\/+$/g, "");
    if (!seg) return { workspace: "local" };
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(seg) && !seg.includes("..")) {
      return { workspace: "local", channelId: seg };
    }
    return { workspace: "local" };
  }

  if (host === "cloud" || host === "open" || host === "") {
    const cleanPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    if (cleanPath.includes("..")) return null;
    const search = u.search && !/[\r\n\0]/.test(u.search) ? u.search : "";
    return { workspace: "cloud", path: `${cleanPath}${search}` };
  }

  return null;
}

export const DESKTOP_MIN_ZOOM = 0.75;
export const DESKTOP_MAX_ZOOM = 1.75;

export type CloudQuickRoute = "lobby" | "cloud-agents" | "okr-board" | "marketplace" | "dashboard";

const CLOUD_QUICK_ROUTE_PATHS: Record<CloudQuickRoute, string> = {
  lobby: "/lobby",
  "cloud-agents": "/cloud-agents",
  "okr-board": "/okr-board",
  marketplace: "/marketplace",
  dashboard: "/dashboard",
};

/**
 * Resolve an allowlisted Desktop Rail quick-route key to a same-origin Cloud URL.
 * Rejects unknown route keys or malformed remoteServerUrl values.
 */
export function resolveCloudQuickRoute(route: unknown, remoteServerUrl: string): string | null {
  if (typeof route !== "string") return null;
  const path = Object.prototype.hasOwnProperty.call(CLOUD_QUICK_ROUTE_PATHS, route)
    ? CLOUD_QUICK_ROUTE_PATHS[route as CloudQuickRoute]
    : null;
  if (!path) return null;
  try {
    const base = new URL(remoteServerUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    return new URL(path, base.origin).toString();
  } catch {
    return null;
  }
}

/**
 * Map the current Cloud WebView URL to the corresponding Desktop Rail section highlight.
 */
export function classifyCloudRailSection(rawUrl: unknown, remoteServerUrl: string): CloudQuickRoute {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "lobby";
  try {
    const cur = new URL(rawUrl);
    const expectedOrigin = new URL(remoteServerUrl).origin;
    if (cur.origin !== expectedOrigin) return "lobby";
    const p = cur.pathname.toLowerCase();
    if (p === "/cloud-agents" || p.startsWith("/cloud-agents/")) return "cloud-agents";
    if (p === "/okr-board" || p === "/okr" || p === "/okr.html" || p === "/okr-board.html") return "okr-board";
    if (p === "/marketplace" || p === "/marketplace.html") return "marketplace";
    if (p === "/dashboard" || p === "/dashboard.html") return "dashboard";
    return "lobby";
  } catch {
    return "lobby";
  }
}

/**
 * Selector covering every theme toggle button across AgentsChat Cloud pages
 * while explicitly excluding non-theme icon buttons (such as `#shortcutsBtn`
 * on OKR Board that shares the `.theme-toggle` utility class).
 */
export const CLOUD_THEME_TOGGLE_SELECTOR =
  ".theme-toggle:not(#shortcutsBtn), .theme-btn, #themeToggleBtn, #agentThemeToggle, #approvalsThemeToggle, #analyticsThemeToggle, #landingThemeToggle, #lkThemeToggle, #docThemeToggle, #protocolThemeToggle, #modThemeToggle";

/**
 * Format a safe, shareable http(s) URL for the currently viewed Cloud page.
 * Strictly enforces same-origin with `remoteServerUrl`, strips any embedded
 * credentials, and returns `null` for `file://`, `about:`, or foreign origins.
 */
export function formatCopyableCloudUrl(rawUrl: unknown, remoteServerUrl: string): string | null {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl);
    const expected = new URL(remoteServerUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.origin !== expected.origin) return null;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Format zoom factor into a compact rail badge string (e.g. `110%`), or `null`
 * when at the default 100% scale so the rail stays clean.
 */
export function formatZoomBadge(zoomFactor: unknown): string | null {
  const clamped = clampDesktopZoomFactor(zoomFactor);
  const pct = Math.round(clamped * 100);
  return pct === 100 ? null : `${pct}%`;
}

/**
 * Resolve the safest retry URL for `cloud-offline.html`: preserves the exact
 * same-origin Cloud sub-page that failed (stripping any credentials), and falls
 * back to `remoteServerUrl` for foreign, `file://`, or malformed URLs.
 */
export function resolveOfflineRetryUrl(failedUrl: unknown, remoteServerUrl: string): string {
  return formatCopyableCloudUrl(failedUrl, remoteServerUrl) || remoteServerUrl;
}

/**
 * Safely construct a loopback Local Mini-Server channel deep-link URL
 * (`http://127.0.0.1:<port>/#channel=<id>`) for OS Notification click routing
 * and `agentschat://local/<channel>` deep links.
 * Strictly requires an HTTP loopback origin and a valid, traversal-free channel ID.
 */
export function buildLocalChannelUrl(httpUrl: string, channelId: unknown): string | null {
  if (typeof httpUrl !== "string" || typeof channelId !== "string") return null;
  const cleanId = channelId.trim();
  if (!cleanId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(cleanId) || cleanId.includes("..")) {
    return null;
  }
  try {
    const parsed = new URL(httpUrl);
    if (parsed.protocol !== "http:") return null;
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return null;
    if (parsed.username || parsed.password) return null;
    return `${parsed.origin}/#channel=${encodeURIComponent(cleanId)}`;
  } catch {
    return null;
  }
}

export interface TrayTooltipState {
  cloudUnread?: number;
  localUnread?: number;
  localRunning: boolean;
  localPort?: number;
  localOnlineCount?: number;
  notificationsMuted?: boolean;
}

/**
 * Format a compact, live tray tooltip summarizing unread notifications and
 * embedded Local Mini-Server status.
 */
export function formatTrayTooltip(state: TrayTooltipState): string {
  const cloud = Math.max(0, Math.floor(Number(state.cloudUnread) || 0));
  const local = Math.max(0, Math.floor(Number(state.localUnread) || 0));
  const totalUnread = cloud + local;
  const head = totalUnread > 0 ? `AgentsChat Desktop (${totalUnread} unread)` : "AgentsChat Desktop";
  const muteSuffix = state.notificationsMuted === true ? " · Muted" : "";
  if (!state.localRunning) {
    return `${head} · Local Stopped${muteSuffix}`;
  }
  const port = Number.isFinite(Number(state.localPort)) && Number(state.localPort) > 0 ? Number(state.localPort) : 8787;
  const online = Math.max(0, Math.floor(Number(state.localOnlineCount) || 0));
  return online > 0
    ? `${head} · Local :${port} (${online} online)${muteSuffix}`
    : `${head} · Local :${port}${muteSuffix}`;
}

export interface DesktopWindowTitleState {
  activeWorkspace: "cloud" | "local";
  cloudSection?: CloudQuickRoute;
  cloudUnread?: number;
  localUnread?: number;
  localRunning?: boolean;
  localPort?: number;
}

const CLOUD_SECTION_TITLES: Record<CloudQuickRoute, string> = {
  lobby: "AgentsChat",
  "cloud-agents": "AgentsChat · Cloud Studio",
  "okr-board": "AgentsChat · OKR Board",
  marketplace: "AgentsChat · Bot Market",
  dashboard: "AgentsChat · Dashboard",
};

/**
 * Format a concise, live native window title showing unread count and active
 * Cloud section or Local Mini-Server port.
 */
export function formatDesktopWindowTitle(state: DesktopWindowTitleState): string {
  const cloud = Math.max(0, Math.floor(Number(state.cloudUnread) || 0));
  const local = Math.max(0, Math.floor(Number(state.localUnread) || 0));
  const totalUnread = cloud + local;
  const prefix = totalUnread > 0 ? `(${totalUnread}) ` : "";
  if (state.activeWorkspace === "local") {
    if (state.localRunning) {
      const port = Number.isFinite(Number(state.localPort)) && Number(state.localPort) > 0 ? Number(state.localPort) : 8787;
      return `${prefix}AgentsChat · Local :${port}`;
    }
    return `${prefix}AgentsChat · Local`;
  }
  const section = state.cloudSection && Object.prototype.hasOwnProperty.call(CLOUD_SECTION_TITLES, state.cloudSection)
    ? state.cloudSection
    : "lobby";
  return `${prefix}${CLOUD_SECTION_TITLES[section]}`;
}

/**
 * Verify that an IPC theme signal from Cloud WebContentsView comes from the
 * configured AgentsChat remote origin (http/https only).
 */
export function isTrustedCloudThemeOrigin(senderUrl: unknown, remoteServerUrl: string): boolean {
  if (typeof senderUrl !== "string" || !senderUrl.trim()) return false;
  try {
    const sender = new URL(senderUrl);
    const expected = new URL(remoteServerUrl);
    if (sender.protocol !== "https:" && sender.protocol !== "http:") return false;
    return sender.origin === expected.origin;
  } catch {
    return false;
  }
}

/**
 * Identify whether a WebContentsView URL is the bundled `cloud-offline.html` fallback page.
 */
export function isCloudOfflinePageUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  try {
    const u = new URL(rawUrl);
    return u.protocol === "file:" && /(?:^|\/)cloud-offline\.html$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Identify whether a WebContentsView URL is the bundled `local-stopped.html` status page.
 */
export function isLocalStoppedPageUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  try {
    const u = new URL(rawUrl);
    return u.protocol === "file:" && /(?:^|\/)local-stopped\.html$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Format a concise native download-completed notification title & body,
 * stripping control characters and clamping long filenames safely.
 */
export function formatDownloadCompleteNotice(rawFilename: unknown): { title: string; body: string } {
  const cleaned = String(rawFilename || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  const base = cleaned.split(/[\\/]/).pop()?.trim() || "文件";
  const display = base.length > 72 ? `${base.slice(0, 71)}…` : base;
  return {
    title: "文件已保存",
    body: `${display} · 点击在访达 / 文件夹中显示`,
  };
}

/**
 * Compute an Electron `BrowserWindow.setProgressBar` value from download byte counters.
 * Returns `0..1` when total size is known, `2` (indeterminate) while receiving bytes
 * without a known total, or `-1` (clear progress bar) when invalid/idle.
 */
export function computeDownloadProgress(receivedBytes: unknown, totalBytes: unknown): number {
  const received = Number(receivedBytes);
  const total = Number(totalBytes);
  if (!Number.isFinite(received) || received < 0) return -1;
  if (Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(1, received / total));
  }
  return received > 0 ? 2 : -1;
}

/**
 * Build the safe Local Mini-Server MCP CLI command for a loopback HTTP base URL.
 */
export function formatLocalMcpCommand(httpUrl: unknown): string {
  const fallback = "http://127.0.0.1:8787";
  if (typeof httpUrl !== "string" || !httpUrl.trim()) {
    return `npx -y agentschat-mcp@latest --url ${fallback}`;
  }
  try {
    const parsed = new URL(httpUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `npx -y agentschat-mcp@latest --url ${fallback}`;
    }
    parsed.username = "";
    parsed.password = "";
    return `npx -y agentschat-mcp@latest --url ${parsed.origin}`;
  } catch {
    return `npx -y agentschat-mcp@latest --url ${fallback}`;
  }
}

export interface WorkspaceCopyAction {
  kind: "cloud-url" | "local-mcp";
  text: string;
  title: string;
}

/**
 * Resolve what `Cmd/Ctrl+Shift+C` should copy based on the currently visible workspace:
 * - Cloud workspace: copy the safe same-origin Cloud page URL.
 * - Local workspace: copy the Local Mini-Server MCP command when running.
 */
export function resolveWorkspaceCopyAction(opts: {
  activeWorkspace: "cloud" | "local";
  cloudUrl: unknown;
  remoteServerUrl: string;
  localHttpUrl?: unknown;
  localRunning: boolean;
}): WorkspaceCopyAction | null {
  if (opts.activeWorkspace === "local") {
    if (!opts.localRunning) return null;
    return {
      kind: "local-mcp",
      text: formatLocalMcpCommand(opts.localHttpUrl),
      title: "已复制本机 MCP 接入命令",
    };
  }
  const safeCloudUrl = formatCopyableCloudUrl(opts.cloudUrl, opts.remoteServerUrl);
  if (!safeCloudUrl) return null;
  return {
    kind: "cloud-url",
    text: safeCloudUrl,
    title: "已复制当前页面链接",
  };
}

/**
 * Build the safe IIFE injected into same-origin Cloud pages to sync theme
 * state from Desktop without triggering an echo loop in `cloud-preload.cjs`
 * and without clobbering SVG icon buttons.
 */
export function buildCloudThemeSyncScript(nextTheme: "light" | "dark"): string {
  const isLight = nextTheme === "light";
  const safeTheme = isLight ? "light" : "dark";
  const icon = isLight ? "☀️" : "🌙";
  return `(() => {
    try {
      const html = document.documentElement;
      if (html && html.dataset) {
        html.dataset.acDesktopSyncing = '1';
        html.dataset.acDesktopThemeReady = '1';
      }
      localStorage.setItem('ac_theme', ${JSON.stringify(safeTheme)});
      if (html) {
        html.classList.toggle('light', ${isLight});
        if (html.style) html.style.colorScheme = ${JSON.stringify(safeTheme)};
      }
      if (document.body) document.body.classList.toggle('light', ${isLight});
      const toggles = document.querySelectorAll(${JSON.stringify(CLOUD_THEME_TOGGLE_SELECTOR)});
      for (const el of toggles) {
        if (!el || (typeof el.querySelector === 'function' && el.querySelector('svg'))) continue;
        el.textContent = ${JSON.stringify(icon)};
      }
      setTimeout(() => {
        try {
          if (html && html.dataset) delete html.dataset.acDesktopSyncing;
        } catch {}
      }, 0);
    } catch {}
  })()`;
}

/**
 * Build the safe IIFE injected into `cloud-offline.html` to sync Light/Dark mode.
 */
export function buildOfflineThemeSyncScript(nextTheme: "light" | "dark"): string {
  const isDark = nextTheme === "dark";
  return `(() => {
    try {
      if (document.body) document.body.classList.toggle('dark', ${isDark});
      if (document.documentElement && document.documentElement.style) {
        document.documentElement.style.colorScheme = ${JSON.stringify(nextTheme)};
      }
    } catch {}
  })()`;
}

/**
 * Extract leading `(N)` unread count from a Web page title (e.g. "(3) AgentsChat" -> 3).
 */
export function parseUnreadCountFromTitle(title: unknown): number {
  if (typeof title !== "string") return 0;
  const m = title.trim().match(/^\((\d{1,4})\)(?:\s+|$)/);
  if (!m) return 0;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(999, n);
}

export interface RectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compute centered window bounds within a display's workArea, clamping width
 * and height so the window never overflows smaller displays.
 */
export function computeCenteredWindowBounds(
  workArea: RectBounds,
  targetWidth = 1320,
  targetHeight = 860,
  minWidth = 880,
  minHeight = 560,
): RectBounds {
  const waX = Number.isFinite(workArea.x) ? Math.round(workArea.x) : 0;
  const waY = Number.isFinite(workArea.y) ? Math.round(workArea.y) : 0;
  const waW = Math.max(320, Math.round(Number.isFinite(workArea.width) ? workArea.width : targetWidth));
  const waH = Math.max(240, Math.round(Number.isFinite(workArea.height) ? workArea.height : targetHeight));
  const clampedMinW = Math.min(minWidth, waW);
  const clampedMinH = Math.min(minHeight, waH);
  const width = Math.min(waW, Math.max(clampedMinW, Math.round(targetWidth)));
  const height = Math.min(waH, Math.max(clampedMinH, Math.round(targetHeight)));
  const x = waX + Math.round((waW - width) / 2);
  const y = waY + Math.round((waH - height) / 2);
  return { x, y, width, height };
}

export interface SavedWindowBounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * Resolve restored window bounds safely against the matching display's workArea.
 * Clamps oversized windows (e.g. saved on an external 4K display, restored after
 * undocking to a smaller laptop panel) so the window fits completely inside the
 * visible workArea, and omits off-screen x/y coordinates cleanly.
 */
export function resolveRestoredWindowBounds(
  saved: SavedWindowBounds | null | undefined,
  workArea: RectBounds | null | undefined,
  defaultWidth = 1320,
  defaultHeight = 860,
  minWidth = 880,
  minHeight = 560,
): { width: number; height: number; x?: number; y?: number } {
  const rawW = Number(saved?.width);
  const rawH = Number(saved?.height);
  const baseW = Number.isFinite(rawW) && rawW > 0 ? Math.round(rawW) : defaultWidth;
  const baseH = Number.isFinite(rawH) && rawH > 0 ? Math.round(rawH) : defaultHeight;

  if (
    !workArea ||
    !Number.isFinite(workArea.width) ||
    !Number.isFinite(workArea.height) ||
    workArea.width <= 0 ||
    workArea.height <= 0
  ) {
    return {
      width: Math.max(minWidth, baseW),
      height: Math.max(minHeight, baseH),
    };
  }

  const waX = Number.isFinite(workArea.x) ? Math.round(workArea.x) : 0;
  const waY = Number.isFinite(workArea.y) ? Math.round(workArea.y) : 0;
  const waW = Math.max(320, Math.round(workArea.width));
  const waH = Math.max(240, Math.round(workArea.height));

  const clampedMinW = Math.min(minWidth, waW);
  const clampedMinH = Math.min(minHeight, waH);
  const width = Math.min(waW, Math.max(clampedMinW, baseW));
  const height = Math.min(waH, Math.max(clampedMinH, baseH));

  const rawX = saved?.x;
  const rawY = saved?.y;
  if (typeof rawX === "number" && Number.isFinite(rawX) && typeof rawY === "number" && Number.isFinite(rawY)) {
    const sx = Math.round(rawX);
    const sy = Math.round(rawY);
    const intersects =
      sx < waX + waW - 80 &&
      sx + baseW > waX + 80 &&
      sy < waY + waH - 60 &&
      sy + baseH > waY + 40;
    if (intersects) {
      const x = Math.min(waX + waW - width, Math.max(waX, sx));
      const y = Math.min(waY + waH - height, Math.max(waY, sy));
      return { width, height, x, y };
    }
  }

  return { width, height };
}

const RESERVED_LOCAL_PROFILE_NAMES = new Set([
  "profile",
  "config",
  "settings",
  "default",
  "dev-token",
  "session-binds",
]);

/**
 * Derive a traversal-free, OS-safe local profile filename stem (`~/.agentschat/profiles/<name>.json`)
 * from an optional user-provided profile name or display name.
 * Strips path separators, traversal sequences, leading punctuation, and reserved names.
 */
export function sanitizeLocalProfileName(
  rawProfileName: unknown,
  displayName: unknown,
  fallbackSuffix = "agent",
): string {
  const cleanCandidate = (raw: unknown): string => {
    if (typeof raw !== "string") return "";
    const stripped = raw
      .trim()
      .replace(/\.\.+/g, "-")
      .replace(/[\\/]+/g, "-")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 40)
      .replace(/[._-]+$/g, "");
    if (!stripped || RESERVED_LOCAL_PROFILE_NAMES.has(stripped.toLowerCase())) {
      return "";
    }
    return stripped;
  };

  const primary = cleanCandidate(rawProfileName);
  if (primary) return primary;
  const fromDisplay = cleanCandidate(displayName);
  if (fromDisplay) return fromDisplay;

  const safeSuffix =
    String(fallbackSuffix || "")
      .replace(/[^a-zA-Z0-9_-]+/g, "")
      .slice(0, 16) || "agent";
  return `Agent-${safeSuffix}`;
}

/**
 * Clamp and round Electron webContents zoom factor to a safe, comfortable range [0.75, 1.75].
 */
export function clampDesktopZoomFactor(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(DESKTOP_MAX_ZOOM, Math.max(DESKTOP_MIN_ZOOM, Math.round(n * 100) / 100));
}

export function parseDesktopReleaseTag(tagName: string): string | null {
  const m = String(tagName || "").trim().match(/^desktop-v(\d+)\.(\d+)\.(\d+)$/i);
  if (!m) return null;
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
}

export function compareSemver(a: string, b: string): number {
  const pa = String(a || "0.0.0")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "0.0.0")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export async function checkLatestDesktopRelease(
  currentVersion: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<DesktopUpdateCheckResult> {
  try {
    const res = await fetchImpl(GITHUB_RELEASES_API_URL, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `AgentsChat-Desktop/${currentVersion}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return {
        checked: false,
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        releaseUrl: GITHUB_RELEASES_WEB_URL,
        error: `GitHub API returned HTTP ${res.status}`,
      };
    }
    const list = (await res.json()) as Array<{
      tag_name?: string;
      html_url?: string;
      draft?: boolean;
      prerelease?: boolean;
    }>;
    let bestVersion: string | null = null;
    let bestUrl = GITHUB_RELEASES_WEB_URL;
    for (const rel of Array.isArray(list) ? list : []) {
      if (rel.draft || rel.prerelease) continue;
      const ver = parseDesktopReleaseTag(rel.tag_name || "");
      if (!ver) continue;
      if (!bestVersion || compareSemver(ver, bestVersion) > 0) {
        bestVersion = ver;
        if (typeof rel.html_url === "string" && rel.html_url.startsWith("https://github.com/")) {
          bestUrl = rel.html_url;
        }
      }
    }
    const hasUpdate = Boolean(bestVersion && compareSemver(bestVersion, currentVersion) > 0);
    return {
      checked: true,
      currentVersion,
      latestVersion: bestVersion,
      hasUpdate,
      releaseUrl: bestUrl,
    };
  } catch (err: any) {
    return {
      checked: false,
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      releaseUrl: GITHUB_RELEASES_WEB_URL,
      error: String(err?.message || "Network error"),
    };
  }
}
