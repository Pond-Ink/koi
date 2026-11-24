import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIResponsesAgent, SELECTIVE_SILENCE } from "../src/ai/openai-responses-agent.js";
import { EventDeduplicator } from "../src/app/event-deduplicator.js";
import { LangChainGroupMemory } from "../src/app/langchain-group-memory.js";
import { GroupAiControl } from "../src/app/group-ai-control.js";
import { MessageService } from "../src/app/message-service.js";
import { createBuiltinCommandRegistry } from "../src/commands/builtins/index.js";
import { SqliteChatArchive } from "../src/memory/sqlite-chat-archive.js";
import { normalizeGroupMessageEvent } from "../src/qq/qq-event-normalizer.js";

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
  {
    longTermMemory = null,
    botMemberOpenid = "bot-member-openid",
    botIdentityResolver,
    logger: serviceLogger = logger,
    sendGroupText,
  } = {},
) {
  const sent = [];
  const memory = new LangChainGroupMemory();
  const archive = new SqliteChatArchive({ database: memory.database });
  const aiControl = new GroupAiControl();
  const service = new MessageService({
    qqApi: {
      async sendGroupText(message) {
        const response = await sendGroupText?.(message);
        sent.push(message);
        return response;
      },
    },
    registry: createBuiltinCommandRegistry(),
    aiAgent,
    deduplicator: new EventDeduplicator(),
    memory,
    chatArchive: archive,
    longTermMemory,
    aiControl,
    botIdentityResolver: botIdentityResolver || {
      async getMemberOpenid(groupOpenid) {
        assert.equal(groupOpenid, "group-1");
        return botMemberOpenid;
      },
    },
    logger: serviceLogger,
  });
  return { service, sent, memory, aiControl, archive };
}

test("斜杠命令绕过 AI", async () => {
  let aiCalls = 0;
  const { service, sent } = createService({ async respond() { aiCalls += 1; } });
  const event = payload({ id: "msg-1", content: " /ping " });
  event.d.attachments = [{ content_type: "image/png", url: "https://example.invalid/image.png" }];
  await service.handleGatewayPayload(event);
  assert.equal(aiCalls, 0);
  assert.equal(sent[0].content, "pong");
  assert.equal(sent[0].msgId, "msg-1");
});

test("纯图片群消息进入 Responses API，群聊历史只保留图片数量", async () => {
  const imageUrl = "https://example.invalid/image.png?token=temporary";
  const event = payload({ id: "image-only", content: "" });
  event.t = "GROUP_MESSAGE_CREATE";
  event.d.mentions = [];
  event.d.attachments = [{ content_type: "image/png", url: imageUrl }];
  let request;
  const agent = new OpenAIResponsesAgent({
    model: "test-model",
    client: {
      responses: {
        async create(body) {
          request = body;
          return { output_text: SELECTIVE_SILENCE };
        },
      },
    },
  });
  const { service, sent, memory, archive } = createService(agent);

  assert.equal(await service.handleGatewayPayload(event), true);

  const [text, image] = request.input.at(-1).content;
  assert.match(text.text, /"current_message": ""/);
  assert.match(text.text, /"current_image_count": 1/);
  assert.deepEqual(image, { type: "input_image", image_url: imageUrl, detail: "auto" });
  assert.equal(sent.length, 0);
  const [remembered] = await memory.get("group-1");
  assert.match(remembered.content, /"current_image_count": 1/);
  assert.doesNotMatch(remembered.content, /example\.invalid/);
  assert.deepEqual(archive.search("group-1").messages[0].attachments, [
    { type: "image/png", filename: null },
  ]);
});

