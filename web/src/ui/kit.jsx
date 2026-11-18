// The small pieces of the page: icons (the app's line icons), the ball of yarn, a card with its
// stitch, the round check, photos opened here, and how a day and an hour are said.
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as T from '../core/time.js';
import { LOCALE } from './i18n.js';

export const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

/** The data, drawn again when it changes. */
export function useData() {
  const app = useApp();
  useSyncExternalStore((fn) => app.data.subscribe(fn), () => app.data.version);
  return app.data;
}

const PATHS = {
  back: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7',
  stop: 'M7 7h10v10H7z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  trash: 'M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12',
  retry: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  send: 'M5 12h13M13 6l6 6-6 6',
  photo: 'M4 6h16v12H4zM8 14l3-3 3 3 2-2 4 4M9 9.5a1 1 0 1 0 0 .01',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  calendar: 'M5 6h14v14H5zM5 10h14M9 3v4M15 3v4',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  tune: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4',
  lock: 'M7 11h10v9H7zM9 11V8a3 3 0 0 1 6 0v3',
  write: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  today: 'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  tasks: 'M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01',
  notes: 'M6 4h12v16H6zM9 9h6M9 13h6M9 17h3',
  diary: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 18a2 2 0 0 1 2-2h11',
  meds: 'M10.5 4.5l9 9a4 4 0 0 1-5.7 5.7l-9-9a4 4 0 0 1 5.7-5.7zM8 12l4-4',
  gallery: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5',
  turn: 'M5 12a7 7 0 1 0 2-5M5 3v4h4',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  sound: 'M5 10v4h3l5 4V6L8 10zM16 9a4 4 0 0 1 0 6',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
};

export function Icon({ name, size = 22, stroke = 1.7 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

/** The ball of yarn (the app's mark): the ball, its turns of thread, the loose end. */
export function Yarn({ size = 34, color = 'var(--accent)' }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
      <circle cx="46" cy="46" r="34" fill={color} />
      <g fill="none" stroke="var(--on-accent)" strokeOpacity="0.32" strokeWidth="3" strokeLinecap="round">
        <path d="M22 30c14-8 34-8 50 4" /><path d="M16 44c18-10 40-8 58 6" /><path d="M20 60c14-8 30-8 44 2" />
        <path d="M38 14c-8 18-8 40 2 62" /><path d="M56 14c6 16 6 36-4 60" />
      </g>
      <path d="M70 66c8 6 16 10 16 18s-8 8-10 2" fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

export function Check({ on, onClick, label }) {
  return (
    <button type="button" className={`check${on ? ' on' : ''}`} aria-label={label} aria-pressed={!!on} onClick={(e) => { e.stopPropagation(); onClick?.(); }}>
      {on ? <Icon name="check" stroke={2.6} /> : null}
    </button>
  );
}

export function IconBtn({ icon, label, onClick, kind = '', disabled }) {
  return (
    <button type="button" className={`icon-btn ${kind}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  );
}

/**
 * Closing with a little motion: [leave] marks it as going (the screen plays its way out), and
 * [onClose] comes when that ends. Returns [leaving, leave].
 */
export function useLeave(onClose, ms = 190) {
  const [leaving, setLeaving] = useState(false);
  const gone = useRef(false);
  const leave = () => {
    if (gone.current) return;
    gone.current = true;
    setLeaving(true);
    setTimeout(onClose, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms);
  };
  return [leaving, leave];
}

/** A file of hers, opened here (fetched encrypted, opened with the space's key): an address for the page. */
export function useBlobUrl(media) {
  const app = useApp();
  const [url, setUrl] = useState(null);
  const id = media?.id;
  useEffect(() => {
    let live = true;
    if (!id) { setUrl(null); return undefined; }
    app.sync.url(id, media?.mime ?? 'image/jpeg').then((u) => { if (live) setUrl(u); }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  return url;
}

/** A photo (a capture): its thumbnail in a grid, the whole one when [whole]. */
export function Photo({ capture, whole = false, onClick, className = 'photo' }) {
  const app = useApp();
  const media = capture?.media ?? {};
  const url = useBlobUrl(whole ? media.image ?? media.thumb : media.thumb ?? media.image);
  const turn = capture?.turn ?? 0;
  return (
    <button type="button" className={className} onClick={onClick} aria-label={app.t('photo')}>
      {url ? <img src={url} alt="" style={turn ? { transform: `rotate(${turn}deg)` } : undefined} draggable={false} onLoad={(e) => e.currentTarget.classList.add('ready')} ref={(el) => { if (el?.complete && el.naturalWidth) el.classList.add('ready'); }} /> : <span className="wait">{media.image || media.thumb ? '' : app.t('photoOnPhone')}</span>}
    </button>
  );
}

// ------------------------------------------------------------------ days and hours, said

export function hm(ms, zone) {
  return T.hhmm(T.timeOf(ms, zone));
}

/** "hoje", "amanhã", "ontem", "sexta", "12 de nov." — a day said the short way. */
export function dayWord(ms, zone, lang, t, now = Date.now()) {
  const d = T.dateOf(ms, zone);
  const today = T.dateOf(now, zone);
  const diff = T.daysBetween(today, d);
  if (diff === 0) return t('dayToday').toLowerCase();
  if (diff === 1) return t('tomorrow');
  if (diff === -1) return t('yesterday');
  const loc = LOCALE[lang] ?? 'pt-BR';
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat(loc, { weekday: 'long', timeZone: zone }).format(new Date(ms));
  return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', ...(d.y !== today.y ? { year: 'numeric' } : {}), timeZone: zone }).format(new Date(ms));
}

export function when(ms, hasTime, zone, lang, t) {
  return hasTime ? `${dayWord(ms, zone, lang, t)} · ${hm(ms, zone)}` : dayWord(ms, zone, lang, t);
}

/** A date and time for an <input type="datetime-local"> (and back). */
export function toInput(ms, zone) {
  if (ms == null) return '';
  const p = T.parts(ms, zone);
  const two = (n) => String(n).padStart(2, '0');
  return `${p.y}-${two(p.m)}-${two(p.d)}T${two(p.h)}:${two(p.mi)}`;
}

export function fromInput(text, zone) {
  const p = T.parseLocal(text);
  if (!p) return null;
  return p.time ? T.toMs(p.date.y, p.date.m, p.date.d, p.time.h, p.time.mi, 0, zone) : T.atStartOfDay(p.date, zone);
}

/** A textarea that grows with what is written in it. */
export function grow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}
