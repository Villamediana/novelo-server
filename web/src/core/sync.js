// Keeping the page and the phone in step — the page's side of sync/SyncEngine.kt: news from the
// server into the data (a change made here meanwhile merged field by field), what changed here up
// (a write refused because something newer is there merged and sent again), files up and down.
import * as lock from './crypto.js';
import { SCHEMA, TABLES, ridOf } from './data.js';

/** Three ways, as the phone does: changed only here stays, only there comes, on both — the one changed last. */
export function merge(base, local, remote) {
  const newer = (local.updatedAt ?? 0) > (remote.updatedAt ?? 0);
  const out = {};
  const keys = [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort();
  for (const k of keys) {
    const l = local[k];
    const r = remote[k];
    const b = base ? base[k] : undefined;
    if (eq(l, r)) out[k] = l ?? null;
    else if (base && eq(l, b)) out[k] = r ?? null;
    else if (base && eq(r, b)) out[k] = l ?? null;
    else out[k] = newer ? l ?? null : r ?? null;
  }
  return out;
}

function eq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

export function sameRow(a, b) {
  if (!a || !b) return a === b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!eq(a[k], b[k])) return false;
  return true;
}

export class WebSync {
  constructor({ api, keys, data, store, onStatus = () => {} }) {
    Object.assign(this, { api, keys, data, store, onStatus });
    this.state = new Map(); // k → {k, t, rid, s, base}
    this.byRow = new Map(); // "t|rid" → k
    this.cursor = 0;
    this.running = false;
    this.pushing = null;
    this.status = { online: true, lastAt: 0, busy: false, error: null };
    this.urls = new Map(); // blob id → object URL
  }

  async keyOf(t, rid) {
    const row = `${t}|${rid}`;
    let k = this.byRow.get(row);
    if (!k) {
      k = await lock.recordKey(this.keys, t, rid);
      this.byRow.set(row, k);
    }
    return k;
  }

  setStatus(s) {
    this.status = { ...this.status, ...s };
    this.onStatus(this.status);
  }

  // ------------------------------------------------------------------ what is kept here

  /** Back from the browser: the records as they were, the changes not yet up still marked. */
  async load() {
    this.cursor = (await this.store.get('cursor')) ?? 0;
    const rows = await this.store.records();
    // Opened first (sealed with the space's key; one that doesn't open is left), put in all at once.
    const opened = [];
    for (const r of rows) {
      try {
        const v = JSON.parse(new TextDecoder().decode(await lock.openBlob(this.keys, `rec:${r.k}`, r.data)));
        if (v && Object.hasOwn(SCHEMA, r.t) && (v.row === null || (typeof v.row === 'object' && !Array.isArray(v.row)))) opened.push([r, v]);
      } catch { /* not this key's */ }
    }
    this.data.batch(() => {
      for (const [r, v] of opened) {
        this.state.set(r.k, { k: r.k, t: r.t, rid: r.rid, s: r.s, base: v.base ?? null, gone: v.gone === true });
        this.byRow.set(`${r.t}|${r.rid}`, r.k);
        if (v.row) this.data.put(r.t, r.rid, v.row);
        if (r.dirty) this.data.dirty.set(`${r.t}|${r.rid}`, true);
        if (r.held) this.data.held.add(`${r.t}|${r.rid}`);
      }
    });
    for (const f of await this.store.pendingFiles()) this.waitingFiles.add(f.id);
  }

  /** The records named, as they are now, kept in the browser (sealed). */
  async keep(rows) {
    const out = [];
    for (const [t, rid] of rows) {
      const k = await this.keyOf(t, rid);
      const st = this.state.get(k);
      const row = this.data.tables[t].get(rid) ?? null;
      const dirty = this.data.dirty.has(`${t}|${rid}`);
      if (!row && !st) {
        out.push({ k, remove: true });
        continue;
      }
      // A row gone (known so at its number) is kept as gone: the same row made again goes over it.
      // A row deleted here and not yet up is not gone yet: it still has to go.
      const plain = new TextEncoder().encode(JSON.stringify({ row, base: st?.base ?? null, gone: !row && !!st?.gone }));
      const sealed = await lock.sealBlob(this.keys, `rec:${k}`, plain);
      out.push({ k, t, rid, s: st?.s ?? 0, dirty, held: this.data.held.has(`${t}|${rid}`), data: sealed });
    }
    await this.store.putRecords(out);
  }

