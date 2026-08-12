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
  const message = normalizeGroupMessageEvent(quotePayload(), () => 123);

  assert.equal(message.text, "这句话是什么意思？");
  assert.deepEqual(message.replyTo, {
    messageId: "quoted-idx",
    username: "小红",
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
    text: null,
    attachments: [],
  });
});
