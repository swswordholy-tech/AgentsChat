#!/usr/bin/env node
/**
 * Official Antigravity Sidecar wake bridge for AgentsChat.
 *
 * Designed to be managed by Antigravity App (`~/.gemini/config/sidecars/agentschat-wake/sidecar.json`),
 * where Antigravity injects `agentapi` (and `ANTIGRAVITY_LS_ADDRESS`) into the child environment.
 * Exposes a strict loopback HTTP endpoint (`127.0.0.1:0`, HMAC-SHA256 authenticated) whose
 * connection descriptor is written atomically (`0600` on POSIX) to `~/.agentschat/antigravity-sidecar.json`.
 *
 * Cross-platform (macOS / Linux / Windows):
 * - On Windows, Node's `execFile(..., { shell: false })` cannot directly execute `.bat`/`.cmd` shims
 *   (CVE-2024-27980 / CreateProcessW). We resolve `agentapi.bat`/`agentapi.cmd` directly to the
 *   underlying `language_server.exe` (or `agentapi.exe`) and invoke it with `shell: false, windowsHide: true`,
 *   preserving exact multiline prompts with zero shell-injection surface.
 * - Atomic state file replacement handles Windows `EPERM`/`EACCES`/`EBUSY` when replacing an existing file.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_PROMPT_CHARS = 32_768;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_HEADER = "x-agentschat-signature";
const WINDOWS_LS_EXE_NAMES = [
  "language_server.exe",
  "language_server_windows_x64.exe",
  "language_server_windows_arm64.exe",
];

function isLanguageServerBinary(filePath, pathApi) {
  const base = pathApi.basename(String(filePath || "")).toLowerCase();
  return /^language_server[^\\/]*(\.exe)?$/.test(base);
}

function stripOuterQuotes(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function expandWinEnvVars(raw, env, dirWithSep) {
  let out = raw.replace(/%~dp0[\\/]?/gi, dirWithSep);
  out = out.replace(/%([A-Za-z0-9_()]+)%/g, (full, name) => {
    const exact = env[name];
    if (typeof exact === "string" && exact.length > 0) return exact;
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(env)) {
      if (k.toLowerCase() === lower && typeof v === "string" && v.length > 0) return v;
    }
    return full;
  });
  return out;
}

/**
 * Parse a Windows `.bat` / `.cmd` shim (e.g. Antigravity's `agentapi.bat`) to locate
 * the underlying `.exe` binary and any static prefix arguments (e.g. `["agentapi"]`),
 * so we can call `execFile(exe, [...prefixArgs, ...], { shell: false })` safely without cmd.exe.
 */
export function parseBatchExecTarget(batchFilePath, batchContent, opts = {}) {
  if (typeof batchContent !== "string" || !batchContent.trim()) return null;
  const pathApi = opts.pathApi || path.win32;
  const existsSyncFn = opts.existsSyncFn || fs.existsSync;
  const env = opts.env || process.env;
  const batchDir = pathApi.dirname(batchFilePath);
  const dirWithSep = batchDir.endsWith(pathApi.sep) ? batchDir : `${batchDir}${pathApi.sep}`;

  for (const rawLine of batchContent.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^(?:@?echo\b|rem\b|::|@?setlocal\b|@?endlocal\b|@?set\b|@?if\b|@?goto\b|@?exit\b|:)/i.test(line)) {
      continue;
    }
    line = line.replace(/^@+/, "").trim();
    if (/^call\s+/i.test(line)) {
      line = line.replace(/^call\s+/i, "").trim();
    }
    if (!line) continue;

    let exeToken = "";
    let rest = "";
    if (line.startsWith('"')) {
      const closeIdx = line.indexOf('"', 1);
      if (closeIdx <= 1) continue;
      exeToken = line.slice(1, closeIdx);
      rest = line.slice(closeIdx + 1).trim();
    } else {
      const m = line.match(/^(\S+)([\s\S]*)$/);
      if (!m) continue;
      exeToken = m[1];
      rest = (m[2] || "").trim();
    }

    const expandedExe = expandWinEnvVars(exeToken, env, dirWithSep);
    if (!/\.exe$/i.test(expandedExe)) continue;

    const resolvedExe = pathApi.isAbsolute(expandedExe)
      ? pathApi.normalize(expandedExe)
      : pathApi.resolve(batchDir, expandedExe);
    if (!existsSyncFn(resolvedExe)) continue;

    const prefixArgs = [];
    if (rest) {
      const tokens = rest.match(/"[^"]*"|\S+/g) || [];
      for (const tok of tokens) {
        const cleaned = stripOuterQuotes(tok);
        if (!cleaned) continue;
        if (/^%(?:~?[0-9*]|~[a-z]+[0-9])$/i.test(cleaned)) break;
        if (/^[0-9]?>>?&?[0-9]?/.test(cleaned) || cleaned === "|" || cleaned === "&" || cleaned === "&&") break;
        prefixArgs.push(cleaned);
      }
    }
    if (prefixArgs.length === 0 && isLanguageServerBinary(resolvedExe, pathApi)) {
      prefixArgs.push("agentapi");
    }
    return { command: resolvedExe, prefixArgs };
  }
  return null;
}

