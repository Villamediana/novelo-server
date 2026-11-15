// How much one phone may ask (per minute and per day, per job, and in dollars per day), and how
// much everything may cost (per day and per month). Counted in memory, written to disk in batches.
import { HttpError } from './http.js';
import { event, tx } from './db.js';

/** The date (YYYY-MM-DD) at [ms] in [timeZone]. */
export function dayOf(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export class Limits {
  constructor({ db, settings, now = Date.now }) {
    this.db = db;
    this.settings = settings;
    this.now = now;
    this.minute = new Map(); // device|job → { start, n }
    this.days = new Map(); // phone (its install) → { day, cost, jobs: Map(job → { requests, cost, dirty }) }
    this.q = {
      load: db.prepare('SELECT job, requests, cost FROM usage_day WHERE device = ? AND day = ?'),
      save: db.prepare(`INSERT INTO usage_day(device,day,job,requests,cost) VALUES(?,?,?,?,?)
        ON CONFLICT(device,day,job) DO UPDATE SET requests=excluded.requests, cost=excluded.cost`),
    };
    this.spent = { day: '', dayUsd: 0, month: '', monthUsd: 0, warned: '' };
    this.loadSpent();
  }

  day() {
    return dayOf(this.now(), this.settings.get('timezone'));
  }

  /** What was spent today and this month, from what is written (after writing what is still in memory). */
  loadSpent() {
    this.flush();
    const day = this.day();
    const month = day.slice(0, 7);
    this.spent.day = day;
    this.spent.month = month;
    this.spent.dayUsd = this.db.prepare('SELECT COALESCE(SUM(cost),0) c FROM usage_day WHERE day = ?').get(day).c;
    this.spent.monthUsd = this.db.prepare('SELECT COALESCE(SUM(cost),0) c FROM usage_day WHERE day >= ? AND day <= ?').get(`${month}-00`, `${month}-99`).c;
  }

  roll() {
    const day = this.day();
    if (day === this.spent.day) return;
    this.flush();
    if (day.slice(0, 7) !== this.spent.month) {
      this.spent.month = day.slice(0, 7);
      this.spent.monthUsd = 0;
    }
    this.spent.day = day;
    this.spent.dayUsd = 0;
    this.days.clear();
  }

  device(id) {
    const day = this.spent.day;
    let d = this.days.get(id);
    if (d && d.day === day) return d;
    d = { day, cost: 0, jobs: new Map() };
    for (const row of this.q.load.all(id, day)) {
      d.jobs.set(row.job, { requests: row.requests, cost: row.cost, dirty: false });
      d.cost += row.cost;
    }
    this.days.set(id, d);
    return d;
  }

  secondsToMidnight() {
    // Close enough for a Retry-After: the next change of date in the server's time zone.
    const now = this.now();
    const day = this.day();
    let lo = 0;
    let hi = 26 * 3600;
    while (hi - lo > 60) {
      const mid = (lo + hi) >> 1;
      if (dayOf(now + mid * 1000, this.settings.get('timezone')) === day) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  /** Counts one request of [device] for [job]; throws 429 when it is over a limit. */
  admit(device, job) {
    this.roll();
    const now = this.now();
    const d = this.device(device);
    const cap = this.settings.get('device_day_usd');
    if (cap && d.cost >= cap) {
      throw new HttpError(429, 'quota', 'O limite de hoje deste aparelho acabou.', { retry_after: this.secondsToMidnight() });
    }
    const j = d.jobs.get(job.key) ?? { requests: 0, cost: 0, dirty: false };
    if (job.per_day && j.requests >= job.per_day) {
      throw new HttpError(429, 'quota', 'O limite de hoje deste aparelho acabou.', { retry_after: this.secondsToMidnight() });
    }
    const key = `${device}|${job.key}`;
    let m = this.minute.get(key);
    if (!m || now - m.start >= 60_000) {
      m = { start: now, n: 0 };
      this.minute.set(key, m);
    }
    if (job.per_minute && m.n >= job.per_minute) {
      throw new HttpError(429, 'rate_limited', 'Muitos pedidos em pouco tempo.', { retry_after: Math.ceil((m.start + 60_000 - now) / 1000) });
    }
    m.n++;
    j.requests++;
    j.dirty = true;
    d.jobs.set(job.key, j);
  }

  /** A request that was counted but got no answer goes back to the day. */
  refund(device, jobKey) {
    const j = this.days.get(device)?.jobs.get(jobKey);
    if (j && j.requests > 0) {
      j.requests--;
      j.dirty = true;
    }
  }

  /** What a finished request cost, on the phone's day and on everything's. */
  addCost(device, jobKey, cost) {
    if (!(cost > 0)) return;
    this.roll();
    const d = this.device(device);
    const j = d.jobs.get(jobKey) ?? { requests: 0, cost: 0, dirty: false };
    j.cost += cost;
    j.dirty = true;
    d.jobs.set(jobKey, j);
    d.cost += cost;
    this.spent.dayUsd += cost;
    this.spent.monthUsd += cost;
    const over = this.overBudget();
    if (over && this.spent.warned !== `${this.spent.day}|${over}`) {
      this.spent.warned = `${this.spent.day}|${over}`;
      event(this.db, 'teto', over === 'day' ? 'Teto de gasto do dia atingido: modelos pagos pausados até amanhã.' : 'Teto de gasto do mês atingido: modelos pagos pausados.');
    }
  }

  /** 'day' or 'month' when the money for paid models is over; null while there is some. */
  overBudget() {
    this.roll();
    const day = this.settings.get('budget_day_usd');
    const month = this.settings.get('budget_month_usd');
    if (month && this.spent.monthUsd >= month) return 'month';
    if (day && this.spent.dayUsd >= day) return 'day';
    return null;
  }

  flush() {
    const rows = [];
    for (const [id, d] of this.days) {
      for (const [job, j] of d.jobs) {
        if (!j.dirty) continue;
        rows.push([id, d.day, job, j.requests, j.cost]);
        j.dirty = false;
      }
    }
    if (rows.length) tx(this.db, () => rows.forEach((r) => this.q.save.run(...r)));
  }

  /** Lets go of what is no longer needed in memory. */
  prune() {
    const now = this.now();
    for (const [k, m] of this.minute) if (now - m.start >= 120_000) this.minute.delete(k);
    if (this.days.size > 100_000) {
      this.flush();
      this.days.clear();
    }
  }
}
