// The backup in the cloud. The phone encrypts everything before it leaves (the key never comes
// here), cuts it in pieces and sends each piece once; a small encrypted index says which pieces
// make the backup. Here they are only files: without the key nobody — not even this server — can
// read them. What opens a vault is a token made from that same key; only its hash is kept.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './http.js';
import { event, tx } from './db.js';

export const BLOB_MAX = 4 * 1024 * 1024 + 4096;
export const MANIFEST_MAX = 24 * 1024 * 1024;
const BLOB_ID = /^[A-Za-z0-9_-]{43}$/;
const DAY = 24 * 3600_000;
const FREE_FLOOR = 512 * 1024 * 1024;

export class Vaults {
  constructor({ db, settings, dataDir, now = Date.now }) {
    this.db = db;
    this.settings = settings;
    this.now = now;
    this.dir = dataDir === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'novelo-vaults-')) : path.join(dataDir, 'backups');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.made = new Map(); // install|day → vaults created
    this.warned = 0;
  }

  folder(vault) {
    return path.join(this.dir, vault);
  }

  blobFile(vault, id) {
    return path.join(this.folder(vault), 'blobs', id.slice(0, 2), id);
  }

  manifestFile(vault, id) {
    return path.join(this.folder(vault), 'manifests', String(id));
  }

  write(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /**
   * The vault [id], opened with [token]. An unknown one is made when [create] (the first backup of a
   * Novelo+ phone); otherwise 404. A wrong token: 403.
   */
  open(id, token, { create = false, install = '', day = '' } = {}) {
    const raw = Buffer.from(String(token ?? ''), 'base64url');
    if (raw.length !== 32) throw new HttpError(403, 'vault_key', 'Chave do backup inválida.');
    const auth = crypto.createHash('sha256').update(raw).digest();
    const v = this.db.prepare('SELECT * FROM vaults WHERE id = ?').get(id);
    if (v) {
      if (!crypto.timingSafeEqual(Buffer.from(v.auth), auth)) throw new HttpError(403, 'vault_key', 'Chave do backup inválida.');
      return v;
    }
    if (!create) throw new HttpError(404, 'no_backup', 'Não há backup na nuvem com esta chave.');
    const key = `${install}|${day}`;
    const n = this.made.get(key) ?? 0;
    if (n >= 3) throw new HttpError(429, 'rate_limited', 'Muitos backups novos hoje.', { retry_after: 3600 });
    if (this.made.size > 50_000) this.made.clear();
    this.made.set(key, n + 1);
    const t = this.now();
    this.db.prepare('INSERT INTO vaults(id,auth,created,updated,install) VALUES(?,?,?,?,?)').run(id, auth, t, t, install);
    return this.db.prepare('SELECT * FROM vaults WHERE id = ?').get(id);
  }

  quota() {
    return this.settings.get('backup_quota_mb') * 1024 * 1024;
  }

  /** Room for [size] more bytes in [v]: its own quota, the ceiling of everything, the disk. */
  room(v, size) {
    if (v.bytes + size > this.quota()) throw new HttpError(413, 'backup_full', 'O backup na nuvem está cheio.', { quota: this.quota(), used: v.bytes });
    const ceiling = this.settings.get('backup_total_gb') * 1024 ** 3;
    let full = ceiling > 0 && this.db.prepare('SELECT COALESCE(SUM(bytes),0) b FROM vaults').get().b + size > ceiling;
    if (!full) {
      try {
        const st = fs.statfsSync(this.dir);
        full = st.bavail * st.bsize < FREE_FLOOR + size;
      } catch { /* a file system that doesn't say: the write itself will */ }
    }
    if (full) {
      if (this.now() - this.warned > DAY) {
        this.warned = this.now();
        event(this.db, 'backup', 'Sem espaço para mais backups: envios recusados.');
      }
      throw new HttpError(507, 'storage_full', 'Sem espaço para o backup agora.', { retry_after: 3600 });
    }
  }

  info(v) {
    return {
      exists: true,
      created: v.created,
      updated: v.updated,
      used: v.bytes,
      quota: this.quota(),
      manifests: this.db.prepare('SELECT id, size FROM vault_manifests WHERE vault = ? ORDER BY id DESC').all(v.id),
    };
  }

  /** Which of [ids] are not here yet. */
  missing(v, ids, max = 20_000) {
    if (!Array.isArray(ids) || ids.length > max || ids.some((i) => !BLOB_ID.test(i))) throw new HttpError(422, 'bad_request', 'Lista inválida.');
    const has = this.db.prepare('SELECT 1 x FROM vault_blobs WHERE vault = ? AND id = ?');
    return ids.filter((i) => !has.get(v.id, i));
  }

  putBlob(v, id, data) {
    if (!data.length || data.length > BLOB_MAX) throw new HttpError(413, 'too_large', 'Pedaço grande demais.');
    if (this.db.prepare('SELECT 1 x FROM vault_blobs WHERE vault = ? AND id = ?').get(v.id, id)) return { ok: true, had: true };
    this.room(v, data.length);
    this.write(this.blobFile(v.id, id), data);
    const t = this.now();
    tx(this.db, () => {
      this.db.prepare('INSERT INTO vault_blobs(vault,id,size,at) VALUES(?,?,?,?)').run(v.id, id, data.length, t);
      this.db.prepare('UPDATE vaults SET bytes = bytes + ?, updated = ? WHERE id = ?').run(data.length, t, v.id);
    });
    return { ok: true };
  }

  getBlob(v, id) {
    if (!this.db.prepare('SELECT 1 x FROM vault_blobs WHERE vault = ? AND id = ?').get(v.id, id)) throw new HttpError(404, 'not_found', 'Pedaço não encontrado.');
    try {
      return fs.readFileSync(this.blobFile(v.id, id));
    } catch {
      throw new HttpError(404, 'not_found', 'Pedaço não encontrado.');
    }
  }

  /**
   * A new version of the backup: [data] (the encrypted index) and [refs] (the pieces it is made
   * of — every one must be here already). The last few versions are kept; pieces no version
   * uses any more are let go.
   */
  putManifest(v, data, refs) {
    if (!data.length || data.length > MANIFEST_MAX) throw new HttpError(413, 'too_large', 'Índice grande demais.');
    // A version may be made of many pieces (years of photos): far more than one "have" asks about at once.
    const lacking = this.missing(v, refs, 200_000);
    if (lacking.length) throw new HttpError(409, 'missing', 'Faltam pedaços.', { missing: lacking.slice(0, 1000) });
    this.room(v, data.length);
    const last = this.db.prepare('SELECT COALESCE(MAX(id),0) m FROM vault_manifests WHERE vault = ?').get(v.id).m;
    const id = Math.max(this.now(), last + 1);
    this.write(this.manifestFile(v.id, id), data);
    tx(this.db, () => {
      this.db.prepare('INSERT INTO vault_manifests(vault,id,size,refs) VALUES(?,?,?,?)').run(v.id, id, data.length, JSON.stringify(refs));
      this.db.prepare('UPDATE vaults SET bytes = bytes + ?, updated = ? WHERE id = ?').run(data.length, this.now(), v.id);
    });
    this.tidy(v.id);
    return { ok: true, id };
  }

  getManifest(v, id) {
    const row = id
      ? this.db.prepare('SELECT id FROM vault_manifests WHERE vault = ? AND id = ?').get(v.id, id)
      : this.db.prepare('SELECT id FROM vault_manifests WHERE vault = ? ORDER BY id DESC LIMIT 1').get(v.id);
    if (!row) throw new HttpError(404, 'no_backup', 'Ainda não há backup na nuvem.');
    try {
      return { id: row.id, data: fs.readFileSync(this.manifestFile(v.id, row.id)) };
    } catch {
      throw new HttpError(404, 'no_backup', 'Ainda não há backup na nuvem.');
    }
  }

  /** Old versions out; pieces of no kept version out too (not the ones just sent for the next one). */
  tidy(vault) {
    const keep = Math.max(1, this.settings.get('backup_keep'));
    const all = this.db.prepare('SELECT id, size, refs FROM vault_manifests WHERE vault = ? ORDER BY id DESC').all(vault);
    let freed = 0;
    for (const m of all.slice(keep)) {
      fs.rmSync(this.manifestFile(vault, m.id), { force: true });
      this.db.prepare('DELETE FROM vault_manifests WHERE vault = ? AND id = ?').run(vault, m.id);
      freed += m.size;
    }
    const used = new Set();
    for (const m of all.slice(0, keep)) for (const r of JSON.parse(m.refs)) used.add(r);
    const old = this.now() - DAY;
    for (const b of this.db.prepare('SELECT id, size FROM vault_blobs WHERE vault = ? AND at < ?').all(vault, old)) {
      if (used.has(b.id)) continue;
      fs.rmSync(this.blobFile(vault, b.id), { force: true });
      this.db.prepare('DELETE FROM vault_blobs WHERE vault = ? AND id = ?').run(vault, b.id);
      freed += b.size;
    }
    if (freed) this.db.prepare('UPDATE vaults SET bytes = MAX(0, bytes - ?) WHERE id = ?').run(freed, vault);
  }

  /** Everything of a vault, gone (she turned the cloud backup off, or asked for it to be erased). */
  erase(id) {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM vault_blobs WHERE vault = ?').run(id);
      this.db.prepare('DELETE FROM vault_manifests WHERE vault = ?').run(id);
      this.db.prepare('DELETE FROM vaults WHERE id = ?').run(id);
    });
    fs.rmSync(this.folder(id), { recursive: true, force: true });
    return { ok: true };
  }

  totals() {
    return this.db.prepare('SELECT COUNT(*) vaults, COALESCE(SUM(bytes),0) bytes FROM vaults').get();
  }
}
