// ---------- 会话级译文缓存（含可选的 storage 持久化节流） ----------
import { hashText, normalizeSpace } from './text.mjs';

export class TranslateCache {
  constructor({ limit = 6000, persistKey = 'ot-cache-v3' } = {}) {
    this.limit = limit;
    this.persistKey = persistKey;
    this.map = new Map();      // key -> translated
    this.dirty = false;
    this._timer = null;
  }

  key(text, tl, provider) {
    return `${tl}|${provider}|${hashText(normalizeSpace(text))}`;
  }

  get(text, tl, provider) {
    const k = this.key(text, tl, provider);
    if (!this.map.has(k)) return null;
    const v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v); // LRU touch
    return v;
  }

  set(text, translated, tl, provider) {
    const k = this.key(text, tl, provider);
    this.map.delete(k);
    this.map.set(k, translated);
    this.dirty = true;
    while (this.map.size > this.limit) {
      this.map.delete(this.map.keys().next().value);
    }
    this.schedulePersist();
  }

  has(text, tl, provider) { return this.map.has(this.key(text, tl, provider)); }

  get size() { return this.map.size; }

  schedulePersist(delay = 2500) {
    if (!this._timer) {
      this._timer = setTimeout(() => { this.persistNow(); }, delay);
    }
  }

  async attachStorage(storageArea, maxSaved = 3000) {
    try {
      const got = await storageArea.get(this.persistKey);
      const saved = got && got[this.persistKey];
      if (saved && typeof saved === 'object') {
        let n = 0;
        for (const [k, v] of Object.entries(saved)) {
          if (n++ > maxSaved) break;
          this.map.set(k, v);
        }
      }
    } catch (_) { /* ignore */ }
  }

  async persistNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this.dirty || typeof chrome === 'undefined' || !chrome.storage) return;
    this.dirty = false;
    try {
      const entries = [...this.map.entries()].slice(-2500);
      await chrome.storage.local.set({ [this.persistKey]: Object.fromEntries(entries) });
    } catch (_) { /* 超过配额时忽略 */ }
  }
}
