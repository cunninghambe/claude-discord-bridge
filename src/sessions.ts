import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type UserSession = {
  discordUserId: string;
  claudeSessionId: string | null;
  createdAt: Date;
  lastUsedAt: Date;
};

export type SessionStore = {
  get(discordUserId: string): UserSession | null;
  upsert(s: UserSession): void;
  clear(discordUserId: string): void;
  close(): void;
};

type SessionRow = {
  discord_user_id: string;
  claude_session_id: string | null;
  created_at: number;
  last_used_at: number;
};

export function openSessionStore(dbPath: string): SessionStore {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      discord_user_id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
  `);

  const getStmt = db.prepare<[string], SessionRow>(
    'SELECT discord_user_id, claude_session_id, created_at, last_used_at FROM sessions WHERE discord_user_id = ?',
  );

  type UpsertBind = {
    discordUserId: string;
    claudeSessionId: string | null;
    createdAt: number;
    lastUsedAt: number;
  };
  const upsertStmt = db.prepare<UpsertBind>(`
    INSERT INTO sessions (discord_user_id, claude_session_id, created_at, last_used_at)
    VALUES (@discordUserId, @claudeSessionId, @createdAt, @lastUsedAt)
    ON CONFLICT(discord_user_id) DO UPDATE SET
      claude_session_id = excluded.claude_session_id,
      last_used_at = excluded.last_used_at
  `);

  const deleteStmt = db.prepare<[string]>('DELETE FROM sessions WHERE discord_user_id = ?');

  return {
    get(id) {
      const row = getStmt.get(id);
      if (!row) return null;
      return {
        discordUserId: row.discord_user_id,
        claudeSessionId: row.claude_session_id,
        createdAt: new Date(row.created_at),
        lastUsedAt: new Date(row.last_used_at),
      };
    },
    upsert(s) {
      upsertStmt.run({
        discordUserId: s.discordUserId,
        claudeSessionId: s.claudeSessionId,
        createdAt: s.createdAt.getTime(),
        lastUsedAt: s.lastUsedAt.getTime(),
      });
    },
    clear(id) {
      deleteStmt.run(id);
    },
    close() {
      db.close();
    },
  };
}
