import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LangChainGroupMemory } from "../src/app/langchain-group-memory.js";
import { SqliteDatabase } from "../src/memory/sqlite-database.js";
import { SqliteChatArchive } from "../src/memory/sqlite-chat-archive.js";

test("完整存档跨重启保留全部消息，并仅迁移一次现存的旧上下文", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "koi-archive-"));
  const filename = join(directory, "archive.sqlite");
  let database = new SqliteDatabase({ filename });
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const memory = new LangChainGroupMemory({ database, maxMessages: 3 });
  await memory.addUserMessage("group-a", "小明：旧消息");
  let archive = new SqliteChatArchive({ database });
  const start = Date.parse("2026-11-23T08:00:00+08:00");
  for (let index = 0; index < 40; index += 1) {
    const message = {
      groupOpenid: "group-a",
      msgId: `message-${index}`,
      username: "小明",
      memberOpenid: "member-1",
      text: `团建讨论第 ${index} 条`,
      sentAt: start + index * 1000,
    };
    archive.recordIncoming(message);
    archive.recordIncoming(message);
    await memory.addUserMessage("group-a", message.text);
  }
  assert.equal((await memory.get("group-a")).length, 3);
  database.close();
  database = new SqliteDatabase({ filename });
  archive = new SqliteChatArchive({ database });

  const firstPage = archive.search("group-a", { keyword: "团建", order: "oldest", limit: 30 });
  assert.equal(firstPage.messages.length, 30);
  assert.equal(firstPage.messages[0].content, "团建讨论第 0 条");
  assert.equal(firstPage.next_offset, 30);
  const lastPage = archive.search("group-a", { keyword: "团建", order: "oldest", offset: 30 });
  assert.equal(lastPage.messages.length, 10);
  assert.equal(lastPage.next_offset, null);
  const legacy = archive.search("group-a", { keyword: "旧消息", member: "小明" });
  assert.equal(legacy.messages.length, 1);
  assert.equal(legacy.messages[0].legacy, true);
});

test("完整存档支持时间范围、成员、本人及关键词联合查询，群之间隔离", () => {
  const database = new SqliteDatabase();
  const archive = new SqliteChatArchive({ database });
  const message = {
    groupOpenid: "group-a",
    msgId: "one",
    username: "小明",
    memberOpenid: "member-1",
    text: "团建：杭州",
    sentAt: Date.parse("2026-11-23T10:00:00+08:00"),
  };
  archive.recordIncoming(message);
  archive.recordIncoming({
    ...message, msgId: "two", username: "小明", memberOpenid: "member-2", text: "团建：上海",
  });
  archive.recordIncoming({
    ...message, msgId: "three", sentAt: Date.parse("2026-11-24T00:00:00+08:00"),
  });
  archive.recordIncoming({ ...message, groupOpenid: "group-b", text: "团建：其他群" });
  const options = {
    keyword: "团建", member: "$self", start_time: "2026-11-23", end_time: "2026-11-24",
  };
  const result = archive.search("group-a", options, { currentMemberOpenid: "member-1" });
  assert.deepEqual(result.messages.map((row) => row.content), ["团建：杭州"]);
  assert.equal(result.messages[0].time, "2026-11-23T10:00:00.000+08:00");
  assert.equal(archive.search("group-b", { keyword: "杭州" }).messages.length, 0);
  assert.throws(() => archive.search("group-a", { start_time: "invalid" }), /ISO/);
  assert.throws(() => archive.search("group-a", { start_time: "2026-02-31" }), /ISO/);
  assert.throws(() => archive.search("group-a", { limit: 500 }), /分页/);
  database.close();
});

test("合并转发原文单独持久化，历史搜索只返回引用，图片链接仅临时缓存", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "koi-forward-"));
  const filename = join(directory, "archive.sqlite");
  let database = new SqliteDatabase({ filename });
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let now = 1000;
  let archive = new SqliteChatArchive({ database, clock: () => now });
  const card = {
    id: "forward-card-one",
    source: "current",
    entries: [
      { sender: "小红", time: "2026-11-20T12:00:00+08:00", text: "转发秘密文字", attachments: [], imageUrls: [] },
      { sender: "小明", time: null, text: "查看图片", attachments: [{ type: "image/png", filename: "图.png" }],
        imageUrls: ["https://example.invalid/temporary"] },
    ],
  };
  archive.recordIncoming({
    groupOpenid: "group-a", msgId: "message-one", msgIndex: "original-index",
    username: "转发者", memberOpenid: "member-a", text: "", forwardedMessages: [card],
  });
  assert.equal(archive.search("group-a", { keyword: "秘密文字" }).messages.length, 1);
  assert.doesNotMatch(JSON.stringify(archive.search("group-a", { keyword: "秘密文字" })), /秘密文字|temporary/);
  assert.equal(archive.readForwarded("group-b", { forward_id: card.id }), null);
  const first = archive.readForwarded("group-a", { forward_id: "original-index", limit: 1 });
  assert.equal(first.entries[0].text, "转发秘密文字");
  assert.equal(first.next_offset, 1);
  const second = archive.readForwarded("group-a", { forward_id: card.id, offset: 1 });
  assert.deepEqual(second.entries[0].imageUrls, ["https://example.invalid/temporary"]);
  const stored = database.connection.prepare("SELECT entries_json FROM chat_forward_records").get();
  assert.doesNotMatch(stored.entries_json, /temporary|imageUrls/);
  now += 600_001;
  assert.deepEqual(archive.readForwarded("group-a", { forward_id: card.id, offset: 1 }).entries[0].imageUrls, []);
  database.close();
  database = new SqliteDatabase({ filename });
  archive = new SqliteChatArchive({ database });
  const reopened = archive.readForwarded("group-a", { forward_id: card.id });
  assert.equal(reopened.entries[0].text, "转发秘密文字");
  assert.equal(reopened.entries[1].image_count, 1);
  assert.deepEqual(reopened.entries[1].imageUrls, []);
});
