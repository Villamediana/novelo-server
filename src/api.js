// What the app talks to. The app sends the request ready (the prompt, the photo or the sound, as a
// chat request without a model); here it is checked, queued, sent to a model and answered. See
// docs/PROTOCOLO.md.
import crypto from 'node:crypto';
import { HttpError, readBody, parseJson, sendJson, sendError, clientIp } from './http.js';
import { BLOB_MAX, MANIFEST_MAX } from './vaults.js';

const HEARTBEAT = 10_000;
const KEEP_DONE = 10 * 60_000;
const KEEP_BYTES = 64 * 1024 * 1024;
const ROLES = new Set(['system', 'developer', 'user', 'assistant']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high']);
const AUDIO = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'webm']);
const IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/;

const bad = (message) => new HttpError(422, 'bad_request', message);

function cacheControl(part) {
  return part.cache_control && typeof part.cache_control.type === 'string' ? { cache_control: { type: part.cache_control.type.slice(0, 20) } } : {};
}

/**
 * The request as it goes on to the model: only what a chat request needs, nothing that picks the
 * model, turns on paid extras (tools, web search, plugins) or makes the provider fetch an address.
 */
export function prepare(job, body) {
  const accepts = new Set(job.accepts.split(',').map((s) => s.trim()));
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 64) throw bad('messages: de 1 a 64 mensagens.');
  const messages = body.messages.map((m) => {
    if (!m || typeof m !== 'object' || !ROLES.has(m.role)) throw bad('messages: papel inválido.');
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    if (!Array.isArray(m.content) || !m.content.length || m.content.length > 32) throw bad('messages: conteúdo inválido.');
    const content = m.content.map((p) => {
      if (p?.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text, ...cacheControl(p) };
      if (p?.type === 'image_url' && accepts.has('image')) {
        const url = p.image_url?.url;
        if (typeof url !== 'string' || !IMAGE.test(url)) throw bad('imagem: só JPEG, PNG ou WebP dentro do pedido (data:).');
        const detail = ['low', 'high', 'auto'].includes(p.image_url.detail) ? { detail: p.image_url.detail } : {};
        return { type: 'image_url', image_url: { url, ...detail } };
      }
      if (p?.type === 'input_audio' && accepts.has('audio')) {
        const a = p.input_audio;
        if (typeof a?.data !== 'string' || !AUDIO.has(a.format)) throw bad('áudio: data (base64) e format.');
        return { type: 'input_audio', input_audio: { data: a.data, format: a.format } };
      }
      throw bad(`conteúdo não aceito neste pedido: ${String(p?.type).slice(0, 30)}.`);
    });
    return { role: m.role, content };
  });
  const out = { messages };
  const rf = body.response_format;
  if (rf && typeof rf === 'object' && ['json_object', 'json_schema', 'text'].includes(rf.type)) out.response_format = rf;
  if (EFFORTS.has(body.reasoning_effort)) out.reasoning_effort = body.reasoning_effort;
  if (body.reasoning && typeof body.reasoning === 'object' && EFFORTS.has(body.reasoning.effort)) {
    out.reasoning = { effort: body.reasoning.effort, ...(typeof body.reasoning.exclude === 'boolean' ? { exclude: body.reasoning.exclude } : {}) };
  }
  for (const k of ['temperature', 'top_p']) if (typeof body[k] === 'number' && body[k] >= 0 && body[k] <= 2) out[k] = body[k];
  if (Number.isInteger(body.seed)) out.seed = body.seed;
  if (typeof body.stop === 'string') out.stop = body.stop.slice(0, 64);
  else if (Array.isArray(body.stop)) out.stop = body.stop.filter((s) => typeof s === 'string').slice(0, 4).map((s) => s.slice(0, 64));
  const asked = Number(body.max_tokens ?? body.max_completion_tokens);
  out.max_tokens = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), job.max_output_tokens) : job.max_output_tokens;
  return out;
}

