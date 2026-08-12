import assert from "node:assert/strict";
import test from "node:test";
import { AccessTokenManager } from "../src/qq/access-token-manager.js";
import { QqApiClient } from "../src/qq/qq-api-client.js";

test("Access Token 被缓存且并发刷新合并为一次请求", async () => {
  let calls = 0;
  const manager = new AccessTokenManager({
    appId: "app",
    appSecret: "secret",
    clock: () => 1000,
    fetchImpl: async () => {
      calls += 1;
      await Promise.resolve();
      return new Response(JSON.stringify({ access_token: "token", expires_in: 7200 }), { status: 200 });
    },
  });
  assert.deepEqual(await Promise.all([manager.getToken(), manager.getToken()]), ["token", "token"]);
  assert.equal(await manager.getToken(), "token");
  assert.equal(calls, 1);
});

test("群聊回复使用正确 URL、鉴权头和请求字段", async () => {
  let request;
  const client = new QqApiClient({
    tokenManager: { async getToken() { return "access"; }, invalidate() {} },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ id: "reply-id" }), {
        status: 200,
        headers: { "X-Tps-trace-ID": "trace" },
      });
    },
  });
  await client.sendGroupText({ groupOpenid: "group/id", content: "pong", msgId: "msg", msgSeq: 2 });
  assert.equal(request.url, "https://api.bot.qq.com/v2/groups/group%2Fid/messages");
  assert.equal(request.options.headers.Authorization, "QQBot access");
  assert.deepEqual(JSON.parse(request.options.body), {
    msg_type: 0,
    content: "pong",
    msg_id: "msg",
    msg_seq: 2,
  });
});
