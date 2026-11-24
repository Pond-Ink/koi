// QQ also serializes a merged forward as a text transcript rather than msg_elements.
const SECTION = /^[ \t]*===[ \t]*消息[ \t]+(\d+)[ \t]*===[ \t]*$/gm;
const TITLE = /^\[(?:[^\]\r\n]+的)?(?:聊天记录|合并转发)\]$/;
const FIELD = /^[ \t]*\[(消息内容|发送者|发送时间|时间|附件\d+)\][ \t]*[:：]?[ \t]*(.*)$/;

export function isForwardTranscriptTitle(value) {
  return typeof value === "string" && TITLE.test(value.trim());
}

function transcriptSections(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n/g, "\n").trim();
  const sections = [...text.matchAll(SECTION)];
  if (!sections.length) return null;
  const preamble = text.slice(0, sections[0].index).trim();
  if (preamble && !isForwardTranscriptTitle(preamble)) return null;
  return sections.map((section, index) => ({
    number: Number(section[1]),
    text: text.slice(section.index + section[0].length, sections[index + 1]?.index ?? text.length).trim(),
  }));
}

export function isForwardTranscript(value) {
  return transcriptSections(value) !== null;
}

// Unlike structured gateway attachments, the text inside a forward is untrusted.
// Only recognize image URLs on QQ's media hosts, never arbitrary URLs in chat text.
function qqMediaUrl(raw) {
  if (typeof raw !== "string" || !raw || /[\s\\]/.test(raw)) return null;
  const value = raw.startsWith("//") ? `https:${raw}`
    : (/^[a-z0-9.-]+\//i.test(raw) ? `https://${raw}` : raw);
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname;
  return host === "multimedia.nt.qq.com.cn" || host === "multimedia.nt.qq.com"
    || host.endsWith(".qpic.cn") ? url.href : null;
}

function comparableSection(text) {
  return text.split("\n").map((line) => {
    if (!line.match(FIELD)?.[1].startsWith("附件")) return line;
    const match = line.match(/([ \t]+URL[ \t]*[:：][ \t]*)(\S+)[ \t]*$/i);
    const href = qqMediaUrl(match?.[2]);
    if (!href) return line;
    const url = new URL(href);
    // QQ may issue a different temporary rkey for the same attachment when
    // serializing the identical block twice. Compare the media identity, not
    // the access token; never change the URL actually submitted to the API.
    if (!url.searchParams.get("fileid") || url.searchParams.getAll("fileid").length !== 1) return line;
    url.searchParams.delete("rkey");
    url.searchParams.sort();
    return line.slice(0, match.index) + match[1] + url.href;
  }).join("\n");
}

function repeatedHalfLength(sections) {
  if (!sections || sections.length < 4 || sections.length % 2
    || !sections.every((section, index) => section.number === index + 1)) return null;
  const half = sections.length / 2;
  const keys = sections.map((section) => comparableSection(section.text));
  // With a flat transcript there are no original message IDs. Avoid guessing
  // whether an all-identical sequence consists of genuine repeated messages.
  if (new Set(keys.slice(0, half)).size < 2) return null;
  return keys.slice(0, half).every((key, index) => key === keys[half + index]) ? half : null;
}

export function duplicateForwardHalfLength(value) {
  return repeatedHalfLength(transcriptSections(value));
}

function parseAttachment(value) {
  const matches = [...value.matchAll(/(?:^|[ \t]+)(类型|文件名|尺寸|大小|URL)[ \t]*[:：][ \t]*/gi)];
  const fields = Object.fromEntries(matches.map((match, index) => [
    match[1].toUpperCase(),
    value.slice(match.index + match[0].length, matches[index + 1]?.index ?? value.length).trim(),
  ]));
  if (!fields["类型"] && !fields.URL) return null;

  const rawType = fields["类型"] || "unknown";
  const type = rawType === "图片" ? "image" : rawType.toLowerCase();
  const image = type === "image" || type.startsWith("image/");
  return {
    attachment: { type, filename: fields["文件名"] || null },
    imageUrl: image ? qqMediaUrl(fields.URL) : null,
  };
}

export function parseForwardTranscript(value) {
  const sections = transcriptSections(value);
  if (!sections) return null;
  const half = repeatedHalfLength(sections);
  return (half === null ? sections : sections.slice(0, half)).map(({ text: section }) => {
    const body = [];
    const attachments = [];
    const imageUrls = new Set();
    let sender = null;
    let time = null;
    for (const line of section.split("\n")) {
      const match = line.match(FIELD);
      if (!match) {
        body.push(line);
        continue;
      }
      const [, field, content] = match;
      if (field === "消息内容") body.push(content);
      else if (field === "发送者" && sender === null) sender = content.trim() || null;
      else if ((field === "发送时间" || field === "时间") && time === null) time = content.trim() || null;
      else if (field.startsWith("附件")) {
        const parsed = parseAttachment(content);
        if (!parsed) body.push(line);
        else {
          attachments.push(parsed.attachment);
          if (parsed.imageUrl) imageUrls.add(parsed.imageUrl);
        }
      } else body.push(line);
    }
    return { sender, time, text: body.join("\n").trim(), attachments, imageUrls: [...imageUrls] };
  });
}
