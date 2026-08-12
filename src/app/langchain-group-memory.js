import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { SqliteDatabase } from "../memory/sqlite-database.js";
import { SqliteChatMessageHistory } from "../memory/sqlite-chat-message-history.js";

function toOpenAiInput(message) {
  const type = message.getType();
  if (type === "human") return { role: "user", content: message.content };
  if (type === "ai") return { role: "assistant", content: message.content };
  throw new TypeError(`不支持的 LangChain 消息类型：${type}`);
}

export class LangChainGroupMemory {
  constructor({ database, maxMessages = 12 } = {}) {
    this.database = database || new SqliteDatabase();
    this.ownsDatabase = !database;
    this.maxMessages = maxMessages;
    this.histories = new Map();
  }

  getHistory(groupOpenid) {
    let history = this.histories.get(groupOpenid);
    if (!history) {
      history = new SqliteChatMessageHistory({
        database: this.database,
        groupOpenid,
        maxMessages: this.maxMessages,
      });
      this.histories.set(groupOpenid, history);
    }
    return history;
  }

  async get(groupOpenid) {
    const messages = await this.getHistory(groupOpenid).getMessages();
    return messages.map(toOpenAiInput);
  }

  async addUserMessage(groupOpenid, content) {
    await this.addMessages(groupOpenid, [new HumanMessage(content)]);
  }

  async addTurn(groupOpenid, { user, assistant }) {
    await this.addMessages(groupOpenid, [
      new HumanMessage(user),
      new AIMessage(assistant),
    ]);
  }

  async addMessages(groupOpenid, newMessages) {
    await this.getHistory(groupOpenid).addMessages(newMessages);
  }

  close() {
    if (this.ownsDatabase) this.database.close();
  }
}