test("完整存档包含纯文件消息、原始正文、命令和实际发送的回复", async () => {
  const { service, archive } = createService({
    async respond() { assert.fail("纯文件消息和斜杠命令无需调用 AI"); },
  });
  const file = payload({ id: "archive-file", content: "" });
  file.t = "GROUP_MESSAGE_CREATE";
  file.d.mentions = [];
  file.d.timestamp = "2026-11-23T08:00:00+08:00";
  file.d.attachments = [{
    content_type: "application/pdf",
    filename: "团建方案.pdf",
    url: "https://example.invalid/file",
  }];
  await service.handleGatewayPayload(file);
  await service.handleGatewayPayload(payload({ id: "archive-command", content: " /ping " }));

  const recorded = archive.search("group-1", { order: "oldest" }).messages;
  assert.deepEqual(recorded.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "" },
    { role: "user", content: " /ping " },
    { role: "assistant", content: "pong" },
  ]);
  assert.equal(recorded[0].time, "2026-11-23T08:00:00.000+08:00");
  assert.deepEqual(recorded[0].attachments, [{ type: "application/pdf", filename: "团建方案.pdf" }]);
  assert.equal(archive.search("group-1", { keyword: "团建" }).messages.length, 1);
});

test("普通群聊只注入合并转发引用，后续 @ 查询调用工具才提交正文和图片", async () => {
  const imageUrl = "https://multimedia.nt.qq.com.cn/download?fileid=lazy-image&rkey=temporary";
  const event = payload({ id: "lazy-forward", content: [
    "[小明的聊天记录]", "=== 消息 1 ===", "[消息内容] 第一条转发原文", "[发送者] 小明",
    "=== 消息 2 ===", "[消息内容] 第二条转发原文", "[发送者] 小红",
    `[附件1] 类型:图片 文件名:图片.png 尺寸:596x430 大小:65.3KB URL:${imageUrl}`,
  ].join("\n") });
  event.t = "GROUP_MESSAGE_CREATE";
  event.d.mentions = [];
  event.d.message_type = 102;
  event.d.msg_elements = [];
  const forwardId = normalizeGroupMessageEvent(event).forwardedMessages[0].id;
  const requests = [];
  const agent = new OpenAIResponsesAgent({
    model: "test-model",
    webSearch: "deepseek",
    client: { responses: {
      async create(body) {
        requests.push(body);
        if (requests.length === 1) return { output_text: SELECTIVE_SILENCE };
        if (requests.length === 2) return { output: [{
          type: "function_call",
          name: "read_forwarded_message",
          arguments: JSON.stringify({ forward_id: forwardId, offset: 0, limit: 20 }),
        }] };
        return { output_text: "转发总结" };
      },
    } },
  });
  const { service, archive, memory, sent } = createService(agent);
  await service.handleGatewayPayload(event);
  assert.equal(sent.length, 0);
  assert.ok(JSON.stringify(await memory.get("group-1")).includes(forwardId));
  assert.doesNotMatch(JSON.stringify(await memory.get("group-1")), /转发原文|lazy-image/);
  await service.handleGatewayPayload(payload({ id: "expand-forward", content: "总结刚才的合并转发" }));
  assert.equal(requests.length, 3);
  assert.ok(!requests[0].tools.some((tool) => tool.name === "read_forwarded_message"));
  assert.ok(requests[1].tools.some((tool) => tool.name === "read_forwarded_message"));
  for (const request of requests.slice(0, 2)) {
    assert.ok(JSON.stringify(request.input).includes(forwardId));
    assert.doesNotMatch(JSON.stringify(request.input), /第一条转发原文|第二条转发原文|lazy-image/);
  }
  const expanded = requests[2].input.at(-1).content;
  assert.match(expanded[0].text, /第一条转发原文/);
  assert.match(expanded[0].text, /第二条转发原文/);
  assert.doesNotMatch(expanded[0].text, /rkey=temporary|lazy-image/);
  assert.deepEqual(expanded[1], {
    type: "input_image", image_url: imageUrl, detail: "auto",
  });
  assert.deepEqual(requests[2].tools, []);
  assert.equal(sent[0].content, "转发总结");
  const found = archive.search("group-1", { keyword: "第一条转发原文" }).messages[0];
  assert.equal(found.forwarded_messages[0].forward_id, forwardId);
  assert.doesNotMatch(JSON.stringify(found), /第一条转发原文|lazy-image/);
  assert.equal(archive.readForwarded("other-group", { forward_id: forwardId }), null);
});

