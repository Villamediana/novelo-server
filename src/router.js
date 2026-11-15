// A request for a job goes to the first model configured for it that has room. Told to wait (429),
// or failing, that model steps aside and the request goes on to the next, and back when they
// return — until an answer comes or the job's waiting time ends. When every model configured is
// out (or the money for the day is), the free ones are tried, if the job allows it.
import { chat, UpstreamError } from './upstream.js';
import { Dispatcher, Lane } from './lanes.js';
import { FreePool, REST } from './free.js';
import { event } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (text) => {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

export const isFreeModel = (model) => model.endsWith(':free');

/** What a request may not bring from the phone is dropped; what the route says goes last. */
export function merge(body, extra) {
  const out = { ...body };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? { ...out[k], ...v } : v;
  }
  return out;
}

export class Router {
  constructor({ db, config, settings, limits, fetcher = fetch, now = Date.now }) {
    this.db = db;
    this.config = config;
    this.settings = settings;
    this.limits = limits;
    this.fetcher = fetcher;
    this.now = now;
    this.dispatcher = new Dispatcher({ now });
    this.freeLane = new Lane('free');
    this.free = new FreePool({ settings, fetcher, now, provider: () => this.freeProvider() });
    this.warned = new Map();
    this.reload();
  }

  /** Reads the configuration again (the panel changed something). Requests going on are not touched. */
  reload() {
    this.providers = new Map(this.db.prepare('SELECT * FROM providers').all().map((p) => [p.id, { ...p, headers: parse(p.headers), extra: parse(p.extra) }]));
    this.jobs = new Map(this.db.prepare('SELECT * FROM jobs').all().map((j) => [j.key, j]));
    this.routes = new Map();
    const byJob = {};
    for (const job of this.jobs.keys()) byJob[job] = [];
    for (const r of this.db.prepare('SELECT * FROM routes ORDER BY job, position, id').all()) {
      const route = { ...r, extra: parse(r.extra) };
      this.routes.set(r.id, route);
      const p = this.providers.get(r.provider_id);
      if (r.enabled && p?.enabled && byJob[r.job]) byJob[r.job].push(route);
    }
    this.dispatcher.setRoutes(byJob);
    this.freeLane.configure({ maxConcurrency: this.settings.get('free_max_concurrency'), rpm: this.settings.get('free_rpm') });
  }

  keyOf(provider) {
    return provider.key_env ? this.config.get(provider.key_env) : '';
  }

  freeProvider() {
    const p = this.providers.get(this.settings.get('free_provider'));
    if (!p || !p.enabled) return null;
    const key = this.keyOf(p);
    return key ? { ...p, key } : null;
  }

  warn(key, kind, message) {
    const now = this.now();
    if ((this.warned.get(key) ?? 0) > now) return;
    this.warned.set(key, now + 10 * 60_000);
    event(this.db, kind, message);
  }

  /** What a failure means for the lane (everybody's), and whether this request should stay away from it. */
  blame(lane, route, provider, e) {
    const now = this.now();
    const label = `${provider.name} · ${route.model}`;
    switch (e.kind) {
      case 'rate':
        lane.tooMany(now, e.retryAfterMs, e.message);
        return false;
      case 'auth':
        lane.failed(now, 5 * 60_000, e.message);
        this.warn(`auth:${provider.id}`, 'chave', `${provider.name}: ${e.status === 402 ? 'sem crédito' : 'chave recusada'} (${e.message})`);
        return false;
      case 'gone':
        lane.failed(now, 10 * 60_000, e.message);
        this.warn(`gone:${route.id}`, 'modelo', `${label}: modelo não encontrado.`);
        return false;
      case 'refused':
      case 'empty':
        return true;
      default:
        // Their side, the network, or no answer in time: out for 2, 4, 8… up to 30 s.
        lane.failed(now, Math.min(30_000, 1000 * 2 ** Math.min(lane.fails + 1, 5)), e.message);
        return false;
    }
  }

