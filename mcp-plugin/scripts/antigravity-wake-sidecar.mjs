#!/usr/bin/env node
/**
 * Official Antigravity Sidecar wake bridge for AgentsChat.
 *
 * Designed to be managed by Antigravity App (`~/.gemini/config/sidecars/agentschat-wake/sidecar.json`),
 * where Antigravity injects `agentapi` (and `ANTIGRAVITY_LS_ADDRESS`) into the child environment.
 * Exposes a strict loopback HTTP endpoint (`127.0.0.1:0`, HMAC-SHA256 authenticated) whose
 * connection descriptor is written atomically (`0600`) to `~/.agentschat/antigravity-sidecar.json`.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_PROMPT_CHARS = 32_768;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_HEADER = "x-agentschat-signature";
const AGENTAPI_BIN = (process.env.AGENTSCHAT_AGENTAPI_BIN || "").trim() || "agentapi";
const STATE_FILE =
  (process.env.AGENTSCHAT_AGY_SIDECAR_STATE || "").trim() ||
  path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".agentschat", "antigravity-sidecar.json");

const SECRET = crypto.randomBytes(32).toString("hex");
const recipientQueues = new Map();

function writeStateFileAtomically(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing && existing.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink state file: ${filePath}`);
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const json = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(tmpPath, json, { mode: 0o600, encoding: "utf8" });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
}

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
  return new Promise((resolve) => {
    execFile(
      AGENTAPI_BIN,
      ["send-message", `--title=${title}`, recipient, prompt],
      {
        shell: false,
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
process.on("exit", cleanupStateFile);

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
    process.stderr.write(`[agentschat-wake-sidecar] Listening on 127.0.0.1:${addr.port} (pid=${process.pid})\n`);
  } catch (err) {
    process.stderr.write(`[agentschat-wake-sidecar] Failed to write state file: ${String(err)}\n`);
    process.exit(1);
  }
});
