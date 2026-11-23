// The Novelo on the computer, started: on a phone, the page to get the app; on a computer not linked
// yet, its QR code; linked, the space opened here (its keys never leave this browser), kept in step
// with the phone, and the page.
import { createRoot } from 'react-dom/client';
import * as lock from './core/crypto.js';
import { Api } from './core/api.js';
import { Data } from './core/data.js';
import { Store, MemoryStore } from './core/store.js';
import { WebSync } from './core/sync.js';
import { WebMind } from './core/mind.js';
import { Library } from './core/library.js';
import { here } from './core/time.js';
import { strings, pickLang } from './ui/i18n.js';
import { Ctx, Yarn } from './ui/kit.jsx';
import { App } from './ui/app.jsx';
import { FriendPage, LinkPage, PhonePage, isPhone } from './ui/link.jsx';
import { smaller } from './ui/write.jsx';

const root = createRoot(document.getElementById('root'));
let prefs = {};

// Installing the page as an app (its own window): the browser's offer, kept for Ajustes' button.
let installOffer = null;
const installListeners = new Set();
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installOffer = e;
  installListeners.forEach((f) => f(true));
});
addEventListener('appinstalled', () => {
  installOffer = null;
  installListeners.forEach((f) => f(false));
});

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
  // The browser's own frame in the page's color (where it paints one).
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = dark ? '#221A15' : '#F3EBDD';
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

/** Open in another tab: the Novelo works in one tab at a time (nothing organized twice). */
function OtherTab({ t, onUse }) {
  return (
    <div className="center"><div className="phone"><Yarn size={60} /><h1>{t('otherTab')}</h1><p className="lead">{t('otherTabHint')}</p><button type="button" className="big-btn" onClick={onUse}>{t('useHere')}</button></div></div>
  );
}

const ACTIVE = 'novelo-web-active';

/**
 * [run] in this tab only while no other tab of the page runs it (Web Locks): another tab shows "Usar
 * aqui", which takes it over — and the tab that had it starts again, now showing the same.
 */
function exclusive(run, t) {
  if (!navigator.locks?.request) return run();
  const hold = (opts) => navigator.locks.request(ACTIVE, opts, async (held) => {
    if (!held) return 'busy';
    await run();
    return new Promise(() => {}); // kept while this tab lives
  });
  const watch = (p) => p.then(
    (r) => { if (r === 'busy') root.render(<OtherTab t={t} onUse={() => watch(hold({ steal: true }))} />); },
    () => location.reload(), // taken by another tab
  );
  watch(hold({ ifAvailable: true }));
  return undefined;
}

function Unlinked({ t }) {
  return (
    <div className="center"><div className="phone"><Yarn size={60} /><h1>{t('unlinked')}</h1><button type="button" className="big-btn" onClick={() => location.reload()}>{t('linkNew')}</button></div></div>
  );
}

async function start() {
  prefs = prefsSaved();
  look(prefs);
  grain().catch(() => {});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { look(prefs); grain().catch(() => {}); });
  const lang = pickLang(prefs.lang);
  const t = strings(lang);
  // A friend's invite (app 1.84): it is opened by the app; here, only where to get it.
  if (location.pathname.replace(/\/+$/, '') === '/web/amigo') {
    root.render(<FriendPage t={t} />);
    return;
  }
  if (isPhone()) {
    root.render(<PhonePage t={t} />);
    return;
  }
  const store = await new Store().open();
  const keys = await store.get('keys');
  const token = await store.get('token');
  const proof = await store.get('proof');
  if (!keys || !token || !proof) {
    // Nothing (or only part of it) here: nothing of a link stays half kept.
    if (keys || token || proof) await store.wipe().then(() => store.open());
    const api = new Api();
    root.render(<LinkPage api={api} t={t} onLinked={async ({ token: tok, proof: signer, space, key, owner, shared }) => {
      // The space's key becomes keys that can't be taken out of this browser; the bytes go.
      const k = await lock.spaceKeys(key);
      key.fill(0);
      // Someone else's computer: all of it only in this tab's memory, and unlinked when it closes.
      const where = shared ? new MemoryStore() : store;
      await where.set('keys', k);
      await where.set('proof', signer);
      await where.set('token', tok);
      await where.set('space', space);
      await where.set('owner', owner);
      await where.set('cursor', 0);
      if (shared) return linked({ store: where, keys: k, token: tok, proof: signer, shared: true, t, lang });
      location.reload();
      return undefined;
    }} />);
    return;
  }
  // Read again when this tab becomes the one that works (another may have unlinked meanwhile).
  store.close();
  exclusive(async () => {
    const s2 = await new Store().open();
    const [k2, tok2, proof2] = [await s2.get('keys'), await s2.get('token'), await s2.get('proof')];
    if (!k2 || !tok2 || !proof2) return location.reload();
    return linked({ store: s2, keys: k2, token: tok2, proof: proof2, shared: false, t, lang });
  }, t);
}

/** Linked: the space opened here, kept in step with the phone, and the page. */
async function linked({ store, keys, token, proof, shared, t, lang }) {
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
    for (const u of sync.urls.values()) URL.revokeObjectURL(u);
    root.render(<Unlinked t={t} />);
  };
  let tabs = null;
  // The tabs of this browser's own link hear each other (a tab of someone else's computer is another
  // link, only in its own memory: it isn't theirs to let go of).
  if (!shared) {
    try {
      tabs = new BroadcastChannel('novelo-web');
      tabs.onmessage = (e) => { if (e.data === 'unlinked') unlink(false); };
    } catch { /* an old browser: each tab finds out by itself (the server says 401) */ }
  }
  const api = new Api({ token, proof, onUnlinked: () => unlink(false) });
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
  if (shared) {
    // Closing (or reloading) the tab unlinks this computer: the request goes even as the tab closes
    // (keepalive), signed ahead of time (a signature is good for two minutes: made again each minute).
    let farewell = null;
    const sign = async () => { farewell = await api.sign('DELETE', '/v1/link').catch(() => farewell); };
    await sign();
    setInterval(sign, 60_000);
    addEventListener('pagehide', () => {
      if (unlinked || !farewell) return;
      fetch('/v1/link', { method: 'DELETE', keepalive: true, credentials: 'omit', headers: { Authorization: `Bearer ${token}`, 'X-Novelo-Sig': farewell } }).catch(() => {});
    });
    // And the server lets it go by itself if that request never arrives.
    api.call('POST', '/v1/link/shared').catch(() => {});
  }

  const app = {
    data, sync, mind, library, zone, lang, t, api, localFiles, shared,
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
    canInstall: () => !!installOffer && !shared,
    onInstall: (f) => { installListeners.add(f); return () => installListeners.delete(f); },
    install: async () => {
      if (!installOffer) return;
      await installOffer.prompt();
      installOffer = null;
      installListeners.forEach((f) => f(false));
    },
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

