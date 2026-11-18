// Finding what was said before — mind/Recall.kt and mind/PhotoRecall.kt, the same here: words that
// match (rarer ones weigh more, a word's start finds the rest of it), one hop along the topics and
// links, a small nudge to what is recent. Pure.
import { Words } from './words.js';

const terms = (query) => [...new Set(Words.of(query).filter((w) => w.length >= 3 || /\d/.test(w)))];

function score(set, ts, df, n) {
  let s = 0;
  const matched = new Set();
  for (const t of ts) {
    const exact = set.has(t);
    let prefix = false;
    if (!exact && t.length >= 4) for (const w of set) if (w.length >= 4 && (w.startsWith(t) || t.startsWith(w))) { prefix = true; break; }
    if (exact || prefix) {
      s += Math.log(1 + n / (df.get(t) ?? 1)) * (exact ? 1 : 0.6);
      matched.add(t);
    }
  }
  return [s, matched];
}

function counts(sets) {
  const df = new Map();
  for (const set of sets) for (const w of set) df.set(w, (df.get(w) ?? 0) + 1);
  return df;
}

export class Recall {
  /** [entries], [topics] ({id, name}), [ties] ({entryId, topicId}), [links] ({a, b}). */
  constructor(entries, topics, ties, links) {
    this.byId = new Map(entries.map((e) => [e.id, e]));
    const topicName = new Map(topics.map((t) => [t.id, t.name]));
    this.topicsOf = new Map();
    this.entriesOf = new Map();
    for (const t of ties) {
      if (!this.topicsOf.has(t.entryId)) this.topicsOf.set(t.entryId, []);
      this.topicsOf.get(t.entryId).push(t.topicId);
      if (!this.entriesOf.has(t.topicId)) this.entriesOf.set(t.topicId, []);
      this.entriesOf.get(t.topicId).push(t.entryId);
    }
    this.linked = new Map();
    for (const l of links) {
      if (!this.linked.has(l.a)) this.linked.set(l.a, []);
      this.linked.get(l.a).push(l.b);
      if (!this.linked.has(l.b)) this.linked.set(l.b, []);
      this.linked.get(l.b).push(l.a);
    }
    this.words = new Map(entries.map((e) => {
      const topicText = (this.topicsOf.get(e.id) ?? []).map((id) => topicName.get(id)).filter((x) => x != null).join(' ');
      return [e.id, new Set(Words.of(`${e.title} ${e.body} ${e.tags} ${topicText}`))];
    }));
    this.df = counts(this.words.values());
  }

  terms(query) {
    return terms(query);
  }

  /** The best entries for [query]: [{entry, score, matched}]. */
  search(query, limit = 12, now = Date.now()) {
    const ts = terms(query);
    if (!ts.length || !this.byId.size) return [];
    const n = this.byId.size;
    const direct = new Map();
    for (const [id, set] of this.words) {
      const [s, matched] = score(set, ts, this.df, n);
      if (s > 0) direct.set(id, [s, matched]);
    }
    if (!direct.size) return [];
    const total = new Map();
    for (const [id, v] of direct) total.set(id, (total.get(id) ?? 0) + v[0]);
    [...direct.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, 8).forEach(([id, v]) => {
      const near = [...(this.topicsOf.get(id) ?? []).flatMap((t) => this.entriesOf.get(t) ?? []), ...(this.linked.get(id) ?? [])];
      for (const other of near) if (other !== id) total.set(other, (total.get(other) ?? 0) + v[0] * 0.35);
    });
    return [...total.entries()]
      .map(([id, s]) => {
        const e = this.byId.get(id);
        return e ? { entry: e, score: s + recency(e, now), matched: direct.get(id)?.[1] ?? new Set() } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Entries tied to [id] through a shared topic or a link, closest first. */
  related(id, limit = 8) {
    const c = new Map();
    for (const t of this.topicsOf.get(id) ?? []) for (const e of this.entriesOf.get(t) ?? []) c.set(e, (c.get(e) ?? 0) + 1);
    for (const e of this.linked.get(id) ?? []) c.set(e, (c.get(e) ?? 0) + 2);
    c.delete(id);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => this.byId.get(e)).filter(Boolean).slice(0, limit);
  }
}

function recency(e, now) {
  const days = Math.max(now - e.createdAt, 0) / 86_400_000;
  return 0.3 / (1 + days / 7);
}

/** Photos ({id, takenAt, description, text}) by what they show and what is written in them. */
export class PhotoRecall {
  constructor(photos) {
    this.all = photos;
    this.words = new Map(photos.map((p) => [p.id, new Set(Words.of(`${p.description ?? ''} ${p.text ?? ''}`))]));
    this.df = counts(this.words.values());
  }

  search(query, limit = 12) {
    const ts = terms(query);
    if (!ts.length || !this.all.length) return [];
    const n = this.all.length;
    return this.all
      .map((p) => [p, score(this.words.get(p.id) ?? new Set(), ts, this.df, n)[0]])
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1] || b[0].takenAt - a[0].takenAt)
      .slice(0, limit)
      .map(([p]) => p);
  }

  /** The photos taken in [days] ([first, last] ms), the newest first. */
  during(days, limit = 12) {
    return this.all.filter((p) => p.takenAt >= days[0] && p.takenAt <= days[1]).sort((a, b) => b.takenAt - a.takenAt).slice(0, limit);
  }
}

/** The bit of text around the first match ("…falei com a Ana sobre o contrato…"). */
export function around(text, ts, radius = 70) {
  const flat = String(text).replaceAll('\n', ' ').trim();
  if (!ts.length || flat.length <= radius * 2) return flat;
  const folded = Words.fold(flat);
  const hits = ts.map((t) => folded.indexOf(t)).filter((i) => i >= 0);
  if (!hits.length) return `${flat.slice(0, radius * 2)}…`;
  const at = Math.min(...hits);
  const start = Math.max(at - radius, 0);
  const end = Math.min(at + radius, flat.length);
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}

/** Character ranges of [text] that match [ts], to highlight: [[start, end)]. */
export function ranges(text, ts) {
  if (!ts.length) return [];
  const folded = Words.fold(text);
  if (folded.length !== String(text).length) return [];
  const out = [];
  const isWord = (c) => /[\p{L}\p{N}]/u.test(c);
  for (const t of ts) {
    let i = folded.indexOf(t);
    while (i >= 0) {
      if (i === 0 || !isWord(folded[i - 1])) {
        let end = i + t.length;
        while (end < folded.length && isWord(folded[end])) end++;
        out.push([i, end]);
      }
      i = folded.indexOf(t, i + t.length);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}
