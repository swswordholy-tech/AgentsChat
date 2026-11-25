import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildCloudThemeSyncScript,
  buildOfflineThemeSyncScript,
  checkLatestDesktopRelease,
  clampDesktopZoomFactor,
  classifyCloudRailSection,
  CLOUD_THEME_TOGGLE_SELECTOR,
  compareSemver,
  formatCopyableCloudUrl,
  formatZoomBadge,
  isCloudOfflinePageUrl,
  isTrustedCloudThemeOrigin,
  parseDeepLink,
  parseDesktopReleaseTag,
  parseUnreadCountFromTitle,
  resolveCloudQuickRoute,
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

    const saved = store.save({
      activeWorkspace: "local",
      remoteServerUrl: "http://evil-insecure.example.com",
      localServerPort: 80,
      allowLan: true,
      minimizeToTray: false,
    });

    // Insecure HTTP remoteServerUrl and privileged port < 1024 fall back safely
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
      for (const secretPath of ["/preload.cjs", "/local-preload.cjs", "/shell.html", "/cloud-offline.html"]) {
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
});
