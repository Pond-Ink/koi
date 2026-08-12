export class EventDeduplicator {
  constructor({ ttlMs = 600_000, maxEntries = 10_000, clock = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.clock = clock;
    this.seenAt = new Map();
  }

  isDuplicate(key) {
    const now = this.clock();
    const previous = this.seenAt.get(key);
    if (previous !== undefined && now - previous < this.ttlMs) return true;

    this.seenAt.set(key, now);
    if (this.seenAt.size > this.maxEntries) this.cleanup(now);
    return false;
  }

  cleanup(now = this.clock()) {
    for (const [key, timestamp] of this.seenAt) {
      if (now - timestamp >= this.ttlMs || this.seenAt.size > this.maxEntries) {
        this.seenAt.delete(key);
      }
    }
  }
}
