import { OpenAIResponsesAgent } from "./ai/openai-responses-agent.js";
import { LangChainGroupMemory } from "./app/langchain-group-memory.js";
import { EventDeduplicator } from "./app/event-deduplicator.js";
import { GroupAiControl } from "./app/group-ai-control.js";
import { MessageService } from "./app/message-service.js";
import { LongTermMemoryService } from "./app/long-term-memory-service.js";
import { createBuiltinCommandRegistry } from "./commands/builtins/index.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./infra/logger.js";
import { LongTermMemoryExtractor } from "./memory/long-term-memory-extractor.js";
import { OpenAISdkEmbeddings } from "./memory/openai-embeddings.js";
import { SqliteDatabase } from "./memory/sqlite-database.js";
import { SqliteLongTermMemoryStore } from "./memory/sqlite-long-term-memory-store.js";
import { loadPersona } from "./persona/persona-loader.js";
import { AccessTokenManager } from "./qq/access-token-manager.js";
import { GroupBotIdentityResolver } from "./qq/group-bot-identity-resolver.js";
import { QqApiClient } from "./qq/qq-api-client.js";
import { QqGatewayClient } from "./qq/qq-gateway-client.js";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const persona = loadPersona({ personaUrl: config.persona.configPath });

const tokenManager = new AccessTokenManager({
  appId: config.qq.appId,
  appSecret: config.qq.appSecret,
  requestTimeoutMs: config.qq.requestTimeoutMs,
  endpoint: `${config.qq.apiBaseUrl}/app/getAppAccessToken`,
});

const qqApi = new QqApiClient({
  tokenManager,
  baseUrl: config.qq.apiBaseUrl,
  requestTimeoutMs: config.qq.requestTimeoutMs,
  maxRetries: config.qq.maxRetries,
  logger,
});

const registry = createBuiltinCommandRegistry({ prefix: config.bot.commandPrefix });
const aiAgent = new OpenAIResponsesAgent({ ...config.ai, persona });
const database = new SqliteDatabase({ filename: config.memory.databasePath });
const embeddings = new OpenAISdkEmbeddings({
  ...config.ai,
  apiKey: config.memory.embeddingApiKey,
  model: config.memory.embeddingModel,
  baseUrl: config.memory.embeddingBaseUrl,
});
const longTermMemory = new LongTermMemoryService({
  extractor: new LongTermMemoryExtractor({
    ...config.ai,
    model: config.memory.extractionModel,
    maxOperations: config.memory.maxOperationsPerMessage,
  }),
  embeddings,
  store: new SqliteLongTermMemoryStore({ database }),
  recallLimit: config.memory.recallLimit,
  candidateLimit: config.memory.candidateLimit,
  minimumSimilarity: config.memory.minimumSimilarity,
});
const messageService = new MessageService({
  qqApi,
  registry,
  aiAgent,
  deduplicator: new EventDeduplicator({ ttlMs: config.bot.dedupTtlMs }),
  memory: new LangChainGroupMemory({
    database,
    maxMessages: config.memory.historyMessages,
  }),
  longTermMemory,
  botIdentityResolver: new GroupBotIdentityResolver({ qqApi }),
  aiControl: new GroupAiControl({ database }),
  botName: persona.name,
  maxReplyChars: config.bot.maxReplyChars,
  logger,
});

const gateway = new QqGatewayClient({
  apiClient: qqApi,
  tokenManager,
  intents: config.qq.intents,
  onDispatch: (payload) => messageService.handleGatewayPayload(payload),
  logger,
  reconnectBaseDelayMs: config.qq.reconnectBaseDelayMs,
  reconnectMaxDelayMs: config.qq.reconnectMaxDelayMs,
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("收到退出信号", { signal });
  gateway.stop();
  await messageService.waitForIdle();
  database.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

logger.info("启动 QQ 群聊机器人", {
  intents: config.qq.intents,
  model: config.ai.model,
  persona: persona.name,
  memoryDatabase: database.filename,
});
await gateway.start();
