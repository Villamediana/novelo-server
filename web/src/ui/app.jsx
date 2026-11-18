// The page's frame: the rail (Escrever, Hoje, Tarefas…, Ajustes), the tab open, an item or a medicine
// open beside it, the photo viewer, the "Desfazer" note — and Ajustes.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { todayCount } from '../core/sections.js';
import { Icon, IconBtn, Yarn, useApp, useData, useLeave } from './kit.jsx';
import { WritePage } from './write.jsx';
import { TodayTab, TasksTab, NotesTab, DiaryTab, GalleryTab, SearchTab } from './lists.jsx';
import { MedsTab, MedPanel } from './meds.jsx';
import { EntryPanel } from './entry.jsx';
import { LANGS } from './i18n.js';

const TABS = [
  ['write', 'write'], ['today', 'today'], ['tasks', 'tasks'], ['notes', 'notes'], ['diary', 'diary'], ['meds', 'meds'], ['gallery', 'gallery'],
];
const ACCENTS = [['vermilion', '#C2593A'], ['pink', '#B84F6A'], ['graphite', '#A86A30'], ['green', '#6F7D45'], ['blue', '#5671A0'], ['teal', '#4C7F77'], ['purple', '#84587F']];

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [tab] = h.split('/');
  return TABS.some(([k]) => k === tab) || tab === 'search' ? tab : 'write';
}

function Viewer({ ids, at, onClose }) {
  const app = useApp();
  const data = useData();
  const [leaving, leave] = useLeave(onClose, 170);
  const [i, setI] = useState(Math.max(ids.indexOf(at), 0));
  const c = data.capture(ids[i]);
  const media = c?.media?.image ?? c?.media?.thumb;
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (media) app.sync.url(media.id, media.mime ?? 'image/jpeg').then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [media?.id]);
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') leave();
      if (e.key === 'ArrowRight') setI((x) => Math.min(x + 1, ids.length - 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(x - 1, 0));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [ids.length]);
  if (!c) return null;
  return (
    <div className={`viewer${leaving ? ' leaving' : ''}`} onClick={leave} role="dialog" aria-label={app.t('photo')}>
      <div className="cap">{c.description ?? ''}</div>
      {url ? <img key={url} src={url} alt={c.description ?? ''} style={{ transform: `rotate(${c.turn ?? 0}deg)` }} onClick={(e) => e.stopPropagation()} /> : <p className="faint">{media ? '…' : app.t('photoOnPhone')}</p>}
      <div className="bar2" onClick={(e) => e.stopPropagation()}>
        <IconBtn icon="turn" label={app.t('turn')} onClick={() => app.library.turnPhoto(c.id)} />
        <IconBtn icon="trash" label={app.t('remove')} onClick={() => { app.library.removePhoto(c.id); leave(); }} />
        <IconBtn icon="close" label={app.t('close')} onClick={leave} />
      </div>
    </div>
  );
}

