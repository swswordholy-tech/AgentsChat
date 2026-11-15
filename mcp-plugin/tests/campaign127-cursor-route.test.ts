import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCursor, persistCursor } from "../src/read-cursor.ts";
import { resolveSessionForAgent } from "../src/session-route.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "c127-cursor-route-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Campaign #127 KR3: read-cursor & session-route Hardening", () => {
  test("read-cursor blocks raw symlink_dir/.. traversal before resolve() collapses '..'", () => {
    const realDir = join(dir, "real");
    const outsideDir = join(dir, "outside");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(realDir, "c.json"), JSON.stringify({ room: "2026-11-15T00:00:00Z" }));

    const symLink = join(dir, "sym");
    symlinkSync(outsideDir, symLink);

    // Raw unnormalized path traverses `sym` before `..` collapses
    const rawTraversalPath = `${symLink}/../real/c.json`;

    const loadWarnings: string[] = [];
    expect(loadCursor(rawTraversalPath, (m) => loadWarnings.push(m)).size).toBe(0);
    expect(loadWarnings.join("")).toMatch(/could not read/);

    const persistWarnings: string[] = [];
    expect(
      persistCursor(rawTraversalPath, new Map([["room", "2026-11-15T01:00:00Z"]]), (m) =>
        persistWarnings.push(m),
      ),
    ).toBe(false);
    expect(persistWarnings.join("")).toMatch(/parent is not a real directory/);
  });

  test("persistCursor falls back cleanly to copyFileSync on Windows-style EPERM/EACCES rename failure while refusing symlink targets", () => {
    const file = join(dir, "cursor.json");
    writeFileSync(file, JSON.stringify({ old: "2026-11-14T00:00:00Z" }));

    let renameAttempts = 0;
    let copyAttempts = 0;
    const warnings: string[] = [];

    const ok = persistCursor(
      file,
      new Map([["chan-1", "2026-11-15T01:23:45Z"]]),
      (m) => warnings.push(m),
      {
        renameSync: () => {
          renameAttempts++;
          const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        },
        copyFileSync: (src, dest) => {
          copyAttempts++;
          copyFileSync(src, dest);
        },
      },
    );

    expect(ok).toBe(true);
    expect(renameAttempts).toBe(1);
    expect(copyAttempts).toBe(1);
    expect(warnings).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "chan-1": "2026-11-15T01:23:45Z" });
    expect(readdirSync(dir)).toEqual(["cursor.json"]); // tmp cleaned up

    // If target gets swapped with a symlink right during EACCES fallback, copyFileSync is NEVER called!
    const victim = join(dir, "victim.json");
    writeFileSync(victim, JSON.stringify({ untouched: true }));
    const swapTarget = join(dir, "swap.json");
    writeFileSync(swapTarget, JSON.stringify({ initial: "ts" }));

    let copyCalledOnSwap = false;
    const swapWarns: string[] = [];
    const swapOk = persistCursor(
      swapTarget,
      new Map([["chan-2", "2026-11-15T02:00:00Z"]]),
      (m) => swapWarns.push(m),
      {
        renameSync: () => {
          rmSync(swapTarget);
          symlinkSync(victim, swapTarget);
          const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        },
        copyFileSync: () => {
          copyCalledOnSwap = true;
        },
      },
    );

    expect(swapOk).toBe(false);
    expect(copyCalledOnSwap).toBe(false);
    expect(JSON.parse(readFileSync(victim, "utf8"))).toEqual({ untouched: true });
    expect(swapWarns.join("")).toMatch(/symlink/);
  });

  test("read-cursor scrubs expanded token prefixes (glpat-, xoxb-, rk_live_, URL userinfo) in warnings", () => {
    const warnings: string[] = [];
    const secretPath = join(
      dir,
      "missing-glpat-secretToken1234-xoxb-slackSecret5678-rk_live_987654321",
      "c.json",
    );
    expect(persistCursor(secretPath, new Map([["ch", "ts"]]), (m) => warnings.push(m))).toBe(false);
    const combined = warnings.join("");
    expect(combined).not.toContain("secretToken1234");
    expect(combined).not.toContain("slackSecret5678");
    expect(combined).not.toContain("rk_live_987654321");
    expect(combined).toContain("REDACTED");
  });

  test("session-route blocks raw symlink_dir/.. configDir, excludes all reserved state/meta sidecars, and filters unsafe sessionIds", () => {
    const realCfg = join(dir, "real-cfg");
    const outside = join(dir, "outside-dir");
    mkdirSync(join(realCfg, "profiles"), { recursive: true });
    mkdirSync(outside, { recursive: true });

    writeFileSync(join(realCfg, "profiles", "valid-bot.json"), JSON.stringify({ agent_id: "bot-1" }));
    // Sidecar files that happen to contain an `agent_id` field must NEVER resolve as profiles
    for (const sidecar of [
      "profile.json",
      "session-binds.meta.json",
      "agy-binds.meta.json",
      "grok-binds.meta.json",
      "agy-session-binds.json",
      "identity-guard.json",
      "mention-timestamps.json",
      "dsh.json",
      "muse.json",
    ]) {
      writeFileSync(join(realCfg, sidecar), JSON.stringify({ agent_id: "sidecar-spoof" }));
    }

    writeFileSync(
      join(realCfg, "session-binds.json"),
      JSON.stringify({
        "sess-meta-1": "session-binds.meta",
        "sess-meta-2": "agy-binds.meta",
        "sess-profile": "profile",
        "sess-muse": "muse",
        "sess-dsh": "dsh",
        "bad\x00sess": "valid-bot",
        ["x".repeat(300)]: "valid-bot",
      }),
    );

    expect(resolveSessionForAgent("sidecar-spoof", { configDir: realCfg })).toBeUndefined();
    expect(resolveSessionForAgent("bot-1", { configDir: realCfg })).toBeUndefined();

    // Add a clean sessionId for valid-bot -> resolves cleanly on realCfg, but NOT via symlink_dir/..
    writeFileSync(
      join(realCfg, "session-binds.json"),
      JSON.stringify({
        "good-session-1": "valid-bot",
        "bad\nctrl": "valid-bot",
      }),
    );
    expect(resolveSessionForAgent("bot-1", { configDir: realCfg })).toEqual({
      sessionId: "good-session-1",
      profileName: "valid-bot",
      agentId: "bot-1",
    });

    const sym = join(dir, "sym-cfg");
    symlinkSync(outside, sym);
    expect(resolveSessionForAgent("bot-1", { configDir: `${sym}/../real-cfg` })).toBeUndefined();
  });
});
