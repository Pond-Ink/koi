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

test("升级旧版合并转发存档时纠正条目数并清理正文中的临时附件链接", () => {
  const database = new SqliteDatabase();
  const now = 1_000_000;
  let archive = new SqliteChatArchive({ database, clock: () => now });
  const url = "https://multimedia.nt.qq.com.cn/download?fileid=old&rkey=old-secret";
  const entries = [
    { path: [1], text: "[小明的聊天记录]" },
    { path: [2], text: `=== 消息 1 ===\n[发送者] 小明\n[附件1] 类型:图片 文件名:旧图.png URL:${url}` },
    { path: [3], text: "=== 消息 2 ===\n[消息内容] 旧转发正文\n[发送者] 小红" },
    { path: [4], text: `=== 消息 3 ===\n[发送者] 小明\n[附件1] 类型:图片 文件名:旧图.png URL:${url.replace("old-secret", "old-secret-copy")}` },
    { path: [5], text: "=== 消息 4 ===\n[消息内容] 旧转发正文\n[发送者] 小红" },
  ].map((entry) => ({ ...entry, sender: null, time: null, attachments: [], imageUrls: [] }));
  const card = { id: "forward-legacy-one", source: "current", entries };
  const message = { groupOpenid: "group-a", msgId: "one", username: "转发者", text: "", forwardedMessages: [card], sentAt: now - 60_000 };
  archive.recordIncoming(message);
  archive.recordIncoming({ ...message, groupOpenid: "group-b", sentAt: now - 600_001 });
  database.connection.exec("ALTER TABLE chat_forward_records DROP COLUMN format_version");

  archive = new SqliteChatArchive({ database, clock: () => now });
  const recent = archive.readForwarded("group-a", { forward_id: card.id });
  assert.equal(recent.total_entries, 2);
  assert.equal(recent.entries[0].sender, "小明");
  assert.deepEqual(recent.entries[0].imageUrls, [url]);
  assert.equal(recent.entries[0].image_count, 1);
  assert.equal(recent.entries[1].text, "旧转发正文");
  assert.equal(recent.entries[1].sender, "小红");
  const old = archive.readForwarded("group-b", { forward_id: card.id });
  assert.deepEqual(old.entries[0].imageUrls, []);
  assert.equal(old.entries[0].image_count, 1);
  const found = archive.search("group-a", { keyword: "旧转发正文" }).messages[0];
  assert.equal(found.forwarded_messages[0].entry_count, 2);
  assert.match(found.content, /2 条目/);
  assert.doesNotMatch(JSON.stringify(database.connection.prepare("SELECT entries_json, searchable_text FROM chat_forward_records").all()), /old-secret|rkey=/);
  assert.equal(archive.readForwarded("group-c", { forward_id: card.id }), null);
  archive = new SqliteChatArchive({ database, clock: () => now });
  assert.equal(archive.readForwarded("group-a", { forward_id: card.id }).total_entries, 2);
  assert.deepEqual(archive.readForwarded("group-a", { forward_id: card.id }).entries[0].imageUrls, []);
  database.close();
});

test("旧版存档中的长转发按连续同源编号去除重复副本，保留独立分支", () => {
  const database = new SqliteDatabase();
  let archive = new SqliteChatArchive({ database });
  const bodies = Array.from({ length: 19 }, (_, index) => `[消息内容] 原文 ${index + 1}\n[发送者] 小明`);
  const heading = (body, index) => `=== 消息 ${index + 1} ===\n${body}`;
  const entries = [
    { path: [1], text: "[群聊的聊天记录]" },
    ...[...bodies, ...bodies].map((body, index) => ({ path: [index + 2], text: heading(body, index) })),
  ].map((entry) => ({ ...entry, sender: null, time: null, attachments: [], imageUrls: [] }));
  // A different nested branch is independent, despite starting over at 1.
  entries.push({ path: [40, 1], text: heading(bodies[0], 0), sender: null, time: null, attachments: [], imageUrls: [] });
  archive.recordIncoming({ groupOpenid: "group-a", msgId: "long", text: "", username: "小明",
    forwardedMessages: [{ id: "long-forward", source: "current", entries }] });
  database.connection.exec("ALTER TABLE chat_forward_records DROP COLUMN format_version");
  archive = new SqliteChatArchive({ database });
  const result = archive.readForwarded("group-a", { forward_id: "long-forward", limit: 30 });
  assert.equal(result.total_entries, 20);
  assert.deepEqual(result.entries.map((entry) => entry.text), [...bodies, bodies[0]].map((body) => body.split("\n")[0].slice("[消息内容] ".length)));
  assert.equal(result.next_offset, null);
  assert.equal(archive.search("group-a", { keyword: "原文 19" }).messages[0].forwarded_messages[0].entry_count, 20);
  database.close();
});
