import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  aggregateDownloadProgress,
  buildCloudThemeSyncScript,
  buildLocalChannelUrl,
  buildOfflineThemeSyncScript,
  checkLatestDesktopRelease,
  clampDesktopZoomFactor,
  classifyCloudRailSection,
  CLOUD_THEME_TOGGLE_SELECTOR,
  compareSemver,
  computeCenteredWindowBounds,
  computeDisplayReclampedBounds,
  computeDownloadProgress,
  createSerialTaskQueue,
  formatCopyableCloudUrl,
  formatDesktopDiagnostics,
  formatDesktopWindowTitle,
  formatDownloadCompleteNotice,
  formatLocalMcpCommand,
  formatTrayTooltip,
  formatZoomBadge,
  isCloudOfflinePageUrl,
  isLocalStoppedPageUrl,
  isOAuthPopupUrl,
  isTrustedCloudThemeOrigin,
  parseDeepLink,
  parseDesktopReleaseTag,
  parseUnreadCountFromTitle,
  resolveBeforeInputShortcut,
  resolveCloudHistoryCommand,
  resolveCloudQuickRoute,
  resolveOfflineRetryUrl,
  resolveRestoredWindowBounds,
  resolveSmartReloadAction,
  resolveWorkspaceCopyAction,
  sanitizeLocalProfileName,
} from "../src/desktop-helpers.js";
import { GlobalIdentityAuthority } from "../src/identity-authority.js";
import { LocalMiniServer } from "../src/local-server.js";
import { DEFAULT_DESKTOP_SETTINGS, DesktopSettingsStore, sanitizeDesktopSettings } from "../src/settings-store.js";

