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

export class SqliteChatArchive {
  constructor({ database, botName = "Koi", clock = Date.now }) {
    this.database = database;
    this.botName = botName;
    this.clock = clock;
    this.initialize();
    this.insert = database.connection.prepare(`
      INSERT INTO chat_archive (
        group_openid, record_key, role, message_id, sender_openid, sender_name,
        content, sent_at, reply_to_message_id, attachments_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (group_openid, record_key) DO NOTHING
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
    this.insert.run(
      message.groupOpenid,
      `user:${message.msgId}`,
      "user",
      message.msgId,
      message.memberOpenid || null,
      message.username || null,
      message.rawText ?? message.text,
      message.sentAt ?? this.clock(),
      message.replyTo?.messageId || null,
      JSON.stringify(message.attachments || []),
    );
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
      ))`);
      bindings.push(keyword, keyword);
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
      SELECT record_key, role, sender_name, content, sent_at, attachments_json
      FROM chat_archive
      WHERE ${conditions.join(" AND ")}
      ORDER BY sent_at ${direction}, id ${direction}
      LIMIT ? OFFSET ?
    `).all(...bindings, limit + 1, offset);

    return {
      messages: rows.slice(0, limit).map((row) => ({
        role: row.role,
        sender: row.sender_name,
        time: beijingTime(row.sent_at),
        content: row.content,
        attachments: JSON.parse(row.attachments_json),
        legacy: row.record_key.startsWith("legacy:"),
      })),
      next_offset: rows.length > limit ? offset + limit : null,
    };
  }
}
