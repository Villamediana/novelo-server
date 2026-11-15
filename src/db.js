// SQLite (node:sqlite, nothing to install). What is kept: the configuration, the phones, and
// numbers about each request (when, which model, how long, tokens, cost). Never what was said:
// no prompt and no answer is written anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS providers(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  key_env TEXT NOT NULL DEFAULT '',
  headers TEXT NOT NULL DEFAULT '{}',
  extra TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS jobs(
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  accepts TEXT NOT NULL DEFAULT 'text',
  enabled INTEGER NOT NULL DEFAULT 1,
  max_body_kb INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  per_minute INTEGER NOT NULL,
  per_day INTEGER NOT NULL,
  wait_s INTEGER NOT NULL,
  free_fallback INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS routes(
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL,
  position INTEGER NOT NULL,
  provider_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_concurrency INTEGER NOT NULL DEFAULT 32,
  rpm INTEGER NOT NULL DEFAULT 0,
  price_in REAL NOT NULL DEFAULT 0,
  price_out REAL NOT NULL DEFAULT 0,
  timeout_s INTEGER NOT NULL DEFAULT 90,
  extra TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS devices(
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  package TEXT NOT NULL DEFAULT '',
  attested INTEGER NOT NULL DEFAULT 0,
  attest_level TEXT NOT NULL DEFAULT '',
  attest_note TEXT NOT NULL DEFAULT '',
  boot TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  note TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  device TEXT NOT NULL,
  job TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  free INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  queue_ms INTEGER NOT NULL DEFAULT 0,
  upstream_ms INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);

CREATE TABLE IF NOT EXISTS agg_hour(
  hour INTEGER NOT NULL,
  job TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  bad INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  ms_sum INTEGER NOT NULL DEFAULT 0,
  queue_ms_sum INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(hour, job, model)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_day(
  device TEXT NOT NULL,
  day TEXT NOT NULL,
  job TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(device, day, job)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS usage_day_day ON usage_day(day);

-- Who has what: decided here, never by what a phone says of itself. An "install" is one phone
-- (it stays the same when the app is installed again), so a trial doesn't start over.
CREATE TABLE IF NOT EXISTS installs(
  id TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  plan TEXT NOT NULL,
  trial_start INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
`;

/** Every setting, with the value a fresh server starts with. All of them are changed in the panel. */
export const DEFAULTS = {
  // Money (USD). 0 = no ceiling.
  budget_day_usd: 5,
  budget_month_usd: 60,
  // One phone, one day (USD). 0 = no ceiling.
  device_day_usd: 0.25,
  // The day turns at midnight here.
  timezone: 'America/Sao_Paulo',
  // Who may register: 'off' (anyone), 'observe' (the phone's proof is checked and noted, not demanded), 'require'.
  attestation: 'observe',
  app_packages: 'com.villamediana.novelo',
  // SHA-256 of the certificate the app is signed with (hex), one per line.
  // (The release certificate of the app; it is in every APK, not a secret.)
  app_cert_sha256: 'f538e5002e8ae68cac35b25785e655d40a1e6bf54f9db606493500633d48bffc',
  // New phones: per address per day, and in all per day.
  register_per_ip_day: 5,
  register_per_day: 3000,
  // What a phone that registers for the first time gets: 'plus' (Novelo+) or 'trial' (so many days, then
  // the Novelo's intelligence ends for it and it goes on with its own: on the phone, or its API).
  new_plan: 'plus',
  trial_days: 7,
  // Everything stops answering (maintenance, or a leak being looked at).
  paused: 0,
  // The last resort: free models of this provider, rotated.
  free_provider: 1,
  free_max_concurrency: 4,
  free_rpm: 18,
  free_preferred: [
    'baidu/ernie-5.5-flash-preview:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3.5-super-vl:free',
    'dots-studio/dots-3-note-preview:free',
  ].join('\n'),
  free_avoid: [
    'liquid/lfm-3-1.7b:free',
    'nvidia/nemotron-3.5-lightning:free',
    'recursive/flint-v1.0:free',
    'cohere/north-mini-code:free',
    'thinkingmachines/inkling-2-small:free',
  ].join('\n'),
  // How long the per-request rows are kept (the hourly totals stay).
  keep_days: 30,
};

const JOBS = [
  // key, label, accepts, max_body_kb, max_output_tokens, per_minute, per_day, wait_s
  ['hear', 'Ouvir', 'text,audio', 4096, 4000, 40, 800, 150],
  ['see', 'Ver', 'text,image', 3072, 1000, 20, 300, 150],
  ['think', 'Pensar', 'text', 512, 16000, 30, 500, 150],
];

export function openDb(dataDir, file = 'novelo.db') {
  if (dataDir !== ':memory:') fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, file));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

/** Columns that came after the first version. */
function migrate(db) {
  const has = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has('devices', 'install')) db.exec("ALTER TABLE devices ADD COLUMN install TEXT NOT NULL DEFAULT ''");
}

function seed(db) {
  const jobs = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  if (!jobs) {
    const ins = db.prepare('INSERT INTO jobs(key,label,accepts,max_body_kb,max_output_tokens,per_minute,per_day,wait_s) VALUES(?,?,?,?,?,?,?,?)');
    for (const j of JOBS) ins.run(...j);
  }
  if (!db.prepare('SELECT COUNT(*) n FROM providers').get().n) {
    db.prepare('INSERT INTO providers(id,name,base_url,key_env,headers,extra) VALUES(1,?,?,?,?,?)').run(
      'OpenRouter',
      'https://openrouter.ai/api/v1',
      'OPENROUTER_API_KEY',
      JSON.stringify({ 'X-Title': 'Novelo' }),
      JSON.stringify({ usage: { include: true } }),
    );
  }
}

/** The settings, read once and kept; a write goes to the database and to the copy. */
export class Settings {
  constructor(db) {
    this.db = db;
    this.cache = { ...DEFAULTS };
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      if (!(row.key in DEFAULTS)) continue;
      this.cache[row.key] = typeof DEFAULTS[row.key] === 'number' ? Number(row.value) : row.value;
    }
  }

  get(key) {
    return this.cache[key];
  }

  list(key) {
    return String(this.cache[key] ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }

  all() {
    return { ...this.cache };
  }

  set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`ajuste desconhecido: ${key}`);
    let v = value;
    if (typeof DEFAULTS[key] === 'number') {
      v = Number(value);
      if (!Number.isFinite(v) || v < 0) throw new Error(`valor inválido para ${key}`);
    } else {
      v = String(value ?? '');
    }
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(v));
    this.cache[key] = v;
  }
}

export function event(db, kind, message) {
  db.prepare('INSERT INTO events(ts,kind,message) VALUES(?,?,?)').run(Date.now(), kind, String(message).slice(0, 500));
}

/** Runs [fn] inside one transaction. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
