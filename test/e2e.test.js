import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeUpstream, startServer, Phone, panel, sleep } from './helpers.js';

async function setup(script, opts = {}) {
  const upstream = await fakeUpstream(script ?? (() => ({ text: 'resposta' })));
  const server = await startServer({ upstream, ...opts });
  const phone = new Phone(server.url);
  await phone.register();
  return { upstream, server, phone, close: async () => { await server.close(); await upstream.close(); } };
}

test('a phone registers, asks, and gets the model\'s answer', async () => {
  const s = await setup(() => ({ text: '{"plano":1}', cost: 0.002 }));
  try {
    s.server.route('think', 'openai/modelo-a');
    const r = await s.phone.ask('think', {
      model: 'outro/modelo-caro', tools: [{ type: 'web_search' }], plugins: [{ id: 'web' }], stream: true,
      messages: [{ role: 'system', content: 'instruções' }, { role: 'user', content: 'comprar pão' }],
      response_format: { type: 'json_object' }, reasoning_effort: 'low', max_tokens: 999999,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, '{"plano":1}');
    assert.equal(r.json.novelo.route, 'r1');
    // What went on to the model: the server's model, nothing the phone may not ask for.
    const sent = s.upstream.calls[0].json;
    assert.equal(sent.model, 'openai/modelo-a');
    assert.equal(sent.stream, false);
    assert.equal(sent.tools, undefined);
    assert.equal(sent.plugins, undefined);
    assert.equal(sent.max_tokens, 16000);
    assert.deepEqual(sent.usage, { include: true });
    assert.equal(sent.reasoning_effort, 'low');
    assert.equal(s.upstream.calls[0].headers.authorization, 'Bearer sk-test-1234');
    // The numbers are kept; the words are not.
    s.server.app.flush();
    const row = s.server.app.db.prepare('SELECT * FROM requests').get();
    assert.equal(row.ok, 1);
    assert.equal(row.model, 'openai/modelo-a');
    assert.equal(row.cost, 0.002);
    assert.equal(row.tokens_in, 100);
    const dump = fs.readFileSync(`${s.server.dir}/data/novelo.db`).toString('latin1') + (fs.existsSync(`${s.server.dir}/data/novelo.db-wal`) ? fs.readFileSync(`${s.server.dir}/data/novelo.db-wal`).toString('latin1') : '');
    assert.equal(dump.includes('comprar p'), false);
    assert.equal(dump.includes('plano'), false);
    assert.equal(dump.includes('sk-test-1234'), false);
  } finally {
    await s.close();
  }
});

test('no signature, a wrong one, an old clock, an unknown phone: nothing reaches a model', async () => {
  const s = await setup();
  try {
    s.server.route('think', 'm');
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'oi' }] });
    const post = (headers) => fetch(`${s.server.url}/v1/ask/think`, { method: 'POST', headers, body }).then(async (r) => ({ status: r.status, json: await r.json() }));
    const good = s.phone.headers('/v1/ask/think', body);
    assert.equal((await post({ 'Content-Type': 'application/json' })).json.error.code, 'unknown_device');
    assert.equal((await post({ ...good, 'X-Novelo-Device': 'A'.repeat(24) })).json.error.code, 'unknown_device');
    assert.equal((await post({ ...s.phone.headers('/v1/ask/see', body) })).json.error.code, 'bad_signature');
    assert.equal((await post({ ...s.phone.headers('/v1/ask/think', body + ' ') })).json.error.code, 'bad_signature');
    const old = await post(s.phone.headers('/v1/ask/think', body, { time: Date.now() - 6 * 60_000 }));
    assert.equal(old.json.error.code, 'stale_time');
    assert.ok(Math.abs(old.json.error.now - Date.now()) < 5000);
    const other = new Phone(s.server.url);
    other.id = s.phone.id;
    assert.equal((await post(other.headers('/v1/ask/think', body))).json.error.code, 'bad_signature');
    assert.equal(s.upstream.calls.length, 0);
    assert.equal((await post(good)).status, 200);
  } finally {
    await s.close();
  }
});

test('the same request sent twice is asked once', async () => {
  const s = await setup(() => ({ text: 'uma vez', delay: 150 }));
  try {
    s.server.route('think', 'm');
    const request = 'pedido-repetido-0001';
    const [a, b] = await Promise.all([s.phone.ask('think', undefined, { request }), s.phone.ask('think', undefined, { request })]);
    const c = await s.phone.ask('think', undefined, { request });
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
    assert.equal(c.json.choices[0].message.content, 'uma vez');
    assert.equal(s.upstream.calls.length, 1);
    s.server.app.flush();
    assert.equal(s.server.app.db.prepare('SELECT COUNT(*) n FROM requests').get().n, 1);
  } finally {
    await s.close();
  }
});

