import { SqliteDatabase } from "../memory/sqlite-database.js";

export class GroupAiControl {
  constructor({ database, clock = Date.now } = {}) {
    this.database = database ?? new SqliteDatabase();
    this.ownsDatabase = !database;
    this.clock = clock;
    this.getStateStatement = this.database.connection.prepare(`
      SELECT enabled
      FROM group_ai_state
      WHERE group_openid = ?
    `);
    this.setStateStatement = this.database.connection.prepare(`
      INSERT INTO group_ai_state (group_openid, enabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(group_openid) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `);
  }

  isEnabled(groupOpenid) {
    const state = this.getStateStatement.get(groupOpenid);
    return state ? Boolean(state.enabled) : true;
  }

  setEnabled(groupOpenid, enabled) {
    const normalizedEnabled = Boolean(enabled);
    this.setStateStatement.run(
      groupOpenid,
      normalizedEnabled ? 1 : 0,
      this.clock(),
    );
    return normalizedEnabled;
  }

  close() {
    if (this.ownsDatabase) this.database.close();
  }
}