  /** What changed here, kept in the browser at once (a tab closed before it went up loses nothing), then sent. */
  async saveLocal() {
    const rows = [...this.data.changed].map((k) => k.split('|'));
    this.data.changed.clear();
    if (rows.length) await this.keep(rows);
    return this.push().catch(() => {});
  }

  /** What she was writing and didn't send yet: sealed with the space's key, kept here. */
  async saveDraft(text) {
    await this.store.set('draft', text ? await lock.sealBlob(this.keys, 'draft', new TextEncoder().encode(text)) : null);
  }

  async loadDraft() {
    const d = await this.store.get('draft');
    if (!d) return '';
    try {
      return new TextDecoder().decode(await lock.openBlob(this.keys, 'draft', d));
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------------ news from the server

  async pull(wait = 0, signal) {
    let first = true;
    for (;;) {
      const since = this.cursor;
      const res = await this.api.changes(since, first ? wait : 0, signal);
      first = false;
      if (this.cursor !== since) return; // another pull took these already
      const touched = [];
      for (const c of res.changes) {
        const st = this.state.get(c.k);
        if (c.d === null) {
          // One already known (this page's own deletion coming back, or one seen before): the row may
          // have been made again here since, and goes up over it.
          if (st && (st.gone || st.s >= c.s)) {
            if (st.s < c.s) st.s = c.s;
            continue;
          }
          if (st) {
            this.data.put(st.t, st.rid, null);
            this.data.dirty.delete(`${st.t}|${st.rid}`);
            this.state.set(c.k, { ...st, s: c.s, base: null, gone: true });
            touched.push([st.t, st.rid]);
          }
          continue;
        }
        if (st && st.s >= c.s) continue;
        let rec;
        try {
          rec = await lock.open(this.keys, c.k, c.d);
        } catch {
          continue; // not this space's key
        }
        if (!rec || !Object.hasOwn(SCHEMA, rec.t) || typeof rec.id !== 'string' || !rec.r || typeof rec.r !== 'object' || Array.isArray(rec.r)) continue;
        const remote = clean(rec.t, rec.r);
        // The record is the row it says it is: its name is that row's, and the row's own id is that one
        // (otherwise it could land on another row, or two records fight over one).
        if (ridOf(rec.t, remote) !== rec.id || (await this.keyOf(rec.t, rec.id)) !== c.k) continue;
        const key = `${rec.t}|${rec.id}`;
        const local = this.data.tables[rec.t].get(rec.id);
        if (local && this.data.dirty.has(key)) {
          const merged = merge(st?.base ?? null, local, remote);
          this.data.put(rec.t, rec.id, merged);
          if (sameRow(merged, remote)) this.data.dirty.delete(key);
        } else {
          this.data.put(rec.t, rec.id, remote);
          this.data.dirty.delete(key);
        }
        this.state.set(c.k, { k: c.k, t: rec.t, rid: rec.id, s: c.s, base: remote, gone: false });
        touched.push([rec.t, rec.id]);
      }
      this.cursor = res.seq;
      if (touched.length) this.data.notify();
      await this.keep(touched);
      await this.store.set('cursor', this.cursor);
      if (!res.more) return;
    }
  }

  // ------------------------------------------------------------------ what changed here

  push() {
    if (!this.pushing) this.pushing = this.pushNow().finally(() => { this.pushing = null; });
    return this.pushing;
  }

  async pushNow() {
    for (let round = 0; round < 4; round++) {
      await this.sendFiles();
      const out = [];
      for (const key of [...this.data.dirty.keys()]) {
        if (this.data.held.has(key)) continue;
        const [t, rid] = key.split('|');
        const row = this.data.tables[t].get(rid) ?? null;
        const k = await this.keyOf(t, rid);
        const st = this.state.get(k);
        if (!row && (!st || st.gone)) {
          this.data.dirty.delete(key);
          continue;
        }
        // A file not up yet: the record waits for it (the phone would look for it and not find it).
        if (row && t === 'captures' && this.waitingFiles.size && Object.values(row.media ?? {}).some((m) => this.waitingFiles.has(m?.id))) continue;
        out.push({ t, rid, k, row, item: { k, base: st?.s ?? 0, d: row ? await lock.seal(this.keys, k, { t, id: rid, r: row }) : null } });
      }
      if (!out.length) return;
      let refused = false;
      const touched = [];
      for (let i = 0; i < out.length; i += 200) {
        const chunk = out.slice(i, i + 200);
        const res = await this.api.push(chunk.map((o) => o.item));
        const byK = new Map(res.results.map((r) => [r.k, r]));
        for (const o of chunk) {
          const r = byK.get(o.k);
          if (!r) continue;
          const key = `${o.t}|${o.rid}`;
          touched.push([o.t, o.rid]);
          if (r.ok) {
            this.state.set(o.k, { k: o.k, t: o.t, rid: o.rid, s: r.s, base: o.row ?? null, gone: !o.row });
            // Changed again while it went: still to go.
            if (sameRow(this.data.tables[o.t].get(o.rid) ?? null, o.row)) this.data.dirty.delete(key);
            continue;
          }
          refused = true;
          const st = this.state.get(o.k);
          if (r.d === null) {
            if (o.row && (!st || st.gone)) {
              // Gone there, and here a row made again after that (brought back with "Desfazer", a dose
              // ticked again): it goes up over the gap, next round.
              this.state.set(o.k, { k: o.k, t: o.t, rid: o.rid, s: r.s, base: null, gone: true });
              continue;
            }
            // Deleted there while changed here: here too (deleting wins over changing).
            this.data.put(o.t, o.rid, null);
            this.data.dirty.delete(key);
            this.state.set(o.k, { k: o.k, t: o.t, rid: o.rid, s: r.s, base: null, gone: true });
            continue;
          }
          if (!o.row) {
            // Deleted here, changed there: the deletion goes again over what is there.
            this.state.set(o.k, { k: o.k, t: o.t, rid: o.rid, s: r.s, base: null, gone: false });
            continue;
          }
          let rec;
          try {
            rec = await lock.open(this.keys, o.k, r.d);
          } catch {
            continue;
          }
          if (!rec || rec.t !== o.t || rec.id !== o.rid || !rec.r || typeof rec.r !== 'object' || Array.isArray(rec.r)) continue;
          const remote = clean(o.t, rec.r);
          if (ridOf(o.t, remote) !== o.rid) continue;
          const merged = merge(this.state.get(o.k)?.base ?? null, o.row, remote);
          this.data.put(o.t, o.rid, merged);
          this.state.set(o.k, { k: o.k, t: o.t, rid: o.rid, s: r.s, base: remote, gone: false });
          if (sameRow(merged, remote)) this.data.dirty.delete(key);
        }
      }
      this.data.notify();
      await this.keep(touched);
      if (!refused) return;
    }
  }

  // ------------------------------------------------------------------ files

  get waitingFiles() {
    return this._waiting ?? (this._waiting = new Set());
  }

  /** A file made here (a photo, a document she attached): sealed, kept until it is up. */
  async addFile(id, bytes) {
    const sealed = await lock.sealBlob(this.keys, id, bytes);
    await this.store.putFile({ id, data: sealed });
    this.waitingFiles.add(id);
    this.urls.set(id, URL.createObjectURL(new Blob([bytes])));
  }

  async sendFiles() {
    const list = await this.store.pendingFiles();
    for (const f of list) {
      this.waitingFiles.add(f.id);
      await this.api.putBlob(f.id, f.data);
      await this.store.dropFile(f.id);
      this.waitingFiles.delete(f.id);
    }
  }

  /** A file to show (photo, sound, document): fetched, opened here, an address for the page. */
  async url(id, mime = 'application/octet-stream') {
    if (!id) return null;
    const have = this.urls.get(id);
    if (have) {
      // The most recently used last (the oldest go first, below).
      this.urls.delete(id);
      this.urls.set(id, have);
      return have;
    }
    const sealed = await this.api.getBlob(id).catch(() => null);
    if (!sealed) return null;
    const bytes = await lock.openBlob(this.keys, id, sealed);
    const u = URL.createObjectURL(new Blob([bytes], { type: safeType(mime) }));
    this.urls.set(id, u);
    // At most so many opened at once (a long visit to the Galeria): the oldest are let go — what is
    // still on the screen stays drawn, and is opened again if it is needed again.
    for (const [old, ou] of this.urls) {
      if (this.urls.size <= MAX_URLS) break;
      if (this.waitingFiles.has(old)) continue;
      this.urls.delete(old);
      URL.revokeObjectURL(ou);
    }
    return u;
  }

  async bytes(id) {
    const sealed = await this.api.getBlob(id).catch(() => null);
    return sealed ? lock.openBlob(this.keys, id, sealed) : null;
  }

  // ------------------------------------------------------------------ keeping it going

  /** News waited for on the server, what changed here sent; again and again while the page is open. */
  async run(signal) {
    if (this.running) return;
    this.running = true;
    let failures = 0;
    try {
      while (!signal?.aborted) {
        try {
          this.setStatus({ busy: true });
          await this.push();
          await this.pull(0, signal);
          this.setStatus({ busy: false, online: true, lastAt: Date.now(), error: null });
          failures = 0;
          await this.pull(25, signal);
        } catch (e) {
          if (e?.name === 'AbortError') return;
          failures++;
          this.setStatus({ busy: false, online: e?.status !== 0, error: e?.code ?? e?.message ?? 'erro' });
          if (e?.status === 401) return;
          await sleep(Math.min(2000 * failures, 30_000), signal);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

const BLOB_ID = /^[A-Za-z0-9_-]{22,64}$/;
const MAX_URLS = 300;
const KINDS = ['image', 'thumb', 'audio', 'file'];

/** A capture's files as they may be: {image|thumb|audio|file: {id, size, mime}}, each checked; null when none. */
export function cleanMedia(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const kind of KINDS) {
    const f = Object.hasOwn(v, kind) ? v[kind] : null;
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !BLOB_ID.test(f.id)) continue;
    out[kind] = { id: f.id, size: Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : 0, ...(typeof f.mime === 'string' && f.mime.length <= 100 ? { mime: f.mime } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

/** Only the columns of the table (and a capture's files), nothing else from the record. */
export function clean(t, r) {
  const cols = SCHEMA[t].defaults;
  const out = Object.create(null);
  for (const k of Object.keys(r)) {
    if (!Object.hasOwn(cols, k)) continue;
    const v = r[k];
    // Values only of the kinds a row has (text, number, null), text of a sane size.
    if (typeof v === 'string') out[k] = v.length > 400_000 ? v.slice(0, 400_000) : v;
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : 0;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = null;
    // The row's own keys are numbers.
    if (SCHEMA[t].pk.includes(k) && !Number.isSafeInteger(out[k])) out[k] = typeof out[k] === 'string' && /^-?\d{1,16}$/.test(out[k]) ? Number(out[k]) : NaN;
  }
  const row = { ...cols, ...out };
  if (t === 'captures') {
    const media = cleanMedia(r.media);
    if (media) row.media = media;
  }
  return row;
}

const SAFE = /^(image\/(jpeg|png|webp|gif|heic|heif)|audio\/[a-z0-9.+-]+|video\/(mp4|webm)|application\/pdf|text\/plain)$/i;

/** A file opened in the page is only ever shown as what is safe to show (never as a page: no HTML, no SVG). */
export function safeType(mime) {
  return SAFE.test(String(mime ?? '')) ? mime : 'application/octet-stream';
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export { TABLES };
