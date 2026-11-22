// How each tab groups what is kept — ui/library/LibraryScreen.kt sectionsFor, the same rules: Hoje by
// the hour (a task that repeats there at each of its times), Tarefas by category, Notas by hand, Diário
// by day. Labels are keys (the page puts them in words). Pure.
import * as T from './time.js';
import * as R from './repeat.js';
import { Categories, kindOf, statusOf } from './words.js';

export const NEAR_BACK_MS = 2 * 60 * 60_000;
/** How many days after today Hoje looks ahead ("Próximos dias"). */
export const UPCOMING_DAYS = 3;

/** One of the times of a task that repeats, as Hoje shows it. */
export function atTime(e, time, done) {
  return { ...e, dueAt: time, dueHasTime: 1, remindAt: time, status: done ? 'done' : 'todo', _time: time };
}

export function todayTime(e, from, endToday) {
  if (e.remindAt != null && e.remindAt >= from && e.remindAt < endToday) return e.remindAt;
  if (e.dueAt != null && e.dueHasTime && e.dueAt >= from && e.dueAt < endToday) return e.dueAt;
  return null;
}

export function inOrder(tasks) {
  const byDue = (e) => e.dueAt ?? Number.MAX_SAFE_INTEGER - e.createdAt;
  return [...tasks.filter((e) => e.position == null).sort((a, b) => byDue(a) - byDue(b)), ...tasks.filter((e) => e.position != null).sort((a, b) => a.position - b.position)];
}

export function byHand(notes) {
  return [...notes].sort((a, b) => (a.position == null ? 0 : 1) - (b.position == null ? 0 : 1) || (a.position ?? 0) - (b.position ?? 0) || b.createdAt - a.createdAt);
}

/** A group per day ([label: {day} | null, items]). */
export function byDay(list, zone, today, nearOnly = false) {
  const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
  const groups = [];
  for (const e of sorted) {
    const d = T.dateOf(e.createdAt, zone);
    const last = groups[groups.length - 1];
    if (last && T.sameDate(last.date, d)) last.items.push(e);
    else groups.push({ date: d, items: [e] });
  }
  const yesterday = T.addDays(today, -1);
  return groups.map((g) => [!nearOnly || T.sameDate(g.date, today) || T.sameDate(g.date, yesterday) ? { day: g.date } : null, g.items]);
}