export class Api {
  constructor({ config, settings, devices, limits, router, telemetry, plans, vaults, now = Date.now, heartbeatMs = HEARTBEAT }) {
    this.plans = plans;
    this.vaults = vaults;
    this.carries = new Map(); // device → { start, n } (backup pieces a minute)
    this.heartbeatMs = heartbeatMs;
    this.config = config;
    this.settings = settings;
    this.devices = devices;
    this.limits = limits;
    this.router = router;
    this.telemetry = telemetry;
    this.now = now;
    this.trust = config.get('TRUST_PROXY', 'none');
    this.maxHeld = config.int('MAX_HELD_MB', 1024) * 1024 * 1024;
    this.maxOpen = config.int('MAX_OPEN', 20_000);
    this.held = 0;
    this.open = 0;
    this.runs = new Map(); // device:request → { promise, done, at, size, listeners, gone }
    this.kept = 0;
    this.knocks = new Map(); // address → { start, n } (registration only)
    this.sweep = setInterval(() => this.clean(), 30_000);
    this.sweep.unref();
  }

  stop() {
    clearInterval(this.sweep);
  }

  clean() {
    const now = this.now();
    for (const [k, r] of this.runs) {
      if (r.done && (now - r.at > KEEP_DONE || this.kept > KEEP_BYTES)) {
        this.kept -= r.size;
        this.runs.delete(k);
      }
    }
    for (const [k, v] of this.knocks) if (now - v.start > 60_000) this.knocks.delete(k);
    for (const [k, v] of this.carries) if (now - v.start > 60_000) this.carries.delete(k);
  }

  /** Registration has no signature yet: an address may knock so many times a minute. */
  knock(req) {
    const ip = clientIp(req, this.trust);
    const now = this.now();
    let k = this.knocks.get(ip);
    if (!k || now - k.start > 60_000) this.knocks.set(ip, (k = { start: now, n: 0 }));
    if (++k.n > 30) throw new HttpError(429, 'rate_limited', 'Muitos pedidos em pouco tempo.', { retry_after: 60 });
    return ip;
  }

