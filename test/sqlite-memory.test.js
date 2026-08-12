import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GroupAiControl } from "../src/app/group-ai-control.js";
import { LangChainGroupMemory } from "../src/app/langchain-group-memory.js";
import { SqliteDatabase } from "../src/memory/sqlite-database.js";
import { SqliteLongTermMemoryStore } from "../src/memory/sqlite-long-term-memory-store.js";

test("短期消息历史跨 SQLite 重开后仍可读取", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "koi-memory-"));
  const filename = join(directory, "memory.sqlite");

  const firstDatabase = new SqliteDatabase({ filename });
  const first = new LangChainGroupMemory({ database: firstDatabase, maxMessages: 3 });
  await first.addUserMessage("group-a", "小明：第一条");
  await first.addTurn("group-a", { user: "小红：第二条", assistant: "收到" });
  firstDatabase.close();

  const secondDatabase = new SqliteDatabase({ filename });
  t.after(() => {
    secondDatabase.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const second = new LangChainGroupMemory({ database: secondDatabase, maxMessages: 3 });
  assert.deepEqual(await second.get("group-a"), [
    { role: "user", content: "小明：第一条" },
    { role: "user", content: "小红：第二条" },
    { role: "assistant", content: "收到" },
  ]);
  assert.deepEqual(await second.get("group-b"), []);
});

test("长期记忆按群隔离、按稳定键更新并使用向量召回", () => {
  const database = new SqliteDatabase();
  const store = new SqliteLongTermMemoryStore({ database, clock: () => 1000 });
  const source = { msgId: "msg-1", memberOpenid: "member-1", username: "小明" };

  store.upsert({
    groupOpenid: "group-a",
    scope: "member",
    memberOpenid: "member-1",
    kind: "preference",
    memoryKey: "favorite_food",
    content: "小明喜欢面条",
    embedding: [1, 0],
    source,
  });
  store.upsert({
    groupOpenid: "group-a",
    scope: "member",
    memberOpenid: "member-1",
    kind: "preference",
    memoryKey: "favorite_food",
    content: "小明现在更喜欢米饭",
    embedding: [0.9, 0.1],
    source: { ...source, msgId: "msg-2" },
  });
  store.upsert({
    groupOpenid: "group-b",
    scope: "group",
    memberOpenid: "member-2",
    kind: "decision",
    memoryKey: "meeting_time",
    content: "周五开会",
    embedding: [1, 0],
    source: { msgId: "msg-3", memberOpenid: "member-2", username: "小红" },
  });

  const recalled = store.search({ groupOpenid: "group-a", queryEmbedding: [1, 0], limit: 5 });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].content, "小明现在更喜欢米饭");
  assert.equal(store.search({ groupOpenid: "missing", queryEmbedding: [1, 0] }).length, 0);

  store.delete({
    groupOpenid: "group-a",
    scope: "member",
    memberOpenid: "member-1",
    memoryKey: "favorite_food",
  });
  assert.equal(store.search({ groupOpenid: "group-a", queryEmbedding: [1, 0] }).length, 0);
  database.close();
});

test("SQLite 会在服务重启后延续群 AI 回避状态", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "koi-ai-state-"));
  const filename = join(directory, "memory.sqlite");
  let database;

  t.after(() => {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  database = new SqliteDatabase({ filename });
  let control = new GroupAiControl({ database, clock: () => 100 });
  control.setEnabled("group-a", false);
  assert.equal(control.isEnabled("group-a"), false);
  assert.equal(control.isEnabled("group-b"), true);
  database.close();

  database = new SqliteDatabase({ filename });
  control = new GroupAiControl({ database, clock: () => 200 });
  assert.equal(control.isEnabled("group-a"), false);
  control.setEnabled("group-a", true);
  database.close();

  database = new SqliteDatabase({ filename });
  control = new GroupAiControl({ database });
  assert.equal(control.isEnabled("group-a"), true);
});
