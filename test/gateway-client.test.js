import assert from "node:assert/strict";
import test from "node:test";
import { QqGatewayClient } from "../src/qq/qq-gateway-client.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("Gateway Hello 后使用 QQBot AccessToken 和群聊 Intent 鉴权", async () => {
  const sent = [];
  const gateway = new QqGatewayClient({
    apiClient: {},
    tokenManager: { async getToken() { return "access-token"; } },
    intents: 1 << 25,
    onDispatch() {},
    logger,
  });
  gateway.socket = {
    readyState: WebSocket.OPEN,
    send(value) { sent.push(JSON.parse(value)); },
    close() {},
  };

  await gateway.handlePayload(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
  gateway.clearHeartbeat();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, 2);
  assert.equal(sent[0].d.token, "QQBot access-token");
  assert.equal(sent[0].d.intents, 1 << 25);
  assert.deepEqual(sent[0].d.shard, [0, 1]);
});

test("Gateway 业务事件保留序列号并交给应用层", async () => {
  const events = [];
  const gateway = new QqGatewayClient({
    apiClient: {},
    tokenManager: {},
    intents: 1 << 25,
    onDispatch(payload) { events.push(payload); },
    logger,
  });
  await gateway.handlePayload(JSON.stringify({
    id: "event-1",
    op: 0,
    s: 42,
    t: "GROUP_AT_MESSAGE_CREATE",
    d: { id: "message-1" },
  }));
  await Promise.resolve();
  assert.equal(gateway.latestSequence, 42);
  assert.equal(events[0].id, "event-1");
});
