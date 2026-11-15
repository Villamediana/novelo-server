// One call to a model's API (the OpenAI chat way, which OpenRouter and most others speak), and
// what kind of failure it was — that is what decides whether to wait, try another model or give up.

export class UpstreamError extends Error {
  /**
   * kind: 'rate' (429: wait), 'auth' (the key: refused or out of credit), 'gone' (no such model),
   * 'refused' (this request, as written, isn't taken), 'server' (their side), 'timeout', 'network',
   * 'empty' (answered nothing).
   */
  constructor(kind, status, message, retryAfterMs = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfter(headers) {
  const v = headers.get('retry-after');
  if (!v) return 0;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

export function kindOf(status) {
  if (status === 429) return 'rate';
  if (status === 401 || status === 402) return 'auth';
  if (status === 404) return 'gone';
  if (status === 400 || status === 403 || status === 413 || status === 415 || status === 422) return 'refused';
  return 'server';
}

function errorOf(json) {
  const e = json?.error ?? json?.choices?.[0]?.error;
  if (!e) return null;
  if (typeof e === 'string') return { message: e, code: 0 };
  return { message: String(e.message ?? 'erro'), code: Number(e.code) || 0 };
}

function textOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

/** Azure (AI Foundry, Azure OpenAI): its address and its way of taking the key differ from the rest. */
export function isAzure(baseUrl) {
  try {
    return /\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** Azure takes the key in `api-key`; everyone else as a bearer token. No key, no header. */
function authOf(baseUrl, key) {
  if (!key) return {};
  return isAzure(baseUrl) ? { 'api-key': key } : { Authorization: `Bearer ${key}` };
}

// What an API said it doesn't take, learned per API and model, so the next request goes right the first time:
// a parameter under another name ("max_tokens" → "max_completion_tokens" on OpenAI's newer models, also on
// Azure), or one it doesn't take at all (a "temperature" a reasoning model refuses).
const learned = new Map();

function adapt(body, rules) {
  if (!rules) return body;
  const out = { ...body };
  for (const [from, to] of rules.rename) {
    if (!(from in out)) continue;
    if (!(to in out)) out[to] = out[from];
    delete out[from];
  }
  for (const k of rules.drop) delete out[k];
  return out;
}

/** "Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens' instead." → what to change, or null. */
export function lessonOf(message) {
  const m = /unsupported (?:parameter|value)\W+'([a-z_]+)'/i.exec(String(message));
  if (!m) return null;
  return { param: m[1], instead: /use '([a-z_]+)' instead/i.exec(String(message))?.[1] ?? null };
}

/**
 * POST {base}/chat/completions. Returns { text, tokensIn, tokensOut, cost (USD, or null when the
 * API doesn't say), finish }. A 400 naming a parameter the model doesn't take: changed as it says, once more.
 */
export async function chat({ baseUrl, key, headers = {}, body, timeoutMs = 90_000, fetcher = fetch }) {
  if (typeof body !== 'object' || !body) return chatOnce({ baseUrl, key, headers, body, timeoutMs, fetcher });
  const where = `${baseUrl}|${body.model ?? ''}`;
  let payload = adapt(body, learned.get(where));
  for (let tries = 0; ; tries++) {
    try {
      return await chatOnce({ baseUrl, key, headers, body: payload, timeoutMs, fetcher });
    } catch (e) {
      const lesson = tries < 3 && e instanceof UpstreamError && e.status === 400 ? lessonOf(e.message) : null;
      if (!lesson || !(lesson.param in payload)) throw e;
      const rules = learned.get(where) ?? { rename: new Map(), drop: new Set() };
      if (lesson.instead) rules.rename.set(lesson.param, lesson.instead);
      else rules.drop.add(lesson.param);
      learned.set(where, rules);
      payload = adapt(payload, rules);
    }
  }
}

async function chatOnce({ baseUrl, key, headers = {}, body, timeoutMs = 90_000, fetcher = fetch }) {
  let res;
  let raw;
  try {
    res = await fetcher(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authOf(baseUrl, key), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    raw = await res.text();
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new UpstreamError(timeout ? 'timeout' : 'network', 0, timeout ? 'sem resposta a tempo' : `rede: ${e?.cause?.code ?? e?.message ?? 'erro'}`);
  }
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch { /* not JSON: judged by the status */ }
  if (!res.ok) {
    const err = errorOf(json);
    throw new UpstreamError(kindOf(res.status), res.status, (err?.message ?? `HTTP ${res.status}`).slice(0, 300), retryAfter(res.headers));
  }
  // Some answer 200 with the provider's error inside.
  const inner = errorOf(json);
  if (inner) {
    const status = inner.code >= 400 && inner.code < 600 ? inner.code : 502;
    throw new UpstreamError(kindOf(status), status, inner.message.slice(0, 300), retryAfter(res.headers));
  }
  const choice = json?.choices?.[0];
  const text = textOf(choice?.message);
  if (!text.trim()) throw new UpstreamError('empty', 200, 'resposta vazia');
  const u = json.usage ?? {};
  return {
    text,
    finish: String(choice?.finish_reason ?? ''),
    tokensIn: Number(u.prompt_tokens) || 0,
    tokensOut: Number(u.completion_tokens) || 0,
    // Of the input, what the model had in its cache (OpenAI/OpenRouter way; Anthropic's own name too).
    tokensCached: Number(u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens) || 0,
    cost: typeof u.cost === 'number' ? u.cost : null,
  };
}

/**
 * Azure: what the resource has deployed (only those can be called, by the deployment's name), keeping the
 * ones its catalog says chat. The deployments are listed only by this older version of the API; the v1 one
 * lists the whole catalog, deployed or not. Azure doesn't say what goes in (audio, images): anyInput.
 */
async function azureDeployments({ baseUrl, key, headers, fetcher }) {
  const origin = new URL(baseUrl).origin;
  const get = async (path) => {
    const res = await fetcher(`${origin}${path}`, { headers: { Accept: 'application/json', ...authOf(baseUrl, key), ...headers }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new UpstreamError(kindOf(res.status), res.status, `deployments: HTTP ${res.status}`);
    return res.json();
  };
  const [deployed, catalog] = await Promise.all([get('/openai/deployments?api-version=2022-12-01'), get('/openai/v1/models').catch(() => null)]);
  const known = new Map((Array.isArray(catalog?.data) ? catalog.data : []).map((m) => [String(m.id).toLowerCase(), m]));
  // The catalog names a model with and without its date ("gpt-x", "gpt-x-2026-09-22").
  const entry = (model) => {
    const name = String(model).toLowerCase();
    return known.get(name) ?? [...known].find(([id]) => id.startsWith(`${name}-`))?.[1];
  };
  // Unknown to the catalog: kept (it is deployed; whoever chooses decides).
  const chats = (model) => {
    const e = entry(model);
    return e ? e.capabilities?.chat_completion === true : true;
  };
  return (Array.isArray(deployed?.data) ? deployed.data : [])
    .filter((d) => d && typeof d.id === 'string' && (d.status ?? 'succeeded') === 'succeeded' && (chats(d.model ?? d.id) || isTranscriber(d.model ?? d.id)))
    .map((d) => ({
      kind: isTranscriber(d.model ?? d.id) ? 'transcribe' : 'chat',
      lifecycle: String(entry(d.model ?? d.id)?.lifecycle_status ?? ''),
      id: d.id,
      base: String(d.model ?? d.id),
      name: d.model && d.model !== d.id ? `${d.id} (${d.model})` : d.id,
      created: Number(d.created_at) || 0,
      context: 0,
      input: isTranscriber(d.model ?? d.id) ? ['audio'] : ['text'],
      output: ['text'],
      anyInput: !isTranscriber(d.model ?? d.id),
      priceIn: 0,
      priceOut: 0,
      priced: false,
      params: [],
    }));
}

/** A transcription model (audio in, its words out, by /audio/transcriptions, not by chat): known by its name. */
export function isTranscriber(model) {
  return /transcri|whisper/i.test(String(model));
}

/**
 * A recording's words, by a transcription model: POST {base}/audio/transcriptions with the audio as a file.
 * [audio]: { data (base64), format }. Nothing said comes back as "-", the way the app asks a chat model to say it.
 * Returns what chat() returns.
 */
export async function transcribe({ baseUrl, key, headers = {}, model, audio, timeoutMs = 90_000, fetcher = fetch }) {
  const format = /^[a-z0-9]{2,5}$/i.test(String(audio?.format ?? '')) ? String(audio.format).toLowerCase() : 'wav';
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(String(audio?.data ?? ''), 'base64')], { type: `audio/${format}` }), `audio.${format}`);
  form.append('model', model);
  form.append('response_format', 'json');
  const send = (url) => fetcher(url, { method: 'POST', headers: { Accept: 'application/json', ...authOf(baseUrl, key), ...headers }, body: form, signal: AbortSignal.timeout(timeoutMs) });
  let res;
  let raw;
  try {
    res = await send(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`);
    // An Azure resource without it in v1: by the deployment, the older way.
    if (res.status === 404 && isAzure(baseUrl)) {
      res = await send(`${new URL(baseUrl).origin}/openai/deployments/${encodeURIComponent(model)}/audio/transcriptions?api-version=2025-03-01-preview`);
    }
    raw = await res.text();
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new UpstreamError(timeout ? 'timeout' : 'network', 0, timeout ? 'sem resposta a tempo' : `rede: ${e?.cause?.code ?? e?.message ?? 'erro'}`);
  }
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch { /* judged by the status */ }
  if (!res.ok) {
    const err = errorOf(json);
    throw new UpstreamError(kindOf(res.status), res.status, (err?.message ?? `HTTP ${res.status}`).slice(0, 300), retryAfter(res.headers));
  }
  const u = json?.usage ?? {};
  return { text: String(json?.text ?? '').trim() || '-', finish: 'stop', tokensIn: Number(u.input_tokens) || 0, tokensOut: Number(u.output_tokens) || 0, tokensCached: 0, cost: null };
}

/** The models a provider lists, with what OpenRouter says of each (price per token, what goes in). */
export async function listModels({ baseUrl, key, headers = {}, fetcher = fetch }) {
  if (isAzure(baseUrl)) return azureDeployments({ baseUrl, key, headers, fetcher });
  const res = await fetcher(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { Accept: 'application/json', ...authOf(baseUrl, key), ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new UpstreamError(kindOf(res.status), res.status, `modelos: HTTP ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return list
    .filter((m) => m && typeof m.id === 'string')
    .map((m) => ({
      kind: isTranscriber(m.id) ? 'transcribe' : 'chat',
      id: m.id,
      name: String(m.name ?? m.id),
      created: Number(m.created) || 0,
      context: Number(m.context_length) || 0,
      input: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : isTranscriber(m.id) ? ['audio'] : ['text'],
      output: Array.isArray(m.architecture?.output_modalities) ? m.architecture.output_modalities : ['text'],
      // Dollars per million tokens. A router that picks a model per request says -1: no price of its own.
      priceIn: Math.max(0, Number(m.pricing?.prompt) * 1e6 || 0),
      priceOut: Math.max(0, Number(m.pricing?.completion) * 1e6 || 0),
      priceCached: Math.max(0, Number(m.pricing?.input_cache_read) * 1e6 || 0),
      priced: m.pricing?.prompt !== undefined && Number(m.pricing.prompt) >= 0 && Number(m.pricing?.completion ?? 0) >= 0,
      variable: Number(m.pricing?.prompt) < 0,
      params: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
    }));
}
