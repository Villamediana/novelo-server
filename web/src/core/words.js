// The small pieces of text the phone uses everywhere (mind/Recall.kt Words, data/Categories.kt,
// mind/Brain.kt Steps and Tags, mind/Keeper.kt joined and Steps.same), the same here. Pure.

const MARKS = /\p{M}+/gu;
const SPLIT = /[^\p{L}\p{N}]+/u;

export const Words = {
  /** Lowercase, no accents. */
  fold(text) {
    return String(text ?? '').toLowerCase().normalize('NFD').replace(MARKS, '');
  },
  /** "Reunião às 3h" → ["reuniao", "as", "3h"]. */
  of(text) {
    return Words.fold(text).split(SPLIT).filter((w) => w.length > 0);
  },
};

export const Categories = {
  MAX: 24,
  clean(name) {
    const n = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, Categories.MAX).trim();
    if (!n) return null;
    return n.charAt(0).toUpperCase() + n.slice(1);
  },
  fold(name) {
    return String(name).trim().toLowerCase().normalize('NFD').replace(MARKS, '');
  },
  /** [name] as one of [existing] when it is the same written another way; otherwise cleaned (a new one). */
  pick(name, existing) {
    const n = Categories.clean(name);
    if (n === null) return null;
    const f = Categories.fold(n);
    for (const e of existing) if (Categories.fold(e) === f) return e;
    return n;
  },
  /** The categories in use among [tasks], the ones with the most open tasks first, then by name. */
  inUse(entries) {
    const groups = new Map();
    for (const e of entries) {
      if (kindOf(e) !== 'task' || e.category == null) continue;
      if (!groups.has(e.category)) groups.set(e.category, []);
      groups.get(e.category).push(e);
    }
    return [...groups.entries()]
      .map(([name, list]) => ({ name, open: list.filter((e) => statusOf(e) !== 'done').length }))
      .sort((a, b) => b.open - a.open || (Categories.fold(a.name) < Categories.fold(b.name) ? -1 : Categories.fold(a.name) > Categories.fold(b.name) ? 1 : 0))
      .map((x) => x.name);
  },
};

/** A task, a note or a diary (what an unknown kind is read as: a note). */
export function kindOf(e) {
  const k = String(e?.kind ?? '').trim().toLowerCase();
  return k === 'task' || k === 'note' || k === 'diary' ? k : 'note';
}

export function kindKey(k) {
  const v = String(k ?? '').trim().toLowerCase();
  return v === 'task' || v === 'note' || v === 'diary' ? v : null;
}

export function statusKey(s) {
  const v = String(s ?? '').trim().toLowerCase();
  return ['todo', 'doing', 'waiting', 'done'].includes(v) ? v : null;
}

export function statusOf(e) {
  return statusKey(e?.status);
}

export function isOpenTask(e) {
  return kindOf(e) === 'task' && statusOf(e) !== 'done';
}

export const Steps = {
  read(text) {
    try {
      const v = JSON.parse(text ?? '[]');
      return Array.isArray(v) ? v.filter((s) => s && typeof s.text === 'string').map((s) => ({ text: s.text, done: s.done === true })) : [];
    } catch {
      return [];
    }
  },
  /** As the phone writes them: "done" only when true. */
  write(steps) {
    return JSON.stringify(steps.map((s) => (s.done ? { text: s.text, done: true } : { text: s.text })));
  },
  /** The same step said another way (one inside the other, from 6 letters). */
  same(a, b) {
    const x = Words.of(a).join(' ');
    const y = Words.of(b).join(' ');
    return x.length > 0 && (x === y || (x.length >= 6 && y.includes(x)) || (y.length >= 6 && x.includes(y)));
  },
};

export const Tags = {
  read(text) {
    try {
      const v = JSON.parse(text ?? '[]');
      return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
    } catch {
      return [];
    }
  },
  write(tags) {
    return JSON.stringify(tags);
  },
};

/** [body] and what is new about it, a blank line between them. */
export function joined(body, news) {
  return [String(body).trim(), String(news).trim()].filter((s) => s.length > 0).join('\n\n');
}

/** Kotlin's String.take for a possibly missing string. */
export function take(s, n) {
  return String(s ?? '').slice(0, n);
}

export function isBlank(s) {
  return s == null || String(s).trim().length === 0;
}