function Settings({ onClose: done }) {
  const app = useApp();
  const { t } = app;
  const [leaving, onClose] = useLeave(done);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const [sure, setSure] = useState(false);
  const [canInstall, setCanInstall] = useState(app.canInstall?.() ?? false);
  useEffect(() => app.onInstall?.((v) => setCanInstall(v && app.canInstall())), []);
  const [prefs, setPrefs] = useState(app.prefs);
  const set = (patch) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    app.setPrefs(next);
  };
  return (
    <>
      <div className={`scrim${leaving ? ' leaving' : ''}`} onClick={onClose} />
      <aside className={`panel${leaving ? ' leaving' : ''}`} aria-label={t('settings')}>
        <div className="panel-top"><IconBtn icon="close" label={t('close')} onClick={onClose} /><div className="grow" /></div>
        <h2 className="h1">{t('settings')}</h2>
        <div className="set">
          <div className="section" style={{ margin: '18px 0 4px' }}>{t('theme')}</div>
          <div className="pills">
            {[['system', 'themeSystem'], ['light', 'themeLight'], ['dark', 'themeDark']].map(([k, label]) => <button key={k} type="button" className={`pill${prefs.mode === k ? ' on' : ''}`} onClick={() => set({ mode: k })}>{t(label)}</button>)}
          </div>
          <div className="section" style={{ margin: '18px 0 4px' }}>{t('accent')}</div>
          <div className="swatches">
            {ACCENTS.map(([k, c]) => <button key={k} type="button" aria-label={k} className={`swatch${prefs.accent === k ? ' on' : ''}`} style={{ background: c }} onClick={() => set({ accent: k })} />)}
          </div>
          <div className="section" style={{ margin: '18px 0 4px' }}>{t('language')}</div>
          <div className="pills">
            {Object.entries(LANGS).map(([k, label]) => <button key={k} type="button" className={`pill${app.lang === k ? ' on' : ''}`} onClick={() => set({ lang: k })}>{label}</button>)}
          </div>
          {canInstall ? (
            <>
              <div className="section" style={{ margin: '18px 0 4px' }}>{t('install')}</div>
              <button type="button" className="pill on" style={{ alignSelf: 'flex-start' }} onClick={() => app.install()}><Icon name="plus" size={16} /> {t('install')}</button>
              <p className="note" style={{ marginTop: 0 }}>{t('installHint')}</p>
            </>
          ) : null}
          <div className="section" style={{ margin: '28px 0 4px' }}>{app.owner ? t('linkedTo', { p: app.owner }) : ''}</div>
          <button type="button" className={`pill${sure ? ' on' : ''}`} style={{ alignSelf: 'flex-start' }} onClick={() => (sure ? app.unlink() : setSure(true))}>
            <Icon name="close" size={16} /> {sure ? t('unlinkSure') : t('unlink')}
          </button>
          <p className="note">{t('unlinkHint')}</p>
        </div>
      </aside>
    </>
  );
}

