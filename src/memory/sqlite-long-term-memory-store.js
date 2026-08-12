import { randomUUID } from "node:crypto";

function parseEmbedding(value) {
  if (!value) return null;
  try {
    const embedding = JSON.parse(value);
    return Array.isArray(embedding) ? embedding : null;
  } catch {
    return null;
  }
}

function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (!leftNorm || !rightNorm) return -1;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function fromRow(row) {
  return {
    id: row.id,
    groupOpenid: row.group_openid,
    scope: row.scope,
    subjectOpenid: row.subject_openid || null,
    kind: row.kind,
    memoryKey: row.memory_key,
    content: row.content,
    embedding: parseEmbedding(row.embedding_json),
    sourceMessageId: row.source_message_id,
    sourceAuthorOpenid: row.source_author_openid,
    sourceAuthorName: row.source_author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRecalledAt: row.last_recalled_at,
  };
}

export class SqliteLongTermMemoryStore {
  constructor({ database, clock = Date.now }) {
    this.database = database;
    this.clock = clock;
    this.selectNamespace = database.connection.prepare(`
      SELECT * FROM long_term_memories
      WHERE group_openid = ?
        AND (scope = 'group' OR (scope = 'member' AND subject_openid = ?))
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    this.selectGroup = database.connection.prepare(`
      SELECT * FROM long_term_memories
      WHERE group_openid = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    this.upsertStatement = database.connection.prepare(`
      INSERT INTO long_term_memories (
        id, group_openid, scope, subject_openid, kind, memory_key, content,
        embedding_json, source_message_id, source_author_openid, source_author_name,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (group_openid, scope, subject_openid, memory_key) DO UPDATE SET
        kind = excluded.kind,
        content = excluded.content,
        embedding_json = excluded.embedding_json,
        source_message_id = excluded.source_message_id,
        source_author_openid = excluded.source_author_openid,
        source_author_name = excluded.source_author_name,
        updated_at = excluded.updated_at
    `);
    this.deleteStatement = database.connection.prepare(`
      DELETE FROM long_term_memories
      WHERE group_openid = ? AND scope = ? AND subject_openid = ? AND memory_key = ?
    `);
    this.touchStatement = database.connection.prepare(`
      UPDATE long_term_memories SET last_recalled_at = ? WHERE id = ?
    `);
  }

  listForExtraction({ groupOpenid, memberOpenid, limit = 30 }) {
    return this.selectNamespace
      .all(groupOpenid, memberOpenid, limit)
      .map(fromRow);
  }

  upsert({ groupOpenid, scope, memberOpenid, kind, memoryKey, content, embedding, source }) {
    const subjectOpenid = scope === "member" ? memberOpenid : "";
    const now = this.clock();
    this.upsertStatement.run(
      randomUUID(),
      groupOpenid,
      scope,
      subjectOpenid,
      kind,
      memoryKey,
      content,
      JSON.stringify(embedding),
      source.msgId,
      source.memberOpenid,
      source.username,
      now,
      now,
    );
  }

  delete({ groupOpenid, scope, memberOpenid, memoryKey }) {
    const subjectOpenid = scope === "member" ? memberOpenid : "";
    this.deleteStatement.run(groupOpenid, scope, subjectOpenid, memoryKey);
  }

  search({
    groupOpenid,
    queryEmbedding,
    limit = 5,
    candidateLimit = 500,
    minimumSimilarity = 0.2,
  }) {
    const candidates = this.selectGroup
      .all(groupOpenid, candidateLimit)
      .map(fromRow)
      .map((memory) => ({
        ...memory,
        score: cosineSimilarity(queryEmbedding, memory.embedding),
      }))
      .filter((memory) => memory.score >= minimumSimilarity)
      .sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt)
      .slice(0, limit);

    if (candidates.length) {
      const now = this.clock();
      this.database.transaction(() => {
        for (const memory of candidates) this.touchStatement.run(now, memory.id);
      });
    }
    return candidates;
  }
}
