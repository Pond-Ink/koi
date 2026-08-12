import { BaseListChatMessageHistory } from "@langchain/core/chat_history";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

function messageToRow(message) {
  const type = message.getType();
  if (type === "human") return { role: "user", content: String(message.content) };
  if (type === "ai") return { role: "assistant", content: String(message.content) };
  throw new TypeError(`不支持持久化的 LangChain 消息类型：${type}`);
}

function rowToMessage(row) {
  return row.role === "assistant"
    ? new AIMessage(row.content)
    : new HumanMessage(row.content);
}

export class SqliteChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ["koi", "stores", "message", "sqlite"];

  constructor({ database, groupOpenid, maxMessages = 12 }) {
    super();
    this.database = database;
    this.groupOpenid = groupOpenid;
    this.maxMessages = maxMessages;
    this.selectRecent = database.connection.prepare(`
      SELECT role, content
      FROM (
        SELECT id, role, content
        FROM chat_messages
        WHERE group_openid = ?
        ORDER BY id DESC
        LIMIT ?
      )
      ORDER BY id ASC
    `);
    this.insert = database.connection.prepare(`
      INSERT INTO chat_messages (group_openid, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `);
    this.trim = database.connection.prepare(`
      DELETE FROM chat_messages
      WHERE group_openid = ?
        AND id NOT IN (
          SELECT id FROM chat_messages
          WHERE group_openid = ?
          ORDER BY id DESC
          LIMIT ?
        )
    `);
    this.deleteAll = database.connection.prepare(
      "DELETE FROM chat_messages WHERE group_openid = ?",
    );
  }

  async getMessages() {
    return this.selectRecent
      .all(this.groupOpenid, this.maxMessages)
      .map(rowToMessage);
  }

  async addMessage(message) {
    await this.addMessages([message]);
  }

  async addMessages(messages) {
    if (!messages.length) return;
    const rows = messages.map(messageToRow);
    const now = Date.now();
    this.database.transaction(() => {
      rows.forEach((row, index) => {
        this.insert.run(this.groupOpenid, row.role, row.content, now + index);
      });
      this.trim.run(this.groupOpenid, this.groupOpenid, this.maxMessages);
    });
  }

  async clear() {
    this.deleteAll.run(this.groupOpenid);
  }
}
