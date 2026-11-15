// The panel: which models do each job, the keys, the limits and the ceiling of what may be spent,
// the phones, and how it is all going. It listens on its own port, behind one password (.env).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, readBody, parseJson, sendJson, sendError, clientIp, scheme } from './http.js';
import { Config, ROOT } from './config.js';
import { DEFAULTS, event } from './db.js';
import { chat, listModels } from './upstream.js';
import { merge } from './router.js';

const SESSION = 12 * 3600_000;
const COOKIE = 'novelo_admin';
const STATIC = path.join(ROOT, 'admin');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const need = (ok, message) => {
  if (!ok) throw new HttpError(422, 'bad_request', message);
};
const jsonObject = (text, name) => {
  try {
    const v = JSON.parse(text === undefined || text === '' ? '{}' : typeof text === 'string' ? text : JSON.stringify(text));
    need(v && typeof v === 'object' && !Array.isArray(v), `${name}: precisa ser um objeto JSON.`);
    return JSON.stringify(v);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, 'bad_request', `${name}: JSON inválido.`);
  }
};
const whole = (v, name, min = 0, max = 1e9) => {
  const n = Number(v);
  need(Number.isInteger(n) && n >= min && n <= max, `${name}: número inválido.`);
  return n;
};
const amount = (v, name) => {
  const n = Number(v);
  need(Number.isFinite(n) && n >= 0 && n < 1e6, `${name}: valor inválido.`);
  return n;
};

export class Admin {
  constructor({ db, config, settings, devices, limits, router, telemetry, plans, vaults, secret, fetcher = fetch, now = Date.now }) {
    Object.assign(this, { db, config, settings, devices, limits, router, telemetry, plans, vaults, secret, fetcher, now });
    this.trust = config.get('TRUST_PROXY', 'none');
    this.httpsOnly = config.get('REQUIRE_HTTPS', '1') !== '0';
    this.fails = new Map();
    this.modelLists = new Map();
  }

  // ── session ────────────────────────────────────────────────────────────────

  mac(text) {
    return crypto.createHmac('sha256', this.secret).update(`admin|${text}`).digest('base64url');
  }

