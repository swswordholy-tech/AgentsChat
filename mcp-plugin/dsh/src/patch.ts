import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface DshPatchFsOps {
  renameSync?: typeof renameSync;
  copyFileSync?: typeof copyFileSync;
}

export interface DshPatchOptions {
  dshHome?: string;
  dshProfile?: string;
  agentsChatProfile?: string;
  apiUrl?: string;
  packageSpec?: string;
  fsOps?: DshPatchFsOps;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DARWIN_ROOT_LINKS = new Set(["/var", "/tmp", "/etc"]);
const DSH_PATCH_CTRL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const DSH_PATCH_PRETRIM_CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029]/;

function isAllowedDarwinSystemLink(dirPath: string): boolean {
  if (process.platform !== "darwin" || !DARWIN_ROOT_LINKS.has(dirPath)) return false;
  try {
    const priv = lstatSync("/private");
    if (priv.isSymbolicLink() || !priv.isDirectory()) return false;
    const real = realpathSync(dirPath);
    if (real !== `/private${dirPath}`) return false;
    const target = lstatSync(real);
    return !target.isSymbolicLink() && target.isDirectory();
  } catch {
    return false;
  }
}

function checkRawDotDotAncestors(rawPath: string): void {
  const trimmed = rawPath.trim();
  if (!trimmed || !isAbsolute(trimmed)) return;
  const normalizedSep = process.platform === "win32" ? trimmed.replace(/\//g, "\\") : trimmed;
  const sepChar = process.platform === "win32" ? "\\" : "/";
  const parts = normalizedSep.split(sepChar);
  if (!parts.includes("..")) return;
  const winDrive = process.platform === "win32" && /^[A-Za-z]:$/.test(parts[0] || "");
  let current = winDrive ? `${parts[0]}\\` : sepChar;
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i]!;
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = current.endsWith(sepChar) ? `${current}${seg}` : `${current}${sepChar}${seg}`;
    if (i < parts.length - 1 || parts.slice(i + 1).includes("..")) {
      if (!isAllowedDarwinSystemLink(candidate)) {
        try {
          const stat = lstatSync(candidate);
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`Refusing symlinked or non-directory parent: ${candidate}`);
          }
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
      }
    }
    current = candidate;
  }
}

