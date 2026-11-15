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

/**
 * POST {base}/chat/completions. Returns { text, tokensIn, tokensOut, cost (USD, or null when the
 * API doesn't say), finish }.
 */
export async function chat({ baseUrl, key, headers = {}, body, timeoutMs = 90_000, fetcher = fetch }) {
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
    cost: typeof u.cost === 'number' ? u.cost : null,
  };
}

/** The models a provider lists, with what OpenRouter says of each (price per token, what goes in). */
export async function listModels({ baseUrl, key, headers = {}, fetcher = fetch }) {
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
      id: m.id,
      name: String(m.name ?? m.id),
      created: Number(m.created) || 0,
      context: Number(m.context_length) || 0,
      input: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : ['text'],
      output: Array.isArray(m.architecture?.output_modalities) ? m.architecture.output_modalities : ['text'],
      // Dollars per million tokens.
      priceIn: Number(m.pricing?.prompt) * 1e6 || 0,
      priceOut: Number(m.pricing?.completion) * 1e6 || 0,
      priced: m.pricing?.prompt !== undefined,
      params: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
    }));
}