  signed(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9]+)\\.([A-Za-z0-9_-]+)`).exec(req.headers.cookie ?? '');
    if (!m) return false;
    const want = this.mac(m[1]);
    return Number(m[1]) > this.now() && m[2].length === want.length && crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(want));
  }

  login(req, res, body) {
    const ip = clientIp(req, this.trust);
    const now = this.now();
    const f = this.fails.get(ip);
    if (f && f.n >= 5 && now - f.at < 15 * 60_000) throw new HttpError(429, 'rate_limited', 'Muitas tentativas. Espere 15 minutos.');
    const password = this.config.get('ADMIN_PASSWORD');
    const a = crypto.createHmac('sha256', this.secret).update(String(body.password ?? '')).digest();
    const b = crypto.createHmac('sha256', this.secret).update(password).digest();
    if (!password || !crypto.timingSafeEqual(a, b)) {
      this.fails.set(ip, { n: (f && now - f.at < 15 * 60_000 ? f.n : 0) + 1, at: now });
      throw new HttpError(401, 'bad_password', 'Senha incorreta.');
    }
    this.fails.delete(ip);
    const exp = String(now + SESSION);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${exp}.${this.mac(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION / 1000}${secure}` });
  }

  // ── http ───────────────────────────────────────────────────────────────────

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    try {
      // Published behind a proxy (Cloudflare Access): never over plain http, where the password would go in the clear.
      if (this.httpsOnly && scheme(req, this.trust) === 'http') {
        req.resume();
        res.writeHead(403, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Use https.');
        return;
      }
      if (!p.startsWith('/api/')) return this.file(req, res, p);
      if (req.method !== 'GET') need(req.headers['x-novelo-admin'] === '1', 'Pedido inválido.');
      const body = req.method === 'GET' ? {} : parseJson(await readBody(req, 256 * 1024).then((b) => (b.length ? b : Buffer.from('{}'))));
      if (p === '/api/login' && req.method === 'POST') return this.login(req, res, body);
      if (!this.signed(req)) throw new HttpError(401, 'login', 'Entre de novo.');
      if (p === '/api/logout') return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
      const out = await this.api(req.method, p, url.searchParams, body);
      return sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('painel:', e);
      return sendError(res, e instanceof HttpError ? e : new HttpError(500, 'internal', String(e?.message ?? 'Erro interno.').slice(0, 200)));
    }
  }

  file(req, res, p) {
    const name = p === '/' ? 'index.html' : p.slice(1);
    const full = path.join(STATIC, name);
    if (req.method !== 'GET' || !full.startsWith(STATIC + path.sep) || !TYPES[path.extname(full)] || !fs.existsSync(full)) {
      res.writeHead(404, HEADERS).end();
      return;
    }
    const data = fs.readFileSync(full);
    res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[path.extname(full)], 'Content-Length': data.length, 'Cache-Control': 'no-cache' }).end(data);
  }

  async api(method, p, query, body) {
    const m = (re) => re.exec(p);
    let x;
    if (method === 'GET' && p === '/api/overview') return this.overview(Number(query.get('hours')) || 24);
    if (method === 'GET' && p === '/api/config') return this.configuration();
    if (method === 'PUT' && p === '/api/settings') return this.saveSettings(body);
    if (method === 'POST' && p === '/api/providers') return this.saveProvider(null, body);
    if ((x = m(/^\/api\/providers\/(\d+)$/)) && method === 'PUT') return this.saveProvider(Number(x[1]), body);
    if (x && method === 'DELETE') return this.deleteProvider(Number(x[1]));
    if ((x = m(/^\/api\/providers\/(\d+)\/key$/)) && method === 'PUT') return this.saveKey(Number(x[1]), body);
    if ((x = m(/^\/api\/providers\/(\d+)\/models$/)) && method === 'GET') return this.models(Number(x[1]), query.get('job') ?? '');
    if ((x = m(/^\/api\/jobs\/([a-z][a-z0-9_]*)$/)) && method === 'PUT') return this.saveJob(x[1], body);
    if (method === 'POST' && p === '/api/routes') return this.saveRoute(null, body);
    if ((x = m(/^\/api\/routes\/(\d+)$/)) && method === 'PUT') return this.saveRoute(Number(x[1]), body);
    if (x && method === 'DELETE') return this.deleteRoute(Number(x[1]));
    if ((x = m(/^\/api\/routes\/(\d+)\/move$/)) && method === 'POST') return this.moveRoute(Number(x[1]), Number(body.dir));
    if ((x = m(/^\/api\/routes\/(\d+)\/test$/)) && method === 'POST') return this.testRoute(Number(x[1]));
    if (method === 'GET' && p === '/api/devices') return this.listDevices(query);
    if ((x = m(/^\/api\/devices\/([A-Za-z0-9_-]{24})$/)) && method === 'PUT') return this.saveDevice(x[1], body);
    if (x && method === 'DELETE') return this.deleteDevice(x[1]);
    throw new HttpError(404, 'not_found', 'Não existe.');
  }

  // ── reading ────────────────────────────────────────────────────────────────

  overview(hours) {
    const h = [24, 168, 720].includes(hours) ? hours : 24;
    const now = this.now();
    const day = this.limits.day();
    const count = (sql, ...args) => this.db.prepare(sql).get(...args).n;
    return {
      now,
      hours: h,
      ...this.telemetry.overview(h, this.settings.get('timezone')),
      live: this.router.live(),
      open: this.router.dispatcher.waiting(),
      budget: {
        day_usd: this.limits.spent.dayUsd,
        month_usd: this.limits.spent.monthUsd,
        day_limit: this.settings.get('budget_day_usd'),
        month_limit: this.settings.get('budget_month_usd'),
      },
      devices: {
        total: count('SELECT COUNT(*) n FROM devices'),
        active_today: count('SELECT COUNT(DISTINCT device) n FROM usage_day WHERE day = ? AND requests > 0', day),
        new_24h: count('SELECT COUNT(*) n FROM devices WHERE created >= ?', now - 24 * 3600_000),
        verified: count('SELECT COUNT(*) n FROM devices WHERE attested = 1'),
        blocked: count("SELECT COUNT(*) n FROM devices WHERE status = 'blocked'"),
      },
      plans: this.planCounts(),
      backups: this.vaults.totals(),
      events: this.db.prepare('SELECT ts, kind, message FROM events ORDER BY id DESC LIMIT 12').all(),
      paused: this.settings.get('paused') ? 1 : 0,
      attestation: this.settings.get('attestation'),
      labels: Object.fromEntries([...this.router.jobs.values()].map((j) => [j.key, j.label])),
    };
  }

  /** How many phones have each plan now (a trial past its days counts as ended). */
  planCounts() {
    const ends = this.now() - this.settings.get('trial_days') * 24 * 3600_000;
    const n = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    return {
      plus: n("SELECT COUNT(*) n FROM installs WHERE plan = 'plus'"),
      trial: n("SELECT COUNT(*) n FROM installs WHERE plan = 'trial' AND trial_start > ?", ends),
      ended: n("SELECT COUNT(*) n FROM installs WHERE plan = 'ended' OR (plan = 'trial' AND trial_start <= ?)", ends),
    };
  }

  configuration() {
    const live = this.router.live();
    const providers = this.db.prepare('SELECT * FROM providers ORDER BY id').all().map((p) => ({
      ...p,
      has_key: p.key_env ? this.config.has(p.key_env) : false,
      key_tail: p.key_env && this.config.has(p.key_env) ? this.config.get(p.key_env).slice(-4) : '',
      routes: this.db.prepare('SELECT COUNT(*) n FROM routes WHERE provider_id = ?').get(p.id).n,
    }));
    const routes = this.db.prepare('SELECT * FROM routes ORDER BY job, position, id').all().map((r) => ({ ...r, live: live.lanes[r.id] ?? null }));
    return {
      settings: this.settings.all(),
      providers,
      jobs: this.db.prepare("SELECT * FROM jobs ORDER BY CASE key WHEN 'hear' THEN 0 WHEN 'see' THEN 1 WHEN 'think' THEN 2 ELSE 3 END, key").all(),
      routes,
      live,
    };
  }

  async models(id, jobKey) {
    const p = this.router.providers.get(id);
    need(p, 'API desconhecida.');
    let kept = this.modelLists.get(id);
    if (!kept || this.now() - kept.at > 10 * 60_000) {
      const list = await listModels({ baseUrl: p.base_url, key: this.router.keyOf(p), headers: p.headers, fetcher: this.fetcher });
      kept = { at: this.now(), list };
      this.modelLists.set(id, kept);
    }
    const needs = (this.router.jobs.get(jobKey)?.accepts ?? 'text').split(',');
    return {
      models: kept.list
        .filter((m) => needs.every((n) => m.input.includes(n)) && m.output.includes('text'))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((m) => ({ id: m.id, name: m.name, price_in: m.priceIn, price_out: m.priceOut, priced: m.priced, context: m.context })),
    };
  }

  listDevices(query) {
    const q = (query.get('q') ?? '').trim().slice(0, 40);
    const filter = query.get('filter') ?? 'all';
    const sort = query.get('sort') === 'cost' ? 'cost DESC, d.last_seen DESC' : 'd.last_seen DESC';
    const offset = Math.max(0, Number(query.get('offset')) || 0);
    const where = ["(? = '' OR d.id LIKE ? OR d.note LIKE ?)"];
    if (filter === 'blocked') where.push("d.status = 'blocked'");
    if (filter === 'unverified') where.push('d.attested = 0');
    this.limits.flush();
    const rows = this.db.prepare(`
      SELECT d.id, d.created, d.last_seen, d.app_version, d.package, d.attested, d.attest_level, d.attest_note, d.boot, d.status, d.note, d.install,
        COALESCE(u.requests, 0) requests, COALESCE(u.cost, 0) cost
      FROM devices d
      LEFT JOIN (SELECT device, SUM(requests) requests, SUM(cost) cost FROM usage_day WHERE day = ? GROUP BY device) u
        ON u.device = CASE WHEN d.install = '' THEN 'd:' || d.id ELSE d.install END
      WHERE ${where.join(' AND ')}
      ORDER BY ${sort} LIMIT 51 OFFSET ?`).all(this.limits.day(), q, `${q}%`, `%${q}%`, offset);
    const devices = rows.slice(0, 50).map(({ install, ...d }) => ({ ...d, plan: this.plans.of(install || `d:${d.id}`) }));
    return { devices, more: rows.length > 50, offset };
  }

  // ── writing ────────────────────────────────────────────────────────────────

  saveSettings(body) {
    for (const [k, v] of Object.entries(body)) {
      need(k in DEFAULTS, `Ajuste desconhecido: ${k}`);
      if (k === 'attestation') need(['off', 'observe', 'require'].includes(v), 'Verificação: off, observe ou require.');
      if (k === 'new_plan') need(['plus', 'trial'].includes(v), 'Novos aparelhos: plus ou trial.');
      if (k === 'timezone') {
        try {
          new Intl.DateTimeFormat('en', { timeZone: String(v) });
        } catch {
          need(false, 'Fuso horário desconhecido.');
        }
      }
      try {
        this.settings.set(k, v);
      } catch (e) {
        need(false, e.message);
      }
    }
    if ('paused' in body) event(this.db, 'servidor', body.paused ? 'Pausado pelo painel.' : 'Retomado pelo painel.');
    this.telemetry.flush();
    this.limits.loadSpent();
    this.router.reload();
    return this.configuration();
  }

  saveProvider(id, b) {
    const name = String(b.name ?? '').trim().slice(0, 60);
    const base = String(b.base_url ?? '').trim().replace(/\/+$/, '');
    const keyEnv = String(b.key_env ?? '').trim();
    need(name, 'Nome: obrigatório.');
    need(/^https?:\/\/[^\s]+$/.test(base), 'Endereço: precisa começar com http(s)://');
    need(Config.validName(keyEnv) && !['ADMIN_PASSWORD', 'SERVER_SECRET'].includes(keyEnv), 'Variável da chave: MAIÚSCULAS_COM_SUBLINHADO (ex.: OPENROUTER_API_KEY).');
    const headers = jsonObject(b.headers, 'Cabeçalhos');
    const extra = jsonObject(b.extra, 'Extras');
    const enabled = b.enabled === false || b.enabled === 0 ? 0 : 1;
    if (id === null) this.db.prepare('INSERT INTO providers(name,base_url,key_env,headers,extra,enabled) VALUES(?,?,?,?,?,?)').run(name, base, keyEnv, headers, extra, enabled);
    else this.db.prepare('UPDATE providers SET name=?, base_url=?, key_env=?, headers=?, extra=?, enabled=? WHERE id=?').run(name, base, keyEnv, headers, extra, enabled, id);
    this.modelLists.clear();
    this.router.reload();
    return this.configuration();
  }

  deleteProvider(id) {
    need(!this.db.prepare('SELECT COUNT(*) n FROM routes WHERE provider_id = ?').get(id).n, 'Há modelos usando esta API. Tire-os antes.');
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    this.router.reload();
    return this.configuration();
  }

  /** The key goes to the .env (never to the database) and is not shown again. */
  saveKey(id, b) {
    const p = this.router.providers.get(id);
    need(p, 'API desconhecida.');
    const value = String(b.value ?? '').trim();
    need(!/\s/.test(value) && value.length <= 400, 'Chave inválida.');
    this.config.set(p.key_env, value);
    this.modelLists.delete(id);
    event(this.db, 'chave', `${p.name}: chave ${value ? 'trocada' : 'removida'} pelo painel.`);
    return this.configuration();
  }

  saveJob(key, b) {
    need(this.router.jobs.has(key), 'Pedido desconhecido.');
    this.db.prepare('UPDATE jobs SET enabled=?, max_body_kb=?, max_output_tokens=?, per_minute=?, per_day=?, wait_s=?, free_fallback=? WHERE key=?').run(
      b.enabled ? 1 : 0,
      whole(b.max_body_kb, 'Tamanho máximo', 16, 32 * 1024),
      whole(b.max_output_tokens, 'Tokens de resposta', 16, 200_000),
      whole(b.per_minute, 'Por minuto', 0, 100_000),
      whole(b.per_day, 'Por dia', 0, 10_000_000),
      whole(b.wait_s, 'Espera', 5, 600),
      b.free_fallback ? 1 : 0,
      key,
    );
    this.router.reload();
    return this.configuration();
  }

  saveRoute(id, b) {
    const job = String(b.job ?? '');
    const model = String(b.model ?? '').trim();
    need(this.router.jobs.has(job), 'Pedido desconhecido.');
    need(this.router.providers.has(Number(b.provider_id)), 'API desconhecida.');
    need(model && model.length <= 200 && !/\s/.test(model), 'Modelo: obrigatório, sem espaços.');
    const v = [
      Number(b.provider_id), model, b.enabled === false || b.enabled === 0 ? 0 : 1,
      whole(b.max_concurrency ?? 32, 'Ao mesmo tempo', 1, 10_000),
      whole(b.rpm ?? 0, 'Por minuto', 0, 1_000_000),
      amount(b.price_in ?? 0, 'Preço de entrada'), amount(b.price_out ?? 0, 'Preço de saída'),
      whole(b.timeout_s ?? 90, 'Tempo limite', 5, 600),
      jsonObject(b.extra, 'Extras'),
    ];
    if (id === null) {
      const pos = this.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM routes WHERE job = ?').get(job).p;
      this.db.prepare('INSERT INTO routes(job,position,provider_id,model,enabled,max_concurrency,rpm,price_in,price_out,timeout_s,extra) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(job, pos, ...v);
    } else {
      this.db.prepare('UPDATE routes SET provider_id=?, model=?, enabled=?, max_concurrency=?, rpm=?, price_in=?, price_out=?, timeout_s=?, extra=? WHERE id=?').run(...v, id);
    }
    this.router.reload();
    return this.configuration();
  }

  deleteRoute(id) {
    this.db.prepare('DELETE FROM routes WHERE id = ?').run(id);
    this.router.reload();
    return this.configuration();
  }

  moveRoute(id, dir) {
    const r = this.db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
    need(r && (dir === 1 || dir === -1), 'Não deu pra mover.');
    const list = this.db.prepare('SELECT id FROM routes WHERE job = ? ORDER BY position, id').all(r.job).map((x) => x.id);
    const at = list.indexOf(id);
    const to = at + dir;
    if (to >= 0 && to < list.length) {
      [list[at], list[to]] = [list[to], list[at]];
      list.forEach((rid, i) => this.db.prepare('UPDATE routes SET position = ? WHERE id = ?').run(i + 1, rid));
    }
    this.router.reload();
    return this.configuration();
  }

  /** A word to the model, to see that the key, the address and the name are right. It costs a few tokens. */
  async testRoute(id) {
    const r = this.router.routes.get(id);
    const p = r && this.router.providers.get(r.provider_id);
    need(r && p, 'Modelo desconhecido.');
    need(this.router.keyOf(p), `Falta a chave de ${p.name}.`);
    const t0 = this.now();
    try {
      const body = merge(merge({ model: r.model, stream: false, max_tokens: 2000, messages: [{ role: 'user', content: 'Responda só com a palavra: ok' }] }, p.extra), r.extra);
      const out = await chat({ baseUrl: p.base_url, key: this.router.keyOf(p), headers: p.headers, body, timeoutMs: 60_000, fetcher: this.fetcher });
      const cost = out.cost ?? (out.tokensIn * r.price_in + out.tokensOut * r.price_out) / 1e6;
      return { ok: true, ms: this.now() - t0, text: out.text.trim().slice(0, 120), tokens_in: out.tokensIn, tokens_out: out.tokensOut, cost };
    } catch (e) {
      return { ok: false, ms: this.now() - t0, error: `${e.status ? `HTTP ${e.status}: ` : ''}${e.message}`.slice(0, 300) };
    }
  }

  /**
   * Everything kept of one phone, erased (the person asked: the right to have one's data deleted):
   * its key, its plan record, what was counted of it. Its cloud backup isn't touched — only who
   * has its secret can erase that, in the app. The app, if still installed, registers again as new.
   */
  deleteDevice(id) {
    const d = this.db.prepare('SELECT install FROM devices WHERE id = ?').get(id);
    need(d, 'Aparelho desconhecido.');
    const install = d.install || `d:${id}`;
    this.limits.flush();
    this.telemetry.forget(id, install);
    this.limits.forget(install);
    this.devices.remove(id);
    this.plans.remove(install);
    event(this.db, 'aparelho', `Registro do aparelho ${id.slice(0, 10)} apagado pelo painel.`);
    return { ok: true };
  }

  saveDevice(id, b) {
    const d = this.db.prepare('SELECT install, status, note FROM devices WHERE id = ?').get(id);
    need(d, 'Aparelho desconhecido.');
    if ('status' in b) this.devices.setStatus(id, b.status === 'blocked' ? 'blocked' : 'ok', b.note ?? '');
    if ('plan' in b) {
      need(['plus', 'trial', 'ended'].includes(b.plan), 'Plano: plus, trial ou ended.');
      const install = d.install || `d:${id}`;
      this.plans.ensure(install);
      this.plans.set(install, b.plan);
    }
    return { ok: true };
  }
}