/**
 * Resolve the executable and fixed prefix args for invoking `agentapi send-message`.
 * Always returns a direct executable (never `.bat`/`.cmd` via `cmd.exe`) when possible.
 */
export function resolveAgentApiCommand(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const existsSyncFn = opts.existsSyncFn || fs.existsSync;
  const readFileSyncFn = opts.readFileSyncFn || fs.readFileSync;
  const isWin = platform === "win32";
  const pathApi = opts.pathApi || (isWin ? path.win32 : path.posix);
  const explicit = stripOuterQuotes(env.AGENTSCHAT_AGENTAPI_BIN || "");
  const home = (env.HOME || env.USERPROFILE || (isWin ? "" : os.homedir()) || "").trim();

  const buildExeResult = (exePath) => ({
    command: exePath,
    prefixArgs: isLanguageServerBinary(exePath, pathApi) ? ["agentapi"] : [],
  });

  if (!isWin) {
    if (explicit) return buildExeResult(explicit);
    if (home) {
      const agyShim = pathApi.join(home, ".gemini", "antigravity", "bin", "agentapi");
      if (existsSyncFn(agyShim)) {
        return { command: agyShim, prefixArgs: [] };
      }
    }
    return { command: "agentapi", prefixArgs: [] };
  }

  const resolveFromBatch = (batPath) => {
    try {
      const content = readFileSyncFn(batPath, "utf8");
      const parsed = parseBatchExecTarget(batPath, content, { existsSyncFn, pathApi, env });
      if (parsed) return parsed;
    } catch {}
    const dir = pathApi.dirname(batPath);
    for (const candidateName of ["agentapi.exe", ...WINDOWS_LS_EXE_NAMES]) {
      const candidate = pathApi.join(dir, candidateName);
      if (existsSyncFn(candidate)) return buildExeResult(candidate);
    }
    return null;
  };

  let unresolvedBatch = "";

  if (explicit) {
    if (/\.(?:bat|cmd)$/i.test(explicit)) {
      const resolved = resolveFromBatch(explicit);
      if (resolved) return resolved;
      unresolvedBatch = explicit;
    } else {
      return buildExeResult(explicit);
    }
  }

  // Search PATH + Antigravity's default bin directories
  const rawPath = env.PATH || env.Path || "";
  const searchDirs = [];
  const seenDirs = new Set();
  const pushDir = (dir) => {
    const clean = stripOuterQuotes(dir);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seenDirs.has(key)) return;
    seenDirs.add(key);
    searchDirs.push(clean);
  };

  if (home) pushDir(pathApi.join(home, ".gemini", "antigravity", "bin"));
  for (const seg of rawPath.split(";")) pushDir(seg);
  if (env.LOCALAPPDATA) {
    pushDir(pathApi.join(env.LOCALAPPDATA, "Programs", "Antigravity", "resources", "bin"));
  }
  if (env.ProgramFiles) {
    pushDir(pathApi.join(env.ProgramFiles, "Antigravity", "resources", "bin"));
  }
  if (env["ProgramFiles(x86)"]) {
    pushDir(pathApi.join(env["ProgramFiles(x86)"], "Antigravity", "resources", "bin"));
  }

  for (const dir of searchDirs) {
    const directAgentApiExe = pathApi.join(dir, "agentapi.exe");
    if (existsSyncFn(directAgentApiExe)) return buildExeResult(directAgentApiExe);

    for (const shimName of ["agentapi.cmd", "agentapi.bat"]) {
      const shimPath = pathApi.join(dir, shimName);
      if (existsSyncFn(shimPath)) {
        const resolved = resolveFromBatch(shimPath);
        if (resolved) return resolved;
        if (!unresolvedBatch) unresolvedBatch = shimPath;
      }
    }

    for (const lsName of WINDOWS_LS_EXE_NAMES) {
      const lsPath = pathApi.join(dir, lsName);
      if (existsSyncFn(lsPath)) return buildExeResult(lsPath);
    }
  }

  return {
    command: explicit || "agentapi.exe",
    prefixArgs: [],
    ...(unresolvedBatch ? { unresolvedBatch } : {}),
  };
}

