import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const DEEPSEEK_FLASH_MODELS = new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
]);

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

function optionalReasoningEffort(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !REASONING_EFFORTS.has(value.trim())) {
    throw new ConfigurationError(
      `${name} 必须是 ${[...REASONING_EFFORTS].join("、")} 之一，或为 null`,
    );
  }
  return value.trim();
}

function webSearchProvider(value, model, baseUrl) {
  switch (value ?? "auto") {
    case "auto":
      return URL.parse(baseUrl)?.hostname === "api.deepseek.com" && DEEPSEEK_FLASH_MODELS.has(model)
        ? "deepseek"
        : null;
    case "deepseek":
      return "deepseek";
    case "off":
      return null;
    default:
      throw new ConfigurationError("OPENAI_WEB_SEARCH 或 ai.webSearch 必须是 auto、deepseek 或 off");
  }
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
      reasoningEffort: optionalReasoningEffort(
        env.OPENAI_REASONING_EFFORT ?? fileConfig.ai.reasoningEffort,
        "OPENAI_REASONING_EFFORT",
      ),
      webSearch: webSearchProvider(env.OPENAI_WEB_SEARCH ?? fileConfig.ai.webSearch, textModel, textBaseUrl),
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
