// The ceilings worked out from what Novelo+ brings in, when the panel has them on "automático": the price,
// minus the store's cut, minus the profit kept, is what one phone may spend on intelligence in a month (in
// dollars, at the day's rate). A phone's day is a thirtieth of that; all phones together, as many as have
// Novelo+, never under a floor (so it works before the first subscriber). They are written into the same
// settings the limits already read, so nothing else changes.

const RATE_URL = 'https://economia.awesomeapi.com.br/json/last/USD-BRL';
const RATE_EVERY = 12 * 3600_000;

/** Rounded down: a ceiling never above what pays. */
const down = (v, digits) => Math.floor(v * 10 ** digits + 1e-9) / 10 ** digits;

/** The ceilings for [s] (the settings) with [plus] phones on Novelo+. */
export function ceilings(s, plus) {
  const net = s.plus_price_brl * (1 - s.store_fee_pct / 100);
  const forAi = net * (1 - s.margin_pct / 100);
  const deviceMonth = s.usd_brl > 0 ? forAi / s.usd_brl : 0;
  const month = Math.max(s.budget_floor_usd, deviceMonth * plus);
  return {
    plus,
    net_brl: down(net, 2),
    ai_brl: down(forAi, 2),
    device_month_usd: down(deviceMonth, 4),
    device_day_usd: down(deviceMonth / 30, 4),
    budget_month_usd: down(month, 2),
    budget_day_usd: down(month / 30, 2),
  };
}

export class AutoBudget {
  constructor({ db, settings, fetcher = fetch, now = Date.now }) {
    Object.assign(this, { db, settings, fetcher, now });
  }

  plus() {
    return this.db.prepare("SELECT COUNT(*) n FROM installs WHERE plan = 'plus'").get().n;
  }

  /** What the ceilings would be now (shown in the panel even when they are set by hand). */
  preview() {
    return ceilings(this.settings.all(), this.plus());
  }

  /** On "automático": the three ceilings follow the price, the rate and the number of subscribers. */
  apply() {
    if (!this.settings.get('budget_auto')) return null;
    const c = this.preview();
    for (const key of ['device_day_usd', 'budget_month_usd', 'budget_day_usd']) {
      if (this.settings.get(key) !== c[key]) this.settings.set(key, c[key]);
    }
    return c;
  }

  /** The day's dollar, twice a day at most, when the ceilings and the rate are both automatic. */
  async refreshRate({ force = false } = {}) {
    if (!this.settings.get('budget_auto') || !this.settings.get('usd_auto')) return false;
    if (!force && this.now() - this.settings.get('usd_brl_at') < RATE_EVERY) return false;
    try {
      const res = await this.fetcher(RATE_URL, { signal: AbortSignal.timeout(15_000) });
      const bid = Number((await res.json())?.USDBRL?.bid);
      if (!res.ok || !(bid > 1 && bid < 50)) return false;
      this.settings.set('usd_brl', down(bid, 4));
      this.settings.set('usd_brl_at', this.now());
      this.apply();
      return true;
    } catch {
      return false; // the last rate goes on being used
    }
  }
}
