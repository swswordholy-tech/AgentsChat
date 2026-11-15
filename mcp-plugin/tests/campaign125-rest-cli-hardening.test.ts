import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWakePidFile,
  advanceChannelReadCursor,
  CURSOR_INIT_KEY,
  hasSafeDirChain,
  loadJsonMap,
  loadSeenIds,
  readBoundedResponseJson,
  releaseWakePidFile,
  validateSafeRestBaseUrl,
  wakeOnce,
} from "../src/rest-cli.ts";

describe("Campaign #125 KR3: rest-cli SSRF, ancestor symlinks, own-__proto__ JSON, and WakeOnceEvent redaction", () => {
  test("validateSafeRestBaseUrl blocks cloud-metadata, link-local, and unspecified hosts over https and http even with AGENTSCHAT_ALLOW_INSECURE_HTTP=1", () => {
    const prevAllow = process.env.AGENTSCHAT_ALLOW_INSECURE_HTTP;
    process.env.AGENTSCHAT_ALLOW_INSECURE_HTTP = "1";
    try {
      const blocked = [
        "http://169.254.169.254",
        "https://169.254.169.254",
        "http://169.254.170.2",
        "http://100.100.100.200",
        "https://100.100.100.200",
        "http://0.0.0.0:8080",
        "http://[::]:8080",
        "http://[fe80::1]:8080",
        "http://[fd00:ec2::254]",
        "http://[::ffff:169.254.169.254]",
        "http://[::ffff:a9fe:a9fe]",
        "http://metadata.google.internal",
        "https://metadata.google.internal",
        "http://metadata.goog",
        "https://internal.metadata.goog",
        "http://metadata",
        "http://instance-data",
      ];
      for (const bad of blocked) {
        expect(() => validateSafeRestBaseUrl(bad)).toThrow(/Refusing|Invalid/);
      }

      expect(validateSafeRestBaseUrl("https://agents-chat.com/")).toBe("https://agents-chat.com");
      expect(validateSafeRestBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
      expect(validateSafeRestBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
      expect(validateSafeRestBaseUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
    } finally {
      if (prevAllow === undefined) delete process.env.AGENTSCHAT_ALLOW_INSECURE_HTTP;
      else process.env.AGENTSCHAT_ALLOW_INSECURE_HTTP = prevAllow;
    }
  });

  test("hasSafeDirChain and state/PID helpers refuse symlinked ancestor directories and symlink_dir/.. traversal on macOS/Linux", () => {
    const root = mkdtempSync(join(tmpdir(), "rest-cli-c125-anc-"));
    try {
      const realSub = join(root, "real-sub");
      mkdirSync(realSub, { recursive: true });
      const symParent = join(root, "sym-parent");
      symlinkSync(realSub, symParent);

      expect(hasSafeDirChain(realSub)).toBe(true);
      expect(hasSafeDirChain(symParent)).toBe(false);
      expect(hasSafeDirChain(join(symParent, "nested"))).toBe(false);
      expect(hasSafeDirChain(`${symParent}/../real-sub`)).toBe(false);

      const seenFile = join(realSub, "seen.json");
      writeFileSync(seenFile, JSON.stringify(["id-1"]));
      expect(loadSeenIds(seenFile)).toEqual(["id-1"]);
      expect(loadSeenIds(join(symParent, "seen.json"))).toEqual([]);

      const mapFile = join(realSub, "map.json");
      writeFileSync(mapFile, JSON.stringify({ general: "2026-11-15T00:00:00Z" }));
      expect(loadJsonMap(mapFile).general).toBe("2026-11-15T00:00:00Z");
      expect(Object.keys(loadJsonMap(join(symParent, "map.json")))).toEqual([]);

      const pidReal = join(realSub, "wake.pid");
      expect(acquireWakePidFile(join(symParent, "wake.pid"), 7777)).toBe(false);
      writeFileSync(pidReal, "7777\n");
      releaseWakePidFile(join(symParent, "wake.pid"), 7777);
      expect(readFileSync(pidReal, "utf8").trim()).toBe("7777");
      releaseWakePidFile(pidReal, 7777);

      expect(() =>
        advanceChannelReadCursor({
          configDir: join(symParent, "nested-cfg"),
          agentId: "bot-1",
          channelId: "general",
          timestamp: "2026-11-15T00:00:00.000Z",
        }),
      ).toThrow("Refusing symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readBoundedResponseJson rejects top-level own __proto__ JSON responses cleanly", async () => {
    const pollutedStreamRes = new Response('{"__proto__":{"polluted":true},"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await expect(readBoundedResponseJson(pollutedStreamRes)).rejects.toThrow(/prototype-polluting/);
    expect(({} as any).polluted).toBeUndefined();

    const cleanRes = new Response('{"ok":true,"channels":[{"id":"general"}]}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await expect(readBoundedResponseJson(cleanRes)).resolves.toEqual({
      ok: true,
      channels: [{ id: "general" }],
    });
  });

  test("wakeOnce redacts leaked secrets across content, messages[], context_prefix, and prompt while honoring same_owner_direct for ac_ keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rest-cli-c125-redact-"));
    try {
      const acSecret = "ac_" + "a".repeat(24);
      const whsecSecret = "whsec_" + "w".repeat(24);
      const skSecret = "sk-" + "s".repeat(24);
      const ghPat = "github_pat_" + "p".repeat(24);

      writeFileSync(
        join(dir, "last-seen-msg-ts-bot-1.json"),
        JSON.stringify({
          [CURSOR_INIT_KEY]: "2026-11-15T00:00:00.000Z",
          general: "2026-11-15T00:01:00.000Z",
          "dm-owner": "2026-11-15T00:01:00.000Z",
        }),
      );

      // 1. Group channel burst + context_prefix: all secrets redacted across every output field!
      const groupEv = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-1",
        token: "ac_caller_token_123456",
        enableSse: false,
        fetchImpl: (async (url: any) => {
          const u = String(url);
          if (u.endsWith("/api/channels/mine")) {
            return Response.json({
              channels: [{ id: "general", last_message_at: "2026-11-15T00:02:05.000Z" }],
            });
          }
          if (u.includes("/api/channels/general/messages")) {
            return Response.json({
              messages: [
                {
                  id: "ctx-1",
                  channel_id: "general",
                  sender_id: "alice@example.com",
                  content: `earlier context with ${whsecSecret} and ${ghPat}`,
                  timestamp: "2026-11-15T00:02:01.000Z",
                },
                {
                  id: "m-1",
                  channel_id: "general",
                  sender_id: "peer-1",
                  content: `@bot-1 check ${acSecret}`,
                  timestamp: "2026-11-15T00:02:03.000Z",
                },
                {
                  id: "m-2",
                  channel_id: "general",
                  sender_id: "peer-1",
                  content: `@bot-1 also ${skSecret}`,
                  timestamp: "2026-11-15T00:02:05.000Z",
                },
              ],
            });
          }
          return Response.json({});
        }) as any,
      });

      const serializedGroup = JSON.stringify(groupEv);
      expect(serializedGroup).not.toContain(acSecret);
      expect(serializedGroup).not.toContain(whsecSecret);
      expect(serializedGroup).not.toContain(skSecret);
      expect(serializedGroup).not.toContain(ghPat);
      expect(serializedGroup).not.toContain("alice@example.com");
      expect(groupEv.messages).toHaveLength(2);

      // 2. same_owner_direct DM: preserves ac_ key, still redacts whsec_ / sk-!
      const dmEv = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-1",
        token: "ac_caller_token_123456",
        enableSse: false,
        fetchImpl: (async (url: any) => {
          const u = String(url);
          if (u.endsWith("/api/channels/mine")) {
            return Response.json({
              channels: [{ id: "dm-owner", last_message_at: "2026-11-15T00:03:00.000Z" }],
            });
          }
          if (u.includes("/api/channels/dm-owner/messages")) {
            return Response.json({
              messages: [
                {
                  id: "dm-1",
                  channel_id: "dm-owner",
                  sender_id: "owner",
                  same_owner_direct: true,
                  content: `here is ${acSecret} and ${whsecSecret}`,
                  timestamp: "2026-11-15T00:03:00.000Z",
                },
              ],
            });
          }
          return Response.json({});
        }) as any,
      });

      expect(dmEv.content).toContain(acSecret);
      expect(dmEv.content).not.toContain(whsecSecret);
      expect(dmEv.prompt).toContain(acSecret);
      expect(dmEv.prompt).not.toContain(whsecSecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
