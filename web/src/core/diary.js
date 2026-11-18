// The diary is one per day — mind/DayDiary.kt, the same here.
import * as T from './time.js';
import { Words, joined } from './words.js';

/** The whole day (in [zone]) that [ms] falls in: [first, last] ms. */
export function bounds(ms, zone) {
  const date = T.dateOf(ms, zone);
  return [T.atStartOfDay(date, zone), T.atStartOfDay(T.addDays(date, 1), zone) - 1];
}

/** Only what isn't in the day's diary yet joins it; the day told again from the start takes its place. */
export function merge(body, more) {
  const had = Words.of(body).join(' ');
  const all = Words.of(more).join(' ');
  if (!all) return body;
  if (!had || ` ${all} `.includes(` ${had} `)) return String(more).trim();
  const fresh = String(more).trim().split(/\n\s*\n/).map((p) => p.trim()).filter((p) => {
    const w = Words.of(p).join(' ');
    return w.length > 0 && !` ${had} `.includes(` ${w} `);
  });
  return fresh.reduce((b, p) => joined(b, p), body);
}

const LOCALES = { pt: 'pt-BR', es: 'es', en: 'en' };

/** "Quarta-feira, 11 de novembro" in [lang] (pt, es, en), as the phone names a diary. */
export function title(ms, zone, lang = 'pt') {
  const loc = LOCALES[lang] ?? 'pt-BR';
  const opts = { timeZone: zone };
  const weekday = new Intl.DateTimeFormat(loc, { ...opts, weekday: 'long' }).format(new Date(ms));
  const month = new Intl.DateTimeFormat(loc, { ...opts, month: 'long' }).format(new Date(ms));
  const d = T.dateOf(ms, zone).d;
  const text = lang === 'en' ? `${weekday}, ${month} ${d}` : `${weekday}, ${d} de ${month}`;
  return text.charAt(0).toLocaleUpperCase(loc) + text.slice(1);
}
