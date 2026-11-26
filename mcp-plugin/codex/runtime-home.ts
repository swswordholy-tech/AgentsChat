import { existsSync, mkdirSync, readdirSync, accessSync, constants, lstatSync, readlinkSync, realpathSync, symlinkSync, linkSync, statSync, type Stats } from "node:fs";
import { assertDirectoryAncestors, type CodexHomeMode } from "./config.ts";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

const RUNTIME_CTRL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

export interface RuntimeHomeLinkDeps {
  platform?: NodeJS.Platform;
  symlinkSync?: (target: Parameters<typeof symlinkSync>[0], path: Parameters<typeof symlinkSync>[1], type?: Parameters<typeof symlinkSync>[2]) => void;
  linkSync?: (existingPath: Parameters<typeof linkSync>[0], newPath: Parameters<typeof linkSync>[1]) => void;
}

function normalizeOrigin(origin: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return origin;
  return origin.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "").replace(/[\\/]+$/, "").toLowerCase();
}

function normalizeLinkTarget(baseDir: string, linkValue: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return resolve(baseDir, linkValue);
  const stripped = linkValue.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
  return resolve(baseDir, stripped).replace(/[\\/]+$/, "").toLowerCase();
}

function sameResolvedLink(baseDir: string, linkValue: string, origin: string, platform: NodeJS.Platform): boolean {
  return normalizeLinkTarget(baseDir, linkValue, platform) === normalizeOrigin(origin, platform);
}

function sameHardLinkFile(targetPath: string, originPath: string): boolean {
  try {
    const targetStat = lstatSync(targetPath, { bigint: true });
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) return false;
    const originStat = statSync(originPath, { bigint: true });
    if (!originStat.isFile()) return false;
    return targetStat.dev === originStat.dev && targetStat.ino === originStat.ino && targetStat.ino > 0n && targetStat.nlink >= 2n;
  } catch {
    return false;
  }
}

function isExpectedRuntimeLink(current: Stats, home: string, target: string, origin: string, isDir: boolean, platform: NodeJS.Platform): boolean {
  if (current.isSymbolicLink()) return sameResolvedLink(home, readlinkSync(target), origin, platform);
  // POSIX keeps strict symlink-only guarantees; Windows falls back to same-volume hard links for unprivileged file linking.
  if (platform === "win32" && !isDir && current.isFile()) return sameHardLinkFile(target, origin);
  return false;
}

function createRuntimeLink(origin: string, target: string, name: string, isDir: boolean, deps: Required<RuntimeHomeLinkDeps>): void {
  if (deps.platform !== "win32") {
    deps.symlinkSync(origin, target);
    return;
  }
  if (isDir) {
    try {
      deps.symlinkSync(origin, target, "junction");
      return;
    } catch (e: any) {
      if (e?.code === "EPERM" || e?.code === "EACCES") {
        throw new Error(`Windows could not create a directory junction for Codex ${name}; check permissions or use --codex-home-mode isolated`);
      }
      throw e;
    }
  }
  try {
    deps.symlinkSync(origin, target, "file");
    return;
  } catch (e: any) {
    if (e?.code !== "EPERM" && e?.code !== "EACCES") throw e;
  }
  const linkSource = lstatSync(origin).isSymbolicLink() ? realpathSync(origin) : origin;
  try {
    deps.linkSync(linkSource, target);
  } catch (linkErr: any) {
    if (linkErr?.code === "EXDEV" || linkErr?.code === "EPERM" || linkErr?.code === "EACCES") {
      throw new Error(`Windows could not link Codex ${name} without symlink privilege or same-drive hard link; enable Windows Developer Mode, keep state_root on the same drive as CODEX_HOME, or use --codex-home-mode isolated`);
    }
    throw linkErr;
  }
}

function executablePath(bin: string): string | undefined {
  if (!bin || RUNTIME_CTRL_RE.test(bin)) return undefined;
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
function assertIndependentTree(home: string, allowedAuthOrigin?: string, codexExecutable?: string, platform: NodeJS.Platform = process.platform) {
  if (lstatSync(home).isSymbolicLink()) throw new Error("Independent Codex home must not be a symlink");
  const inspect = (dir: string, depth = 0) => {
    if (depth > 32) throw new Error("Independent Codex home directory depth exceeds 32");
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), info = lstatSync(path);
      if (info.isSymbolicLink()) {
        if (dir === home && name === "auth.json" && allowedAuthOrigin && sameResolvedLink(home, readlinkSync(path), allowedAuthOrigin, platform)) continue;
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
export function prepareRuntimeHome(
  stateDir: string,
  source = process.env.CODEX_HOME || join(homedir(), ".codex"),
  mode: CodexHomeMode = "linked",
  codexBin = "codex",
  deps: RuntimeHomeLinkDeps = {},
) {
  const linkDeps: Required<RuntimeHomeLinkDeps> = {
    platform: deps.platform ?? process.platform,
    symlinkSync: deps.symlinkSync ?? symlinkSync,
    linkSync: deps.linkSync ?? linkSync,
  };
  if (mode !== "linked" && mode !== "isolated" && mode !== "auth-only") throw new Error("Invalid Codex home mode");
  if (typeof stateDir !== "string" || !stateDir.trim() || stateDir.length > 4096 || RUNTIME_CTRL_RE.test(stateDir)) {
    throw new Error("Invalid bot state directory");
  }
  // Isolated mode deliberately never inspects, copies or links source configuration.
  // Authentication must be set up independently by the operator, with permission.
  if (mode === "isolated") {
    const home = join(stateDir, "codex-home-isolated");
    prepareHomeDirectory(stateDir, home);
    assertIndependentTree(home, undefined, executablePath(codexBin), linkDeps.platform);
    return { home: realpathSync(home) };
  }
  if (typeof source !== "string" || !source.trim() || source.length > 4096 || RUNTIME_CTRL_RE.test(source)) {
    throw new Error("Invalid Codex source home");
  }
  assertDirectoryLeaf(source, "Source Codex home");
  assertDirectoryAncestors(source);
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
    assertIndependentTree(home, origin, executablePath(codexBin), linkDeps.platform);
    const target = join(home, "auth.json");
    let current;
    try { current = lstatSync(target); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    if (current) {
      if (!isExpectedRuntimeLink(current, home, target, origin, false, linkDeps.platform)) {
        throw new Error("Unexpected auth-only login binding");
      }
    } else {
      createRuntimeLink(origin, target, "auth.json", false, linkDeps);
    }
    assertIndependentTree(home, origin, executablePath(codexBin), linkDeps.platform);
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
    const isDir = statSync(origin).isDirectory();
    let current;
    try { current = lstatSync(target); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    if (current) {
      if (!isExpectedRuntimeLink(current, home, target, origin, isDir, linkDeps.platform))
        throw new Error(`Unexpected bot runtime configuration: ${name}`);
    } else createRuntimeLink(origin, target, name, isDir, linkDeps);
  }
  return {home, legacyHome};
}
