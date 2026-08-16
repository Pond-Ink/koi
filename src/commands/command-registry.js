export class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandError";
  }
}

export class CommandRegistry {
  constructor({ prefix = "/" } = {}) {
    this.prefix = prefix;
    this.commands = new Map();
    this.aliases = new Map();
  }

  register(command) {
    if (typeof command.allowNaturalLanguage !== "boolean") {
      throw new TypeError(
        `命令 ${command.name || "<unknown>"} 必须显式配置 allowNaturalLanguage`,
      );
    }
    if (this.commands.has(command.name) || this.aliases.has(command.name)) {
      throw new Error(`重复命令：${command.name}`);
    }
    this.commands.set(command.name, Object.freeze(command));
    for (const alias of command.aliases || []) {
      if (this.commands.has(alias) || this.aliases.has(alias)) throw new Error(`重复别名：${alias}`);
      this.aliases.set(alias, command.name);
    }
    return this;
  }

  list() {
    return [...this.commands.values()];
  }

  resolve(name) {
    const canonical = this.aliases.get(name) || name;
    return this.commands.get(canonical);
  }

  async executeSlash(text, context = {}) {
    const source = text.trimStart().slice(this.prefix.length).trim();
    const separator = source.search(/\s/);
    const name = (separator === -1 ? source : source.slice(0, separator)).toLowerCase();
    const rawArgs = separator === -1 ? "" : source.slice(separator).trim();
    if (!name) throw new CommandError("请输入命令名称，例如 /help");

    const command = this.resolve(name);
    if (!command) throw new CommandError(`未知命令 /${name}，发送 /help 查看可用命令。`);
    const args = command.parseSlash(rawArgs);
    return this.execute(command, args, context);
  }

  async executeTool(toolName, args, context = {}) {
    if (!toolName.startsWith("command_")) throw new CommandError(`未知工具：${toolName}`);
    const command = this.commands.get(toolName.slice("command_".length));
    if (!command || !command.allowNaturalLanguage) {
      throw new CommandError(`命令仅允许通过斜杠触发：${toolName}`);
    }
    if (command.validateNaturalLanguage) command.validateNaturalLanguage(args);
    return this.execute(command, args, context);
  }

  async execute(command, args, context) {
    command.validate(args);
    const result = await command.execute({ ...context, registry: this }, args);
    if (!result || typeof result.text !== "string" || !result.text.trim()) {
      throw new CommandError(`命令 ${command.name} 未返回有效文本`);
    }
    return { ...result, commandName: command.name };
  }

  toAiTools() {
    return this.list()
      .filter((command) => command.allowNaturalLanguage)
      .map((command) => ({
        type: "function",
        name: `command_${command.name}`,
        description: command.aiDescription || command.description,
        strict: true,
        parameters: command.parameters,
      }));
  }
}