  async call(route, provider, body, timeoutMs) {
    const full = merge(merge({ ...body, model: route.model, stream: false }, provider.extra), route.extra);
    const r = await chat({ baseUrl: provider.base_url, key: this.keyOf(provider), headers: provider.headers, body: full, timeoutMs, fetcher: this.fetcher });
    const cost = r.cost ?? (r.tokensIn * route.price_in + r.tokensOut * route.price_out) / 1e6;
    return { ...r, cost };
  }

  /**
   * Runs [body] (already checked) for [job]. [not]: route marks the phone asked to skip (the answer
   * they gave wasn't good). [gone]: set when nobody waits for the answer any more.
   * Always resolves: { ok, text?, code?, message?, route, provider, model, free, attempts, queueMs, upstreamMs, tokensIn, tokensOut, cost }.
   */
  async run(job, body, { not = [], gone = { left: false } } = {}) {
    const start = this.now();
    const deadline = start + job.wait_s * 1000;
    const exclude = new Set();
    const freeNot = new Set();
    for (const mark of not) {
      if (/^r\d+$/.test(mark)) exclude.add(Number(mark.slice(1)));
      else if (mark.startsWith('f:')) freeNot.add(mark.slice(2));
    }
    const out = { ok: false, code: 'busy', message: '', route: '', provider: '', model: '', free: false, attempts: 0, queueMs: 0, upstreamMs: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
    let refused = null;
    let last = null;

    while (true) {
      const over = this.limits.overBudget();
      const allowed = (id) => !over || isFreeModel(this.routes.get(id)?.model ?? '');
      const ticket = {};
      gone.leave = () => ticket.cancel?.();
      if (gone.left) return { ...out, code: 'gone' };
      const lease = await this.dispatcher.acquire(job.key, { exclude, allowed, deadline, ticket });
      gone.leave = null;

      if (lease.lane) {
        const route = this.routes.get(lease.lane.id);
        const provider = route && this.providers.get(route.provider_id);
        if (!route || !provider) {
          lease.release();
          exclude.add(lease.lane.id);
          continue;
        }
        out.queueMs += lease.waited;
        out.attempts++;
        const t0 = this.now();
        try {
          const left = deadline - t0;
          const r = await this.call(route, provider, body, Math.max(5000, Math.min(route.timeout_s * 1000, left)));
          lease.lane.success();
          out.upstreamMs += this.now() - t0;
          return { ...out, ok: true, code: '', text: r.text, route: `r${route.id}`, provider: provider.name, model: route.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost };
        } catch (e) {
          out.upstreamMs += this.now() - t0;
          const err = e instanceof UpstreamError ? e : new UpstreamError('server', 0, String(e?.message ?? e));
          last = err;
          out.provider = provider.name;
          out.model = route.model;
          if (this.blame(lease.lane, route, provider, err)) {
            exclude.add(route.id);
            refused = err;
          }
        } finally {
          lease.release();
        }
        continue;
      }

      if (lease.full) return { ...out, code: 'busy', message: 'Fila cheia.' };
      if (lease.timeout) return { ...out, code: lease.left ? 'gone' : 'busy', message: last?.message ?? 'Sem vaga a tempo.' };

      // Every configured model this request may use is out, or there is none.
      if (job.free_fallback) {
        const r = await this.tryFree(job, body, freeNot, deadline, out);
        if (r) return r;
      }
      const wake = lease.wakeAt;
      if (!(wake < deadline)) {
        const configured = (this.dispatcher.order.get(job.key) ?? []).length > 0;
        if (!configured && !(job.free_fallback && this.freeProvider())) return { ...out, code: 'not_configured', message: 'Nenhum modelo configurado para este pedido.' };
        if (over) return { ...out, code: 'budget', message: 'Teto de gasto atingido.' };
        if (refused) return { ...out, code: 'refused', message: refused.message };
        return { ...out, code: 'busy', message: last?.message ?? 'Modelos ocupados.' };
      }
      await sleep(Math.max(50, wake - this.now()) + Math.random() * 200);
    }
  }

  /** The free models, one after the other (up to three), while the free lane has room. */
  async tryFree(job, body, not, deadline, out) {
    const p = this.freeProvider();
    if (!p) return null;
    const models = await this.free.candidates(job.key, job.accepts, not);
    for (const m of models.slice(0, 3)) {
      const now = this.now();
      if (deadline - now < 3000 || !this.freeLane.ready(now)) return null;
      this.freeLane.take(now);
      out.attempts++;
      const t0 = this.now();
      try {
        const json = m.params.includes('response_format');
        const reasons = m.params.includes('reasoning');
        const fitted = { ...body, model: m.id, stream: false };
        if (!json) delete fitted.response_format;
        if (!reasons) {
          delete fitted.reasoning_effort;
          delete fitted.reasoning;
        }
        const timeoutMs = Math.max(5000, Math.min(90_000, deadline - t0));
        const ask = (b) => chat({ baseUrl: p.base_url, key: p.key, headers: p.headers, body: merge(b, p.extra), timeoutMs, fetcher: this.fetcher });
        let r;
        try {
          r = await ask(fitted);
        } catch (e) {
          // It didn't take the JSON mode or the reasoning level as asked: once more, plain.
          if (e?.kind !== 'refused' || !(fitted.response_format || fitted.reasoning_effort || fitted.reasoning)) throw e;
          const plain = { ...fitted };
          delete plain.response_format;
          delete plain.reasoning_effort;
          delete plain.reasoning;
          r = await ask(plain);
        }
        this.free.good(job.key, m.id);
        this.freeLane.success();
        out.upstreamMs += this.now() - t0;
        return { ...out, ok: true, code: '', text: r.text, route: `f:${m.id}`, provider: p.name, model: m.id, free: true, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost ?? 0 };
      } catch (e) {
        out.upstreamMs += this.now() - t0;
        const kind = e?.kind ?? 'server';
        if (kind === 'auth') {
          this.warn(`auth:${p.id}`, 'chave', `${p.name}: ${e.status === 402 ? 'sem crédito' : 'chave recusada'} (${e.message})`);
          return null;
        }
        // Gone or closed to apps like this one (404, 403) for long; too many asking for a few minutes; anything else for a while.
        this.free.rest(m.id, kind === 'gone' || e?.status === 403 ? REST.gone : kind === 'rate' ? REST.busy : REST.failed);
      } finally {
        this.freeLane.release();
      }
    }
    return null;
  }

  /**
   * The model behind a [mark] the phone said gave an unusable answer, to be counted. That request
   * skips it; nothing changes for the others (one phone's word doesn't take a model from everybody).
   */
  bad(mark) {
    if (mark.startsWith('f:')) return this.free.list.some((m) => m.id === mark.slice(2)) ? mark.slice(2) : '';
    return this.routes.get(Number(mark.slice(1)))?.model ?? '';
  }

  /**
   * Per job: it has a model that can answer now (on, with an API that is on and has its key) —
   * or, for a job that may fall back to the free models, at least those. Yes or no only.
   */
  ready() {
    const free = Boolean(this.freeProvider());
    const out = {};
    for (const [key, job] of this.jobs) {
      const own = (this.dispatcher.order.get(key) ?? []).some((id) => {
        const r = this.routes.get(id);
        const p = r && this.providers.get(r.provider_id);
        return Boolean(p && this.keyOf(p));
      });
      out[key] = Boolean(job.enabled) && (own || (Boolean(job.free_fallback) && free && key === 'think'));
    }
    return out;
  }

  /** How each lane is right now, for the panel. */
  live() {
    const now = this.now();
    const lanes = {};
    for (const [id, lane] of this.dispatcher.lanes) lanes[id] = lane.state(now);
    const waiting = {};
    for (const job of this.jobs.keys()) waiting[job] = this.dispatcher.waiting(job);
    return { lanes, waiting, free_lane: this.freeLane.state(now), free: this.free.state(), over_budget: this.limits.overBudget() };
  }

  stop() {
    this.dispatcher.stop();
  }
}
