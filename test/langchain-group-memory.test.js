import assert from "node:assert/strict";
import test from "node:test";
import { LangChainGroupMemory } from "../src/app/langchain-group-memory.js";

test("LangChain 群聊记忆按 group_openid 隔离", async () => {
  const memory = new LangChainGroupMemory({ maxMessages: 4 });
  await memory.addUserMessage("group-a", "小明：杭州");
  await memory.addUserMessage("group-b", "小红：上海");

  assert.deepEqual(await memory.get("group-a"), [
    { role: "user", content: "小明：杭州" },
  ]);
  assert.deepEqual(await memory.get("group-b"), [
    { role: "user", content: "小红：上海" },
  ]);
});

test("LangChain 群聊记忆保留最近的配置条数", async () => {
  const memory = new LangChainGroupMemory({ maxMessages: 3 });
  await memory.addUserMessage("group-a", "第一条");
  await memory.addTurn("group-a", { user: "第二条", assistant: "回复" });
  await memory.addUserMessage("group-a", "第三条");

  assert.deepEqual(await memory.get("group-a"), [
    { role: "user", content: "第二条" },
    { role: "assistant", content: "回复" },
    { role: "user", content: "第三条" },
  ]);
});