test('429 from the model: the request waits here and is answered, not failed', async () => {
  const s = await setup((json, headers, n) => (n <= 2 ? { status: 429, headers: { 'Retry-After': '1' } } : { text: 'depois da espera' }));
  try {
    s.server.route('think', 'm');
    const t0 = Date.now();
    const r = await s.phone.ask('think');
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'depois da espera');
    assert.ok(Date.now() - t0 >= 1900, 'waited for the two Retry-After');
    assert.equal(s.upstream.calls.length, 3);
    s.server.app.flush();
    assert.equal(s.server.app.db.prepare('SELECT attempts FROM requests').get().attempts, 3);
  } finally {
    await s.close();
  }
});

test('a model that fails makes way for the next; one that refuses the request is not asked again', async () => {
  const s = await setup((json) => {
    if (json.model === 'a') return { status: 500 };
    if (json.model === 'b') return { status: 400, message: 'não aceito response_format' };
    return { text: `de ${json.model}` };
  });
  try {
    s.server.route('think', 'a');
    s.server.route('think', 'b');
    s.server.route('think', 'c');
    const r = await s.phone.ask('think');
    assert.equal(r.json.choices[0].message.content, 'de c');
    assert.deepEqual(s.upstream.calls.map((c) => c.json.model), ['a', 'b', 'c']);
    // The phone found the answer of r3 unusable: asked again, that model is skipped (and the
    // others go on being tried for as long as the job waits).
    s.server.job('think', { wait_s: 3 });
    const again = await s.phone.ask('think', undefined, { not: 'r3' });
    assert.equal(again.status, 422);
    assert.equal(again.json.error.code, 'refused');
    s.server.app.flush();
    assert.equal(s.server.app.db.prepare("SELECT SUM(bad) n FROM agg_hour WHERE model = 'c'").get().n, 1);
  } finally {
    await s.close();
  }
});

test('every model out: the free ones are tried, as the app used to do', async () => {
  const s = await setup((json) => {
    if (json.model === 'pago') return { status: 503 };
    if (json.model === 'gratis/ruim:free') return { status: 429 };
    return { text: `de ${json.model}` };
  });
  try {
    s.upstream.state.models = [
      { id: 'gratis/ruim:free', created: 30, context_length: 64000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: [] },
      { id: 'gratis/bom:free', created: 20, context_length: 64000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['response_format'] },
      { id: 'gratis/pequeno:free', created: 40, context_length: 8000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
      { id: 'pago/caro', created: 50, context_length: 64000, pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    ];
    s.server.route('think', 'pago');
    const r = await s.phone.ask('think', { messages: [{ role: 'user', content: 'oi' }], response_format: { type: 'json_object' }, reasoning_effort: 'low' });
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'de gratis/bom:free');
    assert.deepEqual(r.json.novelo, { route: 'f:gratis/bom:free', free: true });
    const free = s.upstream.calls.filter((c) => c.json.model.endsWith(':free'));
    assert.deepEqual(free.map((c) => c.json.model), ['gratis/ruim:free', 'gratis/bom:free']);
    // Each free model gets only what it takes.
    assert.equal(free[0].json.response_format, undefined);
    assert.deepEqual(free[1].json.response_format, { type: 'json_object' });
    assert.equal(free[1].json.reasoning_effort, undefined);
    // With the last resort off, the request waits for the model and then says "busy".
    s.server.job('think', { free_fallback: 0, wait_s: 1 });
    const busy = await s.phone.ask('think');
    assert.equal(busy.status, 503);
    assert.equal(busy.json.error.code, 'busy');
    assert.ok(busy.headers.get('retry-after'));
  } finally {
    await s.close();
  }
});

test('the ceiling of the day stops the paid models; a request without an answer does not use up the day', async () => {
  const s = await setup(() => ({ text: 'ok', cost: 0.6 }));
  try {
    s.server.route('think', 'pago');
    s.server.app.settings.set('budget_day_usd', 1);
    s.server.app.settings.set('device_day_usd', 0);
    s.server.job('think', { free_fallback: 0 });
    assert.equal((await s.phone.ask('think')).status, 200);
    assert.equal((await s.phone.ask('think')).status, 200);
    const over = await s.phone.ask('think');
    assert.equal(over.status, 503);
    assert.equal(over.json.error.code, 'budget');
    assert.equal(s.upstream.calls.length, 2);
    assert.equal(s.server.app.limits.device(`d:${s.phone.id}`).jobs.get('think').requests, 2);
    assert.match(s.server.app.db.prepare("SELECT message FROM events WHERE kind = 'teto'").get().message, /Teto de gasto do dia/);
    // What was spent this month is read back from the hourly totals (what is counted per phone doesn't stay).
    s.server.app.flush();
    s.server.app.telemetry.prune(30);
    s.server.app.db.prepare('DELETE FROM usage_day').run();
    s.server.app.limits.days.clear();
    s.server.app.limits.loadSpent();
    assert.ok(Math.abs(s.server.app.limits.spent.monthUsd - 1.2) < 1e-9);
    s.server.app.limits.spent.dayUsd = 1.2;
    // A free model configured by hand still answers.
    s.server.route('think', 'algum/modelo:free');
    assert.equal((await s.phone.ask('think')).status, 200);
  } finally {
    await s.close();
  }
});

test('one phone: so many a minute, so many a day, so many dollars a day', async () => {
  const s = await setup(() => ({ text: 'ok', cost: 0.1 }));
  try {
    s.server.route('think', 'm');
    s.server.route('see', 'm');
    s.server.job('think', { per_minute: 2 });
    assert.equal((await s.phone.ask('think')).status, 200);
    assert.equal((await s.phone.ask('think')).status, 200);
    const fast = await s.phone.ask('think');
    assert.equal(fast.status, 429);
    assert.equal(fast.json.error.code, 'rate_limited');
    assert.ok(Number(fast.headers.get('retry-after')) <= 60);
    // The dollars of the day (0.25): two answers made 0.2, the third makes 0.3, the fourth is refused.
    assert.equal((await s.phone.ask('see', { messages: [{ role: 'user', content: 'oi' }] })).status, 200);
    const spent = await s.phone.ask('see');
    assert.equal(spent.status, 429);
    assert.equal(spent.json.error.code, 'quota');
    // Another phone is not affected.
    const other = new Phone(s.server.url);
    await other.register();
    assert.equal((await other.ask('see')).status, 200);
    // Blocked in the panel.
    s.server.app.devices.setStatus(other.id, 'blocked');
    assert.equal((await other.ask('see')).json.error.code, 'blocked');
  } finally {
    await s.close();
  }
});

test('each job takes only its kind of content, of a limited size', async () => {
  const s = await setup();
  try {
    for (const job of ['hear', 'see', 'think']) s.server.route(job, 'm');
    const image = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ', detail: 'low' } };
    const audio = { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } };
    const text = { type: 'text', text: 'o que é isto?' };
    const ask = (job, parts) => s.phone.ask(job, { messages: [{ role: 'user', content: parts }] });
    assert.equal((await ask('see', [text, image])).status, 200);
    assert.deepEqual(s.upstream.calls.at(-1).json.messages[0].content[1], image);
    assert.equal((await ask('hear', [text, audio])).status, 200);
    assert.equal((await ask('think', [text, image])).status, 422);
    assert.equal((await ask('see', [text, audio])).status, 422);
    assert.equal((await ask('see', [text, { type: 'image_url', image_url: { url: 'https://exemplo.com/foto.jpg' } }])).status, 422);
    assert.equal((await s.phone.ask('think', { messages: [] })).status, 422);
    assert.equal((await s.phone.ask('think', 'isto não é json')).status, 422);
    assert.equal((await s.phone.ask('nada')).status, 404);
    s.server.job('think', { max_body_kb: 16 });
    assert.equal((await s.phone.ask('think', { messages: [{ role: 'user', content: 'x'.repeat(20_000) }] })).status, 413);
    // None of the refused ones counted against the phone's day.
    assert.equal(s.server.app.limits.device(`d:${s.phone.id}`).jobs.get('think')?.requests ?? 0, 0);
  } finally {
    await s.close();
  }
});

