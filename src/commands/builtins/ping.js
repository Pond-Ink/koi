import { CommandError } from "../command-registry.js";

export const pingCommand = Object.freeze({
  name: "ping",
  allowNaturalLanguage: false,
  description: "检查机器人是否在线",
  usage: "/ping",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  parseSlash(raw) {
    if (raw) throw new CommandError("用法：/ping");
    return {};
  },
  validate(args) {
    if (!args || Object.keys(args).length !== 0) throw new CommandError("ping 不接受参数");
  },
  execute() {
    return { text: "pong" };
  },
});
