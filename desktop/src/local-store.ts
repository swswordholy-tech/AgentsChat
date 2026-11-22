import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite, type SqliteDb } from "./sqlite-adapter.js";
import type {
  LocalChannel,
  LocalChannelMember,
  LocalChannelType,
  LocalMemberRole,
  LocalMessage,
  PrincipalKind,
  VerifiedPrincipal,
} from "./types.js";

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export function isValidPrincipalOrChannelId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (!trimmed || !SAFE_ID_RE.test(trimmed)) return false;
  if (trimmed === "." || trimmed.includes("..")) return false;
  const lower = trimmed.toLowerCase();
  if (lower === "__proto__" || lower === "constructor" || lower === "prototype") return false;
  return true;
}

export function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function constantTimeHexEqual(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length || aHex.length === 0 || aHex.length % 2 !== 0) return false;
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function deterministicDirectChannelId(idA: string, idB: string): string {
  const pair = [idA.trim(), idB.trim()].sort();
  const digest = createHash("sha256").update(`${pair[0]}\0${pair[1]}`, "utf8").digest("hex").slice(0, 10);
  return `dm-${digest}`;
}

export class LocalStore {
  readonly db: SqliteDb;

  constructor(dbPath = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = openSqlite(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'user')),
        display_name TEXT NOT NULL,
        owner_id TEXT,
        claimed INTEGER NOT NULL DEFAULT 0,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        token_sha256 TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_principals_token_hash ON principals(token_sha256);

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('group', 'project', 'direct')),
        topic TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        joined_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, principal_id),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('agent', 'human')),
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text',
        in_reply_to TEXT,
        mentioned_ids_json TEXT NOT NULL DEFAULT '[]',
        edited_at TEXT,
        deleted_at TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel_id, seq);

      CREATE TABLE IF NOT EXISTS read_cursors (
        channel_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        last_read_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, principal_id)
      );
    `);

    const now = new Date().toISOString();
    const existingWelcome = this.db.prepare("SELECT id FROM channels WHERE id = ?").get("welcome");
    if (!existingWelcome) {
      this.db
        .prepare(
          `INSERT INTO channels (id, name, type, topic, visibility, created_by, created_at, updated_at)
           VALUES (?, ?, 'group', ?, 'public', 'system', ?, ?)`,
        )
        .run(
          "welcome",
          "welcome",
          "Local AgentsChat Hub — connect local agents with global AgentsChat identities for group & DM collaboration.",
          now,
          now,
        );
    }
  }

  close(): void {
    this.db.close();
  }

  // ── Verified Global Principals ──────────────────────────────────────────

  upsertVerifiedPrincipal(params: {
    id: string;
    kind: PrincipalKind;
    display_name: string;
    owner_id?: string | null;
    claimed?: boolean;
    capabilities?: string[];
    raw_token: string;
    expires_at?: string | null;
  }): VerifiedPrincipal {
    if (!isValidPrincipalOrChannelId(params.id)) {
      throw new Error(`Invalid principal id: ${params.id}`);
    }
    const now = new Date().toISOString();
    const cleanName = String(params.display_name || params.id).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 120) || params.id;
    const caps = Array.isArray(params.capabilities)
      ? params.capabilities.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim().slice(0, 64)).slice(0, 24)
      : [];
    const tokenHash = sha256Hex(params.raw_token);
    const claimedInt = params.claimed ? 1 : 0;
    const ownerId = params.owner_id ? String(params.owner_id).trim() : null;
    const expiresAt = params.expires_at ?? null;

    this.db
      .prepare(
        `INSERT INTO principals (id, kind, display_name, owner_id, claimed, capabilities_json, token_sha256, verified_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           display_name = excluded.display_name,
           owner_id = COALESCE(excluded.owner_id, principals.owner_id),
           claimed = CASE WHEN excluded.claimed = 1 THEN 1 ELSE principals.claimed END,
           capabilities_json = CASE WHEN excluded.capabilities_json != '[]' THEN excluded.capabilities_json ELSE principals.capabilities_json END,
           token_sha256 = excluded.token_sha256,
           verified_at = excluded.verified_at,
           expires_at = excluded.expires_at`,
      )
      .run(params.id, params.kind, cleanName, ownerId, claimedInt, JSON.stringify(caps), tokenHash, now, expiresAt);

    return this.getPrincipalById(params.id)!;
  }

  findCachedPrincipalByToken(rawToken: string, nowMs = Date.now()): VerifiedPrincipal | null {
    if (!rawToken || typeof rawToken !== "string") return null;
    const targetHash = sha256Hex(rawToken);
    const rows = this.db
      .prepare("SELECT * FROM principals WHERE token_sha256 = ?")
      .all(targetHash);
    for (const row of rows) {
      if (!row || typeof row.token_sha256 !== "string") continue;
      if (!constantTimeHexEqual(row.token_sha256, targetHash)) continue;
      if (row.expires_at) {
        const expMs = Date.parse(row.expires_at);
        if (Number.isFinite(expMs) && expMs <= nowMs) {
          continue;
        }
      }
      return this.mapPrincipalRow(row);
    }
    return null;
  }

  invalidateToken(rawToken: string): void {
    const targetHash = sha256Hex(rawToken);
    this.db.prepare("DELETE FROM principals WHERE token_sha256 = ?").run(targetHash);
  }

  getPrincipalById(id: string): VerifiedPrincipal | null {
    const row = this.db.prepare("SELECT * FROM principals WHERE id = ?").get(id);
    return row ? this.mapPrincipalRow(row) : null;
  }

  listPrincipals(): VerifiedPrincipal[] {
    const rows = this.db.prepare("SELECT * FROM principals ORDER BY verified_at DESC").all();
    return rows.map((r) => this.mapPrincipalRow(r));
  }

  private mapPrincipalRow(row: any): VerifiedPrincipal {
    let caps: string[] = [];
    try {
      const parsed = JSON.parse(row.capabilities_json || "[]");
      if (Array.isArray(parsed)) caps = parsed;
    } catch {}
    return {
      id: String(row.id),
      kind: row.kind === "user" ? "user" : "agent",
      display_name: String(row.display_name || row.id),
      owner_id: row.owner_id ? String(row.owner_id) : null,
      claimed: Boolean(row.claimed),
      capabilities: caps,
      verified_at: String(row.verified_at),
      expires_at: row.expires_at ? String(row.expires_at) : null,
    };
  }

  // ── Channels (Group, Project & 1v1 Direct) ──────────────────────────────

  getChannel(channelId: string): LocalChannel | null {
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId);
    return row ? this.mapChannelRow(row) : null;
  }

  listChannelsForPrincipal(principalId?: string | null, onlyJoined = false): Array<LocalChannel & { member_count: number }> {
    const rows = onlyJoined && principalId
      ? this.db
          .prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM channel_members cm2 WHERE cm2.channel_id = c.id) AS member_count
             FROM channels c
             INNER JOIN channel_members cm ON cm.channel_id = c.id AND cm.principal_id = ?
             ORDER BY c.updated_at DESC`,
          )
          .all(principalId)
      : this.db
          .prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM channel_members cm2 WHERE cm2.channel_id = c.id) AS member_count
             FROM channels c
             WHERE c.visibility = 'public'
                OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.principal_id = ?))
             ORDER BY c.updated_at DESC`,
          )
          .all(principalId ?? null, principalId ?? null);

    return rows.map((r) => ({
      ...this.mapChannelRow(r),
      member_count: Number(r.member_count || 0),
    }));
  }

  createChannel(params: {
    id?: string;
    name?: string;
    type?: LocalChannelType;
    topic?: string;
    visibility?: "public" | "private";
    creatorId: string;
    memberIds?: string[];
  }): LocalChannel {
    const type: LocalChannelType =
      params.type === "direct" ? "direct" : params.type === "project" ? "project" : "group";
    const uniqueMembers = Array.from(
      new Set([params.creatorId, ...(params.memberIds || [])].map((m) => m.trim()).filter(isValidPrincipalOrChannelId)),
    );

    if (type === "direct") {
      if (uniqueMembers.length !== 2) {
        throw new Error("Direct channel requires exactly 2 distinct participant IDs");
      }
      const dmId = deterministicDirectChannelId(uniqueMembers[0], uniqueMembers[1]);
      const existing = this.getChannel(dmId);
      if (existing) {
        for (const m of uniqueMembers) this.addMember(dmId, m, "member");
        return existing;
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO channels (id, name, type, topic, visibility, created_by, created_at, updated_at)
           VALUES (?, ?, 'direct', '', 'private', ?, ?, ?)`,
        )
        .run(dmId, `${uniqueMembers[0]} ↔ ${uniqueMembers[1]}`, params.creatorId, now, now);
      for (const m of uniqueMembers) {
        this.addMember(dmId, m, "member");
      }
      return this.getChannel(dmId)!;
    }

    const rawId = params.id?.trim() || `room-${randomUUID().slice(0, 8)}`;
    if (!isValidPrincipalOrChannelId(rawId) || rawId.startsWith("dm-")) {
      throw new Error(`Invalid group channel ID: ${rawId}`);
    }
    if (this.getChannel(rawId)) {
      throw new Error(`Channel '${rawId}' already exists`);
    }
    const cleanName = String(params.name || rawId).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 100) || rawId;
    const cleanTopic = String(params.topic || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 500);
    const visibility = params.visibility === "private" ? "private" : "public";
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO channels (id, name, type, topic, visibility, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rawId, cleanName, type, cleanTopic, visibility, params.creatorId, now, now);

    for (const memberId of uniqueMembers) {
      this.addMember(rawId, memberId, memberId === params.creatorId ? "admin" : "member");
    }
    return this.getChannel(rawId)!;
  }

  addMember(channelId: string, principalId: string, role: LocalMemberRole = "member"): boolean {
    if (!isValidPrincipalOrChannelId(principalId)) return false;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_members (channel_id, principal_id, role, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id, principal_id) DO NOTHING`,
      )
      .run(channelId, principalId, role, now);
    return true;
  }

  removeMember(channelId: string, principalId: string): boolean {
    const res = this.db
      .prepare("DELETE FROM channel_members WHERE channel_id = ? AND principal_id = ?")
      .run(channelId, principalId);
    return Number(res.changes) > 0;
  }

  isMember(channelId: string, principalId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM channel_members WHERE channel_id = ? AND principal_id = ?")
      .get(channelId, principalId);
    return Boolean(row);
  }

  getMemberRole(channelId: string, principalId: string): LocalMemberRole | null {
    const row = this.db
      .prepare("SELECT role FROM channel_members WHERE channel_id = ? AND principal_id = ?")
      .get(channelId, principalId);
    return row ? (row.role === "admin" ? "admin" : "member") : null;
  }

  listChannelMembers(channelId: string): Array<
    LocalChannelMember & {
      display_name: string;
      kind: PrincipalKind;
      capabilities: string[];
    }
  > {
    const rows = this.db
      .prepare(
        `SELECT cm.channel_id, cm.principal_id, cm.role, cm.joined_at,
                p.display_name, p.kind, p.capabilities_json
         FROM channel_members cm
         LEFT JOIN principals p ON p.id = cm.principal_id
         WHERE cm.channel_id = ?
         ORDER BY cm.joined_at ASC`,
      )
      .all(channelId);
    return rows.map((r) => {
      let caps: string[] = [];
      try {
        const parsed = JSON.parse(r.capabilities_json || "[]");
        if (Array.isArray(parsed)) caps = parsed;
      } catch {}
      return {
        channel_id: String(r.channel_id),
        principal_id: String(r.principal_id),
        role: r.role === "admin" ? "admin" : "member",
        joined_at: String(r.joined_at),
        display_name: String(r.display_name || r.principal_id),
        kind: r.kind === "user" ? "user" : "agent",
        capabilities: caps,
      };
    });
  }

  private mapChannelRow(row: any): LocalChannel {
    return {
      id: String(row.id),
      name: String(row.name),
      type: row.type === "direct" ? "direct" : row.type === "project" ? "project" : "group",
      topic: String(row.topic || ""),
      visibility: row.visibility === "private" ? "private" : "public",
      created_by: String(row.created_by),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // ── Messages & @Mention Resolution ──────────────────────────────────────

  resolveMentionedMemberIds(channelId: string, content: string, senderId: string): string[] {
    if (!content.includes("@")) return [];
    const members = this.listChannelMembers(channelId);
    const mentioned = new Set<string>();
    const lowerContent = content.toLowerCase();
    for (const m of members) {
      if (m.principal_id === senderId) continue;
      const escapedId = m.principal_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const idRe = new RegExp(`(?:^|[^A-Za-z0-9_.-])@${escapedId}(?=$|[^A-Za-z0-9_.-])`, "i");
      if (idRe.test(content)) {
        mentioned.add(m.principal_id);
        continue;
      }
      const cleanName = m.display_name.trim();
      if (cleanName && cleanName.toLowerCase() !== m.principal_id.toLowerCase()) {
        if (lowerContent.includes(`@${cleanName.toLowerCase()}`)) {
          mentioned.add(m.principal_id);
        }
      }
    }
    return Array.from(mentioned);
  }

  appendMessage(params: {
    id?: string;
    channelId: string;
    senderId: string;
    senderName: string;
    senderType: "agent" | "human";
    content: string;
    contentType?: "text" | "code" | "proposal";
    inReplyTo?: string;
  }): LocalMessage {
    const id = params.id && isValidPrincipalOrChannelId(params.id) ? params.id : randomUUID();
    const content = String(params.content || "").trim();
    if (!content) throw new Error("Message content cannot be empty");
    if (content.length > 64_000) throw new Error("Message content exceeds 64KB limit");
    const timestamp = new Date().toISOString();
    const contentType =
      params.contentType === "code" || params.contentType === "proposal" ? params.contentType : "text";
    const mentionedIds = this.resolveMentionedMemberIds(params.channelId, content, params.senderId);

    this.db
      .prepare(
        `INSERT INTO messages (id, channel_id, sender_id, sender_name, sender_type, content, content_type, in_reply_to, mentioned_ids_json, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.channelId,
        params.senderId,
        params.senderName || params.senderId,
        params.senderType,
        content,
        contentType,
        params.inReplyTo || null,
        JSON.stringify(mentionedIds),
        timestamp,
      );

    this.db
      .prepare("UPDATE channels SET updated_at = ? WHERE id = ?")
      .run(timestamp, params.channelId);

    return {
      id,
      channel_id: params.channelId,
      sender_id: params.senderId,
      sender_name: params.senderName || params.senderId,
      sender_type: params.senderType,
      content,
      content_type: contentType,
      ...(params.inReplyTo ? { in_reply_to: params.inReplyTo } : {}),
      ...(mentionedIds.length > 0 ? { mentioned_ids: mentionedIds } : {}),
      timestamp,
    };
  }

  getMessageById(channelId: string, messageId: string): LocalMessage | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE channel_id = ? AND id = ? AND deleted_at IS NULL")
      .get(channelId, messageId);
    return row ? this.mapMessageRow(row) : null;
  }

  getMessages(
    channelId: string,
    opts: { limit?: number; after?: string; before?: string } = {},
  ): LocalMessage[] {
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    if (opts.after) {
      const rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE channel_id = ? AND deleted_at IS NULL AND timestamp > ?
           ORDER BY seq ASC
           LIMIT ?`,
        )
        .all(channelId, opts.after, limit);
      return rows.map((r) => this.mapMessageRow(r));
    }
    if (opts.before) {
      const rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE channel_id = ? AND deleted_at IS NULL AND timestamp < ?
           ORDER BY seq DESC
           LIMIT ?`,
        )
        .all(channelId, opts.before, limit);
      return rows.reverse().map((r) => this.mapMessageRow(r));
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND deleted_at IS NULL
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(channelId, limit);
    return rows.reverse().map((r) => this.mapMessageRow(r));
  }

  editMessage(channelId: string, messageId: string, senderId: string, newContent: string): LocalMessage | null {
    const clean = String(newContent || "").trim();
    if (!clean || clean.length > 64_000) return null;
    const editedAt = new Date().toISOString();
    const mentionedIds = this.resolveMentionedMemberIds(channelId, clean, senderId);
    const res = this.db
      .prepare(
        `UPDATE messages
         SET content = ?, mentioned_ids_json = ?, edited_at = ?
         WHERE id = ? AND channel_id = ? AND sender_id = ? AND deleted_at IS NULL`,
      )
      .run(clean, JSON.stringify(mentionedIds), editedAt, messageId, channelId, senderId);
    if (Number(res.changes) === 0) return null;
    return this.getMessageById(channelId, messageId);
  }

  deleteMessage(channelId: string, messageId: string, actorId: string, isChannelAdmin = false): boolean {
    const deletedAt = new Date().toISOString();
    const res = isChannelAdmin
      ? this.db
          .prepare("UPDATE messages SET deleted_at = ? WHERE id = ? AND channel_id = ? AND deleted_at IS NULL")
          .run(deletedAt, messageId, channelId)
      : this.db
          .prepare(
            "UPDATE messages SET deleted_at = ? WHERE id = ? AND channel_id = ? AND sender_id = ? AND deleted_at IS NULL",
          )
          .run(deletedAt, messageId, channelId, actorId);
    return Number(res.changes) > 0;
  }

  saveReadCursor(channelId: string, principalId: string, lastReadId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO read_cursors (channel_id, principal_id, last_read_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id, principal_id) DO UPDATE SET
           last_read_id = excluded.last_read_id,
           updated_at = excluded.updated_at`,
      )
      .run(channelId, principalId, lastReadId, now);
  }

  private mapMessageRow(row: any): LocalMessage {
    let mentioned: string[] = [];
    try {
      const parsed = JSON.parse(row.mentioned_ids_json || "[]");
      if (Array.isArray(parsed)) mentioned = parsed;
    } catch {}
    return {
      id: String(row.id),
      channel_id: String(row.channel_id),
      sender_id: String(row.sender_id),
      sender_name: String(row.sender_name || row.sender_id),
      sender_type: row.sender_type === "human" ? "human" : "agent",
      content: String(row.content),
      content_type: row.content_type === "code" || row.content_type === "proposal" ? row.content_type : "text",
      ...(row.in_reply_to ? { in_reply_to: String(row.in_reply_to) } : {}),
      ...(mentioned.length > 0 ? { mentioned_ids: mentioned } : {}),
      ...(row.edited_at ? { edited_at: String(row.edited_at) } : {}),
      timestamp: String(row.timestamp),
    };
  }
}