test("回复发送失败仍保留来信，同群排队消息继续处理和存档", async () => {
  const { service, sent, archive } = createService({
    async respond() { return { text: "收到", route: "ai-text" }; },
  }, {
    async sendGroupText({ msgId }) {
      if (msgId === "send-failed") throw new Error("模拟投递失败");
      return { id: "outgoing-id" };
    },
  });
  const outcomes = await Promise.allSettled([
    service.handleGatewayPayload(payload({ id: "send-failed", content: "第一条" })),
    service.handleGatewayPayload(payload({ id: "send-success", content: "第二条" })),
  ]);
  assert.deepEqual(outcomes.map((item) => item.status), ["rejected", "fulfilled"]);
  assert.equal(sent.length, 1);
  const rows = archive.search("group-1", { order: "oldest" }).messages;
  assert.deepEqual(rows.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "第一条" },
    { role: "user", content: "第二条" },
    { role: "assistant", content: "收到" },
  ]);
});

test("历史查询通过正常消息入口向模型返回同群记录并排除本次提问", async () => {
  const { service, archive, sent } = createService({
    async respond({ message, searchHistory }) {
      if (message.msgId !== "history-question") return { text: null, route: "ai-silent" };
      const result = searchHistory({ keyword: "团建", groupOpenid: "other-group" });
      assert.deepEqual(result.messages.map((item) => item.content), ["团建改到周五"]);
      return { text: result.messages[0].content, route: "ai-history" };
    },
  });
  const other = payload({ id: "other-private", content: "团建秘密" });
  other.d.group_openid = "other-group";
  archive.recordIncoming({
    groupOpenid: other.d.group_openid,
    msgId: other.d.id,
    username: "小红",
    memberOpenid: "other-member",
    text: other.d.content,
  });
  const event = payload({ id: "history-record", content: "团建改到周五" });
  event.t = "GROUP_MESSAGE_CREATE";
  event.d.mentions = [];
  await service.handleGatewayPayload(event);
  await service.handleGatewayPayload(payload({ id: "history-question", content: "团建什么时候？" }));
  assert.equal(sent[0].content, "团建改到周五");
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

test("消息处理日志记录 @ 替换后的内容、群聊和处理结果", async () => {
  const logs = [];
  const event = payload({
    id: "log-mention",
    content: "<@bot-member-openid> 在吗？",
  });
  event.t = "GROUP_MESSAGE_CREATE";
  const { service } = createService(
    { async respond() { return { text: "我在。", route: "ai-text" }; } },
    {
      logger: {
        debug() {},
        warn() {},
        error() {},
        info(message, fields) { logs.push({ message, fields }); },
      },
    },
  );

  await service.handleGatewayPayload(event);

  const handled = logs.find((entry) => entry.message === "群消息处理");
  assert.ok(handled);
  assert.equal(handled.fields.groupOpenid, "group-1");
  assert.equal(handled.fields.action, "已处理消息");
  assert.equal(handled.fields.content, "@当前机器人 在吗？");
  assert.doesNotMatch(handled.fields.content, /bot-member-openid/);
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

test("相同事件 ID 或消息回退 ID 在不同群之间独立去重", async () => {
  const { service, sent, archive } = createService({
    async respond() { return { text: "ok", route: "ai-text" }; },
  });
  for (const useEventId of [true, false]) {
    const first = payload({ id: `shared-${useEventId}`, content: "/ping" });
    if (!useEventId) delete first.id;
    const second = { ...first, d: { ...first.d, group_openid: "group-2" } };

    assert.equal(await service.handleGatewayPayload(first), true);
    assert.equal(await service.handleGatewayPayload(second), true);
    assert.equal(await service.handleGatewayPayload(first), false);
    assert.equal(await service.handleGatewayPayload(second), false);
  }
  assert.deepEqual(sent.map((message) => message.groupOpenid), [
    "group-1", "group-2", "group-1", "group-2",
  ]);
  assert.equal(archive.search("group-1", { keyword: "/ping" }).messages.length, 2);
  assert.equal(archive.search("group-2", { keyword: "/ping" }).messages.length, 2);
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

test("全量群消息交给 AI 选择性判断，静默时写入记忆", async () => {
  const seenHistories = [];
  const logs = [];
  const aiAgent = {
    async respond({ history, engagement }) {
      seenHistories.push(history);
      if (engagement === "selective") return { text: null, route: "ai-silent" };
      assert.equal(engagement, "direct");
      return { text: "ok", route: "ai-text" };
    },
  };
  const { service, sent } = createService(aiAgent, {
    logger: {
      debug() {},
      warn() {},
      error() {},
      info(message, fields) { logs.push({ message, fields }); },
    },
  });

  const observed = payload({ id: "msg-5", content: "下周团建去杭州" });
  observed.t = "GROUP_MESSAGE_CREATE";
  observed.d.mentions = [];
  await service.handleGatewayPayload(observed);
  assert.equal(sent.length, 0);
  assert.deepEqual(seenHistories[0], []);
  assert.deepEqual(logs[0], {
    message: "群消息处理",
    fields: {
      eventType: "GROUP_MESSAGE_CREATE",
      msgId: "msg-5",
      groupOpenid: "group-1",
      content: "下周团建去杭州",
      action: "已静默写入记忆",
      route: "ai-silent",
      longTermOperations: 0,
    },
  });

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
      if (input.engagement === "selective") return { text: null, route: "ai-silent" };
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

test("文本明显面向机器人时由 AI 选择回复", async () => {
  const event = payload({ id: "msg-name", content: "Koi，你怎么看？" });
  event.t = "GROUP_MESSAGE_CREATE";
  event.d.mentions = [];
  const { service, sent } = createService({
    async respond({ engagement, message }) {
      assert.equal(engagement, "selective");
      assert.equal(message.text, "Koi，你怎么看？");
      return { text: "我倾向于先确认时间。", route: "ai-text" };
    },
  });

  await service.handleGatewayPayload(event);

  assert.equal(sent[0].content, "我倾向于先确认时间。");
});

test("讨论机器人但未明确面向机器人时由 AI 选择静默", async () => {
  const event = payload({ id: "msg-about-bot", content: "大家觉得 Koi 的回答怎么样？" });
  event.t = "GROUP_MESSAGE_CREATE";
  event.d.mentions = [];
  const { service, sent, memory } = createService({
    async respond({ engagement }) {
      assert.equal(engagement, "selective");
      return { text: null, route: "ai-silent" };
    },
  });

  await service.handleGatewayPayload(event);

  assert.equal(sent.length, 0);
  assert.deepEqual(await memory.get("group-1"), [
    { role: "user", content: "小明：大家觉得 Koi 的回答怎么样？" },
  ]);
});

test("明确回复机器人消息时由 AI 根据结构化上下文选择回复", async () => {
  const event = payload({ id: "msg-reply-bot", content: "这个建议可以，继续说。" });
  event.t = "GROUP_MESSAGE_CREATE";
  event.d.mentions = [];
  event.d.message_scene.ext.push("ref_msg_idx=bot-message");
  event.d.msg_elements = [{
    msg_idx: "bot-message",
    content: "可以考虑周六出发。",
    author: { username: "Koi", bot: true },
  }];
  const { service, sent } = createService({
    async respond({ engagement, message }) {
      assert.equal(engagement, "selective");
      assert.equal(message.replyTo.isBot, true);
      return { text: "好，我再补充具体安排。", route: "ai-text" };
    },
  });

  await service.handleGatewayPayload(event);

  assert.equal(sent[0].content, "好，我再补充具体安排。");
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
  const { service, sent, memory, archive } = createService({
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
  assert.deepEqual(archive.search("group-1").messages.map((item) => item.role), ["assistant", "user"]);
  assert.equal(archive.search("group-1", { keyword: "不能" }).messages.length, 0);
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
