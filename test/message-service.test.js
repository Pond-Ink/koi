import assert from "node:assert/strict";
import test from "node:test";
import { EventDeduplicator } from "../src/app/event-deduplicator.js";
import { LangChainGroupMemory } from "../src/app/langchain-group-memory.js";
import { GroupAiControl } from "../src/app/group-ai-control.js";
import { MessageService } from "../src/app/message-service.js";
import { createBuiltinCommandRegistry } from "../src/commands/builtins/index.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function payload({ id, content }) {
  return {
    id: `event-${id}`,
    op: 0,
    s: 1,
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id,
      content,
      group_openid: "group-1",
      author: { member_openid: "member-1", username: "小明", bot: false },
      mentions: [{ member_openid: "bot-member-openid", bot: true, username: "Koi" }],
      message_scene: { ext: [`msg_idx=${id}`] },
    },
  };
}

function createService(
  aiAgent,
  { longTermMemory = null, botMemberOpenid = "bot-member-openid", botIdentityResolver } = {},
) {
  const sent = [];
  const memory = new LangChainGroupMemory();
  const aiControl = new GroupAiControl();
  const service = new MessageService({
    qqApi: { async sendGroupText(message) { sent.push(message); } },
    registry: createBuiltinCommandRegistry(),
    aiAgent,
    deduplicator: new EventDeduplicator(),
    memory,
    longTermMemory,
    aiControl,
    botIdentityResolver: botIdentityResolver || {
      async getMemberOpenid(groupOpenid) {
        assert.equal(groupOpenid, "group-1");
        return botMemberOpenid;
      },
    },
    logger,
  });
  return { service, sent, memory, aiControl };
}

test("斜杠命令绕过 AI", async () => {
  let aiCalls = 0;
  const { service, sent } = createService({ async respond() { aiCalls += 1; } });
  await service.handleGatewayPayload(payload({ id: "msg-1", content: " /ping " }));
  assert.equal(aiCalls, 0);
  assert.equal(sent[0].content, "pong");
  assert.equal(sent[0].msgId, "msg-1");
});

test("AT 事件不依赖 mentions 或群状态接口即可执行手写命令", async () => {
  let aiCalls = 0;
  const event = payload({ id: "at-without-mentions", content: "/ping" });
  event.d.mentions = [];
  const { service, sent } = createService(
    { async respond() { aiCalls += 1; } },
    {
      botIdentityResolver: {
        async getMemberOpenid() {
          assert.fail("AT 事件不应查询 bot_state");
        },
      },
    },
  );

  await service.handleGatewayPayload(event);

  assert.equal(aiCalls, 0);
  assert.equal(sent[0].content, "pong");
});

test("非群消息事件在查询群身份前即被忽略", async () => {
  let identityCalls = 0;
  const { service, sent } = createService(
    { async respond() { assert.fail("非群消息不应进入 AI"); } },
    {
      botIdentityResolver: {
        async getMemberOpenid() {
          identityCalls += 1;
          return "bot-member-openid";
        },
      },
    },
  );
  const event = payload({ id: "not-a-message", content: "忽略" });
  event.op = 11;
  event.t = "GROUP_MESSAGE_CREATE";

  assert.equal(await service.handleGatewayPayload(event), false);
  assert.equal(identityCalls, 0);
  assert.equal(sent.length, 0);
});

test("AT 事件正文中的 mention 前缀不会阻止手写命令解析", async () => {
  let aiCalls = 0;
  const event = payload({
    id: "at-command-with-prefix",
    content: "<@bot-member_openid-1> /ping",
  });
  event.d.mentions = [];
  const { service, sent } = createService({
    async respond() {
      aiCalls += 1;
    },
  });

  await service.handleGatewayPayload(event);

  assert.equal(aiCalls, 0);
  assert.equal(sent[0].content, "pong");
});

test("已删除的 echo 和 sum 不再暴露给 AI", async () => {
  const aiAgent = {
    async respond({ tools }) {
      assert.ok(!tools.some((tool) => tool.name === "command_ping"));
      assert.ok(tools.some((tool) => tool.name === "command_ai"));
      assert.ok(!tools.some((tool) => tool.name === "command_echo"));
      assert.ok(!tools.some((tool) => tool.name === "command_sum"));
      return { text: "普通回答", route: "ai-text" };
    },
  };
  const { service, sent } = createService(aiAgent);
  await service.handleGatewayPayload(payload({ id: "msg-2", content: "帮我把 7 和 8 相加" }));
  assert.equal(sent[0].content, "普通回答");
});

test("ping 只允许清晰的斜杠命令触发", async () => {
  const aiAgent = {
    async respond({ tools }) {
      assert.ok(!tools.some((tool) => tool.name === "command_ping"));
      return { text: "我在。需要检查时请发送 /ping。", route: "ai-text" };
    },
  };
  const { service, sent } = createService(aiAgent);

  await service.handleGatewayPayload(payload({ id: "msg-natural-ping", content: "你还活着吗？" }));

  assert.equal(sent[0].content, "我在。需要检查时请发送 /ping。");
});

