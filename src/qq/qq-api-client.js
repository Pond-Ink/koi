export class QqApiError extends Error {
  constructor(message, { status, errCode, traceId, retryable = false } = {}) {
    super(message);
    this.name = "QqApiError";
    this.status = status;
    this.errCode = errCode;
    this.traceId = traceId;
    this.retryable = retryable;
  }
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const base = Math.min(500 * 2 ** attempt, 5000);
  return base + Math.floor(Math.random() * 250);
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class QqApiClient {
  constructor({
    tokenManager,
    baseUrl = "https://api.bot.qq.com",
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 10_000,
    maxRetries = 2,
    sleep = defaultSleep,
    logger,
  }) {
    this.tokenManager = tokenManager;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRetries = maxRetries;
    this.sleep = sleep;
    this.logger = logger;
  }

  async request({ method = "GET", path, body }) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const token = await this.tokenManager.getToken();
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `QQBot ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (error) {
        lastError = new QqApiError("QQ API 网络请求失败", { retryable: true });
        if (attempt >= this.maxRetries) throw Object.assign(lastError, { cause: error });
        await this.sleep(500 * 2 ** attempt);
        continue;
      }

      const responseBody = await readBody(response);
      const traceId = response.headers.get("x-tps-trace-id") || responseBody?.trace_id;
      const errCode = Number(responseBody?.err_code ?? 0);
      const isSuccess = response.ok && errCode === 0;
      if (isSuccess) return responseBody;

      if (response.status === 401) this.tokenManager.invalidate(token);
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new QqApiError("QQ API 调用失败", {
        status: response.status,
        errCode: Number.isFinite(errCode) ? errCode : undefined,
        traceId,
        retryable,
      });

      this.logger?.warn("QQ API 返回错误", {
        method,
        path,
        status: response.status,
        errCode: lastError.errCode,
        traceId,
        attempt,
      });

      const canRetry = attempt < this.maxRetries && (retryable || response.status === 401);
      if (!canRetry) throw lastError;
      await this.sleep(retryDelayMs(response, attempt));
    }

    throw lastError;
  }

  getGateway() {
    return this.request({ path: "/gateway" });
  }

  sendGroupText({ groupOpenid, content, msgId, msgSeq = 1 }) {
    const body = { msg_type: 0, content };
    if (msgId) {
      body.msg_id = msgId;
      body.msg_seq = msgSeq;
    }
    return this.request({
      method: "POST",
      path: `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`,
      body,
    });
  }
}