export function checkParentDirectory(path: string): void {
  if (typeof path !== "string" || !path.trim() || DSH_PATCH_CTRL_RE.test(path)) {
    throw new Error("Invalid DSH target path");
  }
  checkRawDotDotAncestors(path);
  let parent = dirname(resolve(path));
  for (;;) {
    if (!isAllowedDarwinSystemLink(parent)) {
      try {
        const stat = lstatSync(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`Refusing symlinked or non-directory parent: ${parent}`);
        }
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

function isBlockedNormalizedHost(host: string): boolean {
  if (!host) return true;
  if (
    host === "0.0.0.0" ||
    /^0\./.test(host) ||
    host === "::" ||
    host === "0:0:0:0:0:0:0:0" ||
    host === "100.100.100.200" ||
    host === "fd00:ec2::254" ||
    host === "fd00:ec2:0:0:0:0:0:254" ||
    host === "metadata" ||
    host === "instance-data" ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") ||
    host === "metadata.goog" ||
    host.endsWith(".metadata.goog") ||
    /^169\.254\./.test(host)
  ) {
    return true;
  }
  if (
    /^::ffff:(?:0:)?(?:a9fe:[0-9a-f]{1,4}|169\.254\.\d{1,3}\.\d{1,3}|6464:64c8|100\.100\.100\.200|[0-9a-f]{1,2}:[0-9a-f]{1,4}|0\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(
      host,
    ) ||
    /^(?:0:){5}ffff:(?:a9fe:[0-9a-f]{1,4}|169\.254\.\d{1,3}\.\d{1,3}|6464:64c8|100\.100\.100\.200|[0-9a-f]{1,2}:[0-9a-f]{1,4}|0\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(
      host,
    )
  ) {
    return true;
  }
  const first = host.split(":")[0];
  return host.includes(":") && /^[0-9a-f]{1,4}$/.test(first!) && (parseInt(first!, 16) & 0xffc0) === 0xfe80;
}

/** URL.hostname is canonicalized by WHATWG URL, including IPv4-in-IPv6. */
export function isBlockedDshHost(hostname: string): boolean {
  const raw = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (isBlockedNormalizedHost(raw)) return true;
  try {
    const bracketed = raw.includes(":") ? `[${raw}]` : raw;
    const canonical = new URL(`http://${bracketed}`).hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
    if (canonical && canonical !== raw && isBlockedNormalizedHost(canonical)) return true;
  } catch {
    // Non-parseable host handled by caller's URL parser.
  }
  return false;
}

export function resolveDshPatchPath(opts: DshPatchOptions = {}): string {
  const home = opts.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  if (!home || home.length > 4096 || home.startsWith("-") || !isAbsolute(home) || DSH_PATCH_CTRL_RE.test(home)) {
    throw new Error("Invalid DSH home path");
  }
  if (opts.dshProfile !== undefined) {
    if (typeof opts.dshProfile !== "string" || DSH_PATCH_PRETRIM_CTRL_RE.test(opts.dshProfile)) {
      throw new Error("Invalid DSH profile name");
    }
    const profile = opts.dshProfile.trim();
    if (
      !profile ||
      profile.length > 64 ||
      !/^[A-Za-z0-9._-]+$/.test(profile) ||
      profile === "." ||
      profile.includes("..") ||
      FORBIDDEN_KEYS.has(profile.toLowerCase())
    ) {
      throw new Error("Invalid DSH profile name");
    }
    return join(home, "profiles", profile, "cordis.patch.yml");
  }
  return join(home, "cordis.patch.yml");
}

export function buildMcpAgentsChatArgs(opts: DshPatchOptions = {}): string[] {
  const rawPkg = opts.packageSpec ?? "agentschat-mcp@latest";
  if (typeof rawPkg !== "string" || DSH_PATCH_PRETRIM_CTRL_RE.test(rawPkg)) {
    throw new Error("Invalid packageSpec");
  }
  const pkg = rawPkg.trim();
  if (!pkg || pkg.startsWith("-") || /[\x00-\x20\x7f-\x9f\u2028\u2029]/.test(pkg)) {
    throw new Error("Invalid packageSpec");
  }
  const args = ["-y", pkg];
  if (opts.agentsChatProfile !== undefined && opts.agentsChatProfile !== "") {
    if (typeof opts.agentsChatProfile !== "string" || DSH_PATCH_PRETRIM_CTRL_RE.test(opts.agentsChatProfile)) {
      throw new Error("Invalid AgentsChat profile name");
    }
    const profile = opts.agentsChatProfile.trim();
    if (
      !profile ||
      profile.length > 64 ||
      profile.startsWith("-") ||
      profile.includes("..") ||
      profile.includes("/") ||
      profile.includes("\\") ||
      FORBIDDEN_KEYS.has(profile.toLowerCase()) ||
      DSH_PATCH_CTRL_RE.test(profile)
    ) {
      throw new Error("Invalid AgentsChat profile name");
    }
    args.push("--profile", profile);
  }
  if (opts.apiUrl !== undefined && opts.apiUrl !== "") {
    if (typeof opts.apiUrl !== "string" || DSH_PATCH_PRETRIM_CTRL_RE.test(opts.apiUrl)) {
      throw new Error("Invalid AgentsChat API URL");
    }
    const rawUrl = opts.apiUrl.trim();
    if (!rawUrl || rawUrl.startsWith("-") || /[\x00-\x20\x7f-\x9f\u2028\u2029]/.test(rawUrl)) {
      throw new Error("Invalid AgentsChat API URL");
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error("Invalid AgentsChat API URL");
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    if (
      isBlockedDshHost(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.port === "0" || parsed.search || parsed.hash ||
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback))
    ) {
      throw new Error("Invalid AgentsChat API URL");
    }
    args.push("--url", rawUrl);
  }
  return args;
}

function yamlQuote(val: string): string {
  if (/^[A-Za-z0-9._/@:-]+$/.test(val)) return `'${val}'`;
  return JSON.stringify(val);
}

/**
 * Render the YAML lines for an `- id: mcp-agentschat` entry at a given indent.
 */
export function renderMcpAgentsChatEntry(indent: string, opts: DshPatchOptions = {}): string {
  const args = buildMcpAgentsChatArgs(opts);
  const lines = [
    `${indent}- id: mcp-agentschat`,
    `${indent}  name: '@deepseek-ai/dsh-mcp-client'`,
    `${indent}  config:`,
    `${indent}    serverName: agentschat`,
    `${indent}    transport: stdio`,
    `${indent}    command: npx`,
    `${indent}    args:`,
    ...args.map((a) => `${indent}      - ${yamlQuote(a)}`),
  ];
  return lines.join("\n");
}

/**
 * Idempotently merge the `mcp-agentschat` entry into a DSH `cordis.patch.yml`
 * document string while preserving existing comments and entries (such as
 * machine-local `openai-fetch-proxy` or UI settings overrides).
 */
export function mergeDshCordisPatch(existingContent: string, opts: DshPatchOptions = {}): {
  content: string;
  changed: boolean;
} {
  if (/(?:^|\n)\s*-\s*id:\s*['"]?mcp-agentschat['"]?(?:\s|$)/m.test(existingContent)) {
    return { content: existingContent, changed: false };
  }

  const trimmed = existingContent.trim();

  // Case 1: Empty file or comments-only or empty YAML array `[]`
  const withoutComments = existingContent
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .trim();

  if (!trimmed || withoutComments === "" || withoutComments === "[]") {
    const commentLines = existingContent
      .split("\n")
      .filter((line) => /^\s*#/.test(line));
    const prefix = commentLines.length > 0 ? `${commentLines.join("\n")}\n` : "";
    const block = `- insert:\n${renderMcpAgentsChatEntry("    ", opts)}\n`;
    return { content: `${prefix}${block}`, changed: true };
  }

  // Case 2: File already has a top-level `- insert:` block (e.g. ~/.dsh/cordis.patch.yml).
  // Splice inside THAT `- insert:` block (preserving its child indent and stopping before
  // any subsequent top-level `- replace:` / `- delete:` block so multi-block files stay valid YAML).
  const normalizedLines = existingContent.replace(/\r\n/g, "\n").split("\n");
  const insertLineIdx = normalizedLines.findIndex((line) => /^-\s*insert:\s*(?:#.*)?$/.test(line));
  if (insertLineIdx >= 0) {
    let detectedIndent: string | null = null;
    let lastBodyLineIdx = insertLineIdx;
    for (let i = insertLineIdx + 1; i < normalizedLines.length; i++) {
      const line = normalizedLines[i]!;
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
      if (/^\S/.test(line)) break;
      const itemMatch = line.match(/^([ \t]+)-\s+/);
      if (itemMatch && detectedIndent === null) {
        detectedIndent = itemMatch[1]!;
      }
      lastBodyLineIdx = i;
    }
    const entryLines = renderMcpAgentsChatEntry(detectedIndent ?? "    ", opts).split("\n");
    normalizedLines.splice(lastBodyLineIdx + 1, 0, ...entryLines);
    const merged = normalizedLines.join("\n");
    return {
      content: merged.endsWith("\n") ? merged : `${merged}\n`,
      changed: true,
    };
  }

  // Case 3: File is a top-level YAML array of patch entries (like profiles/desktop/cordis.patch.yml)
  const normalized = existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
  const block = `- insert:\n${renderMcpAgentsChatEntry("    ", opts)}\n`;
  return {
    content: `${normalized}${block}`,
    changed: true,
  };
}

export function applyDshCordisPatchFile(opts: DshPatchOptions = {}): {
  patchPath: string;
  changed: boolean;
} {
  const rawHome = opts.dshHome ?? process.env.DSH_HOME;
  if (rawHome) {
    checkRawDotDotAncestors(`${rawHome}/_`);
  }
  const patchPath = resolveDshPatchPath(opts);
  checkParentDirectory(patchPath);
  let existed = false;
  let mode = 0o600;
  try {
    const lst = lstatSync(patchPath);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new Error(`Refusing to modify non-regular or symlinked DSH patch file: ${patchPath}`);
    }
    if (lst.size > 1_048_576) {
      throw new Error(`Refusing to modify oversized DSH patch file (>1MiB): ${patchPath}`);
    }
    existed = true;
    mode = lst.mode & 0o777;
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  const existing = existed ? readFileSync(patchPath, "utf8") : "";
  const { content, changed } = mergeDshCordisPatch(existing, opts);
  if (changed) {
    mkdirSync(dirname(patchPath), { recursive: true });
    checkParentDirectory(patchPath);
    const tmp = `${patchPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    let created = false;
    try {
      writeFileSync(tmp, content, { encoding: "utf8", mode, flag: "wx" });
      created = true;
      checkParentDirectory(patchPath);
      try {
        const cur = lstatSync(patchPath);
        if (cur.isSymbolicLink() || !cur.isFile()) {
          throw new Error(`Refusing to overwrite symlinked or non-regular DSH patch file: ${patchPath}`);
        }
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }
      const doRename = opts.fsOps?.renameSync ?? renameSync;
      const doCopy = opts.fsOps?.copyFileSync ?? copyFileSync;
      try {
        doRename(tmp, patchPath);
      } catch (renameErr: any) {
        if (renameErr?.code !== "EPERM" && renameErr?.code !== "EACCES") {
          throw renameErr;
        }
        checkParentDirectory(patchPath);
        try {
          const cur = lstatSync(patchPath);
          if (cur.isSymbolicLink() || !cur.isFile()) {
            throw new Error(`Refusing to overwrite symlinked or non-regular DSH patch file: ${patchPath}`);
          }
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
        doCopy(tmp, patchPath);
        try {
          unlinkSync(tmp);
        } catch {}
        created = false;
      }
      if (process.platform !== "win32") {
        try {
          chmodSync(patchPath, mode);
        } catch {}
      }
    } catch (err) {
      try {
        if (created) unlinkSync(tmp);
      } catch {}
      throw err;
    }
  }
  return { patchPath, changed };
}
