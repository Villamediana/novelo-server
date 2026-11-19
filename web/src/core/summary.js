// "Em tópicos" (app 1.80) — mind/Summary.kt, the same here: what was understood of a note, in points,
// kept one per line in the entry's `summary`. Whether a note is worth them is the model's call (it sees
// the note); the code only cleans what it wrote. Pure.

// Only so a model that runs away can't fill the page: no note needs more.
export const MAX_POINTS = 30;
export const MAX_POINT = 300;

// Java's \s (ASCII) and Character.isLetterOrDigit / isDigit, as the app reads them.
const SPACES = /[ \t\n\u000B\f\r]+/g;
const BULLET = /^(?:[-–—•·*▪◦>]+|\d{1,2}[.)])[ \t\n\u000B\f\r]+/;
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const DIGIT = /\p{Nd}/u;

/**
 * A note's points as the model may write them: a list, one text with a point per line, or with some
 * shape ({"assunto": "Festa", "pontos": ["…"]} → "Festa: …"): always texts (Brain.kt's Points).
 */
export function points(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(points);
  if (typeof v === 'object') {
    const values = Object.values(v);
    const head = values.filter((x) => x !== null && typeof x !== 'object').map((x) => String(x).trim()).filter((x) => x).join(': ');
    const inner = values.filter((x) => x !== null && typeof x === 'object').flatMap(points);
    if (!inner.length) return head ? [head] : [];
    if (!head) return inner;
    return inner.map((p) => `${head}: ${p}`);
  }
  return [String(v)];
}

/** The model's points, one per line: bullets, numbers and bold marks off; blank and repeated ones out. */
export function clean(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    for (const part of String(raw).split('\n')) {
      const p = part.trim().replace(BULLET, '').replaceAll('**', '').replace(SPACES, ' ').trim().slice(0, MAX_POINT).trim();
      if (!LETTER_OR_DIGIT.test(p)) continue;
      const key = p.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
      if (out.length === MAX_POINTS) return out;
    }
  }
  return out;
}

/** The points as they are kept: one per line. */
export const write = (list) => list.join('\n');

/** The points kept. */
export const read = (summary) => String(summary ?? '').split('\n').map((s) => s.trim()).filter((s) => s);

/** What the model wrote, as it is kept ('': none). */
export const keep = (list) => write(clean(list));

/** A point that starts by what it is about ("Local: a chácara do tio"): [that part, the rest]; null when it doesn't. */
export function label(point) {
  const at = point.indexOf(':');
  if (at < 1 || at > 32 || at === point.length - 1) return null;
  const head = point.slice(0, at).trim();
  const rest = point.slice(at + 1).trim();
  if (!head || DIGIT.test(head.at(-1)) || /[.;!?]/.test(head) || !rest || rest.startsWith('/')) return null;
  return [head, rest];
}
