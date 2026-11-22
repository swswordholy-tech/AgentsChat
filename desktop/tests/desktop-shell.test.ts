import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GlobalIdentityAuthority } from "../src/identity-authority.js";
import { LocalMiniServer } from "../src/local-server.js";
import { DEFAULT_DESKTOP_SETTINGS, DesktopSettingsStore, sanitizeDesktopSettings } from "../src/settings-store.js";

describe("AgentsChat Desktop M2 — Settings, Profile Discovery & Static Local UI", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ac-desktop-m2-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
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

    // Symlinked profile must be ignored (mirrors agentschat-mcp symlink guard)
    const outsideTarget = join(tempDir, "outside.json");
    writeFileSync(
      outsideTarget,
      JSON.stringify({ agent_id: "symlink-bot", display_name: "Symlink Bot", token: "ac_symlink_secret" }),
    );
    symlinkSync(outsideTarget, join(profilesDir, "Symlinked.json"));

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
      const html = await indexRes.text();
      expect(html).toContain("AgentsChat Local Server");
      expect(html).toContain("local-chat.js");

      const jsRes = await fetch(`${status.httpUrl}/local-chat.js`);
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get("content-type")).toContain("javascript");

      // Path traversal attempt must never escape staticUiDir
      const traversalRes = await fetch(`${status.httpUrl}/..%2Fpackage.json`);
      expect(traversalRes.status).toBe(404);
      // Loopback mode never advertises LAN URLs
      expect(status.lanUrls).toEqual([]);
      const health = (await (await fetch(`${status.httpUrl}/health`)).json()) as any;
      expect(health.lan_urls).toEqual([]);
    } finally {
      await server.stop();
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
      await server.stop();
    }
  });
});