/**
 * Write the sidecar state JSON atomically without following symlinks, with
 * Windows compatibility when replacing an existing file (`EPERM`/`EACCES`/`EBUSY`).
 */
export function writeStateFileAtomically(filePath, data, opts = {}) {
  const fsApi = opts.fs || fs;
  const platform = opts.platform || process.platform;
  const dir = path.dirname(filePath);
  fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = fsApi.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing && existing.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink state file: ${filePath}`);
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const json = JSON.stringify(data, null, 2) + "\n";
  try {
    fsApi.writeFileSync(tmpPath, json, { mode: 0o600, encoding: "utf8" });
    if (platform !== "win32") {
      try {
        fsApi.chmodSync(tmpPath, 0o600);
      } catch {}
    }
    try {
      fsApi.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      const code = renameErr && typeof renameErr === "object" ? renameErr.code : "";
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY", "EEXIST"].includes(code)) {
        throw renameErr;
      }
      // Windows does not always allow rename over an existing/briefly-locked destination.
      const recheck = fsApi.lstatSync(filePath, { throwIfNoEntry: false });
      if (recheck && recheck.isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symlink state file: ${filePath}`);
      }
      try {
        if (recheck) fsApi.unlinkSync(filePath);
        fsApi.renameSync(tmpPath, filePath);
      } catch {
        const finalCheck = fsApi.lstatSync(filePath, { throwIfNoEntry: false });
        if (finalCheck && finalCheck.isSymbolicLink()) {
          throw new Error(`Refusing to overwrite symlink state file: ${filePath}`);
        }
        fsApi.writeFileSync(filePath, json, { encoding: "utf8" });
        try {
          fsApi.unlinkSync(tmpPath);
        } catch {}
      }
    }
  } catch (err) {
    try {
      fsApi.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

function startSidecarServer() {
  const STATE_FILE =
    (process.env.AGENTSCHAT_AGY_SIDECAR_STATE || "").trim() ||
    path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".agentschat", "antigravity-sidecar.json");

  const SECRET = crypto.randomBytes(32).toString("hex");
  const recipientQueues = new Map();

  function cleanupStateFile() {
    try {
      const st = fs.lstatSync(STATE_FILE, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink() || !st.isFile() || st.size > 65536) return;
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Number(parsed.pid) === process.pid) {
        fs.unlinkSync(STATE_FILE);
      }
    } catch {}
  }

  function verifySignature(rawBody, headerValue) {
    if (typeof headerValue !== "string") return false;
    const trimmed = headerValue.trim();
    const sigHex = trimmed.toLowerCase().startsWith("sha256=") ? trimmed.slice(7).trim() : trimmed;
    if (!/^[0-9a-f]{64}$/i.test(sigHex)) return false;
    const sigBuf = Buffer.from(sigHex, "hex");
    const expected = crypto.createHmac("sha256", SECRET).update(rawBody, "utf8").digest();
    if (sigBuf.length !== expected.length) return false;
    return crypto.timingSafeEqual(sigBuf, expected);
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let settled = false;
      req.on("data", (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          settled = true;
          const err = new Error("Payload Too Large");
          err.statusCode = 413;
          reject(err);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  function enqueueForRecipient(recipient, task) {
    const prev = recipientQueues.get(recipient) || Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    recipientQueues.set(recipient, tail);
    tail.finally(() => {
      if (recipientQueues.get(recipient) === tail) {
        recipientQueues.delete(recipient);
      }
    });
    return next;
  }

  function runAgentApiSendMessage({ recipient, title, prompt }) {
    const target = resolveAgentApiCommand();
    if (target.unresolvedBatch) {
      return Promise.resolve({
        ok: false,
        error: `Could not resolve .exe target from ${path.basename(target.unresolvedBatch)}; set AGENTSCHAT_AGENTAPI_BIN to language_server.exe`,
      });
    }
    const args = [...target.prefixArgs, "send-message", `--title=${title}`, recipient, prompt];
    return new Promise((resolve) => {
      execFile(
        target.command,
        args,
        {
          shell: false,
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          env: process.env,
        },
        (error, _stdout, stderr) => {
          if (!error) {
            resolve({ ok: true });
            return;
          }
          const detail = String(stderr || error.message || "agentapi failed")
            .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
            .trim()
            .slice(0, 180);
          resolve({ ok: false, error: detail || "agentapi failed" });
        },
      );
    });
  }

  function sendJson(res, statusCode, obj) {
    const payload = JSON.stringify(obj);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && reqUrl.pathname === "/health") {
        sendJson(res, 200, { ok: true, pid: process.pid });
        return;
      }

      if (req.method === "POST" && reqUrl.pathname === "/wake") {
        let rawBody;
        try {
          rawBody = await readJsonBody(req);
        } catch (err) {
          if (err && err.statusCode === 413) {
            sendJson(res, 413, { ok: false, error: "payload_too_large" });
          } else {
            sendJson(res, 400, { ok: false, error: "bad_request_body" });
          }
          return;
        }

        if (!verifySignature(rawBody, req.headers[SIG_HEADER])) {
          sendJson(res, 401, { ok: false, error: "invalid_signature" });
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
          return;
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.prototype.hasOwnProperty.call(parsed, "__proto__")
        ) {
          sendJson(res, 400, { ok: false, error: "invalid_payload_shape" });
          return;
        }

        const recipient = String(parsed.recipient || parsed.target_session_id || "").trim();
        if (!UUID_RE.test(recipient)) {
          sendJson(res, 400, { ok: false, error: "invalid_recipient_uuid" });
          return;
        }

        const rawPrompt = typeof parsed.prompt === "string" ? parsed.prompt.replace(/\0/g, "").trim() : "";
        if (!rawPrompt || rawPrompt.length > MAX_PROMPT_CHARS) {
          sendJson(res, 400, { ok: false, error: "invalid_prompt" });
          return;
        }
        const safePrompt = rawPrompt.startsWith("-") ? ` ${rawPrompt}` : rawPrompt;

        const rawTitle = typeof parsed.display_title === "string" ? parsed.display_title : "AgentsChat";
        const safeTitle =
          rawTitle.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").trim().slice(0, 128) || "AgentsChat";

        const result = await enqueueForRecipient(recipient, () =>
          runAgentApiSendMessage({ recipient, title: safeTitle, prompt: safePrompt }),
        );
        if (result.ok) {
          process.stderr.write(`[agentschat-wake-sidecar] Delivered wake to ${recipient.slice(0, 8)}...\n`);
          sendJson(res, 200, { ok: true });
        } else {
          process.stderr.write(
            `[agentschat-wake-sidecar] Delivery failed for ${recipient.slice(0, 8)}: ${result.error}\n`,
          );
          sendJson(res, 502, { ok: false, error: "agentapi_failed" });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      process.stderr.write(`[agentschat-wake-sidecar] Unexpected error: ${String(err)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "internal_error" });
      }
    }
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[agentschat-wake-sidecar] Shutting down (${signal})\n`);
    cleanupStateFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => shutdown("SIGBREAK"));
  }
  process.on("exit", cleanupStateFile);

  const initialTarget = resolveAgentApiCommand();
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      process.stderr.write("[agentschat-wake-sidecar] Failed to bind loopback port\n");
      process.exit(1);
    }
    const url = `http://127.0.0.1:${addr.port}/wake`;
    try {
      writeStateFileAtomically(STATE_FILE, {
        url,
        secret: SECRET,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      const targetDesc = initialTarget.unresolvedBatch
        ? `unresolved(${path.basename(initialTarget.unresolvedBatch)})`
        : `${path.basename(initialTarget.command)}${initialTarget.prefixArgs.length ? ` ${initialTarget.prefixArgs.join(" ")}` : ""}`;
      process.stderr.write(
        `[agentschat-wake-sidecar] Listening on 127.0.0.1:${addr.port} (pid=${process.pid}, target=${targetDesc})\n`,
      );
    } catch (err) {
      process.stderr.write(`[agentschat-wake-sidecar] Failed to write state file: ${String(err)}\n`);
      process.exit(1);
    }
  });
}

function isEntrypointModule() {
  const arg = process.argv[1];
  if (typeof arg !== "string" || !arg.trim()) return false;
  try {
    const resolvedArg = fs.realpathSync(path.resolve(arg));
    const resolvedSelf = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32"
      ? resolvedArg.toLowerCase() === resolvedSelf.toLowerCase()
      : resolvedArg === resolvedSelf;
  } catch {
    const a = path.resolve(arg);
    const b = fileURLToPath(import.meta.url);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
}

if (isEntrypointModule()) {
  startSidecarServer();
}
