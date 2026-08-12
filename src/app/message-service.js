import { CommandError } from "../commands/command-registry.js";
import { formatMessageForAi } from "../ai/message-context.js";
import { normalizeGroupMessageEvent } from "../qq/qq-event-normalizer.js";
import { GroupAiControl } from "./group-ai-control.js";

function splitText(text, maxChars) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < maxChars / 2) cut = remaining.lastIndexOf(" ", maxChars);
    if (cut < maxChars / 2) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class MessageService {
  constructor({
    qqApi,
    registry,
    aiAgent,
    deduplicator,
    memory,
    longTermMemory = null,
    aiControl = new GroupAiControl(),
    maxReplyChars = 1500,
    logger,
  }) {
    this.qqApi = qqApi;
    this.registry = registry;
    this.aiAgent = aiAgent;
    this.deduplicator = deduplicator;
    this.memory = memory;
    this.longTermMemory = longTermMemory;
    this.aiControl = aiControl;
    this.maxReplyChars = maxReplyChars;
    this.logger = logger;
    this.groupQueues = new Map();
  }

  async observeLongTermMemory(message) {
    if (!this.longTermMemory) return 0;
    try {
      return await this.longTermMemory.observe(message);
    } catch (error) {
      this.logger.error("写入长期记忆失败", { error, msgId: message.msgId });
      return 0;
    }
  }

  async recallLongTermMemory(message) {
    if (!this.longTermMemory) return [];
    try {
      return await this.longTermMemory.recall({
        groupOpenid: message.groupOpenid,
        query: message.text,
      });
    } catch (error) {
      this.logger.error("召回长期记忆失败", { error, msgId: message.msgId });
      return [];
    }
  }

  async waitForIdle() {
    await Promise.allSettled([...this.groupQueues.values()]);
  }

  handleGatewayPayload(payload) {
    const message = normalizeGroupMessageEvent(payload);
    if (!message) return Promise.resolve(false);
    if (this.deduplicator.isDuplicate(message.dedupKey)) {
      this.logger.debug("忽略重复群消息", { msgId: message.msgId, msgIndex: message.msgIndex });
      return Promise.resolve(false);
    }

    const previous = this.groupQueues.get(message.groupOpenid) || Promise.resolve();
    const current = previous.then(() => this.processMessage(message));
    const tracked = current.finally(() => {
      if (this.groupQueues.get(message.groupOpenid) === tracked) {
        this.groupQueues.delete(message.groupOpenid);
      }
    });
    this.groupQueues.set(message.groupOpenid, tracked);
    return tracked;
  }

  async processMessage(message) {
    const isSlashCommand = this.registry.isSlashCommand(message.text);
    const aiWasEnabled = this.aiControl.isEnabled(message.groupOpenid);
    const commandContext = { message, aiControl: this.aiControl };
    const memoryContent = formatMessageForAi(message);

    if (!isSlashCommand && !aiWasEnabled) {
      this.logger.info("AI 回避期间忽略群消息", {
        eventType: message.type,
        msgId: message.msgId,
        route: "ai-avoid",
      });
      return true;
    }

    if (
      message.type === "GROUP_MESSAGE_CREATE"
      && !isSlashCommand
    ) {
      await this.memory.addUserMessage(message.groupOpenid, memoryContent);
      const remembered = await this.observeLongTermMemory(message);
      this.logger.info("群消息已写入记忆", {
        eventType: message.type,
        msgId: message.msgId,
        route: "memory-observe",
        longTermOperations: remembered,
      });
      return true;
    }

    let result;

    try {
      if (isSlashCommand) {
        result = { ...(await this.registry.executeSlash(message.text, commandContext)), route: "slash" };
      } else {
        const longTermMemories = await this.recallLongTermMemory(message);
        result = await this.aiAgent.respond({
          message,
          history: await this.memory.get(message.groupOpenid),
          longTermMemories,
          tools: this.registry.toAiTools(),
          executeTool: (name, args) => this.registry.executeTool(name, args, commandContext),
        });
      }
    } catch (error) {
      if (error instanceof CommandError) {
        result = { text: `命令错误：${error.message}`, route: "command-error" };
      } else {
        this.logger.error("生成群聊回复失败", { error, msgId: message.msgId });
        result = { text: "处理消息时发生错误，请稍后重试。", route: "error" };
      }
    }

    const chunks = splitText(result.text, this.maxReplyChars);
    for (let index = 0; index < chunks.length; index += 1) {
      await this.qqApi.sendGroupText({
        groupOpenid: message.groupOpenid,
        content: chunks[index],
        msgId: message.msgId,
        msgSeq: index + 1,
      });
    }

    const aiIsEnabledAfter = this.aiControl.isEnabled(message.groupOpenid);
    if (aiWasEnabled && aiIsEnabledAfter) {
      await this.memory.addTurn(message.groupOpenid, {
        user: memoryContent,
        assistant: result.text,
      });
    }
    const remembered = isSlashCommand || !aiIsEnabledAfter
      ? 0
      : await this.observeLongTermMemory(message);
    this.logger.info("群消息已处理", {
      eventType: message.type,
      msgId: message.msgId,
      route: result.route,
      commandName: result.commandName,
      replyChunks: chunks.length,
      longTermOperations: remembered,
    });
    return true;
  }
}