  async handle(req, res) {
    const path = (req.url || '/').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true, time: this.now() });
      if (req.method === 'POST' && path === '/v1/devices/challenge') {
        this.knock(req);
        req.resume();
        return sendJson(res, 200, this.devices.challenge());
      }
      if (req.method === 'POST' && path === '/v1/devices') {
        const ip = this.knock(req);
        const body = parseJson(await readBody(req, 64 * 1024));
        return sendJson(res, 200, this.devices.register(body, ip, this.limits.day()));
      }
      const ask = /^\/v1\/ask\/([a-z][a-z0-9_]{0,31})$/.exec(path);
      if (req.method === 'POST' && ask) return await this.ask(req, res, path, ask[1]);
      if (req.method === 'GET' && path === '/v1/me') {
        const who = await this.signed(req, path, 0);
        return sendJson(res, 200, { plan: this.plans.of(who.install), now: this.now() });
      }
      const bk = /^\/v1\/backup\/([A-Za-z0-9_-]{32})(?:\/(have|manifest|blobs)(?:\/([A-Za-z0-9_-]{1,43}))?)?$/.exec(path);
      if (bk) return await this.backup(req, res, path, bk[1], bk[2] ?? '', bk[3] ?? '');
      req.resume();
      return sendJson(res, 404, { error: { code: 'not_found', message: 'Não existe.' } });
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('api:', e);
      return sendError(res, e);
    }
  }

  /** A signed request that isn't an ask: the phone behind it and its body (at most [limit] bytes). */
  async signed(req, path, limit) {
    const claimed = String(req.headers['x-novelo-device'] ?? '');
    const known = /^[A-Za-z0-9_-]{24}$/.test(claimed) ? this.devices.load(claimed) : null;
    if (!known) throw new HttpError(401, 'unknown_device', 'Aparelho não registrado.');
    const raw = limit ? await readBody(req, limit) : (req.resume(), Buffer.alloc(0));
    const who = this.devices.authenticate(req, path, crypto.createHash('sha256').update(raw).digest('hex'));
    return { ...who, raw };
  }

  /**
   * The backup in the cloud (see vaults.js). Sending needs Novelo+; reading back and erasing one's
   * own backup never does — what she kept is hers whatever plan she has now.
   */
  async backup(req, res, path, vaultId, what, piece) {
    if (this.settings.get('paused')) throw new HttpError(503, 'paused', 'Em manutenção.', { retry_after: 300 });
    const m = req.method;
    const limit = m === 'PUT' && what === 'blobs' ? BLOB_MAX : m === 'PUT' && what === 'manifest' ? MANIFEST_MAX * 1.4 : m === 'POST' ? 2 * 1024 * 1024 : 0;
    const declared = Number(req.headers['content-length'] || 0);
    if (this.held + declared > this.maxHeld) throw new HttpError(503, 'busy', 'Servidor cheio.', { retry_after: 15 });
    this.held += declared;
    try {
      const who = await this.signed(req, path, limit);
      const now = this.now();
      let c = this.carries.get(who.id);
      if (!c || now - c.start > 60_000) this.carries.set(who.id, (c = { start: now, n: 0 }));
      if (++c.n > 1200) throw new HttpError(429, 'rate_limited', 'Muitos pedidos em pouco tempo.', { retry_after: 60 });
      const token = req.headers['x-novelo-vault'];
      const writes = m === 'PUT' || m === 'POST';
      if (writes && !this.plans.of(who.install).backup) throw new HttpError(402, 'plan', 'O backup na nuvem é do Novelo+.', { plan: this.plans.of(who.install) });
      const v = this.vaults.open(vaultId, token, { create: writes, install: who.install, day: this.limits.day() });
      const bytes = (data, extra = {}) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
        res.end(data);
      };
      if (!what && m === 'GET') return sendJson(res, 200, this.vaults.info(v));
      if (!what && m === 'DELETE') return sendJson(res, 200, this.vaults.erase(v.id));
      if (what === 'have' && m === 'POST') return sendJson(res, 200, { missing: this.vaults.missing(v, parseJson(who.raw).ids) });
      if (what === 'blobs' && piece.length === 43 && m === 'PUT') return sendJson(res, 200, this.vaults.putBlob(v, piece, who.raw));
      if (what === 'blobs' && piece.length === 43 && m === 'GET') return bytes(this.vaults.getBlob(v, piece));
      if (what === 'manifest' && m === 'PUT') {
        const body = parseJson(who.raw);
        const data = Buffer.from(String(body.data ?? ''), 'base64');
        return sendJson(res, 200, this.vaults.putManifest(v, data, body.refs ?? []));
      }
      if (what === 'manifest' && m === 'GET' && (!piece || /^\d{1,16}$/.test(piece))) {
        const got = this.vaults.getManifest(v, piece ? Number(piece) : 0);
        return bytes(got.data, { 'X-Novelo-Manifest': String(got.id) });
      }
      throw new HttpError(404, 'not_found', 'Não existe.');
    } finally {
      this.held -= declared;
    }
  }

  async ask(req, res, path, jobKey) {
    if (this.settings.get('paused')) throw new HttpError(503, 'paused', 'Em manutenção.', { retry_after: 300 });
    const job = this.router.jobs.get(jobKey);
    if (!job || !job.enabled) throw new HttpError(404, 'not_found', 'Pedido desconhecido.');
    // Before reading megabytes: is it a phone we know?
    const claimed = String(req.headers['x-novelo-device'] ?? '');
    const known = /^[A-Za-z0-9_-]{24}$/.test(claimed) ? this.devices.load(claimed) : null;
    if (!known) throw new HttpError(401, 'unknown_device', 'Aparelho não registrado.');
    if (known.status === 'blocked') throw new HttpError(403, 'blocked', 'Este aparelho está bloqueado.');
    const declared = Number(req.headers['content-length'] || 0);
    if (this.open >= this.maxOpen || this.held + declared > this.maxHeld) throw new HttpError(503, 'busy', 'Servidor cheio.', { retry_after: 15 });

    this.open++;
    let size = 0;
    try {
      const raw = await readBody(req, job.max_body_kb * 1024);
      size = raw.length;
      this.held += size;
      const { id: device, request, install } = this.devices.authenticate(req, path, crypto.createHash('sha256').update(raw).digest('hex'));
      // The trial is over and it isn't Novelo+: the app goes on with its own intelligence (the phone's, or an API).
      this.plans.need(install);
      const key = `${device}:${request}`;

      // The same request again (the connection dropped, the app retried): the same answer, asked once.
      let run = this.runs.get(key);
      if (!run) {
        const not = String(req.headers['x-novelo-not'] ?? '').split(',').map((s) => s.trim()).filter((s) => /^(r\d{1,9}|f:[\w./:-]{1,120})$/.test(s)).slice(0, 8);
        this.limits.admit(device, job);
        let body;
        try {
          body = prepare(job, parseJson(raw));
        } catch (e) {
          this.limits.refund(device, job.key);
          throw e;
        }
        for (const mark of not) this.telemetry.bad(job.key, this.router.bad(mark));
        run = this.start(key, device, job, body, not, size);
      }
      await this.respond(req, res, run, request);
    } finally {
      this.open--;
      this.held -= size;
    }
  }

  start(key, device, job, body, not, bytesIn) {
    const t0 = this.now();
    const gone = { left: false, leave: null };
    const run = { done: false, at: 0, size: 0, listeners: 0, gone, result: null };
    run.promise = this.router.run(job, body, { not, gone }).catch((e) => {
      console.error('run:', e);
      return { ok: false, code: 'internal', message: 'Erro interno.', provider: '', model: '', free: false, attempts: 0, queueMs: 0, upstreamMs: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
    }).then((r) => {
      const now = this.now();
      run.done = true;
      run.at = now;
      run.result = r;
      run.size = r.text ? Buffer.byteLength(r.text) : 0;
      this.kept += run.size;
      if (r.ok) this.limits.addCost(device, job.key, r.cost);
      // A request that got no answer doesn't use up the day.
      else this.limits.refund(device, job.key);
      this.telemetry.record({
        ts: now, device, job: job.key, provider: r.provider, model: r.model, free: r.free, ok: r.ok, code: r.code || '',
        attempts: r.attempts, queueMs: Math.round(r.queueMs), upstreamMs: Math.round(r.upstreamMs), totalMs: now - t0,
        tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost || 0, bytesIn, bytesOut: run.size,
      });
      // Nobody got it and nobody can ask again for a failure worth keeping: let go of it sooner.
      if (!r.ok) this.runs.delete(key);
      return r;
    });
    this.runs.set(key, run);
    return run;
  }

  /**
   * Answers when the run ends. A wait longer than a few seconds starts the answer early (200 and
   * a space every few seconds, which JSON ignores) so no proxy on the way gives up on a silent
   * connection; the outcome, good or not, is then in the body.
   */
  async respond(req, res, run, request) {
    run.listeners++;
    let beat = null;
    const onClose = () => {
      if (res.writableEnded) return;
      clearInterval(beat);
      run.listeners--;
      // Still in line and nobody waiting: leave it. Already with a model: it ends and is kept for the retry.
      if (run.listeners <= 0 && !run.done) {
        run.gone.left = true;
        run.gone.leave?.();
      }
    };
    res.on('close', onClose);
    if (!run.done) {
      beat = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no',
            'X-Content-Type-Options': 'nosniff',
          });
        }
        res.write(' ');
      }, this.heartbeatMs);
    }
    const r = run.done ? run.result : await run.promise;
    clearInterval(beat);
    if (res.destroyed || res.writableEnded) return;
    if (r.ok) {
      sendJson(res, 200, {
        id: request,
        choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
        novelo: { route: r.route, free: r.free },
      });
      return;
    }
    const status = r.code === 'refused' ? 422 : r.code === 'internal' ? 500 : 503;
    const retry = r.code === 'budget' ? this.limits.secondsToMidnight() : r.code === 'busy' ? 20 : r.code === 'not_configured' ? 300 : 0;
    const messages = {
      busy: 'Os modelos estão ocupados. Tente de novo em instantes.',
      budget: 'A inteligência do Novelo volta amanhã.',
      not_configured: 'A inteligência do Novelo ainda não está pronta.',
      refused: 'O pedido não foi aceito pelo modelo.',
      internal: 'Erro interno.',
    };
    sendJson(res, status, { error: { code: r.code, message: messages[r.code] ?? 'Não deu.', ...(retry ? { retry_after: retry } : {}) } }, retry ? { 'Retry-After': String(retry) } : {});
  }
}
