import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushCursor, loadCursor, persistCursor, safeAgentCursorSlug } from "../src/read-cursor.ts";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cursor-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("flushCursor clears dirty only after the write lands", () => {
  /**
   * The bug: the old flush set `dirty = false` before writing. A failed write therefore
   * discarded the cursor AND disabled its own retry — the shutdown fallback flush sees
   * `!dirty` and returns immediately. Both assertions below fail on the old semantics.
   */
  test("a failed write keeps the cursor dirty, so the fallback flush actually retries", () => {
    const state = { dirty: true };
    let attempts = 0;
    const failingWrite = () => { attempts++; return false; };

    expect(flushCursor(state, failingWrite)).toBe(false);
    expect(state.dirty).toBe(true); // old: false — cursor silently dropped

    flushCursor(state, failingWrite); // the shutdown fallback
    expect(attempts).toBe(2); // old: 1 — the fallback early-returned on !dirty
  });

  test("a landed write clears dirty; the fallback flush is then a no-op", () => {
    const state = { dirty: true };
    let attempts = 0;
    const goodWrite = () => { attempts++; return true; };

    expect(flushCursor(state, goodWrite)).toBe(true);
    expect(state.dirty).toBe(false);
    expect(flushCursor(state, goodWrite)).toBe(false);
    expect(attempts).toBe(1); // no redundant write on shutdown
  });

  test("control: a clean cursor never touches disk", () => {
    // Without this, `attempts` assertions above could pass on a flush that always writes.
    let attempts = 0;
    expect(flushCursor({ dirty: false }, () => { attempts++; return true; })).toBe(false);
    expect(attempts).toBe(0);
  });
});

describe("loadCursor distinguishes 'never existed' from 'we just lost it'", () => {
  /**
   * This runs ONCE at startup — there is no second attempt that could notice the failure.
   * A corrupt/unreadable file silently reset remembered state on the old implementation.
   */
  test("a corrupt file reports the reset instead of pretending it was empty", () => {
    const file = join(dir, "c.json");
    writeFileSync(file, "{ this is not json");
    const warnings: string[] = [];

    expect(loadCursor(file, (m) => warnings.push(m)).size).toBe(0);
    expect(warnings.join("")).toMatch(/could not read/); // old: silent
    expect(warnings.join("")).toContain(file);
  });

  test("control: a missing file is the normal first run and stays quiet", () => {
    // Without this, the assertion above could pass on a warn that always fires.
    const warnings: string[] = [];
    expect(loadCursor(join(dir, "absent.json"), (m) => warnings.push(m)).size).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("control: a valid file round-trips quietly", () => {
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ chan: "ts" }));
    const warnings: string[] = [];
    expect(loadCursor(file, (m) => warnings.push(m))).toEqual(new Map([["chan", "ts"]]));
    expect(warnings).toEqual([]);
  });
});

