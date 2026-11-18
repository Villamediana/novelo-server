// What she does by hand on the page — data/Library.kt, the same rules: done (a repeating task has
// this time done and comes back), steps, editing, reminders, deleting (and undoing it), categories,
// medicines' doses ticked, photos turned or removed.
import * as R from './repeat.js';
import { Categories, Steps, kindOf, statusOf, isBlank } from './words.js';
import { title as dayTitle } from './diary.js';

export class Library {
  constructor(data, zone, lang = 'pt') {
    this.data = data;
    this.zone = zone;
    this.lang = lang;
    this.deleted = new Map();
  }

  get now() {
    return this.data.clock();
  }

  create(kind) {
    const now = this.now;
    return this.data.insertEntry({ kind, title: '', status: kind === 'task' ? 'todo' : null, createdAt: now, updatedAt: now });
  }

  /** Made by hand and left with nothing written: not kept; a diary without a title takes its day's. */
  dropIfEmpty(id) {
    const e = this.data.entry(id);
    if (!e) return;
    if (isBlank(e.title) && isBlank(e.body) && !Steps.read(e.steps).length) this.data.deleteEntry(id);
    else if (kindOf(e) === 'diary' && isBlank(e.title)) this.data.updateEntry({ ...e, title: dayTitle(e.createdAt, this.zone, this.lang) });
  }

  setStatus(id, status) {
    const e = this.data.entry(id);
    if (!e || statusOf(e) === status) return;
    const now = this.now;
    this.data.batch(() => {
      this.data.updateEntry(status === 'done' ? R.done(e, now, this.zone) : { ...e, status, doneAt: null, rungAt: e.remindAt == null || e.remindAt <= now ? e.rungAt : null, updatedAt: now });
      this.data.addProgress(id, now, status);
    });
  }

  toggleDone(id) {
    const e = this.data.entry(id);
    if (!e) return;
    this.setStatus(id, statusOf(e) === 'done' ? 'todo' : 'done');
  }

  /** One time of a task that repeats ticked or not any more. */
  setTime(id, at, done) {
    const e = this.data.entry(id);
    if (!e || !R.repeats(e)) return;
    if (R.doneOf(e).has(at) === done) return;
    const now = this.now;
    this.data.batch(() => {
      this.data.updateEntry(R.tick(e, at, done, now, this.zone));
      this.data.addProgress(id, now, done ? 'done' : 'todo');
    });
  }

  toggleTime(id, at) {
    const e = this.data.entry(id);
    if (!e) return;
    if (!R.repeats(e)) return this.toggleDone(id);
    this.setTime(id, at, !R.doneOf(e).has(at));
  }

  steps(id, fn) {
    const e = this.data.entry(id);
    if (!e) return;
    const before = Steps.read(e.steps);
    const after = fn([...before]);
    if (!after) return;
    this.data.updateEntry({ ...e, steps: Steps.write(after), updatedAt: this.now });
  }

  toggleStep(id, i) {
    this.steps(id, (s) => (i >= 0 && i < s.length ? s.map((x, j) => (j === i ? { ...x, done: !x.done } : x)) : null));
  }

  addStep(id, text) {
    const t = String(text).trim();
    if (!t) return;
    this.steps(id, (s) => [...s, { text: t, done: false }]);
  }

  editStep(id, i, text) {
    const t = String(text).trim();
    this.steps(id, (s) => (i >= 0 && i < s.length && t && s[i].text !== t ? s.map((x, j) => (j === i ? { ...x, text: t } : x)) : null));
  }

  removeStep(id, i) {
    this.steps(id, (s) => (i >= 0 && i < s.length ? s.filter((_, j) => j !== i) : null));
  }

  moveStep(id, from, to) {
    this.steps(id, (s) => {
      if (from < 0 || to < 0 || from >= s.length || to >= s.length || from === to) return null;
      const [x] = s.splice(from, 1);
      s.splice(to, 0, x);
      return s;
    });
  }

  edit(id, title, body) {
    const e = this.data.entry(id);
    if (!e) return;
    const t = String(title).trim() || e.title;
    if (t === e.title && body === e.body) return;
    this.data.updateEntry({ ...e, title: t, body, updatedAt: this.now });
  }

  setKind(id, kind) {
    const e = this.data.entry(id);
    if (!e || kindOf(e) === kind) return;
    this.data.updateEntry({ ...e, kind, status: kind === 'task' ? e.status ?? 'todo' : null, checkInAt: kind === 'task' ? e.checkInAt : null, updatedAt: this.now });
  }

