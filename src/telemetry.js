// Numbers about each request — never its words. A row per request for a while (to look into a
// bad hour) and totals per hour, job and model for good (what the panel draws).
import { tx } from './db.js';
import { dayOf } from './limits.js';

const HOUR = 3600_000;
const RING = 2000;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export class Telemetry {
  constructor({ db, now = Date.now }) {
    this.db = db;
    this.now = now;
    this.buffer = [];
    this.bads = [];
    this.rings = new Map(); // job → recent total times of the good ones
    this.q = {
      row: db.prepare(`INSERT INTO requests(ts,device,job,provider,model,free,ok,code,attempts,queue_ms,upstream_ms,total_ms,tokens_in,tokens_out,cost,bytes_in,bytes_out)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      hour: db.prepare(`INSERT INTO agg_hour(hour,job,model,requests,errors,bad,retries,tokens_in,tokens_out,cost,ms_sum,queue_ms_sum)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(hour,job,model) DO UPDATE SET requests=requests+excluded.requests, errors=errors+excluded.errors, bad=bad+excluded.bad,
          retries=retries+excluded.retries, tokens_in=tokens_in+excluded.tokens_in, tokens_out=tokens_out+excluded.tokens_out,
          cost=cost+excluded.cost, ms_sum=ms_sum+excluded.ms_sum, queue_ms_sum=queue_ms_sum+excluded.queue_ms_sum`),
    };
  }

  record(r) {
    this.buffer.push(r);
    if (r.ok) {
      let ring = this.rings.get(r.job);
      if (!ring) this.rings.set(r.job, (ring = []));
      ring.push(r.totalMs);
      if (ring.length > RING) ring.splice(0, ring.length - RING);
    }
    if (this.buffer.length >= 5000) this.flush();
  }

  /** The phone couldn't use an answer of [model]. */
  bad(job, model) {
    if (model) this.bads.push({ ts: this.now(), job, model });
  }

  flush() {
    if (!this.buffer.length && !this.bads.length) return;
    const rows = this.buffer;
    const bads = this.bads;
    this.buffer = [];
    this.bads = [];
    tx(this.db, () => {
      for (const r of rows) {
        this.q.row.run(r.ts, r.device, r.job, r.provider, r.model, r.free ? 1 : 0, r.ok ? 1 : 0, r.code, r.attempts, r.queueMs, r.upstreamMs, r.totalMs, r.tokensIn, r.tokensOut, r.cost, r.bytesIn, r.bytesOut);
        this.q.hour.run(Math.floor(r.ts / HOUR), r.job, r.model || '—', 1, r.ok ? 0 : 1, 0, Math.max(0, r.attempts - 1), r.tokensIn, r.tokensOut, r.cost, r.ok ? r.totalMs : 0, r.queueMs);
      }
      for (const b of bads) this.q.hour.run(Math.floor(b.ts / HOUR), b.job, b.model, 0, 0, 1, 0, 0, 0, 0, 0, 0);
    });
  }

  recent(job) {
    const ring = [...(this.rings.get(job) ?? [])].sort((a, b) => a - b);
    return { n: ring.length, p50: percentile(ring, 0.5), p95: percentile(ring, 0.95) };
  }

  /** What the panel's first page shows for the last [hours] hours (24, 168 or 720). */
  overview(hours, timeZone) {
    this.flush();
    const now = this.now();
    const from = Math.floor(now / HOUR) - hours + 1;
    const rows = this.db.prepare('SELECT * FROM agg_hour WHERE hour >= ? ORDER BY hour').all(from);
    const zero = () => ({ requests: 0, errors: 0, bad: 0, retries: 0, tokens_in: 0, tokens_out: 0, cost: 0, ms_sum: 0, queue_ms_sum: 0 });
    const add = (a, r) => {
      for (const k of Object.keys(a)) if (typeof a[k] === 'number' && k in r) a[k] += r[k];
    };
    const total = zero();
    const byModel = new Map();
    const byJob = new Map();
    const byDay = hours > 48;
    const series = new Map();
    if (byDay) {
      for (let h = from; h <= Math.floor(now / HOUR); h++) {
        const k = dayOf(h * HOUR, timeZone);
        if (!series.has(k)) series.set(k, { key: k, ...zero() });
      }
    } else {
      for (let h = from; h <= Math.floor(now / HOUR); h++) series.set(h, { key: h * HOUR, ...zero() });
    }
    for (const r of rows) {
      add(total, r);
      const mk = `${r.job}|${r.model}`;
      if (!byModel.has(mk)) byModel.set(mk, { job: r.job, model: r.model, ...zero() });
      add(byModel.get(mk), r);
      if (!byJob.has(r.job)) byJob.set(r.job, { job: r.job, ...zero() });
      add(byJob.get(r.job), r);
      const sk = byDay ? dayOf(r.hour * HOUR, timeZone) : r.hour;
      if (series.has(sk)) add(series.get(sk), r);
    }
    const errors = this.db.prepare('SELECT code, COUNT(*) n FROM requests WHERE ok = 0 AND ts >= ? GROUP BY code ORDER BY n DESC LIMIT 8').all(now - 24 * HOUR);
    const jobs = [...byJob.values()].map((j) => ({ ...j, recent: this.recent(j.job) }));
    return {
      total,
      by_day: byDay,
      series: [...series.values()],
      models: [...byModel.values()].sort((a, b) => b.requests - a.requests),
      jobs,
      errors,
    };
  }

  prune(keepDays) {
    if (keepDays > 0) this.db.prepare('DELETE FROM requests WHERE ts < ?').run(this.now() - keepDays * 24 * HOUR);
    this.db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)').run();
    this.db.prepare('DELETE FROM usage_day WHERE day < ?').run(new Date(this.now() - 400 * 24 * HOUR).toISOString().slice(0, 10));
  }
}
