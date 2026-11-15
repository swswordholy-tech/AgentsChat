import { assertDirectoryAncestors } from "./config.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";

export type GuiTool = "send_message_to_thread" | "read_thread";
/** Must execute inside an authorized Codex desktop host. No standalone App Server fallback. */
export type GuiToolCaller = (tool: GuiTool, args: Record<string, unknown>) => Promise<unknown>;
export interface GuiDelivery {
  id: string; threadId: string; hostId?: string; prompt: string;
  status: "pending" | "sending" | "submitted" | "delivered" | "uncertain";
  createdAt: string; deliveredAt?: string; turnId?: string;
}
function payload(result: any): any {
  if (result?.isError || result?.success === false || result?.error) throw new Error("GUI tool rejected request");
  if (Array.isArray(result?.content)) {
    const text = result.content.find((c: any) => c.type === "text")?.text;
    if (!text) throw new Error("GUI tool returned no receipt");
    if (typeof text !== "string" || text.length > 1_048_576) throw new Error("GUI receipt exceeds size limit");
    const parsed = JSON.parse(text);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "__proto__")) throw new Error("Invalid GUI receipt");
    return parsed;
  }
  return result;
}
function validTarget(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length >= 1 && value.length <= 256 && value !== "." && value !== ".." &&
    !/[\/\\\x00-\x1f\x7f]/.test(value) && !["__proto__", "prototype", "constructor"].includes(value.toLowerCase());
}
/** Private durable outbox. An authorized GUI host calls dispatch; enqueue is NOT delivery. */
export class GuiChannel {
  constructor(private directory: string, private allowedThreads: readonly string[]) {
    const existing = lstatSync(directory, { throwIfNoEntry: false });
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error("GUI outbox must be a real directory, not a symlink");
    assertDirectoryAncestors(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("GUI outbox must be a real directory, not a symlink");
  }
  private path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid delivery ID");
    return join(this.directory, `${id}.json`);
  }
  private save(entry: GuiDelivery) {
    const path = this.path(entry.id), temp = `${path}.${randomUUID()}.tmp`;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new Error("GUI receipt must be a regular file, not a symlink");
    try {
      writeFileSync(temp, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current && (current.isSymbolicLink() || !current.isFile())) throw new Error("GUI receipt must be a regular file, not a symlink");
      renameSync(temp, path);
    } catch (error) {
      // An exclusive-create collision belongs to another writer; leave it alone.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") rmSync(temp, { force: true });
      throw error;
    }
  }
  get(id: string): GuiDelivery {
    const path = this.path(id), stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("GUI receipt must be a regular file, not a symlink");
    if (stat.size > 1_048_576) throw new Error("GUI receipt exceeds size limit");
    const entry = JSON.parse(readFileSync(path, "utf8"));
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.prototype.hasOwnProperty.call(entry, "__proto__") || entry.id !== id ||
      !validTarget(entry.threadId) || typeof entry.prompt !== "string" ||
      typeof entry.createdAt !== "string" ||
      !["pending", "sending", "submitted", "delivered", "uncertain"].includes(entry.status) ||
      (entry.hostId !== undefined && !validTarget(entry.hostId)) ||
      (entry.turnId !== undefined && typeof entry.turnId !== "string") ||
      (entry.deliveredAt !== undefined && typeof entry.deliveredAt !== "string")) throw new Error("Invalid GUI receipt");
    return entry;
  }
  list(): GuiDelivery[] {
    const entries: GuiDelivery[] = [];
    for (const file of readdirSync(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      try { entries.push(this.get(file.slice(0, -5))); } catch { /* Isolate damaged or unsafe receipts. */ }
    }
    return entries;
  }
  enqueue(threadId: string, text: string, hostId?: string): GuiDelivery {
    if (!validTarget(threadId) || (hostId !== undefined && !validTarget(hostId))) throw new Error("Invalid GUI target");
    if (!this.allowedThreads.includes(threadId)) throw new Error("GUI target is not allowed");
    if (!text.trim() || text.length > 24000) throw new Error("GUI message must contain 1–24000 characters");
    const id = randomUUID();
    const entry: GuiDelivery = { id, threadId, ...(hostId ? {hostId} : {}),
      prompt: `[AgentsChat delivery ${id}]\n${text}`, status: "pending", createdAt: new Date().toISOString() };
    this.save(entry); return entry;
  }
  async dispatch(id: string, call: GuiToolCaller): Promise<GuiDelivery> {
    const lock = `${this.path(id)}.lock`;
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(lock);
      if (stat.isSymbolicLink()) throw new Error("GUI delivery lock must not be a symlink");
      if (!stat.isDirectory() || Date.now() - stat.mtimeMs <= 5 * 60_000) throw error;
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock, { mode: 0o700 });
    }
    try {
      const entry = this.get(id);
      if (!this.allowedThreads.includes(entry.threadId)) throw new Error("GUI target is no longer allowed");
      if (entry.status === "delivered") return entry;
      const target = {threadId: entry.threadId, ...(entry.hostId ? {hostId: entry.hostId} : {})};
      if (entry.status === "pending") {
        entry.status = "sending"; this.save(entry);
        try {
          payload(await call("send_message_to_thread", {...target, prompt: entry.prompt}));
          entry.status = "submitted"; this.save(entry);
        } catch {
          entry.status = "uncertain"; this.save(entry);
          // A timeout may follow acceptance. Read back; never automatically send twice.
        }
      }
      if (entry.status === "sending") { entry.status = "uncertain"; this.save(entry); }
      try {
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        for (let page = 0; page < 5; page++) {
          const history = payload(await call("read_thread", {...target, turnLimit: 10,
            maxOutputCharsPerItem: 32000, ...(cursor ? {cursor} : {})}));
          if (history?.thread?.id !== entry.threadId) throw new Error("Wrong GUI thread in receipt");
          const turn = history.turns?.find((t: any) => t.items?.some((item: any) =>
            item.type === "userMessage" && item.content?.some((c: any) => c.type === "text" && c.text === entry.prompt)));
          if (turn) {
            entry.status = "delivered"; entry.deliveredAt = new Date().toISOString(); entry.turnId = turn.id;
            this.save(entry); break;
          }
          const nextCursor = history.page?.nextCursor;
          if (typeof nextCursor !== "string" || !nextCursor.length || seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor); cursor = nextCursor;
        }
      } catch { /* Keep submitted/uncertain; an unavailable read is not proof of failure. */ }
      return entry;
    } finally { rmSync(lock, {recursive: true, force: true}); }
  }
}