  /** Its reminder at [at] (null: none), coming back as [repeat] says ({every, days, times}). */
  setReminder(id, at, repeat = null, alarm = null) {
    const e = this.data.entry(id);
    if (!e) return;
    const rule = at === null || !repeat ? null : R.write(R.from(repeat.every, repeat.days ?? [], at, this.zone, repeat.times ?? []));
    const same = rule !== null && rule === e.repeat && e.occursFrom !== null;
    this.data.updateEntry({
      ...e,
      remindAt: at,
      repeat: rule,
      rungAt: null,
      occursFrom: same ? e.occursFrom : rule !== null && kindOf(e) === 'task' ? at : null,
      doneTimes: same ? e.doneTimes : '[]',
      alarm: alarm === null ? e.alarm : alarm ? 1 : 0,
      updatedAt: this.now,
    });
  }

  setAlarm(id, alarm) {
    const e = this.data.entry(id);
    if (e && !!e.alarm !== alarm) this.data.updateEntry({ ...e, alarm: alarm ? 1 : 0, updatedAt: this.now });
  }

  setDue(id, at, hasTime) {
    const e = this.data.entry(id);
    if (!e) return;
    this.data.updateEntry({ ...e, dueAt: at, dueHasTime: at !== null && hasTime ? 1 : 0, updatedAt: this.now });
  }

  setSensitive(id, sensitive) {
    const e = this.data.entry(id);
    if (e) this.data.updateEntry({ ...e, sensitive: sensitive ? 1 : 0, updatedAt: this.now });
  }

  setCategory(id, name) {
    const e = this.data.entry(id);
    if (!e) return;
    const c = Categories.pick(name, this.data.categories());
    if (c !== e.category) this.data.updateEntry({ ...e, category: c, position: null });
  }

  renameCategory(from, to) {
    const others = this.data.categories().filter((c) => c !== from);
    const target = to == null ? null : Categories.pick(to, others);
    if (target !== from) this.data.renameCategory(from, target);
  }

  /** Tasks put in this order by hand. */
  reorder(ids) {
    this.data.batch(() => ids.forEach((id, i) => {
      const e = this.data.entry(id);
      if (e && e.position !== i) this.data.updateEntry({ ...e, position: i });
    }));
  }

  /** Deleted (topics left with nothing go); kept a while for "Desfazer". */
  delete(id) {
    const e = this.data.entry(id);
    if (!e) return null;
    const topics = this.data.topicsOf(id);
    this.data.batch(() => {
      this.data.deleteEntry(id);
      this.data.pruneTopics();
    });
    this.deleted.set(id, { e, topics });
    return e;
  }

  undoDelete(id) {
    const d = this.deleted.get(id);
    if (!d) return null;
    this.deleted.delete(id);
    const { id: _, ...rest } = d.e;
    let newId = null;
    this.data.batch(() => {
      newId = this.data.insertEntry(rest);
      for (const t of d.topics) {
        const tid = this.data.topicByNorm(t.norm)?.id ?? this.data.insertTopic({ name: t.name, norm: t.norm, type: t.type });
        if (tid > 0) this.data.tie(newId, tid);
      }
    });
    return newId;
  }

  // ------------------------------------------------------------------ medicines

  newMed() {
    const now = this.now;
    return this.data.insertMed({ name: '', startsAt: now - (now % 60_000), createdAt: now, updatedAt: now });
  }

  saveMed(m) {
    const old = this.data.med(m.id);
    if (!old) return;
    const changed = Object.keys({ ...old, ...m }).some((k) => old[k] !== m[k]);
    if (changed) this.data.updateMed({ ...m, updatedAt: this.now });
  }

  deleteMed(id) {
    this.data.deleteMed(id);
  }

  dropMedIfEmpty(id) {
    const m = this.data.med(id);
    if (m && isBlank(m.name)) this.deleteMed(id);
  }

  toggleTaken(medId, at) {
    if (this.data.takenBetween(at, at).some((t) => t.medId === medId)) this.data.untake(medId, at);
    else this.data.take(medId, at, this.now);
  }

  // ------------------------------------------------------------------ photos

  turnPhoto(captureId) {
    const c = this.data.capture(captureId);
    if (c) this.data.write('captures', { ...c, turn: (c.turn + 90) % 360 });
  }

  removePhoto(captureId) {
    this.data.remove('captures', String(captureId));
  }
}