describe("persistCursor reports failures instead of swallowing them", () => {
  test("an unwritable path returns false and names the file", () => {
    const warnings: string[] = [];
    const ok = persistCursor(join(dir, "no-such-dir", "c.json"), new Map([["chan", "ts"]]), (m) => warnings.push(m));

    expect(ok).toBe(false); // old: returned void, caller could not tell
    expect(warnings.join("")).toMatch(/failed to persist read cursor/); // old: silent
  });

  test("control: a successful write returns true, stays quiet, and round-trips", () => {
    const file = join(dir, "c.json");
    const warnings: string[] = [];
    const ok = persistCursor(file, new Map([["chan", "2026-07-10T00:00:00Z"]]), (m) => warnings.push(m));

    expect(ok).toBe(true);
    expect(warnings).toEqual([]); // proves the warn assertion above isn't vacuous
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ chan: "2026-07-10T00:00:00Z" });
    // Atomic rename leaves zero stray .tmp siblings behind
    expect(readdirSync(dir)).toEqual(["c.json"]);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  test("loadCursor rejects non-object JSON roots and non-string cursor values with a warning", () => {
    for (const badContent of ["null", "[1,2]", '"str"', JSON.stringify({ chan: 12345 }), JSON.stringify({ chan: "bad\x00ts" })]) {
      const file = join(dir, "bad-shape.json");
      writeFileSync(file, badContent);
      const warnings: string[] = [];
      expect(loadCursor(file, (m) => warnings.push(m)).size).toBe(0);
      expect(warnings.join("")).toMatch(/could not read/);
    }
  });

  test("loadCursor and persistCursor reject symbolic links without following or clobbering targets", () => {
    const victim = join(dir, "victim.json");
    writeFileSync(victim, JSON.stringify({ secret: "untouched" }));
    const link = join(dir, "link-cursor.json");
    symlinkSync(victim, link);

    const loadWarnings: string[] = [];
    expect(loadCursor(link, (m) => loadWarnings.push(m)).size).toBe(0);
    expect(loadWarnings.join("")).toMatch(/could not read/);

    const persistWarnings: string[] = [];
    expect(persistCursor(link, new Map([["chan", "2026-07-10T00:00:00Z"]]), (m) => persistWarnings.push(m))).toBe(false);
    expect(persistWarnings.join("")).toMatch(/failed to persist read cursor/);
    expect(JSON.parse(readFileSync(victim, "utf-8"))).toEqual({ secret: "untouched" });
  });

  test("Campaign #113 KR3: rejects symlinked parent directory, filters case-insensitive prototype keys, and scrubs control chars in warnings", () => {
    expect(safeAgentCursorSlug("__PROTO__")).toBe("_");
    expect(safeAgentCursorSlug("Constructor")).toBe("_");

    const realSub = join(dir, "real-sub");
    mkdirSync(realSub);
    const symSub = join(dir, "sym-sub");
    symlinkSync(realSub, symSub);

    const warnings: string[] = [];
    expect(persistCursor(join(symSub, "c.json"), new Map([["chan", "ts"]]), (m) => warnings.push(m))).toBe(false);
    expect(warnings.join("")).toMatch(/parent is not a real directory/);

    const protoFile = join(dir, "proto.json");
    writeFileSync(protoFile, '{"__PROTO__":"bad","Constructor":"bad","good":"2026-07-10T00:00:00Z"}');
    const loadWarns: string[] = [];
    expect(loadCursor(protoFile, (m) => loadWarns.push(m))).toEqual(new Map([["good", "2026-07-10T00:00:00Z"]]));
    expect(loadWarns).toEqual([]);
  });

  test("Campaign #121 KR3: blocks ancestor symlink directories on both load & persist, scrubs secrets in warnings, and bounds >50,000 entries on persist", () => {
    const realRoot = join(dir, "real-root");
    const realNested = join(realRoot, "nested");
    mkdirSync(realNested, { recursive: true });
    writeFileSync(join(realNested, "c.json"), JSON.stringify({ room: "2026-11-15T00:00:00Z" }));

    const symAnc = join(dir, "sym-anc");
    symlinkSync(realRoot, symAnc);
    const viaAnc = join(symAnc, "nested", "c.json");

    const loadWarnings: string[] = [];
    expect(loadCursor(viaAnc, (m) => loadWarnings.push(m)).size).toBe(0);
    expect(loadWarnings.join("")).toMatch(/could not read/);

    const persistWarnings: string[] = [];
    expect(persistCursor(viaAnc, new Map([["room", "2026-11-15T01:00:00Z"]]), (m) => persistWarnings.push(m))).toBe(false);
    expect(persistWarnings.join("")).toMatch(/parent is not a real directory/);

    // Secret tokens in warning paths/errors are scrubbed before emission
    const secretWarns: string[] = [];
    const badPath = join(dir, "missing-dir-mcp_at_secret1234567890", "c.json");
    expect(persistCursor(badPath, new Map([["room", "ts"]]), (m) => secretWarns.push(m))).toBe(false);
    expect(secretWarns.join("")).not.toContain("secret1234567890");
    expect(secretWarns.join("")).toContain("REDACTED");

    // Persisting 50,005 entries trims oldest 5 so loadCursor (MAX_CURSOR_ENTRIES=50,000) round-trips cleanly!
    const bigMap = new Map<string, string>();
    for (let i = 0; i < 50_005; i++) bigMap.set(`ch-${i}`, "2026-11-15T00:00:00Z");
    const bigFile = join(dir, "big.json");
    const bigWarns: string[] = [];
    expect(persistCursor(bigFile, bigMap, (m) => bigWarns.push(m))).toBe(true);
    const reloaded = loadCursor(bigFile, (m) => bigWarns.push(m));
    expect(bigWarns).toEqual([]);
    expect(reloaded.size).toBe(50_000);
    expect(reloaded.has("ch-0")).toBe(false);
    expect(reloaded.has("ch-50004")).toBe(true);
  });
});
