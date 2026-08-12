import assert from "node:assert/strict";
import test from "node:test";
import { CommandError, CommandRegistry } from "../src/commands/command-registry.js";
import { GroupAiControl } from "../src/app/group-ai-control.js";
import { createBuiltinCommandRegistry } from "../src/commands/builtins/index.js";

test("斜杠命令直接执行确定性处理函数", async () => {
  const registry = createBuiltinCommandRegistry();
  assert.deepEqual(await registry.executeSlash(" /ping "), {
    text: "pong",
    commandName: "ping",
  });
});

test("已删除命令和无效参数明确失败", async () => {
  const registry = createBuiltinCommandRegistry();
  await assert.rejects(() => registry.executeSlash("/missing"), CommandError);
  await assert.rejects(() => registry.executeSlash("/echo hello"), /未知命令/);
  await assert.rejects(() => registry.executeSlash("/sum 1 2"), /未知命令/);
  await assert.rejects(() => registry.executeSlash("/ai maybe"), /用法/);
});

test("AI 工具与斜杠命令共享同一处理函数并使用严格 schema", async () => {
  const registry = createBuiltinCommandRegistry();
  const tools = registry.toAiTools();
  assert.ok(!tools.some((tool) => tool.name === "command_ping"));
  const aiTool = tools.find((tool) => tool.name === "command_ai");
  assert.ok(aiTool);
  assert.deepEqual(aiTool.parameters.properties.action.enum, ["off"]);
  assert.ok(tools.some((tool) => tool.name === "command_help"));
  assert.ok(!tools.some((tool) => tool.name === "command_echo"));
  assert.ok(!tools.some((tool) => tool.name === "command_sum"));
  assert.ok(tools.every((tool) => tool.strict === true));
  assert.ok(tools.every((tool) => tool.parameters.additionalProperties === false));
});

test("每个命令必须显式配置是否允许自然语言触发", () => {
  const registry = createBuiltinCommandRegistry();
  assert.ok(registry.list().every((command) => typeof command.allowNaturalLanguage === "boolean"));
  assert.equal(registry.resolve("ping").allowNaturalLanguage, false);
  assert.equal(registry.resolve("ai").allowNaturalLanguage, true);
  assert.equal(registry.resolve("help").allowNaturalLanguage, true);

  assert.throws(
    () => new CommandRegistry().register({ name: "unsafe" }),
    /必须显式配置 allowNaturalLanguage/,
  );
});

test("仅斜杠命令不会暴露给 AI 且拒绝绕过注册表调用", async () => {
  const registry = createBuiltinCommandRegistry();

  assert.deepEqual(await registry.executeSlash("/ping"), {
    text: "pong",
    commandName: "ping",
  });
  await assert.rejects(
    () => registry.executeTool("command_ping", {}),
    /仅允许通过斜杠触发/,
  );
});

test("AI 状态命令只允许自然语言进入回避，开启和查询仍须斜杠", async () => {
  const registry = createBuiltinCommandRegistry();
  const aiControl = new GroupAiControl();
  const context = { message: { groupOpenid: "group-a" }, aiControl };

  const result = await registry.executeTool("command_ai", { action: "off" }, context);
  assert.match(result.text, /回避状态/);
  assert.equal(aiControl.isEnabled("group-a"), false);

  await assert.rejects(
    () => registry.executeTool("command_ai", { action: "on" }, context),
    /只能通过自然语言进入回避状态/,
  );
  await assert.rejects(
    () => registry.executeTool("command_ai", { action: "status" }, context),
    /只能通过自然语言进入回避状态/,
  );
});

test("AI 回避状态按群隔离且必须由显式斜杠命令切换", async () => {
  const registry = createBuiltinCommandRegistry();
  const aiControl = new GroupAiControl();
  const context = (groupOpenid) => ({ message: { groupOpenid }, aiControl });

  const off = await registry.executeSlash("/ai off", context("group-a"));
  assert.match(off.text, /回避状态/);
  assert.equal(aiControl.isEnabled("group-a"), false);
  assert.equal(aiControl.isEnabled("group-b"), true);

  const status = await registry.executeSlash("/ai status", context("group-a"));
  assert.match(status.text, /处于回避状态/);

  const on = await registry.executeSlash("/ai on", context("group-a"));
  assert.match(on.text, /重新开启/);
  assert.equal(aiControl.isEnabled("group-a"), true);
});
