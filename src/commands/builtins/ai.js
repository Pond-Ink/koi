import { CommandError } from "../command-registry.js";

const ACTIONS = new Map([
  ["off", "off"],
  ["avoid", "off"],
  ["关闭", "off"],
  ["回避", "off"],
  ["on", "on"],
  ["resume", "on"],
  ["开启", "on"],
  ["打开", "on"],
  ["status", "status"],
  ["状态", "status"],
]);

export const aiCommand = Object.freeze({
  name: "ai",
  aliases: [],
  allowNaturalLanguage: true,
  description: "临时开启、回避或查询本群的 AI 处理状态",
  aiDescription: "仅当用户明确要求 AI 停止参与、保持安静、暂时不要回复或进入回避状态时调用。此工具只能关闭 AI；用户询问状态或要求重新开启时不要调用，并提示必须发送 /ai status 或 /ai on。",
  usage: "/ai <on|off|status>",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["off"],
        description: "固定为 off；自然语言只被授权进入回避状态。",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  parseSlash(raw) {
    const normalized = raw.trim().toLowerCase();
    const action = ACTIONS.get(normalized);
    if (!action) throw new CommandError("用法：/ai <on|off|status>");
    return { action };
  },
  validate(args) {
    if (!args || !["on", "off", "status"].includes(args.action)) {
      throw new CommandError("用法：/ai <on|off|status>");
    }
  },
  validateNaturalLanguage(args) {
    if (!args || args.action !== "off" || Object.keys(args).length !== 1) {
      throw new CommandError("AI 只能通过自然语言进入回避状态；开启或查询请使用斜杠命令");
    }
  },
  execute({ message, aiControl }, { action }) {
    if (!message?.groupOpenid || !aiControl) {
      throw new CommandError("AI 状态命令缺少群聊上下文");
    }
    if (action === "status") {
      return {
        text: aiControl.isEnabled(message.groupOpenid)
          ? "AI 当前已开启。发送 /ai off 可进入回避状态。"
          : "AI 当前处于回避状态。发送 /ai on 可重新开启。",
      };
    }

    const enabled = aiControl.setEnabled(message.groupOpenid, action === "on");
    return {
      text: enabled
        ? "AI 已重新开启。之后的群聊消息可以进入 AI 和记忆处理。"
        : "AI 已进入回避状态。之后的非命令消息不会发送给 AI，也不会写入记忆；发送 /ai on 可重新开启。",
    };
  },
});