test('a long wait keeps the connection alive and still ends in valid JSON', async () => {
  const s = await setup(() => ({ text: 'demorou', delay: 400 }), { heartbeatMs: 60 });
  try {
    s.server.route('think', 'm');
    const r = await s.phone.ask('think');
    assert.equal(r.status, 200);
    assert.match(r.raw, /^ {3,}\{/);
    assert.equal(r.json.choices[0].message.content, 'demorou');
    // A failure after the answer began comes in the body.
    s.upstream.state.script = () => ({ status: 400, delay: 200 });
    const bad = await s.phone.ask('think');
    assert.equal(bad.status, 200);
    assert.equal(bad.json.error.code, 'refused');
  } finally {
    await s.close();
  }
});

test('many at once: all answered, never more in the model than the lane allows', async () => {
  let now = 0;
  let peak = 0;
  const s = await setup(async () => {
    peak = Math.max(peak, ++now);
    await sleep(20);
    now--;
    return { text: 'ok' };
  });
  try {
    s.server.route('think', 'm', { max_concurrency: 8 });
    s.server.job('think', { per_minute: 0 });
    const phones = await Promise.all(Array.from({ length: 4 }, async () => { const p = new Phone(s.server.url); await p.register(); return p; }));
    const all = await Promise.all(Array.from({ length: 200 }, (_, i) => phones[i % 4].ask('think')));
    assert.equal(all.filter((r) => r.status === 200).length, 200);
    assert.ok(peak <= 8, `peak ${peak}`);
    assert.equal(s.server.app.router.dispatcher.waiting(), 0);
  } finally {
    await s.close();
  }
});

test('registration: the proof of the key, the limit per address, and "require"', async () => {
  const s = await setup();
  try {
    const again = await s.phone.register();
    assert.equal(again.json.device, s.phone.id);
    assert.equal(again.json.verified, false);
    const liar = new Phone(s.server.url);
    assert.equal((await liar.register({ proof: 'AAAA' })).json.error.code, 'bad_proof');
    assert.equal((await liar.register({ challenge: 'A'.repeat(54) })).json.error.code, 'bad_challenge');
    s.server.app.settings.set('register_per_ip_day', 2);
    assert.equal((await new Phone(s.server.url).register()).status, 200);
    assert.equal((await new Phone(s.server.url).register()).json.error.code, 'rate_limited');
    s.server.app.settings.set('register_per_ip_day', 0);
    // Demanding the phone's proof: no proof, no registration — and the ones without it must come back.
    s.server.app.settings.set('attestation', 'require');
    const strict = await new Phone(s.server.url).register();
    assert.equal(strict.status, 403);
    assert.equal(strict.json.error.code, 'attestation');
    s.server.route('think', 'm');
    assert.equal((await s.phone.ask('think')).json.error.code, 'unknown_device');
  } finally {
    await s.close();
  }
});

test('the panel: password, models, keys in the .env only, phones', async () => {
  const s = await setup(() => ({ text: 'ok', cost: 0.001 }));
  try {
    const anon = await fetch(`${s.server.adminUrl}/api/config`);
    assert.equal(anon.status, 401);
    const wrong = await fetch(`${s.server.adminUrl}/api/login`, { method: 'POST', headers: { 'X-Novelo-Admin': '1' }, body: JSON.stringify({ password: 'errada' }) });
    assert.equal(wrong.status, 401);
    const csrf = await fetch(`${s.server.adminUrl}/api/login`, { method: 'POST', body: JSON.stringify({ password: s.server.password }) });
    assert.equal(csrf.status, 422);
    const call = await panel(s.server);

    s.upstream.state.models = [
      { id: 'a/texto', name: 'Texto', context_length: 64000, pricing: { prompt: '0.0000001', completion: '0.0000005' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
      { id: 'a/olho', name: 'Olho', context_length: 64000, pricing: { prompt: '0.0000002', completion: '0.0000008' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    ];
    const forSee = await call('GET', '/api/providers/1/models?job=see');
    // All of them, with what each takes: the ones that see first, the others after, marked.
    assert.deepEqual(forSee.json.models.map((m) => [m.id, m.fits]), [['a/olho', true], ['a/texto', false]]);
    assert.deepEqual(forSee.json.models[0].input, ['text', 'image']);
    assert.ok(Math.abs(forSee.json.models[0].price_out - 0.8) < 1e-9);
    // Connected: the key is there and the API answers with its models.
    const tried = (await call('POST', '/api/providers/1/test')).json;
    assert.equal(tried.ok, true);
    assert.equal(tried.models, 2);

    let cfg = (await call('POST', '/api/routes', { job: 'think', provider_id: 1, model: 'a/texto', price_in: 0.1, price_out: 0.5 })).json;
    // The panel sees what /health says, without asking twice.
    assert.equal(cfg.ready.think, true);
    assert.equal(typeof cfg.ready.hear, 'boolean');
    cfg = (await call('POST', '/api/routes', { job: 'think', provider_id: 1, model: 'a/olho' })).json;
    const [first, second] = cfg.routes;
    cfg = (await call('POST', `/api/routes/${second.id}/move`, { dir: -1 })).json;
    assert.deepEqual(cfg.routes.map((r) => r.model), ['a/olho', 'a/texto']);
    assert.equal((await call('POST', '/api/routes', { job: 'think', provider_id: 1, model: 'x', extra: '[1]' })).status, 422);
    const tested = (await call('POST', `/api/routes/${first.id}/test`)).json;
    assert.equal(tested.ok, true);
    assert.equal(tested.text, 'ok');

    // The key is written to the .env and nowhere else; the panel shows only its end.
    cfg = (await call('PUT', '/api/providers/1/key', { value: 'sk-or-nova-chave-9876' })).json;
    assert.equal(cfg.providers[0].key_tail, '9876');
    assert.equal(JSON.stringify(cfg).includes('nova-chave'), false);
    assert.match(fs.readFileSync(s.server.envFile, 'utf8'), /^OPENROUTER_API_KEY=sk-or-nova-chave-9876$/m);
    assert.equal(fs.statSync(s.server.envFile).mode & 0o777, 0o600);
    assert.equal((await s.phone.ask('think')).status, 200);
    assert.equal(s.upstream.calls.at(-1).headers.authorization, 'Bearer sk-or-nova-chave-9876');
    assert.equal((await call('PUT', '/api/providers/1', { name: 'X', base_url: 'https://x', key_env: 'ADMIN_PASSWORD' })).status, 422);

    // A new API in one step: the Azure portal's address is completed, the variable comes from the name, the key goes to the .env.
    cfg = (await call('POST', '/api/providers', { name: 'Foundry', base_url: 'https://meu-recurso.openai.azure.com/', key_env: '', key: 'chave-do-foundry-1234' })).json;
    const foundry = cfg.providers.find((p) => p.name === 'Foundry');
    assert.equal(foundry.base_url, 'https://meu-recurso.openai.azure.com/openai/v1');
    assert.equal(foundry.key_env, 'FOUNDRY_API_KEY');
    assert.equal(foundry.key_tail, '1234');
    assert.equal(JSON.stringify(cfg).includes('chave-do-foundry'), false);
    assert.match(fs.readFileSync(s.server.envFile, 'utf8'), /^FOUNDRY_API_KEY=chave-do-foundry-1234$/m);
    // A second one of the same name never takes the first one's variable (nor its key).
    cfg = (await call('POST', '/api/providers', { name: 'Foundry', base_url: 'https://outro.services.ai.azure.com/api/projects/x' })).json;
    const another = cfg.providers.filter((p) => p.name === 'Foundry').at(-1);
    assert.equal(another.key_env, 'FOUNDRY_2_API_KEY');
    assert.equal(another.base_url, 'https://outro.services.ai.azure.com/openai/v1');
    assert.equal(another.has_key, false);
    assert.equal((await call('POST', '/api/providers', { name: 'Y', base_url: 'https://y', key: 'com espaço' })).status, 422);
    assert.equal((await call('POST', '/api/providers', { name: 'Ação', base_url: 'https://y' })).json.providers.at(-1).key_env, 'ACAO_API_KEY');
    for (const p of (await call('GET', '/api/config')).json.providers.slice(1)) assert.equal((await call('DELETE', `/api/providers/${p.id}`)).status, 200);

    cfg = (await call('PUT', '/api/settings', { budget_day_usd: 12.5, attestation: 'require' })).json;
    assert.equal(cfg.settings.budget_day_usd, 12.5);
    assert.equal((await call('PUT', '/api/settings', { attestation: 'talvez' })).status, 422);
    assert.equal((await call('PUT', '/api/jobs/think', { enabled: 1, max_body_kb: 256, max_output_tokens: 8000, per_minute: 10, per_day: 100, wait_s: 60, free_fallback: 0 })).json.jobs.find((j) => j.key === 'think').wait_s, 60);

    const ov = (await call('GET', '/api/overview?hours=24')).json;
    assert.equal(ov.total.requests, 1);
    assert.equal(ov.devices.total, 1);
    assert.ok(ov.budget.day_usd > 0);
    assert.equal(ov.series.length, 24);
    const devs = (await call('GET', '/api/devices')).json;
    assert.equal(devs.devices[0].id, s.phone.id);
    assert.equal(devs.devices[0].requests, 1);
    assert.equal((await call('PUT', `/api/devices/${s.phone.id}`, { status: 'blocked', note: 'teste' })).status, 200);
    assert.equal((await s.phone.ask('think')).status, 403);

    const page = await fetch(`${s.server.adminUrl}/`);
    assert.equal(page.status, 200);
    assert.equal((await fetch(`${s.server.adminUrl}/../.env`)).status, 404);
    assert.equal((await fetch(`${s.server.adminUrl}/%2e%2e/.env`)).status, 404);
  } finally {
    await s.close();
  }
});

test('Azure gets its key in api-key; every other API as a bearer token', async () => {
  const { chat, listModels } = await import('../src/upstream.js');
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return new Response(url.endsWith('/models') ? '{"data":[]}' : JSON.stringify({ choices: [{ message: { content: 'oi' } }] }), { status: 200 });
  };
  await chat({ baseUrl: 'https://r.openai.azure.com/openai/v1', key: 'k-azure', body: {}, fetcher });
  await listModels({ baseUrl: 'https://r.services.ai.azure.com/openai/v1', key: 'k-azure', fetcher });
  await chat({ baseUrl: 'https://api.openai.com/v1', key: 'k-openai', body: {}, fetcher });
  assert.equal(seen[0].url, 'https://r.openai.azure.com/openai/v1/chat/completions');
  const azure = seen.filter((x) => x.url.includes('.azure.com'));
  assert.ok(azure.length >= 3);
  for (const x of azure) {
    assert.equal(x.headers['api-key'], 'k-azure');
    assert.equal(x.headers.Authorization, undefined);
  }
  const openai = seen.find((x) => x.url.startsWith('https://api.openai.com/'));
  assert.equal(openai.headers.Authorization, 'Bearer k-openai');
  assert.equal(openai.headers['api-key'], undefined);
});

test('Azure lists what is deployed and chats, by the deployment\'s name', async () => {
  const { listModels } = await import('../src/upstream.js');
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, headers: init.headers });
    if (url.includes('/openai/deployments')) {
      return new Response(JSON.stringify({ data: [
        { id: 'meu-chat', model: 'gpt-x', status: 'succeeded' },
        { id: 'imagens', model: 'gpt-image-9', status: 'succeeded' },
        { id: 'novo', model: 'modelo-que-o-catalogo-nao-tem', status: 'succeeded' },
        { id: 'subindo', model: 'gpt-x', status: 'running' },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [
      { id: 'gpt-x-2026-01-01', capabilities: { chat_completion: true }, lifecycle_status: 'preview' },
      { id: 'gpt-image-9', capabilities: { inference: true } },
    ] }), { status: 200 });
  };
  const list = await listModels({ baseUrl: 'https://r.openai.azure.com/openai/v1', key: 'k', fetcher });
  // Deployed and chatting (or unknown to the catalog); not the image one, not the one still going up.
  assert.deepEqual(list.map((m) => m.id), ['meu-chat', 'novo']);
  assert.equal(list[0].name, 'meu-chat (gpt-x)');
  assert.equal(list[0].lifecycle, 'preview');
  assert.equal(list[0].anyInput, true);
  assert.ok(seen.some((x) => x.url === 'https://r.openai.azure.com/openai/deployments?api-version=2022-12-01' && x.headers['api-key'] === 'k'));
});

test('a transcription model hears by its own door: the recording as a file, "-" when nothing is said', async () => {
  const { transcribe, isTranscriber } = await import('../src/upstream.js');
  const { audioOf } = await import('../src/router.js');
  assert.equal(isTranscriber('gpt-4o-mini-transcribe'), true);
  assert.equal(isTranscriber('whisper-1'), true);
  assert.equal(isTranscriber('gpt-6-luna'), false);
  const body = { messages: [{ role: 'system', content: 'Transcribe…' }, { role: 'user', content: [{ type: 'input_audio', input_audio: { data: Buffer.from('RIFF....').toString('base64'), format: 'wav' } }] }] };
  assert.equal(audioOf(body).format, 'wav');
  assert.equal(audioOf({ messages: [{ role: 'user', content: 'oi' }] }), null);
  const seen = [];
  let answer = { text: ' olá, tudo bem ', usage: { input_tokens: 120, output_tokens: 8 } };
  const fetcher = async (url, init) => {
    seen.push({ url, headers: init.headers, form: init.body });
    if (url.includes('/openai/v1/audio/transcriptions') && seen.length === 3) return new Response('{"error":{"message":"Resource not found"}}', { status: 404 });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  const out = await transcribe({ baseUrl: 'https://r.openai.azure.com/openai/v1', key: 'k', model: 'gpt-4o-mini-transcribe', audio: audioOf(body), fetcher });
  assert.equal(out.text, 'olá, tudo bem');
  assert.equal(out.tokensIn, 120);
  assert.equal(seen[0].url, 'https://r.openai.azure.com/openai/v1/audio/transcriptions');
  assert.equal(seen[0].headers['api-key'], 'k');
  assert.equal(seen[0].form.get('model'), 'gpt-4o-mini-transcribe');
  assert.equal(seen[0].form.get('file').type, 'audio/wav');
  answer = { text: '' };
  assert.equal((await transcribe({ baseUrl: 'https://api.openai.com/v1', key: 'k2', model: 'whisper-1', audio: { data: '', format: 'wav' }, fetcher })).text, '-');
  assert.equal(seen[1].headers.Authorization, 'Bearer k2');
  // An Azure resource without it in v1: by the deployment.
  answer = { text: 'oi' };
  assert.equal((await transcribe({ baseUrl: 'https://r.openai.azure.com/openai/v1', key: 'k', model: 'meu-transcribe', audio: { data: '', format: 'wav' }, fetcher })).text, 'oi');
  assert.match(seen[3].url, /\/openai\/deployments\/meu-transcribe\/audio\/transcriptions\?api-version=/);
});

test('a Foundry model takes what OpenRouter says the same model takes, with its price as a reference', async () => {
  const { Admin } = await import('../src/admin.js');
  const catalog = { data: [
    { id: 'openai/gpt-6-luna', name: 'Luna', context_length: 400000, pricing: { prompt: '0.0000001', completion: '0.0000005', input_cache_read: '0.00000001' }, architecture: { input_modalities: ['file', 'image', 'text'], output_modalities: ['text'] }, supported_parameters: ['tools'] },
    { id: 'openai/gpt-6-luna:batch', name: 'Luna batch', pricing: { prompt: '0.00000005', completion: '0.00000025' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'openrouter/auto', name: 'Auto', pricing: { prompt: '-1', completion: '-1' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ] };
  let asked = 0;
  const admin = new Admin({ config: { get: (k, d) => d }, fetcher: async () => (asked++, new Response(JSON.stringify(catalog), { status: 200 })) });
  const deployed = [
    { kind: 'chat', id: 'minha-luna', base: 'gpt-6-luna', name: 'minha-luna (gpt-6-luna)', input: ['text'], output: ['text'], anyInput: true, priced: false, priceIn: 0, priceOut: 0, params: [] },
    { kind: 'chat', id: 'Decision-1', base: 'Microsoft-Decision-1', name: 'Decision-1', input: ['text'], output: ['text'], anyInput: true, priced: false, priceIn: 0, priceOut: 0, params: [] },
  ];
  const [luna, unknown] = await admin.withCatalog(deployed);
  assert.equal(luna.ref, 'openai/gpt-6-luna');
  assert.deepEqual(luna.input, ['file', 'image', 'text']);
  assert.equal(luna.anyInput, false);
  assert.ok(Math.abs(luna.priceIn - 0.1) < 1e-9 && Math.abs(luna.priceOut - 0.5) < 1e-9 && Math.abs(luna.priceCached - 0.01) < 1e-9);
  assert.equal(unknown.anyInput, true);
  // Kept an hour: the second list doesn't ask again.
  await admin.withCatalog(deployed);
  assert.equal(asked, 1);
  // A router with no price of its own (-1) is not priced at minus a million.
  const { listModels } = await import('../src/upstream.js');
  const auto = (await listModels({ baseUrl: 'https://openrouter.ai/api/v1', key: '', fetcher: async () => new Response(JSON.stringify(catalog), { status: 200 }) })).find((m) => m.id === 'openrouter/auto');
  assert.equal(auto.priced, false);
  assert.equal(auto.variable, true);
  assert.equal(auto.priceIn, 0);
});

test('a parameter the model doesn\'t take is renamed or left out as the API says, and remembered', async () => {
  const { chat, lessonOf } = await import('../src/upstream.js');
  assert.deepEqual(lessonOf("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), { param: 'max_tokens', instead: 'max_completion_tokens' });
  assert.deepEqual(lessonOf("Unsupported value: 'temperature' does not support 0.2 with this model."), { param: 'temperature', instead: null });
  assert.equal(lessonOf('outra coisa'), null);
  const sent = [];
  const fetcher = async (url, init) => {
    const b = JSON.parse(init.body);
    sent.push(b);
    if ('max_tokens' in b) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }), { status: 400 });
    if ('temperature' in b) return new Response(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  const base = 'https://r.openai.azure.com/openai/v1';
  const out = await chat({ baseUrl: base, key: 'k', body: { model: 'luna-aprende', max_tokens: 2000, temperature: 0.2, messages: [] }, fetcher });
  assert.equal(out.text, 'ok');
  assert.equal(sent.length, 3);
  assert.equal(sent[2].max_completion_tokens, 2000);
  assert.equal('max_tokens' in sent[2] || 'temperature' in sent[2], false);
  // The next request to the same model goes right the first time.
  await chat({ baseUrl: base, key: 'k', body: { model: 'luna-aprende', max_tokens: 500, temperature: 0.2, messages: [] }, fetcher });
  assert.equal(sent.length, 4);
  assert.equal(sent[3].max_completion_tokens, 500);
  // A 400 about something else is not retried.
  await assert.rejects(chat({ baseUrl: base, key: 'k', body: { model: 'outro', messages: [], max_tokens: 1 }, fetcher: async () => new Response('{"error":{"message":"bad request"}}', { status: 400 }) }));
});

test('see takes nine photos in one request (~1.5 MB), each after its "n:", and the JSON comes back', async () => {
  const s = await setup(() => ({ text: '{"1":"a","2":"b"}', cached: 64 }));
  try {
    s.server.route('see', 'openai/gpt-6-luna');
    const jpeg = (i) => `data:image/jpeg;base64,${Buffer.alloc(120_000, i).toString('base64')}`;
    const content = [];
    for (let i = 1; i <= 9; i++) content.push({ type: 'text', text: `${i}:` }, { type: 'image_url', image_url: { url: jpeg(i), detail: 'low' } });
    const body = { messages: [{ role: 'system', content: 'Descreva cada foto. JSON {"1": …}.' }, { role: 'user', content }], response_format: { type: 'json_object' } };
    assert.ok(JSON.stringify(body).length > 1.4e6);
    const r = await s.phone.ask('see', body);
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, '{"1":"a","2":"b"}');
    const sent = s.upstream.calls.at(-1).json;
    assert.equal(sent.messages[1].content.length, 18);
    assert.equal(sent.messages[1].content.filter((p) => p.type === 'image_url').length, 9);
    assert.equal(sent.messages[1].content[16].text, '9:');
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    // The tokens the model had in its cache are counted.
    s.server.app.flush();
    assert.equal(s.server.app.db.prepare('SELECT tokens_cached FROM requests').get().tokens_cached, 64);
    assert.equal(s.server.app.db.prepare("SELECT SUM(tokens_cached) n FROM agg_hour WHERE job = 'see'").get().n, 64);
  } finally {
    await s.close();
  }
});

test('Anthropic through OpenRouter gets the system message marked for the cache; the rest as is', async () => {
  const { markCache } = await import('../src/router.js');
  const msgs = [{ role: 'system', content: 'instruções fixas' }, { role: 'user', content: 'oi' }];
  const marked = markCache('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5-5', msgs);
  assert.deepEqual(marked[0].content, [{ type: 'text', text: 'instruções fixas', cache_control: { type: 'ephemeral' } }]);
  assert.equal(marked[1], msgs[1]);
  assert.equal(msgs[0].content, 'instruções fixas');
  // Gemini caches by itself (a mark would cost the input again plus storage); others too; elsewhere, not OpenRouter's way.
  assert.equal(markCache('https://openrouter.ai/api/v1', 'google/gemini-3-flash', msgs), msgs);
  assert.equal(markCache('https://openrouter.ai/api/v1', 'openai/gpt-6-luna', msgs), msgs);
  assert.equal(markCache('https://openrouter.ai/api/v1', 'google/gemma-4', msgs), msgs);
  assert.equal(markCache('https://r.openai.azure.com/openai/v1', 'anthropic/x', msgs), msgs);
  // Already marked by the app: left alone.
  const own = [{ role: 'system', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }];
  assert.equal(markCache('https://openrouter.ai/api/v1', 'anthropic/x', own), own);
});

test('the cost by the route\'s prices: what was cached at the cached price, a recording billed by the minute by the minute', async () => {
  const { costOf } = await import('../src/router.js');
  const route = { price_in: 2, price_out: 10, price_cached: 0.2, price_minute: 0 };
  // What the API says wins.
  assert.equal(costOf(route, { tokensIn: 1000, tokensOut: 100, tokensCached: 800, cost: 0.5 }), 0.5);
  // 200 new at 2, 800 cached at 0.2, 100 out at 10 (per million).
  assert.equal(costOf(route, { tokensIn: 1000, tokensOut: 100, tokensCached: 800, cost: null }), (200 * 2 + 800 * 0.2 + 100 * 10) / 1e6);
  // No cached price: the input's (as before).
  assert.equal(costOf({ ...route, price_cached: 0 }, { tokensIn: 1000, tokensOut: 100, tokensCached: 800, cost: null }), (1000 * 2 + 100 * 10) / 1e6);
  // Whisper: 90 s at US$ 0.006 a minute.
  assert.ok(Math.abs(costOf({ price_in: 0, price_out: 0, price_minute: 0.006 }, { tokensIn: 0, tokensOut: 0, seconds: 90, cost: null }) - 0.009) < 1e-12);
});

test('a transcription billed by the minute says how long it heard: by the API, or by the recording', async () => {
  const { transcribe, wavSeconds } = await import('../src/upstream.js');
  const wav = (seconds) => {
    const n = 16000 * seconds;
    const b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    return { data: b.toString('base64'), format: 'wav' };
  };
  assert.equal(wavSeconds(wav(3)), 3);
  assert.equal(wavSeconds({ data: 'abc', format: 'wav' }), 0);
  assert.equal(wavSeconds({ data: wav(3).data, format: 'mp3' }), 0);
  let answer;
  const fetcher = async () => new Response(JSON.stringify(answer), { status: 200 });
  const ask = () => transcribe({ baseUrl: 'https://api.openai.com/v1', key: 'k', model: 'whisper-1', audio: wav(2), fetcher });
  answer = { text: 'oi', usage: { type: 'duration', seconds: 7 } };
  assert.equal((await ask()).seconds, 7);
  answer = { text: 'oi' };
  assert.equal((await ask()).seconds, 2);
  // Billed by tokens: no minutes.
  answer = { text: 'oi', usage: { input_tokens: 50, output_tokens: 3 } };
  assert.equal((await ask()).seconds, 0);
});

test('through OpenRouter each job is one session (the same provider keeps the instructions cached), and the cost counts the cache', async () => {
  const server = await startServer();
  try {
    server.app.db.prepare("UPDATE providers SET base_url = 'https://openrouter.ai/api/v1' WHERE id = 1").run();
    const sent = [];
    server.app.router.fetcher = async (url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } } }), { status: 200 });
    };
    const id = server.route('think', 'anthropic/claude-haiku-5-5', { price_in: 1, price_out: 5 });
    const phone = new Phone(server.url);
    await phone.register();
    const body = { messages: [{ role: 'system', content: 'instruções fixas' }, { role: 'user', content: 'oi' }] };
    assert.equal((await phone.ask('think', body)).status, 200);
    assert.equal(sent[0].session_id, 'novelo-think');
    assert.equal(sent[0].messages[0].content[0].cache_control.type, 'ephemeral');
    // No cached price on the route: all of the input at the input's.
    server.app.db.prepare('UPDATE routes SET price_cached = 0.1 WHERE id = ?').run(id);
    server.app.router.reload();
    assert.equal((await phone.ask('think', body)).status, 200);
    server.app.telemetry.flush();
    const costs = server.app.db.prepare("SELECT cost FROM requests WHERE job = 'think' ORDER BY id").all().map((r) => r.cost);
    assert.deepEqual(costs, [(1000 * 1 + 100 * 5) / 1e6, (200 * 1 + 800 * 0.1 + 100 * 5) / 1e6]);
  } finally {
    await server.close();
  }
});
