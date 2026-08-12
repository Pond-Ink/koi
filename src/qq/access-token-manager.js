export class AccessTokenError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AccessTokenError";
    this.details = details;
  }
}

export class AccessTokenManager {
  constructor({
    appId,
    appSecret,
    fetchImpl = globalThis.fetch,
    clock = Date.now,
    refreshSkewMs = 120_000,
    requestTimeoutMs = 10_000,
    endpoint = "https://api.bot.qq.com/app/getAppAccessToken",
  }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.refreshSkewMs = refreshSkewMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.endpoint = endpoint;
    this.cached = null;
    this.refreshPromise = null;
  }

  async getToken() {
    if (this.cached && this.clock() < this.cached.expiresAt - this.refreshSkewMs) {
      return this.cached.token;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  invalidate(token) {
    if (!token || this.cached?.token === token) this.cached = null;
  }

  async refresh() {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok || typeof body.access_token !== "string") {
      throw new AccessTokenError("获取 QQ Access Token 失败", {
        status: response.status,
        errCode: body.err_code,
        traceId: body.trace_id,
      });
    }

    const expiresInSeconds = Number(body.expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new AccessTokenError("QQ Access Token 响应缺少有效 expires_in");
    }

    this.cached = {
      token: body.access_token,
      expiresAt: this.clock() + expiresInSeconds * 1000,
    };
    return this.cached.token;
  }
}
