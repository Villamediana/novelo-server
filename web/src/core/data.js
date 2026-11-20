// What the page holds: the phone's tables, row by row as the phone keeps them (booleans 0/1), the
// same ids. Every change made here is marked to go up (see sync.js); what comes down is put in with
// [put] (not marked). Listeners are told after each change (the screens draw again).

/** The columns of each table and what a new row has in them (the phone's database, version 18). */
export const SCHEMA = {
  entries: {
    pk: ['id'],
    defaults: {
      id: 0, kind: 'note', title: '', body: '', status: null, steps: '[]', tags: '[]', dueAt: null, dueHasTime: 0, remindAt: null, checkInAt: null,
      sensitive: 0, createdAt: 0, updatedAt: 0, doneAt: null, captureId: null, repeat: null, position: null, category: null, rungAt: null,
      occursFrom: null, doneTimes: '[]', alarm: 1, summary: '', skippedTimes: '[]',
    },
  },
  captures: {
    pk: ['id'],
    defaults: {
      id: 0, createdAt: 0, source: 'text', durationMs: 0, transcript: null, state: 'recorded', error: null, reply: null, outcomes: '[]', shown: '[]',
      focusEntryId: null, heard: null, heardPieces: 0, heardBy: null, tries: 0, description: null, shownPhotos: '[]', turn: 0, sound: 0, partOf: null,
      fileName: null, fileMime: null, fileSize: 0,
    },
  },
  entities: { pk: ['id'], defaults: { id: 0, name: '', norm: '', type: 'topic' } },
  entry_topics: { pk: ['entryId', 'topicId'], defaults: { entryId: 0, topicId: 0 } },
  links: { pk: ['a', 'b'], defaults: { a: 0, b: 0 } },
  progress: { pk: ['id'], defaults: { id: 0, entryId: 0, at: 0, text: '', status: null } },
  meds: {
    pk: ['id'],
    defaults: {
      id: 0, name: '', strength: null, dose: null, amount: null, person: null, times: '[]', everyHours: null, days: '[]', startsAt: 0, endsAt: null,
      notes: '', photoId: null, captureId: null, createdAt: 0, updatedAt: 0, alarm: 1,
    },
  },
  med_taken: { pk: ['medId', 'at'], defaults: { medId: 0, at: 0, takenAt: 0 } },
};

export const TABLES = Object.keys(SCHEMA);

/** The id of a row as the record names it ("12", "7:3"). */
export function ridOf(table, row) {
  return SCHEMA[table].pk.map((c) => row[c]).join(':');
}

/** A new id of this computer's: far above the phone's own (2^45 to 2^50), never the same twice. */
export function newId() {
  const hi = globalThis.crypto.getRandomValues(new Uint32Array(2));
  // 2^45 + a random number below 2^50 - 2^45.
  return 2 ** 45 + ((hi[0] % 2 ** 18) * 2 ** 31 + (hi[1] % 2 ** 31)) % (2 ** 50 - 2 ** 45);
}

