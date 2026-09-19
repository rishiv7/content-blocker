export const LOG_KEY = 'requestLogV1';
export const LOG_LIMIT = 100;
export const RESPONSE_LIMIT = 16384;

export function redact(value, apiKey) {
  if (!apiKey) return value;
  if (typeof value === 'string') return value.split(apiKey).join('[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redact(item, apiKey));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, apiKey), redact(item, apiKey)]));
  return value;
}

export async function responsePreview(response) {
  const reader = response.clone().body?.getReader();
  if (!reader) return {body: '', truncated: false};
  const chunks = []; let length = 0, truncated = false;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      const room = RESPONSE_LIMIT - length;
      chunks.push(value.subarray(0, room)); length += Math.min(value.length, room);
      if (value.length > room || length === RESPONSE_LIMIT) {
        truncated = true; reader.cancel().catch(() => {}); break;
      }
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return {body: new TextDecoder().decode(bytes), truncated};
}

export class RequestLog {
  constructor(storage, limit = LOG_LIMIT) {
    this.storage = storage; this.limit = limit; this.entries = []; this.enabled = true;
    this.queue = Promise.resolve(); this.ready = this.load();
  }
  async load() {
    const value = (await this.storage.get(LOG_KEY))[LOG_KEY];
    if (value) { this.enabled = value.enabled !== false; this.entries = Array.isArray(value.entries) ? value.entries.slice(-this.limit) : []; }
  }
  async mutate(fn) {
    const operation = this.queue.catch(() => {}).then(async () => {
      await this.ready; const result = fn();
      await this.storage.set({[LOG_KEY]: {enabled: this.enabled, entries: this.entries}});
      return result;
    });
    this.queue = operation; return operation;
  }
  start(entry) {
    return this.mutate(() => {
      if (!this.enabled) return null;
      const id = crypto.randomUUID();
      this.entries.push({...entry, id});
      if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
      return id;
    });
  }
  update(id, patch) {
    if (!id) return Promise.resolve();
    return this.mutate(() => {
      const entry = this.entries.find(x => x.id === id);
      // Clearing the log or evicting a pending request must not resurrect it.
      if (entry) Object.assign(entry, patch);
    });
  }
  async snapshot() { await this.ready; await this.queue.catch(() => {}); return {enabled: this.enabled, entries: structuredClone(this.entries)}; }
  clear() { return this.mutate(() => {this.entries = [];}); }
  setEnabled(enabled) { return this.mutate(() => {this.enabled = enabled;}); }
}
