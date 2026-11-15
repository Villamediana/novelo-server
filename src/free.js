// The last resort: the free models of OpenRouter, rotated — the same way the app did it when it
// called OpenRouter by itself. Free models come and go, so the list is read from the provider
// (kept for 12 h); one that fails rests for a while and the next takes its place; the one that
// answered last goes first.
import { listModels } from './upstream.js';

const LIST_EVERY = 12 * 3600_000;
export const REST = { failed: 30 * 60_000, busy: 5 * 60_000, bad: 6 * 3600_000, gone: 7 * 24 * 3600_000 };
const POOL = 10;

export class FreePool {
  constructor({ settings, provider, fetcher = fetch, now = Date.now }) {
    this.settings = settings;
    this.provider = provider; // () → { base_url, key, headers } or null
    this.fetcher = fetcher;
    this.now = now;
    this.list = [];
    this.listAt = 0;
    this.resting = new Map();
    this.lastGood = new Map();
  }

  async models() {
    const now = this.now();
    if (this.list.length && now - this.listAt < LIST_EVERY) return this.list;
    const p = this.provider();
    if (!p) return this.list;
    try {
      const all = await listModels({ baseUrl: p.base_url, key: p.key, headers: p.headers, fetcher: this.fetcher });
      const free = all.filter((m) => m.priced && m.priceIn === 0 && m.priceOut === 0)
        .filter((m) => m.output.length === 1 && m.output[0] === 'text' && m.input.includes('text'))
        .filter((m) => m.context >= 32_000 && m.id !== 'openrouter/free');
      if (free.length) {
        this.list = free;
        this.listAt = now;
      }
    } catch { /* the list kept goes on being used */ }
    return this.list;
  }

  /** The models to try now for a job that takes [accepts] ("text,image"), best first; [not]: ones to skip. */
  async candidates(jobKey, accepts, not = new Set()) {
    const now = this.now();
    const needs = accepts.split(',').map((s) => s.trim()).filter(Boolean);
    const preferred = this.settings.list('free_preferred');
    const avoid = new Set(this.settings.list('free_avoid'));
    const good = this.lastGood.get(jobKey);
    const rank = (m) => [
      m.id === good ? 0 : 1,
      preferred.includes(m.id) ? preferred.indexOf(m.id) : 1e6,
      avoid.has(m.id) ? 1 : 0,
      -m.created,
    ];
    return (await this.models())
      .filter((m) => needs.every((n) => m.input.includes(n)))
      .filter((m) => !not.has(m.id) && (this.resting.get(m.id) ?? 0) <= now)
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
        return 0;
      })
      .slice(0, POOL);
  }

  rest(id, ms) {
    this.resting.set(id, this.now() + ms);
  }

  good(jobKey, id) {
    this.lastGood.set(jobKey, id);
  }

  state() {
    const now = this.now();
    return {
      known: this.list.length,
      resting: [...this.resting].filter(([, until]) => until > now).map(([id, until]) => ({ id, minutes: Math.ceil((until - now) / 60_000) })),
      last_good: Object.fromEntries(this.lastGood),
    };
  }
}