export class Data {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.tables = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
    this.dirty = new Map(); // "table|rid" → true: changed here, to go up
    // Kept here for now (what she wrote, while it is being organized): it goes up once it is done.
    this.held = new Set();
    // Rows changed here since the page last kept them (sync.js keeps them in the browser at once).
    this.changed = new Set();
    this.listeners = new Set();
    this.version = 0;
    this.quiet = 0;
  }

  // ------------------------------------------------------------------ change and listen

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    this.version++;
    if (this.quiet) return;
    for (const fn of this.listeners) fn(this.version);
  }

  /** Several changes, one notice at the end. */
  batch(fn) {
    this.quiet++;
    try {
      return fn();
    } finally {
      this.quiet--;
      if (!this.quiet) this.notify();
    }
  }

  /** A row from the server (or loaded): in, not marked. Null removes it. */
  put(table, rid, row) {
    if (row) this.tables[table].set(rid, row);
    else this.tables[table].delete(rid);
  }

  /** A change made here: in, and marked to go up. */
  write(table, row) {
    const full = { ...SCHEMA[table].defaults, ...row };
    const rid = ridOf(table, full);
    this.tables[table].set(rid, full);
    this.dirty.set(`${table}|${rid}`, true);
    this.changed.add(`${table}|${rid}`);
    this.notify();
    return full;
  }

  remove(table, rid) {
    if (!this.tables[table].has(rid)) return;
    this.tables[table].delete(rid);
    this.dirty.set(`${table}|${rid}`, true);
    this.changed.add(`${table}|${rid}`);
    // What pointed at it goes too (the phone's database does it by itself).
    if (table === 'entries') {
      const id = Number(rid);
      for (const [k, t] of [...this.tables.entry_topics]) if (t.entryId === id) this.remove('entry_topics', k);
      for (const [k, l] of [...this.tables.links]) if (l.a === id || l.b === id) this.remove('links', k);
      for (const [k, p] of [...this.tables.progress]) if (p.entryId === id) this.remove('progress', k);
    }
    if (table === 'entities') {
      const id = Number(rid);
      for (const [k, t] of [...this.tables.entry_topics]) if (t.topicId === id) this.remove('entry_topics', k);
    }
    if (table === 'meds') {
      const id = Number(rid);
      for (const [k, t] of [...this.tables.med_taken]) if (t.medId === id) this.remove('med_taken', k);
    }
    this.notify();
  }

  hold(table, rid) {
    this.held.add(`${table}|${rid}`);
  }

  release(table, rid) {
    this.held.delete(`${table}|${rid}`);
    this.notify();
  }

  // ------------------------------------------------------------------ entries

  entry(id) {
    return this.tables.entries.get(String(id)) ?? null;
  }

  /** All entries, the newest first (as the phone's all()). */
  entries() {
    return [...this.tables.entries.values()].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  }

  /** Open tasks: with a due day first (soonest), then the newest. */
  openTasks() {
    return [...this.tables.entries.values()]
      .filter((e) => e.kind === 'task' && e.status !== 'done')
      .sort((a, b) => (a.dueAt == null) - (b.dueAt == null) || (a.dueAt ?? 0) - (b.dueAt ?? 0) || b.createdAt - a.createdAt);
  }

  diariesBetween(from, to) {
    return [...this.tables.entries.values()].filter((e) => e.kind === 'diary' && e.createdAt >= from && e.createdAt <= to).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  }

  categories() {
    return [...new Set([...this.tables.entries.values()].filter((e) => e.kind === 'task' && e.category != null).map((e) => e.category))];
  }

  insertEntry(e) {
    const id = newId();
    this.write('entries', { ...e, id });
    return id;
  }

  updateEntry(e) {
    if (!this.entry(e.id)) return;
    this.write('entries', e);
  }

  deleteEntry(id) {
    this.remove('entries', String(id));
  }

  renameCategory(from, to) {
    this.batch(() => {
      for (const e of [...this.tables.entries.values()]) if (e.kind === 'task' && e.category === from) this.write('entries', { ...e, category: to });
    });
  }

  // ------------------------------------------------------------------ the graph

  topics() {
    return [...this.tables.entities.values()];
  }

  ties() {
    return [...this.tables.entry_topics.values()];
  }

  links() {
    return [...this.tables.links.values()];
  }

  topicByNorm(norm) {
    for (const t of this.tables.entities.values()) if (t.norm === norm) return t;
    return null;
  }

  insertTopic(t) {
    if (this.topicByNorm(t.norm)) return -1;
    const id = newId();
    this.write('entities', { ...t, id });
    return id;
  }

  tie(entryId, topicId) {
    if (this.tables.entry_topics.has(`${entryId}:${topicId}`)) return;
    this.write('entry_topics', { entryId, topicId });
  }

  link(a, b) {
    if (this.tables.links.has(`${a}:${b}`)) return;
    this.write('links', { a, b });
  }

  topicsOf(entryId) {
    const ids = new Set(this.ties().filter((t) => t.entryId === entryId).map((t) => t.topicId));
    return this.topics().filter((t) => ids.has(t.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** Topics left with no entry go. */
  pruneTopics() {
    const used = new Set(this.ties().map((t) => t.topicId));
    for (const t of this.topics()) if (!used.has(t.id)) this.remove('entities', String(t.id));
  }

  addProgress(entryId, at, status) {
    this.write('progress', { id: newId(), entryId, at, text: '', status });
  }

  // ------------------------------------------------------------------ captures

  capture(id) {
    return this.tables.captures.get(String(id)) ?? null;
  }

  captures() {
    return [...this.tables.captures.values()];
  }

  /** The last capture that went through (not [id], not part of another): the conversation's last turn. */
  lastDone(id) {
    let best = null;
    for (const c of this.tables.captures.values()) {
      if (c.state !== 'done' || c.id === id || c.partOf != null) continue;
      if (!best || c.createdAt > best.createdAt || (c.createdAt === best.createdAt && c.id > best.id)) best = c;
    }
    return best;
  }

  // ------------------------------------------------------------------ medicines

  med(id) {
    return this.tables.meds.get(String(id)) ?? null;
  }

  meds() {
    return [...this.tables.meds.values()].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }

  taken() {
    return [...this.tables.med_taken.values()];
  }

  takenBetween(from, to) {
    return this.taken().filter((t) => t.at >= from && t.at <= to);
  }

  insertMed(m) {
    const id = newId();
    this.write('meds', { ...m, id });
    return id;
  }

  updateMed(m) {
    if (!this.med(m.id)) return;
    this.write('meds', m);
  }

  deleteMed(id) {
    this.remove('meds', String(id));
  }

  take(medId, at, takenAt) {
    const k = `${medId}:${at}`;
    if (this.tables.med_taken.has(k)) return; // as the phone's take(): one already marked stays as it was
    this.write('med_taken', { medId, at, takenAt });
  }

  untake(medId, at) {
    this.remove('med_taken', `${medId}:${at}`);
  }
}
