import { CommandError } from "../commands/command-registry.js";
import { formatMessageForAi, formatMessageForLog } from "../ai/message-context.js";
import {
  isSupportedGroupMessageEvent,
  normalizeGroupMessageEvent,
} from "../qq/qq-event-normalizer.js";

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

function stripLeadingMentions(text) {
  let remaining = text.trimStart();
  while (remaining.startsWith("<@")) {
    const closingBracket = remaining.indexOf(">");
    if (closingBracket < 3) break;
    remaining = remaining.slice(closingBracket + 1).trimStart();
  }
  return remaining;
}

function classifyMessage(message, { aiEnabled, commandPrefix }) {
  const commandText = message.isExplicitBotMention
    ? stripLeadingMentions(message.text)
    : "";
  if (commandText.startsWith(commandPrefix)) {
    return { kind: "command", commandText };
  }
  if (!aiEnabled) return { kind: "ignored" };
  return {
    kind: "ai",
    engagement: message.isExplicitBotMention ? "direct" : "selective",
  };
}

export class MessageService {
  constructor({
    qqApi,
    registry,
    aiAgent,
    deduplicator,
    memory,
    longTermMemory = null,
    botIdentityResolver,
    aiControl,
    maxReplyChars = 1500,
    logger,
  }) {
    this.qqApi = qqApi;
    this.registry = registry;
    this.aiAgent = aiAgent;
    this.deduplicator = deduplicator;
    this.memory = memory;
    this.longTermMemory = longTermMemory;
    this.botIdentityResolver = botIdentityResolver;
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

  async handleGatewayPayload(payload) {
    if (!isSupportedGroupMessageEvent(payload)) return false;
    const botMemberOpenid = await this.resolveBotMemberOpenid(payload);
    const message = normalizeGroupMessageEvent(payload, { botMemberOpenid });
    if (!message) return false;
    if (this.deduplicator.isDuplicate(message.dedupKey)) {
      this.logger.debug("忽略重复群消息", { msgId: message.msgId, msgIndex: message.msgIndex });
      return false;
    }

    return this.enqueue(message);
  }

  async resolveBotMemberOpenid(payload) {
    const groupOpenid = payload?.d?.group_openid;
    if (payload?.t !== "GROUP_MESSAGE_CREATE" || !groupOpenid) return null;

    try {
      return await this.botIdentityResolver.getMemberOpenid(String(groupOpenid));
    } catch (error) {
      this.logger.error("获取机器人群身份失败", {
        error,
        groupOpenid: String(groupOpenid),
      });
      return null;
    }
  }

  enqueue(message) {
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
    const aiWasEnabled = this.aiControl.isEnabled(message.groupOpenid);
    const route = classifyMessage(message, {
      aiEnabled: aiWasEnabled,
      commandPrefix: this.registry.prefix,
    });
    const commandContext = { message, aiControl: this.aiControl };
    const memoryContent = formatMessageForAi(message);
    const logContent = formatMessageForLog(message);

    if (route.kind === "ignored") {
      this.logMessageHandling(message, logContent, "AI 回避期间忽略", {
        route: "ai-avoid",
      });
      return true;
    }
    let result;
    try {
      result = await this.executeRoute(route, message, commandContext);
    } catch (error) {
      if (route.engagement === "selective") {
        this.logger.error("旁听群消息时 AI 处理失败，已静默降级", { error, msgId: message.msgId });
        return this.rememberWithoutReply(message, memoryContent, logContent, "ai-observe-fallback");
      }
      if (error instanceof CommandError) {
        result = { text: `命令错误：${error.message}`, route: "command-error" };
      } else {
        this.logger.error("生成群聊回复失败", { error, msgId: message.msgId });
        result = { text: "处理消息时发生错误，请稍后重试。", route: "error" };
      }
    }

    if (route.engagement === "selective" && result.text === null) {
      return this.rememberWithoutReply(message, memoryContent, logContent, result.route);
    }

    const replyChunks = await this.sendReply(message, result.text);
    const aiIsEnabledAfter = this.aiControl.isEnabled(message.groupOpenid);
    if (aiWasEnabled && aiIsEnabledAfter) {
      await this.memory.addTurn(message.groupOpenid, {
        user: memoryContent,
        assistant: result.text,
      });
    }
    const remembered = route.kind === "command" || !aiIsEnabledAfter
      ? 0
      : await this.observeLongTermMemory(message);
    this.logMessageHandling(message, logContent, "已处理消息", {
      route: result.route,
      commandName: result.commandName,
      replyChunks,
      longTermOperations: remembered,
    });
    return true;
  }

  async executeRoute(route, message, commandContext) {
    if (route.kind === "command") {
      return {
        ...(await this.registry.executeSlash(route.commandText, commandContext)),
        route: "slash",
      };
    }

    return this.aiAgent.respond({
      message,
      history: await this.memory.get(message.groupOpenid),
      longTermMemories: await this.recallLongTermMemory(message),
      tools: this.registry.toAiTools(),
      executeTool: (name, args) => this.registry.executeTool(name, args, commandContext),
      engagement: route.engagement,
    });
  }

  async rememberWithoutReply(message, memoryContent, logContent, route) {
    await this.memory.addUserMessage(message.groupOpenid, memoryContent);
    const remembered = await this.observeLongTermMemory(message);
    this.logMessageHandling(message, logContent, "已静默写入记忆", {
      route,
      longTermOperations: remembered,
    });
    return true;
  }

  logMessageHandling(message, content, action, details = {}) {
    this.logger.info("群消息处理", {
      eventType: message.type,
      msgId: message.msgId,
      groupOpenid: message.groupOpenid,
      content,
      action,
      ...details,
    });
  }

  async sendReply(message, text) {
    const chunks = splitText(text, this.maxReplyChars);
    for (let index = 0; index < chunks.length; index += 1) {
      await this.qqApi.sendGroupText({
        groupOpenid: message.groupOpenid,
        content: chunks[index],
        msgId: message.msgId,
        msgSeq: index + 1,
      });
    }
    return chunks.length;
  }
}