export function App() {
  const app = useApp();
  const data = useData();
  const { t, zone } = app;
  const [tab, setTab] = useState(route);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null); // {id, fresh}
  const [med, setMed] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [toast, setToast] = useState(null);
  const [settings, setSettings] = useState(false);
  const [sync, setSync] = useState(app.sync.status);
  const rail = useRef(null);
  const main = useRef(null);
  const search = useRef(null);
  const [glow, setGlow] = useState({ opacity: 0 });
  useEffect(() => app.onSync(setSync), []);
  // The bar behind the open tab: moved to it (without motion the first time, and when the window changes).
  const placed = useRef(false);
  useLayoutEffect(() => {
    const place = (still) => {
      const on = rail.current?.querySelector('.nav.on:not(.cta)');
      if (!on || !on.offsetParent || getComputedStyle(on).display === 'none') return setGlow((g) => ({ ...g, opacity: 0 }));
      setGlow({ opacity: 1, transform: `translateY(${on.offsetTop}px)`, height: on.offsetHeight, left: on.offsetLeft, width: on.offsetWidth, right: 'auto', ...(still ? { transition: 'none' } : {}) });
    };
    place(!placed.current);
    placed.current = true;
    const again = () => place(true);
    window.addEventListener('resize', again);
    return () => window.removeEventListener('resize', again);
  }, [tab]);
  // The window's title says where she is; a new tab starts at its top.
  useEffect(() => {
    document.title = tab === 'write' ? 'Novelo' : `${t(tab)} · Novelo`;
    main.current?.scrollTo({ top: 0 });
  }, [tab]);
  // The keys: "/" or Ctrl/⌘ K searches, Alt 1–7 opens a tab.
  useEffect(() => {
    const key = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') || document.activeElement?.isContentEditable;
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
        e.preventDefault();
        if (route() === 'write') go('search');
        setTimeout(() => search.current?.focus(), 30);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-7]$/.test(e.key)) {
        e.preventDefault();
        go(TABS[Number(e.key) - 1][0]);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    const f = () => setTab(route());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  useEffect(() => {
    app.open = (id, fresh = false) => setOpen({ id, fresh });
    app.openMed = (id, fresh = false) => setMed({ id, fresh });
    app.view = (at, ids) => setViewer({ at, ids });
    app.toast = (text, undo) => {
      const at = Date.now();
      setToast({ text, undo, at });
      setTimeout(() => setToast((x) => (x && x.at === at ? { ...x, leaving: true } : x)), 5700);
      setTimeout(() => setToast((x) => (x && x.at === at ? null : x)), 5950);
    };
  });
  const go = (k) => { location.hash = `#/${k}`; setTab(k); };
  const count = todayCount(data.entries(), zone);
  const syncClass = sync.busy ? 'busy' : !sync.online ? 'off' : '';
  const syncWord = sync.busy ? t('syncBusy') : !sync.online ? t('syncOff') : sync.error ? t('syncErr') : t('syncOk');
  return (
    <div className="app">
      <nav className="rail" aria-label="Novelo" ref={rail}>
        <div className="nav-glow" style={glow} aria-hidden="true" />
        <div className="brand"><Yarn size={28} /><span>Novelo</span></div>
        {TABS.map(([k, icon], i) => (
          <button key={k} type="button" className={`nav${tab === k ? ' on' : ''}${k === 'write' ? ' cta' : ''}`} onClick={() => go(k)} aria-current={tab === k ? 'page' : undefined} title={`${t(k)} · Alt ${i + 1}`}>
            <Icon name={icon} /><span>{t(k)}</span>{k === 'today' && count > 0 ? <span className="count" key={count}>{count}</span> : null}
          </button>
        ))}
        <div className="rail-foot">
          <button type="button" className={`nav${settings ? ' on' : ''}`} onClick={() => setSettings(true)} title={t('settings')}><Icon name="tune" /><span>{t('settings')}</span></button>
          <div className={`sync ${syncClass}`} title={sync.error ?? ''}><i /><span>{syncWord}</span></div>
          {app.shared ? <div className="shared-note">{t('sharedBadge')}</div> : null}
        </div>
      </nav>
      <main className="main" ref={main}>
        <div className="page" key={tab}>
          {tab !== 'write' ? (
            <div className="top">
              <label className="search">
                <Icon name="search" size={20} />
                <input ref={search} type="search" placeholder={t('search')} value={query} onChange={(e) => { setQuery(e.target.value); if (e.target.value && tab !== 'search') go('search'); }} onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} aria-label={t('search')} />
                {query ? null : <kbd>/</kbd>}
              </label>
            </div>
          ) : null}
          {tab !== 'write' && tab !== 'search' ? <h1 className="h1">{t(tab)}</h1> : null}
          {tab === 'write' ? <WritePage /> : null}
          {tab === 'today' ? <TodayTab /> : null}
          {tab === 'tasks' ? <TasksTab /> : null}
          {tab === 'notes' ? <NotesTab /> : null}
          {tab === 'diary' ? <DiaryTab /> : null}
          {tab === 'meds' ? <MedsTab /> : null}
          {tab === 'gallery' ? <GalleryTab /> : null}
          {tab === 'search' ? <SearchTab query={query} /> : null}
        </div>
      </main>
      {open ? <EntryPanel key={open.id} id={open.id} fresh={open.fresh} onClose={() => setOpen(null)} /> : null}
      {med ? <MedPanel key={med.id} id={med.id} fresh={med.fresh} onClose={() => setMed(null)} /> : null}
      {viewer ? <Viewer ids={viewer.ids} at={viewer.at} onClose={() => setViewer(null)} /> : null}
      {settings ? <Settings onClose={() => setSettings(false)} /> : null}
      {toast ? (
        <div className={`toast${toast.leaving ? ' leaving' : ''}`} role="status">
          {toast.text}
          {toast.undo ? <button type="button" onClick={() => { toast.undo(); setToast(null); }}>{t('undo')}</button> : null}
        </div>
      ) : null}
    </div>
  );
}
