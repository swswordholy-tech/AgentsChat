import { existsSync, mkdirSync, readdirSync, accessSync, constants, lstatSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { assertDirectoryAncestors, type CodexHomeMode } from "./config.ts";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

function executablePath(bin: string): string | undefined {
  if (!bin || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(bin)) return undefined;
  const exts = process.platform === "win32" && !/\.[A-Za-z0-9]+$/.test(bin)
    ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
    : [""];
  const bases = isAbsolute(bin) || bin.includes("/") || bin.includes("\\")
    ? [resolve(bin)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, bin));
  for (const base of bases) {
    for (const ext of exts) {
      const candidate = base + ext;
      try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { /* Try the next PATH entry. */ }
    }
  }
}

function assertDirectoryLeaf(path: string, label: string) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info?.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (info && !info.isDirectory()) throw new Error(`${label} must be a directory`);
}

function prepareHomeDirectory(stateDir: string, home: string) {
  assertDirectoryLeaf(stateDir, "Bot state directory");
  assertDirectoryLeaf(home, "Bot runtime home");
  assertDirectoryAncestors(stateDir);
  assertDirectoryAncestors(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

/** Inspect metadata only; never follow a runtime-state link into another home. */
function assertIndependentTree(home: string, allowedAuthOrigin?: string, codexExecutable?: string) {
  if (lstatSync(home).isSymbolicLink()) throw new Error("Independent Codex home must not be a symlink");
  const inspect = (dir: string, depth = 0) => {
    if (depth > 32) throw new Error("Independent Codex home directory depth exceeds 32");
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), info = lstatSync(path);
      if (info.isSymbolicLink()) {
        if (dir === home && name === "auth.json" && allowedAuthOrigin && resolve(home, readlinkSync(path)) === allowedAuthOrigin) continue;
        // Official Codex creates these executable aliases and SIGKILL can leave
        // them behind. Permit only the known shape and this launcher's exact binary.
        const local = relative(home, path).split(sep).join("/");
        if (codexExecutable && /^tmp\/arg0\/codex-arg0[A-Za-z0-9_-]+\/(apply_patch|applypatch|codex-execve-wrapper|codex-linux-sandbox)$/.test(local)) {
          try { if (realpathSync(path) === codexExecutable) continue; } catch { /* Broken alias: fail closed. */ }
        }
        throw new Error("Independent Codex home must not link configuration or runtime state");
      }
      if (info.isDirectory()) inspect(path, depth + 1);
      else if (!info.isFile()) throw new Error("Independent Codex home must contain only regular files and directories");
    }
  };
  inspect(home);
}

/** Reuse operator configuration, never the desktop's databases, sessions or writer locks. */
export function prepareRuntimeHome(stateDir: string, source = process.env.CODEX_HOME || join(homedir(), ".codex"), mode: CodexHomeMode = "linked", codexBin = "codex") {
  if (mode !== "linked" && mode !== "isolated" && mode !== "auth-only") throw new Error("Invalid Codex home mode");
  // Isolated mode deliberately never inspects, copies or links source configuration.
  // Authentication must be set up independently by the operator, with permission.
  if (mode === "isolated") {
    const home = join(stateDir, "codex-home-isolated");
    prepareHomeDirectory(stateDir, home);
    assertIndependentTree(home, undefined, executablePath(codexBin));
    return { home: realpathSync(home) };
  }
  if (mode === "auth-only") {
    const legacyHome = realpathSync(source);
    const origin = join(legacyHome, "auth.json");
    const originStat = lstatSync(origin, { throwIfNoEntry: false });
    if (!originStat || originStat.isSymbolicLink() || !originStat.isFile()) {
      throw new Error("auth-only requires an existing regular auth.json; authorize its use explicitly");
    }
    const home = join(stateDir, "codex-home-auth-only");
    prepareHomeDirectory(stateDir, home);
    if (lstatSync(home).isSymbolicLink() || realpathSync(home) === legacyHome) throw new Error("auth-only home must be independent");
    // A reused directory must not smuggle in unrelated configuration or plugins.
    for (const name of ["config.toml", "AGENTS.md", "rules", "plugins", "hooks.json"]) {
      try { lstatSync(join(home, name)); } catch (e: any) { if (e.code === "ENOENT") continue; throw e; }
      throw new Error("auth-only home contains unexpected configuration; use a fresh state root");
    }
    const skills = join(home, "skills");
    const skillsInfo = lstatSync(skills, { throwIfNoEntry: false });
    if (skillsInfo && (skillsInfo.isSymbolicLink() || !skillsInfo.isDirectory() || readdirSync(skills).some(name => name !== ".system")))
      throw new Error("auth-only home contains unexpected custom skills");
    assertIndependentTree(home, origin, executablePath(codexBin));
    const target = join(home, "auth.json");
    try {
      if (!lstatSync(target).isSymbolicLink() || resolve(home, readlinkSync(target)) !== origin) throw new Error("Unexpected auth-only login binding");
    } catch (e: any) { if (e.code !== "ENOENT") throw e; symlinkSync(origin, target); }
    assertIndependentTree(home, origin, executablePath(codexBin));
    return { home: realpathSync(home) };
  }
  const legacyHome = existsSync(source) ? realpathSync(source) : resolve(source);
  const home = join(stateDir, "codex-home");
  prepareHomeDirectory(stateDir, home);
  if (realpathSync(home) === legacyHome) throw new Error("Bot runtime home must differ from desktop Codex home");
  if (lstatSync(home).isSymbolicLink()) throw new Error("Bot runtime home must not be a symlink");
  for (const name of ["config.toml", "auth.json", "AGENTS.md", "skills", "rules", "plugins", "hooks.json", "models_cache.json"]) {
    const origin = join(legacyHome, name), target = join(home, name);
    if (!existsSync(origin)) continue;
    let current;
    try { current = lstatSync(target); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    if (current) {
      if (!current.isSymbolicLink() || resolve(home, readlinkSync(target)) !== origin)
        throw new Error(`Unexpected bot runtime configuration: ${name}`);
    } else symlinkSync(origin, target);
  }
  return {home, legacyHome};
}
