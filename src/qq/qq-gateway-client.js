const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const FATAL_CLOSE_CODES = new Set([4914, 4915]);
const RESET_SESSION_CODES = new Set([4006, 4007]);

class FatalGatewayError extends Error {
  constructor(code) {
    super(`Gateway 拒绝连接，关闭码 ${code}`);
    this.name = "FatalGatewayError";
    this.code = code;
  }
}

export class QqGatewayClient {
  constructor({
    apiClient,
    tokenManager,
    intents,
    onDispatch,
    logger,
    reconnectBaseDelayMs = 1000,
    reconnectMaxDelayMs = 30_000,
    websocketFactory = (url) => new WebSocket(url),
  }) {
    this.apiClient = apiClient;
    this.tokenManager = tokenManager;
    this.intents = intents;
    this.onDispatch = onDispatch;
    this.logger = logger;
    this.reconnectBaseDelayMs = reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.websocketFactory = websocketFactory;
    this.stopped = true;
    this.socket = null;
    this.heartbeatTimer = null;
    this.heartbeatAcknowledged = true;
    this.sessionId = null;
    this.latestSequence = null;
  }

  async start() {
    if (!this.stopped) throw new Error("Gateway 已启动");
    this.stopped = false;
    let delay = this.reconnectBaseDelayMs;

    while (!this.stopped) {
      try {
        const gateway = await this.apiClient.getGateway();
        if (!gateway?.url) throw new Error("Gateway 响应缺少 url");
        const result = await this.connectOnce(gateway.url);
        if (FATAL_CLOSE_CODES.has(result.code)) {
          throw new FatalGatewayError(result.code);
        }
        if (RESET_SESSION_CODES.has(result.code)) this.clearSession();
        delay = this.reconnectBaseDelayMs;
      } catch (error) {
        if (this.stopped) break;
        if (error instanceof FatalGatewayError) {
          this.stopped = true;
          throw error;
        }
        this.logger.error("QQ Gateway 连接失败", { error, retryInMs: delay });
        await sleep(delay + Math.floor(Math.random() * 250));
        delay = Math.min(delay * 2, this.reconnectMaxDelayMs);
      }
    }
  }

  stop() {
    this.stopped = true;
    this.clearHeartbeat();
    this.socket?.close(1000, "shutdown");
  }

  clearSession() {
    this.sessionId = null;
    this.latestSequence = null;
  }

  connectOnce(url) {
    return new Promise((resolve) => {
      const socket = this.websocketFactory(url);
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.logger.info("QQ Gateway 已连接");
      });

      socket.addEventListener("message", (event) => {
        void this.handlePayload(event.data).catch((error) => {
          this.logger.error("处理 Gateway Payload 失败", { error });
          socket.close(4002, "invalid payload");
        });
      });

      socket.addEventListener("error", () => {
        this.logger.warn("QQ Gateway WebSocket 发生错误");
      });

      socket.addEventListener("close", (event) => {
        this.clearHeartbeat();
        if (this.socket === socket) this.socket = null;
        this.logger.warn("QQ Gateway 已断开", { code: event.code, reason: event.reason });
        resolve({ code: event.code, reason: event.reason });
      });
    });
  }

  async handlePayload(raw) {
    const payload = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    if (Number.isSafeInteger(payload.s)) this.latestSequence = payload.s;

    switch (payload.op) {
      case 0:
        if (payload.t === "READY") {
          this.sessionId = payload.d.session_id;
          this.logger.info("QQ Gateway 鉴权成功", { sessionId: this.sessionId });
        } else if (payload.t === "RESUMED") {
          this.logger.info("QQ Gateway 会话恢复成功");
        } else {
          void Promise.resolve(this.onDispatch(payload)).catch((error) => {
            this.logger.error("业务事件处理失败", {
              error,
              eventType: payload.t,
              eventId: payload.id,
            });
          });
        }
        break;
      case 7:
        this.socket?.close(4000, "server requested reconnect");
        break;
      case 9:
        if (payload.d === false) this.clearSession();
        this.socket?.close(4000, "invalid session");
        break;
      case 10:
        this.startHeartbeat(payload.d.heartbeat_interval);
        await this.authenticate();
        break;
      case 11:
        this.heartbeatAcknowledged = true;
        break;
      default:
        this.logger.debug("忽略未处理的 Gateway OpCode", { op: payload.op });
    }
  }

  async authenticate() {
    const token = await this.tokenManager.getToken();
    if (this.sessionId && this.latestSequence !== null) {
      this.send({
        op: 6,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.latestSequence },
      });
      return;
    }

    this.send({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: this.intents,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: "koi-bot", $device: "koi-bot" },
      },
    });
  }

  startHeartbeat(intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("Gateway Hello 缺少有效 heartbeat_interval");
    }
    this.clearHeartbeat();
    this.heartbeatAcknowledged = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcknowledged) {
        this.logger.warn("未收到 Heartbeat ACK，重新连接");
        this.socket?.close(4000, "heartbeat timeout");
        return;
      }
      this.heartbeatAcknowledged = false;
      this.send({ op: 1, d: this.latestSequence });
    }, intervalMs);
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway WebSocket 尚未就绪");
    }
    this.socket.send(JSON.stringify(payload));
  }
}
