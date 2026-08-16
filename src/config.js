import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function requireValue(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigurationError(`缺少环境变量 ${name}`);
  }
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} 必须是正整数`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ConfigurationError(`${name} 必须是非负整数`);
  }
  return parsed;
}

function fraction(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ConfigurationError(`${name} 必须是 0 到 1 之间的数字`);
  }
  return parsed;
}

export function loadConfig({
  env = process.env,
  configUrl = new URL("../config.json", import.meta.url),
} = {}) {
  const fileConfig = JSON.parse(readFileSync(configUrl, "utf8"));
  const textApiKey = env.OPENAI_TEXT_API_KEY || requireValue(env, "OPENAI_API_KEY");
  const textModel = env.OPENAI_TEXT_MODEL || requireValue(env, "OPENAI_MODEL");
  const textBaseUrl = (
    env.OPENAI_TEXT_BASE_URL
    || env.OPENAI_BASE_URL
    || "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const embeddingBaseUrl = (
    env.OPENAI_EMBEDDING_BASE_URL
    || textBaseUrl
  ).replace(/\/$/, "");
  const embeddingApiKey = env.OPENAI_EMBEDDING_API_KEY || textApiKey;

  return Object.freeze({
    qq: Object.freeze({
      appId: requireValue(env, "QQ_BOT_APP_ID"),
      appSecret: requireValue(env, "QQ_BOT_APP_SECRET"),
      apiBaseUrl: (env.QQ_BOT_API_BASE_URL || "https://api.bot.qq.com").replace(/\/$/, ""),
      intents: nonNegativeInteger(env.QQ_BOT_INTENTS ?? fileConfig.qq.intents, "QQ_BOT_INTENTS"),
      requestTimeoutMs: positiveInteger(fileConfig.qq.requestTimeoutMs, "qq.requestTimeoutMs"),
      maxRetries: nonNegativeInteger(fileConfig.qq.maxRetries, "qq.maxRetries"),
      reconnectBaseDelayMs: positiveInteger(
        fileConfig.qq.reconnectBaseDelayMs,
        "qq.reconnectBaseDelayMs",
      ),
      reconnectMaxDelayMs: positiveInteger(
        fileConfig.qq.reconnectMaxDelayMs,
        "qq.reconnectMaxDelayMs",
      ),
    }),
    ai: Object.freeze({
      apiKey: textApiKey,
      model: textModel,
      baseUrl: textBaseUrl,
      requestTimeoutMs: positiveInteger(fileConfig.ai.requestTimeoutMs, "ai.requestTimeoutMs"),
      maxRetries: nonNegativeInteger(fileConfig.ai.maxRetries, "ai.maxRetries"),
    }),
    memory: Object.freeze({
      databasePath: env.MEMORY_DATABASE_PATH || fileConfig.memory.databasePath,
      extractionModel: env.OPENAI_MEMORY_MODEL || textModel,
      embeddingModel: env.OPENAI_EMBEDDING_MODEL || fileConfig.memory.embeddingModel,
      embeddingBaseUrl,
      embeddingApiKey,
      historyMessages: positiveInteger(
        fileConfig.memory.historyMessages,
        "memory.historyMessages",
      ),
      recallLimit: positiveInteger(fileConfig.memory.recallLimit, "memory.recallLimit"),
      candidateLimit: positiveInteger(
        fileConfig.memory.candidateLimit,
        "memory.candidateLimit",
      ),
      minimumSimilarity: fraction(
        fileConfig.memory.minimumSimilarity,
        "memory.minimumSimilarity",
      ),
      maxOperationsPerMessage: positiveInteger(
        fileConfig.memory.maxOperationsPerMessage,
        "memory.maxOperationsPerMessage",
      ),
    }),
    persona: Object.freeze({
      configPath: resolve(env.PERSONA_CONFIG_PATH || "./config/persona.json"),
    }),
    bot: Object.freeze({
      commandPrefix: fileConfig.bot.commandPrefix,
      dedupTtlMs: positiveInteger(fileConfig.bot.dedupTtlMs, "bot.dedupTtlMs"),
      maxReplyChars: positiveInteger(fileConfig.bot.maxReplyChars, "bot.maxReplyChars"),
    }),
    logLevel: env.LOG_LEVEL || "info",
  });
}