/** The groups of [tab] ('today' | 'tasks' | 'notes' | 'diary' | 'all'): [[label, items]]. */
export function sectionsFor(tab, all, zone, now = Date.now()) {
  const today = T.dateOf(now, zone);
  const startToday = T.atStartOfDay(today, zone);
  const endToday = T.atStartOfDay(T.addDays(today, 1), zone);
  const tasks = all.filter((e) => kindOf(e) === 'task');
  const open = tasks.filter((e) => statusOf(e) !== 'done');
  if (tab === 'today') {
    const back = now - NEAR_BACK_MS;
    const from = Math.min(startToday, back);
    const late = [];
    const timed = [];
    const loose = [];
    const doneTimes = [];
    for (const e of open) {
      if (R.repeats(e)) {
        for (const [at, done] of R.timesOf(e, endToday, zone)) {
          if (at >= back) timed.push([atTime(e, at, done), at]);
          else if (!done) late.push(atTime(e, at, false));
          else if (at >= startToday) doneTimes.push([atTime(e, at, true), at]);
        }
        continue;
      }
      const hour = todayTime(e, from, endToday);
      if (e.dueAt != null && e.dueAt < from) late.push(e);
      else if (hour !== null && hour >= back) timed.push([e, hour]);
      else if (hour !== null) {
        if (e.dueAt == null || e.dueAt < endToday) late.push(e);
        else loose.push(e);
      } else if (e.remindAt != null && e.remindAt < from && e.dueAt == null) late.push(e);
      else if (e.dueAt != null && e.dueAt < endToday) loose.push(e);
      // Put in Hoje today by hand (app 1.83), whatever its day.
      else if (e.myDay != null && e.myDay >= startToday && e.myDay < endToday) loose.push(e);
    }
    const struck = tasks.filter((e) => statusOf(e) === 'done' && !R.repeats(e) && e.doneAt != null && e.doneAt >= startToday)
      .map((e) => [e, todayTime(e, from, endToday)]).filter(([, h]) => h !== null && h >= back);
    timed.push(...struck);
    const repeating = new Set(open.filter(R.repeats).map((e) => e.id));
    // The next days (app 1.82): due or reminding from tomorrow to UPCOMING_DAYS days on; not one that repeats.
    const endUpcoming = T.atStartOfDay(T.addDays(today, 1 + UPCOMING_DAYS), zone);
    const placedToday = new Set([...late.map((e) => e.id), ...timed.map((x) => x[0].id), ...loose.map((e) => e.id)]);
    const upcomingAt = (e) => {
      const ats = [e.dueAt, e.remindAt].filter((x) => x != null && x >= endToday && x < endUpcoming);
      return ats.length ? Math.min(...ats) : null;
    };
    const upcoming = open.filter((e) => !repeating.has(e.id) && !placedToday.has(e.id)).map((e) => [e, upcomingAt(e)]).filter(([, at]) => at !== null)
      .sort((a, b) => a[1] - b[1] || a[0].createdAt - b[0].createdAt).map((x) => x[0]);
    const placed = new Set([...placedToday, ...upcoming.map((e) => e.id)]);
    const doing = open.filter((e) => statusOf(e) === 'doing' && !placed.has(e.id) && !repeating.has(e.id));
    const inCards = new Set(struck.map((x) => x[0].id));
    const doneToday = [...tasks.filter((e) => e.doneAt != null && e.doneAt >= startToday && !inCards.has(e.id)).map((e) => [e, e.doneAt]), ...doneTimes]
      .sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    return [
      ['late', late.sort((a, b) => (a.dueAt ?? a.remindAt ?? a.createdAt) - (b.dueAt ?? b.remindAt ?? b.createdAt))],
      ['for_today', timed.sort((a, b) => a[1] - b[1]).map((x) => x[0])],
      ['through_day', loose.sort((a, b) => (a.dueAt ?? a.createdAt) - (b.dueAt ?? b.createdAt))],
      ['doing', doing],
      ['upcoming', upcoming],
      ['done_today', doneToday],
    ];
  }
  if (tab === 'tasks') {
    const out = [];
    const none = open.filter((e) => e.category == null);
    if (none.length) out.push([{ category: null }, inOrder(none)]);
    for (const c of Categories.inUse(open)) out.push([{ category: c }, inOrder(open.filter((e) => e.category === c))]);
    out.push(['done', tasks.filter((e) => statusOf(e) === 'done').sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt))]);
    return out;
  }
  if (tab === 'notes') return [[null, byHand(all.filter((e) => kindOf(e) === 'note'))]];
  if (tab === 'diary') return byDay(all.filter((e) => kindOf(e) === 'diary'), zone, today, true);
  if (tab === 'all') return byDay(all, zone, today);
  return [];
}

/** How many things are for today (the number next to Hoje): tasks due today or late, reminders still to come today. */
export function todayCount(entries, zone, now = Date.now()) {
  const start = T.atStartOfDay(T.dateOf(now, zone), zone);
  const end = T.atStartOfDay(T.addDays(T.dateOf(now, zone), 1), zone);
  let n = 0;
  for (const e of entries) {
    if (kindOf(e) !== 'task' || statusOf(e) === 'done') continue;
    if (R.repeats(e)) n += R.timesOf(e, end, zone).filter((t) => !t[1]).length;
    else if ((e.dueAt != null && e.dueAt < end) || (e.remindAt != null && e.remindAt < end)) n += 1;
    else if (e.myDay != null && e.myDay >= start && e.myDay < end) n += 1;
  }
  return n;
}
