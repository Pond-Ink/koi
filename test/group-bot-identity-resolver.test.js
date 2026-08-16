import assert from "node:assert/strict";
import test from "node:test";
import { GroupBotIdentityResolver } from "../src/qq/group-bot-identity-resolver.js";

test("机器人群身份按 group_openid 缓存并合并并发查询", async () => {
  const calls = [];
  const resolver = new GroupBotIdentityResolver({
    qqApi: {
      async getGroupBotState(groupOpenid) {
        calls.push(groupOpenid);
        await Promise.resolve();
        return { member_openid: `bot-in-${groupOpenid}` };
      },
    },
  });

  assert.deepEqual(
    await Promise.all([
      resolver.getMemberOpenid("group-a"),
      resolver.getMemberOpenid("group-a"),
    ]),
    ["bot-in-group-a", "bot-in-group-a"],
  );
  assert.equal(await resolver.getMemberOpenid("group-a"), "bot-in-group-a");
  assert.equal(await resolver.getMemberOpenid("group-b"), "bot-in-group-b");
  assert.deepEqual(calls, ["group-a", "group-b"]);
});

test("无 member_openid 的群状态不会进入缓存", async () => {
  let calls = 0;
  const resolver = new GroupBotIdentityResolver({
    qqApi: {
      async getGroupBotState() {
        calls += 1;
        return calls === 1 ? {} : { member_openid: "bot-member" };
      },
    },
  });

  await assert.rejects(resolver.getMemberOpenid("group-a"), /缺少 member_openid/);
  assert.equal(await resolver.getMemberOpenid("group-a"), "bot-member");
  assert.equal(calls, 2);
});
