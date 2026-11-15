import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyDshCordisPatchFile,
  buildMcpAgentsChatArgs,
  checkParentDirectory,
  isBlockedDshHost,
} from "../src/patch.ts";
import { loadDshConfig, main, registerOnly } from "../src/cli.ts";
import { MuseAgentChatClient } from "../../muse/src/client.ts";

describe("Campaign #127 KR4: DSH patch & CLI hardening", () => {
  test("isBlockedDshHost, buildMcpAgentsChatArgs & loadDshConfig block full SSRF metadata/unspecified hosts while allowing normal 3-label hosts", async () => {
    const env = { AGENTCHAT_AGENT_ID: "dsh-bot", AGENTCHAT_TOKEN: "ac_token_127" };
    const blockedHosts = [
      "0.0.0.0",
      "[::]",
      "[0:0:0:0:0:0:0:0]",
      "100.100.100.200",
      "[fd00:ec2::254]",
      "[fd00:ec2:0:0:0:0:0:254]",
      "metadata",
      "instance-data",
      "sub.metadata.google.internal",
      "sub.metadata.goog",
      "[::ffff:100.100.100.200]",
      "[::ffff:6464:64c8]",
      "[::ffff:0:0]",
      "[::ffff:0.0.0.0]",
    ];
    for (const host of blockedHosts) {
      expect(isBlockedDshHost(host)).toBe(true);
      expect(() => buildMcpAgentsChatArgs({ apiUrl: `https://${host}` })).toThrow(/Invalid/);
      expect(() => loadDshConfig({ ...env, AGENTCHAT_REST_URL: `https://${host}` })).toThrow(/Invalid/);
      expect(() => loadDshConfig({ ...env, AGENTCHAT_WS_URL: `wss://${host}/ws` })).toThrow(/Invalid/);
    }

    for (const allowedHost of ["staging-api.agentschat.internal", "metadata.goog.example.com", "agents-chat.com"]) {
      expect(isBlockedDshHost(allowedHost)).toBe(false);
      expect(buildMcpAgentsChatArgs({ apiUrl: `https://${allowedHost}` })).toContain(`https://${allowedHost}`);
      expect(loadDshConfig({ ...env, AGENTCHAT_WS_URL: `wss://${allowedHost}/ws` }).wsUrl).toBe(
        `wss://${allowedHost}/ws`,
      );
    }
  });

  test("checkParentDirectory, applyDshCordisPatchFile, registerOnly & loadDshConfig reject raw symlink_dir/.. traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh127-rawdotdot-"));
    try {
      const realDir = join(dir, "real");
      const siblingDir = join(dir, "sibling");
      const outsideDir = join(dir, "outside");
      mkdirSync(realDir, { recursive: true });
      mkdirSync(siblingDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      const linkInSibling = join(siblingDir, "escape-link");
      symlinkSync(outsideDir, linkInSibling);

      const dotDotTarget = `${linkInSibling}/../real/dsh.json`;
      expect(() => checkParentDirectory(dotDotTarget)).toThrow(/parent/);
      expect(() => applyDshCordisPatchFile({ dshHome: `${linkInSibling}/../real` })).toThrow(/parent/);
      await expect(registerOnly("bot", "https://agents-chat.com", dotDotTarget)).rejects.toThrow(/parent/);

      writeFileSync(join(realDir, "dsh.json"), JSON.stringify({ agentId: "stolen", token: "ac_stolen_123" }), "utf8");
      expect(() => loadDshConfig({}, dotDotTarget)).toThrow(/Missing AgentsChat identity/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("applyDshCordisPatchFile falls back cleanly on Windows NTFS EPERM/EACCES rename and rejects symlink swap", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh127-win-"));
    try {
      const patchFile = join(dir, "cordis.patch.yml");
      writeFileSync(patchFile, "# existing comment\n", "utf8");

      let copyCount = 0;
      const res = applyDshCordisPatchFile({
        dshHome: dir,
        agentsChatProfile: "WinBot",
        fsOps: {
          renameSync() {
            const err: any = new Error("EPERM: operation not permitted, rename");
            err.code = "EPERM";
            throw err;
          },
          copyFileSync(src, dest) {
            copyCount++;
            writeFileSync(dest, readFileSync(src));
          },
        },
      });
      expect(res.changed).toBe(true);
      expect(copyCount).toBe(1);
      expect(readFileSync(patchFile, "utf8")).toContain("WinBot");

      // Symlink swap during EACCES fallback must be rejected without touching victim
      const dir2 = join(dir, "swap");
      mkdirSync(dir2, { recursive: true });
      const victim = join(dir2, "victim.yml");
      writeFileSync(victim, "untouched\n", "utf8");
      const swapPatch = join(dir2, "cordis.patch.yml");
      expect(() =>
        applyDshCordisPatchFile({
          dshHome: dir2,
          fsOps: {
            renameSync() {
              symlinkSync(victim, swapPatch);
              const err: any = new Error("EACCES");
              err.code = "EACCES";
              throw err;
            },
          },
        }),
      ).toThrow(/symlinked or non-regular/);
      expect(readFileSync(victim, "utf8")).toBe("untouched\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validateHttpOrWsUrl rejects query/hash on WS URLs and isSafeAgentId enforces <=128 char bound", async () => {
    const env = { AGENTCHAT_AGENT_ID: "bot", AGENTCHAT_TOKEN: "ac_token_127" };
    expect(() => loadDshConfig({ ...env, AGENTCHAT_WS_URL: "wss://agents-chat.com/ws?token=leak" })).toThrow(/Invalid/);
    expect(() => loadDshConfig({ ...env, AGENTCHAT_WS_URL: "wss://agents-chat.com/ws#frag" })).toThrow(/Invalid/);
    expect(() => loadDshConfig({ ...env, AGENTCHAT_WS_URL: "ws://127.0.0.1:8787/ws?debug=1" })).toThrow(/Invalid/);

    expect(loadDshConfig({ ...env, AGENTCHAT_AGENT_ID: "a".repeat(128) }).agentId).toHaveLength(128);
    expect(() => loadDshConfig({ ...env, AGENTCHAT_AGENT_ID: "a".repeat(129) })).toThrow(/Missing AgentsChat identity/);
    await expect(main(["--send", "c".repeat(129), "--text", "hi"])).rejects.toThrow(/channel id/);
  });

  test("syncBoundDshClients skips reserved sidecar basenames and symlinked profile directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh127-sidecars-"));
    const envNames = ["AGENTSCHAT_CONFIG_DIR", "AGENTCHAT_AGENT_ID", "AGENTCHAT_TOKEN"] as const;
    const prev = Object.fromEntries(envNames.map((k) => [k, process.env[k]]));
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const beforeListeners = signals.map((s) => new Set(process.listeners(s)));
    process.env.AGENTSCHAT_CONFIG_DIR = dir;
    process.env.AGENTCHAT_AGENT_ID = "primary-127";
    process.env.AGENTCHAT_TOKEN = "ac_primary_127";
    mkdirSync(join(dir, "profiles"), { recursive: true });

    const sidecars = [
      "profile",
      "session-binds",
      "session-binds.meta",
      "agy-binds.meta",
      "grok-binds.meta",
      "agy-session-binds",
      "identity-guard",
      "mention-timestamps",
      "dsh",
      "muse",
    ];
    const bindsMap: Record<string, string> = { "session-valid": "ValidBot" };
    sidecars.forEach((sc, idx) => {
      bindsMap[`session-sc-${idx}`] = sc;
      const slug = sc.replace(/[^a-zA-Z0-9_-]/g, "_");
      writeFileSync(join(dir, `${slug}.json`), JSON.stringify({ agent_id: `evil-${idx}`, token: "ac_evil" }), "utf8");
      writeFileSync(
        join(dir, "profiles", `${slug}.json`),
        JSON.stringify({ agent_id: `evil-${idx}`, token: "ac_evil" }),
        "utf8",
      );
    });
    writeFileSync(
      join(dir, "profiles", "ValidBot.json"),
      JSON.stringify({ agent_id: "valid-bot-127", token: "ac_valid_127" }),
      "utf8",
    );
    writeFileSync(join(dir, "session-binds.json"), JSON.stringify(bindsMap), "utf8");

    const connectedIds: string[] = [];
    const connect = spyOn(MuseAgentChatClient.prototype, "connect").mockImplementation(async function (
      this: MuseAgentChatClient,
    ) {
      connectedIds.push((this as any).options?.agentId ?? (this as any).agentId);
    });
    const joinChannel = spyOn(MuseAgentChatClient.prototype, "joinChannel").mockImplementation(() => {});
    const disconnect = spyOn(MuseAgentChatClient.prototype, "disconnect").mockImplementation(() => {});
    const closed = spyOn(MuseAgentChatClient.prototype, "waitUntilClosed").mockResolvedValue();
    try {
      await main(["--wake"]);
      expect(connectedIds).toEqual(["primary-127", "valid-bot-127"]);
      expect(existsSync(join(dir, "profiles", "ValidBot.json"))).toBe(true);
    } finally {
      connect.mockRestore();
      joinChannel.mockRestore();
      disconnect.mockRestore();
      closed.mockRestore();
      signals.forEach((sig, i) => {
        for (const l of process.listeners(sig)) {
          if (!beforeListeners[i]!.has(l)) process.removeListener(sig, l);
        }
      });
      for (const k of envNames) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
