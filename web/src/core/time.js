// Days and hours in a time zone, the way the phone counts them (java.time): what "amanhã às 9",
// "o diário de hoje" and "os remédios de hoje" mean depends on the zone, not on the browser's UTC.
// A date is {y, m, d}; a time {h, mi}. Pure.

const fmts = new Map();

function fmt(zone) {
  let f = fmts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    fmts.set(zone, f);
  }
  return f;
}

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The wall clock of [ms] in [zone]: {y, m, d, h, mi, s, dow (1 = Monday)}. */
export function parts(ms, zone) {
  const out = {};
  for (const p of fmt(zone).formatToParts(new Date(ms))) {
    if (p.type === 'year') out.y = +p.value;
    else if (p.type === 'month') out.m = +p.value;
    else if (p.type === 'day') out.d = +p.value;
    else if (p.type === 'hour') out.h = +p.value;
    else if (p.type === 'minute') out.mi = +p.value;
    else if (p.type === 'second') out.s = +p.value;
    else if (p.type === 'weekday') out.dow = WEEKDAY[p.value];
  }
  return out;
}

/** How far [zone] is from UTC at [ms] (ms). */
function offsetAt(ms, zone) {
  const p = parts(ms, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of a wall clock in [zone], like java.time's LocalDateTime.atZone: in a gap (the clock
 * jumps forward) it moves later by the gap; in an overlap (the clock goes back) the earlier one.
 */
export function toMs(y, m, d, h = 0, mi = 0, s = 0, zone) {
  const local = Date.UTC(y, m - 1, d, h, mi, s);
  const before = offsetAt(local - 86_400_000, zone);
  const after = offsetAt(local + 86_400_000, zone);
  const valid = (t) => {
    const p = parts(t, zone);
    return p.y === y && p.m === m && p.d === d && p.h === h && p.mi === mi;
  };
  if (before === after) return local - before;
  const a = local - before;
  const b = local - after;
  if (valid(a)) return a;
  if (valid(b)) return b;
  return a;
}

export function dateOf(ms, zone) {
  const p = parts(ms, zone);
  return { y: p.y, m: p.m, d: p.d };
}

export function addDays(date, n) {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function addMonths(date, n) {
  const t = new Date(Date.UTC(date.y, date.m - 1 + n, 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: Math.min(date.d, lengthOfMonth(t.getUTCFullYear(), t.getUTCMonth() + 1)) };
}

export function lengthOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 1 = Monday … 7 = Sunday. */
export function dayOfWeek(date) {
  const w = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function sameDate(a, b) {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

export function cmpDate(a, b) {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

export function daysBetween(a, b) {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

export function atStartOfDay(date, zone) {
  return toMs(date.y, date.m, date.d, 0, 0, 0, zone);
}

export function atTime(date, time, zone) {
  return toMs(date.y, date.m, date.d, time.h, time.mi, 0, zone);
}

export function startOfDay(ms, zone, plusDays = 0) {
  return atStartOfDay(addDays(dateOf(ms, zone), plusDays), zone);
}

const two = (n) => String(n).padStart(2, '0');

export function isoDate(date) {
  return `${date.y}-${two(date.m)}-${two(date.d)}`;
}

/** "2026-11-12" */
export function day(ms, zone) {
  return isoDate(dateOf(ms, zone));
}

/** "2026-11-12 15:00" */
export function stamp(ms, zone) {
  const p = parts(ms, zone);
  return `${p.y}-${two(p.m)}-${two(p.d)} ${two(p.h)}:${two(p.mi)}`;
}

export function hhmm(t) {
  return `${two(t.h)}:${two(t.mi)}`;
}

export function timeOf(ms, zone) {
  const p = parts(ms, zone);
  return { h: p.h, mi: p.mi };
}

export function cmpTime(a, b) {
  return a.h - b.h || a.mi - b.mi;
}

/** The weekday in Portuguese, as the phone writes it for the model ("quarta-feira"). */
export const PT_WEEKDAYS = ['segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'];

/** The zone this browser is in (what the phone would call ZoneId.systemDefault()). */
export function here() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "2026-11-12T15:00" / "2026-11-12 15:00:00" / "2026-11-12" → its parts; null when it isn't one. */
export function parseLocal(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (!m) return null;
  const date = { y: +m[1], m: +m[2], d: +m[3] };
  if (date.m < 1 || date.m > 12 || date.d < 1 || date.d > lengthOfMonth(date.y, date.m)) return null;
  if (m[4] === undefined) return { date, time: null };
  const time = { h: +m[4], mi: +m[5], s: m[6] ? +m[6] : 0 };
  if (time.h > 23 || time.mi > 59 || time.s > 59) return null;
  return { date, time };
}
