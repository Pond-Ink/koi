export class LongTermMemoryService {
  constructor({
    extractor,
    embeddings,
    store,
    recallLimit = 5,
    candidateLimit = 500,
    minimumSimilarity = 0.2,
  }) {
    this.extractor = extractor;
    this.embeddings = embeddings;
    this.store = store;
    this.recallLimit = recallLimit;
    this.candidateLimit = candidateLimit;
    this.minimumSimilarity = minimumSimilarity;
  }

  async observe(message) {
    const existingMemories = this.store.listForExtraction({
      groupOpenid: message.groupOpenid,
      memberOpenid: message.memberOpenid,
    });
    const operations = await this.extractor.extract({ message, existingMemories });
    const upserts = operations.filter((operation) => operation.action === "upsert");
    const vectors = await this.embeddings.embedDocuments(
      upserts.map((operation) => operation.content),
    );

    let vectorIndex = 0;
    for (const operation of operations) {
      const namespace = {
        groupOpenid: message.groupOpenid,
        scope: operation.scope,
        memberOpenid: message.memberOpenid,
        memoryKey: operation.memory_key,
      };
      if (operation.action === "delete") {
        this.store.delete(namespace);
        continue;
      }
      this.store.upsert({
        ...namespace,
        kind: operation.kind,
        content: operation.content,
        embedding: vectors[vectorIndex],
        source: message,
      });
      vectorIndex += 1;
    }
    return operations.length;
  }

  async recall({ groupOpenid, query }) {
    if (!query.trim()) return [];
    const queryEmbedding = await this.embeddings.embedQuery(query);
    return this.store.search({
      groupOpenid,
      queryEmbedding,
      limit: this.recallLimit,
      candidateLimit: this.candidateLimit,
      minimumSimilarity: this.minimumSimilarity,
    });
  }
}
