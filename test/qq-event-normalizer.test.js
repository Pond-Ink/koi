import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGroupMessageEvent } from "../src/qq/qq-event-normalizer.js";

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
  assert.equal(message.dedupKey, "event-quote");
  assert.deepEqual(message.replyTo, {
    messageId: "quoted-idx",
    username: "小红",
    isBot: false,
    text: "被引用的消息",
    attachments: [{ content_type: "image/png", filename: "图.png" }],
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
  });
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
