// What each phone has: the trial (so many days from its first registration) or Novelo+. It is
// decided and kept here. The app never says which it has; it asks, and is told.
import { HttpError } from './http.js';

const DAY = 24 * 3600_000;
const KINDS = new Set(['plus', 'trial', 'ended']);

export class Plans {
  constructor({ db, settings, now = Date.now }) {
    this.db = db;
    this.settings = settings;
    this.now = now;
    this.cache = new Map();
    this.q = {
      get: db.prepare('SELECT * FROM installs WHERE id = ?'),
      insert: db.prepare('INSERT INTO installs(id,created,plan,trial_start) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING'),
      set: db.prepare('UPDATE installs SET plan = ?, trial_start = ? WHERE id = ?'),
    };
  }

  row(id) {
    let r = this.cache.get(id);
    if (r) return r;
    r = this.q.get.get(id);
    if (r) {
      if (this.cache.size > 200_000) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(id, r);
    }
    return r ?? null;
  }

  /** The phone's record, made on its first registration with what new ones get now. */
  ensure(id) {
    const known = this.row(id);
    if (known) return known;
    const t = this.now();
    this.q.insert.run(id, t, this.settings.get('new_plan') === 'trial' ? 'trial' : 'plus', t);
    return this.row(id);
  }

  /**
   * What [id] has now: { kind: 'plus' | 'trial' | 'ended', active (the Novelo's intelligence
   * answers), backup (the cloud takes its backup), trial_ends (ms, for a trial) }.
   */
  of(id) {
    const r = this.row(id);
    if (!r) return { kind: 'ended', active: false, backup: false };
    if (r.plan === 'plus') return { kind: 'plus', active: true, backup: true };
    if (r.plan === 'trial') {
      const ends = r.trial_start + this.settings.get('trial_days') * DAY;
      if (this.now() < ends) return { kind: 'trial', active: true, backup: false, trial_ends: ends };
    }
    return { kind: 'ended', active: false, backup: false };
  }

  /** Throws 402 when the Novelo's intelligence is over for this phone. */
  need(id) {
    const plan = this.of(id);
    if (!plan.active) throw new HttpError(402, 'plan', 'O teste da inteligência do Novelo terminou.', { plan });
    return plan;
  }

  /** The panel: 'plus', 'trial' (a new trial, from now) or 'ended'. */
  set(id, kind) {
    if (!KINDS.has(kind)) throw new Error('plano inválido');
    const r = this.row(id);
    if (!r) throw new Error('aparelho sem registro de plano');
    this.q.set.run(kind, kind === 'trial' ? this.now() : r.trial_start, id);
    this.cache.delete(id);
  }
}
