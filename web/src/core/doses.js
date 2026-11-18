// When a medicine is taken — meds/Doses.kt, the same here. A med is its row (times and days as JSON).
import * as T from './time.js';
import { clock } from './repeat.js';

export const time = clock;

function readList(text) {
  try {
    const v = JSON.parse(text ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function readTimes(text) {
  const out = [];
  for (const t of readList(text).filter((s) => typeof s === 'string').map(clock).filter(Boolean)) if (!out.some((o) => o.h === t.h && o.mi === t.mi)) out.push(t);
  return out.sort(T.cmpTime);
}

export function writeTimes(list) {
  const out = [];
  for (const t of list) if (!out.some((o) => o.h === t.h && o.mi === t.mi)) out.push(t);
  return JSON.stringify(out.sort(T.cmpTime).map(T.hhmm));
}

export function readDays(text) {
  const s = new Set(readList(text).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7));
  return s.size === 7 ? new Set() : s;
}

export function writeDays(days) {
  const d = [...new Set(days.filter((x) => x >= 1 && x <= 7))].sort((a, b) => a - b);
  return JSON.stringify(d.length === 7 ? [] : d);
}

export const times = (m) => readTimes(m.times);
export const days = (m) => readDays(m.days);
export const hhmm = T.hhmm;

/** "De N em N horas" from [first]: the times of a day. */
export function every(first, hours) {
  if (!(hours >= 1 && hours <= 24)) return [first];
  const out = [];
  for (let i = 0; i < Math.floor(24 / hours); i++) {
    const total = (first.h * 60 + first.mi + i * hours * 60) % (24 * 60);
    const t = { h: Math.floor(total / 60), mi: total % 60 };
    if (!out.some((o) => o.h === t.h && o.mi === t.mi)) out.push(t);
  }
  return out.sort(T.cmpTime);
}

export function takesOn(m, date) {
  const d = days(m);
  return d.size === 0 || d.has(T.dayOfWeek(date));
}

/** The times [m] is due between [from] and [to] (ms, both included), in order. */
export function slots(m, from, to, zone) {
  const ts = times(m);
  const start = Math.max(from, m.startsAt);
  const end = Math.min(to, m.endsAt ?? Number.MAX_SAFE_INTEGER);
  if (!ts.length || end < start) return [];
  let d = T.addDays(T.dateOf(start, zone), -1);
  const last = T.dateOf(end, zone);
  const out = [];
  while (T.cmpDate(d, last) <= 0) {
    if (takesOn(m, d)) for (const t of ts) {
      const at = T.atTime(d, t, zone);
      if (at >= start && at <= end) out.push(at);
    }
    d = T.addDays(d, 1);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** The times of [date], each with the medicines due then, in order: [{at, meds}]. */
export function day(meds, date, zone) {
  const from = T.atStartOfDay(date, zone);
  const to = T.atStartOfDay(T.addDays(date, 1), zone) - 1;
  const by = new Map();
  for (const m of meds) for (const at of slots(m, from, to, zone)) {
    if (!by.has(at)) by.set(at, []);
    by.get(at).push(m);
  }
  return [...by.keys()].sort((a, b) => a - b).map((at) => ({ at, meds: by.get(at) }));
}

export const ended = (m, now) => m.endsAt !== null && m.endsAt !== undefined && m.endsAt < now;
export const dayOf = (ms, zone) => T.dateOf(ms, zone);
export const startOfDay = (ms, zone) => T.startOfDay(ms, zone);
export const endOf = (date, zone) => T.atStartOfDay(T.addDays(date, 1), zone) - 1;

export function lastTimes(m, n, until, zone) {
  if (n <= 0 || !times(m).length) return [];
  let back = 1;
  for (;;) {
    const fromT = T.atStartOfDay(T.addDays(T.dateOf(until, zone), -back), zone);
    const found = slots({ ...m, startsAt: Math.min(m.startsAt, fromT) }, fromT, until, zone);
    if (found.length >= n || back >= 120) return found.slice(-n);
    back *= 2;
  }
}

export function nearest(m, at, zone) {
  const date = T.dateOf(at, zone);
  const whole = { ...m, startsAt: Math.min(m.startsAt, T.atStartOfDay(date, zone)) };
  const list = day([whole], date, zone);
  if (!list.length) return null;
  return list.reduce((best, s) => (Math.abs(s.at - at) < Math.abs(best.at - at) ? s : best)).at;
}

export function daysLeft(m, now, zone) {
  if (m.endsAt == null) return null;
  return Math.max(T.daysBetween(T.dateOf(now, zone), T.dateOf(m.endsAt, zone)) + 1, 0);
}

export function progress(m, now, zone) {
  if (m.endsAt == null) return null;
  const total = T.daysBetween(T.dateOf(m.startsAt, zone), T.dateOf(m.endsAt, zone)) + 1;
  const gone = T.daysBetween(T.dateOf(m.startsAt, zone), T.dateOf(now, zone));
  return Math.min(Math.max(gone / Math.max(total, 1), 0), 1);
}

export const MAX_DOTS = 60;

/** The doses to show as beads (the whole treatment when short and with an end, else today's). */
export function course(m, taken, now, zone) {
  if (!times(m).length) return null;
  const dayStart = T.startOfDay(now, zone);
  const dots = (list) => {
    const by = new Map();
    for (const at of list) {
      const k = T.day(at, zone);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push({ at, taken: taken.has(at), past: at < dayStart });
    }
    return [...by.keys()].sort().map((k) => by.get(k));
  };
  if (m.endsAt != null) {
    const all = slots(m, m.startsAt, m.endsAt, zone);
    if (all.length >= 1 && all.length <= MAX_DOTS) return { days: dots(all), whole: true };
  }
  const today = day([m], T.dateOf(now, zone), zone).map((s) => s.at);
  return today.length ? { days: dots(today), whole: false } : null;
}

// ------------------------------------------------------------------ what one dose comes to

const FRACTIONS = {
  '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3,
  meio: 0.5, meia: 0.5, medio: 0.5, media: 0.5, half: 0.5,
  'um quarto': 0.25, 'un cuarto': 0.25, 'a quarter': 0.25,
};
const WORDS = [
  ['um quarto', 0.25], ['un cuarto', 0.25], ['a quarter', 0.25],
  ['meio', 0.5], ['meia', 0.5], ['medio', 0.5], ['media', 0.5], ['half', 0.5],
  ['uma', 1], ['um', 1], ['una', 1], ['uno', 1], ['un', 1], ['one', 1],
  ['duas', 2], ['dois', 2], ['dos', 2], ['two', 2],
  ['três', 3], ['tres', 3], ['three', 3],
];
const PIECES = ['comprimido', 'comp', 'cp', 'cápsula', 'capsula', 'drágea', 'dragea', 'pílula', 'pilula', 'sachê', 'sache', 'sobre', 'unidade', 'unidad', 'tablete', 'tableta', 'tablet', 'pastilla', 'pill', 'capsule'];

export function pieces(dose) {
  let rest = String(dose).trim().toLowerCase();
  let total = 0;
  let found = false;
  const takeRe = (re, value) => {
    const m = re.exec(rest);
    if (!m) return false;
    const v = value(m);
    if (v === null || v === undefined) return false;
    total += v;
    found = true;
    rest = rest.slice(m.index + m[0].length).trimStart();
    return true;
  };
  const words = WORDS.map((w) => w[0]).join('|');
  void (takeRe(/^(\d+)\s*\/\s*(\d+)/, (m) => (+m[2] > 0 ? +m[1] / +m[2] : null))
    || takeRe(/^(\d+(?:[.,]\d+)?)/, (m) => Number.parseFloat(m[1].replace(',', '.')))
    || takeRe(new RegExp(`^(${words})(?![\\p{L}])`, 'u'), (m) => WORDS.find((w) => w[0] === m[1])[1]));
  if (found) takeRe(/^(?:(?:e|y|and)\s+)?(½|¼|¾|meio|meia|medio|media|half|um quarto|un cuarto|a quarter)(?![\p{L}])/u, (m) => FRACTIONS[m[1]]);
  else takeRe(/^(½|¼|¾|⅓|⅔)/u, (m) => FRACTIONS[m[1]]);
  if (!found || total <= 0) return null;
  const unit = rest.trim();
  return !unit || PIECES.some((p) => unit.startsWith(p)) ? total : null;
}

function number(v, comma) {
  const r = Math.round(v * 100) / 100;
  const text = r === Math.floor(r) ? String(Math.trunc(r)) : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return comma ? text.replace('.', ',') : text;
}

/** "500 mg" and "½ comprimido" → "250 mg"; null when they don't say it in pieces. */
export function amount(strength, dose) {
  const s = String(strength ?? '').trim();
  if (!strength || s.includes('/')) return null;
  const m = /^(\d+(?:[.,]\d+)*)\s*(mcg|µg|mg|g|ui|UI|IU)\b/i.exec(s);
  if (!m) return null;
  const written = m[1];
  const thousands = /^[1-9]\d{0,2}(\.\d{3})+$/.test(written);
  const value = Number.parseFloat(thousands ? written.replace(/\./g, '') : written.replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  if (dose == null) return null;
  const q = pieces(dose);
  if (q === null || q === 1) return null;
  const comma = thousands || !written.includes('.');
  return `${number(value * q, comma)} ${m[2]}`;
}
