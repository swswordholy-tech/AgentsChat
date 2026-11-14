import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { safeWriteProfile, findDefaultProfileCollision } from "../src/profile-store.ts";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, existsSync, rmSync, renameSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
const mode = (p: string) => statSync(p).mode & 0o777;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "profstore-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("premise (control): why the unlink is required at all", () => {
  test("writeFileSync's mode is IGNORED for an existing file, and rename preserves it", () => {
    const f = join(dir, "x.tmp");
    writeFileSync(f, "a", { mode: 0o644 });
    chmodSync(f, 0o644);
    writeFileSync(f, "b", { mode: 0o600 }); // mode silently ignored — file already exists
    expect(mode(f)).toBe(0o644);

    renameSync(f, join(dir, "x.json"));
    expect(mode(join(dir, "x.json"))).toBe(0o644); // rename preserved the source's mode
  });
});

describe("safeWriteProfile keeps the agent key 0600", () => {
  test("normal write is 0600 and leaves no .tmp", () => {
    const p = join(dir, "p.json");
    safeWriteProfile(p, { token: "ac_secret" });
    expect(mode(p)).toBe(0o600);
    expect(existsSync(p + ".tmp")).toBe(false);
  });

  test("a stale world-readable .tmp does not carry 0644 into the profile", () => {
    const p = join(dir, "p.json");
    const tmp = p + ".tmp";
    writeFileSync(tmp, "{}", { mode: 0o644 });
    chmodSync(tmp, 0o644);

    safeWriteProfile(p, { token: "ac_secret" });
    expect(mode(p)).toBe(0o600);
    expect(existsSync(tmp)).toBe(false);
  });

  /**
   * THE discriminating test. The two above pass even against the old implementation,
   * because chmodSync repairs the mode after the fact. The real guarantee is that the key
   * is 0600 *by construction* — never world-readable on disk, not even in the window
   * between rename and chmod. Force rename to fail (target is a directory) so the tmp
   * survives, and inspect the permissions it was created with.
   *
   * Old code: writes into the stale 0644 tmp → key sits world-readable → 0644 here.
   * New code: unlinks first, creates fresh with mode 0600 → 0600 here.
   */
  test("if we die before rename/chmod, the key on disk is still 0600", () => {
    const p = join(dir, "p.json");
    const tmp = p + ".tmp";
    writeFileSync(tmp, "{}", { mode: 0o644 });
    chmodSync(tmp, 0o644);
    mkdirSync(p); // renameSync(tmp, p) now throws — we never reach chmod

    expect(() => safeWriteProfile(p, { token: "ac_secret" })).toThrow();
    expect(existsSync(tmp)).toBe(true);
    expect(mode(tmp)).toBe(0o600); // 0644 on the old implementation
  });

  test("a stale .tmp that cannot be removed is reported, never swallowed", () => {
    const p = join(dir, "p.json");
    const tmp = p + ".tmp";
    mkdirSync(tmp); // unlinkSync on a directory fails → the warn path we added

    const warnings: string[] = [];
    expect(() => safeWriteProfile(p, { token: "ac_secret" }, (m) => warnings.push(m))).toThrow();
    expect(warnings.join("")).toMatch(/could not be removed/);
  });

  test("control: the happy path emits no warnings at all", () => {
    // Without this, the assertion above could pass on a sink that always fires.
    const warnings: string[] = [];
    safeWriteProfile(join(dir, "p.json"), { token: "ac_secret" }, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  test("unlinks a dangling .tmp symlink instead of writing the private key through it, and rejects symlinked target paths", () => {
    const p = join(dir, "p.json");
    const tmp = p + ".tmp";
    const victim = join(dir, "victim-outside.json");
    // Dangling symlink: existsSync(tmp) is FALSE, so naive code would follow it on writeFileSync!
    symlinkSync(victim, tmp);
    expect(existsSync(tmp)).toBe(false);

    safeWriteProfile(p, { token: "ac_live_secret" });
    expect(existsSync(victim)).toBe(false);
    expect(JSON.parse(readFileSync(p, "utf8")).token).toBe("ac_live_secret");
    expect(mode(p)).toBe(0o600);

    // Symlinked target path itself must fail closed
    const realTarget = join(dir, "real.json");
    writeFileSync(realTarget, '{"token":"keep"}');
    const symTarget = join(dir, "sym-profile.json");
    symlinkSync(realTarget, symTarget);
    expect(() => safeWriteProfile(symTarget, { token: "ac_overwrite" })).toThrow(/symlink/i);
    expect(JSON.parse(readFileSync(realTarget, "utf8")).token).toBe("keep");

    // findDefaultProfileCollision ignores symlinked candidate profiles
    const defPath = join(dir, "profile.json");
    writeFileSync(defPath, JSON.stringify({ agent_id: "bot_1", display_name: "Bot 1", token: "ac_1" }));
    const symCand = join(dir, "Shadow.json");
    symlinkSync(defPath, symCand);
    expect(findDefaultProfileCollision(dir, defPath)).toBeNull();
  });

  test("Campaign #114 KR3: rejects symlinked parent dirs, scrubs control chars in warnings, and handles uppercase .JSON metadata/profile collisions", () => {
    const outsideDir = join(dir, "outside");
    mkdirSync(outsideDir);
    const symParent = join(dir, "sym-parent");
    symlinkSync(outsideDir, symParent);

    expect(() => safeWriteProfile(join(symParent, "profile.json"), { token: "ac_secret" })).toThrow(
      /invalid or symlinked parent directory/i,
    );
    expect(existsSync(join(outsideDir, "profile.json"))).toBe(false);

    // Control characters in warning paths/errors are scrubbed before hitting stderr/warn sink
    const noisyPath = join(dir, "bad\x1b[31mname.json");
    mkdirSync(noisyPath + ".tmp");
    const warnings: string[] = [];
    expect(() => safeWriteProfile(noisyPath, { token: "ac_secret" }, (m) => warnings.push(m))).toThrow();
    expect(warnings.join("")).not.toContain("\x1b");
    expect(warnings.join("")).toMatch(/could not be removed/);

    // findDefaultProfileCollision skips uppercase metadata files (SESSION-BINDS.JSON) while detecting uppercase .JSON shadow profiles
    const cfgDir = join(dir, "cfg");
    mkdirSync(cfgDir);
    const defPath = join(cfgDir, "profile.json");
    writeFileSync(defPath, JSON.stringify({ agent_id: "bot_upper", display_name: "Upper Bot", token: "ac_def" }));
    writeFileSync(
      join(cfgDir, "SESSION-BINDS.JSON"),
      JSON.stringify({ agent_id: "bot_upper", display_name: "Upper Bot", token: "ac_not_profile" }),
    );
    expect(findDefaultProfileCollision(cfgDir, defPath)).toBeNull();

    writeFileSync(
      join(cfgDir, "NamedUpper.JSON"),
      JSON.stringify({ agent_id: "bot_upper", display_name: "Upper Bot", token: "ac_named" }),
    );
    const collision = findDefaultProfileCollision(cfgDir, defPath);
    expect(collision?.collidingName).toBe("NamedUpper");
    expect(collision?.reason).toBe("agent_id");

    // Symlinked configDir is refused by findDefaultProfileCollision
    const symCfg = join(dir, "sym-cfg");
    symlinkSync(cfgDir, symCfg);
    expect(findDefaultProfileCollision(symCfg, defPath)).toBeNull();
  });
});
