const SUPPORTED_EVENTS = new Set(["GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"]);

export function isSupportedGroupMessageEvent(payload) {
  return payload?.op === 0
    && SUPPORTED_EVENTS.has(payload.t)
    && Boolean(payload.d?.id)
    && Boolean(payload.d?.group_openid)
    && !payload.d?.author?.bot;
}

function findMessageIndex(message) {
  if (message.msg_idx !== undefined) return String(message.msg_idx);
  if (message.msg_seq !== undefined) return String(message.msg_seq);
  return findSceneValue(message, "msg_idx");
}

function findSceneValue(message, key) {
  const prefix = `${key}=`;
  const colonPrefix = `${key}:`;
  const entry = message.message_scene?.ext?.find((item) => (
    typeof item === "string" && (item.startsWith(prefix) || item.startsWith(colonPrefix))
  ));
  if (!entry) return "";
  return entry.slice(entry.startsWith(prefix) ? prefix.length : colonPrefix.length);
}

function findReferenceIndex(message) {
  const direct = message.ref_msg_idx
    ?? message.message_reference?.message_id
    ?? message.reply?.message_id;
  return direct === undefined || direct === null
    ? findSceneValue(message, "ref_msg_idx")
    : String(direct);
}

function collectElementText(elements = []) {
  return elements
    .flatMap((element) => [element.content, collectElementText(element.msg_elements)])
    .filter(Boolean)
    .join("\n")
    .trim();
}

function findElementByIndex(elements = [], index) {
  for (const element of elements) {
    if (index && String(element.msg_idx ?? "") === index) return element;
    const nested = findElementByIndex(element.msg_elements, index);
    if (nested) return nested;
  }
  return null;
}

function collectCurrentElementText(message, referenceIndex) {
  const currentIndex = findMessageIndex(message);
  const currentElement = findElementByIndex(message.msg_elements, currentIndex);
  if (currentElement && currentIndex !== referenceIndex) {
    return collectElementText([currentElement]);
  }

  return collectElementText(
    (message.msg_elements || []).filter((element) => (
      !referenceIndex || String(element.msg_idx ?? "") !== referenceIndex
    )),
  );
}

function normalizeReplyTo(message) {
  const referenceIndex = findReferenceIndex(message);
  if (!referenceIndex) return null;

  const hasEmbeddedReference = message.ref_msg_idx !== undefined
    || Boolean(findSceneValue(message, "ref_msg_idx"));
  const referenceElement = findElementByIndex(message.msg_elements, referenceIndex)
    || (hasEmbeddedReference ? message.msg_elements?.[0] : null)
    || null;
  const text = referenceElement ? collectElementText([referenceElement]) : "";
  const attachments = referenceElement?.attachments || [];
  const author = referenceElement?.author || referenceElement?.member || {};

  return Object.freeze({
    messageId: referenceIndex,
    username: author.username || author.nickname || null,
    isBot: Boolean(author.bot || author.is_you),
    text: text || null,
    attachments,
  });
}

function normalizeMentions(mentions, botMemberOpenid) {
  if (!Array.isArray(mentions)) return [];
  return mentions.map((mention) => {
    const memberOpenid = mention?.member_openid === undefined
      ? null
      : String(mention.member_openid);
    return Object.freeze({
      memberOpenid,
      username: mention?.username || "群成员",
      isBot: Boolean(mention?.bot),
      isCurrentBot: mention?.is_you === true
        || (Boolean(botMemberOpenid) && memberOpenid === String(botMemberOpenid)),
    });
  });
}

export function normalizeGroupMessageEvent(
  payload,
  { botMemberOpenid = null } = {},
) {
  if (!isSupportedGroupMessageEvent(payload)) return null;
  const message = payload.d;

  const replyTo = normalizeReplyTo(message);
  const text = (
    message.content?.trim()
    || collectCurrentElementText(message, replyTo?.messageId)
  ).trim();
  const mentions = normalizeMentions(message.mentions, botMemberOpenid);
  const isExplicitBotMention = payload.t === "GROUP_AT_MESSAGE_CREATE"
    || mentions.some((mention) => mention.isCurrentBot);
  if (!text && !isExplicitBotMention) return null;

  const msgIndex = findMessageIndex(message);

  return Object.freeze({
    type: payload.t,
    msgId: String(message.id),
    msgIndex,
    groupOpenid: String(message.group_openid),
    memberOpenid: String(message.author?.member_openid || message.author?.id || "unknown"),
    username: message.author?.username || "群成员",
    text,
    isExplicitBotMention,
    mentions,
    replyTo,
    dedupKey: String(payload.id || `${message.id}:${msgIndex}`),
  });
}
