const SCHEMA = `
CREATE TABLE chat_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_openid TEXT NOT NULL,
  record_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  message_id TEXT,
  sender_openid TEXT,
  sender_name TEXT,
  content TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  reply_to_message_id TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (group_openid, record_key)
);
CREATE INDEX chat_archive_group_time
ON chat_archive (group_openid, sent_at DESC, id DESC);
CREATE INDEX chat_archive_group_sender
ON chat_archive (group_openid, sender_openid, sent_at DESC, id DESC);
`;

const FORWARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_forward_records (
  group_openid TEXT NOT NULL,
  forward_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_index TEXT,
  source TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  entries_json TEXT NOT NULL,
  searchable_text TEXT NOT NULL,
  PRIMARY KEY (group_openid, forward_id)
);
CREATE INDEX IF NOT EXISTS chat_forward_records_message
ON chat_forward_records (group_openid, message_id);
CREATE INDEX IF NOT EXISTS chat_forward_records_index
ON chat_forward_records (group_openid, message_index);
`;

const FORWARD_MEDIA_TTL_MS = 600_000;
const FORWARD_MEDIA_LIMIT = 128;
const LEGACY_PREFIX = "以下是当前群聊消息的结构化数据：\n";

function legacySender(content) {
  if (content.startsWith(LEGACY_PREFIX)) {
    try {
      const data = JSON.parse(content.slice(LEGACY_PREFIX.length));
      return typeof data.sender === "string" ? data.sender : null;
    } catch {
      return null;
    }
  }
  const separator = content.indexOf("：");
  return separator > 0 ? content.slice(0, separator) : null;
}

function optionalText(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 300) {
    throw new TypeError(`${name} 必须是最多 300 字符的文本`);
  }
  return value.trim() || null;
}

function timeBound(value, name) {
  const text = optionalText(value, name);
  if (!text) return null;
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T00:00:00+08:00`
    : text;
  const valueMs = Date.parse(timestamp);
  const calendarDate = new Date(`${text.slice(0, 10)}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
    || !Number.isFinite(valueMs) || !Number.isFinite(calendarDate.getTime())
    || calendarDate.toISOString().slice(0, 10) !== text.slice(0, 10)) {
    throw new TypeError(`${name} 必须是日期或含时区的 ISO 时间`);
  }
  return valueMs;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`查询分页参数必须是 ${minimum}-${maximum} 之间的整数`);
  }
  return number;
}

function beijingTime(timestamp) {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00");
}

function storedForwardEntries(entries) {
  return entries.map(({ imageUrls = [], ...entry }) => ({
    ...entry,
    image_count: imageUrls.length,
  }));
}

export class SqliteChatArchive {
  constructor({ database, botName = "Koi", clock = Date.now }) {
    this.database = database;
    this.botName = botName;
    this.clock = clock;
    this.forwardMedia = new Map();
    this.initialize();
    database.connection.exec(FORWARD_SCHEMA);
    this.insert = database.connection.prepare(`
      INSERT INTO chat_archive (
        group_openid, record_key, role, message_id, sender_openid, sender_name,
        content, sent_at, reply_to_message_id, attachments_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (group_openid, record_key) DO NOTHING
    `);
    this.insertForward = database.connection.prepare(`
      INSERT INTO chat_forward_records (
        group_openid, forward_id, message_id, message_index, source, entry_count,
        entries_json, searchable_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (group_openid, forward_id) DO NOTHING
    `);
    this.getForward = database.connection.prepare(`
      SELECT * FROM chat_forward_records
      WHERE group_openid = ? AND forward_id = ?
    `);
    this.getForwardByIndex = database.connection.prepare(`
      SELECT * FROM chat_forward_records
      WHERE group_openid = ? AND source = 'current'
        AND (message_index = ? OR message_id = ?)
      LIMIT 2
    `);
  }

  initialize() {
    const connection = this.database.connection;
    const exists = connection.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_archive'",
    );
    if (exists.get()) return;
    this.database.transaction(() => {
      if (exists.get()) return;
      connection.exec(SCHEMA);
      const insertLegacy = connection.prepare(`
        INSERT INTO chat_archive (
          group_openid, record_key, role, sender_name, content, sent_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of connection.prepare("SELECT * FROM chat_messages ORDER BY id").all()) {
        insertLegacy.run(
          row.group_openid,
          `legacy:${row.id}`,
          row.role,
          row.role === "assistant" ? this.botName : legacySender(row.content),
          row.content,
          row.created_at,
        );
      }
    });
  }

  recordIncoming(message) {
    const cards = message.forwardedMessages || [];
    const content = [
      message.rawText ?? message.text,
      ...cards.map((card) => `[合并转发 ${card.id}，${card.entries.length} 条目]`),
    ].filter((part) => part !== undefined && part !== null && part !== "").join("\n");
    const insertMessage = () => this.insert.run(
      message.groupOpenid,
      `user:${message.msgId}`,
      "user",
      message.msgId,
      message.memberOpenid || null,
      message.username || null,
      content,
      message.sentAt ?? this.clock(),
      message.replyTo?.messageId || null,
      JSON.stringify(message.attachments || []),
    );
    if (!cards.length) {
      insertMessage();
      return;
    }
    this.database.transaction(() => {
      insertMessage();
      for (const card of cards) {
        const entries = storedForwardEntries(card.entries);
        const searchable = entries.map((entry) => [
          entry.sender, entry.text, ...(entry.attachments || []).map((attachment) => attachment.filename),
        ].filter(Boolean).join("\n")).join("\n");
        this.insertForward.run(
          message.groupOpenid, card.id, message.msgId, message.msgIndex || null,
          card.source, entries.length, JSON.stringify(entries), searchable,
        );
      }
    });
    for (const card of cards) this.cacheForwardMedia(message.groupOpenid, card);
  }

  cacheForwardMedia(groupOpenid, card) {
    const images = card.entries.map((entry) => entry.imageUrls || []);
    if (!images.some((urls) => urls.length)) return;
    const now = this.clock();
    for (const [key, cached] of this.forwardMedia) {
      if (cached.expiresAt <= now) this.forwardMedia.delete(key);
    }
    const key = JSON.stringify([groupOpenid, card.id]);
    this.forwardMedia.delete(key);
    this.forwardMedia.set(key, { images, expiresAt: now + FORWARD_MEDIA_TTL_MS });
    if (this.forwardMedia.size > FORWARD_MEDIA_LIMIT) {
      this.forwardMedia.delete(this.forwardMedia.keys().next().value);
    }
  }

  readForwarded(groupOpenid, options = {}, current = []) {
    const id = optionalText(options.forward_id, "forward_id");
    if (!id) throw new TypeError("缺少合并转发标识");
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER - 30);
    const limit = boundedInteger(options.limit, 20, 1, 30);
    const live = current?.find((card) => card.id === id);
    let entries;
    let source;
    let forwardId = id;
    let images;
    if (live) {
      entries = storedForwardEntries(live.entries);
      images = live.entries.map((entry) => entry.imageUrls || []);
      source = live.source;
    } else {
      let row = this.getForward.get(groupOpenid, id);
      if (!row) {
        const matched = this.getForwardByIndex.all(groupOpenid, id, id);
        if (matched.length === 1) row = matched[0];
      }
      if (!row) return null;
      source = row.source;
      forwardId = row.forward_id;
      entries = JSON.parse(row.entries_json);
      const key = JSON.stringify([groupOpenid, forwardId]);
      const cached = this.forwardMedia.get(key);
      if (cached?.expiresAt > this.clock()) images = cached.images;
      else this.forwardMedia.delete(key);
    }
    return {
      forward_id: forwardId,
      source,
      total_entries: entries.length,
      entries: entries.slice(offset, offset + limit).map((entry, index) => ({
        ...entry,
        imageUrls: images?.[offset + index] || [],
      })),
      next_offset: offset + limit < entries.length ? offset + limit : null,
    };
  }

  recordReply(message, { content, msgSeq, response }) {
    this.insert.run(
      message.groupOpenid,
      `assistant:${message.msgId}:${msgSeq}`,
      "assistant",
      response?.id ? String(response.id) : null,
      null,
      this.botName,
      content,
      this.clock(),
      message.msgId,
      "[]",
    );
  }

  search(groupOpenid, options = {}, { excludeMessageId = null, currentMemberOpenid = null } = {}) {
    const keyword = optionalText(options.keyword, "keyword");
    const member = optionalText(options.member, "member");
    const self = member === "$self";
    const memberOpenid = self ? currentMemberOpenid : member;
    if (self && (!memberOpenid || memberOpenid === "unknown")) {
      throw new TypeError("当前用户的群成员标识不可用");
    }
    const start = timeBound(options.start_time, "start_time");
    const end = timeBound(options.end_time, "end_time");
    if (start !== null && end !== null && start >= end) {
      throw new TypeError("结束时间必须晚于开始时间");
    }
    const limit = boundedInteger(options.limit, 20, 1, 30);
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER - 30);
    const order = options.order ?? "newest";
    if (!["newest", "oldest"].includes(order)) throw new TypeError("无效的历史消息排序");
    const direction = order === "oldest" ? "ASC" : "DESC";

    const conditions = ["group_openid = ?"];
    const bindings = [groupOpenid];
    if (excludeMessageId !== null) {
      conditions.push("record_key <> ?");
      bindings.push(`user:${excludeMessageId}`);
    }
    if (keyword) {
      conditions.push(`(instr(lower(content), lower(?)) > 0 OR EXISTS (
        SELECT 1 FROM json_each(attachments_json)
        WHERE instr(lower(json_extract(value, '$.filename')), lower(?)) > 0
      ) OR EXISTS (
        SELECT 1 FROM chat_forward_records AS f
        WHERE chat_archive.role = 'user' AND f.group_openid = chat_archive.group_openid
          AND f.message_id = chat_archive.message_id
          AND instr(lower(f.searchable_text), lower(?)) > 0
      ))`);
      bindings.push(keyword, keyword, keyword);
    }
    if (self) {
      conditions.push("sender_openid = ?");
      bindings.push(memberOpenid);
    } else if (member) {
      conditions.push("(sender_openid = ? OR instr(lower(sender_name), lower(?)) > 0)");
      bindings.push(member, member);
    }
    if (start !== null) {
      conditions.push("sent_at >= ?");
      bindings.push(start);
    }
    if (end !== null) {
      conditions.push("sent_at < ?");
      bindings.push(end);
    }
    const rows = this.database.connection.prepare(`
      SELECT record_key, role, sender_name, content, sent_at, attachments_json,
        (SELECT json_group_array(json_object(
          'forward_id', f.forward_id, 'source', f.source, 'entry_count', f.entry_count
        )) FROM chat_forward_records AS f
        WHERE chat_archive.role = 'user' AND f.group_openid = chat_archive.group_openid
          AND f.message_id = chat_archive.message_id) AS forward_refs
      FROM chat_archive
      WHERE ${conditions.join(" AND ")}
      ORDER BY sent_at ${direction}, id ${direction}
      LIMIT ? OFFSET ?
    `).all(...bindings, limit + 1, offset);

    return {
      messages: rows.slice(0, limit).map((row) => {
        const forwards = JSON.parse(row.forward_refs);
        return {
          role: row.role,
          sender: row.sender_name,
          time: beijingTime(row.sent_at),
          content: row.content,
          attachments: JSON.parse(row.attachments_json),
          legacy: row.record_key.startsWith("legacy:"),
          ...(forwards.length ? { forwarded_messages: forwards } : {}),
        };
      }),
      next_offset: rows.length > limit ? offset + limit : null,
    };
  }
}
