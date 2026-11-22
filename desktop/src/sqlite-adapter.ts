import { createRequire } from "node:module";

export interface SqliteStatement {
  get(...params: any[]): any;
  all(...params: any[]): any[];
  run(...params: any[]): { changes: number | bigint };
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const requireMod = createRequire(import.meta.url);

/**
 * Cross-runtime zero-native-addon SQLite adapter:
 * - In Electron / Node >= 22.5 (macOS & Windows): uses built-in `node:sqlite` (`DatabaseSync`)
 * - In Bun (`bun test`): uses built-in `bun:sqlite` (`Database`)
 */
export function openSqlite(dbPath: string): SqliteDb {
  if (typeof (globalThis as any).Bun !== "undefined") {
    const { Database } = requireMod("bun:sqlite");
    const db = new Database(dbPath, { create: true });
    return {
      exec(sql: string) {
        db.exec(sql);
      },
      prepare(sql: string): SqliteStatement {
        const stmt = db.query(sql);
        return {
          get(...params: any[]) {
            return stmt.get(...params) ?? undefined;
          },
          all(...params: any[]) {
            return stmt.all(...params);
          },
          run(...params: any[]) {
            const res = stmt.run(...params);
            return { changes: res?.changes ?? 0 };
          },
        };
      },
      close() {
        db.close();
      },
    };
  }

  const { DatabaseSync } = requireMod("node:sqlite");
  const db = new DatabaseSync(dbPath);
  return {
    exec(sql: string) {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql);
      return {
        get(...params: any[]) {
          return stmt.get(...params) ?? undefined;
        },
        all(...params: any[]) {
          return stmt.all(...params);
        },
        run(...params: any[]) {
          const res = stmt.run(...params);
          return { changes: res?.changes ?? 0 };
        },
      };
    },
    close() {
      db.close();
    },
  };
}
