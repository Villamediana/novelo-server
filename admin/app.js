// The panel. Plain JavaScript, no build: what it shows comes from /api, what it changes goes back there.
// Four pages: Início (is it working, and the one thing to do next), Inteligência (APIs and models),
// Aparelhos, Ajustes (saved as they change). What is rarely touched waits under "Avançado".
const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const dialog = $('#dialog');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('pt-BR');
const num = (n) => nf.format(Math.round(n || 0));
const compact = (n) => new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const usd = (n, digits) => `US$ ${(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: digits ?? ((n || 0) >= 100 ? 0 : (n || 0) >= 1 ? 2 : 3), maximumFractionDigits: digits ?? ((n || 0) >= 100 ? 0 : (n || 0) >= 1 ? 2 : 3) })}`;
const secs = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`);
const pct = (a, b) => (b ? `${((100 * a) / b).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '0%');
const when = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  if (m < 48 * 60) return `há ${Math.round(m / 60)} h`;
  return `há ${Math.round(m / 1440)} dias`;
};
const and = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} e ${list.at(-1)}` : list[0] ?? '');
const shortModel = (m) => String(m).split('/').pop();

const LOGO = `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="var(--accent)"/><g fill="none" stroke="var(--on-accent)" stroke-width="1.7" stroke-linecap="round" opacity=".9"><path d="M8 19c9-8 23-8 32 0"/><path d="M6 27c11-9 25-9 36 0"/><path d="M10 35c8-6 20-6 28 0"/><path d="M17 5c-7 12-7 26 0 38"/><path d="M29 4c8 12 8 28 0 40"/></g></svg>`;

// Line icons, 24 × 24, drawn with the text's color.
const ICON = {
  inicio: '<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  inteligencia: '<path d="M11 3.5l1.9 5.1 5.1 1.9-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z"/><path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  aparelhos: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 17.5h2"/>',
  ajustes: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  hear: '<path d="M8 15.5c-1.2-1.1-2-2.7-2-4.5a6 6 0 1 1 12 0c0 2.4-1.3 3.4-2.4 4.3-1 .8-1.6 1.5-1.6 2.7a2.5 2.5 0 0 1-4.6 1.4"/><path d="M9.5 11a2.5 2.5 0 0 1 5 0"/>',
  see: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  think: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2v.2h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5 19 4M16 7l2.5 2.5M14 9l2 2"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  alert: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};
const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

const VIEWS = [['inicio', 'Início'], ['inteligencia', 'Inteligência'], ['aparelhos', 'Aparelhos'], ['ajustes', 'Ajustes']];
// The old addresses still open the right page.
const OLD = { visao: 'inicio', modelos: 'inteligencia', apis: 'inteligencia', custos: 'ajustes', seguranca: 'ajustes' };
const JOB_TEXT = { hear: 'Entende áudio', see: 'Entende imagens', think: 'Pensa e responde' };

const state = { view: location.hash.slice(1) || 'inicio', hours: 24, metric: 'requests', config: null, overview: null, devices: null, deviceQuery: { q: '', filter: 'all', sort: 'seen', offset: 0 }, tests: {}, timer: null, wizard: false };

// ── talking to the server ──────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'X-Novelo-Admin': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    login();
    throw new Error('Entre de novo.');
  }
  if (!res.ok) throw new Error(json.error?.message ?? `Erro ${res.status}`);
  return json;
}

let toastTimer;
function toast(text, err = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = `on${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 5000 : 2200);
}
const attempt = async (fn, done) => {
  try {
    const out = await fn();
    if (done) toast(done);
    return out;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
};

// ── frame ──────────────────────────────────────────────────────────────────
function login() {
  clearInterval(state.timer);
  app.innerHTML = `<div class="login"><form>${LOGO}<h1>Novelo</h1><p class="sub">Inteligência</p>
    <input type="password" name="password" placeholder="Senha" autocomplete="current-password" autofocus required>
    <button class="btn primary">Entrar</button></form></div>`;
  $('form', app).onsubmit = async (e) => {
    e.preventDefault();
    const ok = await attempt(() => api('POST', '/login', { password: e.target.password.value }));
    if (ok) start();
  };
}

function frame(inner) {
  app.innerHTML = `<div class="frame"><aside class="side">
      <div class="brand">${LOGO}<div><b>Novelo</b><small>inteligência</small></div></div>
      <nav>${VIEWS.map(([k, label]) => `<button data-view="${k}" ${k === state.view ? 'aria-current="page"' : ''}>${icon(k)}<span>${label}</span></button>`).join('')}</nav>
      <button class="btn quiet out" data-act="logout">Sair</button>
    </aside><main class="${state.shown === state.view ? '' : 'enter'}">${inner}</main></div>`;
  // The page comes in when it is opened, not every time its numbers are refreshed.
  state.shown = state.view;
}

async function start() {
  if (!(await attempt(async () => (state.config = await api('GET', '/config'))))) return;
  go(state.view);
}

async function go(view) {
  view = OLD[view] ?? view;
  if (!VIEWS.some(([k]) => k === view)) view = 'inicio';
  if (view !== state.view) window.scrollTo(0, 0);
  state.view = view;
  history.replaceState(null, '', `#${view}`);
  clearInterval(state.timer);
  if (view === 'inicio') {
    await refresh();
    state.timer = setInterval(() => document.hidden || dialog.open || refresh(), 10_000);
  } else if (view === 'aparelhos') {
    await loadDevices();
  } else {
    if (view === 'inteligencia') state.timer = setInterval(async () => {
      if (document.hidden || dialog.open || document.activeElement?.closest('details, form')) return;
      state.config = await api('GET', '/config').catch(() => state.config);
      render();
    }, 10_000);
    render();
  }
}

function render() {
  const open = [...document.querySelectorAll('details[open]')].map((d) => d.dataset.key);
  frame({ inicio, inteligencia, aparelhos, ajustes }[state.view]());
  for (const d of document.querySelectorAll('details')) if (open.includes(d.dataset.key)) d.open = true;
  requestAnimationFrame(() => {
    for (const el of document.querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`;
    for (const el of document.querySelectorAll('[data-ring]')) el.style.strokeDasharray = `${el.dataset.ring} 100`;
  });
  charts();
}

// ── Início ─────────────────────────────────────────────────────────────────
async function refresh() {
  const got = await Promise.all([api('GET', `/overview?hours=${state.hours}`), api('GET', '/config')]).catch((e) => (toast(e.message, true), null));
  if (!got || state.view !== 'inicio') return;
  [state.overview, state.config] = got;
  render();
}

/** The one thing that matters now: it is working, or what is missing (with the button that solves it). */
function hero(o, c) {
  const ready = c.ready ?? {};
  const keyed = c.providers.some((p) => p.enabled && p.has_key);
  const missing = c.jobs.filter((j) => j.enabled && !ready[j.key]);
  if (o.paused) return { tone: 'bad', ico: 'pause', title: 'Pausado', text: 'O app recebe "em manutenção" e guarda os pedidos pra depois.', btn: '<button class="btn primary" data-act="resume">Retomar</button>' };
  if (!keyed) return { tone: 'warn', ico: 'key', title: 'Conecte uma API', text: 'Escolha o provedor e cole a chave. O resto o painel vai pedindo.', btn: '<button class="btn primary" data-act="provider-new">Conectar API</button>' };
  if (missing.length) return { tone: 'warn', ico: 'alert', title: `Falta o modelo de ${and(missing.map((j) => j.label.toLowerCase()))}`, text: 'Sem modelo, o servidor não atende essa parte. Toque no sentido pra escolher.', btn: `<button class="btn primary" data-act="route-new" data-job="${missing[0].key}">Escolher modelo</button>` };
  if (o.live.over_budget) return { tone: 'warn', ico: 'alert', title: 'Teto de gasto atingido', text: 'Os modelos pagos voltam quando virar o dia; os grátis seguem atendendo.', btn: '<button class="btn" data-view="ajustes">Ver o teto</button>' };
  return { tone: 'good', ico: 'check', title: 'Tudo funcionando', text: o.total.requests ? `${num(o.total.requests)} pedidos com ${pct(o.total.requests - o.total.errors, o.total.requests)} respondidos.` : 'Pronto pra receber os pedidos do app.', btn: '' };
}

function inicio() {
  const o = state.overview;
  const c = state.config;
  if (!o) return '<div class="head"><h1>Início</h1></div>';
  const t = o.total;
  const h = hero(o, c);
  const ready = c.ready ?? {};
  const range = [[24, '24 h'], [168, '7 dias'], [720, '30 dias']];
  const tiles = c.jobs.map((j, i) => {
    const first = c.routes.find((r) => r.job === j.key && r.enabled);
    const ok = j.enabled && ready[j.key];
    const used = o.jobs.find((x) => x.job === j.key)?.requests ?? 0;
    const foot = !j.enabled ? 'Desligado' : ok ? `${icon('check')} ${num(used)} ${used === 1 ? 'pedido' : 'pedidos'}` : 'Tocar pra escolher';
    return `<button class="tile rise ${ok ? 'ok' : 'todo'}" style="--i:${i + 1}" data-act="${first ? 'job' : 'route-new'}" data-job="${j.key}">
      <span class="tile-ico">${icon(j.key)}</span><b>${esc(j.label)}</b>
      <span class="tile-model">${first ? esc(shortModel(first.model)) : ok ? 'modelos grátis' : 'sem modelo'}</span>
      <span class="tile-foot">${foot}</span></button>`;
  }).join('');
  const dayLimit = o.budget.day_limit;
  const share = dayLimit ? Math.min(100, (100 * o.budget.day_usd) / dayLimit) : 0;
  const totals = { requests: num(t.requests), cost: usd(t.cost), errors: num(t.errors) };
  return `<div class="head"><h1>Início</h1>${o.paused ? '' : `<span class="pill good live">No ar</span>`}</div>
    <div class="hero rise ${h.tone}" style="--i:0"><span class="badge">${icon(h.ico)}</span><div><h2>${esc(h.title)}</h2><p class="sub">${esc(h.text)}</p></div>${h.btn}</div>
    <div class="tiles">${tiles}</div>
    <div class="stats">
      <div class="card stat rise" style="--i:4"><svg class="ring" viewBox="0 0 44 44"><circle class="ring-bg" cx="22" cy="22" r="18" pathLength="100"/><circle class="ring-fg ${share >= 100 ? 'over' : share >= 80 ? 'near' : ''}" cx="22" cy="22" r="18" pathLength="100" data-ring="${share.toFixed(1)}"/></svg>
        <div><span>Gasto hoje</span><div class="num">${usd(o.budget.day_usd)}</div><small>${dayLimit ? `de ${usd(dayLimit, dayLimit % 1 ? 2 : 0)}` : 'sem teto'}</small></div></div>
      <div class="card stat rise" style="--i:5"><div><span>Aparelhos hoje</span><div class="num">${compact(o.devices.active_today)}</div><small>${num(o.devices.total)} ao todo · ${num(o.plans.plus)} no Novelo+</small></div></div>
    </div>
    <div class="card chart rise" style="--i:6" data-chart="${state.metric}">
      <header><div class="seg">${Object.entries(METRICS).map(([k, m]) => `<button data-metric="${k}" aria-pressed="${state.metric === k}">${m.label}</button>`).join('')}</div>
        <div class="seg">${range.map(([hh, l]) => `<button data-hours="${hh}" aria-pressed="${state.hours === hh}">${l}</button>`).join('')}</div></header>
      <div class="num total">${totals[state.metric]}</div><div class="plot"></div></div>
    ${o.events.length ? `<section><h2 class="label">Avisos</h2><ul class="events card">${o.events.slice(0, 4).map((e) => `<li><time>${ago(e.ts)}</time><span>${esc(e.message)}</span></li>`).join('')}</ul></section>` : ''}
    <details class="more" data-key="numbers"><summary>Mais números</summary>${numbers(o)}</details>`;
}

/** The detailed tables, for when something looks off. */
function numbers(o) {
  const t = o.total;
  const ok = t.requests - t.errors;
  return `<div class="kpis">
      <div class="kpi"><span>Tempo médio</span><div class="num">${ok ? secs(t.ms_sum / ok) : '—'}</div><small>${t.requests ? secs(t.queue_ms_sum / t.requests) : '0 s'} na fila</small></div>
      <div class="kpi"><span>Sem resposta</span><div class="num">${pct(t.errors, t.requests)}</div><small>${num(t.retries)} novas tentativas</small></div>
      <div class="kpi"><span>Gasto do mês</span><div class="num">${usd(o.budget.month_usd)}</div><small>${o.budget.month_limit ? `de ${usd(o.budget.month_limit, 0)}` : 'sem teto'}</small></div>
      <div class="kpi"><span>Planos</span><div class="num">${compact(o.plans.plus)}</div><small>Novelo+ · ${num(o.plans.trial)} em teste · ${num(o.plans.ended)} encerrados</small></div>
    </div>
    <div class="card scroll">${o.models.length ? `<table><thead><tr><th>Pedido</th><th>Modelo</th><th class="r">Pedidos</th><th class="r">Sem resposta</th><th class="r">Custo</th><th class="r">Tempo</th></tr></thead><tbody>
      ${o.models.map((m) => `<tr><td>${esc(o.labels[m.job] ?? m.job)}</td><td><span class="mono">${esc(m.model)}</span></td><td class="r">${num(m.requests)}</td><td class="r">${pct(m.errors, m.requests)}</td><td class="r">${usd(m.cost)}</td><td class="r">${m.requests - m.errors ? secs(m.ms_sum / (m.requests - m.errors)) : '—'}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Nenhum pedido neste período.</p>'}</div>
    ${o.errors.length ? `<div class="card scroll"><table><tbody>${o.errors.map((e) => `<tr><td>${esc(ERRORS[e.code] ?? e.code)}</td><td class="r">${num(e.n)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

const ERRORS = { busy: 'Modelos ocupados até o fim da espera', budget: 'Teto de gasto atingido', refused: 'Pedido recusado pelo modelo', not_configured: 'Sem modelo configurado', gone: 'O app desistiu de esperar', internal: 'Erro interno' };

const METRICS = {
  requests: { label: 'Pedidos', get: (p) => p.requests, cls: '', show: (v) => `${num(v)} pedidos` },
  cost: { label: 'Custo', get: (p) => p.cost, cls: 'accent', show: (v) => usd(v) },
  errors: { label: 'Falhas', get: (p) => p.errors, cls: 'danger', show: (v) => `${num(v)} sem resposta` },
};

/** One chart: the chosen measure, by hour or by day. */
function charts() {
  const o = state.overview;
  const box = $('[data-chart]');
  if (state.view !== 'inicio' || !o || !box) return;
  const label = (p) => (o.by_day ? p.key.slice(8, 10) + '/' + p.key.slice(5, 7) : new Date(p.key).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
  const def = METRICS[state.metric];
  const pts = o.series;
  const max = Math.max(...pts.map(def.get), 0);
  const W = 600;
  const H = 130;
  const step = W / pts.length;
  const bw = Math.max(2, Math.min(18, step - 2));
  const cols = pts.map((p, i) => {
    const v = def.get(p);
    const h = max ? Math.max(v ? 2 : 0, (v / max) * (H - 6)) : 0;
    const x = i * step + (step - bw) / 2;
    const r = Math.min(4, bw / 2, h);
    const bar = h ? `<path class="bar ${def.cls}" style="--d:${i}" d="M${x},${H} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z"/>` : '';
    return `<g class="col" data-i="${i}">${bar}<rect class="hit" x="${i * step}" y="0" width="${step}" height="${H}"/></g>`;
  }).join('');
  const plot = $('.plot', box);
  plot.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${def.label} por ${o.by_day ? 'dia' : 'hora'}">${cols}<line class="base" x1="0" x2="${W}" y1="${H}" y2="${H}"/></svg>
    <div class="axis"><span>${label(pts[0])}</span><span>${max ? `pico ${def.show(max)}` : 'nada ainda'}</span><span>${label(pts[pts.length - 1])}</span></div>`;
  const svg = $('svg', plot);
  let tip;
  svg.addEventListener('pointermove', (e) => {
    const col = e.target.closest('.col');
    if (!col) return;
    const p = pts[Number(col.dataset.i)];
    tip ??= box.appendChild(Object.assign(document.createElement('div'), { className: 'tip' }));
    tip.innerHTML = `${esc(label(p))} · <b>${esc(def.show(def.get(p)))}</b>`;
    const rect = box.getBoundingClientRect();
    tip.style.left = `${Math.max(60, Math.min(rect.width - 60, e.clientX - rect.left))}px`;
    tip.style.top = `${svg.getBoundingClientRect().top - rect.top - 4}px`;
  });
  svg.addEventListener('pointerleave', () => {
    tip?.remove();
    tip = null;
  });
}

// ── Inteligência ───────────────────────────────────────────────────────────
function inteligencia() {
  const c = state.config;
  return `<div class="head tight"><h1>Inteligência</h1></div>
    <p class="sub lead">Cada sentido usa o primeiro modelo da lista; os de baixo entram se ele falhar ou lotar.</p>
    <h2 class="label">APIs</h2>
    <div class="apis">${c.providers.map((p, i) => `<button class="api-chip rise ${p.enabled && p.has_key ? 'ok' : 'todo'}" style="--i:${i}" data-act="provider-edit" data-id="${p.id}">
        <span class="dot"></span><b>${esc(p.name)}</b><small>${!p.enabled ? 'desligada' : p.has_key ? `chave ····${esc(p.key_tail)}` : 'falta a chave'}</small></button>`).join('')}
      <button class="api-chip add rise" style="--i:${c.providers.length}" data-act="provider-new">${icon('plus')}<b>Conectar</b></button></div>
    ${c.jobs.map(jobCard).join('')}
    <details class="more" data-key="free"><summary>Modelos grátis, o último recurso</summary><div class="card">
      <p class="sub">${num(c.live.free.known)} conhecidos${c.live.free.resting.length ? ` · ${c.live.free.resting.length} descansando` : ''}${Object.keys(c.live.free.last_good).length ? ` · último bom: ${Object.values(c.live.free.last_good).map(esc).join(', ')}` : ''}</p>
      <form class="form" data-form="settings">
        <label class="wide">Preferidos, na ordem <small>um por linha</small><textarea name="free_preferred">${esc(c.settings.free_preferred)}</textarea></label>
        <label class="wide">Evitar <small>só quando não sobrar outro</small><textarea name="free_avoid">${esc(c.settings.free_avoid)}</textarea></label>
        <label>Ao mesmo tempo<input type="number" name="free_max_concurrency" min="1" value="${c.settings.free_max_concurrency}"></label>
        <label>Por minuto<input type="number" name="free_rpm" min="0" value="${c.settings.free_rpm}"></label>
        <label>API dos grátis<select name="free_provider">${c.providers.map((p) => `<option value="${p.id}" ${p.id === c.settings.free_provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      </form></div></details>`;
}

function jobCard(j, ji) {
  const c = state.config;
  const routes = c.routes.filter((r) => r.job === j.key);
  const ok = j.enabled && c.ready?.[j.key];
  const waiting = c.live.waiting[j.key];
  return `<section class="card job rise" id="job-${j.key}" style="--i:${ji + 2}"><header>
      <span class="job-ico ${ok ? 'ok' : ''}">${icon(j.key)}</span>
      <div class="job-name"><h2>${esc(j.label)}</h2><small>${JOB_TEXT[j.key] ?? ''}</small></div>
      ${waiting ? `<span class="pill warn">${num(waiting)} na fila</span>` : ''}
      ${!j.enabled ? '<span class="pill bad">Desligado</span>' : ok ? '<span class="pill good">Pronto</span>' : '<span class="pill warn">Sem modelo</span>'}
    </header>
    ${routes.length ? `<ol class="routes">${routes.map((r, i) => routeRow(r, i, routes.length)).join('')}</ol>` : `<p class="empty small">${ok ? 'Sem modelo próprio: usa os grátis.' : 'Nenhum modelo ainda.'}</p>`}
    <button class="add-row" data-act="route-new" data-job="${j.key}">${icon('plus')}<span>${routes.length ? 'Modelo reserva' : 'Escolher modelo'}</span></button>
    <details class="limits" data-key="job-${j.key}"><summary>Limites</summary><form class="form" data-form="job" data-key="${j.key}">
      <label>Por aparelho, por minuto<input type="number" name="per_minute" min="0" value="${j.per_minute}"></label>
      <label>Por aparelho, por dia<input type="number" name="per_day" min="0" value="${j.per_day}"></label>
      <label>Espera máxima na fila (s)<input type="number" name="wait_s" min="5" max="600" value="${j.wait_s}"></label>
      <label>Tamanho máximo do pedido (KB)<input type="number" name="max_body_kb" min="16" value="${j.max_body_kb}"></label>
      <label>Tokens máximos de resposta<input type="number" name="max_output_tokens" min="16" value="${j.max_output_tokens}"></label>
      <label class="check"><input type="checkbox" name="free_fallback" ${j.free_fallback ? 'checked' : ''}>Último recurso: modelos grátis</label>
      <label class="check"><input type="checkbox" name="enabled" ${j.enabled ? 'checked' : ''}>Ligado</label>
    </form></details></section>`;
}

function routeRow(r, i, n) {
  const p = state.config.providers.find((x) => x.id === r.provider_id);
  const live = r.live;
  const test = state.tests[r.id];
  const status = !r.enabled ? '<span class="pill">Desligado</span>'
    : live?.cooling_ms ? `<span class="pill warn" title="${esc(live.last_error)}">Em pausa ${Math.ceil(live.cooling_ms / 1000)} s</span>`
    : live?.in_flight ? `<span class="pill good live">${live.in_flight} agora</span>` : '';
  const price = r.price_in || r.price_out ? ` · ${usd(r.price_in, 2)} → ${usd(r.price_out, 2)} por milhão` : '';
  return `<li class="route ${r.enabled ? '' : 'off'}"><span class="n">${i + 1}</span>
    <div class="what"><b>${esc(r.model)}</b><small>${esc(p?.name ?? '?')}${i ? ' · reserva' : ''}${price}</small></div>
    <div class="acts">${status}
      ${n > 1 ? `<button class="icon-btn" data-act="route-move" data-id="${r.id}" data-dir="-1" title="Subir" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
      <button class="icon-btn" data-act="route-move" data-id="${r.id}" data-dir="1" title="Descer" ${i === n - 1 ? 'disabled' : ''}>${icon('down')}</button>` : ''}
      <button class="icon-btn" data-act="route-test" data-id="${r.id}" title="Testar" ${test === 'running' ? 'disabled' : ''}>${test === 'running' ? '<span class="spin"></span>' : icon('play')}</button>
      <button class="icon-btn" data-act="route-edit" data-id="${r.id}" title="Editar">${icon('edit')}</button></div>
    ${test && test !== 'running' ? `<div class="result">${test.ok ? `<span class="pill good">Respondeu em ${secs(test.ms)}</span>` : `<span class="pill bad">Não respondeu</span> <span class="faint">${esc(test.error)}</span>`}</div>` : ''}</li>`;
}

/** Tries a model with a tiny request and says how it went, on its row and in a toast. */
async function testRoute(id) {
  state.tests[id] = 'running';
  render();
  const out = await attempt(() => api('POST', `/routes/${id}/test`, {}));
  state.tests[id] = out ?? undefined;
  if (out) toast(out.ok ? `Funcionou: respondeu em ${secs(out.ms)}` : `Não respondeu: ${out.error}`, !out.ok);
  render();
}

/** After an API is connected: the senses still without a model, one after the other. */
function nextInWizard(providerId) {
  const c = state.config;
  const next = c.jobs.find((j) => j.enabled && !c.routes.some((r) => r.job === j.key));
  if (!state.wizard || !next) {
    state.wizard = false;
    return;
  }
  routeDialog(next.key, null, providerId);
}

async function routeDialog(job, route, providerId) {
  const c = state.config;
  const keyed = c.providers.filter((p) => p.enabled && p.has_key);
  if (!route && !keyed.length) {
    toast('Primeiro, conecte uma API');
    return providerDialog();
  }
  const r = route ?? { job, provider_id: providerId ?? keyed[0]?.id ?? c.providers[0]?.id, model: '', enabled: 1, max_concurrency: 32, rpm: 0, price_in: 0, price_out: 0, timeout_s: 90, extra: '{}' };
  const j = c.jobs.find((x) => x.key === r.job);
  const label = j?.label ?? r.job;
  dialog.innerHTML = `<div class="dialog-head"><span class="job-ico">${icon(r.job)}</span><div><h2>${route ? 'Editar modelo' : 'Modelo pra ' + esc(label.toLowerCase())}</h2>
      <small class="faint">${state.wizard ? 'Passo a passo: cancele pra parar' : esc(JOB_TEXT[r.job] ?? '')}</small></div></div>
    <form class="form" method="dialog">
    <label class="wide">API<select name="provider_id">${c.providers.map((p) => `<option value="${p.id}" ${p.id === r.provider_id ? 'selected' : ''}>${esc(p.name)}${p.has_key ? '' : ' (sem chave)'}</option>`).join('')}</select></label>
    <label class="wide">Modelo <small data-count></small><input type="text" name="model" list="models" value="${esc(r.model)}" placeholder="carregando a lista…" autocomplete="off" required><datalist id="models"></datalist></label>
    <details class="limits wide"><summary>Avançado</summary><div class="form">
      <label>Ao mesmo tempo<input type="number" name="max_concurrency" min="1" value="${r.max_concurrency}"></label>
      <label>Pedidos por minuto <small>0 = sem limite</small><input type="number" name="rpm" min="0" value="${r.rpm}"></label>
      <label>Entrada, US$ por milhão <small>vem da lista</small><input type="number" name="price_in" min="0" step="any" value="${r.price_in}"></label>
      <label>Saída, US$ por milhão <small>vem da lista</small><input type="number" name="price_out" min="0" step="any" value="${r.price_out}"></label>
      <label>Tempo limite (s)<input type="number" name="timeout_s" min="5" max="600" value="${r.timeout_s}"></label>
      <label class="check"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}>Ligado</label>
      <label class="wide">Extras do pedido <small>JSON somado a cada chamada, ex.: {"reasoning":{"effort":"low"}}</small><textarea name="extra">${esc(r.extra)}</textarea></label>
    </div></details>
    <div class="actions wide">${route ? '<button type="button" class="btn danger" data-do="delete">Tirar</button>' : ''}
      <button type="button" class="btn" data-do="cancel">${state.wizard ? 'Parar' : 'Cancelar'}</button><button class="btn primary">${route ? 'Salvar' : 'Salvar e testar'}</button></div></form>`;
  const form = $('form', dialog);
  let models = [];
  const load = async () => {
    const p = c.providers.find((x) => x.id === Number(form.provider_id.value));
    // Azure answers by the name of the deployment, which its list of models doesn't have.
    if (/\.azure\.com(\/|$)/i.test(p?.base_url ?? '')) {
      models = [];
      $('#models', dialog).innerHTML = '';
      form.model.placeholder = 'nome do deployment no Foundry';
      $('[data-count]', dialog).textContent = '';
      return;
    }
    form.model.placeholder = 'carregando a lista…';
    const out = await api('GET', `/providers/${form.provider_id.value}/models?job=${r.job}`).catch(() => null);
    models = out?.models ?? [];
    $('#models', dialog).innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.priced ? `${usd(m.price_in, 2)} → ${usd(m.price_out, 2)}` : m.name)}</option>`).join('');
    form.model.placeholder = models.length ? 'toque pra ver a lista, ou escreva' : 'nome do modelo';
    $('[data-count]', dialog).textContent = models.length ? `${num(models.length)} servem pra ${label.toLowerCase()}` : '';
  };
  form.provider_id.onchange = load;
  // Picking one from the list brings its price.
  form.model.onchange = () => {
    const m = models.find((x) => x.id === form.model.value.trim());
    if (m?.priced) {
      form.price_in.value = +m.price_in.toFixed(6);
      form.price_out.value = +m.price_out.toFixed(6);
    }
  };
  form.onclick = async (e) => {
    const what = e.target.dataset?.do;
    if (what === 'cancel') {
      state.wizard = false;
      dialog.close();
    }
    if (what === 'delete' && confirm(`Tirar ${r.model}?`)) {
      const out = await attempt(() => api('DELETE', `/routes/${r.id}`), 'Tirado');
      if (out) done(out);
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const body = { ...f, job: r.job, provider_id: Number(f.provider_id), enabled: form.enabled.checked };
    const out = await attempt(() => (route ? api('PUT', `/routes/${r.id}`, body) : api('POST', '/routes', body)), route ? 'Salvo' : null);
    if (!out) return;
    done(out);
    if (route) return;
    const added = out.routes.filter((x) => x.job === r.job).reduce((a, b) => (b.id > a.id ? b : a));
    nextInWizard(body.provider_id);
    testRoute(added.id);
  };
  dialog.showModal();
  load();
}

function done(config) {
  state.config = config;
  if (dialog.open) dialog.close();
  render();
}

// The known ones: picking one fills the address and the key's variable; only the key is left to paste.
const ADDRESS = ['Endereço', 'o que vem antes de /chat/completions'];
const PRESETS = [
  { id: 'openrouter', label: 'OpenRouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', headers: '{"X-Title":"Novelo"}', key: 'sk-or-…' },
  {
    id: 'foundry', label: 'Azure AI Foundry', name: 'Foundry', base: '', env: 'FOUNDRY_API_KEY', key: 'a chave 1 ou 2 do recurso',
    ask: ['Endpoint do recurso', 'como aparece no portal da Azure, em Chaves e Ponto de Extremidade; o resto o servidor completa. Nos modelos, use o nome do deployment.'],
    placeholder: 'https://meu-recurso.openai.azure.com',
  },
  { id: 'openai', label: 'OpenAI', name: 'OpenAI', base: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', key: 'sk-…' },
  { id: 'anthropic', label: 'Anthropic (Claude)', name: 'Anthropic', base: 'https://api.anthropic.com/v1', env: 'ANTHROPIC_API_KEY', key: 'sk-ant-…' },
  { id: 'gemini', label: 'Google Gemini', name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY', key: 'AIza…' },
  { id: 'mistral', label: 'Mistral', name: 'Mistral', base: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY' },
  { id: 'groq', label: 'Groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', key: 'gsk_…' },
  { id: 'deepseek', label: 'DeepSeek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY', key: 'sk-…' },
  { id: 'xai', label: 'xAI (Grok)', name: 'xAI', base: 'https://api.x.ai/v1', env: 'XAI_API_KEY', key: 'xai-…' },
  { id: 'outra', label: 'Outra, que fale como a OpenAI', name: '', base: 'https://', env: '' },
];

// A second one of the same kind gets "2" (name and variable), so its key never overwrites the first one's.
function unused(value, taken, next) {
  if (!value || !taken.has(value)) return value;
  let n = 2;
  while (taken.has(next(n))) n++;
  return next(n);
}

function providerDialog(p) {
  const v = p ?? { name: '', base_url: 'https://', key_env: '', headers: '{}', extra: '{}', enabled: 1, routes: 0 };
  const fresh = !p;
  dialog.innerHTML = `<div class="dialog-head"><span class="job-ico">${icon('key')}</span><div><h2>${fresh ? 'Conectar API' : esc(v.name)}</h2>
      <small class="faint">${fresh ? 'Escolha o provedor e cole a chave' : p.has_key ? `chave ····${esc(p.key_tail)}` : 'falta a chave'}</small></div></div>
    <form class="form" method="dialog">
    ${fresh ? `<label class="wide">Provedor<select name="preset" required><option value="" selected disabled>Escolha…</option>${PRESETS.map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select></label>` : ''}
    <label class="wide">${fresh ? 'Chave' : p.has_key ? 'Trocar a chave' : 'Chave'} <small>fica só no arquivo .env do servidor, nunca volta pra tela</small>
      <input type="password" name="key" autocomplete="off" placeholder="${fresh || !p.has_key ? 'cole a chave aqui' : 'vazio: fica a que está'}"></label>
    <label>Nome<input type="text" name="name" value="${esc(v.name)}" required></label>
    <label class="wide"><span data-ask>${ADDRESS[0]}</span> <small data-hint>${ADDRESS[1]}</small><input type="text" name="base_url" value="${esc(v.base_url)}" required></label>
    <details class="limits wide"><summary>Avançado</summary><div class="form">
      <label>Variável da chave no .env <small>vazio: o servidor escolhe</small><input type="text" name="key_env" value="${esc(v.key_env)}" placeholder="MINHA_API_KEY"></label>
      <label class="wide">Cabeçalhos a mais <small>JSON</small><textarea name="headers">${esc(v.headers)}</textarea></label>
      <label class="wide">Extras de todo pedido <small>JSON</small><textarea name="extra">${esc(v.extra)}</textarea></label>
      <label class="check"><input type="checkbox" name="enabled" ${v.enabled ? 'checked' : ''}>Ligada</label>
      ${p?.has_key ? '<button type="button" class="btn quiet danger" data-do="unkey">Tirar a chave</button>' : ''}
    </div></details>
    <div class="actions wide">${p && !p.routes ? '<button type="button" class="btn danger" data-do="delete">Apagar</button>' : ''}
      <button type="button" class="btn" data-do="cancel">Cancelar</button><button class="btn primary">${fresh ? 'Conectar' : 'Salvar'}</button></div></form>`;
  const form = $('form', dialog);
  const field = (n) => form.elements.namedItem(n);
  if (fresh) {
    field('preset').onchange = () => {
      const x = PRESETS.find((y) => y.id === field('preset').value);
      const providers = state.config.providers;
      field('name').value = unused(x.name, new Set(providers.map((q) => q.name)), (n) => `${x.name} ${n}`);
      field('key_env').value = unused(x.env, new Set(providers.map((q) => q.key_env)), (n) => x.env.replace(/_API_KEY$/, `_${n}_API_KEY`));
      field('base_url').value = x.base;
      field('base_url').placeholder = x.placeholder ?? '';
      field('headers').value = x.headers ?? '{}';
      field('key').placeholder = x.key ?? 'cole a chave aqui';
      const [ask, hint] = x.ask ?? ADDRESS;
      $('[data-ask]', form).textContent = ask;
      $('[data-hint]', form).textContent = hint;
      field(x.base && x.base !== 'https://' ? 'key' : 'base_url').focus();
    };
  }
  form.onclick = async (e) => {
    const what = e.target.dataset?.do;
    if (what === 'cancel') dialog.close();
    if (what === 'delete' && confirm(`Apagar ${v.name}?`)) {
      const out = await attempt(() => api('DELETE', `/providers/${p.id}`), 'Apagada');
      if (out) done(out);
    }
    if (what === 'unkey' && confirm(`Tirar a chave de ${v.name}? Os modelos dela param de responder.`)) {
      const out = await attempt(() => api('PUT', `/providers/${p.id}/key`, { value: '' }), 'Chave tirada');
      if (out) done(out);
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(form)), enabled: field('enabled').checked };
    delete body.preset;
    const out = await attempt(() => (p ? api('PUT', `/providers/${p.id}`, body) : api('POST', '/providers', body)), body.key ? (fresh ? 'Conectada' : 'Chave trocada') : 'Salvo');
    if (!out) return;
    done(out);
    // Just connected, with its key: straight on to the senses that still have no model.
    if (fresh && body.key) {
      const added = out.providers.reduce((a, b) => (b.id > a.id ? b : a));
      state.wizard = true;
      nextInWizard(added.id);
    }
  };
  dialog.showModal();
}

// ── Aparelhos ──────────────────────────────────────────────────────────────
async function loadDevices() {
  const q = state.deviceQuery;
  const out = await attempt(() => api('GET', `/devices?q=${encodeURIComponent(q.q)}&filter=${q.filter}&sort=${q.sort}&offset=${q.offset}`));
  if (!out || state.view !== 'aparelhos') return;
  state.devices = out;
  const typing = document.activeElement?.name === 'q';
  render();
  if (typing) {
    const input = $('input[name=q]');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function aparelhos() {
  const d = state.devices;
  const q = state.deviceQuery;
  const mode = state.config.settings.attestation;
  const verified = (x) => (x.attested
    ? `<span class="pill good" title="${esc(x.attest_note)}">Verificado${x.attest_level === 'strongbox' ? ' · StrongBox' : ''}</span>`
    : `<span class="pill ${mode === 'off' ? '' : 'warn'}" title="${esc(x.attest_note)}">${esc(x.attest_note || 'Não verificado')}</span>`);
  const seg = (name, opts) => `<div class="seg">${opts.map(([k, l]) => `<button data-dq="${name}" data-v="${k}" aria-pressed="${q[name] === k}">${l}</button>`).join('')}</div>`;
  const plan = (x) => `<select class="plan" data-plan="${x.id}" title="${x.plan.kind === 'trial' ? `até ${when(x.plan.trial_ends)}` : ''}">
      <option value="plus" ${x.plan.kind === 'plus' ? 'selected' : ''}>Novelo+</option>
      <option value="trial" ${x.plan.kind === 'trial' ? 'selected' : ''}>${x.plan.kind === 'trial' ? `Teste até ${when(x.plan.trial_ends).slice(0, 5)}` : 'Teste (começar)'}</option>
      <option value="ended" ${x.plan.kind === 'ended' ? 'selected' : ''}>Encerrado</option></select>`;
  return `<div class="head"><h1>Aparelhos</h1>${d ? `<span class="faint">${num(d.devices.length)}${d.more ? '+' : ''}</span>` : ''}</div>
    <div class="filters"><input type="search" name="q" placeholder="Buscar pelo código ou nota" value="${esc(q.q)}">
      ${seg('filter', [['all', 'Todos'], ['unverified', 'Não verificados'], ['blocked', 'Bloqueados']])}
      ${seg('sort', [['seen', 'Recentes'], ['cost', 'Gasto de hoje']])}</div>
    ${d?.devices.length ? `<div class="devices">${d.devices.map((x, i) => `<article class="card device rise ${x.status === 'blocked' ? 'blocked' : ''}" style="--i:${Math.min(i, 8)}">
        <header><span class="dev-ico">${icon('aparelhos')}</span>
          <div class="dev-name"><b class="mono" title="${esc(x.id)}">${esc(x.id.slice(0, 10))}</b><small>${x.note ? `${esc(x.note)} · ` : ''}visto ${ago(x.last_seen)} · app ${esc(x.app_version || '—')}</small></div>
          ${verified(x)}</header>
        <div class="dev-row">${plan(x)}<span class="faint small">hoje: ${num(x.requests)} pedidos · ${usd(x.cost)}</span>
          <span class="dev-acts">${x.status === 'blocked'
            ? `<button class="btn quiet" data-act="device" data-id="${x.id}" data-status="ok">Liberar</button>`
            : `<button class="btn quiet danger" data-act="device" data-id="${x.id}" data-status="blocked">Bloquear</button>`}
            <button class="btn quiet" data-act="device-erase" data-id="${x.id}" title="Apagar o registro deste aparelho (pedido da pessoa)">Apagar</button></span></div>
      </article>`).join('')}</div>` : `<div class="card empty-state">${icon('aparelhos')}<p>${q.q || q.filter !== 'all' ? 'Nenhum aparelho com esse filtro.' : 'Nenhum aparelho ainda. Eles aparecem aqui quando abrem o app.'}</p></div>`}
    <div class="actions">${q.offset ? '<button class="btn" data-act="devices-page" data-d="-50">Anteriores</button>' : ''}${d?.more ? '<button class="btn" data-act="devices-page" data-d="50">Próximos</button>' : ''}</div>`;
}

// ── Ajustes ────────────────────────────────────────────────────────────────
function ajustes() {
  const s = state.config.settings;
  const plans = [['plus', 'Novelo+', 'Tudo liberado desde o primeiro dia.'], ['trial', 'Teste', `${num(s.trial_days)} dias, depois o app segue com a inteligência própria.`]];
  const modes = [
    ['require', 'Exigir', 'Só entra aparelho de verdade com o app assinado por você.'],
    ['observe', 'Observar', 'Confere e anota em Aparelhos, sem barrar ninguém.'],
    ['off', 'Desligada', 'Qualquer um entra. Só pra testes.'],
  ];
  return `<div class="head"><h1>Ajustes</h1><span class="faint small">${icon('check')} salva sozinho</span></div>
    <form data-form="settings" class="stack">
      <div class="card rise" style="--i:0"><h2>Quem instala o app</h2><p class="sub">entra como</p>
        <div class="choice two">${plans.map(([k, title, text]) => `<label><input type="radio" name="new_plan" value="${k}" ${s.new_plan === k ? 'checked' : ''}><b>${title}</b><small class="sub">${text}</small></label>`).join('')}</div>
        <div class="form"><label>Dias de teste<input type="number" name="trial_days" min="0" value="${s.trial_days}"></label></div></div>
      <div class="card rise" style="--i:1"><h2>Teto de gasto</h2><p class="sub">Batendo o teto, os pagos param; os grátis seguem.</p>
        <div class="form"><label>Por dia (US$) <small>0 = sem teto</small><input type="number" name="budget_day_usd" min="0" step="any" value="${s.budget_day_usd}"></label>
        <label>Por mês (US$) <small>0 = sem teto</small><input type="number" name="budget_month_usd" min="0" step="any" value="${s.budget_month_usd}"></label></div></div>
      <div class="card rise" style="--i:2"><h2>Verificação do aparelho</h2>
        <div class="choice">${modes.map(([k, title, text]) => `<label><input type="radio" name="attestation" value="${k}" ${s.attestation === k ? 'checked' : ''}><b>${title}</b><small class="sub">${text}</small></label>`).join('')}</div></div>
      <div class="card row-card rise" style="--i:3"><div><h2>Pausar tudo</h2><p class="sub">O app recebe "em manutenção" e guarda os pedidos pra depois.</p></div>
        <label class="switch" title="Pausar"><input type="checkbox" name="paused" ${s.paused ? 'checked' : ''}><i></i></label></div>
      <details class="more" data-key="advanced"><summary>Avançado</summary><div class="card"><div class="form">
        <label>Gasto por aparelho, por dia (US$) <small>0 = sem teto</small><input type="number" name="device_day_usd" min="0" step="any" value="${s.device_day_usd}"></label>
        <label>Aparelhos novos por endereço, por dia <small>0 = sem limite</small><input type="number" name="register_per_ip_day" min="0" value="${s.register_per_ip_day}"></label>
        <label>Aparelhos novos por dia, ao todo <small>0 = sem limite</small><input type="number" name="register_per_day" min="0" value="${s.register_per_day}"></label>
        <label>Fuso do dia<input type="text" name="timezone" value="${esc(s.timezone)}"></label>
        <label>Dias guardando pedido por pedido <small>só números; os totais por hora ficam</small><input type="number" name="keep_days" min="1" value="${s.keep_days}"></label>
        <label class="wide">Pacotes aceitos <small>um por linha</small><textarea name="app_packages">${esc(s.app_packages)}</textarea></label>
        <label class="wide">Certificado que assina o app (SHA-256) <small>um por linha; vazio = não confere a assinatura</small><textarea name="app_cert_sha256" placeholder="AB:CD:…">${esc(s.app_cert_sha256)}</textarea></label>
      </div></div></details>
    </form>
    <div class="actions"><button class="btn quiet" data-act="logout">Sair do painel</button></div>`;
}

// ── what a click does ──────────────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-view],[data-act],[data-hours],[data-dq],[data-metric]');
  if (!t || dialog.contains(t)) return;
  const d = t.dataset;
  if (d.view) return go(d.view);
  if (d.hours) {
    state.hours = Number(d.hours);
    return refresh();
  }
  if (d.metric) {
    state.metric = d.metric;
    return render();
  }
  if (d.dq) {
    state.deviceQuery[d.dq] = d.v;
    state.deviceQuery.offset = 0;
    return loadDevices();
  }
  const c = state.config;
  switch (d.act) {
    case 'logout':
      await api('POST', '/logout', {}).catch(() => {});
      return login();
    case 'resume': {
      const out = await attempt(() => api('PUT', '/settings', { paused: 0 }), 'Retomado');
      return out && refresh();
    }
    case 'job':
      await go('inteligencia');
      return document.getElementById(`job-${d.job}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    case 'route-new':
      return routeDialog(d.job);
    case 'route-edit':
      return routeDialog(null, c.routes.find((r) => r.id === Number(d.id)));
    case 'route-move': {
      const out = await attempt(() => api('POST', `/routes/${d.id}/move`, { dir: Number(d.dir) }));
      return out && done(out);
    }
    case 'route-test':
      return testRoute(d.id);
    case 'provider-new':
      return providerDialog();
    case 'provider-edit':
      return providerDialog(c.providers.find((p) => p.id === Number(d.id)));
    case 'device': {
      const note = d.status === 'blocked' ? prompt('Bloquear este aparelho. Uma nota (opcional):', '') : '';
      if (note === null) return;
      await attempt(() => api('PUT', `/devices/${d.id}`, { status: d.status, note }), d.status === 'blocked' ? 'Bloqueado' : 'Liberado');
      return loadDevices();
    }
    case 'device-erase':
      if (!confirm(`Apagar tudo o que o servidor guarda do aparelho ${d.id.slice(0, 10)}?\n\nA chave, o plano e os números de uso somem. Se o app ainda estiver instalado, ele entra de novo como aparelho novo.`)) return;
      await attempt(() => api('DELETE', `/devices/${d.id}`), 'Apagado');
      return loadDevices();
    case 'devices-page':
      state.deviceQuery.offset = Math.max(0, state.deviceQuery.offset + Number(d.d));
      return loadDevices();
  }
});

// The page's forms have no "Salvar": Enter just finishes the field, and the change is what saves.
document.addEventListener('submit', (e) => {
  if (!e.target.closest('[data-form]')) return;
  e.preventDefault();
  document.activeElement?.blur?.();
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset?.plan) {
    await attempt(() => api('PUT', `/devices/${el.dataset.plan}`, { plan: el.value }), 'Plano trocado');
    return loadDevices();
  }
  const form = el.closest('form[data-form]');
  if (!form || dialog.contains(form) || !el.name) return;
  let out;
  if (form.dataset.form === 'settings') {
    out = await attempt(() => api('PUT', '/settings', { [el.name]: el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value }), 'Salvo');
  } else if (form.dataset.form === 'job') {
    const f = Object.fromEntries(new FormData(form));
    for (const box of form.querySelectorAll('input[type=checkbox]')) f[box.name] = box.checked ? 1 : 0;
    out = await attempt(() => api('PUT', `/jobs/${form.dataset.key}`, f), 'Salvo');
  }
  // Kept, not redrawn: the next field may already have the cursor.
  if (out) state.config = out;
});

let typing;
document.addEventListener('input', (e) => {
  if (e.target.name !== 'q' || state.view !== 'aparelhos') return;
  state.deviceQuery.q = e.target.value;
  state.deviceQuery.offset = 0;
  clearTimeout(typing);
  typing = setTimeout(loadDevices, 250);
});

start();
