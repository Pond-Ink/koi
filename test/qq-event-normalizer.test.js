import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGroupMessageEvent } from "../src/qq/qq-event-normalizer.js";
import { parseForwardTranscript } from "../src/qq/forwarded-transcript.js";
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

test("QQ 正文序列化的合并转发正确分离标题、作者、时间和图片附件", () => {
  const event = quotePayload();
  event.d.message_type = 102;
  event.d.msg_elements = [];
  const first = "https://multimedia.nt.qq.com.cn/download?appid=1&fileid=example1&rkey=ephemeral1&spec=0";
  const second = "https://multimedia.nt.qq.com.cn/download?appid=1&fileid=example2&rkey=ephemeral2&spec=0";
  event.d.content = [
    "[转发者的聊天记录]", "", "=== 消息 1 ===", "[发送者] 小明", "[发送时间] 2026-11-24 22:54:00",
    `[附件1] 类型:图片 文件名:第一张 图片.png 尺寸:596x430 大小:65.3KB URL:${first}`,
    "", "=== 消息 2 ===", "[消息内容] 第一行", "第二行", "[发送者] 小红",
    "", "=== 消息 3 ===", "[发送者] 小明",
    `[附件1] 类型:图片 文件名:第二张.jpg 尺寸:596x430 大小:65.3KB URL:${second}`,
    "", "=== 消息 4 ===", "[消息内容] 已收到", "[发送者] 小红",
  ].join("\r\n");
  const message = normalizeGroupMessageEvent(event);
  const [card] = message.forwardedMessages;
  assert.equal(card.entries.length, 4);
  assert.deepEqual(card.entries.map((entry) => entry.sender), ["小明", "小红", "小明", "小红"]);
  assert.equal(card.entries[0].time, "2026-11-24 22:54:00");
  assert.equal(card.entries[0].text, "");
  assert.deepEqual(card.entries[0].attachments, [{ type: "image", filename: "第一张 图片.png" }]);
  assert.deepEqual(card.entries[0].imageUrls, [first]);
  assert.equal(card.entries[1].text, "第一行\n第二行");
  assert.deepEqual(card.entries[2].imageUrls, [second]);
  assert.equal(card.entries[3].text, "已收到");
  assert.deepEqual(message.imageUrls, []);
  assert.doesNotMatch(JSON.stringify(card.entries.map(({ imageUrls, ...entry }) => entry)), /ephemeral|\[附件1\]|\[发送者\]/);
  assert.doesNotMatch(formatMessageInput(message), /第一行|ephemeral|第一张/);
});

test("合并转发完整重复时忽略同一 QQ 图片的 rkey 差异，只展开一次", () => {
  const event = quotePayload();
  event.d.message_type = 102;
  event.d.msg_elements = [];
  const first = "https://multimedia.nt.qq.com.cn/download?appid=1&fileid=same-file&rkey=first&spec=0";
  const second = first.replace("rkey=first", "rkey=second");
  const image = (url) => `[发送者] 小明\n[附件1] 类型:图片 文件名:截图.png 尺寸:596x430 大小:65.3KB URL:${url}`;
  const text = "[消息内容] 难绷\n[发送者] 小明";
  const transcript = (messages) => ["[小明的聊天记录]", ...messages.map((body, index) => `=== 消息 ${index + 1} ===\n${body}`)].join("\n\n");
  event.d.content = transcript([image(first), text, image(second), text]);
  const card = normalizeGroupMessageEvent(event).forwardedMessages[0];
  assert.equal(card.entries.length, 2);
  assert.deepEqual(card.entries[0].imageUrls, [first]);
  assert.equal(card.entries[1].text, "难绷");
  // A different file, even with identical name and dimensions, is not the same message.
  assert.equal(parseForwardTranscript(transcript([image(first), text, image(second.replace("same-file", "other-file")), text])).length, 4);
  // Nor should differing access parameters other than the temporary rkey be ignored.
  assert.equal(parseForwardTranscript(transcript([image(first), text, image(second.replace("spec=0", "spec=1")), text])).length, 4);
});

test("长转发 38 条整体重复折叠为 19 条，原有正常重复发言仍保留", () => {
  const bodies = Array.from({ length: 19 }, (_, index) => `[消息内容] 第 ${index + 1} 条文本\n[发送者] 小明`);
  bodies[3] = bodies[2];
  const transcript = (messages, numbers = []) => messages.map((text, index) => `=== 消息 ${numbers[index] ?? index + 1} ===\n${text}`).join("\n\n");
  const parsed = parseForwardTranscript(transcript([...bodies, ...bodies]));
  assert.equal(parsed.length, 19);
  assert.deepEqual(parsed.map((entry) => entry.text), bodies.map((body) => body.split("\n")[0].slice("[消息内容] ".length)));
  assert.equal(parsed[2].text, parsed[3].text);
  assert.equal(parseForwardTranscript(transcript([bodies[0], bodies[0]])).length, 2);
  assert.equal(parseForwardTranscript(transcript(Array(4).fill(bodies[0]))).length, 4);
  assert.equal(parseForwardTranscript(transcript([bodies[0], bodies[1], bodies[0], bodies[2]])).length, 4);
  assert.equal(parseForwardTranscript(transcript([bodies[0], bodies[1], bodies[0], bodies[1]], [1, 2, 1, 2])).length, 4);
  const normalUrl = (rkey) => `[消息内容] https://multimedia.nt.qq.com.cn/download?fileid=same&rkey=${rkey}\n[发送者] 小明`;
  assert.equal(parseForwardTranscript(transcript([normalUrl("a"), bodies[1], normalUrl("b"), bodies[1]])).length, 4);
});

test("带标题的引用转发也识别为待展开卡片，任意正文链接不会变为图片输入", () => {
  const event = quotePayload();
  event.d.message_type = 103;
  event.d.content = "图片内容是什么？";
  event.d.msg_elements = [{
    content: ["[小明的聊天记录]", "=== 消息 1 ===", "[消息内容] https://multimedia.nt.qq.com.cn/download?ordinary=text",
      "[附件1] 类型:图片 文件名:外链.png URL:https://example.invalid/remote.png",
      "[附件2] 类型:图片 文件名:假域名.png URL:https://multimedia.nt.qq.com.cn.example.invalid/remote.png",
      "[附件3] 类型:文件 文件名:非图片.pdf URL:https://multimedia.nt.qq.com.cn/download?temporary=3"].join("\n"),
  }];
  const message = normalizeGroupMessageEvent(event);
  const [card] = message.forwardedMessages;
  assert.equal(card.source, "reply");
  assert.equal(card.entries.length, 1);
  assert.equal(message.replyTo.text, null);
  assert.equal(card.entries[0].text, "https://multimedia.nt.qq.com.cn/download?ordinary=text");
  assert.equal(card.entries[0].attachments.length, 3);
  assert.deepEqual(card.entries[0].imageUrls, []);
  assert.doesNotMatch(formatMessageInput(message), /ordinary=|remote\.png|非图片/);
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
