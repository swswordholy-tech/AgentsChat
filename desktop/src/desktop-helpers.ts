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
  showLocalWorkspace?: boolean;
  localRunning: boolean;
  localPort?: number;
  localOnlineCount?: number;
  notificationsMuted?: boolean;
  audioMuted?: boolean;
}

/**
 * Format a compact, live tray tooltip summarizing unread notifications and
 * embedded Local Mini-Server status (omitting Local status in Cloud-only mode).
 */
export function formatTrayTooltip(state: TrayTooltipState): string {
  const cloud = Math.max(0, Math.floor(Number(state.cloudUnread) || 0));
  const showLocal = state.showLocalWorkspace !== false;
  const local = showLocal ? Math.max(0, Math.floor(Number(state.localUnread) || 0)) : 0;
  const totalUnread = cloud + local;
  const head = totalUnread > 0 ? `AgentsChat Desktop (${totalUnread} unread)` : "AgentsChat Desktop";
  const muteSuffix = [
    state.notificationsMuted === true ? "Muted" : "",
    state.audioMuted === true ? "Audio Off" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const trailingStatus = muteSuffix ? ` · ${muteSuffix}` : "";
  if (!showLocal) {
    return `${head}${trailingStatus}`;
  }
  if (!state.localRunning) {
    return `${head} · Local Stopped${trailingStatus}`;
  }
  const port = Number.isFinite(Number(state.localPort)) && Number(state.localPort) > 0 ? Number(state.localPort) : 8787;
  const online = Math.max(0, Math.floor(Number(state.localOnlineCount) || 0));
  return online > 0
    ? `${head} · Local :${port} (${online} online)${trailingStatus}`
    : `${head} · Local :${port}${trailingStatus}`;
}

export interface DesktopWindowTitleState {
  activeWorkspace: "cloud" | "local";
  cloudSection?: CloudQuickRoute;
  cloudUnread?: number;
  localUnread?: number;
  localRunning?: boolean;
  localPort?: number;
  audioMuted?: boolean;
}

const CLOUD_SECTION_TITLES: Record<CloudQuickRoute, string> = {
  lobby: "AgentsChat",
  "cloud-agents": "AgentsChat · Cloud Studio",
  "okr-board": "AgentsChat · OKR Board",
  marketplace: "AgentsChat · Bot Market",
  dashboard: "AgentsChat · Dashboard",
};

/**
 * Format a concise, live native window title showing unread count, active
 * Cloud section or Local Mini-Server port, and audio mute status when enabled.
 */
export function formatDesktopWindowTitle(state: DesktopWindowTitleState): string {
  const cloud = Math.max(0, Math.floor(Number(state.cloudUnread) || 0));
  const local = Math.max(0, Math.floor(Number(state.localUnread) || 0));
  const totalUnread = cloud + local;
  const prefix = totalUnread > 0 ? `(${totalUnread}) ` : "";
  const audioSuffix = state.audioMuted === true ? " · Audio Off" : "";
  if (state.activeWorkspace === "local") {
    if (state.localRunning) {
      const port = Number.isFinite(Number(state.localPort)) && Number(state.localPort) > 0 ? Number(state.localPort) : 8787;
      return `${prefix}AgentsChat · Local :${port}${audioSuffix}`;
    }
    return `${prefix}AgentsChat · Local${audioSuffix}`;
  }
  const section = state.cloudSection && Object.prototype.hasOwnProperty.call(CLOUD_SECTION_TITLES, state.cloudSection)
    ? state.cloudSection
    : "lobby";
  return `${prefix}${CLOUD_SECTION_TITLES[section]}${audioSuffix}`;
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

export interface ActiveDownloadSample {
  receivedBytes: number;
  totalBytes: number;
  state: string;
}

/**
 * Aggregate OS taskbar/Dock progress across all concurrent active downloads.
 * Ignores non-progressing items (e.g. interrupted/paused), returns `0..1` when
 * all progressing items have known totals, `2` (indeterminate) when any item
 * has unknown total bytes, and `-1` to clear the bar when none are progressing.
 */
export function aggregateDownloadProgress(items: ReadonlyArray<ActiveDownloadSample>): number {
  let receivedSum = 0;
  let totalSum = 0;
  let hasProgressing = false;
  let hasIndeterminate = false;
  for (const item of items) {
    if (!item || item.state !== "progressing") continue;
    hasProgressing = true;
    const rec = Number(item.receivedBytes);
    const tot = Number(item.totalBytes);
    if (Number.isFinite(rec) && rec > 0) receivedSum += rec;
    if (Number.isFinite(tot) && tot > 0) {
      totalSum += tot;
    } else {
      hasIndeterminate = true;
    }
  }
  if (!hasProgressing) return -1;
  if (hasIndeterminate || totalSum <= 0) return receivedSum > 0 ? 2 : 0;
  return Math.max(0, Math.min(1, receivedSum / totalSum));
}

export interface BeforeInputKeySample {
  type?: string;
  key?: string;
  alt?: boolean;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  isComposing?: boolean;
}

/**
 * Map cross-platform browser navigation keys (`F5`, `Shift/Ctrl+F5`, `Alt+ArrowLeft`, `Alt+ArrowRight`)
 * and Escape dismissal of an open Find bar inside `before-input-event` while strictly ignoring IME composition.
 */
export function resolveBeforeInputShortcut(
  input: BeforeInputKeySample,
  opts?: { findBarOpen?: boolean },
): "reload" | "force-reload" | "back" | "forward" | "close-find" | null {
  if (!input || input.type !== "keyDown" || input.isComposing) return null;
  const key = String(input.key || "");
  const hasPrimaryMod = Boolean(input.control || input.meta);
  if (opts?.findBarOpen === true && key === "Escape" && !hasPrimaryMod && !input.alt && !input.shift) {
    return "close-find";
  }
  if (key === "F5" && !input.alt) {
    if (input.shift || hasPrimaryMod) return "force-reload";
    return "reload";
  }
  if (input.alt && !hasPrimaryMod && !input.shift) {
    if (key === "ArrowLeft") return "back";
    if (key === "ArrowRight") return "forward";
  }
  return null;
}

const SELECTION_SECRET_RE =
  /(?:(?:^|[^A-Za-z0-9])(?:mcp_(?:at|rt|code)_|ac_|agent_key_|whsec_|sk[-_]|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|(?:hf|npm)_)[A-Za-z0-9_-]{6,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/i;

export interface SelectionLookupInfo {
  label: string;
  searchUrl: string | null;
}

/**
 * Build a secret-safe label and external search URL for selected text in native context menus.
 * Never emits an external search URL for credentials/tokens or overly long selections (>300 chars).
 */
export function buildSelectionLookupInfo(selectionText: unknown): SelectionLookupInfo | null {
  if (typeof selectionText !== "string") return null;
  const normalized = selectionText.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const isSecret = SELECTION_SECRET_RE.test(normalized);
  if (isSecret) return null;
  const label = normalized.length > 28 ? `${normalized.slice(0, 27)}…` : normalized;
  const searchUrl =
    normalized.length <= 300 ? `https://www.google.com/search?q=${encodeURIComponent(normalized)}` : null;
  return { label, searchUrl };
}

/**
 * Sanitize selected page text for seeding the native Find-in-Page bar (`Cmd/Ctrl+E` or context menu).
 * Strips control characters, normalizes whitespace to single spaces, caps at 120 characters,
 * and rejects empty selections.
 */
export function sanitizeFindSeedText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, 120);
}

/**
 * Compute clamped top-right floating bounds for the native Find-in-Page bar
 * rendered above the active Cloud / Local WebContentsView.
 */
export function computeFindBarBounds(
  contentWidth: number,
  contentHeight: number,
  railWidth: number,
): { x: number; y: number; width: number; height: number } {
  const safeContentW = Number.isFinite(contentWidth) ? Math.max(320, Math.round(contentWidth)) : 1200;
  const safeContentH = Number.isFinite(contentHeight) ? Math.max(200, Math.round(contentHeight)) : 800;
  const safeRail = Number.isFinite(railWidth) ? Math.max(0, Math.round(railWidth)) : 0;
  const availW = Math.max(240, safeContentW - safeRail - 24);
  const width = Math.min(368, availW);
  const height = Math.min(48, Math.max(40, safeContentH - 24));
  const x = Math.max(safeRail + 12, safeContentW - width - 16);
  const y = 12;
  return { x, y, width, height };
}

/**
 * Format Chromium `found-in-page` ordinal & total count for the floating Find bar.
 */
export function formatFindMatchCounter(
  activeMatchOrdinal: number,
  matches: number,
  hasQuery: boolean,
): string {
  if (!hasQuery) return "";
  const safeTotal = Number.isFinite(matches) && matches > 0 ? Math.floor(matches) : 0;
  if (safeTotal === 0) return "0 / 0";
  const safeActive =
    Number.isFinite(activeMatchOrdinal) && activeMatchOrdinal > 0
      ? Math.min(safeTotal, Math.floor(activeMatchOrdinal))
      : 1;
  return `${safeActive} / ${safeTotal}`;
}

const ALLOWED_WEB_PERMISSIONS = new Set([
  "media",
  "audioCapture",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "notifications",
]);

export interface WebPermissionCheckParams {
  workspace: "cloud" | "local";
  permission: string;
  requestingOrigin: unknown;
  remoteServerUrl: string;
  notificationsMuted?: boolean;
}

/**
 * Strict, least-privilege Electron permission policy for Cloud and Local sessions:
 * - Denies untrusted / foreign origins.
 * - Allowlists only voice/media, clipboard, fullscreen, and notifications.
 * - Enforces Desktop Do-Not-Disturb (`notificationsMuted`) for Web notifications too.
 */
export function shouldGrantWebPermission(params: WebPermissionCheckParams): boolean {
  const perm = String(params.permission || "");
  if (!ALLOWED_WEB_PERMISSIONS.has(perm)) return false;
  if (perm === "notifications" && params.notificationsMuted === true) return false;
  if (typeof params.requestingOrigin !== "string" || !params.requestingOrigin.trim()) return false;
  try {
    const req = new URL(params.requestingOrigin);
    if (params.workspace === "cloud") {
      const expected = new URL(params.remoteServerUrl);
      return (req.protocol === "https:" || req.protocol === "http:") && req.origin === expected.origin;
    }
    return req.protocol === "http:" && (req.hostname === "127.0.0.1" || req.hostname === "localhost");
  } catch {
    return false;
  }
}

/**
 * Guard `localView` main-frame navigations so accidental file drops or untrusted
 * URLs can never replace the embedded Local Mini-Server UI.
 */
export function isAllowedLocalViewNavigation(targetUrl: unknown, localHttpUrl: string | null | undefined): boolean {
  if (typeof targetUrl !== "string" || !targetUrl.trim()) return false;
  if (targetUrl === "agentschat-action://start-local" || targetUrl === "agentschat-action://switch-cloud") {
    return true;
  }
  if (isLocalStoppedPageUrl(targetUrl)) return true;
  if (!localHttpUrl) return false;
  try {
    const target = new URL(targetUrl);
    const local = new URL(localHttpUrl);
    return target.protocol === "http:" && target.origin === local.origin;
  } catch {
    return false;
  }
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

/**
 * Check whether an already-open window's bounds need clamping after a live
 * display-removal or display-metrics change (e.g. undocking an external monitor).
 * Returns `null` when the window already fits cleanly within `workArea`, or the
 * minimal clamped/centered `RectBounds` when it overflows or lies off-screen.
 */
export function computeDisplayReclampedBounds(
  current: RectBounds,
  workArea: RectBounds,
  minWidth = 880,
  minHeight = 560,
): RectBounds | null {
  if (
    !Number.isFinite(workArea.width) ||
    !Number.isFinite(workArea.height) ||
    workArea.width <= 0 ||
    workArea.height <= 0
  ) {
    return null;
  }
  const waX = Number.isFinite(workArea.x) ? Math.round(workArea.x) : 0;
  const waY = Number.isFinite(workArea.y) ? Math.round(workArea.y) : 0;
  const waW = Math.max(320, Math.round(workArea.width));
  const waH = Math.max(240, Math.round(workArea.height));

  const curX = Math.round(Number(current.x) || 0);
  const curY = Math.round(Number(current.y) || 0);
  const curW = Math.max(1, Math.round(Number(current.width) || 1320));
  const curH = Math.max(1, Math.round(Number(current.height) || 860));

  const fitsWidth = curW <= waW;
  const fitsHeight = curH <= waH;
  const insideX = curX >= waX && curX + curW <= waX + waW;
  const insideY = curY >= waY && curY + curH <= waY + waH;
  if (fitsWidth && fitsHeight && insideX && insideY) {
    return null;
  }

  const clampedMinW = Math.min(minWidth, waW);
  const clampedMinH = Math.min(minHeight, waH);
  const nextW = Math.min(waW, Math.max(clampedMinW, curW));
  const nextH = Math.min(waH, Math.max(clampedMinH, curH));
  const nextX = Math.min(waX + waW - nextW, Math.max(waX, curX));
  const nextY = Math.min(waY + waH - nextH, Math.max(waY, curY));
  return { x: nextX, y: nextY, width: nextW, height: nextH };
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

export interface DesktopDiagnosticsSnapshot {
  appVersion: string;
  electronVersion?: string;
  nodeVersion?: string;
  platform: string;
  arch?: string;
  activeWorkspace: "cloud" | "local";
  showLocalWorkspace?: boolean;
  theme: "light" | "dark";
  zoomFactor?: number;
  localRunning: boolean;
  localPort?: number;
  allowLan?: boolean;
  localOnlineCount?: number;
  notificationsMuted?: boolean;
  audioMuted?: boolean;
}

/**
 * Format a clean, secret-free diagnostic summary for Help → Copy Diagnostics Info.
 * Never includes tokens, cookies, file paths, or user identities.
 */
export function formatDesktopDiagnostics(info: DesktopDiagnosticsSnapshot): string {
  const zoomPct = Math.round(clampDesktopZoomFactor(info.zoomFactor ?? 1) * 100);
  const port = Number.isFinite(Number(info.localPort)) && Number(info.localPort) > 0 ? Number(info.localPort) : 8787;
  const online = Math.max(0, Math.floor(Number(info.localOnlineCount) || 0));
  const localLine =
    info.showLocalWorkspace === false
      ? "Local Workspace: hidden (Cloud-only mode)"
      : info.localRunning
        ? `Local Mini-Server: running (:${port}, lan=${info.allowLan ? "on" : "off"}, online=${online})`
        : `Local Mini-Server: stopped (port=${port}, lan=${info.allowLan ? "on" : "off"})`;
  const audioPart = info.audioMuted === true ? " · Audio: muted" : "";
  return [
    `AgentsChat Desktop v${info.appVersion || "0.1.0"}`,
    `Runtime: Electron ${info.electronVersion || "unknown"} / Node ${info.nodeVersion || "unknown"} (${info.platform}${info.arch ? "/" + info.arch : ""})`,
    `Workspace: ${info.activeWorkspace} · Theme: ${info.theme} · Zoom: ${zoomPct}% · Muted: ${info.notificationsMuted ? "yes" : "no"}${audioPart}`,
    localLine,
  ].join("\n");
}

/**
 * Decide whether a `window.open` URL from the Cloud WebView is an OAuth sign-in
 * popup (which should stay in an Electron popup sharing the Cloud session partition)
 * vs. a regular external link (which should open in the user's default browser).
 */
export function isOAuthPopupUrl(rawUrl: unknown, remoteOrigin: string): boolean {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.origin === remoteOrigin) return true;
    const h = parsed.hostname.toLowerCase();
    if (h === "accounts.google.com" || h === "appleid.apple.com") return true;
    if (h === "github.com") {
      const p = parsed.pathname.toLowerCase();
      return p === "/login" || p.startsWith("/login/") || p === "/sessions" || p.startsWith("/sessions/");
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Map Electron native swipe directions (macOS trackpad) and app-command triggers
 * (Windows/Linux mouse Back/Forward buttons) to Cloud navigation history actions.
 */
export function resolveCloudHistoryCommand(trigger: string): "back" | "forward" | null {
  const normalized = String(trigger || "").trim().toLowerCase();
  if (normalized === "left" || normalized === "browser-backward") return "back";
  if (normalized === "right" || normalized === "browser-forward") return "forward";
  return null;
}

export type SmartReloadAction = { kind: "reload" } | { kind: "loadUrl"; url: string };

/**
 * Determine whether Reload (Cmd+R / rail reload / context menu Reload) should reload
 * the current document or recover from a static offline/stopped fallback page.
 */
export function resolveSmartReloadAction(params: {
  workspace: "cloud" | "local";
  currentUrl: string;
  lastCloudFailedUrl?: string | null;
  remoteServerUrl: string;
  localRunning?: boolean;
  localHttpUrl?: string | null;
}): SmartReloadAction {
  if (params.workspace === "cloud" && isCloudOfflinePageUrl(params.currentUrl)) {
    return {
      kind: "loadUrl",
      url: resolveOfflineRetryUrl(params.lastCloudFailedUrl, params.remoteServerUrl),
    };
  }
  if (
    params.workspace === "local" &&
    isLocalStoppedPageUrl(params.currentUrl) &&
    params.localRunning &&
    params.localHttpUrl
  ) {
    return { kind: "loadUrl", url: params.localHttpUrl };
  }
  return { kind: "reload" };
}

/**
 * Create a lightweight FIFO async task serializer so concurrent Local Mini-Server
 * start/stop/restart/LAN transitions execute strictly one at a time without leaking
 * orphaned listening sockets, while isolating errors so later tasks still run.
 */
export function createSerialTaskQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
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
