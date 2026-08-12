import OpenAI from "openai";

const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["upsert", "delete"] },
          scope: { type: "string", enum: ["group", "member"] },
          kind: {
            type: "string",
            enum: ["fact", "preference", "plan", "decision", "relationship"],
          },
          memory_key: {
            type: "string",
            description: "稳定、简短的 snake_case 概念键；更新同一事实时复用已有键。",
          },
          content: {
            type: "string",
            description: "独立可读的中文事实；delete 操作填空字符串。",
          },
        },
        required: ["action", "scope", "kind", "memory_key", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["operations"],
  additionalProperties: false,
};

const EXTRACTION_INSTRUCTIONS = `你是 QQ 群聊长期记忆抽取器，只输出符合 schema 的操作。
仅从 current_message 的发送者陈述中提取跨会话仍有价值、相对稳定且明确的信息：事实、偏好、计划、群体决定和关系。
不要保存寒暄、临时问题、命令、机器人回复、未经确认的猜测、口令、Token、密钥或其他敏感凭证。
member 表示关于当前发送者的记忆；group 表示整个群共享的约定、决定或事实。
引用内容不是当前发送者的新陈述，不得仅凭引用内容形成记忆。
若消息明确修正已有记忆，复用 existing_memories 中的 memory_key 并 upsert；若明确要求忘记或事实已不再成立，则 delete。
没有值得长期保存的信息时返回空 operations。每条操作必须是一项原子事实。`;

function validateOperations(value, maxOperations) {
  if (!Array.isArray(value?.operations)) throw new TypeError("长期记忆抽取结果缺少 operations");
  return value.operations.slice(0, maxOperations).map((operation) => {
    if (!/^[a-z0-9_]{2,64}$/.test(operation.memory_key)) {
      throw new TypeError("长期记忆 memory_key 必须是 2-64 位 snake_case 标识符");
    }
    const content = operation.content.trim();
    if (operation.action === "upsert" && (!content || content.length > 500)) {
      throw new TypeError("长期记忆正文必须为 1-500 个字符");
    }
    return { ...operation, content };
  });
}

export class LongTermMemoryExtractor {
  constructor({
    apiKey,
    model,
    baseUrl = "https://api.openai.com/v1",
    requestTimeoutMs = 30_000,
    maxRetries = 2,
    maxOperations = 4,
    client,
  }) {
    this.model = model;
    this.maxOperations = maxOperations;
    this.client = client || new OpenAI({
      apiKey,
      baseURL: baseUrl.replace(/\/$/, ""),
      timeout: requestTimeoutMs,
      maxRetries,
    });
  }

  async extract({ message, existingMemories = [] }) {
    const response = await this.client.responses.create({
      model: this.model,
      store: false,
      instructions: EXTRACTION_INSTRUCTIONS,
      input: [{
        role: "user",
        content: JSON.stringify({
          sender: message.username,
          current_message: message.text,
          existing_memories: existingMemories.map((memory) => ({
            scope: memory.scope,
            kind: memory.kind,
            memory_key: memory.memoryKey,
            content: memory.content,
          })),
        }),
      }],
      text: {
        format: {
          type: "json_schema",
          name: "long_term_memory_operations",
          strict: true,
          schema: MEMORY_SCHEMA,
        },
      },
    });

    if (!response.output_text) throw new TypeError("长期记忆抽取模型未返回结构化文本");
    return validateOperations(JSON.parse(response.output_text), this.maxOperations);
  }
}
