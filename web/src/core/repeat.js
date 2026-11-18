// How a reminder (and its task) comes back — remind/Repeat.kt, the same here. Kept with the entry as
// JSON ({"every":"day","time":"08:00"}…), written the way the phone writes it (what is default left out).
import * as T from './time.js';
import { Steps, kindOf } from './words.js';

export const DAY = 'day';
export const WEEK = 'week';
export const MONTH = 'month';
export const MAX_TIMES = 2000;
const KEEP_DONE_MS = 24 * 60 * 60_000;

function parseTime(text) {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? ''));
  if (!m) return null;
  const h = +m[1];
  const mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/** A rule: {every, days, time, day, times}. */
export function rule(r) {
  return { every: r.every, days: r.days ?? [], time: r.time ?? '09:00', day: r.day ?? null, times: r.times ?? [] };
}

export function allTimes(r) {
  const parsed = (r.times.length ? r.times : [r.time]).map(parseTime).filter(Boolean);
  const uniq = [];
  for (const t of parsed) if (!uniq.some((u) => u.h === t.h && u.mi === t.mi)) uniq.push(t);
  uniq.sort(T.cmpTime);
  return uniq.length ? uniq : [{ h: 9, mi: 0 }];
}

/** The first time it comes after [after] (ms); null when the rule says nothing. */
export function next(r, after, zone) {
  const start = T.dateOf(after, zone);
  const ats = allTimes(r);
  const ms = (d) => ats.map((t) => T.atTime(d, t, zone));
  const first = (dates) => {
    for (const d of dates) for (const t of ms(d)) if (t > after) return t;
    return null;
  };
  if (r.every === DAY) return first([0, 1].map((i) => T.addDays(start, i)));
  if (r.every === WEEK) {
    const on = new Set(r.days.filter((d) => d >= 1 && d <= 7));
    if (!on.size) return null;
    return first([0, 1, 2, 3, 4, 5, 6, 7].map((i) => T.addDays(start, i)).filter((d) => on.has(T.dayOfWeek(d))));
  }
  if (r.every === MONTH) {
    const dom = Math.min(Math.max(r.day ?? start.d, 1), 31);
    const months = [];
    for (let i = 0; i <= 12; i++) {
      const m = T.addMonths({ y: start.y, m: start.m, d: 1 }, i);
      months.push({ y: m.y, m: m.m, d: Math.min(dom, T.lengthOfMonth(m.y, m.m)) });
    }
    return first(months);
  }
  return null;
}

/** Its times from [from] (included) up to [until] (not), in order. */
export function between(r, from, until, zone) {
  const out = [];
  let t = next(r, from - 1, zone);
  while (t !== null && t < until && out.length < MAX_TIMES) {
    out.push(t);
    t = next(r, t, zone);
  }
  return out;
}

/** The rule kept with an entry, or null (none, or one that says nothing). */
export function read(text) {
  if (!text || !String(text).trim()) return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || typeof v.every !== 'string') return null;
  const r = rule({
    every: v.every,
    days: Array.isArray(v.days) ? v.days.filter(Number.isInteger) : [],
    time: typeof v.time === 'string' ? v.time : '09:00',
    day: Number.isInteger(v.day) ? v.day : null,
    times: Array.isArray(v.times) ? v.times.filter((s) => typeof s === 'string') : [],
  });
  if (![DAY, WEEK, MONTH].includes(r.every)) return null;
  if (r.every === WEEK && !r.days.some((d) => d >= 1 && d <= 7)) return null;
  return r;
}

/** As kotlinx writes it (defaults left out, in the class's order). */
export function write(r) {
  if (!r) return null;
  const o = { every: r.every };
  if (r.days.length) o.days = r.days;
  if (r.time !== '09:00') o.time = r.time;
  if (r.day !== null && r.day !== undefined) o.day = r.day;
  if (r.times.length) o.times = r.times;
  return JSON.stringify(o);
}

/** "08:00", "8:30", "8h", "20h30", "8" → a time of the day; null when it isn't one (meds/Doses.kt time). */
export function clock(text) {
  const m = /^\s*(\d{1,2})(?:\s*[:hH.]\s*(\d{2})?)?\s*(?:h|hs|hrs)?\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (h === 24 && mi === 0) return { h: 0, mi: 0 };
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, mi };
}

