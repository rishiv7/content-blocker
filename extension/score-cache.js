// Only hashes and scores are persisted. No passage text, URLs or API keys.
export const CACHE_STORAGE_KEY = 'passageScoresV2';
export const CACHE_LIMIT = 10000;
const valid = score => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1;

export class ScoreCache {
  constructor(storage, limit = CACHE_LIMIT) {
    this.storage = storage;
    this.limit = limit;
    this.entries = new Map();
    this.pending = new Map();
    this.writes = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    const stored = (await this.storage.get(CACHE_STORAGE_KEY))[CACHE_STORAGE_KEY];
    if (!Array.isArray(stored)) return;
    for (const entry of stored.slice(-this.limit)) {
      if (Array.isArray(entry) && /^[a-f0-9]{64}$/.test(entry[0]) && valid(entry[1])) this.entries.set(entry[0], entry[1]);
    }
  }

  async getOrCompute(key, compute, onSource = () => {}) {
    await this.ready;
    if (this.entries.has(key)) {
      onSource('cache');
      const score = this.entries.get(key);
      this.entries.delete(key); this.entries.set(key, score);
      return score;
    }
    if (this.pending.has(key)) { onSource('shared'); return this.pending.get(key); }
    onSource('api');
    // Install the shared promise before compute runs, including when compute throws.
    const pending = Promise.resolve().then(compute).then(async score => {
      if (!valid(score)) throw new Error('Invalid score; nothing was cached.');
      this.entries.set(key, score);
      while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
      // Serialize writes so simultaneous completions cannot overwrite newer entries.
      const write = this.writes.catch(() => {}).then(() => this.storage.set({[CACHE_STORAGE_KEY]: [...this.entries]}));
      this.writes = write;
      try { await write; }
      catch { this.entries.delete(key); throw new Error('Could not save the passage score. Check extension storage.'); }
      return score;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }
}