describe("AgentsChat Desktop M2 — Settings, Profile Discovery & Static Local UI", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ac-desktop-m2-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    } catch {}
  });

  test("DesktopSettingsStore persists atomically and rejects insecure remote URLs or out-of-range ports", () => {
    const settingsPath = join(tempDir, "nested", "desktop-settings.json");
    const store = new DesktopSettingsStore(settingsPath);

    expect(store.load()).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(DEFAULT_DESKTOP_SETTINGS.showLocalWorkspace).toBe(false);
    expect(DEFAULT_DESKTOP_SETTINGS.localServerEnabled).toBe(false);

    // Without showLocalWorkspace=true, activeWorkspace falls back to "cloud"
    const cloudOnlySaved = store.save({ activeWorkspace: "local" });
    expect(cloudOnlySaved.showLocalWorkspace).toBe(false);
    expect(cloudOnlySaved.activeWorkspace).toBe("cloud");

    const saved = store.save({
      showLocalWorkspace: true,
      activeWorkspace: "local",
      remoteServerUrl: "http://evil-insecure.example.com",
      localServerPort: 80,
      allowLan: true,
      minimizeToTray: false,
    });

    // Insecure HTTP remoteServerUrl and privileged port < 1024 fall back safely
    expect(saved.showLocalWorkspace).toBe(true);
    expect(saved.activeWorkspace).toBe("local");
    expect(saved.remoteServerUrl).toBe("https://agents-chat.com");
    expect(saved.localServerPort).toBe(8787);
    expect(saved.allowLan).toBe(true);
    expect(saved.minimizeToTray).toBe(false);

    // Custom HTTPS enterprise/staging URL without embedded credentials is accepted
    const custom = store.save({
      remoteServerUrl: "https://agents-chat.com///",
      localServerPort: 18787,
    });
    expect(custom.remoteServerUrl).toBe("https://agents-chat.com");
    expect(custom.localServerPort).toBe(18787);
    expect(store.load().localServerPort).toBe(18787);

    // Embedded credentials in URL are rejected
    expect(
      sanitizeDesktopSettings({ remoteServerUrl: "https://user:pass@agents-chat.com" }).remoteServerUrl,
    ).toBe("https://agents-chat.com");

    // Window bounds persistence & clamping
    const withBounds = store.save({ windowBounds: { width: 1440, height: 900, x: 120, y: 80 }, theme: "dark" });
    expect(withBounds.windowBounds).toEqual({ width: 1440, height: 900, x: 120, y: 80 });
    expect(withBounds.theme).toBe("dark");
    expect(store.load().windowBounds).toEqual({ width: 1440, height: 900, x: 120, y: 80 });
    expect(store.load().theme).toBe("dark");
    // Tiny or bogus window dimensions and invalid theme values are sanitized cleanly
    expect(sanitizeDesktopSettings({ windowBounds: { width: 100, height: 100 }, theme: "neon" as any }).windowBounds).toBeUndefined();
    expect(sanitizeDesktopSettings({ theme: "neon" as any }).theme).toBe("light");
  });

  test("discoverLocalAgentProfiles finds valid ~/.agentschat profiles while skipping symlinks, internal files, and dev-token", () => {
    const profilesDir = join(tempDir, ".agentschat", "profiles");
    mkdirSync(profilesDir, { recursive: true });

    // Valid named profile
    writeFileSync(
      join(profilesDir, "Claude_Lead.json"),
      JSON.stringify({
        agent_id: "claude-lead-01",
        display_name: "Claude Lead",
        token: "ac_live_secret_do_not_expose",
      }),
    );

    // Internal files & dev-token must be ignored
    writeFileSync(
      join(tempDir, ".agentschat", "session-binds.json"),
      JSON.stringify({ agent_id: "fake-bind", token: "ac_123" }),
    );
    writeFileSync(
      join(profilesDir, "DevBot.json"),
      JSON.stringify({ agent_id: "dev-bot", token: "dev-token" }),
    );

    // Symlinked profile must be ignored (mirrors agentschat-mcp symlink guard; Windows may lack SeCreateSymbolicLinkPrivilege)
    const outsideTarget = join(tempDir, "outside.json");
    writeFileSync(
      outsideTarget,
      JSON.stringify({ agent_id: "symlink-bot", display_name: "Symlink Bot", token: "ac_symlink_secret" }),
    );
    try {
      symlinkSync(outsideTarget, join(profilesDir, "Symlinked.json"), "file");
    } catch (err: any) {
      if (process.platform !== "win32" || err?.code !== "EPERM") throw err;
    }

    const discovered = GlobalIdentityAuthority.discoverLocalAgentProfiles(tempDir);
    expect(discovered.length).toBe(1);
    expect(discovered[0]?.profile_name).toBe("Claude_Lead");
    expect(discovered[0]?.agent_id).toBe("claude-lead-01");
    expect(discovered[0]?.display_name).toBe("Claude Lead");
    // Secret token must NEVER be included in discovered UI metadata
    expect((discovered[0] as any).token).toBeUndefined();
  });

  test("LocalMiniServer serves embedded local-chat UI assets and blocks path traversal", async () => {
    const uiDir = resolve(import.meta.dir, "../ui");
    const server = new LocalMiniServer({
      port: 0,
      dbPath: join(tempDir, "ui-test.db"),
      staticUiDir: uiDir,
    });

    const status = await server.start();
    try {
      const indexRes = await fetch(`${status.httpUrl}/`);
      expect(indexRes.status).toBe(200);
      expect(indexRes.headers.get("content-type")).toContain("text/html");
      expect(indexRes.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(indexRes.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(indexRes.headers.get("content-security-policy")).toContain("img-src 'self' data: https:");
      const html = await indexRes.text();
      expect(html).toContain("AgentsChat Local Server");
      expect(html).toContain("local-chat.js");
      expect(html).toContain("local-theme-init.js");

      const jsRes = await fetch(`${status.httpUrl}/local-chat.js`);
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get("content-type")).toContain("javascript");

      const themeInitRes = await fetch(`${status.httpUrl}/local-theme-init.js`);
      expect(themeInitRes.status).toBe(200);
      expect(themeInitRes.headers.get("content-type")).toContain("javascript");

      // Internal Electron preloads & shell files must NEVER be exposed over HTTP
      for (const secretPath of ["/preload.cjs", "/local-preload.cjs", "/settings-preload.cjs", "/shell.html", "/settings.html", "/cloud-offline.html", "/local-stopped.html"]) {
        const res = await fetch(`${status.httpUrl}${secretPath}`);
        expect(res.status).toBe(404);
      }

      // Path traversal attempt must never escape staticUiDir
      const traversalRes = await fetch(`${status.httpUrl}/..%2Fpackage.json`);
      expect(traversalRes.status).toBe(404);
      // Loopback mode never advertises LAN URLs
      expect(status.lanUrls).toEqual([]);
      const health = (await (await fetch(`${status.httpUrl}/health`)).json()) as any;
      expect(health.lan_urls).toEqual([]);
    } finally {
      await server.closeAll();
    }
  });

  test("LocalMiniServer exposes LAN IPv4 addresses when host=0.0.0.0", async () => {
    const server = new LocalMiniServer({
      port: 0,
      host: "0.0.0.0",
      dbPath: join(tempDir, "lan-test.db"),
    });
    const status = await server.start();
    try {
      expect(status.host).toBe("0.0.0.0");
      expect(status.httpUrl).toBe(`http://127.0.0.1:${status.port}`);
      expect(Array.isArray(status.lanUrls)).toBe(true);
      for (const u of status.lanUrls) {
        expect(u).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
        expect(u).not.toContain("127.0.0.1");
      }
      const health = (await (await fetch(`${status.httpUrl}/health`)).json()) as any;
      expect(health.lan_urls).toEqual(status.lanUrls);
    } finally {
      await server.closeAll();
    }
  });

  test("saveLocalAgentProfile persists valid 0600 profiles, blocks overwrites, traversal, reserved names, and symlinks", () => {
    const saved = GlobalIdentityAuthority.saveLocalAgentProfile({
      profileName: "Desktop_Bot-1",
      agentId: "desktop-bot-global-1",
      displayName: "Desktop Bot 1",
      token: "ac_live_global_secret_123",
      customHomeDir: tempDir,
    });
    expect(saved.profileName).toBe("Desktop_Bot-1");
    expect(saved.filePath.endsWith(join(".agentschat", "profiles", "Desktop_Bot-1.json"))).toBe(true);

    // Discovered cleanly right away
    const found = GlobalIdentityAuthority.discoverLocalAgentProfiles(tempDir);
    expect(found.length).toBe(1);
    expect(found[0]?.agent_id).toBe("desktop-bot-global-1");
    expect((found[0] as any).token).toBeUndefined();

    // Refuses overwrite of existing profile
    expect(() =>
      GlobalIdentityAuthority.saveLocalAgentProfile({
        profileName: "Desktop_Bot-1",
        agentId: "other-id",
        displayName: "Other",
        token: "ac_other",
        customHomeDir: tempDir,
      }),
    ).toThrow(/already exists/i);

    // Rejects path traversal & reserved internal prefix
    expect(() =>
      GlobalIdentityAuthority.saveLocalAgentProfile({
        profileName: "../evil",
        agentId: "evil-id",
        displayName: "Evil",
        token: "ac_123",
        customHomeDir: tempDir,
      }),
    ).toThrow();
    expect(() =>
      GlobalIdentityAuthority.saveLocalAgentProfile({
        profileName: "session-binds-hack",
        agentId: "evil-id",
        displayName: "Evil",
        token: "ac_123",
        customHomeDir: tempDir,
      }),
    ).toThrow(/reserved/i);

    // Refuses writing into symlinked / junctioned `.agentschat` directory
    const symHome = join(tempDir, "sym-home");
    const decoy = join(tempDir, "decoy-dir");
    mkdirSync(symHome, { recursive: true });
    mkdirSync(decoy, { recursive: true });
    symlinkSync(decoy, join(symHome, ".agentschat"), process.platform === "win32" ? "junction" : "dir");
    expect(() =>
      GlobalIdentityAuthority.saveLocalAgentProfile({
        profileName: "LegitBot",
        agentId: "legit-bot",
        displayName: "Legit",
        token: "ac_123",
        customHomeDir: symHome,
      }),
    ).toThrow(/symlink/i);
  });

  test("parseDeepLink safely routes agentschat:// links and blocks open redirects or traversal", () => {
    expect(parseDeepLink("agentschat://local")).toEqual({ workspace: "local" });
    expect(parseDeepLink("agentschat://local/my-group-1")).toEqual({
      workspace: "local",
      channelId: "my-group-1",
    });
    expect(parseDeepLink("agentschat://cloud/cloud-agents?tab=hosts")).toEqual({
      workspace: "cloud",
      path: "/cloud-agents?tab=hosts",
    });

    // Rejects non-agentschat schemes, embedded credentials, double slashes, traversal, and unknown hosts
    expect(parseDeepLink("https://agents-chat.com/welcome")).toBeNull();
    expect(parseDeepLink("agentschat://cloud//evil.com")).toBeNull();
    expect(parseDeepLink("agentschat://cloud/../../etc/passwd")).toBeNull();
    expect(parseDeepLink("agentschat://user:pass@cloud/login")).toBeNull();
    expect(parseDeepLink("agentschat://evil.com/phish")).toBeNull();
  });

  test("desktop update checker parses desktop-v* tags, compares semver, and ignores drafts/non-desktop tags", async () => {
    expect(parseDesktopReleaseTag("desktop-v0.2.1")).toBe("0.2.1");
    expect(parseDesktopReleaseTag("v0.36.31")).toBeNull();
    expect(compareSemver("0.2.0", "0.1.9")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "1.0.0")).toBe(-1);

    const mockFetch = (async () =>
      new Response(
        JSON.stringify([
          { tag_name: "v0.36.32", html_url: "https://github.com/swswordholy-tech/AgentsChat/releases/tag/v0.36.32" },
          { tag_name: "desktop-v0.3.0", draft: true, html_url: "https://github.com/swswordholy-tech/AgentsChat/releases/tag/desktop-v0.3.0" },
          { tag_name: "desktop-v0.2.0", html_url: "https://github.com/swswordholy-tech/AgentsChat/releases/tag/desktop-v0.2.0" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const up = await checkLatestDesktopRelease("0.1.0", mockFetch);
    expect(up.checked).toBe(true);
    expect(up.hasUpdate).toBe(true);
    expect(up.latestVersion).toBe("0.2.0");
    expect(up.releaseUrl).toBe("https://github.com/swswordholy-tech/AgentsChat/releases/tag/desktop-v0.2.0");

    const same = await checkLatestDesktopRelease("0.2.0", mockFetch);
    expect(same.hasUpdate).toBe(false);
  });

  test("parseUnreadCountFromTitle & clampDesktopZoomFactor sanitize Cloud badge counts and persisted zoom", () => {
    expect(parseUnreadCountFromTitle("(3) AgentsChat")).toBe(3);
    expect(parseUnreadCountFromTitle("(128) AgentChat")).toBe(128);
    expect(parseUnreadCountFromTitle("(2500) AgentsChat")).toBe(999);
    expect(parseUnreadCountFromTitle("(0) AgentsChat")).toBe(0);
    expect(parseUnreadCountFromTitle("AgentsChat")).toBe(0);
    expect(parseUnreadCountFromTitle("(-5) AgentsChat")).toBe(0);
    expect(parseUnreadCountFromTitle(null)).toBe(0);

    expect(clampDesktopZoomFactor(0.1)).toBe(0.75);
    expect(clampDesktopZoomFactor(1.2)).toBe(1.2);
    expect(clampDesktopZoomFactor(9.5)).toBe(1.75);
    expect(clampDesktopZoomFactor(Number.NaN)).toBe(1);

    const sanitized = sanitizeDesktopSettings({ zoomFactor: 1.35 });
    expect(sanitized.zoomFactor).toBe(1.35);
    expect(sanitizeDesktopSettings({ zoomFactor: 5 }).zoomFactor).toBe(1.75);
    expect(sanitizeDesktopSettings({}).zoomFactor).toBe(1);
  });

  test("local-chat UI keeps zero HTML-injection sinks and wires WeChat 4.0 sidebar, rich Markdown, and shortcuts parity", () => {
    const uiDir = join(import.meta.dir, "..", "ui");
    const js = readFileSync(join(uiDir, "local-chat.js"), "utf8");
    const html = readFileSync(join(uiDir, "local-chat.html"), "utf8");
    const css = readFileSync(join(uiDir, "local-chat.css"), "utf8");

    // Zero HTML injection sinks and valid JS syntax
    expect(js).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(js)).not.toThrow();

    // Sidebar filter pills, pinning, context menu, and unread divider
    expect(html).toContain('id="ch-filter-all"');
    expect(html).toContain('id="ch-filter-unread"');
    expect(js).toContain('ac_local_pinned_channels');
    expect(js).toContain('openChannelContextMenu');
    expect(js).toContain('localUnreadDivider');

    // Pure-DOM rich Markdown (tables + single-pass syntax highlighter + mention-me) & shortcuts cheatsheet
    expect(js).toContain('appendSyntaxHighlightedCode');
    expect(js).toContain('parseTableAlignments');
    expect(js).toContain('mention-me');
    expect(js).toContain('openLocalShortcutsCheatsheet');

    // Resizable sidebar split-pane, right-click message context menu, multiline editor & ArrowUp edit-last-message
    expect(html).toContain('id="local-sidebar-resizer"');
    expect(html).toContain('id="dialog-textarea"');
    expect(js).toContain('ac_local_sidebar_width');
    expect(js).toContain('openMessageContextMenu');
    expect(js).toContain('editLocalMessage');

    // Zero-FOUC theme init (strict external script for CSP script-src 'self'), in-channel search stepper, safe inline images & Lightbox 2.0
    const themeInitJs = readFileSync(join(uiDir, "local-theme-init.js"), "utf8");
    expect(() => new Function(themeInitJs)).not.toThrow();
    expect(html).toContain('<script src="/local-theme-init.js" data-ac-theme-init></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i);
    expect(html).toContain('id="search-match-count"');
    expect(html).toContain('id="btn-search-prev"');
    expect(html).toContain('id="btn-search-next"');
    expect(js).toContain('stepSearchMatch');
    expect(js).toContain('isSafeLocalImageUrl');
    expect(js).toContain('openLocalImageLightbox');
    expect(js).toContain('lbClampPan');

    // Local Hub 2.2: online-first member strip, cursor-aware @mention, bot @ID copy, channel race guard, mark-all-read & dialog backdrop close
    expect(js).toContain('channelLoadSeq');
    expect(js).toContain('insertTextAtCursor');
    expect(js).toContain('markAllLocalChannelsRead');
    expect(js).toContain('bindDialogBackdropClose');
    expect(js).toContain('member-online-summary');
    expect(js).toContain('bot-id copyable');
    expect(js).toContain('dialog[open]');

    expect(css).toContain('.ac-table-wrap');
    expect(css).toContain('.unread-divider');
    expect(css).toContain('.local-ctx-menu');
    expect(css).toContain('.local-kbd-card');
    expect(css).toContain('.mention-chip.mention-me');
    expect(css).toContain('.local-sidebar-resizer');
    expect(css).toContain('mark.search-hit.current');
    expect(css).toContain('.wx-inline-img');
    expect(css).toContain('.local-lb-backdrop');
    expect(css).toContain('.member-online-summary');
    expect(css).toContain('.bot-id.copyable');
  });

  test("Desktop Command Rail 2.0 allowlists Cloud quick routes, classifies active sections, and wires shell rail controls", () => {
    const remote = "https://agents-chat.com/lobby";
    expect(resolveCloudQuickRoute("lobby", remote)).toBe("https://agents-chat.com/lobby");
    expect(resolveCloudQuickRoute("cloud-agents", remote)).toBe("https://agents-chat.com/cloud-agents");
    expect(resolveCloudQuickRoute("okr-board", remote)).toBe("https://agents-chat.com/okr-board");
    expect(resolveCloudQuickRoute("marketplace", remote)).toBe("https://agents-chat.com/marketplace");
    expect(resolveCloudQuickRoute("dashboard", remote)).toBe("https://agents-chat.com/dashboard");
    // Rejects arbitrary paths, prototype keys, and non-http(s) remote URLs
    expect(resolveCloudQuickRoute("https://evil.com", remote)).toBeNull();
    expect(resolveCloudQuickRoute("__proto__", remote)).toBeNull();
    expect(resolveCloudQuickRoute("constructor", remote)).toBeNull();
    expect(resolveCloudQuickRoute("lobby", "javascript:alert(1)")).toBeNull();

    expect(classifyCloudRailSection("https://agents-chat.com/cloud-agents", remote)).toBe("cloud-agents");
    expect(classifyCloudRailSection("https://agents-chat.com/okr-board", remote)).toBe("okr-board");
    expect(classifyCloudRailSection("https://agents-chat.com/okr.html", remote)).toBe("okr-board");
    expect(classifyCloudRailSection("https://agents-chat.com/marketplace", remote)).toBe("marketplace");
    expect(classifyCloudRailSection("https://agents-chat.com/lobby", remote)).toBe("lobby");
    expect(classifyCloudRailSection("https://agents-chat.com/chat/demo-bot", remote)).toBe("lobby");
    expect(classifyCloudRailSection("https://evil.example/cloud-agents", remote)).toBe("lobby");

    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    expect(shellHtml).toContain('id="btn-cloud-studio"');
    expect(shellHtml).toContain('id="btn-cloud-okr"');
    expect(shellHtml).toContain('id="btn-cloud-market"');
    expect(shellHtml).toContain('id="btn-cloud-back"');
    expect(shellHtml).toContain('id="btn-cloud-forward"');
    expect(shellHtml).toContain('id="rail-load-bar"');
    expect(shellHtml).toContain('id="btn-brand-home"');
    expect(shellHtml).toContain('navigateCloudRoute');
    expect(shellHtml).toContain('cloudHistory');
  });

  test("Desktop 2.1 two-way theme sync validates origins, handles cloud-offline, preserves SVG buttons, and keeps cloud-preload zero-privilege", () => {
    const remote = "https://agents-chat.com/lobby";
    expect(isTrustedCloudThemeOrigin("https://agents-chat.com/okr-board", remote)).toBe(true);
    expect(isTrustedCloudThemeOrigin("https://agents-chat.com/chat/bot-1?x=1", remote)).toBe(true);
    expect(isTrustedCloudThemeOrigin("https://evil.example/lobby", remote)).toBe(false);
    expect(isTrustedCloudThemeOrigin("file:///tmp/cloud-offline.html", remote)).toBe(false);
    expect(isTrustedCloudThemeOrigin("javascript:alert(1)", remote)).toBe(false);

    expect(isCloudOfflinePageUrl("file:///Applications/AgentsChat.app/ui/cloud-offline.html?reason=ERR")).toBe(true);
    expect(isCloudOfflinePageUrl("https://agents-chat.com/cloud-offline.html")).toBe(false);
    expect(isCloudOfflinePageUrl("file:///tmp/evil.html")).toBe(false);

    expect(CLOUD_THEME_TOGGLE_SELECTOR).toContain(".theme-toggle:not(#shortcutsBtn)");
    expect(CLOUD_THEME_TOGGLE_SELECTOR).toContain("#analyticsThemeToggle");
    expect(CLOUD_THEME_TOGGLE_SELECTOR).toContain("#approvalsThemeToggle");

    // Execute generated cloud sync script against a synthetic DOM containing an SVG shortcuts button + real theme toggles
    const htmlClasses = new Set<string>();
    const bodyClasses = new Set<string>();
    const dataset: Record<string, string> = {};
    const htmlStyle: Record<string, string> = {};
    const store = new Map<string, string>();
    const svgShortcutsBtn = {
      id: "shortcutsBtn",
      textContent: "KEEP_SVG",
      querySelector: (sel: string) => (sel === "svg" ? {} : null),
    };
    const realThemeBtn = {
      id: "themeToggleBtn",
      textContent: "🌙",
      querySelector: () => null,
    };
    const analyticsThemeBtn = {
      id: "analyticsThemeToggle",
      textContent: "🌙",
      querySelector: () => null,
    };
    const fakeDocument = {
      documentElement: {
        dataset,
        style: htmlStyle,
        classList: {
          toggle: (cls: string, force?: boolean) => (force ? htmlClasses.add(cls) : htmlClasses.delete(cls)),
        },
      },
      body: {
        classList: {
          toggle: (cls: string, force?: boolean) => (force ? bodyClasses.add(cls) : bodyClasses.delete(cls)),
        },
      },
      querySelectorAll: () => [svgShortcutsBtn, realThemeBtn, analyticsThemeBtn],
    };
    const fakeLocalStorage = {
      setItem: (k: string, v: string) => store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
    };
    const scheduled: Array<() => void> = [];
    const fakeSetTimeout = (fn: () => void) => {
      scheduled.push(fn);
      return 1;
    };

    const runCloudSync = new Function(
      "document",
      "localStorage",
      "setTimeout",
      buildCloudThemeSyncScript("light"),
    );
    runCloudSync(fakeDocument, fakeLocalStorage, fakeSetTimeout);

    expect(store.get("ac_theme")).toBe("light");
    expect(htmlClasses.has("light")).toBe(true);
    expect(bodyClasses.has("light")).toBe(true);
    expect(htmlStyle.colorScheme).toBe("light");
    expect(dataset.acDesktopThemeReady).toBe("1");
    expect(dataset.acDesktopSyncing).toBe("1");
    // SVG icon button must NEVER be overwritten; real theme toggles must update
    expect(svgShortcutsBtn.textContent).toBe("KEEP_SVG");
    expect(realThemeBtn.textContent).toBe("☀️");
    expect(analyticsThemeBtn.textContent).toBe("☀️");
    // Flushing scheduled micro-timer clears syncing flag so subsequent user clicks sync back to Desktop
    scheduled.forEach((fn) => fn());
    expect(dataset.acDesktopSyncing).toBeUndefined();

    // Verify offline page sync script toggles body.dark
    const offlineBodyClasses = new Set<string>();
    const offlineDoc = {
      documentElement: { style: {} as Record<string, string> },
      body: {
        classList: {
          toggle: (cls: string, force?: boolean) => (force ? offlineBodyClasses.add(cls) : offlineBodyClasses.delete(cls)),
        },
      },
    };
    new Function("document", buildOfflineThemeSyncScript("dark"))(offlineDoc);
    expect(offlineBodyClasses.has("dark")).toBe(true);
    new Function("document", buildOfflineThemeSyncScript("light"))(offlineDoc);
    expect(offlineBodyClasses.has("dark")).toBe(false);

    // Zero-privilege security invariant on cloud-preload.cjs
    const cloudPreload = readFileSync(join(import.meta.dir, "..", "ui", "cloud-preload.cjs"), "utf8");
    const cloudPreloadCode = cloudPreload.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(() => new Function("require", cloudPreload)).not.toThrow();
    expect(cloudPreloadCode).not.toContain("contextBridge");
    expect(cloudPreloadCode).not.toContain("exposeInMainWorld");
    expect(cloudPreloadCode).toContain("desktop:cloud-theme-observed");
  });

  test("Desktop 2.3 rail wires zoom reset chip, active reload, context-aware copy URL & safe same-origin link helpers", () => {
    const remote = "https://agents-chat.com/lobby";
    expect(formatCopyableCloudUrl("https://agents-chat.com/lobby?channel=abc", remote)).toBe(
      "https://agents-chat.com/lobby?channel=abc",
    );
    expect(formatCopyableCloudUrl("https://user:pass@agents-chat.com/marketplace?bot=codex", remote)).toBe(
      "https://agents-chat.com/marketplace?bot=codex",
    );
    expect(formatCopyableCloudUrl("file:///Users/test/cloud-offline.html", remote)).toBeNull();
    expect(formatCopyableCloudUrl("https://evil.example/phish", remote)).toBeNull();
    expect(formatCopyableCloudUrl("javascript:alert(1)", remote)).toBeNull();
    expect(formatCopyableCloudUrl("", remote)).toBeNull();

    expect(formatZoomBadge(1)).toBeNull();
    expect(formatZoomBadge(1.001)).toBeNull();
    expect(formatZoomBadge(1.1)).toBe("110%");
    expect(formatZoomBadge(0.85)).toBe("85%");
    expect(formatZoomBadge(5)).toBe("175%");
    expect(formatZoomBadge(0.2)).toBe("75%");

    expect(CLOUD_THEME_TOGGLE_SELECTOR).toContain("#modThemeToggle");

    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    expect(shellHtml).toContain('id="btn-zoom-reset"');
    expect(shellHtml).toContain('id="btn-active-reload"');
    expect(shellHtml).toContain("copyCurrentCloudUrl");
    expect(shellHtml).toContain("resetZoom");
    expect(shellHtml).toContain("reloadActiveView");

    const preloadJs = readFileSync(join(import.meta.dir, "..", "ui", "preload.cjs"), "utf8");
    expect(preloadJs).toContain("desktop:reload-active");
    expect(preloadJs).toContain("desktop:reset-zoom");
    expect(preloadJs).toContain("desktop:copy-cloud-url");

    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("CmdOrCtrl+6");
    expect(mainTs).toContain("CmdOrCtrl+Shift+C");
    expect(mainTs).toContain("CmdOrCtrl+Shift+O");
    expect(mainTs).toContain("Copy Page Link");
    expect(mainTs).toContain("Open Page in Browser");
  });

  test("Desktop 2.4 adds live tray tooltip & quick jumps, smart offline auto-reconnect, Local Hub confirmations, drag-safe backdrop close & T shortcut", () => {
    const remote = "https://agents-chat.com/lobby";
    expect(resolveOfflineRetryUrl("https://agents-chat.com/cloud-agents?tab=billing", remote)).toBe(
      "https://agents-chat.com/cloud-agents?tab=billing",
    );
    expect(resolveOfflineRetryUrl("https://u:p@agents-chat.com/okr-board", remote)).toBe(
      "https://agents-chat.com/okr-board",
    );
    expect(resolveOfflineRetryUrl("https://evil.example/steal", remote)).toBe(remote);
    expect(resolveOfflineRetryUrl("file:///tmp/cloud-offline.html", remote)).toBe(remote);
    expect(resolveOfflineRetryUrl(null, remote)).toBe(remote);

    expect(
      formatTrayTooltip({ cloudUnread: 2, localUnread: 3, localRunning: true, localPort: 8787, localOnlineCount: 4 }),
    ).toBe("AgentsChat Desktop (5 unread) · Local :8787 (4 online)");
    expect(
      formatTrayTooltip({ cloudUnread: 0, localUnread: 0, localRunning: true, localPort: 9001, localOnlineCount: 0 }),
    ).toBe("AgentsChat Desktop · Local :9001");
    expect(
      formatTrayTooltip({ cloudUnread: -2, localUnread: Number.NaN, localRunning: false }),
    ).toBe("AgentsChat Desktop · Local Stopped");

    const offlineHtml = readFileSync(join(import.meta.dir, "..", "ui", "cloud-offline.html"), "utf8");
    const offlineScript = offlineHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(offlineScript.length).toBeGreaterThan(0);
    expect(() => new Function(offlineScript)).not.toThrow();
    expect(offlineHtml).toContain('window.addEventListener("online"');
    expect(offlineHtml).toContain('id="btn-toggle-auto"');
    expect(offlineHtml).toContain("agentschat-action://retry-cloud");

    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain("function openConfirmDialog(");
    expect(localJs).toContain('title: "撤回这条消息？"');
    expect(localJs).toContain('title: `退出群聊 ${roomLabel}？`');
    expect(localJs).toContain("if (downTarget && downTarget !== dlg) return;");
    expect(localJs).toContain("function triggerManualWsReconnect()");
    expect(localJs).toContain('insertTextAtCursor(elInput, "@")');
    expect(localJs).toContain('ev.key === "t" || ev.key === "T"');
    expect(localJs).toContain('["切换浅色 / 深色模式", ["T"]]');

    const localHtml = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.html"), "utf8");
    expect(localHtml).toContain('title="切换浅色 / 深色模式 (T)"');

    const localCss = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.css"), "utf8");
    expect(localCss).toContain(".ws-pill.clickable");
    expect(localCss).toContain(".btn-danger");

    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("tray.setToolTip(");
    expect(mainTs).toContain("formatTrayTooltip(");
    expect(mainTs).toContain("Copy Local MCP Command");
    expect(mainTs).toContain("resolveOfflineRetryUrl(");
  });

  test("Desktop 2.5 adds Notification channel routing, Local Hub auto-resizing composer, live bot presence, channel-switch skeleton, live search clear & reduced motion", () => {
    expect(buildLocalChannelUrl("http://127.0.0.1:8787", "dev-room")).toBe("http://127.0.0.1:8787/#channel=dev-room");
    expect(buildLocalChannelUrl("http://localhost:9001/foo?x=1", "dm-alpha_1.2")).toBe(
      "http://localhost:9001/#channel=dm-alpha_1.2",
    );
    // Rejects non-loopback, https, embedded credentials, traversal, or malformed channel IDs
    expect(buildLocalChannelUrl("https://127.0.0.1:8787", "welcome")).toBeNull();
    expect(buildLocalChannelUrl("http://evil.example:8787", "welcome")).toBeNull();
    expect(buildLocalChannelUrl("http://user:pass@127.0.0.1:8787", "welcome")).toBeNull();
    expect(buildLocalChannelUrl("http://127.0.0.1:8787", "../etc")).toBeNull();
    expect(buildLocalChannelUrl("http://127.0.0.1:8787", "bad/channel")).toBeNull();
    expect(buildLocalChannelUrl("http://127.0.0.1:8787", "")).toBeNull();
    expect(buildLocalChannelUrl("http://127.0.0.1:8787", null)).toBeNull();

    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("buildLocalChannelUrl(");
    expect(mainTs).toContain("void openLocalChannel(msg.channel_id);");
    expect(mainTs).toContain("await openLocalChannel(parsed.channelId);");

    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain("function autoResizeLocalInput()");
    expect(localJs).toContain("function syncComposerState()");
    expect(localJs).toContain("function renderMessagesSkeleton()");
    expect(localJs).toContain("function updateDiscoveredBotPresence(");
    expect(localJs).toContain("function renderBotCountBadge()");
    expect(localJs).toContain("res.data?.known_principals");
    expect(localJs).toContain("window.history.replaceState(null, \"\", nextHash)");
    expect(localJs).toContain('if (activeSearchQuery && !elSearchInput.value.trim())');
    expect(localJs).toContain('["聚焦消息输入框", [mod, "/"]]');

    const localHtml = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.html"), "utf8");
    expect(localHtml).toContain('id="bot-count-badge"');
    expect(localHtml).toContain('id="btn-send" disabled');

    const localCss = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.css"), "utf8");
    expect(localCss).toContain(".bot-online-dot");
    expect(localCss).toContain(".section-count.has-online");
    expect(localCss).toContain(".msg-skeleton-list");
    expect(localCss).toContain(".btn-send:disabled");
    expect(localCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("Desktop 2.6 adds live contextual window title, tray tooltip parity, auto-focus on switch, compact low-height rail & cross-platform shortcuts", () => {
    expect(
      formatDesktopWindowTitle({ activeWorkspace: "cloud", cloudSection: "lobby", cloudUnread: 0, localUnread: 0 }),
    ).toBe("AgentsChat");
    expect(
      formatDesktopWindowTitle({ activeWorkspace: "cloud", cloudSection: "cloud-agents", cloudUnread: 2, localUnread: 1 }),
    ).toBe("(3) AgentsChat · Cloud Studio");
    expect(
      formatDesktopWindowTitle({ activeWorkspace: "cloud", cloudSection: "okr-board", cloudUnread: 0, localUnread: 0 }),
    ).toBe("AgentsChat · OKR Board");
    expect(
      formatDesktopWindowTitle({ activeWorkspace: "cloud", cloudSection: "marketplace", cloudUnread: 0, localUnread: 0 }),
    ).toBe("AgentsChat · Bot Market");
    expect(
      formatDesktopWindowTitle({ activeWorkspace: "cloud", cloudSection: "dashboard", cloudUnread: 1, localUnread: 0 }),
    ).toBe("(1) AgentsChat · Dashboard");
    expect(
      formatDesktopWindowTitle({ activeWorkspace: "local", localRunning: true, localPort: 8787, cloudUnread: 0, localUnread: 0 }),
    ).toBe("AgentsChat · Local :8787");
    expect(
      formatDesktopWindowTitle({ activeWorkspace: "local", localRunning: false, cloudUnread: 4, localUnread: 0 }),
    ).toBe("(4) AgentsChat · Local");

    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(shellScript.length).toBeGreaterThan(0);
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain("@media (max-height: 670px)");
    expect(shellHtml).toContain("function applyPlatformShortcuts(platform)");
    expect(shellHtml).toContain("btnShellScreenshot.hidden = !isMac;");
    expect(shellHtml).toContain("openCurrentCloudInBrowser");

    const preloadJs = readFileSync(join(import.meta.dir, "..", "ui", "preload.cjs"), "utf8");
    expect(preloadJs).toContain("desktop:open-cloud-browser");

    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("formatDesktopWindowTitle(");
    expect(mainTs).toContain("activeView.webContents.focus()");
    expect(mainTs).toContain("Dashboard (⌘6)");
    expect(mainTs).toContain("desktop:open-cloud-browser");
  });

  test("Desktop 2.7 adds persistent Always-on-Top pin, lossless Local Hub send with retry-restore, IME/Cancel/focus dialog guards, drag-safe overlays, platform shortcuts & Alt+Shift unread jump", () => {
    // 1. Settings sanitization & persistence for alwaysOnTop
    expect(DEFAULT_DESKTOP_SETTINGS.alwaysOnTop).toBe(false);
    expect(sanitizeDesktopSettings({}).alwaysOnTop).toBe(false);
    expect(sanitizeDesktopSettings({ alwaysOnTop: true }).alwaysOnTop).toBe(true);
    expect(sanitizeDesktopSettings({ alwaysOnTop: "yes" as any }).alwaysOnTop).toBe(false);
    const store = new DesktopSettingsStore(join(tempDir, "settings-pin.json"));
    expect(store.load().alwaysOnTop).toBe(false);
    expect(store.save({ alwaysOnTop: true }).alwaysOnTop).toBe(true);
    expect(store.load().alwaysOnTop).toBe(true);

    // 2. Shell, preload & main process Always-on-Top wiring + strict shell-only IPC check
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("function applyAlwaysOnTop(enabled: boolean)");
    expect(mainTs).toContain('setAlwaysOnTop(true, "floating")');
    expect(mainTs).toContain('accelerator: "CmdOrCtrl+Shift+T"');
    expect(mainTs).toContain('label: "Keep Window on Top"');
    expect(mainTs).toContain('ipcMain.handle("desktop:set-always-on-top"');

    const preloadJs = readFileSync(join(import.meta.dir, "..", "ui", "preload.cjs"), "utf8");
    expect(preloadJs).toContain('setAlwaysOnTop: (enabled) => ipcRenderer.invoke("desktop:set-always-on-top"');

    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain('id="btn-shell-pin"');
    expect(shellHtml).toContain(".mini-btn.pinned");
    expect(shellHtml).toContain("api?.setAlwaysOnTop?.(next)");
    expect(shellHtml).toContain("取消窗口置顶");

    // 3. Local Hub lossless messaging, IME/Cancel/Focus dialogs, drag-safe overlays, platform shortcuts & Alt+Shift unread jump
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain("let isSendingChat = false;");
    expect(localJs).toContain("if (isSendingChat) return;");
    expect(localJs).toContain("const restoreFailedDraft = () =>");
    expect(localJs).toContain("saveLocalDraft(targetChannel, text);");
    expect(localJs).toContain("if (savedReply && !replyTarget) setReplyTarget(savedReply);");
    expect(localJs).toContain("(ev.metaKey || ev.ctrlKey) && !isImeComposing(ev)");
    expect(localJs).toContain("document.activeElement === cancelBtn");
    expect(localJs).toContain("if (ev.target === switcherBg && (!downTarget || downTarget === switcherBg))");
    expect(localJs).toContain("if (ev.target === kbdBg && (!downTarget || downTarget === kbdBg))");
    expect(localJs).toContain("function applyLocalPlatformShortcuts()");
    expect(localJs).toContain("当前没有未读会话");
    expect(localJs).toContain("切换窗口置顶");
  });

  test("Desktop 2.8 adds persistent Do-Not-Disturb notification mute, Local Hub Markdown links/headings/blockquotes/rules, interactive @chips, sender @ID copy & Cmd+B/I/E formatting", () => {
    // 1. Settings persistence & sanitization for notificationsMuted + Tray tooltip Muted state
    expect(DEFAULT_DESKTOP_SETTINGS.notificationsMuted).toBe(false);
    expect(sanitizeDesktopSettings({}).notificationsMuted).toBe(false);
    expect(sanitizeDesktopSettings({ notificationsMuted: true }).notificationsMuted).toBe(true);
    expect(sanitizeDesktopSettings({ notificationsMuted: 1 as any }).notificationsMuted).toBe(false);
    const store = new DesktopSettingsStore(join(tempDir, "settings-mute.json"));
    expect(store.load().notificationsMuted).toBe(false);
    expect(store.save({ notificationsMuted: true }).notificationsMuted).toBe(true);
    expect(store.load().notificationsMuted).toBe(true);

    expect(
      formatTrayTooltip({ localRunning: true, localPort: 8787, localOnlineCount: 2, notificationsMuted: true }),
    ).toBe("AgentsChat Desktop · Local :8787 (2 online) · Muted");
    expect(
      formatTrayTooltip({ localRunning: false, cloudUnread: 3, notificationsMuted: true }),
    ).toBe("AgentsChat Desktop (3 unread) · Local Stopped · Muted");

    // 2. Main process, preload & shell rail Do-Not-Disturb mute wiring
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("function applyNotificationsMuted(muted: boolean)");
    expect(mainTs).toContain("if (settings.notificationsMuted !== true && Notification.isSupported())");
    expect(mainTs).toContain('accelerator: "CmdOrCtrl+Shift+M"');
    expect(mainTs).toContain('label: "Mute Local Notifications"');
    expect(mainTs).toContain('ipcMain.handle("desktop:set-notifications-muted"');

    const preloadJs = readFileSync(join(import.meta.dir, "..", "ui", "preload.cjs"), "utf8");
    expect(preloadJs).toContain('setNotificationsMuted: (muted) => ipcRenderer.invoke("desktop:set-notifications-muted"');

    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain('id="btn-shell-mute"');
    expect(shellHtml).toContain(".mini-btn.muted");
    expect(shellHtml).toContain("api?.setNotificationsMuted?.(next)");
    expect(shellHtml).toContain("恢复本机通知提醒");

    // 3. Local Hub safe Markdown links, headings/blockquotes/hr, interactive @mention & sender @id copy, avatar syncComposerState & Cmd+B/I/E
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain("\\[([^\\]\\n]{1,120})\\]\\((https?:\\/\\/[^)\\s\\n]+)\\)");
    expect(localJs).toContain("wx-md-heading");
    expect(localJs).toContain("wx-md-quote");
    expect(localJs).toContain("wx-md-hr");
    expect(localJs).toContain("mention-chip clickable");
    expect(localJs).toContain("wx-sender-id clickable");
    expect(localJs).toContain('if (k === "b" || k === "i" || k === "e")');
    expect(localJs).toContain("静音 / 恢复桌面通知");

    const localCss = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.css"), "utf8");
    expect(localCss).toContain(".wx-md-quote");
    expect(localCss).toContain(".wx-md-heading");
    expect(localCss).toContain(".wx-sender-id.clickable:hover");
  });

  test("Desktop 2.9 fixes Alt+Shift unread jump crash, hardens Lightbox pan/Esc/focus, adds IME/dialog/tablist/context-menu a11y, offline diag copy & Reset Window Size & Center", () => {
    // 1. Pure centered window geometry helper (standard, small display, secondary monitor offset)
    expect(computeCenteredWindowBounds({ x: 0, y: 25, width: 1920, height: 1055 })).toEqual({
      x: 300,
      y: 123,
      width: 1320,
      height: 860,
    });
    // Small 1280x720 display clamps cleanly without overflowing workArea
    expect(computeCenteredWindowBounds({ x: 0, y: 0, width: 1280, height: 720 })).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
    // Secondary display at negative X offset centers inside that display
    expect(computeCenteredWindowBounds({ x: -1920, y: 0, width: 1920, height: 1080 })).toEqual({
      x: -1620,
      y: 110,
      width: 1320,
      height: 860,
    });

    // 2. Main process: Reset Window Size & Center, macOS-gated screenshot shortcut/tray/menu, cross-platform tray hints, silent DND screenshot notice
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("function resetWindowSizeAndCenter(): boolean");
    expect(mainTs).toContain('label: "Reset Window Size & Center"');
    expect(mainTs).toContain('accelerator: "CmdOrCtrl+Shift+0"');
    expect(mainTs).toContain('isMac ? "  Dashboard (⌘6)" : "  Dashboard (Ctrl+6)"');
    expect(mainTs).toContain('if (process.platform === "darwin")');
    expect(mainTs).toContain("silent: settings.notificationsMuted === true");

    // 3. Offline fallback page: 1-click diagnostic copy, double-click-safe triggerRetry, P pause shortcut & focus-visible styles
    const offlineHtml = readFileSync(join(import.meta.dir, "..", "ui", "cloud-offline.html"), "utf8");
    const offlineScript = offlineHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(offlineScript)).not.toThrow();
    expect(offlineHtml).toContain('id="btn-copy-diag"');
    expect(offlineHtml).toContain("async function copyDiagnosticText()");
    expect(offlineHtml).toContain("function toggleAutoRetry()");
    expect(offlineHtml).toContain('retryLink.classList.add("retrying")');
    expect(offlineHtml).toContain('else if (ev.key === "p" || ev.key === "P")');

    // 4. Local Hub: no unreadCounts crash, pinned-first Alt+Up/Down & Alt+Shift+Up/Down, capture-phase Lightbox + pan guard + focus restore, IME guards, accessible dialogs/tablist/context-menu
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).not.toContain("unreadCounts");
    expect(localJs).toContain("function getOrderedChannels()");
    expect(localJs).toContain("unreadByChannel.get(candidate.id)");
    expect(localJs).toContain("function isImeComposing(ev)");
    expect(localJs).toContain("function openNativeDialog(dlg)");
    expect(localJs).toContain("function mountContextMenu(menu, clientX, clientY)");
    expect(localJs).toContain("function selectHarnessTab(btn, shouldFocus = false)");
    expect(localJs).toContain("function flashCopyButton(btn, defaultLabel)");
    expect(localJs).toContain("localLbState.stageDownTarget");
    expect(localJs).toContain("localLbState.justDragged");
    expect(localJs).toContain("localLbState.prevFocus");
    expect(localJs).toContain("!Number.isInteger(port) || port < 1024 || port > 65535");
    expect(localJs).toContain("重置窗口大小并居中");

    const localHtml = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.html"), "utf8");
    expect(localHtml).toContain('data-harness="claude" role="tab" aria-selected="true" tabindex="0"');
    expect(localHtml).toContain('data-harness="codex" role="tab" aria-selected="false" tabindex="-1"');

    const localCss = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.css"), "utf8");
    expect(localCss).toContain(".tab-btn:focus-visible");
    expect(localCss).toContain(".local-ctx-item:focus-visible:not(:disabled)");
    expect(localCss).toContain(".local-lb-close:focus-visible");
  });

  test("Desktop 2.10 adds graceful local-stopped recovery view, renderer crash recovery, native download reveal & spellcheck, rail power lock, Markdown lists/checklists/strikethrough & resilient api()", () => {
    // 1. Pure helpers: isLocalStoppedPageUrl & formatDownloadCompleteNotice
    expect(isLocalStoppedPageUrl("file:///Applications/AgentsChat.app/ui/local-stopped.html?theme=dark&port=8787")).toBe(true);
    expect(isLocalStoppedPageUrl("http://127.0.0.1:8787/local-stopped.html")).toBe(false);
    expect(isLocalStoppedPageUrl("file:///tmp/other.html")).toBe(false);
    expect(isLocalStoppedPageUrl(null)).toBe(false);

    expect(formatDownloadCompleteNotice("/Users/test/Downloads/agentschat-welcome-2026.md")).toEqual({
      title: "文件已保存",
      body: "agentschat-welcome-2026.md · 点击在访达 / 文件夹中显示",
    });
    expect(formatDownloadCompleteNotice("evil\n\rname.png").body).toContain("evil  name.png");
    expect(formatDownloadCompleteNotice("").body).toContain("文件");

    // 2. local-stopped.html: valid script, CSP, Light/Dark & keyboard shortcuts
    const stoppedHtml = readFileSync(join(import.meta.dir, "..", "ui", "local-stopped.html"), "utf8");
    const stoppedScript = stoppedHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(stoppedScript.length).toBeGreaterThan(0);
    expect(() => new Function(stoppedScript)).not.toThrow();
    expect(stoppedHtml).toContain("agentschat-action://start-local");
    expect(stoppedHtml).toContain("agentschat-action://switch-cloud");
    expect(stoppedHtml).toContain("@media (prefers-reduced-motion: reduce)");

    // 3. Main process: local-stopped routing, theme sync, renderer crash recovery, download completion reveal & spellcheck
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("function attachDownloadFeedback(wc: Electron.WebContents)");
    expect(mainTs).toContain("shell.showItemInFolder(savePath)");
    expect(mainTs).toContain("wc.replaceMisspelling(suggestion)");
    expect(mainTs).toContain("async function loadLocalStoppedPage()");
    expect(mainTs).toContain("function syncThemeToLocalView(");
    expect(mainTs).toContain('agentschat-action://start-local');
    expect(mainTs).toContain('cloudView.webContents.on("render-process-gone"');
    expect(mainTs).toContain('localView.webContents.on("render-process-gone"');

    // 4. Shell rail power toggle lock
    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain("let powerToggling = false;");

    // 5. Local Hub: resilient api(), pure-DOM lists/checklists/strikethrough, timestamp tooltips & refresh bots feedback
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain("networkError: true");
    expect(localJs).toContain("wx-md-del");
    expect(localJs).toContain("wx-md-checklist");
    expect(localJs).toContain("wx-md-ol");
    expect(localJs).toContain("function formatFullLocalTimestamp(iso)");
    expect(localJs).toContain("wx-sender-time");
    expect(localJs).toContain('btnRefreshBots.classList.add("spinning")');

    const localCss = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.css"), "utf8");
    expect(localCss).toContain(".wx-md-list");
    expect(localCss).toContain(".wx-md-check-box.done");
    expect(localCss).toContain(".wx-sender-time");
    expect(localCss).toContain(".micro-btn.spinning svg");
  });

  test("Desktop 2.11 adds OS download progress bar, workspace-aware Cmd+Shift+C, offline-safe screenshot guard, App Menu server/LAN toggles, rail ARIA/spin polish & Local @mention 2.0", () => {
    // 1. Pure helpers: computeDownloadProgress, formatLocalMcpCommand & resolveWorkspaceCopyAction
    expect(computeDownloadProgress(50, 100)).toBe(0.5);
    expect(computeDownloadProgress(150, 100)).toBe(1);
    expect(computeDownloadProgress(0, 100)).toBe(0);
    expect(computeDownloadProgress(2048, 0)).toBe(2); // indeterminate progress when total unknown
    expect(computeDownloadProgress(0, 0)).toBe(-1);
    expect(computeDownloadProgress(-10, 100)).toBe(-1);
    expect(computeDownloadProgress(Number.NaN, 100)).toBe(-1);

    expect(formatLocalMcpCommand("http://127.0.0.1:9191/welcome")).toBe(
      "npx -y agentschat-mcp@latest --url http://127.0.0.1:9191",
    );
    expect(formatLocalMcpCommand("http://user:pass@127.0.0.1:8787")).toBe(
      "npx -y agentschat-mcp@latest --url http://127.0.0.1:8787",
    );
    expect(formatLocalMcpCommand("javascript:alert(1)")).toBe(
      "npx -y agentschat-mcp@latest --url http://127.0.0.1:8787",
    );
    expect(formatLocalMcpCommand("")).toBe(
      "npx -y agentschat-mcp@latest --url http://127.0.0.1:8787",
    );

    const cloudCopy = resolveWorkspaceCopyAction({
      activeWorkspace: "cloud",
      cloudUrl: "https://agents-chat.com/cloud-agents?tab=fleet",
      remoteServerUrl: "https://agents-chat.com",
      localHttpUrl: "http://127.0.0.1:8787",
      localRunning: true,
    });
    expect(cloudCopy).toEqual({
      kind: "cloud-url",
      text: "https://agents-chat.com/cloud-agents?tab=fleet",
      title: "已复制当前页面链接",
    });

    const localCopy = resolveWorkspaceCopyAction({
      activeWorkspace: "local",
      cloudUrl: "https://agents-chat.com/lobby",
      remoteServerUrl: "https://agents-chat.com",
      localHttpUrl: "http://127.0.0.1:9911",
      localRunning: true,
    });
    expect(localCopy).toEqual({
      kind: "local-mcp",
      text: "npx -y agentschat-mcp@latest --url http://127.0.0.1:9911",
      title: "已复制本机 MCP 接入命令",
    });

    expect(
      resolveWorkspaceCopyAction({
        activeWorkspace: "local",
        cloudUrl: "https://agents-chat.com/lobby",
        remoteServerUrl: "https://agents-chat.com",
        localHttpUrl: "http://127.0.0.1:8787",
        localRunning: false,
      }),
    ).toBeNull();

    // 2. Main process wiring: download progress bar, workspace-aware copy, offline-safe screenshot & App Menu parity
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("function copyActiveWorkspaceLinkOrCommand(notify = true)");
    expect(mainTs).toContain("mainWindow.setProgressBar(progress)");
    expect(mainTs).toContain("mainWindow.setProgressBar(-1)");
    expect(mainTs).toContain("!isCloudOfflinePageUrl(cloudView.webContents.getURL())");
    expect(mainTs).toContain('label: "Local Mini-Server Running"');
    expect(mainTs).toContain('accelerator: "CmdOrCtrl+Shift+L"');

    // 3. Shell rail: aria-pressed on power button, local reload spin pulse & aria-busy
    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain('btnPower.setAttribute("aria-pressed", String(running));');
    expect(shellHtml).toContain('btnActiveReload.setAttribute("aria-busy"');
    expect(shellHtml).toContain("localReloadSpinning = true;");

    // 4. Local Hub: @mention 2.0 (CJK/Unicode regex, online-first sort, ARIA listbox/combobox, Home/End, hover/scroll sync), global Esc reply cancel, Alt+Enter guard & keyboard quote jump
    const localHtml = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.html"), "utf8");
    expect(localHtml).toContain('id="mention-menu" role="listbox"');
    expect(localHtml).toContain('aria-autocomplete="list" aria-controls="mention-menu" aria-expanded="false"');
    expect(localHtml).toContain('id="btn-quick-mention" title="插入 @ 提及本机 Agent" aria-label="插入 @ 提及本机 Agent"');

    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain("function syncMentionActiveVisual(scrollIntoView = false)");
    expect(localJs).toContain("/(^|\\s)@([^\\s@]{0,40})$/");
    expect(localJs).toContain('opt.setAttribute("role", "option")');
    expect(localJs).toContain('elInput.setAttribute("aria-activedescendant", activeOpt.id)');
    expect(localJs).toContain('if (ev.key === "Home")');
    expect(localJs).toContain('if (ev.key === "End")');
    expect(localJs).toContain('if (ev.key === "Enter" && !ev.shiftKey && !ev.altKey && !isImeComposing(ev))');
    expect(localJs).toContain('quoteEl.setAttribute("role", "button")');
    expect(localJs).toContain("if (ev.key === \"Escape\" && replyTarget)");

    const localCss = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.css"), "utf8");
    expect(localCss).toContain(".wx-quote-pill.jumpable:focus-visible");
    expect(localCss).toContain(".mention-opt:focus-visible");
  });

  test("Desktop 2.12 hardens multi-monitor window restoration, upgrades Cmd+K Quick Switcher 2.0 (in-place sync/Home/End/ARIA), updates shortcuts cheatsheet, adds busy/copy locks on bot/LAN/settings controls & IME/colorScheme guards on fallback pages", () => {
    // 1. Pure helper: resolveRestoredWindowBounds clamps oversized 4K bounds into smaller laptop display & keeps position inside workArea
    expect(
      resolveRestoredWindowBounds(
        { x: 100, y: 80, width: 2200, height: 1400 },
        { x: 0, y: 25, width: 1440, height: 875 },
      ),
    ).toEqual({ width: 1440, height: 875, x: 0, y: 25 });

    // Preserves valid bounds comfortably inside display
    expect(
      resolveRestoredWindowBounds(
        { x: 120, y: 60, width: 1280, height: 800 },
        { x: 0, y: 25, width: 1920, height: 1055 },
      ),
    ).toEqual({ width: 1280, height: 800, x: 120, y: 60 });

    // Clamps partially overhanging coordinates back into visible workArea
    expect(
      resolveRestoredWindowBounds(
        { x: 1400, y: 500, width: 1000, height: 700 },
        { x: 0, y: 25, width: 1920, height: 1055 },
      ),
    ).toEqual({ width: 1000, height: 700, x: 920, y: 380 });

    // Drops off-screen coordinates cleanly while returning clamped size
    expect(
      resolveRestoredWindowBounds(
        { x: 4000, y: 3000, width: 1320, height: 860 },
        { x: 0, y: 25, width: 1920, height: 1055 },
      ),
    ).toEqual({ width: 1320, height: 860 });

    // Handles null/missing saved bounds gracefully
    expect(resolveRestoredWindowBounds(null, { x: 0, y: 0, width: 1280, height: 720 })).toEqual({
      width: 1280,
      height: 720,
    });

    // 2. Main process wiring uses resolveRestoredWindowBounds
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("resolveRestoredWindowBounds(");

    // 3. Local Hub HTML landmarks & settings submit button ID
    const localHtml = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.html"), "utf8");
    expect(localHtml).toContain('id="channel-list" role="navigation" aria-label="本地会话列表"');
    expect(localHtml).toContain('id="member-strip" role="region" aria-label="房间成员"');
    expect(localHtml).toContain('id="messages-box" aria-label="消息记录"');
    expect(localHtml).toContain('id="btn-save-settings"');

    // 4. Local Hub JS: Cmd+K Quick Switcher 2.0, Shortcuts Cheatsheet parity, channel ARIA, bot busy/copy locks, LAN/settings re-entrancy locks & IME guards
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain("function syncLocalSwitcherActive(scrollIntoView = false)");
    expect(localJs).toContain('switcherInput.setAttribute("role", "combobox")');
    expect(localJs).toContain('switcherList.setAttribute("role", "listbox")');
    expect(localJs).toContain('switcherInput.setAttribute("aria-activedescendant", activeNode.id)');
    expect(localJs).toContain('else if (ev.key === "Home")');
    expect(localJs).toContain('else if (ev.key === "End")');
    expect(localJs).toContain('if (isCurrent) btn.setAttribute("aria-current", "page")');
    expect(localJs).toContain('btnInvite.textContent = "处理中…"');
    expect(localJs).toContain('btnDm.textContent = "打开中…"');
    expect(localJs).toContain('flashCopyButton(btnCmd, "MCP")');
    expect(localJs).toContain('btnToggleLan.textContent = "切换中…"');
    expect(localJs).toContain("let savingLocalSettings = false;");
    expect(localJs).toContain('saveBtn.textContent = "保存中…"');
    expect(localJs).toContain("复制当前页面链接 / 本机 MCP 命令");
    expect(localJs).toContain("启动 / 停止内置本机 Server");
    expect(localJs).toContain("快捷切换工作区（Cloud / 本地 / Studio / OKR）");

    // 5. Local Hub CSS focus-visible & disabled wait affordances
    const localCss = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.css"), "utf8");
    expect(localCss).toContain(".channel-item:focus-visible");
    expect(localCss).toContain(".local-switcher-item:focus-visible");
    expect(localCss).toContain(".icon-btn:disabled");

    // 6. Fallback pages (cloud-offline.html & local-stopped.html): colorScheme dark sync, aria-busy & IME keydown guard
    const offlineHtml = readFileSync(join(import.meta.dir, "..", "ui", "cloud-offline.html"), "utf8");
    const offlineScript = offlineHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(offlineScript)).not.toThrow();
    expect(offlineHtml).toContain('document.documentElement.style.colorScheme = isDarkTheme ? "dark" : "light"');
    expect(offlineHtml).toContain('retryLink.setAttribute("aria-busy", "true")');
    expect(offlineHtml).toContain("ev.isComposing || ev.keyCode === 229");

    const stoppedHtml = readFileSync(join(import.meta.dir, "..", "ui", "local-stopped.html"), "utf8");
    const stoppedScript = stoppedHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(stoppedScript)).not.toThrow();
    expect(stoppedHtml).toContain('document.documentElement.style.colorScheme = isDarkTheme ? "dark" : "light"');
    expect(stoppedHtml).toContain('startLink.setAttribute("aria-busy", "true")');
    expect(stoppedHtml).toContain("ev.isComposing || ev.keyCode === 229");
  });

  test("Desktop 2.13 adds sleep/wake recovery, fullscreen bounds guard, App Menu LAN sync, safe profile naming, interactive rail LAN/ARIA polish, online WS wakeup & Local Hub keyboard/history polish", () => {
    // 1. Pure helper: sanitizeLocalProfileName strips traversal, separators, reserved names & handles CJK display names cleanly
    expect(sanitizeLocalProfileName("My_Local_Claude", "Claude", "xyz")).toBe("My_Local_Claude");
    expect(sanitizeLocalProfileName("../../etc/passwd", "Safe Bot", "xyz")).toBe("etc-passwd");
    expect(sanitizeLocalProfileName("profile", "Code Reviewer", "xyz")).toBe("Code-Reviewer");
    expect(sanitizeLocalProfileName("dev-token", "前端审查助手", "abc123")).toBe("Agent-abc123");
    expect(sanitizeLocalProfileName("", "前端审查助手", "abc123")).toBe("Agent-abc123");
    expect(sanitizeLocalProfileName("...___...", "  My Agent!!  ", "xyz")).toBe("My-Agent");
    expect(sanitizeLocalProfileName("a".repeat(60), "", "xyz").length).toBeLessThanOrEqual(40);

    // 2. Main process: powerMonitor resume recovery, fullscreen/maximized bounds guard, App Menu sync on settings save & sanitizeLocalProfileName
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain('powerMonitor.on("resume"');
    expect(mainTs).toContain("mainWindow.isFullScreen()");
    expect(mainTs).toContain("mainWindow.isMaximized()");
    expect(mainTs).toContain("sanitizeLocalProfileName(rawProfileName, displayName");

    // 3. Shell rail: clickable LAN button, aria-current="page", theme aria-pressed & power aria-busy
    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain('<button class="lan-chip" id="lan-chip" type="button"');
    expect(shellHtml).toContain('lanChip?.addEventListener("click", () => api?.switchWorkspace("local"))');
    expect(shellHtml).toContain('el.setAttribute("aria-current", "page")');
    expect(shellHtml).toContain('btnShellTheme.setAttribute("aria-pressed", String(isDark))');
    expect(shellHtml).toContain('btnPower.setAttribute("aria-busy", "true")');

    // 4. Local Hub: window online instant WS reconnect, loadOlderMessages busy/error states, keyboard-accessible avatars/sender handles & rich member aria-label
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain('window.addEventListener("online"');
    expect(localJs).toContain("async function loadOlderMessages(triggerBtn)");
    expect(localJs).toContain('triggerBtn.textContent = "加载中…"');
    expect(localJs).toContain('showToast(res?.data?.error || "加载历史消息失败，请稍后重试")');
    expect(localJs).toContain('av.setAttribute("role", "button")');
    expect(localJs).toContain('idSpan.setAttribute("role", "button")');
    expect(localJs).toContain('idSpan.setAttribute("aria-label", `复制 @${m.sender_id}`)');

    const localCss = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.css"), "utf8");
    expect(localCss).toContain(".wx-avatar.clickable:focus-visible");
    expect(localCss).toContain(".wx-sender-id.clickable:focus-visible");
    expect(localCss).toContain(".member-pill:focus-visible");
  });

  test("Desktop 2.14 adds Copy Diagnostics Info, parented update dialogs with re-entrancy guard, WAI-ARIA keyboard Window Splitter, roving channel filter tabs, copy flash & sync/register busy locks", () => {
    // 1. Pure helper: formatDesktopDiagnostics outputs clean secret-free runtime summary for both running and stopped Local Mini-Server
    const runningDiag = formatDesktopDiagnostics({
      appVersion: "0.2.14",
      electronVersion: "35.0.0",
      nodeVersion: "22.14.0",
      platform: "darwin",
      arch: "arm64",
      activeWorkspace: "local",
      theme: "dark",
      zoomFactor: 1.1,
      localRunning: true,
      localPort: 8787,
      allowLan: true,
      localOnlineCount: 3,
      notificationsMuted: false,
    });
    expect(runningDiag).toContain("AgentsChat Desktop v0.2.14");
    expect(runningDiag).toContain("Electron 35.0.0 / Node 22.14.0 (darwin/arm64)");
    expect(runningDiag).toContain("Workspace: local · Theme: dark · Zoom: 110% · Muted: no");
    expect(runningDiag).toContain("Local Mini-Server: running (:8787, lan=on, online=3)");

    const stoppedDiag = formatDesktopDiagnostics({
      appVersion: "",
      platform: "win32",
      activeWorkspace: "cloud",
      theme: "light",
      zoomFactor: 99,
      localRunning: false,
      localPort: 0,
      allowLan: false,
      notificationsMuted: true,
    });
    expect(stoppedDiag).toContain("AgentsChat Desktop v0.1.0");
    expect(stoppedDiag).toContain("Zoom: 175% · Muted: yes");
    expect(stoppedDiag).toContain("Local Mini-Server: stopped (port=8787, lan=off)");

    // 2. Main process: parented update dialog, re-entrancy lock, Help → Copy Diagnostics Info & simplified Bot Market route
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("let checkingForUpdates = false;");
    expect(mainTs).toContain("async function showDesktopMessageBox(");
    expect(mainTs).toContain("dialog.showMessageBox(mainWindow, options)");
    expect(mainTs).toContain("cancelId: 1");
    expect(mainTs).toContain("function copyDesktopDiagnostics(): string");
    expect(mainTs).toContain('label: "Copy Diagnostics Info"');

    // 3. Local Hub HTML: roving filter tablist & WAI-ARIA Window Splitter attributes
    const localHtml = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.html"), "utf8");
    expect(localHtml).toContain('id="ch-filter-tabs" role="tablist"');
    expect(localHtml).toContain('id="ch-filter-all" role="tab" aria-selected="true" tabindex="0"');
    expect(localHtml).toContain('id="ch-filter-unread" role="tab" aria-selected="false" tabindex="-1"');
    expect(localHtml).toContain('tabindex="0"');
    expect(localHtml).toContain('aria-valuemin="220"');
    expect(localHtml).toContain('aria-valuemax="420"');
    expect(localHtml).toContain('aria-valuenow="276"');

    // 4. Local Hub JS: zero HTML sinks, valid JS syntax, roving tablist keyboard nav, keyboard splitter resize, server pill flash copy & sync/register busy locks
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain("function selectLocalChannelFilter(unreadOnly, shouldFocus = false)");
    expect(localJs).toContain('elChFilterTabs?.addEventListener("keydown"');
    expect(localJs).toContain("elChFilterAll.tabIndex = sidebarUnreadOnly ? -1 : 0;");
    expect(localJs).toContain('elSidebarResizer?.setAttribute("aria-valuenow", String(clamped))');
    expect(localJs).toContain('elSidebarResizer.addEventListener("keydown"');
    expect(localJs).toContain('const step = ev.shiftKey ? 40 : 16;');
    expect(localJs).toContain('flashCopyButton(elServerPill, originUrl.replace(/^https?:\\/\\//, ""))');
    expect(localJs).toContain("let syncingCloudSession = false;");
    expect(localJs).toContain('triggerBtn.textContent = "同步中…"');
    expect(localJs).toContain("let registeringLocalAgent = false;");
    expect(localJs).toContain('btnRegisterAgent.textContent = "注册中…"');

    // 5. Local Hub CSS: keyboard focus-visible rings on sidebar resizer & filter pills
    const localCss = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.css"), "utf8");
    expect(localCss).toContain(".local-sidebar-resizer:focus-visible::after");
    expect(localCss).toContain(".ch-filter-pill:focus-visible");
  });

  test("Desktop 2.15 adds native swipe/app-command Cloud history navigation, rail keyboard nav + colorScheme/aria-pressed sync, stale-search race guard, 2-step IME-safe Esc & withLocalActionBusy locks", () => {
    // 1. Pure helper: resolveCloudHistoryCommand maps macOS swipe & Win/Linux mouse buttons cleanly
    expect(resolveCloudHistoryCommand("left")).toBe("back");
    expect(resolveCloudHistoryCommand("RIGHT")).toBe("forward");
    expect(resolveCloudHistoryCommand("browser-backward")).toBe("back");
    expect(resolveCloudHistoryCommand("browser-forward")).toBe("forward");
    expect(resolveCloudHistoryCommand("up")).toBeNull();
    expect(resolveCloudHistoryCommand("")).toBeNull();

    // 2. Main process: macOS trackpad swipe & Windows/Linux app-command listeners
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain('mainWindow.on("swipe"');
    expect(mainTs).toContain('mainWindow.on("app-command"');
    expect(mainTs).toContain("resolveCloudHistoryCommand(direction)");
    expect(mainTs).toContain("resolveCloudHistoryCommand(cmd)");

    // 3. Shell rail: keyboard ArrowUp/ArrowDown/Home/End nav, colorScheme parity, optimistic theme aria-pressed & resilient copy
    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain('id="rail-nav-group"');
    expect(shellHtml).toContain('railNavGroup?.addEventListener("keydown"');
    expect(shellHtml).toContain('document.documentElement.style.colorScheme = isDark ? "dark" : "light"');
    expect(shellHtml).toContain('btnCopyUrl.setAttribute("aria-label", "已复制")');

    // 4. Local Hub JS: colorScheme + theme aria-pressed, stale-search seq guard, 2-step IME-safe Esc, withLocalActionBusy locks & safe Markdown export
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain('document.documentElement.style.colorScheme = isDark ? "dark" : "light"');
    expect(localJs).toContain('themeBtn?.setAttribute("aria-pressed", String(isDark))');
    expect(localJs).toContain("let searchRequestSeq = 0;");
    expect(localJs).toContain("if (seq !== searchRequestSeq || targetCh !== currentChannelId) return;");
    expect(localJs).toContain("if (elSearchInput.value || activeSearchQuery)");
    expect(localJs).toContain("async function withLocalActionBusy(btn, fn)");
    expect(localJs).toContain("withLocalActionBusy(elBtnNewGroup");
    expect(localJs).toContain("withLocalActionBusy(elBtnLeaveChannel");
    expect(localJs).toContain('showToast("导出 Markdown 失败，请稍后重试")');
  });

  test("Desktop 2.16 fixes offline/stopped smart reload recovery, adds dialog aria-labelledby, clears stale typing on room switch, surfaces load errors, adds offline WS detection & hardens message edit/delete", () => {
    // 1. Pure helper: resolveSmartReloadAction recovers cloud-offline & local-stopped instead of endlessly reloading static fallback pages
    expect(
      resolveSmartReloadAction({
        workspace: "cloud",
        currentUrl: "file:///app/out/ui/cloud-offline.html?theme=dark",
        lastCloudFailedUrl: "https://agents-chat.com/lobby?channel=dev",
        remoteServerUrl: "https://agents-chat.com",
      }),
    ).toEqual({ kind: "loadUrl", url: "https://agents-chat.com/lobby?channel=dev" });

    expect(
      resolveSmartReloadAction({
        workspace: "cloud",
        currentUrl: "https://agents-chat.com/lobby",
        lastCloudFailedUrl: "https://agents-chat.com/okr-board",
        remoteServerUrl: "https://agents-chat.com",
      }),
    ).toEqual({ kind: "reload" });

    expect(
      resolveSmartReloadAction({
        workspace: "local",
        currentUrl: "file:///app/out/ui/local-stopped.html?port=8787",
        remoteServerUrl: "https://agents-chat.com",
        localRunning: true,
        localHttpUrl: "http://127.0.0.1:8787",
      }),
    ).toEqual({ kind: "loadUrl", url: "http://127.0.0.1:8787" });

    expect(
      resolveSmartReloadAction({
        workspace: "local",
        currentUrl: "file:///app/out/ui/local-stopped.html?port=8787",
        remoteServerUrl: "https://agents-chat.com",
        localRunning: false,
        localHttpUrl: null,
      }),
    ).toEqual({ kind: "reload" });

    // 2. Main process: reloadWebContentsSmart wired into both reloadActiveView & native context menu Reload
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("function reloadWebContentsSmart(");
    expect(mainTs).toContain("resolveSmartReloadAction({");
    expect(mainTs).toContain("return reloadWebContentsSmart(target.webContents, workspace);");
    expect(mainTs).toContain("reloadWebContentsSmart(wc, targetWorkspace)");

    // 3. Local Hub HTML: all 4 native <dialog> modals wire aria-labelledby to their titles
    const localHtml = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.html"), "utf8");
    expect(localHtml).toContain('<dialog id="prompt-dialog" class="modal-dialog" aria-labelledby="dialog-title">');
    expect(localHtml).toContain('<dialog id="connect-dialog" class="modal-dialog modal-wide" aria-labelledby="connect-dialog-title">');
    expect(localHtml).toContain('<dialog id="settings-dialog" class="modal-dialog" aria-labelledby="settings-dialog-title">');
    expect(localHtml).toContain('<dialog id="registered-dialog" class="modal-dialog modal-wide" aria-labelledby="registered-dialog-title">');

    // 4. Local Hub JS: offline WS pill update, clear stale typing, msgRes/bots error guards, edit/delete targetChannelId capture & per-message mutation lock
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain('window.addEventListener("offline"');
    expect(localJs).toContain("clearTimeout(connectRealtimeWs._typingTimer);");
    expect(localJs).toContain('showToast(msgRes.data?.error || "加载房间消息失败，请稍后重试")');
    expect(localJs).toContain("const mutatingMessageIds = new Set();");
    expect(localJs).toContain("const targetChannelId = m.channel_id || currentChannelId;");
  });

  test("Desktop 2.17 fixes duplicate swipe cancellation, serializes Local Server lifecycle, fixes rail copy aria-label stickiness, adds fallback watchdogs & hardens Local Hub IME/search/dialog/clipboard/motion", async () => {
    // 1. Pure helper: createSerialTaskQueue runs overlapping async tasks strictly FIFO and isolates failures
    const runSerial = createSerialTaskQueue();
    const trace: string[] = [];
    const p1 = runSerial(async () => {
      trace.push("start-1");
      await new Promise((r) => setTimeout(r, 15));
      trace.push("end-1");
      return "one";
    });
    const p2 = runSerial(async () => {
      trace.push("start-2");
      throw new Error("boom");
    });
    const p3 = runSerial(async () => {
      trace.push("start-3");
      return "three";
    });
    expect(await p1).toBe("one");
    let p2Err = "";
    try {
      await p2;
    } catch (err: any) {
      p2Err = String(err?.message || "");
    }
    expect(p2Err).toBe("boom");
    expect(await p3).toBe("three");
    expect(trace).toEqual(["start-1", "end-1", "start-2", "start-3"]);

    // 2. Main process: single swipe listener (no contradictory double-fire) + serialized Local Server transitions
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    const swipeMatches = mainTs.match(/mainWindow\.on\("swipe"/g) || [];
    expect(swipeMatches.length).toBe(1);
    expect(mainTs).toContain("const runLocalServerOp = createSerialTaskQueue();");
    expect(mainTs).toContain("async function setLocalServerEnabled(enabled: boolean)");
    expect(mainTs).toContain("void setLocalServerEnabled(true);");
    expect(mainTs).toContain("await setLocalServerEnabled(Boolean(enabled));");

    // 3. Shell rail: baseAriaLabel prevents rapid double-click permanently sticking aria-label="已复制"
    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain("btnCopyUrl.dataset.baseAriaLabel = baseCopyAriaLabel;");
    expect(shellHtml).toContain("btnCopyUrl.dataset.baseAriaLabel ||");

    // 4. Offline & Stopped fallback pages: Light/Dark colorScheme parity, watchdog recovery & valid JS syntax
    const offlineHtml = readFileSync(join(import.meta.dir, "..", "ui", "cloud-offline.html"), "utf8");
    const offlineScript = offlineHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(offlineScript)).not.toThrow();
    expect(offlineHtml).toContain('document.documentElement.style.colorScheme = isDarkTheme ? "dark" : "light"');
    expect(offlineHtml).toContain("function resetRetryState(");
    expect(offlineHtml).toContain("retryWatchdogTimer = setTimeout(");
    expect(offlineHtml).toContain('copied ? "✓ 已复制" : "复制失败"');

    const stoppedHtml = readFileSync(join(import.meta.dir, "..", "ui", "local-stopped.html"), "utf8");
    const stoppedScript = stoppedHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(stoppedScript)).not.toThrow();
    expect(stoppedHtml).toContain('document.documentElement.style.colorScheme = isDarkTheme ? "dark" : "light"');
    expect(stoppedHtml).toContain("function resetStartState(");
    expect(stoppedHtml).toContain("startWatchdogTimer = setTimeout(");

    // 5. Local Hub JS: IME-safe global keydown & snippet tabs, atomic search error state, dialog open/settled guards, reduced-motion scroll & unified safe clipboard
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain("function getScrollBehavior()");
    expect(localJs).toContain("behavior: getScrollBehavior()");
    expect(localJs).toContain("if (!localLbState.open || isImeComposing(ev)) return;");
    expect(localJs).toContain("if (localLbState.open || isImeComposing(ev)) return;");
    expect(localJs).toContain("if (!dlg || dlg.open) return Promise.resolve(null);");
    expect(localJs).toContain("if (!dlg || dlg.open) return Promise.resolve(false);");
    expect(localJs).toContain('if (!dlg || typeof dlg.showModal !== "function" || dlg.open) return;');
    expect(localJs).not.toContain("else await navigator.clipboard?.writeText(");
  });

  test("Desktop 2.18 adds live multi-monitor undock reclamping, macOS fullscreen rail padding, localView did-fail-load fallback, pasteAndMatchStyle, zero-FOUC colorScheme & Local Hub WS/scroll/token/bitmap hardening", () => {
    // 1. Pure helper: computeDisplayReclampedBounds leaves in-bounds windows untouched and clamps oversized/off-screen windows cleanly
    const laptopWorkArea = { x: 0, y: 25, width: 1440, height: 875 };
    expect(computeDisplayReclampedBounds({ x: 60, y: 40, width: 1320, height: 840 }, laptopWorkArea)).toBeNull();
    expect(computeDisplayReclampedBounds({ x: 2400, y: 120, width: 1800, height: 1100 }, laptopWorkArea)).toEqual({
      x: 0,
      y: 25,
      width: 1440,
      height: 875,
    });
    expect(computeDisplayReclampedBounds({ x: -200, y: 10, width: 1000, height: 700 }, laptopWorkArea)).toEqual({
      x: 0,
      y: 25,
      width: 1000,
      height: 700,
    });

    // 2. Main process: display-removed/metrics reclamp, fullscreen state/listeners, localView did-fail-load fallback & pasteAndMatchStyle
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain('screen.on("display-removed", clampMainWindowToVisibleDisplay);');
    expect(mainTs).toContain('screen.on("display-metrics-changed", clampMainWindowToVisibleDisplay);');
    expect(mainTs).toContain("isFullScreen: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen())");
    expect(mainTs).toContain('mainWindow.on("enter-full-screen"');
    expect(mainTs).toContain('mainWindow.on("leave-full-screen"');
    expect(mainTs).toContain('localView.webContents.on("did-fail-load"');
    expect((mainTs.match(/role:\s*"pasteAndMatchStyle"/g) || []).length).toBeGreaterThanOrEqual(2);

    // 3. Shell rail: collapses macOS traffic-light top padding in native fullscreen
    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain(".rail.mac.fullscreen { padding-top: 16px; }");
    expect(shellHtml).toContain('rail.classList.toggle("fullscreen", Boolean(state.isFullScreen));');

    // 4. Zero-FOUC local-theme-init.js sets colorScheme synchronously on first paint
    const themeInitJs = readFileSync(join(import.meta.dir, "..", "ui", "local-theme-init.js"), "utf8");
    expect(() => new Function(themeInitJs)).not.toThrow();
    expect(themeInitJs).toContain('document.documentElement.style.colorScheme = isDark ? "dark" : "light";');

    // 5. Local Hub JS: WS socket-identity guards, scroll-preserving edit/delete, non-destructive token rollback & GPU bitmap cleanup
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(localJs).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain("if (sock !== ws) return;");
    expect(localJs).toContain("if (sock !== ws || sock._manualClose || !authToken) return;");
    expect(localJs).toContain("renderMessages(isNearBottom() ? undefined : { keepScrollTop: elMessages.scrollTop });");
    expect(localJs).toContain("const prevToken = authToken;");
    expect(localJs).toContain("authToken = prevToken;");
    expect(localJs).toContain("bmp.close?.();");
  });

  test("Desktop 2.19 defaults to Cloud-only workspace with native Preferences window (Cmd+,), opt-in Local Mini-Server toggle, strict OAuth popup filtering, async fullscreen reset & context menu polish", () => {
    // 1. Settings defaults & sanitization enforce Cloud-only default and safe opt-in/opt-out
    expect(DEFAULT_DESKTOP_SETTINGS.showLocalWorkspace).toBe(false);
    expect(DEFAULT_DESKTOP_SETTINGS.localServerEnabled).toBe(false);
    expect(sanitizeDesktopSettings({}).showLocalWorkspace).toBe(false);
    expect(sanitizeDesktopSettings({}).localServerEnabled).toBe(false);
    expect(sanitizeDesktopSettings({ activeWorkspace: "local" }).activeWorkspace).toBe("cloud");
    expect(sanitizeDesktopSettings({ showLocalWorkspace: true }).localServerEnabled).toBe(true);
    expect(sanitizeDesktopSettings({ showLocalWorkspace: true, localServerEnabled: false }).localServerEnabled).toBe(false);
    expect(sanitizeDesktopSettings({ showLocalWorkspace: true, activeWorkspace: "local" }).activeWorkspace).toBe("local");

    // 2. Tray tooltip & diagnostics stay clean in Cloud-only mode (no Local Stopped noise)
    expect(
      formatTrayTooltip({ showLocalWorkspace: false, cloudUnread: 2, localUnread: 5, localRunning: false }),
    ).toBe("AgentsChat Desktop (2 unread)");
    expect(
      formatTrayTooltip({ showLocalWorkspace: false, cloudUnread: 0, localRunning: false, notificationsMuted: true }),
    ).toBe("AgentsChat Desktop · Muted");
    const cloudOnlyDiag = formatDesktopDiagnostics({
      appVersion: "0.2.19",
      platform: "darwin",
      activeWorkspace: "cloud",
      showLocalWorkspace: false,
      theme: "dark",
      localRunning: false,
    });
    expect(cloudOnlyDiag).toContain("Local Workspace: hidden (Cloud-only mode)");
    expect(cloudOnlyDiag).not.toContain("Local Mini-Server:");

    // 3. OAuth popup filter allows real auth providers while letting GitHub repos & Google Docs open in default browser
    const remoteOrigin = "https://agents-chat.com";
    expect(isOAuthPopupUrl("https://agents-chat.com/api/auth/google", remoteOrigin)).toBe(true);
    expect(isOAuthPopupUrl("https://accounts.google.com/o/oauth2/v2/auth", remoteOrigin)).toBe(true);
    expect(isOAuthPopupUrl("https://appleid.apple.com/auth/authorize", remoteOrigin)).toBe(true);
    expect(isOAuthPopupUrl("https://github.com/login/oauth/authorize", remoteOrigin)).toBe(true);
    expect(isOAuthPopupUrl("https://github.com/sessions/two-factor", remoteOrigin)).toBe(true);
    expect(isOAuthPopupUrl("https://github.com/swswordholy-tech/AgentsChat", remoteOrigin)).toBe(false);
    expect(isOAuthPopupUrl("https://docs.google.com/document/d/123", remoteOrigin)).toBe(false);
    expect(isOAuthPopupUrl("https://mail.google.com/mail/u/0/", remoteOrigin)).toBe(false);
    expect(isOAuthPopupUrl("javascript:alert(1)", remoteOrigin)).toBe(false);

    // 4. Native Preferences UI (`settings.html` + `settings-preload.cjs`): valid JS, zero HTML injection sinks, strict CSP & opt-in toggle
    const settingsHtml = readFileSync(join(import.meta.dir, "..", "ui", "settings.html"), "utf8");
    const settingsScript = settingsHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(settingsScript.length).toBeGreaterThan(0);
    expect(() => new Function(settingsScript)).not.toThrow();
    expect(settingsScript).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(settingsHtml).toContain('id="pref-show-local"');
    expect(settingsHtml).toContain('id="local-advanced-panel" hidden');
    expect(settingsHtml).toContain('document.documentElement.style.colorScheme = isDark ? "dark" : "light"');
    expect(settingsHtml).toContain("ev.isComposing || ev.keyCode === 229");
    expect(settingsHtml).toContain("@media (prefers-reduced-motion: reduce)");

    const settingsPreload = readFileSync(join(import.meta.dir, "..", "ui", "settings-preload.cjs"), "utf8");
    expect(settingsPreload).toContain("desktop:get-settings-state");
    expect(settingsPreload).toContain("desktop:save-desktop-settings");
    expect(settingsPreload).toContain("desktop:open-data-folder");
    expect(settingsPreload).toContain("desktop:close-settings-window");

    // 5. Shell rail hides Local controls by default & wires Settings button (Cmd+,)
    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain('id="btn-shell-settings"');
    expect(shellHtml).toContain('id="btn-local" type="button" title="本机 Server (⌘2) — 本机低延迟多 Agent 群聊与私聊" aria-label="本机聊天" hidden');
    expect(shellHtml).toContain('const showLocal = state.settings?.showLocalWorkspace === true;');
    expect(shellHtml).toContain("btnLocal.hidden = !showLocal;");
    expect(shellHtml).toContain("portBadge.hidden = !showLocal;");
    expect(shellHtml).toContain("btnPower.hidden = !showLocal;");
    expect(shellHtml).toContain("api?.openSettings?.();");

    const preloadJs = readFileSync(join(import.meta.dir, "..", "ui", "preload.cjs"), "utf8");
    expect(preloadJs).toContain('openSettings: () => ipcRenderer.invoke("desktop:open-settings-window")');

    // 6. Offline fallback respects `?local=0` (Cloud-only mode hides Switch to Local button & L shortcut)
    const offlineHtml = readFileSync(join(import.meta.dir, "..", "ui", "cloud-offline.html"), "utf8");
    const offlineScript = offlineHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(offlineScript)).not.toThrow();
    expect(offlineHtml).toContain("[hidden] { display: none !important; }");
    expect(offlineHtml).toContain('const localEnabledInUi = params.get("local") !== "0";');
    expect(offlineHtml).toContain('else if ((ev.key === "l" || ev.key === "L") && localEnabledInUi)');

    // 7. Main process wiring: Preferences window, Cmd+,, togglefullscreen, async fullscreen reset, Add to Dictionary & Cloud-only guard
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("async function openDesktopSettingsWindow()");
    expect(mainTs).toContain("async function setShowLocalWorkspace(enabled: boolean)");
    expect(mainTs).toContain('accelerator: "CmdOrCtrl+,"');
    expect(mainTs).toContain('{ role: "togglefullscreen" }');
    expect(mainTs).toContain('mainWindow.once("leave-full-screen", applyCenteredBounds)');
    expect(mainTs).toContain("addWordToSpellCheckerDictionary");
    expect(mainTs).toContain("if (!settings.showLocalWorkspace || !settings.localServerEnabled)");
    expect(mainTs).toContain('ipcMain.handle("desktop:save-desktop-settings"');
  });

  test("Desktop 2.20 hardens rail/settings drag-drop anti-navigation, OAuth popup child safety, concurrent download progress, F5/Alt navigation, Preferences Zoom/Diagnostics/roving theme & Local menu IME guard", () => {
    // 1. Pure helper: aggregateDownloadProgress handles concurrent, interrupted, unknown-total & empty sets
    expect(aggregateDownloadProgress([])).toBe(-1);
    expect(aggregateDownloadProgress([{ receivedBytes: 50, totalBytes: 100, state: "interrupted" }])).toBe(-1);
    expect(
      aggregateDownloadProgress([
        { receivedBytes: 50, totalBytes: 100, state: "progressing" },
        { receivedBytes: 150, totalBytes: 300, state: "progressing" },
      ]),
    ).toBe(0.5);
    expect(
      aggregateDownloadProgress([
        { receivedBytes: 50, totalBytes: 100, state: "progressing" },
        { receivedBytes: 256, totalBytes: 0, state: "progressing" },
      ]),
    ).toBe(2);

    // 2. Pure helper: resolveBeforeInputShortcut handles F5 & Alt+Left/Right while ignoring IME & wrong modifiers
    expect(resolveBeforeInputShortcut({ type: "keyDown", key: "F5" })).toBe("reload");
    expect(resolveBeforeInputShortcut({ type: "keyDown", key: "ArrowLeft", alt: true })).toBe("back");
    expect(resolveBeforeInputShortcut({ type: "keyDown", key: "ArrowRight", alt: true })).toBe("forward");
    expect(resolveBeforeInputShortcut({ type: "keyUp", key: "F5" })).toBeNull();
    expect(resolveBeforeInputShortcut({ type: "keyDown", key: "F5", isComposing: true })).toBeNull();
    expect(resolveBeforeInputShortcut({ type: "keyDown", key: "ArrowLeft", alt: true, meta: true })).toBeNull();
    expect(resolveBeforeInputShortcut({ type: "keyDown", key: "ArrowLeft" })).toBeNull();

    // 3. Main process: anti-drop will-navigate guards, OAuth child did-create-window, aggregate downloads, F5/Alt before-input-event & settings diagnostics/zoom
    const mainTs = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    expect(mainTs).toContain("function syncDownloadProgressBar()");
    expect(mainTs).toContain("aggregateDownloadProgress(samples)");
    expect(mainTs).toContain('mainWindow.webContents.on("will-navigate"');
    expect(mainTs).toContain('settingsWindow.webContents.on("will-navigate"');
    expect(mainTs).toContain('cloudView.webContents.on("did-create-window"');
    expect(mainTs).toContain('wc.on("before-input-event"');
    expect(mainTs).toContain("resolveBeforeInputShortcut(input)");
    expect(mainTs).toContain("settingsWindowOpen: Boolean(settingsWindow && !settingsWindow.isDestroyed())");
    expect(mainTs).toContain('ipcMain.handle("desktop:copy-diagnostics"');

    // 4. Preferences window: Zoom stepper, roving theme radiogroup, 1-click Copy Diagnostics & drag-drop guard
    const settingsHtml = readFileSync(join(import.meta.dir, "..", "ui", "settings.html"), "utf8");
    const settingsScript = settingsHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(settingsScript)).not.toThrow();
    expect(settingsScript).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/);
    expect(settingsHtml).toContain('id="btn-zoom-out"');
    expect(settingsHtml).toContain('id="btn-zoom-value"');
    expect(settingsHtml).toContain('id="btn-zoom-in"');
    expect(settingsHtml).toContain('id="btn-copy-diag"');
    expect(settingsHtml).toContain('id="pref-theme-group"');
    expect(settingsHtml).toContain('window.addEventListener("drop", (ev) => ev.preventDefault());');

    // 5. Shell rail: live aria-expanded on settings gear & drag-drop guard
    const shellHtml = readFileSync(join(import.meta.dir, "..", "ui", "shell.html"), "utf8");
    const shellScript = shellHtml.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    expect(() => new Function(shellScript)).not.toThrow();
    expect(shellHtml).toContain('btnShellSettings.setAttribute("aria-expanded", String(settingsOpen));');
    expect(shellHtml).toContain('window.addEventListener("drop", (ev) => ev.preventDefault());');

    // 6. Local Hub JS: IME guard inside context-menu keydown handler
    const localJs = readFileSync(join(import.meta.dir, "..", "ui", "local-chat.js"), "utf8");
    expect(() => new Function(localJs)).not.toThrow();
    expect(localJs).toContain('menu.addEventListener("keydown", (ev) => {\n      if (isImeComposing(ev)) return;');
  });
});
