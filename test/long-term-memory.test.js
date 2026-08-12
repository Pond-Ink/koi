import assert from "node:assert/strict";
import test from "node:test";
import { LongTermMemoryService } from "../src/app/long-term-memory-service.js";
import { LongTermMemoryExtractor } from "../src/memory/long-term-memory-extractor.js";

test("长期记忆抽取使用严格结构化输出且只提交当前正文", async () => {
  let requestedBody;
  const extractor = new LongTermMemoryExtractor({
    model: "test-model",
    client: {
      responses: {
        async create(body) {
          requestedBody = body;
          return {
            output_text: JSON.stringify({
              operations: [{
                action: "upsert",
                scope: "member",
                kind: "plan",
                memory_key: "exam_plan",
                content: "小明九月参加考试",
              }],
            }),
          };
        },
      },
    },
  });

  const operations = await extractor.extract({
    message: {
      username: "小明",
      text: "我九月要参加考试",
      replyTo: { text: "引用中的内容不应进入抽取请求" },
    },
    existingMemories: [],
  });

  assert.equal(requestedBody.store, false);
  assert.equal(requestedBody.text.format.type, "json_schema");
  assert.equal(requestedBody.text.format.strict, true);
  assert.match(requestedBody.input[0].content, /我九月要参加考试/);
  assert.doesNotMatch(requestedBody.input[0].content, /引用中的内容/);
  assert.equal(operations[0].memory_key, "exam_plan");
});

test("长期记忆服务批量生成向量并执行 upsert/delete", async () => {
  const calls = [];
  const service = new LongTermMemoryService({
    extractor: {
      async extract() {
        return [
          { action: "upsert", scope: "member", kind: "fact", memory_key: "city", content: "小明住在杭州" },
          { action: "delete", scope: "group", kind: "decision", memory_key: "old_plan", content: "" },
        ];
      },
    },
    embeddings: {
      async embedDocuments(texts) {
        assert.deepEqual(texts, ["小明住在杭州"]);
        return [[1, 0]];
      },
      async embedQuery() { return [0, 1]; },
    },
    store: {
      listForExtraction() { return []; },
      upsert(value) { calls.push(["upsert", value]); },
      delete(value) { calls.push(["delete", value]); },
      search(value) { calls.push(["search", value]); return [{ content: "记忆" }]; },
    },
    recallLimit: 3,
    candidateLimit: 50,
    minimumSimilarity: 0.4,
  });
  const message = {
    groupOpenid: "group-1",
    memberOpenid: "member-1",
    username: "小明",
    msgId: "msg-1",
    text: "我住在杭州",
  };

  assert.equal(await service.observe(message), 2);
  assert.equal(calls[0][0], "upsert");
  assert.deepEqual(calls[0][1].embedding, [1, 0]);
  assert.equal(calls[1][0], "delete");
  assert.deepEqual(await service.recall({ groupOpenid: "group-1", query: "住哪里" }), [
    { content: "记忆" },
  ]);
  assert.equal(calls[2][1].limit, 3);
  assert.equal(calls[2][1].candidateLimit, 50);
  assert.equal(calls[2][1].minimumSimilarity, 0.4);
});
