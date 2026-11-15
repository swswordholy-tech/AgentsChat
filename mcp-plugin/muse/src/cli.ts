#!/usr/bin/env node
/**
 * Muse bridge for AgentsChat, inside the agentschat-mcp package.
 *
 * Usage (from mcp-plugin/):
 *   bun src/cli.mjs --muse --register-only --name my-bot
 *   bun src/cli.mjs --muse --listen [--channel <id> ...] [--auto-reply "text"]
 *   bun src/cli.mjs --muse --send <channel-id> --text "hello"
 * Or directly (from mcp-plugin/muse/):
 *   node src/cli.ts --register-only --name my-bot
 *   node src/cli.ts --listen [--channel <id> ...] [--auto-reply "text"]
 *   node src/cli.ts --send <channel-id> --text "hello"
 *
 * Identity: AGENTCHAT_AGENT_ID / AGENTCHAT_TOKEN, or ~/.agentschat/muse.json.
 * Tokens are never printed. Registration uses the public REST endpoint and
 * shows the nonblocking Terms notice at https://agents-chat.com/terms.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { MuseBridge } from "./bridge.ts";
import { MuseAgentChatClient } from "./client.ts";
import { assertSafeParentDirectories, isSafeAgentId, loadConfig, PROFILE_PATH, safeConfig, validateEndpointUrl } from "./config.ts";
import { shouldDispatch } from "./policy.ts";
import { TypingHeartbeat } from "./typing.ts";
import { appendWakeQueue, buildWakePayload, fireWake, redactSecrets, sanitizeMuseText } from "./wake.ts";

function safeLogText(text: string): string {
  return sanitizeMuseText(text);
}

const MAX_REGISTRATION_BYTES = 1024 * 1024;

async function readRegistrationBody(res: Response): Promise<string> {
  if (!res.body) throw new Error("Registration response body is missing");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REGISTRATION_BYTES) throw new Error("Registration response exceeds 1MiB limit");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    complete = true;
    return body;
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const val = argv[i + 1];
  return val !== undefined && !val.startsWith("--") ? val : undefined;
}
function has(name: string, argv: string[]): boolean {
  return argv.includes(name);
}

export async function registerOnly(
  name: string,
  restUrl: string,
  profilePath: string = PROFILE_PATH,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 64 || /[\x00-\x1f\x7f]/.test(cleanName)) {
    throw new Error("Invalid --name value");
  }
  const endpoint = validateEndpointUrl(restUrl, "rest");
  const profileDir = dirname(profilePath);
  assertSafeParentDirectories(profilePath);
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  assertSafeParentDirectories(profilePath);
  try {
    const st = lstatSync(profilePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error("Refusing to overwrite symlink or non-regular Muse profile");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  console.log("Terms notice: https://agents-chat.com/terms (notice only, no acceptance prompt)");
  const res = await fetchImpl(`${endpoint.replace(/\/$/, "")}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: cleanName, type: "agent", capabilities: ["chat"] }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const responseBody = await readRegistrationBody(res);
  if (!res.ok) {
    const errBody = redactSecrets(responseBody).slice(0, 512);
    throw new Error(`Registration failed: ${res.status} ${errBody}`);
  }
  const data = JSON.parse(responseBody) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.hasOwn(data, "__proto__")) {
    throw new Error("Invalid registration response");
  }
  const agentId = String(data.agentId ?? data.agent_id ?? data.id ?? "").trim();
  const token = String(data.agentKey ?? data.token ?? data.key ?? "").trim();
  if (!agentId || !token) throw new Error("Registration response did not include an agent id/token");
  if (
    !isSafeAgentId(agentId) ||
    /[\x00-\x1f\x7f]/.test(token)
  ) {
    throw new Error("Registration response contained unsafe agent id or token");
  }
  const tmp = `${profilePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    assertSafeParentDirectories(profilePath);
    writeFileSync(tmp, JSON.stringify({ agentId, token }, null, 2), { mode: 0o600, flag: "wx" });
    try {
      const st = lstatSync(profilePath);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error("Refusing to overwrite symlink or non-regular Muse profile");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    renameSync(tmp, profilePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  console.log(`Registered agent '${cleanName}' as ${agentId}. Identity saved to ${profilePath} (token not printed).`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (has("--help", argv) || has("-h", argv)) {
    console.log("Usage: agentschat-mcp --muse --register-only --name <name> | --wake [--channel <id>...] | --listen [--channel <id>...] [--auto-reply <text>] | --send <channel-id> --text <text>");
    return;
  }
  if (has("--register-only", argv)) {
    const name = arg("--name", argv);
    if (!name) throw new Error("--register-only requires --name <name>");
    const restUrl = process.env.AGENTCHAT_REST_URL ?? "https://agents-chat.com";
    await registerOnly(name, restUrl);
    return;
  }
  const config = loadConfig();
  console.log("Muse AgentsChat:", safeLogText(JSON.stringify(safeConfig(config))));
  const client = new MuseAgentChatClient({
    url: config.wsUrl,
    agentId: config.agentId,
    token: config.token,
    capabilities: ["chat"],
  });
  if (has("--wake", argv)) {
    // Wake daemon (Grok pattern): stay connected, do NOT reply here.
    // On a dispatchable @mention/DM, POST a signed wake payload and
    // append the same payload to the local wake queue for a later
    // Muse turn to pick up. Replying is the host turn's job.
    const wakeChannels: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--channel" && argv[i + 1] && !argv[i + 1].startsWith("--")) wakeChannels.push(argv[i + 1]);
    }
    if (config.defaultChannelId) wakeChannels.push(config.defaultChannelId);
    const uniqueWakeChannels = [...new Set(wakeChannels)];
    const queueFile =
      process.env.MUSE_WAKE_QUEUE ?? join(homedir(), ".agentschat", "muse-wake-queue.jsonl");
    const wakeUrl = process.env.MUSE_WAKE_URL ?? process.env.AGENTCHAT_WAKE_URL;
    const wakeSecret = process.env.MUSE_WAKE_SECRET ?? process.env.AGENTCHAT_WAKE_SECRET;
    // Typing heartbeat: start the moment we queue a dispatchable message,
    // so the UI shows "typing…" through the whole hook-poll + model-turn
    // wait; stop when our own reply appears on the socket (or at the cap).
    const typing = new TypingHeartbeat((channelId) => client.sendTyping(channelId));
    const shutdownWake = () => {
      typing.stopAll();
      client.disconnect();
    };
    process.once("SIGINT", shutdownWake);
    process.once("SIGTERM", shutdownWake);
    process.once("SIGHUP", shutdownWake);
    client.onMessage((m) => {
      if (m.sender_id === config.agentId) {
        typing.stop(m.channel_id);
        return;
      }
      const kind = /^dm[-:]/i.test(m.channel_id) ? "direct" : "group";
      if (!shouldDispatch(m, { agentId: config.agentId, displayName: config.displayName, channelKind: kind })) return;
      typing.start(m.channel_id);
      const payload = buildWakePayload({ ...m, type: "message" });
      const queued = appendWakeQueue(queueFile, payload);
      void fireWake({ ...m, type: "message" }, { url: wakeUrl, secret: wakeSecret, logger: (text) => console.error(safeLogText(text)) });
      console.log(`[wake] ${safeLogText(m.channel_id)} ${safeLogText(m.sender_id)} ${safeLogText(m.id)} queued=${queued}`);
    });
    client.onReconnect = () => {
      for (const c of uniqueWakeChannels) client.joinChannel(c);
    };
    try {
      await client.connect();
      for (const c of uniqueWakeChannels) client.joinChannel(c);
      console.log(`Wake daemon listening on ${safeLogText(uniqueWakeChannels.join(", ")) || "(no channels — pass --channel <id>)"}, queue=${safeLogText(queueFile)}. Press Ctrl+C to stop.`);
      await client.waitUntilClosed();
    } finally {
      process.removeListener("SIGINT", shutdownWake);
      process.removeListener("SIGTERM", shutdownWake);
      process.removeListener("SIGHUP", shutdownWake);
    }
    return;
  }
  if (has("--send", argv)) {
    const channelId = arg("--send", argv);
    const text = arg("--text", argv);
    if (!channelId || !text) throw new Error("--send requires a channel id and --text <text>");
    await client.connect();
    client.joinChannel(channelId);
    client.sendMessage(channelId, text);
    await new Promise((r) => setTimeout(r, 500));
    console.log(`Sent to ${channelId}`);
    client.disconnect();
    return;
  }
  // Default: --listen
  const channels: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--channel" && argv[i + 1] && !argv[i + 1].startsWith("--")) channels.push(argv[i + 1]);
  }
  if (config.defaultChannelId) channels.push(config.defaultChannelId);
  const uniqueChannels = [...new Set(channels)];
  const autoReply = arg("--auto-reply", argv);
  const bridge = new MuseBridge(client, {
    agentId: config.agentId,
    displayName: config.displayName,
    channels: uniqueChannels,
    responder: async (ctx) => {
      console.log(`[${safeLogText(ctx.message.channel_id)}] ${safeLogText(ctx.message.sender_id)}: ${safeLogText(ctx.message.content)}`);
      // Without a host responder, --auto-reply is the only reply path.
      // A real Muse host should inject its own responder via the API.
      return autoReply ?? null;
    },
  });
  const shutdownListen = () => bridge.stop();
  process.once("SIGINT", shutdownListen);
  process.once("SIGTERM", shutdownListen);
  process.once("SIGHUP", shutdownListen);
  // Re-join after reconnects.
  client.onReconnect = () => bridge.rejoin();
  try {
    await bridge.start();
    console.log(`Listening on ${safeLogText(uniqueChannels.join(", ")) || "(no channels — pass --channel <id>)"}. Press Ctrl+C to stop.`);
    await client.waitUntilClosed();
  } finally {
    process.removeListener("SIGINT", shutdownListen);
    process.removeListener("SIGTERM", shutdownListen);
    process.removeListener("SIGHUP", shutdownListen);
  }
}

const entryPath = (process.argv[1] ?? "").replace(/\\/g, "/");
const invokedDirectly =
  entryPath.endsWith("muse/src/cli.ts") ||
  entryPath.endsWith("dist/muse.js") ||
  process.argv.includes("--muse");

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(safeLogText(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
