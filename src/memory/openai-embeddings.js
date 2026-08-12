import { Embeddings } from "@langchain/core/embeddings";
import OpenAI from "openai";

export class OpenAISdkEmbeddings extends Embeddings {
  constructor({
    apiKey,
    model = "text-embedding-3-small",
    baseUrl = "https://api.openai.com/v1",
    requestTimeoutMs = 30_000,
    maxRetries = 2,
    client,
  }) {
    super({ maxConcurrency: 2, maxRetries });
    this.model = model;
    this.client = client || new OpenAI({
      apiKey,
      baseURL: baseUrl.replace(/\/$/, ""),
      timeout: requestTimeoutMs,
      maxRetries,
    });
  }

  async embedDocuments(documents) {
    if (!documents.length) return [];
    const response = await this.client.embeddings.create({
      model: this.model,
      input: documents,
      encoding_format: "float",
    });
    return [...response.data]
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);
  }

  async embedQuery(document) {
    const [embedding] = await this.embedDocuments([document]);
    return embedding;
  }
}
