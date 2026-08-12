import { readFileSync } from "node:fs";

export class PersonaConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PersonaConfigurationError";
  }
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonaConfigurationError(`${path} 必须是对象`);
  }
  return value;
}

function string(value, path, { maxLength = 1000 } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PersonaConfigurationError(`${path} 必须是非空字符串`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new PersonaConfigurationError(`${path} 不能超过 ${maxLength} 个字符`);
  }
  return result;
}

function stringArray(value, path, { maxItems = 20, maxLength = 500 } = {}) {
  if (!Array.isArray(value)) throw new PersonaConfigurationError(`${path} 必须是数组`);
  if (value.length > maxItems) {
    throw new PersonaConfigurationError(`${path} 最多包含 ${maxItems} 项`);
  }
  return value.map((item, index) => string(item, `${path}[${index}]`, { maxLength }));
}

function exactKeys(value, path, allowedKeys) {
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length) {
    throw new PersonaConfigurationError(`${path} 包含未知字段：${unknown.join(", ")}`);
  }
}

export function validatePersona(input) {
  const persona = object(input, "persona");
  exactKeys(persona, "persona", [
    "version",
    "name",
    "identity",
    "background",
    "personality",
    "speakingStyle",
    "behavior",
    "boundaries",
  ]);
  if (persona.version !== 1) {
    throw new PersonaConfigurationError("persona.version 当前必须为 1");
  }

  const speakingStyle = object(persona.speakingStyle, "persona.speakingStyle");
  exactKeys(speakingStyle, "persona.speakingStyle", [
    "language",
    "tone",
    "verbosity",
    "habits",
  ]);

  return Object.freeze({
    version: 1,
    name: string(persona.name, "persona.name", { maxLength: 50 }),
    identity: string(persona.identity, "persona.identity", { maxLength: 1000 }),
    background: Object.freeze(stringArray(persona.background, "persona.background")),
    personality: Object.freeze(stringArray(persona.personality, "persona.personality")),
    speakingStyle: Object.freeze({
      language: string(speakingStyle.language, "persona.speakingStyle.language", {
        maxLength: 50,
      }),
      tone: string(speakingStyle.tone, "persona.speakingStyle.tone", { maxLength: 200 }),
      verbosity: string(speakingStyle.verbosity, "persona.speakingStyle.verbosity", {
        maxLength: 50,
      }),
      habits: Object.freeze(stringArray(
        speakingStyle.habits,
        "persona.speakingStyle.habits",
      )),
    }),
    behavior: Object.freeze(stringArray(persona.behavior, "persona.behavior")),
    boundaries: Object.freeze(stringArray(persona.boundaries, "persona.boundaries")),
  });
}

export function loadPersona({
  personaUrl = new URL("../../config/persona.json", import.meta.url),
} = {}) {
  let input;
  try {
    input = JSON.parse(readFileSync(personaUrl, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new PersonaConfigurationError(`人格配置不是有效 JSON：${error.message}`);
    }
    throw new PersonaConfigurationError(`无法读取人格配置 ${personaUrl}：${error.message}`);
  }
  return validatePersona(input);
}
