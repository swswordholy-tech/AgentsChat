import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { assertDirectoryAncestors, atomicReplaceRegularFile } from "./config.ts";
import { normalizeTimestampForCursor } from "../src/timestamps.ts";

interface Snapshot {
  version: 1;
  channels: Record<string, string>;
  last_check_at?: string;
  last_success_at?: string;
  last_error?: string;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid history timestamp");
  const normalized = normalizeTimestampForCursor(value, "after");
  if (!normalized || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/.test(normalized)) throw new Error("Invalid history timestamp");
  return normalized;
}
function validChannel(channel: unknown): channel is string {
  return typeof channel === "string" && channel.length > 0 && channel.length <= 128 && channel === channel.trim() && channel !== "."
    && !channel.includes("..") && !/[\/\\]/.test(channel)
    && !/%(?:2e%2e|2f|5c|00)/i.test(channel)
    && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(channel)
    && !["__proto__", "constructor", "prototype"].includes(channel.trim().toLowerCase());
}
function validateChannel(channel: unknown): asserts channel is string {
  if (!validChannel(channel)) throw new Error("Invalid inbound channel");
}

/** REST checkpoints, independent of live WS delivery. Advancing a live cursor
 * could otherwise jump over messages that were silently lost before it. */
export class InboxSync {
  private file: string;
  private state: Snapshot;
  private channels = new Set<string>();
  private running?: Promise<void>;
  constructor(stateDir: string, private api: (path: string) => Promise<any>,
    private receive: (message: unknown) => boolean, private active: () => boolean,
    private log: (message: string) => void = console.error) {
    const existing = lstatSync(stateDir, { throwIfNoEntry: false });
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error("Invalid inbound state directory");
    assertDirectoryAncestors(stateDir);
    mkdirSync(stateDir, {recursive:true, mode:0o700});
    const dirStat = lstatSync(stateDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("Invalid inbound state directory");
    if (process.platform !== "win32") chmodSync(stateDir, 0o700);
    this.file = join(stateDir, "inbound-cursors.json");
    let fileStat;
    try { fileStat = lstatSync(this.file); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (fileStat && (fileStat.isSymbolicLink() || !fileStat.isFile())) throw new Error("Invalid inbound cursors file");
    if (fileStat && fileStat.size > 1_048_576) throw new Error("Inbound cursors exceed size limit");
    this.state = fileStat ? JSON.parse(readFileSync(this.file, "utf8")) : {version:1, channels:{}};
    if (!this.state || typeof this.state !== "object" || Array.isArray(this.state) || Object.hasOwn(this.state, "__proto__") || this.state.version !== 1 || !this.state.channels || typeof this.state.channels !== "object" || Array.isArray(this.state.channels) ||
      Object.hasOwn(this.state.channels, "__proto__") || Object.keys(this.state.channels).length > 1024)
      throw new Error("Invalid inbound cursors; refusing to discard checkpoint");
    const channels: Record<string, string> = Object.create(null);
    for (const [channel, value] of Object.entries(this.state.channels)) {
      if (!validChannel(channel)) continue;
      timestamp(value);
      channels[channel] = value;
    }
    this.state.channels = channels;
  }
  private save() {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
    let created = false;
    try {
      writeFileSync(tmp, JSON.stringify(this.state), {mode:0o600, flag:"wx"});
      created = true;
      atomicReplaceRegularFile(tmp, this.file, () => {
        const current = lstatSync(this.file, { throwIfNoEntry: false });
        if (current && (current.isSymbolicLink() || !current.isFile())) throw new Error("Invalid inbound cursors file");
      });
    } catch (err) {
      if (created) { try { unlinkSync(tmp); } catch {} }
      throw err;
    }
  }
  watch(channel: string) {
    validateChannel(channel);
    if (!Object.hasOwn(this.state.channels, channel) && Object.keys(this.state.channels).length >= 1024) throw new Error("Inbound channel limit exceeded");
    this.channels.add(channel);
    // First installation/new membership starts now, never replays old requests.
    if (!Object.hasOwn(this.state.channels, channel)) {
      this.state.channels[channel] = timestamp(new Date().toISOString()); this.save();
    }
  }
  memberships(channels: string[]) {
    for (const channel of channels) validateChannel(channel);
    if (new Set([...Object.keys(this.state.channels), ...channels]).size > 1024) throw new Error("Inbound channel limit exceeded");
    this.channels = new Set(channels);
    let changed = false;
    for (const channel of this.channels) {
      if (!Object.hasOwn(this.state.channels, channel)) {
        this.state.channels[channel] = timestamp(new Date().toISOString());
        changed = true;
      }
    }
    if (changed) this.save();
  }
  sync(): Promise<void> {
    if (!this.running) this.running = this.run().finally(() => {this.running = undefined;});
    return this.running;
  }
  private async run() {
    if (!this.active()) return;
    let failed = false;
    for (const channel of [...this.channels]) {
      if (!this.active()) return;
      try {
        const after = this.state.channels[channel]!;
        const body = await this.api(`/api/channels/${encodeURIComponent(channel)}/messages?after=${encodeURIComponent(after)}&limit=50`);
        if (!this.active()) return;
        if (!this.channels.has(channel)) continue;
        const messages = Array.isArray(body) ? body : body?.messages;
        if (!Array.isArray(messages)) throw new Error("Invalid history response");
        const rows = messages.map(m => {
          if (!m || m.channel_id !== channel || typeof m.id !== "string" || m.id.trim().length === 0 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(m.id)) throw new Error("Invalid history message");
          return {message:m, time:timestamp(m.timestamp)};
        }).sort((a,b) => a.time.localeCompare(b.time));
        // One bounded page per channel per pass. Full pages continue next pass.
        // The inbox persists acceptance before we persist this checkpoint.
        let newest = after, complete = true;
        for (const {message,time} of rows) {
          if (time <= after) continue;
          if (!this.receive(message)) { complete = false; break; }
          newest = time;
        }
        // Commit whole pages so backpressure cannot skip an equal-time sibling.
        // Already queued rows deduplicate on retry.
        if (complete) { this.state.channels[channel] = newest; this.save(); }
      } catch {
        failed = true;
        this.log("Inbound history reconciliation failed; checkpoint retained for retry");
      }
    }
    if (!this.active()) return;
    this.state.last_check_at = new Date().toISOString();
    if (failed) this.state.last_error = "History reconciliation failed; retry pending";
    else { this.state.last_success_at = this.state.last_check_at; delete this.state.last_error; }
    this.save();
  }
}
