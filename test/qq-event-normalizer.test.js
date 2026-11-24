import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGroupMessageEvent } from "../src/qq/qq-event-normalizer.js";
import { formatMessageInput } from "../src/ai/message-context.js";

function quotePayload({ separator = "=" } = {}) {
  return {
    id: "event-quote",
    op: 0,
    s: 8,
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: "current-id",
      content: "这句话是什么意思？",
      group_openid: "group-1",
      author: { member_openid: "member-1", username: "小明", bot: false },
      mentions: [{ member_openid: "bot-member-openid", bot: true, username: "Koi" }],
      message_scene: {
        ext: ["msg_idx=current-idx", `ref_msg_idx${separator}quoted-idx`],
      },
      msg_elements: [
        {
          msg_idx: "quoted-idx",
          content: "被引用的消息",
          author: { username: "小红" },
          attachments: [{ content_type: "image/png", filename: "图.png" }],
        },
        { msg_idx: "current-idx", content: "这句话是什么意思？" },
      ],
    },
  };
}

test("标准化群聊引用消息，且引用正文不混入当前正文", () => {
  const message = normalizeGroupMessageEvent(quotePayload());

  assert.equal(message.text, "这句话是什么意思？");
  assert.equal(message.dedupKey, JSON.stringify(["group-1", "event-quote"]));
  assert.deepEqual(message.replyTo, {
    messageId: "quoted-idx",
    username: "小红",
    isBot: false,
    text: "被引用的消息",
    attachments: [{ content_type: "image/png", filename: "图.png" }],
    imageUrls: [],
  });
});

test("兼容 message_scene 中冒号分隔的引用索引", () => {
  const message = normalizeGroupMessageEvent(quotePayload({ separator: ":" }));
  assert.equal(message.replyTo.messageId, "quoted-idx");
});

test("仅有引用 ID 时仍向下游保留引用关系", () => {
  const payload = quotePayload();
  payload.d.msg_elements = [{ msg_idx: "current-idx", content: "这句话是什么意思？" }];
  payload.d.message_reference = { message_id: "quoted-message-id" };
  payload.d.message_scene.ext = ["msg_idx=current-idx"];

  assert.deepEqual(normalizeGroupMessageEvent(payload).replyTo, {
    messageId: "quoted-message-id",
    username: null,
    isBot: false,
    text: null,
    attachments: [],
    imageUrls: [],
  });
});

test("提取群消息及引用中的图片 URL，并区分图片来源", () => {
  const event = quotePayload();
  event.d.content = "";
  event.d.attachments = [
    { content_type: "image/jpeg", url: "//example.invalid/current.jpg?key=1" },
    { content_type: "audio/mp3", url: "https://example.invalid/audio.mp3" },
    { content_type: "image/png", url: "file:///tmp/image.png" },
  ];
  const [quoted, current] = event.d.msg_elements;
  quoted.attachments = [{ content_type: "image/png", url: "https://example.invalid/quoted.png" }];
  current.content = "";
  current.msg_elements = [{
    attachments: [
      { content_type: "image/jpeg", url: "https://example.invalid/current.jpg?key=1" },
      { filename: "extra.WEBP", url: "https://example.invalid/attachment?key=2" },
    ],
  }];
  event.d.msg_elements.push({
    attachments: [{ content_type: "image/gif", url: "https://example.invalid/sibling.gif" }],
  });

  const message = normalizeGroupMessageEvent(event);

  assert.equal(message.text, "");
  assert.deepEqual(message.imageUrls, [
    "https://example.invalid/current.jpg?key=1",
    "https://example.invalid/attachment?key=2",
    "https://example.invalid/sibling.gif",
  ]);
  assert.deepEqual(message.replyTo.imageUrls, ["https://example.invalid/quoted.png"]);
});

test("合并转发的嵌套正文及图片只保留在可展开记录内，普通输入仅暴露引用", () => {
  const event = quotePayload();
  event.d.message_type = 102;
  event.d.content = "[聊天记录]";
  event.d.message_scene.ext = ["msg_idx=outer"];
  event.d.msg_elements = [{
    msg_idx: "outer",
    message_type: 102,
    msg_elements: [{
      content: "转发原话",
      author: { username: "原作者" },
      timestamp: "2026-11-23T08:30:00+08:00",
      attachments: [{
        content_type: "image/png",
        url: "multimedia.nt.qq.com.cn/download?token=temporary",
      }],
    }],
  }];

  const message = normalizeGroupMessageEvent(event);
  assert.equal(message.text, "");
  assert.equal(message.rawText, "");
  assert.deepEqual(message.imageUrls, []);
  const [card] = message.forwardedMessages;
  assert.equal(card.entries.length, 1);
  const original = card.entries.find((entry) => entry.text === "转发原话");
  assert.equal(original.sender, "原作者");
  assert.equal(original.time, "2026-11-23T08:30:00+08:00");
  assert.deepEqual(original.imageUrls, ["https://multimedia.nt.qq.com.cn/download?token=temporary"]);
  const input = formatMessageInput(message);
  assert.equal(typeof input, "string");
  assert.match(input, /forwarded_messages/);
  assert.ok(input.includes(card.id));
  assert.doesNotMatch(input, /转发原话|原作者|temporary/);
});

