// Writes a plan into the data — mind/Keeper.kt and mind/MedKeeper.kt, the same here: new entries,
// their topics and links, changes, categories, medicines and the doses given.
import * as T from './time.js';
import * as R from './repeat.js';
import * as D from './doses.js';
import * as Brain from './brain.js';
import { merge as diaryMerge, bounds } from './diary.js';
import { Categories, Steps, Tags, Words, joined, kindKey, kindOf, statusKey, statusOf, isBlank } from './words.js';
import * as Summary from './summary.js';

const STOP = new Set(['none', 'never', 'no', 'nunca', 'nenhum', '']);
const NO_END = new Set(['none', 'never', 'nunca', 'null', '', 'contínuo', 'continuo']);
const FUTURE_MS = 5 * 60_000;
const EARLY_MS = 30 * 60_000;

/**
 * [plan] into [data]. [captureId]: what it came from; [sentPhotos]/[sentFiles]: the captures she sent
 * with it, in the model's numbering; [photo]: the photo sent alone; [saidAt]: when she said it; [diaryAt]: the
 * moment whose day a diary made here belongs to (photos sent alone: the day they were taken; null: now).
 * Returns {outcomes, touched, meds, medsChanged}.
 */
export function apply(data, plan, { captureId = null, sentPhotos = [], sentFiles = [], photo = null, saidAt = null, diaryAt = null, zone, now = data.clock(), alarmByDefault = true } = {}) {
  return data.batch(() => {
    const picked = (nums, ids) => (nums.includes(Brain.ALL) ? [true, []] : [false, [...new Set(nums.map((n) => ids[n - 1]).filter((x) => x !== undefined))]]);
    const outcome = (id, action, photos, files) => {
      const [allPhotos, pics] = picked(photos, sentPhotos);
      const [allFiles, docs] = picked(files, sentFiles);
      return { entryId: id, action, photos: allPhotos, files: allFiles, pics, docs };
    };
    const z = zone;
    const base = saidAt !== null ? Math.min(saidAt, now) : now;
    const ahead = (text) => {
      const at = Brain.remindTime(text, z, base);
      if (at === null) return null;
      return Brain.relative(text) !== null ? Math.max(at, now + 1000) : at > now ? at : null;
    };
    const outcomes = [];
    const touched = [];
    const known = new Set();
    const categories = data.categories();
    const category = (name) => {
      const c = Categories.pick(name, categories);
      if (c !== null && !categories.includes(c)) categories.push(c);
      return c;
    };

    for (const c of plan.categories) {
      const from = categories.find((x) => Categories.fold(x) === Categories.fold(c.name));
      if (from === undefined) continue;
      const others = categories.filter((x) => x !== from);
      const to = Categories.pick(c.to, others);
      if (to === from) continue;
      data.renameCategory(from, to);
      categories.splice(categories.indexOf(from), 1);
      if (to !== null && !categories.includes(to)) categories.push(to);
    }

    // The diary's day: when the photos were taken, or now (never one ahead of now).
    const diaryDay = diaryAt !== null ? Math.min(diaryAt, now) : now;
    for (const item of distinct(plan.create)) {
      const kind = kindKey(item.kind);
      if (!kind) continue;
      if (kind === 'diary') {
        const day = bounds(diaryDay, z);
        const today = data.diariesBetween(day[0], day[1])[0];
        if (today) {
          const body = diaryMerge(today.body, item.body);
          const title = isBlank(today.body) && !isBlank(item.title) ? item.title.trim().slice(0, 140) : today.title;
          const e = { ...today, title, body };
          if (e.title !== today.title || e.body !== today.body || item.photos.length || item.files.length) {
            data.updateEntry({ ...e, updatedAt: now });
            outcomes.push(outcome(today.id, 'updated', item.photos, item.files));
          }
          known.add(today.id);
          tieTopics(data, today.id, item.entities);
          for (const other of item.related) if (other !== today.id && data.entry(other)) data.link(Math.min(today.id, other), Math.max(today.id, other));
          continue;
        }
      }
      const due = Brain.time(item.due, z, base);
      const status = kind === 'task' ? statusKey(item.status) ?? 'todo' : null;
      const [repeat, remindAt] = repeating(item.repeat, ahead(item.remindAt), now, z);
      // A task just like one still open (the same words): that one, told some more — never a second one.
      const twin = kind === 'task' && status !== 'done' && repeat === null ? twinOf(data, item, known, now, z, due ? due[0] : null, remindAt) : null;
      if (twin) {
        let e = { ...twin };
        const steps = Steps.read(e.steps);
        const more = item.steps.filter((a) => !isBlank(a) && !steps.some((s) => Steps.same(a, s.text))).map((a) => ({ text: a.trim(), done: false }));
        if (more.length) e = { ...e, steps: Steps.write([...steps, ...more]) };
        const body = item.body.trim();
        if (body && !Words.of(e.body).join(' ').includes(Words.of(body).join(' '))) e = { ...e, body: joined(e.body, body) };
        if (e.dueAt == null && due) e = { ...e, dueAt: due[0], dueHasTime: due[1] ? 1 : 0 };
        if (remindAt !== null && (e.remindAt == null || e.remindAt <= now)) e = { ...e, remindAt, rungAt: null, alarm: item.alarm != null ? (item.alarm ? 1 : 0) : e.alarm };
        if (e.category == null) {
          const c = category(item.category);
          if (c !== null) e = { ...e, category: c };
        }
        const joins = item.photos.length > 0 || item.files.length > 0;
        if (!same(e, twin) || joins) data.updateEntry({ ...e, updatedAt: now });
        // Changed or not, it is what she asked for: its card is there in the answer.
        outcomes.push(outcome(e.id, 'updated', item.photos, item.files));
        if (e.remindAt !== twin.remindAt) touched.push(e.id);
        known.add(e.id);
        tieTopics(data, e.id, item.entities);
        for (const other of item.related) if (other !== e.id && data.entry(other)) data.link(Math.min(e.id, other), Math.max(e.id, other));
        continue;
      }
      const entry = {
        kind,
        title: item.title.trim().slice(0, 140),
        body: item.body.trim(),
        status,
        steps: Steps.write(item.steps.filter((s) => !isBlank(s)).map((s) => ({ text: s.trim(), done: false }))),
        tags: Tags.write([...new Set(item.tags.map((s) => s.trim()).filter((s) => s))].slice(0, 8)),
        dueAt: due ? due[0] : null,
        dueHasTime: due ? (due[1] ? 1 : 0) : 0,
        remindAt,
        repeat,
        occursFrom: repeat !== null && kind === 'task' ? remindAt : null,
        checkInAt: kind === 'task' ? ahead(item.checkInAt) : null,
        alarm: (item.alarm ?? alarmByDefault) ? 1 : 0,
        sensitive: item.sensitive ? 1 : 0,
        // A diary of the day the photos were taken is that day's.
        createdAt: kind === 'diary' ? diaryDay : now,
        updatedAt: now,
        doneAt: status === 'done' ? now : null,
        captureId,
        category: kind === 'task' ? category(item.category) : null,
        // A note the model saw worth it: its points too, "Em tópicos" (a task, the diary: never).
        summary: kind === 'note' ? Summary.keep(item.summary) : '',
      };
      const id = data.insertEntry(entry);
      known.add(id);
      tieTopics(data, id, item.entities);
      for (const other of item.related) if (other !== id && data.entry(other)) data.link(Math.min(id, other), Math.max(id, other));
      outcomes.push(outcome(id, status === 'done' ? 'done' : 'created', item.photos, item.files));
      if (entry.remindAt !== null || entry.checkInAt !== null) touched.push(id);
    }

    for (const change of plan.update) {
      const old = data.entry(change.id);
      if (!old) continue;
      if (change.delete) {
        data.deleteEntry(old.id);
        outcomes.push({ entryId: old.id, action: 'deleted', photos: false, files: false, pics: [], docs: [] });
        touched.push(old.id);
        continue;
      }
      let e = { ...old };
      const newStatus = kindOf(old) === 'task' ? statusKey(change.status) : null;
      if (newStatus !== null && newStatus !== statusOf(old)) e = { ...e, status: newStatus, doneAt: newStatus === 'done' ? now : null };
      if (change.stepsDone.length || change.addSteps.length) {
        let steps = Steps.read(e.steps).map((s) => (change.stepsDone.some((d) => Steps.same(d, s.text)) ? { ...s, done: true } : s));
        for (const a of change.addSteps) if (!isBlank(a) && !steps.some((s) => Steps.same(a, s.text))) steps = [...steps, { text: a.trim(), done: false }];
        e = { ...e, steps: Steps.write(steps) };
      }
      if (!isBlank(change.title)) e = { ...e, title: change.title.trim().slice(0, 140) };
      if (kindOf(e) === 'task') {
        const c = category(change.category);
        if (c !== null && c !== e.category) e = { ...e, category: c, position: null };
      }
      if (!isBlank(change.body)) e = { ...e, body: change.body.trim() };
      if (!isBlank(change.append)) e = { ...e, body: kindOf(e) === 'diary' ? diaryMerge(e.body, change.append) : joined(e.body, change.append) };
      // A note's points, whole again; its text written again without them: the old ones went with it.
      // Only joined to (news) without them: the ones it had still hold.
      if (kindOf(e) === 'note') {
        const points = Summary.keep(change.summary);
        const rewritten = !isBlank(change.body) && e.body !== old.body;
        if (points) e = { ...e, summary: points };
        else if (rewritten) e = { ...e, summary: '' };
      }
      const due = Brain.time(change.due, z, base);
      if (due) e = { ...e, dueAt: due[0], dueHasTime: due[1] ? 1 : 0 };
      const r = ahead(change.remindAt);
      if (r !== null) e = { ...e, remindAt: r };
      const ci = ahead(change.checkInAt);
      if (ci !== null) e = { ...e, checkInAt: ci };
      if (change.alarm !== null) e = { ...e, alarm: change.alarm ? 1 : 0 };
      if (change.repeat) {
        if (STOP.has(change.repeat.every.trim().toLowerCase())) e = { ...e, repeat: null, occursFrom: null, doneTimes: '[]', skippedTimes: '[]' };
        else {
          const [rr, at] = repeating(change.repeat, e.remindAt !== null && e.remindAt > now ? e.remindAt : null, now, z);
          if (rr !== null) {
            const same = rr === old.repeat && old.occursFrom !== null;
            e = { ...e, repeat: rr, remindAt: at, occursFrom: same || kindOf(e) !== 'task' ? e.occursFrom : at, doneTimes: same ? e.doneTimes : '[]', skippedTimes: same ? e.skippedTimes ?? '[]' : '[]' };
          }
        }
      }
      if (statusOf(e) === 'done' && statusOf(old) !== 'done' && R.read(e.repeat) !== null) e = R.done(e, now, z);
      else if (statusOf(e) === 'done') e = { ...e, checkInAt: null, rungAt: statusOf(old) === 'done' ? e.rungAt : e.remindAt };
      else if (statusOf(old) === 'done' && e.remindAt !== null && e.remindAt > now && e.rungAt === e.remindAt) e = { ...e, rungAt: null };
      const changed = !same(e, old);
      const joins = change.photos.length > 0 || change.files.length > 0;
      if (changed || joins) data.updateEntry({ ...e, updatedAt: now });
      if (newStatus !== null && newStatus !== statusOf(old)) data.addProgress(e.id, now, newStatus);
      tieTopics(data, e.id, change.entities);
      if (changed || joins) {
        const saidDone = newStatus === 'done' && statusOf(old) !== 'done';
        outcomes.push(outcome(e.id, saidDone || (statusOf(e) === 'done' && statusOf(old) !== 'done') ? 'done' : 'updated', change.photos, change.files));
        if (e.remindAt !== old.remindAt || e.checkInAt !== old.checkInAt) touched.push(e.id);
      }
    }
    if (plan.update.some((u) => u.delete)) data.pruneTopics();
    const meds = applyMeds(data, plan.meds, { captureId, sentPhotos, photo, now: base, zone: z, alarm: alarmByDefault });
    const seen = new Set();
    const unique = outcomes.filter((o) => {
      const k = `${o.entryId}|${o.action}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { outcomes: unique, touched: [...new Set(touched)], meds: meds.meds, medsChanged: meds.changed };
  });
}

/** The model saying the same thing twice in one answer (two tasks with the same words): once, the steps, photos and files of both together. */
function distinct(items) {
  const out = [];
  for (const item of items) {
    const kind = kindKey(item.kind);
    const words = Words.of(item.title).join(' ');
    const i = out.findIndex((it) => kind && kind !== 'diary' && kindKey(it.kind) === kind && words.length > 0 && Words.of(it.title).join(' ') === words);
    if (i < 0) {
      out.push(item);
      continue;
    }
    const first = out[i];
    const names = new Set();
    out[i] = {
      ...first,
      steps: [...first.steps, ...item.steps.filter((a) => !first.steps.some((s) => Steps.same(a, s)))],
      body: isBlank(first.body) ? item.body : first.body,
      photos: [...new Set([...first.photos, ...item.photos])],
      files: [...new Set([...first.files, ...item.files])],
      entities: [...first.entities, ...item.entities].filter((t) => {
        const k = Words.of(t.name).join(' ');
        if (names.has(k)) return false;
        names.add(k);
        return true;
      }),
    };
  }
  return out;
}

/**
 * An open task with the same words as [item] (not one of [known], made or changed in this answer) that this one
 * would only repeat: it doesn't repeat itself, and has no other day ([due]) or reminder ahead ([remind]) than the
 * ones said — another day or hour is another time of it, a task of its own.
 */
function twinOf(data, item, known, now, z, due, remind) {
  const words = Words.of(item.title).join(' ');
  if (!words) return null;
  return data.openTasks().find((e) => !known.has(e.id) && e.repeat == null && Words.of(e.title).join(' ') === words
    && (due === null || e.dueAt == null || T.sameDate(T.dateOf(due, z), T.dateOf(e.dueAt, z)))
    && (remind === null || e.remindAt == null || e.remindAt <= now || Math.floor(remind / 60_000) === Math.floor(e.remindAt / 60_000))) ?? null;
}

function same(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function repeating(ask, remind, now, z) {
  const every = ask?.every?.trim().toLowerCase();
  if (!every || STOP.has(every)) return [null, remind];
  const base = remind ?? T.atTime(T.dateOf(now, z), { h: 9, mi: 0 }, z);
  const rule = R.from(every, ask.days, base, z, ask.times);
  if (!rule) return [null, remind];
  const first = R.next(rule, Math.max(base, now + 1) - 1, z);
  if (first === null) return [null, remind];
  return [R.write(rule), first];
}

function tieTopics(data, entryId, topics) {
  for (const t of topics) {
    const name = t.name.trim().slice(0, 60);
    const norm = Words.of(name).join(' ');
    if (norm.length < 2) continue;
    let id = data.topicByNorm(norm)?.id;
    if (id === undefined) {
      const made = data.insertTopic({ name, norm, type: t.type.trim().toLowerCase() || 'topic' });
      id = made > 0 ? made : data.topicByNorm(norm)?.id;
    }
    if (id === undefined) continue;
    data.tie(entryId, id);
  }
}

// ------------------------------------------------------------------ medicines (MedKeeper)

function applyMeds(data, asks, { captureId, sentPhotos, photo, now, zone: z, alarm }) {
  if (!asks.length) return { meds: [], changed: false };
  const people = [...new Set(data.meds().map((m) => m.person).filter((p) => p != null))];
  const person = (name) => {
    const p = Categories.pick(name, people);
    if (p !== null && !people.includes(p)) people.push(p);
    return p;
  };
  const pool = !sentPhotos.length && photo !== null ? [photo] : sentPhotos;
  const pickedPhoto = (nums) => (nums.includes(Brain.ALL) ? pool[0] ?? null : nums.map((n) => pool[n - 1]).find((x) => x !== undefined) ?? null);
  const ids = [];
  let changed = false;
  for (const ask of asks) {
    const old = ask.id !== null ? data.med(ask.id) : null;
    if (ask.id !== null && !old) continue;
    if (ask.delete) {
      if (old) {
        data.deleteMed(old.id);
        changed = true;
      }
      continue;
    }
    const name = ask.name?.trim().replace(/\s+/g, ' ').slice(0, 80) || null;
    if (!old && name !== null) {
      const cleanWho = ask.person != null ? Categories.clean(ask.person) : null;
      const who = cleanWho !== null ? Categories.fold(cleanWho) : null;
      const sameOne = data.meds().find((m0) => Categories.fold(m0.name) === Categories.fold(name) && (m0.person != null ? Categories.fold(m0.person) : null) === who && !D.ended(m0, now));
      if (sameOne) {
        const d = applyMeds(data, [{ ...ask, id: sameOne.id, name: null }], { captureId, sentPhotos, photo, now, zone: z, alarm });
        ids.push(...d.meds);
        changed = changed || d.changed;
        continue;
      }
    }
    if (!old && name === null) continue;
    let m = old ? { ...old } : { ...dataDefaultsMed(), name, startsAt: firstDose(ask, now, z), captureId, alarm: alarm ? 1 : 0, createdAt: now, updatedAt: now };
    if (old) {
      if (name !== null) m = { ...m, name };
      if (ask.start != null) {
        const s = start(ask.start, now, z);
        if (s !== null) m = { ...m, startsAt: s };
      }
    }
    if (ask.strength != null) m = { ...m, strength: ask.strength.trim().slice(0, 40) || null };
    if (ask.dose != null) m = { ...m, dose: ask.dose.trim().slice(0, 40) || null };
    if (ask.amount != null) m = { ...m, amount: ask.amount.trim().slice(0, 40) || null };
    if (ask.amount == null && (ask.strength != null || ask.dose != null)) m = { ...m, amount: D.amount(m.strength, m.dose) };
    if (ask.person != null) m = { ...m, person: person(ask.person) };
    if (ask.end != null) m = { ...m, endsAt: NO_END.has(ask.end.trim().toLowerCase()) ? null : end(ask.end, z) ?? m.endsAt };
    if (ask.notes != null) m = { ...m, notes: ask.notes.trim().slice(0, 300) };
    if (ask.alarm != null) m = { ...m, alarm: ask.alarm ? 1 : 0 };
    if (ask.days != null) m = { ...m, days: D.writeDays(ask.days) };
    m = times(m, ask, z);
    const ph = pickedPhoto(ask.photos) ?? (old ? null : photo);
    if (ph !== null) m = { ...m, photoId: ph };

    let id;
    if (!old) {
      id = data.insertMed(m);
      changed = true;
    } else {
      if (!same(m, old)) {
        data.updateMed({ ...m, updatedAt: now });
        changed = true;
      }
      id = m.id;
    }
    const given = ask.taken !== null || ask.takenAt.length > 0 || (ask.takenCount ?? 0) > 0 || ask.untakenAt.length > 0;
    for (const text of ask.untakenAt) {
      const at = givenAt(text, now, z);
      if (at === null) continue;
      const cur = data.med(id);
      if (!cur) break;
      untake(data, cur, at, z);
    }
    if (ask.taken === false) {
      const cur = data.med(id);
      if (cur) untake(data, cur, now, z);
    }
    if (ask.taken === true) {
      const cur = data.med(id);
      if (cur) take(data, cur, now, now, z);
    }
    for (const text of ask.takenAt) {
      const at = givenAt(text, now, z);
      if (at === null) continue;
      if (at > now + FUTURE_MS) continue;
      const cur = data.med(id);
      if (!cur) break;
      take(data, cur, at, now, z);
    }
    if ((ask.takenCount ?? 0) > 0) {
      const cur = data.med(id);
      if (cur) takeLast(data, cur, Math.min(ask.takenCount, 200), now, z);
    }
    if (given) changed = true;
    if (!old || !same(m, old) || given) ids.push(id);
  }
  return { meds: [...new Set(ids)], changed };
}

function dataDefaultsMed() {
  return { strength: null, dose: null, amount: null, person: null, times: '[]', everyHours: null, days: '[]', endsAt: null, notes: '', photoId: null };
}

function times(m, ask, z) {
  const said = ask.times.map(D.time).filter(Boolean);
  if (!said.length && ask.everyHours == null) return m;
  let every;
  if (ask.everyHours != null) every = ask.everyHours >= 1 && ask.everyHours <= 24 ? ask.everyHours : null;
  else {
    const h = m.everyHours;
    const sorted = [];
    for (const t of said) if (!sorted.some((o) => o.h === t.h && o.mi === t.mi)) sorted.push(t);
    sorted.sort(T.cmpTime);
    every = h != null && JSON.stringify(D.every(said[0], h)) === JSON.stringify(sorted) ? h : null;
  }
  const base = said.length ? said : D.times(m);
  let ts;
  if (every != null) {
    const first = base[0] ?? T.timeOf(m.startsAt, z);
    ts = D.every({ h: first.h, mi: first.mi }, every);
  } else ts = base;
  return { ...m, times: D.writeTimes(ts), everyHours: every ?? null };
}

export function take(data, m, at, now, z) {
  const slot = D.nearest(m, at, z);
  if (slot !== null && slot < m.startsAt) data.updateMed({ ...m, startsAt: slot });
  data.take(m.id, slot ?? Math.floor(at / 60_000) * 60_000, Math.min(at, now));
}

function untake(data, m, at, z) {
  const day = bounds(at, z);
  const marked = data.takenBetween(day[0], day[1]).filter((t) => t.medId === m.id);
  if (!marked.length) return;
  const best = marked.reduce((b, t) => (Math.abs(t.at - at) < Math.abs(b.at - at) ? t : b));
  data.untake(m.id, best.at);
}

function takeLast(data, m, n, now, z) {
  const last = D.lastTimes(m, n, now + EARLY_MS, z);
  if (!last.length) return;
  if (last[0] < m.startsAt) data.updateMed({ ...m, startsAt: last[0] });
  for (const at of last) data.take(m.id, at, now);
}

function givenAt(text, now, z) {
  const t = D.time(text);
  if (t) return T.atTime(T.dateOf(now, z), t, z);
  const r = Brain.time(text, z, now);
  if (!r) return null;
  return r[1] ? r[0] : null;
}

function firstDose(ask, now, z) {
  const said = Brain.time(ask.start, z, now);
  if (said && said[1]) return said[0];
  const day = T.dateOf(said ? said[0] : now, z);
  const first = ask.times.map(D.time).find(Boolean);
  if (!first) return T.atStartOfDay(day, z);
  return T.atTime(day, first, z);
}

function start(text, now, z) {
  const r = Brain.time(text, z, now);
  if (!r) return null;
  return r[1] ? r[0] : D.startOfDay(r[0], z);
}

function end(text, z) {
  const r = Brain.time(text, z);
  if (!r) return null;
  return r[1] ? r[0] : D.endOf(T.dateOf(r[0], z), z);
}
