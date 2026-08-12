import { CommandError } from "../command-registry.js";

export const helpCommand = Object.freeze({
  name: "help",
  aliases: ["帮助"],
  allowNaturalLanguage: true,
  description: "查看全部命令或某个命令的用法",
  aiDescription: "当用户询问机器人有哪些能力、命令、帮助或某个命令怎么使用时调用。",
  usage: "/help [命令名]",
  parameters: {
    type: "object",
    properties: { command: { type: ["string", "null"], description: "要查询的命令名；查询全部时为 null" } },
    required: ["command"],
    additionalProperties: false,
  },
  parseSlash(raw) {
    return { command: raw || null };
  },
  validate(args) {
    if (!args || !(typeof args.command === "string" || args.command === null)) {
      throw new CommandError("help.command 必须是字符串或 null");
    }
  },
  execute({ registry }, { command }) {
    if (command) {
      const target = registry.resolve(command.replace(/^\//, "").toLowerCase());
      if (!target) throw new CommandError(`没有找到命令 ${command}`);
      const trigger = target.allowNaturalLanguage ? "支持自然语言触发" : "仅支持斜杠命令";
      return { text: `${target.usage}\n${target.description}\n触发方式：${trigger}` };
    }
    const lines = registry.list().map((item) => {
      const trigger = item.allowNaturalLanguage ? "支持自然语言" : "仅斜杠";
      return `${item.usage} — ${item.description} [${trigger}]`;
    });
    return { text: `可用命令：\n${lines.join("\n")}` };
  },
});