test("官方引用聊天记录格式只保留可展开的引用，用户正文独立", () => {
  const event = quotePayload();
  event.d.message_type = 103;
  event.d.content = "请总结这条记录";
  event.d.msg_elements = [{
    content: "=== 消息 1 ===\n[消息内容] 原话甲\n\n=== 消息 2 ===\n[消息内容] 原话乙",
  }];
  const message = normalizeGroupMessageEvent(event);
  assert.equal(message.text, "请总结这条记录");
  assert.equal(message.replyTo.text, null);
  assert.equal(message.forwardedMessages[0].source, "reply");
  assert.equal(message.forwardedMessages[0].entries.length, 2);
  assert.doesNotMatch(formatMessageInput(message), /原话甲|原话乙/);
});

test("合并转发的汇总正文不把外层发送者和时间归因给原消息", () => {
  const event = quotePayload();
  event.d.message_type = 102;
  event.d.content = "=== 消息 1 ===\n[消息内容] 原话";
  event.d.timestamp = "2026-11-24T12:00:00+08:00";
  event.d.msg_elements = [];
  const [entry] = normalizeGroupMessageEvent(event).forwardedMessages[0].entries;
  assert.equal(entry.sender, null);
  assert.equal(entry.time, null);
  assert.match(entry.text, /原话/);
});

test("全量群消息通过 mentions 标记明确 @ 机器人，且允许只有 @", () => {
  const payload = quotePayload();
  payload.t = "GROUP_MESSAGE_CREATE";
  payload.d.content = "";
  payload.d.msg_elements = [];
  payload.d.message_scene.ext = ["msg_idx=current-idx"];
  payload.d.mentions = [{ member_openid: "bot-member-openid", bot: true, username: "Koi" }];

  const message = normalizeGroupMessageEvent(payload, {
    botMemberOpenid: "bot-member-openid",
  });
  assert.equal(message.text, "");
  assert.equal(message.isExplicitBotMention, true);
});

test("全量群消息按机器人在当前群的 member_openid 精确识别 @", () => {
  const payload = quotePayload();
  payload.t = "GROUP_MESSAGE_CREATE";
  payload.d.mentions = [
    { id: "same-global-id", member_openid: "another-member", bot: true, username: "Else" },
    { id: "different-global-id", member_openid: "current-member", username: "Koi" },
  ];

  assert.equal(
    normalizeGroupMessageEvent(payload, {
      botMemberOpenid: "current-member",
    }).isExplicitBotMention,
    true,
  );
  assert.equal(
    normalizeGroupMessageEvent(payload, {
      botMemberOpenid: "missing-member",
    }).isExplicitBotMention,
    false,
  );
});

test("全量群消息优先使用 mentions.is_you 标记当前机器人", () => {
  const payload = quotePayload();
  payload.t = "GROUP_MESSAGE_CREATE";
  payload.d.mentions = [{
    member_openid: "bot-member-openid",
    username: "Koi",
    bot: true,
    is_you: true,
  }];

  const message = normalizeGroupMessageEvent(payload, {
    botMemberOpenid: "another-bot-member-openid",
  });

  assert.equal(message.isExplicitBotMention, true);
  assert.deepEqual(message.mentions, [{
    memberOpenid: "bot-member-openid",
    username: "Koi",
    isBot: true,
    isCurrentBot: true,
  }]);
});

test("引用机器人消息时保留机器人身份", () => {
  const payload = quotePayload();
  payload.d.msg_elements[0].author = { username: "Koi", bot: true };

  assert.equal(normalizeGroupMessageEvent(payload).replyTo.isBot, true);
});

test("AT 事件本身表示 @，全量事件则通过 mentions 判断", () => {
  const atEvent = quotePayload();
  atEvent.d.mentions = [];
  assert.equal(normalizeGroupMessageEvent(atEvent).isExplicitBotMention, true);

  const fullWithoutMention = quotePayload();
  fullWithoutMention.t = "GROUP_MESSAGE_CREATE";
  fullWithoutMention.d.mentions = [];
  assert.equal(normalizeGroupMessageEvent(fullWithoutMention, {
    botMemberOpenid: "bot-member-openid",
  }).isExplicitBotMention, false);

  const fullWithMention = quotePayload();
  fullWithMention.t = "GROUP_MESSAGE_CREATE";
  assert.equal(normalizeGroupMessageEvent(fullWithMention, {
    botMemberOpenid: "bot-member-openid",
  }).isExplicitBotMention, true);
});
