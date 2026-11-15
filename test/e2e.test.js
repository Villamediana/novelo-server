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
    assert.deepEqual(forSee.json.models.map((m) => m.id), ['a/olho']);
    assert.ok(Math.abs(forSee.json.models[0].price_out - 0.8) < 1e-9);

    let cfg = (await call('POST', '/api/routes', { job: 'think', provider_id: 1, model: 'a/texto', price_in: 0.1, price_out: 0.5 })).json;
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
  assert.equal(seen[0].headers['api-key'], 'k-azure');
  assert.equal(seen[0].headers.Authorization, undefined);
  assert.equal(seen[1].headers['api-key'], 'k-azure');
  assert.equal(seen[2].headers.Authorization, 'Bearer k-openai');
  assert.equal(seen[2].headers['api-key'], undefined);
});
