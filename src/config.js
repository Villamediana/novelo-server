// Where the secrets live: one .env file (chmod 600), never the database, never git.
// The panel writes a key here when one is pasted in it; nothing reads a secret from anywhere else.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export class Config {
  constructor(file = process.env.NOVELO_ENV || path.join(ROOT, '.env'), env = process.env) {
    this.file = file;
    this.values = new Map();
    this.processEnv = env;
    this.load();
  }

  load() {
    this.values.clear();
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      this.values.set(m[1], v);
    }
  }

  /** The process environment wins over the file (a systemd unit may set a port). */
  get(name, fallback = '') {
    const v = this.processEnv[name] ?? this.values.get(name);
    return v === undefined || v === '' ? fallback : v;
  }

  int(name, fallback) {
    const n = Number.parseInt(this.get(name, ''), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  has(name) {
    return this.get(name, '') !== '';
  }

  static validName(name) {
    return NAME.test(name);
  }

  /** Writes one value into the .env, keeping every other line as it is. Empty removes it. */
  set(name, value) {
    if (!Config.validName(name)) throw new Error('nome de variável inválido');
    if (/[\r\n]/.test(value)) throw new Error('valor inválido');
    const lines = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8').split(/\r?\n/) : [];
    const at = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
    const line = `${name}=${value}`;
    if (at >= 0) lines[at] = line;
    else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push(line);
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
    if (value === '') this.values.delete(name);
    else this.values.set(name, value);
    delete this.processEnv[name];
  }

  /** The secret that signs challenges and panel sessions: made once and kept in the .env. */
  serverSecret() {
    let s = this.get('SERVER_SECRET');
    if (s.length < 32) {
      s = crypto.randomBytes(48).toString('base64url');
      this.set('SERVER_SECRET', s);
    }
    return s;
  }

  get dataDir() {
    return path.resolve(ROOT, this.get('DATA_DIR', './data'));
  }
}