test("重复事件只回复一次", async () => {
  const { service, sent } = createService({ async respond() { return { text: "ok", route: "ai-text" }; } });
  const event = payload({ id: "msg-3", content: "你好" });
  await service.handleGatewayPayload(event);
  await service.handleGatewayPayload(event);
  assert.equal(sent.length, 1);
});

test("引用内容不会改变斜杠命令的确定性路由", async () => {
  let aiCalls = 0;
  const event = payload({ id: "msg-4", content: "/ping" });
  event.d.message_scene.ext.push("ref_msg_idx=quoted-idx");
  event.d.msg_elements = [{ msg_idx: "quoted-idx", content: "/ai off" }];

  const { service, sent } = createService({ async respond() { aiCalls += 1; } });
  await service.handleGatewayPayload(event);

  assert.equal(aiCalls, 0);
  assert.equal(sent[0].content, "pong");
});

test("全量群消息由 AI 静默旁听并写入记忆，后续明确 @ 可读取上下文", async () => {
  const seenHistories = [];
  const aiAgent = {
    async respond({ history, engagement }) {
      seenHistories.push(history);
      if (engagement === "opportunistic") return { text: null, route: "ai-silent" };
      return { text: "ok", route: "ai-text" };
    },
  };
  const { service, sent } = createService(aiAgent);

  const observed = payload({ id: "msg-5", content: "下周团建去杭州" });
  observed.t = "GROUP_MESSAGE_CREATE";
  observed.d.mentions = [];
  await service.handleGatewayPayload(observed);
  assert.equal(sent.length, 0);
  assert.deepEqual(seenHistories[0], []);

  await service.handleGatewayPayload(payload({ id: "msg-6", content: "刚才说去哪？" }));
  assert.equal(sent.length, 1);
  assert.deepEqual(seenHistories[1], [
    { role: "user", content: "小明：下周团建去杭州" },
  ]);
});

test("全量群消息中的明确 @ 直接进入必答 AI 路径", async () => {
  let engagement;
  const event = payload({ id: "msg-full-at", content: "在吗？" });
  event.t = "GROUP_MESSAGE_CREATE";
  event.d.mentions = [{ member_openid: "bot-member-openid", bot: true, username: "Koi" }];
  const { service, sent } = createService({
    async respond(input) {
      engagement = input.engagement;
      return { text: "我在。", route: "ai-text" };
    },
  });

  await service.handleGatewayPayload(event);

  assert.equal(engagement, "direct");
  assert.equal(sent[0].content, "我在。");
});

test("全量群消息中只有 @ 机器人时结合已有上下文回复", async () => {
  const calls = [];
  const { service, sent } = createService({
    async respond(input) {
      calls.push(input);
      if (input.engagement === "opportunistic") return { text: null, route: "ai-silent" };
      return { text: "刚才在讨论周六的团建。", route: "ai-text" };
    },
  });

  const context = payload({ id: "msg-context", content: "团建改到周六" });
  context.t = "GROUP_MESSAGE_CREATE";
  context.d.mentions = [];
  await service.handleGatewayPayload(context);

  const onlyMention = payload({ id: "msg-only-at", content: "" });
  onlyMention.t = "GROUP_MESSAGE_CREATE";
  onlyMention.d.mentions = [{ member_openid: "bot-member-openid", bot: true, username: "Koi" }];
  await service.handleGatewayPayload(onlyMention);

  assert.equal(calls[1].engagement, "direct");
  assert.equal(calls[1].message.text, "");
  assert.deepEqual(calls[1].history, [
    { role: "user", content: "小明：团建改到周六" },
  ]);
  assert.equal(sent[0].content, "刚才在讨论周六的团建。");
});

test("全量群消息提及机器人名字时由 AI 择机发言", async () => {
  const event = payload({ id: "msg-name", content: "Koi，你怎么看？" });
  event.t = "GROUP_MESSAGE_CREATE";
  event.d.mentions = [];
  const { service, sent } = createService({
    async respond({ engagement, message }) {
      assert.equal(engagement, "opportunistic");
      assert.equal(message.text, "Koi，你怎么看？");
      return { text: "我倾向于先确认时间。", route: "ai-text" };
    },
  });

  await service.handleGatewayPayload(event);

  assert.equal(sent[0].content, "我倾向于先确认时间。");
});

test("全量群消息中只有明确 @ 当前机器人时才直接执行斜杠命令", async () => {
  let aiCalls = 0;
  const aiAgent = {
    async respond() {
      aiCalls += 1;
      return { text: null, route: "ai-silent" };
    },
  };
  const { service, sent } = createService(aiAgent, { botMemberOpenid: "current-member" });

  const withoutMention = payload({ id: "msg-7-no-at", content: "/ping" });
  withoutMention.t = "GROUP_MESSAGE_CREATE";
  withoutMention.d.mentions = [];
  await service.handleGatewayPayload(withoutMention);

  const event = payload({ id: "msg-7-at", content: "<@current-member> /ping" });
  event.t = "GROUP_MESSAGE_CREATE";
  event.d.mentions = [{ member_openid: "current-member", username: "Koi" }];

  await service.handleGatewayPayload(event);

  assert.equal(aiCalls, 1);
  assert.equal(sent[0].content, "pong");
});

