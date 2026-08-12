const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SENSITIVE_KEY = /(authorization|secret|token|api[_-]?key)/i;

function redact(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen),
    ]),
  );
}

export function createLogger({ level = "info", sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(logLevel, message, fields = {}) {
    if (LEVELS[logLevel] < threshold) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: logLevel,
      message,
      ...redact(fields),
    });
    const method = logLevel === "error" ? "error" : logLevel === "warn" ? "warn" : "log";
    sink[method](line);
  }

  return Object.freeze({
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  });
}
