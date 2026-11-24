const SUPPORTED_EVENTS = new Set(["GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"]);
const IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp)$/i;

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

function flattenElements(elements, excluded) {
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((element) => (
    element && element !== excluded
      ? [element, ...flattenElements(element.msg_elements, excluded)]
      : []
  ));
}

function findElementByIndex(elements, index) {
  return index ? elements.find((element) => String(element.msg_idx ?? "") === index) : null;
}

function collectElementText(elements) {
  return elements.map((element) => element.content).filter(Boolean).join("\n").trim();
}

function getAttachments(message) {
  return Array.isArray(message.attachments) ? message.attachments.filter(Boolean) : [];
}

function messageTimestamp(value) {
  const timestamp = typeof value === "number"
    ? (value < 1e12 ? value * 1000 : value)
    : Date.parse(value);
  return Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp + 28_800_000).getTime())
    ? timestamp
    : Date.now();
}

function getImageUrls(attachments) {
  const urls = new Set();
  for (const attachment of attachments) {
    if (typeof attachment.url !== "string") continue;
    const raw = attachment.url.trim();
    const imageUrl = raw.startsWith("//") ? `https:${raw}` : raw;
    const url = URL.parse(imageUrl);
    if (!url || !/^https?:\/\//i.test(imageUrl) || url.username || url.password) continue;

    const type = String(attachment.content_type || attachment.type || "").trim().toLowerCase();
    const hasImageExtension = IMAGE_EXTENSION.test(attachment.filename || "")
      || IMAGE_EXTENSION.test(url.pathname);
    if (type === "image" || type.startsWith("image/")
      || ((!type || type === "application/octet-stream") && hasImageExtension)) {
      urls.add(imageUrl);
    }
  }
  return [...urls];
}

function findReferenceElement(message, referenceIndex, currentIndex) {
  if (!referenceIndex) return null;

  const hasEmbeddedReference = message.ref_msg_idx !== undefined
    || Boolean(findSceneValue(message, "ref_msg_idx"));
  const matched = findElementByIndex(flattenElements(message.msg_elements), referenceIndex);
  if (matched) return matched;

  const first = message.msg_elements?.[0];
  if (!hasEmbeddedReference || !first || (currentIndex && String(first.msg_idx) === currentIndex)) {
    return null;
  }
  return first;
}

function normalizeReplyTo(referenceIndex, referenceElement) {
  if (!referenceIndex) return null;

  const elements = flattenElements([referenceElement]);
  const text = collectElementText(elements);
  const attachments = elements.flatMap(getAttachments);
  const author = referenceElement?.author || referenceElement?.member || {};

  return Object.freeze({
    messageId: referenceIndex,
    username: author.username || author.nickname || null,
    isBot: Boolean(author.bot || author.is_you),
    text: text || null,
    attachments,
    imageUrls: getImageUrls(attachments),
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
  const groupOpenid = String(message.group_openid);

  const msgIndex = findMessageIndex(message);
  const referenceIndex = findReferenceIndex(message);
  const referenceElement = findReferenceElement(message, referenceIndex, msgIndex);
  const replyTo = normalizeReplyTo(referenceIndex, referenceElement);
  const elements = flattenElements(message.msg_elements, referenceElement);
  const currentElement = findElementByIndex(elements, msgIndex);
  const currentElements = currentElement ? flattenElements([currentElement], referenceElement) : elements;
  const text = message.content?.trim() || collectElementText(currentElements);
  const attachments = [
    ...getAttachments(message),
    ...elements.flatMap(getAttachments),
  ];
  const imageUrls = getImageUrls(attachments);
  const mentions = normalizeMentions(message.mentions, botMemberOpenid);
  const isExplicitBotMention = payload.t === "GROUP_AT_MESSAGE_CREATE"
    || mentions.some((mention) => mention.isCurrentBot);
  return Object.freeze({
    type: payload.t,
    msgId: String(message.id),
    msgIndex,
    groupOpenid,
    memberOpenid: String(message.author?.member_openid || message.author?.id || "unknown"),
    username: message.author?.username || message.author?.nickname || message.member?.nick || "群成员",
    text,
    rawText: typeof message.content === "string" && (message.content.trim() || !text) ? message.content : text,
    sentAt: messageTimestamp(message.timestamp),
    attachments: attachments.map((attachment) => ({
      type: attachment.content_type || attachment.type || "unknown",
      filename: attachment.filename || null,
    })),
    imageUrls,
    isExplicitBotMention,
    mentions,
    replyTo,
    dedupKey: JSON.stringify([groupOpenid, String(payload.id || `${message.id}:${msgIndex}`)]),
  });
}