test("AI 回复前召回长期记忆，处理后再形成新记忆", async () => {
  const calls = [];
  const longTermMemory = {
    async recall(input) {
      calls.push(["recall", input]);
      return [{ content: "小明喜欢面条" }];
    },
    async observe(message) {
      calls.push(["observe", message.msgId]);
      return 1;
    },
  };
  const aiAgent = {
    async respond({ longTermMemories }) {
      assert.equal(longTermMemories[0].content, "小明喜欢面条");
      return { text: "记得", route: "ai-text" };
    },
  };
  const { service, sent } = createService(aiAgent, { longTermMemory });

  await service.handleGatewayPayload(payload({ id: "msg-8", content: "我喜欢吃什么？" }));

  assert.equal(sent[0].content, "记得");
  assert.deepEqual(calls, [
    ["recall", { groupOpenid: "group-1", query: "我喜欢吃什么？" }],
    ["observe", "msg-8"],
  ]);
});

test("长期记忆故障不阻断普通 AI 回复", async () => {
  const longTermMemory = {
    async recall() { throw new Error("embedding unavailable"); },
    async observe() { throw new Error("extractor unavailable"); },
  };
  const { service, sent } = createService({
    async respond({ longTermMemories }) {
      assert.deepEqual(longTermMemories, []);
      return { text: "仍可回复", route: "ai-text" };
    },
  }, { longTermMemory });

  await service.handleGatewayPayload(payload({ id: "msg-9", content: "你好" }));
  assert.equal(sent[0].content, "仍可回复");
});

test("AI 回避期间普通消息不调用任何 AI 能力、不回复且不写入历史", async () => {
  let responseCalls = 0;
  let recallCalls = 0;
  let observeCalls = 0;
  const longTermMemory = {
    async recall() { recallCalls += 1; return []; },
    async observe() { observeCalls += 1; return 0; },
  };
  const { service, sent, memory } = createService({
    async respond() { responseCalls += 1; return { text: "不应出现", route: "ai-text" }; },
  }, { longTermMemory });

  await service.handleGatewayPayload(payload({ id: "avoid-off", content: "/ai off" }));
  assert.match(sent.at(-1).content, /回避状态/);

  await service.handleGatewayPayload(payload({ id: "avoid-at", content: "这条消息不能发给 AI" }));
  const observed = payload({ id: "avoid-full", content: "这条群消息也不能进入记忆" });
  observed.t = "GROUP_MESSAGE_CREATE";
  observed.d.mentions = [];
  await service.handleGatewayPayload(observed);

  assert.equal(sent.length, 1);
  assert.equal(responseCalls, 0);
  assert.equal(recallCalls, 0);
  assert.equal(observeCalls, 0);
  assert.deepEqual(await memory.get("group-1"), []);
});

test("自然语言可以调用本地命令进入回避，但不能产生后续记忆调用", async () => {
  let observeCalls = 0;
  const longTermMemory = {
    async recall() { return []; },
    async observe() { observeCalls += 1; return 0; },
  };
  const { service, sent, memory, aiControl } = createService({
    async respond({ tools, executeTool }) {
      const aiTool = tools.find((tool) => tool.name === "command_ai");
      assert.deepEqual(aiTool.parameters.properties.action.enum, ["off"]);
      return {
        ...(await executeTool("command_ai", { action: "off" })),
        route: "ai-tool",
      };
    },
  }, { longTermMemory });

  await service.handleGatewayPayload(payload({ id: "natural-avoid", content: "小鲤先安静一会儿" }));

  assert.equal(aiControl.isEnabled("group-1"), false);
  assert.match(sent[0].content, /回避状态/);
  assert.equal(observeCalls, 0);
  assert.deepEqual(await memory.get("group-1"), []);
});

test("回避期间本地命令可用，只有显式 /ai on 恢复后才调用 AI", async () => {
  let aiCalls = 0;
  const histories = [];
  const { service, sent } = createService({
    async respond({ history }) {
      aiCalls += 1;
      histories.push(history);
      return { text: "AI 已恢复", route: "ai-text" };
    },
  });

  await service.handleGatewayPayload(payload({ id: "toggle-off", content: "/ai off" }));
  await service.handleGatewayPayload(payload({ id: "toggle-ping", content: "/ping" }));
  assert.equal(sent.at(-1).content, "pong");
  await service.handleGatewayPayload(payload({ id: "toggle-ignored", content: "重新打开 AI" }));
  assert.equal(aiCalls, 0);

  await service.handleGatewayPayload(payload({ id: "toggle-on", content: "/ai on" }));
  assert.match(sent.at(-1).content, /重新开启/);
  await service.handleGatewayPayload(payload({ id: "toggle-chat", content: "现在可以回答了" }));

  assert.equal(aiCalls, 1);
  assert.equal(sent.at(-1).content, "AI 已恢复");
  const combinedHistory = JSON.stringify(histories[0]);
  assert.doesNotMatch(combinedHistory, /重新打开 AI/);
  assert.doesNotMatch(combinedHistory, /小明：\/ping|pong|小明：\/ai on/);
});
