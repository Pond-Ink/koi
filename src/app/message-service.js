import { CommandError } from "../commands/command-registry.js";
import { formatMessageForAi } from "../ai/message-context.js";
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

function isExplicitTextAddressToBot(text, botName) {
  if (!botName) return false;
  const escapedName = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedName}(?=\\s|[，,：:！!？?]|$)`, "iu")
    .test(stripLeadingMentions(text));
}

function classifyMessage(message, { aiEnabled, commandPrefix, botName }) {
  const commandText = message.isExplicitBotMention
    ? stripLeadingMentions(message.text)
    : "";
  if (commandText.startsWith(commandPrefix)) {
    return { kind: "command", commandText };
  }
  if (!aiEnabled) return { kind: "ignored" };
  if (message.isExplicitBotMention) return { kind: "ai", reason: "explicit-mention" };
  if (message.replyTo?.isBot) return { kind: "ai", reason: "reply-to-bot" };
  if (isExplicitTextAddressToBot(message.text, botName)) {
    return { kind: "ai", reason: "explicit-text-address" };
  }
  return { kind: "observed" };
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
    botName = "",
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
    this.botName = botName;
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
      botName: this.botName,
    });
    const commandContext = { message, aiControl: this.aiControl };
    const memoryContent = formatMessageForAi(message);

    if (route.kind === "ignored") {
      this.logger.info("AI 回避期间忽略群消息", {
        eventType: message.type,
        msgId: message.msgId,
        route: "ai-avoid",
      });
      return true;
    }
    if (route.kind === "observed") {
      return this.rememberWithoutReply(message, memoryContent, "memory-observe");
    }

    let result;
    try {
      result = await this.executeRoute(route, message, commandContext);
    } catch (error) {
      if (error instanceof CommandError) {
        result = { text: `命令错误：${error.message}`, route: "command-error" };
      } else {
        this.logger.error("生成群聊回复失败", { error, msgId: message.msgId });
        result = { text: "处理消息时发生错误，请稍后重试。", route: "error" };
      }
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
    this.logger.info("群消息已处理", {
      eventType: message.type,
      msgId: message.msgId,
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
      engagement: "direct",
    });
  }

  async rememberWithoutReply(message, memoryContent, route) {
    await this.memory.addUserMessage(message.groupOpenid, memoryContent);
    const remembered = await this.observeLongTermMemory(message);
    this.logger.info("群消息已静默写入记忆", {
      eventType: message.type,
      msgId: message.msgId,
      route,
      longTermOperations: remembered,
    });
    return true;
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
