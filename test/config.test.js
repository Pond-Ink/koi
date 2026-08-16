import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

function baseEnv(overrides = {}) {
  return {
    QQ_BOT_APP_ID: "app-id",
    QQ_BOT_APP_SECRET: "app-secret",
    OPENAI_API_KEY: "api-key",
    OPENAI_MODEL: "text-default",
    OPENAI_BASE_URL: "https://text.example/v1/",
    ...overrides,
  };
}

test("文本处理与 Embedding 可使用不同的模型和 BASE_URL", () => {
  const env = baseEnv({
    OPENAI_TEXT_API_KEY: "text-api-key",
    OPENAI_TEXT_MODEL: "text-model",
    OPENAI_TEXT_BASE_URL: "https://text-provider.example/v1/",
    OPENAI_MEMORY_MODEL: "memory-model",
    OPENAI_EMBEDDING_API_KEY: "embedding-api-key",
    OPENAI_EMBEDDING_MODEL: "embedding-model",
    OPENAI_EMBEDDING_BASE_URL: "https://embedding-provider.example/v1/",
  });
  delete env.OPENAI_API_KEY;
  const config = loadConfig({
    env,
  });

  assert.equal(config.ai.apiKey, "text-api-key");
  assert.equal(config.ai.model, "text-model");
  assert.equal(config.ai.baseUrl, "https://text-provider.example/v1");
  assert.equal(config.memory.extractionModel, "memory-model");
  assert.equal(config.memory.embeddingModel, "embedding-model");
  assert.equal(config.memory.embeddingBaseUrl, "https://embedding-provider.example/v1");
  assert.equal(config.memory.embeddingApiKey, "embedding-api-key");
});

test("未配置专用地址时 Embedding 沿用文本处理配置", () => {
  const config = loadConfig({ env: baseEnv() });

  assert.equal(config.ai.model, "text-default");
  assert.equal(config.ai.apiKey, "api-key");
  assert.equal(config.ai.baseUrl, "https://text.example/v1");
  assert.equal(config.memory.extractionModel, "text-default");
  assert.equal(config.memory.embeddingBaseUrl, "https://text.example/v1");
  assert.equal(config.memory.embeddingApiKey, "api-key");
});
