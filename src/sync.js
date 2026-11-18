// The Novelo on the computer (Novelo Web), and the phone it is tied to. Everything the phone keeps
// (tasks, notes, the diary, medicines, photos, files) goes here as records and files *encrypted on the
// phone*, with a key only the phone and the computers it linked have: this server keeps bytes it
// cannot read, and hands them to whoever of them asks. See docs/WEB.md.
//
// - A space: one per phone (its install), with the records' change counter. `key_check` says which
//   key the bytes are in, without being it: a phone that lost its key (reinstalled) starts the space over.
// - Records: (space, key) → bytes. The key is an HMAC of what the record is, the bytes are AES-GCM: the
//   server sees neither what nor whose. Each write takes the next number of the space (`seq`); a
//   write says the number it saw (`base`) and is refused when someone wrote after it (the writer merges
//   and tries again). Deleting leaves the key with no bytes, so the others know it went.
// - Files (photos, sounds, documents): encrypted the same way, on disk, under the space.
// - Links: the computer shows a QR code with its public key; the phone reads it and sends the space's
//   key to the computer, encrypted to that key (the server only carries it); the computer gets a
//   token for this server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.js';

export const SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS spaces(
  id TEXT PRIMARY KEY,
  install TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  key_check TEXT NOT NULL,
  created INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  blob_bytes INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS records(
  space TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data BLOB,
  PRIMARY KEY(space, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS records_seq ON records(space, seq);

CREATE TABLE IF NOT EXISTS blobs(
  space TEXT NOT NULL,
  id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(space, id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS links(
  id TEXT PRIMARY KEY,
  space TEXT,
  web_key TEXT NOT NULL,
  poll_hash TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  wrapped TEXT,
  name TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  proof_key TEXT,
  shared INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS links_space ON links(space);
`;

const ID = /^[A-Za-z0-9_-]{22,64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;
const MINUTE = 60_000;
const PAGE_BYTES = 4 * 1024 * 1024;
// How far a computer's clock may be from the server's (and how long a nonce is remembered: twice this).
const PROOF_WINDOW = 2 * MINUTE;

/** A P-256 public key (raw, 65 bytes, base64url) as a key to verify with; null when it isn't one. */
function proofKey(raw) {
  try {
    const b = Buffer.from(raw, 'base64url');
    if (b.length !== 65 || b[0] !== 4) return null;
    return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b.subarray(1, 33).toString('base64url'), y: b.subarray(33).toString('base64url') }, format: 'jwk' });
  } catch {
    return null;
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// A name shown to someone (the computer's on the phone, the phone's on the computer): no control
// characters and none that turn text around (a name that reads as another one).
const shown = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').trim().slice(0, max);
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const bad = (message) => new HttpError(422, 'bad_request', message);

export class Sync {
  constructor({ db, config, dataDir, now = Date.now }) {
    this.db = db;
    this.now = now;
    db.exec(SYNC_SCHEMA);
    // Columns added after the table was first made.
    const cols = new Set(db.prepare('PRAGMA table_info(links)').all().map((c) => c.name));
    if (!cols.has('proof_key')) db.exec('ALTER TABLE links ADD COLUMN proof_key TEXT');
    if (!cols.has('shared')) db.exec('ALTER TABLE links ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
    this.dir = path.join(dataDir, 'sync');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // What one space may hold: the records (text) and the files (photos, sounds, documents).
    this.maxRecords = config.int('SYNC_RECORDS_MB', 256) * 1024 * 1024;
    this.maxBlobs = config.int('SYNC_FILES_MB', 8192) * 1024 * 1024;
    this.maxBlob = config.int('SYNC_FILE_MB', 40) * 1024 * 1024;
    this.maxRecord = 512 * 1024;
    // A link not read by the phone in this long is gone; computers linked to one phone, at most.
    this.linkTtl = 10 * MINUTE;
    this.maxLinks = 10;
    // Codes waiting to be read, from everyone at once (each address may make 30 a minute).
    this.maxPending = config.int('SYNC_PENDING_LINKS', 5000);
    // A computer not seen in this many days is unlinked (it has to read a new code).
    this.idleMs = config.int('SYNC_IDLE_DAYS', 90) * 24 * 3600_000;
    // A computer that isn't hers (not kept linked): unlinked when its tab closes — or, if that word
    // never comes, after this long without a sign of it.
    this.sharedIdleMs = config.int('SYNC_SHARED_IDLE_MIN', 30) * MINUTE;
    // The disk is never filled up: below this much free, nothing more is kept.
    this.minFree = config.int('SYNC_MIN_FREE_MB', 2048) * 1024 * 1024;
    // Long waits (news, a code being read) open at once: per space, per code and in all.
    this.maxWaitsPerSpace = 12;
    this.maxWaits = config.int('SYNC_MAX_WAITS', 4000);
    this.waits = 0;
    this.proofKeys = new Map(); // link → its public key (KeyObject)
    this.nonces = new Map(); // link → Map(nonce → when): each signed request is taken once
    this.waiters = new Map(); // space → Set<() => void>
    this.polls = new Map(); // link id → Set<() => void>
    this.calls = new Map(); // space or ip → { start, n }
    this.q = {
      spaceByInstall: db.prepare('SELECT * FROM spaces WHERE install = ?'),
      space: db.prepare('SELECT * FROM spaces WHERE id = ?'),
      newSpace: db.prepare('INSERT INTO spaces(id, install, device, key_check, created, last_seen) VALUES(?,?,?,?,?,?)'),
      touch: db.prepare('UPDATE spaces SET device = ?, last_seen = ? WHERE id = ?'),
      changes: db.prepare('SELECT key, seq, data FROM records WHERE space = ? AND seq > ? ORDER BY seq LIMIT ?'),
      record: db.prepare('SELECT seq, data FROM records WHERE space = ? AND key = ?'),
      put: db.prepare('INSERT INTO records(space, key, seq, data) VALUES(?,?,?,?) ON CONFLICT(space, key) DO UPDATE SET seq = excluded.seq, data = excluded.data'),
      bump: db.prepare('UPDATE spaces SET seq = ?, bytes = ? WHERE id = ?'),
      blob: db.prepare('SELECT size FROM blobs WHERE space = ? AND id = ?'),
      newBlob: db.prepare('INSERT INTO blobs(space, id, size, created) VALUES(?,?,?,?) ON CONFLICT(space, id) DO UPDATE SET size = excluded.size'),
      blobs: db.prepare('SELECT id, size, created FROM blobs WHERE space = ?'),
      dropBlob: db.prepare('DELETE FROM blobs WHERE space = ? AND id = ?'),
      blobBytes: db.prepare('UPDATE spaces SET blob_bytes = (SELECT COALESCE(SUM(size), 0) FROM blobs WHERE space = ?) WHERE id = ?'),
      link: db.prepare('SELECT * FROM links WHERE id = ?'),
      linkByToken: db.prepare('SELECT * FROM links WHERE token_hash = ?'),
      newLink: db.prepare('INSERT INTO links(id, web_key, poll_hash, name, ip, created, proof_key) VALUES(?,?,?,?,?,?,?)'),
      approve: db.prepare('UPDATE links SET space = ?, token_hash = ?, wrapped = ?, approved = ?, last_seen = ? WHERE id = ? AND approved = 0'),
      delivered: db.prepare('UPDATE links SET wrapped = NULL WHERE id = ?'),
      linkSeen: db.prepare('UPDATE links SET last_seen = ? WHERE id = ?'),
      linksOf: db.prepare('SELECT id, name, created, last_seen, shared FROM links WHERE space = ? AND approved > 0 ORDER BY created'),
      dropLink: db.prepare('DELETE FROM links WHERE id = ? AND space = ?'),
      stale: db.prepare('DELETE FROM links WHERE approved = 0 AND created < ?'),
      // Read by the phone but never fetched by the computer: its token (kept only until then) goes.
      undelivered: db.prepare('DELETE FROM links WHERE approved > 0 AND wrapped IS NOT NULL AND created < ?'),
      idle: db.prepare('DELETE FROM links WHERE approved > 0 AND wrapped IS NULL AND last_seen < ?'),
      // Fetched by the computer but never used (the answer lost on the way): not a computer of hers.
      unused: db.prepare('DELETE FROM links WHERE approved > 0 AND wrapped IS NULL AND last_seen = approved AND approved < ?'),
      sharedIdle: db.prepare('DELETE FROM links WHERE shared = 1 AND approved > 0 AND last_seen < ?'),
      markShared: db.prepare('UPDATE links SET shared = 1 WHERE id = ?'),
      pending: db.prepare('SELECT COUNT(*) AS n FROM links WHERE approved = 0'),
    };
  }

  /** So many calls a minute for one space (or, before it has one, one address). */
  rate(who, max = 600) {
    const now = this.now();
    let c = this.calls.get(who);
    if (!c || now - c.start > MINUTE) this.calls.set(who, (c = { start: now, n: 0 }));
    if (++c.n > max) throw new HttpError(429, 'rate_limited', 'Muitos pedidos em pouco tempo.', { retry_after: 30 });
  }

  /** Room on the disk for [bytes] more, keeping [minFree] free. */
  room(bytes) {
    let free = Infinity;
    try {
      const st = fs.statfsSync(this.dir);
      free = st.bavail * st.bsize;
    } catch { /* can't tell: the space's own limits still hold */ }
    if (free - bytes < this.minFree) throw new HttpError(507, 'server_full', 'O servidor está sem espaço agora.', { retry_after: 3600 });
  }

  /** One more long wait open, or 429 when there are too many ([n] of this one already). */
  enter(n, max) {
    if (n >= max || this.waits >= this.maxWaits) throw new HttpError(429, 'rate_limited', 'Conexões demais abertas.', { retry_after: 10 });
    this.waits++;
    let left = false;
    return () => {
      if (!left) this.waits--;
      left = true;
    };
  }

  prune() {
    const now = this.now();
    this.q.stale.run(now - this.linkTtl);
    this.q.undelivered.run(now - this.linkTtl);
    this.q.idle.run(now - this.idleMs);
    this.q.unused.run(now - this.linkTtl);
    this.q.sharedIdle.run(now - this.sharedIdleMs);
    for (const [k, seen] of this.nonces) {
      for (const [n, at] of seen) if (now - at > PROOF_WINDOW * 2) seen.delete(n);
      if (!seen.size) this.nonces.delete(k);
    }
    for (const [k, c] of this.calls) if (now - c.start > MINUTE) this.calls.delete(k);
  }

  // ------------------------------------------------------------------ the space

  /**
   * The phone's space ([install] behind [device]), made the first time. [keyCheck] says which key it
   * encrypts with: another one means a phone that lost its key — refused (409), unless [reset], which
   * throws everything there away (records, files and linked computers) and starts it over.
   */
  open(install, device, keyCheck, reset = false) {
    if (typeof keyCheck !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(keyCheck)) throw bad('key_check inválido.');
    const now = this.now();
    let s = this.q.spaceByInstall.get(install);
    if (s && s.key_check !== keyCheck) {
      if (!reset) throw new HttpError(409, 'key_mismatch', 'Este espaço está em outra chave.');
      this.erase(s.id);
      s = null;
    }
    if (!s) {
      const id = token(18);
      this.q.newSpace.run(id, install, device, keyCheck, now, now);
      return { space: id, seq: 0, fresh: true };
    }
    this.q.touch.run(device, now, s.id);
    return { space: s.id, seq: s.seq, fresh: false };
  }

  /** The phone's space, when it has one. */
  spaceOf(install) {
    return this.q.spaceByInstall.get(install) ?? null;
  }

  /** Everything of a space, gone (the phone asked, or it started over with another key). */
  erase(spaceId) {
    this.db.exec('BEGIN');
    try {
      for (const t of ['records', 'blobs']) this.db.prepare(`DELETE FROM ${t} WHERE space = ?`).run(spaceId);
      this.db.prepare('DELETE FROM links WHERE space = ?').run(spaceId);
      this.db.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    fs.rmSync(path.join(this.dir, spaceId), { recursive: true, force: true });
    this.wake(spaceId);
  }

  // ------------------------------------------------------------------ records

  /** What changed after [since], oldest first: { changes: [{ k, s, d (base64) | null }], seq, more, head }. */
  changes(spaceId, since, limit = 500) {
    const s = this.q.space.get(spaceId);
    if (!s) throw new HttpError(404, 'no_space', 'Espaço não existe.');
    const from = Number.isSafeInteger(since) && since >= 0 ? since : 0;
    const n = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 500, 1000));
    const rows = this.q.changes.all(spaceId, from, n + 1);
    let more = rows.length > n;
    // At most ~4 MB a page (records go up to 512 KB each): the rest in the next one.
    let page = rows.slice(0, n);
    let bytes = 0;
    for (let i = 0; i < page.length; i++) {
      bytes += (page[i].data?.length ?? 0) + 64;
      if (bytes > PAGE_BYTES && i > 0) {
        page = page.slice(0, i);
        more = true;
        break;
      }
    }
    return {
      changes: page.map((r) => ({ k: r.key, s: r.seq, d: r.data ? Buffer.from(r.data).toString('base64') : null })),
      seq: page.length ? page[page.length - 1].seq : from,
      more,
      head: s.seq,
    };
  }

  /**
   * Writes: each { k, base, d (base64) | null }. One whose record changed after [base] (the number
   * the writer last saw of it; 0 for new) is not written: it comes back with what is there now, to
   * merge. All the others are written, each with the next number of the space.
   */
  push(spaceId, items) {
    if (!Array.isArray(items) || items.length > 500) throw bad('items: até 500.');
    const s = this.q.space.get(spaceId);
    if (!s) throw new HttpError(404, 'no_space', 'Espaço não existe.');
    const parsed = items.map((it) => {
      if (!it || typeof it !== 'object' || typeof it.k !== 'string' || !KEY.test(it.k)) throw bad('k inválido.');
      const base = it.base ?? 0;
      if (!Number.isSafeInteger(base) || base < 0) throw bad('base inválida.');
      let data = null;
      if (it.d !== null && it.d !== undefined) {
        if (typeof it.d !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(it.d)) throw bad('d: base64.');
        data = Buffer.from(it.d, 'base64');
        if (data.length < 28 || data.length > this.maxRecord) throw bad('registro de tamanho inválido.');
      }
      return { k: it.k, base, data };
    });
    const adding = parsed.reduce((n, it) => n + (it.data ? it.data.length : 0), 0);
    if (adding) this.room(adding);
    const results = [];
    let seq = s.seq;
    let bytes = s.bytes;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const it of parsed) {
        const cur = this.q.record.get(spaceId, it.k);
        const curSeq = cur?.seq ?? 0;
        if (curSeq !== it.base) {
          results.push({ k: it.k, ok: false, s: curSeq, d: cur?.data ? Buffer.from(cur.data).toString('base64') : null });
          continue;
        }
        // Deleting what isn't there: nothing to say to anyone.
        if (!cur && !it.data) {
          results.push({ k: it.k, ok: true, s: 0 });
          continue;
        }
        const was = cur?.data ? cur.data.length : 0;
        const next = bytes - was + (it.data ? it.data.length : 0);
        if (it.data && next > this.maxRecords) throw new HttpError(507, 'space_full', 'O espaço do Novelo Web está cheio.');
        seq += 1;
        bytes = next;
        this.q.put.run(spaceId, it.k, seq, it.data);
        results.push({ k: it.k, ok: true, s: seq });
      }
      this.q.bump.run(seq, bytes, spaceId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    if (seq !== s.seq) this.wake(spaceId);
    return { results, head: seq };
  }

  /** Waits (up to [ms]) for something after [since]; true when there is. */
  async waitFor(spaceId, since, ms, signal) {
    const head = () => this.q.space.get(spaceId)?.seq ?? -1;
    if (head() !== since || ms <= 0) return true;
    const leave = this.enter(this.waiters.get(spaceId)?.size ?? 0, this.maxWaitsPerSpace);
    return await new Promise((resolve) => {
      let set = this.waiters.get(spaceId);
      if (!set) this.waiters.set(spaceId, (set = new Set()));
      const done = (v) => {
        clearTimeout(timer);
        set.delete(wake);
        if (!set.size) this.waiters.delete(spaceId);
        leave();
        resolve(v);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      set.add(wake);
      signal?.addEventListener('abort', () => done(false), { once: true });
    });
  }

  wake(spaceId) {
    const set = this.waiters.get(spaceId);
    if (set) [...set].forEach((w) => w());
  }

  // ------------------------------------------------------------------ files

  blobPath(spaceId, id) {
    return path.join(this.dir, spaceId, id);
  }

  hasBlob(spaceId, id) {
    if (!ID.test(id)) throw bad('id do arquivo inválido.');
    return this.q.blob.get(spaceId, id) ?? null;
  }

  /** A file, written whole or not at all (a copy, then renamed). */
  putBlob(spaceId, id, bytes) {
    if (!ID.test(id)) throw bad('id do arquivo inválido.');
    if (bytes.length < 28) throw bad('arquivo vazio.');
    const s = this.q.space.get(spaceId);
    if (!s) throw new HttpError(404, 'no_space', 'Espaço não existe.');
    const old = this.q.blob.get(spaceId, id)?.size ?? 0;
    if (s.blob_bytes - old + bytes.length > this.maxBlobs) throw new HttpError(507, 'space_full', 'O espaço de arquivos do Novelo Web está cheio.');
    this.room(bytes.length);
    const dir = path.join(this.dir, spaceId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${id}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, id));
    this.q.newBlob.run(spaceId, id, bytes.length, this.now());
    this.q.blobBytes.run(spaceId, spaceId);
  }

  getBlob(spaceId, id) {
    if (!this.hasBlob(spaceId, id)) return null;
    try {
      return fs.readFileSync(this.blobPath(spaceId, id));
    } catch {
      return null;
    }
  }

  /**
   * The phone says which files are still in use: the others go — except the ones that arrived in the
   * last [graceMs] (a computer may have just sent one whose record the phone hasn't seen yet).
   */
  keepBlobs(spaceId, ids, graceMs = 6 * 3600_000) {
    if (!Array.isArray(ids) || ids.length > 200_000 || ids.some((i) => typeof i !== 'string')) throw bad('ids inválidos.');
    const keep = new Set(ids);
    const now = this.now();
    let dropped = 0;
    for (const b of this.q.blobs.all(spaceId)) {
      if (keep.has(b.id) || now - b.created < graceMs) continue;
      this.q.dropBlob.run(spaceId, b.id);
      fs.rmSync(this.blobPath(spaceId, b.id), { force: true });
      dropped++;
    }
    this.q.blobBytes.run(spaceId, spaceId);
    return { dropped };
  }

  // ------------------------------------------------------------------ linking a computer

  /**
   * A computer wants to be linked: its public key for the link (P-256, raw, base64url), the public half
   * of the key that will sign each of its requests ([proof], ECDSA P-256, raw, base64url: the private
   * half can't leave its browser) and what it is.
   */
  startLink(webKey, name, proof) {
    if (typeof webKey !== 'string' || !B64URL.test(webKey) || Buffer.from(webKey, 'base64url').length !== 65) throw bad('key: P-256 (65 bytes).');
    if (typeof proof !== 'string' || !B64URL.test(proof) || !proofKey(proof)) throw bad('proof: P-256 (65 bytes).');
    if (this.q.pending.get().n >= this.maxPending) throw new HttpError(503, 'busy', 'Muitos códigos abertos agora. Tente de novo em instantes.', { retry_after: 60 });
    const id = token(16);
    const poll = token(32);
    // The address isn't kept (it was only for counting, in memory): nothing about the computer but its name.
    this.q.newLink.run(id, webKey, sha(poll), shown(name, 80), '', this.now(), proof);
    return { id, poll, expires_in: Math.round(this.linkTtl / 1000) };
  }

  /** The computer asks whether the phone read its code yet (waiting up to [ms]); the answer comes once. */
  async pollLink(id, poll, ms, signal) {
    const read = () => {
      const l = typeof id === 'string' && ID.test(id) ? this.q.link.get(id) : null;
      if (!l || typeof poll !== 'string' || l.poll_hash !== sha(poll)) throw new HttpError(404, 'no_link', 'Código não existe.');
      if (!l.approved) {
        if (this.now() - l.created > this.linkTtl) throw new HttpError(410, 'expired', 'O código expirou.');
        return null;
      }
      if (!l.wrapped) throw new HttpError(410, 'delivered', 'Este código já foi usado.');
      return l;
    };
    let l = read();
    if (!l && ms > 0) {
      const leave = this.enter(this.polls.get(id)?.size ?? 0, 2);
      await new Promise((resolve) => {
        let set = this.polls.get(id);
        if (!set) this.polls.set(id, (set = new Set()));
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          if (!set.size) this.polls.delete(id);
          leave();
          resolve();
        };
        const timer = setTimeout(done, ms);
        set.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
      l = read();
    }
    if (!l) return { status: 'pending' };
    const out = JSON.parse(l.wrapped);
    this.q.delivered.run(id);
    return { status: 'linked', ...out };
  }

  /**
   * The phone read the computer's code: it sends the space's key encrypted to the computer's key
   * ([wrapped]: its own one-time public key, iv, ciphertext — all base64url). The computer gets a
   * token for this server and that, once.
   */
  approveLink(install, linkId, wrapped, owner) {
    const s = this.q.spaceByInstall.get(install);
    if (!s) throw new HttpError(409, 'no_space', 'O celular ainda não abriu o espaço.');
    const l = typeof linkId === 'string' && ID.test(linkId) ? this.q.link.get(linkId) : null;
    if (!l || l.approved || this.now() - l.created > this.linkTtl) throw new HttpError(410, 'expired', 'O código expirou. Mostre outro no computador.');
    if (!wrapped || typeof wrapped !== 'object') throw bad('wrapped inválido.');
    const w = {};
    for (const f of ['pub', 'iv', 'ct']) {
      if (typeof wrapped[f] !== 'string' || !B64URL.test(wrapped[f]) || wrapped[f].length > 4096) throw bad(`wrapped.${f} inválido.`);
      w[f] = wrapped[f];
    }
    if (this.q.linksOf.all(s.id).length >= this.maxLinks) throw new HttpError(409, 'too_many', 'Computadores demais ligados a este celular.');
    const t = token(32);
    const now = this.now();
    const payload = JSON.stringify({ token: t, space: s.id, wrapped: w, owner: shown(owner, 80) });
    const r = this.q.approve.run(s.id, sha(t), payload, now, now, linkId);
    if (r.changes !== 1) throw new HttpError(410, 'expired', 'O código expirou. Mostre outro no computador.');
    const set = this.polls.get(linkId);
    if (set) [...set].forEach((w2) => w2());
    return { id: linkId, name: l.name };
  }

  /** The computer behind a token (Authorization: Bearer …), or 401. */
  web(req) {
    const h = String(req.headers.authorization ?? '');
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(h);
    const l = m ? this.q.linkByToken.get(sha(m[1])) : null;
    if (!l || !l.space) throw new HttpError(401, 'unlinked', 'Este computador não está mais ligado ao celular.');
    const s = this.q.space.get(l.space);
    if (!s) throw new HttpError(401, 'unlinked', 'Este computador não está mais ligado ao celular.');
    return { link: l.id, name: l.name, space: s.id, install: s.install, device: s.device, proof: l.proof_key, approved: l.approved, lastSeen: l.last_seen };
  }

  /**
   * The computer's request is its own: signed (X-Novelo-Sig: "<ms>.<nonce>.<signature>") by the key
   * only its browser holds, over what it asks — method, address, when, a one-time nonce and the
   * body's SHA-256. A token taken elsewhere (a log, a copy of the disk) is worth nothing without it.
   * A clock too far off says the server's time (the page corrects and asks again).
   */
  proof(who, req, raw) {
    const key = who.proof ? this.proofKeyOf(who.link, who.proof) : null;
    const m = /^(\d{12,14})\.([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{86})$/.exec(String(req.headers['x-novelo-sig'] ?? ''));
    const now = this.now();
    if (!key || !m) throw new HttpError(401, 'bad_proof', 'Pedido sem a assinatura deste computador.', { now });
    const at = Number(m[1]);
    if (Math.abs(now - at) > PROOF_WINDOW) throw new HttpError(401, 'bad_proof', 'O relógio deste computador está fora da hora.', { now });
    const text = `novelo-web-v1\n${req.method}\n${req.url}\n${m[1]}\n${m[2]}\n${crypto.createHash('sha256').update(raw).digest('hex')}`;
    const ok = crypto.verify('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
    if (!ok) throw new HttpError(401, 'bad_proof', 'Assinatura que não confere.', { now });
    let seen = this.nonces.get(who.link);
    if (!seen) this.nonces.set(who.link, (seen = new Map()));
    if (seen.has(m[2])) throw new HttpError(401, 'bad_proof', 'Pedido repetido.', { now });
    if (seen.size >= 20_000) throw new HttpError(429, 'rate_limited', 'Muitos pedidos em pouco tempo.', { retry_after: 30 });
    seen.set(m[2], now);
    // Seen now (the first use after being linked, then once a minute).
    if (who.lastSeen === who.approved || now - who.lastSeen > MINUTE) this.q.linkSeen.run(now, who.link);
  }

  proofKeyOf(link, raw) {
    let k = this.proofKeys.get(link);
    if (!k) {
      k = proofKey(raw);
      if (this.proofKeys.size > 2000) this.proofKeys.clear();
      if (k) this.proofKeys.set(link, k);
    }
    return k;
  }

  /** This computer isn't hers: it goes when its tab closes, or by itself after a while without a sign. */
  markShared(link) {
    this.q.markShared.run(link);
  }

  links(spaceId) {
    return this.q.linksOf.all(spaceId).map((l) => ({ id: l.id, name: l.name, created: l.created, last_seen: l.last_seen, shared: l.shared === 1 }));
  }

  unlink(spaceId, id) {
    this.proofKeys.delete(id);
    this.nonces.delete(id);
    return this.q.dropLink.run(id, spaceId).changes > 0;
  }
}
