// The queue. Each model configured for a job is a lane: so many requests at once, so many per
// minute. A request waits in line (first come, first served) for the first lane of its job that
// has room. A lane told "too many requests" (429) steps aside for a while and comes back taking
// fewer at once, then grows again as answers come — so a burst waits here instead of failing.

const MINUTE = 60_000;

export class Lane {
  constructor(id, { maxConcurrency = 32, rpm = 0 } = {}) {
    this.id = id;
    this.inFlight = 0;
    this.stamps = [];
    this.coolUntil = 0;
    this.fails = 0;
    this.lastError = '';
    this.configure({ maxConcurrency, rpm });
    this.limit = this.max;
  }

  configure({ maxConcurrency = 32, rpm = 0 }) {
    this.max = Math.max(1, Math.floor(maxConcurrency) || 1);
    this.rpm = Math.max(0, Math.floor(rpm) || 0);
    this.limit = Math.min(this.limit ?? this.max, this.max);
  }

  cooling(now) {
    return now < this.coolUntil;
  }

  rpmFree(now) {
    if (!this.rpm) return true;
    while (this.stamps.length && now - this.stamps[0] >= MINUTE) this.stamps.shift();
    return this.stamps.length < this.rpm;
  }

  ready(now) {
    return !this.cooling(now) && this.inFlight < Math.max(1, Math.floor(this.limit)) && this.rpmFree(now);
  }

  /** When it may have room again by itself (Infinity: only when a request in it ends). */
  wakeAt(now) {
    if (this.cooling(now)) return this.coolUntil;
    if (!this.rpmFree(now)) return this.stamps[0] + MINUTE;
    return Infinity;
  }

  take(now) {
    this.inFlight++;
    if (this.rpm) this.stamps.push(now);
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  success() {
    this.fails = 0;
    this.lastError = '';
    this.limit = Math.min(this.max, this.limit + 1 / Math.max(1, this.limit));
  }

  /** 429: fewer at once, and out for what the API said (or 1, 2, 4… up to 60 s), with a little jitter. */
  tooMany(now, retryAfterMs, error = '429') {
    this.fails++;
    this.lastError = error;
    this.limit = Math.max(1, this.limit * 0.7);
    const wait = retryAfterMs > 0 ? Math.min(retryAfterMs, 5 * MINUTE) : Math.min(MINUTE, 1000 * 2 ** Math.min(this.fails - 1, 6));
    this.coolUntil = Math.max(this.coolUntil, now + wait + Math.random() * 250);
  }

  /** Another kind of failure: out for [ms]. */
  failed(now, ms, error = '') {
    this.fails++;
    this.lastError = error;
    this.coolUntil = Math.max(this.coolUntil, now + ms);
  }

  state(now) {
    return {
      in_flight: this.inFlight,
      limit: Math.max(1, Math.floor(this.limit)),
      max: this.max,
      cooling_ms: Math.max(0, Math.round(this.coolUntil - now)),
      last_error: this.lastError,
    };
  }
}

export class Dispatcher {
  constructor({ now = Date.now, maxWaiting = 20_000 } = {}) {
    this.now = now;
    this.maxWaiting = maxWaiting;
    this.lanes = new Map(); // route id → Lane
    this.order = new Map(); // job → [route ids], best first
    this.waiters = [];
    this.timer = null;
    this.wakeAt = Infinity;
    this.pumping = false;
  }

  /** The lanes of each job, as configured now. A lane that stays keeps its state. */
  setRoutes(byJob) {
    const keep = new Set();
    this.order.clear();
    for (const [job, routes] of Object.entries(byJob)) {
      this.order.set(job, routes.map((r) => r.id));
      for (const r of routes) {
        keep.add(r.id);
        const lane = this.lanes.get(r.id);
        if (lane) lane.configure({ maxConcurrency: r.max_concurrency, rpm: r.rpm });
        else this.lanes.set(r.id, new Lane(r.id, { maxConcurrency: r.max_concurrency, rpm: r.rpm }));
      }
    }
    for (const [id, lane] of this.lanes) if (!keep.has(id) && lane.inFlight === 0) this.lanes.delete(id);
    this.pump();
  }

  candidates(w) {
    return (this.order.get(w.job) ?? []).filter((id) => !w.exclude.has(id) && w.allowed(id)).map((id) => this.lanes.get(id)).filter(Boolean);
  }

  /**
   * A place in a lane of [job]. Resolves to:
   *  { lane, release }        — go;
   *  { none: true, wakeAt }   — every lane this request may use is out (cooling) or there is none;
   *  { timeout: true }        — [deadline] came while waiting in line;
   *  { full: true }           — the line itself is full.
   * [exclude]: lanes this request won't use; [allowed]: lanes it may use now (the budget);
   * [ticket]: gets a cancel() to leave the line.
   */
  acquire(job, { exclude = new Set(), allowed = () => true, deadline, ticket = {} }) {
    return new Promise((resolve) => {
      if (this.waiters.length >= this.maxWaiting) {
        resolve({ full: true });
        return;
      }
      const w = { job, exclude, allowed, deadline, resolve, done: false, since: this.now() };
      // Whoever asked may leave the line (nobody is waiting for the answer any more).
      ticket.cancel = () => {
        if (w.done) return;
        w.done = true;
        resolve({ timeout: true, left: true });
        this.pump();
      };
      this.waiters.push(w);
      this.pump();
    });
  }

  grant(w, lane, now) {
    lane.take(now);
    w.done = true;
    let released = false;
    w.resolve({
      lane,
      waited: now - w.since,
      release: () => {
        if (released) return;
        released = true;
        lane.release();
        this.pump();
      },
    });
  }

  pump() {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        const now = this.now();
        let wake = Infinity;
        for (const w of this.waiters) {
          if (w.done) continue;
          if (now >= w.deadline) {
            w.done = true;
            w.resolve({ timeout: true });
            continue;
          }
          const lanes = this.candidates(w);
          const ready = lanes.find((l) => l.ready(now));
          if (ready) {
            this.grant(w, ready, now);
            continue;
          }
          const usable = lanes.filter((l) => !l.cooling(now));
          if (!usable.length) {
            w.done = true;
            w.resolve({ none: true, wakeAt: lanes.length ? Math.min(...lanes.map((l) => l.coolUntil)) : Infinity });
            continue;
          }
          wake = Math.min(wake, w.deadline, ...usable.map((l) => l.wakeAt(now)));
        }
        this.waiters = this.waiters.filter((w) => !w.done);
        this.schedule(wake);
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  schedule(wake) {
    if (wake === this.wakeAt && this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.wakeAt = wake;
    if (wake === Infinity) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, wake - this.now() + 1));
    this.timer.unref?.();
  }

  waiting(job) {
    return job ? this.waiters.filter((w) => w.job === job).length : this.waiters.length;
  }

  stop() {
    clearTimeout(this.timer);
    for (const w of this.waiters) w.resolve({ timeout: true });
    this.waiters = [];
  }
}
