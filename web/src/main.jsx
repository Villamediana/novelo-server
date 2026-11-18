// The Novelo on the computer, started: on a phone, the page to get the app; on a computer not linked
// yet, its QR code; linked, the space opened here (its keys never leave this browser), kept in step
// with the phone, and the page.
import { createRoot } from 'react-dom/client';
import * as lock from './core/crypto.js';
import { Api } from './core/api.js';
import { Data } from './core/data.js';
import { Store } from './core/store.js';
import { WebSync } from './core/sync.js';
import { WebMind } from './core/mind.js';
import { Library } from './core/library.js';
import { here } from './core/time.js';
import { strings, pickLang } from './ui/i18n.js';
import { Ctx, Yarn } from './ui/kit.jsx';
import { App } from './ui/app.jsx';
import { LinkPage, PhonePage, isPhone } from './ui/link.jsx';
import { smaller } from './ui/write.jsx';

const root = createRoot(document.getElementById('root'));

function prefsSaved() {
  try {
    return JSON.parse(localStorage.getItem('novelo-prefs') ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function look(prefs) {
  const dark = prefs.mode === 'dark' || (prefs.mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.mode = dark ? 'dark' : 'light';
  document.documentElement.dataset.accent = prefs.accent ?? 'vermilion';
  document.documentElement.lang = prefs.lang === 'en' ? 'en' : prefs.lang === 'es' ? 'es' : 'pt-BR';
}

/** The paper's grain (the app's: specks about a dp wide, the same every time), made once. */
async function grain() {
  const side = 96;
  const c = new OffscreenCanvas(side, side);
  const g = c.getContext('2d');
  const img = g.createImageData(side, side);
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const dark = document.documentElement.dataset.mode === 'dark';
  const [r, gg, b, a] = dark ? [245, 225, 200, 0.03] : [107, 76, 46, 0.045];
  for (let i = 0; i < side * side; i++) {
    const v = rnd();
    // As the app: a speck's strength (0–1) times the tint's own (a few percent).
    const alpha = v > 0.6 ? ((v - 0.6) / 0.4) * a * 255 : 0;
    img.data.set([r, gg, b, Math.min(255, alpha)], i * 4);
  }
  g.putImageData(img, 0, 0);
  const url = URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }));
  document.documentElement.style.setProperty('--grain', `url("${url}")`);
}

function Unlinked({ t }) {
  return (
    <div className="center"><div className="phone"><Yarn size={60} /><h1>{t('unlinked')}</h1><button type="button" className="big-btn" onClick={() => location.reload()}>{t('linkNew')}</button></div></div>
  );
}

async function start() {
  let prefs = prefsSaved();
  look(prefs);
  grain().catch(() => {});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { look(prefs); grain().catch(() => {}); });
  const lang = pickLang(prefs.lang);
  const t = strings(lang);
  if (isPhone()) {
    root.render(<PhonePage t={t} />);
    return;
  }
  const store = await new Store().open();
  const keys = await store.get('keys');
  const token = await store.get('token');
  if (!keys || !token) {
    const api = new Api();
    root.render(<LinkPage api={api} t={t} onLinked={async ({ token: tok, space, key, owner }) => {
      // The space's key becomes keys that can't be taken out of this browser; the bytes go.
      const k = await lock.spaceKeys(key);
      key.fill(0);
      await store.set('keys', k);
      await store.set('token', tok);
      await store.set('space', space);
      await store.set('owner', owner);
      await store.set('cursor', 0);
      location.reload();
    }} />);
    return;
  }

  const zone = here();
  const data = new Data();
  let unlinked = false;
  const unlink = async (tellServer) => {
    if (unlinked) return;
    unlinked = true;
    if (tellServer) await api.unlink().catch(() => {});
    await store.wipe();
    // The other tabs of this page let go too (their keys are in their memory).
    try { tabs?.postMessage('unlinked'); } catch { /* closed */ }
    root.render(<Unlinked t={t} />);
  };
  let tabs = null;
  try {
    tabs = new BroadcastChannel('novelo-web');
    tabs.onmessage = (e) => { if (e.data === 'unlinked') unlink(false); };
  } catch { /* an old browser: each tab finds out by itself (the server says 401) */ }
  const api = new Api({ token, onUnlinked: () => unlink(false) });
  const syncListeners = new Set();
  let wasOnline = true;
  let thinking = null; // the mind, once made (below)
  const sync = new WebSync({
    api,
    keys,
    data,
    store,
    onStatus: (s) => {
      syncListeners.forEach((f) => f(s));
      // The server answered again after not answering: what waited in the line goes now.
      const ok = s.online && !s.error;
      if (ok && !wasOnline) thinking?.online();
      wasOnline = ok;
    },
  });
  await sync.load();
  const localFiles = new Map(); // capture id → the File she dropped (to describe it without fetching it back)
  const mindListeners = new Set();
  const mind = new WebMind({
    data,
    zone,
    lang,
    ask: (job, body, opts) => api.ask(job, body, opts),
    describe: async (id) => {
      const c = data.capture(id);
      const local = localFiles.get(id);
      const blob = local ?? (c?.media?.image ? new Blob([await sync.bytes(c.media.image.id)]) : null);
      if (!blob) return null;
      const jpeg = await smaller(blob, 1024);
      return jpeg ? lock.b64.enc(jpeg) : null;
    },
    peek: async (id) => {
      const c = data.capture(id);
      if (!c || !/^(text\/|application\/(json|xml|csv))/.test(c.fileMime ?? '') && !/\.(txt|md|csv|json|xml|log|ya?ml|ini|tsv)$/i.test(c.fileName ?? '')) return '';
      const local = localFiles.get(id);
      const bytes = local ? new Uint8Array(await local.slice(0, 16_000).arrayBuffer()) : (c.media?.file ? await sync.bytes(c.media.file.id) : null);
      return bytes ? new TextDecoder().decode(bytes.subarray(0, 16_000)).slice(0, 800) : '';
    },
    onChange: (m) => mindListeners.forEach((f) => f(m)),
  });
  thinking = mind;
  const library = new Library(data, zone, lang);
  // What changes here is kept in the browser at once and sent (a moment later, several together).
  let soon = null;
  data.subscribe(() => {
    clearTimeout(soon);
    soon = setTimeout(() => sync.saveLocal(), 400);
  });
  addEventListener('online', () => { mind.online(); sync.saveLocal(); });
  // Seen at once (the sync may be in the middle of a long wait and only notice later).
  addEventListener('offline', () => sync.setStatus({ online: false }));
  addEventListener('beforeunload', () => { sync.saveLocal(); });

  const app = {
    data, sync, mind, library, zone, lang, t, api, localFiles,
    owner: await store.get('owner'),
    prefs,
    setPrefs: (p) => {
      prefs = p;
      try { localStorage.setItem('novelo-prefs', JSON.stringify(p)); } catch { /* private window */ }
      look(p);
      grain().catch(() => {});
      if (p.lang && p.lang !== lang) location.reload();
    },
    onSync: (f) => { syncListeners.add(f); return () => syncListeners.delete(f); },
    onMind: (f) => { mindListeners.add(f); return () => mindListeners.delete(f); },
    unlink: () => unlink(true),
    open: () => {}, openMed: () => {}, view: () => {}, toast: () => {},
  };
  root.render(<Ctx.Provider value={app}><App /></Ctx.Provider>);
  mind.resume();
  sync.run();
}

start().catch((e) => {
  console.error(e);
  root.render(<div className="center"><p className="faint">{String(e?.message ?? e)}</p></div>);
});

