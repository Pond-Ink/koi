export class GroupBotIdentityResolver {
  constructor({ qqApi }) {
    this.qqApi = qqApi;
    this.memberOpenids = new Map();
    this.pending = new Map();
  }

  async getMemberOpenid(groupOpenid) {
    const cached = this.memberOpenids.get(groupOpenid);
    if (cached) return cached;

    const inFlight = this.pending.get(groupOpenid);
    if (inFlight) return inFlight;

    const request = this.qqApi.getGroupBotState(groupOpenid)
      .then((state) => {
        const memberOpenid = state?.member_openid;
        if (typeof memberOpenid !== "string" || !memberOpenid) {
          throw new TypeError("机器人群状态响应缺少 member_openid");
        }
        this.memberOpenids.set(groupOpenid, memberOpenid);
        return memberOpenid;
      })
      .finally(() => {
        this.pending.delete(groupOpenid);
      });

    this.pending.set(groupOpenid, request);
    return request;
  }
}
