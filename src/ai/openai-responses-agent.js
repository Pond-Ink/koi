import OpenAI from "openai";
import { formatLongTermMemoriesForAi, formatMessageForAi } from "./message-context.js";
import { buildAgentInstructions } from "../persona/prompt-builder.js";

const DEFAULT_PERSONA = Object.freeze({
  version: 1,
  name: "QQ 群聊机器人",
  identity: "群聊中的 AI 助手。",
  background: [],
  personality: ["友好、诚实。"],
  speakingStyle: {
    language: "简体中文",
    tone: "简洁、自然",
    verbosity: "简洁",
    habits: [],
  },
  behavior: [],
  boundaries: [],
});

function extractOutputText(response) {
  return (response.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export class OpenAIResponsesError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OpenAIResponsesError";
    this.details = details;
  }
}

export class OpenAIResponsesAgent {
  constructor({
    apiKey,
    model,
    baseUrl,
    requestTimeoutMs = 30_000,
    maxRetries = 2,
    persona = DEFAULT_PERSONA,
    client,
  }) {
    this.model = model;
    this.instructions = buildAgentInstructions(persona);
    this.client = client || new OpenAI({
      apiKey,
      baseURL: baseUrl.replace(/\/$/, ""),
      timeout: requestTimeoutMs,
      maxRetries,
    });
  }

  async respond({ message, history, longTermMemories = [], tools, executeTool }) {
    const recalledMemory = formatLongTermMemoriesForAi(longTermMemories);
    const input = [
      ...history,
      ...(recalledMemory ? [{ role: "developer", content: recalledMemory }] : []),
      { role: "user", content: formatMessageForAi(message) },
    ];
    let response;
    try {
      response = await this.client.responses.create({
        model: this.model,
        store: false,
        instructions: this.instructions,
        input,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
      });
    } catch (error) {
      throw new OpenAIResponsesError("OpenAI Responses API 调用失败", {
        status: error.status,
        requestId: error.request_id,
        code: error.code,
        type: error.type,
      });
    }

    const toolCall = response.output?.find((item) => item.type === "function_call");
    if (toolCall) {
      let args;
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        throw new OpenAIResponsesError("模型返回了无效的工具参数 JSON");
      }
      const result = await executeTool(toolCall.name, args);
      return { ...result, route: "ai-tool" };
    }

    const text = response.output_text?.trim() || extractOutputText(response);
    if (!text) throw new OpenAIResponsesError("模型未返回文本或工具调用");
    return { text, route: "ai-text" };
  }
}
