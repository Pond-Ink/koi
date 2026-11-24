import { createHash } from "node:crypto";
import { isForwardTranscript, isForwardTranscriptTitle, parseForwardTranscript } from "./forwarded-transcript.js";

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

function flattenElements(elements, excluded = new Set()) {
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((element) => (
    element && !excluded.has(element)
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
    const imageUrl = raw.startsWith("//") ? `https:${raw}`
      : (/^[a-z0-9.-]+\.(?:qq\.com(?:\.cn)?|qpic\.cn)\//i.test(raw) ? `https://${raw}` : raw);
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

function isForwardElement(element) {
  return Number(element?.message_type) === 102
    || isForwardTranscript(element?.content);
}

function collectForwardRoots(elements, excluded, roots = []) {
  for (const element of Array.isArray(elements) ? elements : []) {
    if (!element || excluded.has(element)) continue;
    if (isForwardElement(element)) {
      roots.push(element);
      excluded.add(element);
    } else {
      collectForwardRoots(element.msg_elements, excluded, roots);
    }
  }
  return roots;
}

function summarizeAttachments(attachments) {
  return attachments.map((attachment) => ({
    type: attachment.content_type || attachment.type || "unknown",
    filename: attachment.filename || null,
  }));
}

function splitForwardEntry(entry) {
  const chars = Array.from(entry.text);
  const pieces = [entry];
  if (chars.length <= 4000) return pieces;
  pieces[0] = { ...entry, text: chars.slice(0, 4000).join("") };
  for (let index = 4000; index < chars.length; index += 4000) {
    pieces.push({ ...entry, text: chars.slice(index, index + 4000).join(""), attachments: [], imageUrls: [] });
  }
  return pieces;
}

function forwardEntries(node, path = []) {
  const attachments = getAttachments(node);
  const imageUrls = getImageUrls(attachments);
  const isContainer = isForwardElement(node);
  const placeholder = isContainer && isForwardTranscriptTitle(node.content);
  const transcript = parseForwardTranscript(node.content);
  const author = node.author || node.member || node.sender || {};
  const timestamp = node.timestamp ?? node.time;
  const original = {
    sender: isContainer ? null : ((typeof author === "string" ? author : (
      author.username || author.member_nickname || author.nickname || author.nick
    )) || node.username || node.nickname || null),
    time: !isContainer && (typeof timestamp === "string" || typeof timestamp === "number") ? timestamp : null,
    text: !placeholder && typeof node.content === "string" ? node.content : "",
    attachments: summarizeAttachments(attachments),
    imageUrls,
  };
  if (transcript && attachments.length) {
    // Structured and serialized attachments may coexist. Do not repeat a URL
    // already associated with one of the transcript's individual messages.
    const represented = new Set(transcript.flatMap((entry) => entry.imageUrls));
    const extra = attachments.filter((attachment) => !getImageUrls([attachment]).some((url) => represented.has(url)));
    if (extra.length) {
      transcript[0].attachments.push(...summarizeAttachments(extra));
      transcript[0].imageUrls.push(...getImageUrls(extra));
    }
  }
  const parts = transcript || (original.text.trim() || attachments.length ? [original] : []);
  const entries = parts.flatMap(splitForwardEntry).map((entry, index) => ({ ...entry, path: [...path, index + 1] }));
  const children = Array.isArray(node.msg_elements) ? node.msg_elements : [];
  return [
    ...entries,
    ...children.flatMap((child, index) => child ? forwardEntries(child, [...path, index + 1]) : []),
  ];
}

function forwardRecord(groupOpenid, msgId, root, source, index) {
  const id = "forward-" + createHash("sha256")
    .update(JSON.stringify([groupOpenid, msgId, source, index]))
    .digest("hex").slice(0, 24);
  return { id, source, entries: forwardEntries(root) };
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

function normalizeReplyTo(referenceIndex, referenceElement, excluded) {
  if (!referenceIndex) return null;

  const elements = flattenElements([referenceElement], excluded);
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
  const messageType = Number(message.message_type);
  const isForward = messageType === 102
    || ([101, 103].includes(messageType) && isForwardElement(message));
  const referenceIndex = isForward ? "" : findReferenceIndex(message);
  const referenceElement = findReferenceElement(message, referenceIndex, msgIndex);
  const replyExcluded = new Set();
  const replyRoots = collectForwardRoots([referenceElement], replyExcluded);
  const replyTo = normalizeReplyTo(referenceIndex, referenceElement, replyExcluded);
  const currentExcluded = new Set(referenceElement ? [referenceElement] : []);
  const currentRoots = isForward ? [message] : collectForwardRoots(message.msg_elements, currentExcluded);
  const forwardedMessages = [
    ...currentRoots.map((root, index) => forwardRecord(groupOpenid, message.id, root, "current", index)),
    ...replyRoots.map((root, index) => forwardRecord(groupOpenid, message.id, root, "reply", index)),
  ];
  const elements = isForward ? [] : flattenElements(message.msg_elements, currentExcluded);
  const currentElement = findElementByIndex(elements, msgIndex);
  const currentElements = currentElement ? flattenElements([currentElement], currentExcluded) : elements;
  const suppliedText = message.content?.trim() || "";
  const forwardPlaceholder = currentRoots.length && isForwardTranscriptTitle(suppliedText);
  const text = isForward ? "" : ((forwardPlaceholder ? "" : suppliedText) || collectElementText(currentElements));
  const attachments = isForward ? [] : [
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
    rawText: isForward || forwardPlaceholder ? text
      : (typeof message.content === "string" && (message.content.trim() || !text) ? message.content : text),
    sentAt: messageTimestamp(message.timestamp),
    attachments: summarizeAttachments(attachments),
    imageUrls,
    forwardedMessages,
    isExplicitBotMention,
    mentions,
    replyTo,
    dedupKey: JSON.stringify([groupOpenid, String(payload.id || `${message.id}:${msgIndex}`)]),
  });
}