/** A rule said by the model or chosen on screen, made whole from its first time ([first], ms). */
export function from(every, days, first, zone, times = []) {
  const at = T.parts(first, zone);
  const said = [];
  for (const t of times.map(clock).filter(Boolean)) if (!said.some((s) => s.h === t.h && s.mi === t.mi)) said.push(t);
  said.sort(T.cmpTime);
  const saidText = said.map(T.hhmm);
  const time = saidText[0] ?? T.hhmm({ h: at.h, mi: at.mi });
  const more = saidText.length > 1 ? saidText : [];
  const e = String(every ?? '').trim().toLowerCase();
  if (e === DAY) return rule({ every: DAY, time, times: more });
  if (e === WEEK) {
    let d = [...new Set(days.filter((x) => x >= 1 && x <= 7))].sort((a, b) => a - b);
    if (!d.length) d = [at.dow];
    return rule({ every: WEEK, days: d, time, times: more });
  }
  if (e === MONTH) return rule({ every: MONTH, time, day: at.d, times: more });
  return null;
}

// ------------------------------------------------------------------ a task that repeats

export function repeats(e) {
  return kindOf(e) === 'task' && read(e.repeat) !== null;
}

export function doneOf(e) {
  try {
    const v = JSON.parse(e.doneTimes ?? '[]');
    return new Set(Array.isArray(v) ? v.filter(Number.isFinite) : []);
  } catch {
    return new Set();
  }
}

export function writeDone(times) {
  return JSON.stringify([...new Set(times)].sort((a, b) => a - b));
}

function startOf(e) {
  return e.occursFrom ?? e.remindAt ?? null;
}

/** Its times from where they count up to [until] (not included), each [time, done]. */
export function timesOf(e, until, zone) {
  if (!repeats(e)) return [];
  const r = read(e.repeat);
  const s = startOf(e);
  if (s === null) return [];
  const done = doneOf(e);
  return between(r, s, until, zone).map((t) => [t, done.has(t)]);
}

export function come(e, now, zone) {
  const list = timesOf(e, now + 1, zone);
  const last = list[list.length - 1];
  return last && !last[1] ? last[0] : null;
}

export function current(e, now, zone) {
  const c = come(e, now, zone);
  if (c !== null) return c;
  const r = read(e.repeat);
  const s = startOf(e);
  if (!r || s === null) return null;
  const done = doneOf(e);
  let t = next(r, Math.max(now, s - 1), zone);
  let n = 0;
  while (t !== null && done.has(t) && n++ < MAX_TIMES) t = next(r, t, zone);
  return t;
}

export function nextRing(e, after, zone) {
  const r = read(e.repeat);
  if (!r) return null;
  const done = kindOf(e) === 'task' ? doneOf(e) : new Set();
  let t = next(r, after, zone);
  let n = 0;
  while (t !== null && done.has(t) && n++ < MAX_TIMES) t = next(r, t, zone);
  return t;
}

export function isTime(e, at, zone) {
  const r = read(e.repeat);
  return r !== null && next(r, at - 1, zone) === at;
}

/** One of its times ticked ([done]) or not any more: open, its reminder on the next not done. */
export function tick(e, at, done, now, zone) {
  const r = read(e.repeat);
  if (!r) return e;
  const times = doneOf(e);
  if (done) times.add(at);
  else times.delete(at);
  let fromT = Math.min(startOf(e) ?? at, at);
  let n = 0;
  while (times.has(fromT) && fromT < now - KEEP_DONE_MS && n++ < MAX_TIMES) {
    times.delete(fromT);
    const nx = next(r, fromT, zone);
    if (nx === null) break;
    fromT = nx;
  }
  let after = {
    ...e,
    status: 'todo',
    doneAt: null,
    occursFrom: fromT,
    doneTimes: writeDone([...times].filter((t) => t >= fromT)),
    checkInAt: done ? null : e.checkInAt,
    updatedAt: now,
  };
  after = { ...after, remindAt: nextRing(after, now, zone) };
  if (after.dueAt !== null && after.dueAt !== undefined) {
    const c = current(after, now, zone);
    if (c !== null) after = { ...after, dueAt: after.dueHasTime ? c : T.startOfDay(c, zone) };
  }
  if (done) after = { ...after, steps: Steps.write(Steps.read(e.steps).map((s) => ({ ...s, done: false }))) };
  return after;
}

/** A task done now: a repeating one has this time done and is there again for the next. */
export function done(e, now, zone) {
  const open = { ...e, status: 'todo', doneAt: null };
  const at = repeats(e) ? current(open, now, zone) : null;
  if (at === null) return { ...e, status: 'done', doneAt: now, checkInAt: null, rungAt: e.remindAt ?? null, updatedAt: now };
  return tick(open, at, true, now, zone);
}
