import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_openid TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_messages_group_order
ON chat_messages (group_openid, id DESC);

CREATE TABLE IF NOT EXISTS long_term_memories (
  id TEXT PRIMARY KEY,
  group_openid TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('group', 'member')),
  subject_openid TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding_json TEXT,
  source_message_id TEXT,
  source_author_openid TEXT,
  source_author_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_recalled_at INTEGER,
  UNIQUE (group_openid, scope, subject_openid, memory_key)
);

CREATE INDEX IF NOT EXISTS long_term_memories_namespace
ON long_term_memories (group_openid, scope, subject_openid, updated_at DESC);

CREATE TABLE IF NOT EXISTS group_ai_state (
  group_openid TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);
`;

export class SqliteDatabase {
  constructor({ filename = ":memory:" } = {}) {
    this.filename = filename === ":memory:" ? filename : resolve(filename);
    if (this.filename !== ":memory:") mkdirSync(dirname(this.filename), { recursive: true });

    this.connection = new DatabaseSync(this.filename);
    this.connection.exec("PRAGMA foreign_keys = ON");
    if (this.filename !== ":memory:") this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    this.connection.exec(SCHEMA);
    this.closed = false;
  }

  transaction(operation) {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
  }
}
