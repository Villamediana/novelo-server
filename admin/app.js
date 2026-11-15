// The panel. Plain JavaScript, no build: what it shows comes from /api, what it changes goes back there.
const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const dialog = $('#dialog');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('pt-BR');
const num = (n) => nf.format(Math.round(n || 0));
const compact = (n) => new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const usd = (n, digits) => `US$ ${(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: digits ?? ((n || 0) >= 100 ? 0 : (n || 0) >= 1 ? 2 : 3), maximumFractionDigits: digits ?? ((n || 0) >= 100 ? 0 : (n || 0) >= 1 ? 2 : 3) })}`;
const secs = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`);
const size = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB` : `${Math.round((b || 0) / 1024 ** 2).toLocaleString('pt-BR')} MB`);
const pct = (a, b) => (b ? `${((100 * a) / b).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '0%');
const when = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  if (m < 48 * 60) return `há ${Math.round(m / 60)} h`;
  return `há ${Math.round(m / 1440)} dias`;
};

const LOGO = `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="var(--accent)"/><g fill="none" stroke="var(--on-accent)" stroke-width="1.7" stroke-linecap="round" opacity=".9"><path d="M8 19c9-8 23-8 32 0"/><path d="M6 27c11-9 25-9 36 0"/><path d="M10 35c8-6 20-6 28 0"/><path d="M17 5c-7 12-7 26 0 38"/><path d="M29 4c8 12 8 28 0 40"/></g></svg>`;
const VIEWS = [['visao', 'Visão'], ['modelos', 'Modelos'], ['apis', 'APIs'], ['custos', 'Custos e limites'], ['aparelhos', 'Aparelhos'], ['seguranca', 'Segurança']];

const state = { view: location.hash.slice(1) || 'visao', hours: 24, config: null, overview: null, devices: null, deviceQuery: { q: '', filter: 'all', sort: 'seen', offset: 0 }, tests: {}, timer: null };

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
      <nav>${VIEWS.map(([k, label]) => `<button data-view="${k}" ${k === state.view ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav>
      <button class="btn quiet out" data-act="logout">Sair</button>
    </aside><main class="${state.shown === state.view ? '' : 'enter'}">${inner}</main></div>`;
  // The page slides in when it is opened, not every time its numbers are refreshed.
  state.shown = state.view;
}

async function start() {
  if (!(await attempt(async () => (state.config = await api('GET', '/config'))))) return;
  go(VIEWS.some(([k]) => k === state.view) ? state.view : 'visao');
}

async function go(view) {
  state.view = view;
  history.replaceState(null, '', `#${view}`);
  clearInterval(state.timer);
  if (view === 'visao') {
    await loadOverview();
    state.timer = setInterval(() => document.hidden || dialog.open || loadOverview(), 10_000);
  } else if (view === 'aparelhos') {
    await loadDevices();
  } else {
    if (view === 'modelos') state.timer = setInterval(async () => {
      if (document.hidden || dialog.open || document.activeElement?.closest('details')) return;
      state.config = await api('GET', '/config').catch(() => state.config);
      render();
    }, 10_000);
    render();
  }
}

function render() {
  const open = [...document.querySelectorAll('details[open]')].map((d) => d.dataset.key);
  frame({ visao, modelos, apis, custos, aparelhos, seguranca }[state.view]());
  for (const el of document.querySelectorAll('[data-w]')) requestAnimationFrame(() => (el.style.width = `${el.dataset.w}%`));
  for (const d of document.querySelectorAll('details')) if (open.includes(d.dataset.key)) d.open = true;
  charts();
}

// ── Visão ──────────────────────────────────────────────────────────────────
async function loadOverview() {
  const o = await api('GET', `/overview?hours=${state.hours}`).catch((e) => (toast(e.message, true), null));
  if (!o || state.view !== 'visao') return;
  state.overview = o;
  render();
}

function meter(label, spent, limit) {
  const share = limit ? Math.min(100, (100 * spent) / limit) : 0;
  const cls = share >= 100 ? 'over' : share >= 80 ? 'near' : '';
  return `<div class="card meter"><div class="row"><span class="sub">${label}</span><span><span class="num">${usd(spent)}</span> <span class="faint">${limit ? `de ${usd(limit, limit % 1 ? 2 : 0)}` : 'sem teto'}</span></span></div>
    <div class="track"><i class="${cls}" data-w="${share.toFixed(1)}"></i></div></div>`;
}

function visao() {
  const o = state.overview;
  if (!o) return '<div class="head"><h1>Visão</h1></div>';
  const t = o.total;
  const waiting = Object.values(o.live.waiting).reduce((a, b) => a + b, 0);
  const flying = Object.values(o.live.lanes).reduce((a, l) => a + l.in_flight, 0) + o.live.free_lane.in_flight;
  const ok = t.requests - t.errors;
  const status = o.paused ? '<span class="pill bad">Pausado</span>' : o.live.over_budget ? '<span class="pill warn">Teto atingido · só grátis</span>' : '<span class="pill good live">No ar</span>';
  const range = [[24, '24 h'], [168, '7 dias'], [720, '30 dias']];
  return `<div class="head"><h1>Visão</h1>${status}
      <div class="seg">${range.map(([h, l]) => `<button data-hours="${h}" aria-pressed="${state.hours === h}">${l}</button>`).join('')}</div></div>
    <div class="kpis">
      <div class="kpi"><span>Pedidos</span><div class="num">${compact(t.requests)}</div><small>${num(t.retries)} novas tentativas</small></div>
      <div class="kpi"><span>Custo</span><div class="num">${usd(t.cost)}</div><small>${t.requests ? usd((1000 * t.cost) / t.requests) : 'US$ 0'} por mil</small></div>
      <div class="kpi"><span>Sem resposta</span><div class="num">${pct(t.errors, t.requests)}</div><small>${num(t.errors)} pedidos</small></div>
      <div class="kpi"><span>Tempo médio</span><div class="num">${ok ? secs(t.ms_sum / ok) : '—'}</div><small>${t.requests ? secs(t.queue_ms_sum / t.requests) : '0 s'} na fila</small></div>
      <div class="kpi"><span>Agora</span><div class="num">${num(flying)}</div><small>${num(waiting)} na fila</small></div>
      <div class="kpi"><span>Aparelhos hoje</span><div class="num">${compact(o.devices.active_today)}</div><small>${num(o.devices.total)} ao todo · ${num(o.devices.new_24h)} novos</small></div>
      <div class="kpi"><span>Novelo+</span><div class="num">${compact(o.plans.plus)}</div><small>${num(o.plans.trial)} em teste · ${num(o.plans.ended)} encerrados</small></div>
      <div class="kpi"><span>Backup na nuvem</span><div class="num">${size(o.backups.bytes)}</div><small>${num(o.backups.vaults)} ${o.backups.vaults === 1 ? 'pessoa' : 'pessoas'}</small></div>
    </div>
    <div class="meters">${meter('Gasto de hoje', o.budget.day_usd, o.budget.day_limit)}${meter('Gasto do mês', o.budget.month_usd, o.budget.month_limit)}</div>
    <section><div class="charts">
      <div class="card chart" data-chart="requests"><header><b>Pedidos</b><span class="num">${num(t.requests)}</span></header></div>
      <div class="card chart" data-chart="errors"><header><b>Sem resposta</b><span class="num">${num(t.errors)}</span></header></div>
      <div class="card chart" data-chart="cost"><header><b>Custo</b><span class="num">${usd(t.cost)}</span></header></div>
    </div></section>
    <section><h2>Por modelo</h2><div class="card scroll">${o.models.length ? `<table><thead><tr><th>Pedido</th><th>Modelo</th><th class="r">Pedidos</th><th class="r">Sem resposta</th><th class="r">Ruins</th><th class="r">Tokens</th><th class="r">Custo</th><th class="r">Tempo</th></tr></thead><tbody>
      ${o.models.map((m) => `<tr><td>${esc(o.labels[m.job] ?? m.job)}</td><td><span class="mono">${esc(m.model)}</span></td><td class="r">${num(m.requests)}</td><td class="r">${pct(m.errors, m.requests)}</td><td class="r">${num(m.bad)}</td><td class="r">${compact(m.tokens_in)} → ${compact(m.tokens_out)}</td><td class="r">${usd(m.cost)}</td><td class="r">${m.requests - m.errors ? secs(m.ms_sum / (m.requests - m.errors)) : '—'}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Nenhum pedido neste período.</p>'}</div></section>
    <section><h2>Por pedido</h2><div class="card scroll"><table><thead><tr><th>Pedido</th><th class="r">Pedidos</th><th class="r">Na fila agora</th><th class="r">Metade responde em</th><th class="r">95% em</th><th class="r">Custo</th></tr></thead><tbody>
      ${Object.entries(o.labels).map(([key, label]) => {
        const j = o.jobs.find((x) => x.job === key);
        return `<tr><td>${esc(label)}</td><td class="r">${num(j?.requests)}</td><td class="r">${num(o.live.waiting[key])}</td><td class="r">${j?.recent.n ? secs(j.recent.p50) : '—'}</td><td class="r">${j?.recent.n ? secs(j.recent.p95) : '—'}</td><td class="r">${usd(j?.cost)}</td></tr>`;
      }).join('')}</tbody></table></div></section>
    ${o.errors.length ? `<section><h2>Sem resposta nas últimas 24 h</h2><div class="card scroll"><table><tbody>${o.errors.map((e) => `<tr><td>${esc(ERRORS[e.code] ?? e.code)}</td><td class="r">${num(e.n)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
    <section><h2>Avisos</h2><div class="card">${o.events.length ? `<ul class="events">${o.events.map((e) => `<li><time>${when(e.ts)}</time><b>${esc(e.kind)}</b><span>${esc(e.message)}</span></li>`).join('')}</ul>` : '<p class="empty">Nada por aqui.</p>'}</div></section>`;
}

const ERRORS = { busy: 'Modelos ocupados até o fim da espera', budget: 'Teto de gasto atingido', refused: 'Pedido recusado pelo modelo', not_configured: 'Sem modelo configurado', gone: 'O app desistiu de esperar', internal: 'Erro interno' };

/** Three small charts on the same days or hours, one measure each. */
function charts() {
  const o = state.overview;
  if (state.view !== 'visao' || !o) return;
  const label = (p) => (o.by_day ? p.key.slice(8, 10) + '/' + p.key.slice(5, 7) : new Date(p.key).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
  const defs = {
    requests: { get: (p) => p.requests, cls: '', show: (v) => `${num(v)} pedidos` },
    errors: { get: (p) => p.errors, cls: 'danger', show: (v) => `${num(v)} sem resposta` },
    cost: { get: (p) => p.cost, cls: 'accent', show: (v) => usd(v) },
  };
  for (const box of document.querySelectorAll('[data-chart]')) {
    const def = defs[box.dataset.chart];
    const pts = o.series;
    const max = Math.max(...pts.map(def.get), 0);
    const W = 600;
    const H = 120;
    const step = W / pts.length;
    const bw = Math.max(2, Math.min(18, step - 2));
    const cols = pts.map((p, i) => {
      const v = def.get(p);
      const h = max ? Math.max(v ? 2 : 0, (v / max) * (H - 6)) : 0;
      const x = i * step + (step - bw) / 2;
      const r = Math.min(4, bw / 2, h);
      const bar = h ? `<path class="bar ${def.cls}" d="M${x},${H} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z"/>` : '';
      return `<g class="col" data-i="${i}">${bar}<rect class="hit" x="${i * step}" y="0" width="${step}" height="${H}"/></g>`;
    }).join('');
    box.insertAdjacentHTML('beforeend', `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc($('header b', box).textContent)} por ${o.by_day ? 'dia' : 'hora'}">${cols}<line class="base" x1="0" x2="${W}" y1="${H}" y2="${H}"/></svg>
      <div class="axis"><span>${label(pts[0])}</span><span>${max ? `pico ${def.show(max)}` : ''}</span><span>${label(pts[pts.length - 1])}</span></div>`);
    const svg = $('svg', box);
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
}

// ── Modelos ────────────────────────────────────────────────────────────────
function modelos() {
  const c = state.config;
  const provider = (id) => c.providers.find((p) => p.id === id);
  const noKey = c.providers.filter((p) => p.enabled && !p.has_key);
  return `<div class="head tight"><h1>Modelos</h1></div><p class="sub lead">Cada pedido vai ao primeiro da lista que tiver vaga; os de baixo entram quando os de cima falham ou lotam.</p>
    ${noKey.length ? `<p class="card">Falta a chave de ${noKey.map((p) => esc(p.name)).join(', ')}. <button class="btn quiet" data-view="apis">Colocar</button></p><br>` : ''}
    ${c.jobs.map((j) => {
      const routes = c.routes.filter((r) => r.job === j.key);
      return `<div class="card job"><header><h2>${esc(j.label)}</h2>
          ${c.live.waiting[j.key] ? `<span class="pill warn">${num(c.live.waiting[j.key])} na fila</span>` : ''}
          ${j.enabled ? '' : '<span class="pill bad">Desligado</span>'}
          <button class="btn" data-act="route-new" data-job="${j.key}">+ Modelo</button></header>
        ${routes.length ? routes.map((r, i) => {
          const p = provider(r.provider_id);
          const live = r.live;
          const test = state.tests[r.id];
          const status = !r.enabled ? '<span class="pill">Desligado</span>'
            : live?.cooling_ms ? `<span class="pill warn" title="${esc(live.last_error)}">Em pausa ${Math.ceil(live.cooling_ms / 1000)} s</span>`
            : live?.in_flight ? `<span class="pill good live">${live.in_flight} de ${live.limit}</span>` : '';
          return `<div class="route ${r.enabled ? '' : 'off'}"><span class="n">${i + 1}</span>
            <div class="what"><b>${esc(r.model)}</b><div><span>${esc(p?.name ?? '?')}</span><span>${r.max_concurrency} ao mesmo tempo</span>${r.rpm ? `<span>${num(r.rpm)}/min</span>` : ''}
              ${r.price_in || r.price_out ? `<span>${usd(r.price_in, 2)} → ${usd(r.price_out, 2)} por milhão</span>` : ''}</div></div>
            <div class="acts">${status}
              <button class="btn quiet" data-act="route-move" data-id="${r.id}" data-dir="-1" title="Subir" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="btn quiet" data-act="route-move" data-id="${r.id}" data-dir="1" title="Descer" ${i === routes.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="btn quiet" data-act="route-test" data-id="${r.id}">${test === 'running' ? 'Testando…' : 'Testar'}</button>
              <button class="btn quiet" data-act="route-edit" data-id="${r.id}">Editar</button></div>
            ${test && test !== 'running' ? `<div class="result ${test.ok ? '' : 'faint'}">${test.ok ? `<span class="pill good">Respondeu em ${secs(test.ms)}</span> “${esc(test.text)}” · ${usd(test.cost, 5)}` : `<span class="pill bad">Não respondeu</span> ${esc(test.error)}`}</div>` : ''}
          </div>`;
        }).join('') : `<p class="empty">${j.free_fallback ? 'Sem modelo próprio: usa só os grátis.' : 'Nenhum modelo: este pedido não responde.'}</p>`}
        <details class="limits" data-key="job-${j.key}"><summary>Limites e espera</summary><form class="form" data-form="job" data-key="${j.key}">
          <label>Por aparelho, por minuto<input type="number" name="per_minute" min="0" value="${j.per_minute}"></label>
          <label>Por aparelho, por dia<input type="number" name="per_day" min="0" value="${j.per_day}"></label>
          <label>Espera máxima na fila (s)<input type="number" name="wait_s" min="5" max="600" value="${j.wait_s}"></label>
          <label>Tamanho máximo do pedido (KB)<input type="number" name="max_body_kb" min="16" value="${j.max_body_kb}"></label>
          <label>Tokens máximos de resposta<input type="number" name="max_output_tokens" min="16" value="${j.max_output_tokens}"></label>
          <label class="check"><input type="checkbox" name="free_fallback" ${j.free_fallback ? 'checked' : ''}>Último recurso: modelos grátis</label>
          <label class="check"><input type="checkbox" name="enabled" ${j.enabled ? 'checked' : ''}>Ligado</label>
          <div class="actions wide"><button class="btn primary">Salvar</button></div></form></details></div>`;
    }).join('')}
    <section><h2>Modelos grátis</h2><div class="card"><p class="sub">${num(c.live.free.known)} conhecidos${c.live.free.resting.length ? ` · ${c.live.free.resting.length} descansando` : ''}${Object.keys(c.live.free.last_good).length ? ` · último bom: ${Object.values(c.live.free.last_good).map(esc).join(', ')}` : ''}</p>
      <form class="form" data-form="settings">
        <label class="wide">Preferidos, na ordem <small>um por linha</small><textarea name="free_preferred">${esc(c.settings.free_preferred)}</textarea></label>
        <label class="wide">Evitar <small>só quando não sobrar outro</small><textarea name="free_avoid">${esc(c.settings.free_avoid)}</textarea></label>
        <label>Ao mesmo tempo<input type="number" name="free_max_concurrency" min="1" value="${c.settings.free_max_concurrency}"></label>
        <label>Por minuto<input type="number" name="free_rpm" min="0" value="${c.settings.free_rpm}"></label>
        <label>API dos grátis<select name="free_provider">${c.providers.map((p) => `<option value="${p.id}" ${p.id === c.settings.free_provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <div class="actions wide"><button class="btn primary">Salvar</button></div></form></div></section>`;
}

async function routeDialog(job, route) {
  const c = state.config;
  const r = route ?? { job, provider_id: c.providers[0]?.id, model: '', enabled: 1, max_concurrency: 32, rpm: 0, price_in: 0, price_out: 0, timeout_s: 90, extra: '{}' };
  const label = c.jobs.find((j) => j.key === r.job)?.label ?? r.job;
  dialog.innerHTML = `<h2>${route ? 'Editar modelo' : 'Novo modelo'} · ${esc(label)}</h2><form class="form" method="dialog">
    <label>API<select name="provider_id">${c.providers.map((p) => `<option value="${p.id}" ${p.id === r.provider_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label>Modelo<input type="text" name="model" list="models" value="${esc(r.model)}" placeholder="carregando a lista…" autocomplete="off" required><datalist id="models"></datalist></label>
    <label>Ao mesmo tempo<input type="number" name="max_concurrency" min="1" value="${r.max_concurrency}"></label>
    <label>Pedidos por minuto <small>0 = sem limite</small><input type="number" name="rpm" min="0" value="${r.rpm}"></label>
    <label>Entrada, US$ por milhão<input type="number" name="price_in" min="0" step="any" value="${r.price_in}"></label>
    <label>Saída, US$ por milhão<input type="number" name="price_out" min="0" step="any" value="${r.price_out}"></label>
    <label>Tempo limite (s)<input type="number" name="timeout_s" min="5" max="600" value="${r.timeout_s}"></label>
    <label class="check"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}>Ligado</label>
    <label class="wide">Extras do pedido <small>JSON somado a cada chamada, ex.: {"reasoning":{"effort":"low"}}</small><textarea name="extra">${esc(r.extra)}</textarea></label>
    <div class="actions wide">${route ? '<button type="button" class="btn danger" data-do="delete">Tirar</button>' : ''}
      <button type="button" class="btn" data-do="cancel">Cancelar</button><button class="btn primary">Salvar</button></div></form>`;
  const form = $('form', dialog);
  let models = [];
  const load = async () => {
    form.model.placeholder = 'carregando a lista…';
    const out = await api('GET', `/providers/${form.provider_id.value}/models?job=${r.job}`).catch(() => null);
    models = out?.models ?? [];
    $('#models', dialog).innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.priced ? `${usd(m.price_in, 2)} → ${usd(m.price_out, 2)}` : m.name)}</option>`).join('');
    form.model.placeholder = models.length ? `${models.length} modelos servem pra ${label.toLowerCase()}` : 'nome do modelo';
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
    if (what === 'cancel') dialog.close();
    if (what === 'delete' && confirm(`Tirar ${r.model}?`)) {
      const out = await attempt(() => api('DELETE', `/routes/${r.id}`), 'Tirado');
      if (out) done(out);
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const body = { ...f, job: r.job, provider_id: Number(f.provider_id), enabled: form.enabled.checked };
    const out = await attempt(() => (route ? api('PUT', `/routes/${r.id}`, body) : api('POST', '/routes', body)), 'Salvo');
    if (out) done(out);
  };
  dialog.showModal();
  load();
}

function done(config) {
  state.config = config;
  if (dialog.open) dialog.close();
  render();
}

// ── APIs ───────────────────────────────────────────────────────────────────
function apis() {
  const c = state.config;
  return `<div class="head"><h1>APIs</h1><button class="btn" data-act="provider-new">+ API</button></div>
    ${c.providers.map((p) => `<div class="card job"><header><h2>${esc(p.name)}</h2>
        ${p.has_key ? `<span class="pill good">Chave ····${esc(p.key_tail)}</span>` : '<span class="pill bad">Sem chave</span>'}
        ${p.enabled ? '' : '<span class="pill">Desligada</span>'}
        <button class="btn quiet" data-act="provider-edit" data-id="${p.id}">Editar</button></header>
      <p class="sub mono">${esc(p.base_url)}</p>
      <form class="form" data-form="key" data-id="${p.id}">
        <label class="wide">${p.has_key ? 'Trocar a chave' : 'Chave'} <small>fica só no arquivo .env do servidor (${esc(p.key_env)}), nunca volta pra tela</small>
          <input type="password" name="value" autocomplete="off" placeholder="sk-…"></label>
        <div class="actions wide"><button class="btn primary">Guardar chave</button></div></form></div>`).join('')}`;
}

function providerDialog(p) {
  const v = p ?? { name: '', base_url: 'https://', key_env: '', headers: '{}', extra: '{}', enabled: 1, routes: 0 };
  dialog.innerHTML = `<h2>${p ? 'Editar API' : 'Nova API'}</h2><form class="form" method="dialog">
    <label>Nome<input type="text" name="name" value="${esc(v.name)}" required></label>
    <label>Variável da chave no .env<input type="text" name="key_env" value="${esc(v.key_env)}" placeholder="MINHA_API_KEY" required></label>
    <label class="wide">Endereço <small>o que vem antes de /chat/completions</small><input type="text" name="base_url" value="${esc(v.base_url)}" required></label>
    <label class="wide">Cabeçalhos a mais <small>JSON</small><textarea name="headers">${esc(v.headers)}</textarea></label>
    <label class="wide">Extras de todo pedido <small>JSON</small><textarea name="extra">${esc(v.extra)}</textarea></label>
    <label class="check"><input type="checkbox" name="enabled" ${v.enabled ? 'checked' : ''}>Ligada</label>
    <div class="actions wide">${p && !p.routes ? '<button type="button" class="btn danger" data-do="delete">Apagar</button>' : ''}
      <button type="button" class="btn" data-do="cancel">Cancelar</button><button class="btn primary">Salvar</button></div></form>`;
  const form = $('form', dialog);
  form.onclick = async (e) => {
    if (e.target.dataset?.do === 'cancel') dialog.close();
    if (e.target.dataset?.do === 'delete' && confirm(`Apagar ${v.name}?`)) {
      const out = await attempt(() => api('DELETE', `/providers/${p.id}`), 'Apagada');
      if (out) done(out);
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(form)), enabled: form.enabled.checked };
    const out = await attempt(() => (p ? api('PUT', `/providers/${p.id}`, body) : api('POST', '/providers', body)), 'Salvo');
    if (out) done(out);
  };
  dialog.showModal();
}

// ── Custos e limites ───────────────────────────────────────────────────────
function custos() {
  const s = state.config.settings;
  return `<div class="head"><h1>Custos e limites</h1></div>
    <form data-form="settings"><div class="card"><h2>Teto de gasto</h2><p class="sub">Batendo o teto, os modelos pagos param até virar o dia (ou o mês). Com o último recurso ligado, os grátis seguem atendendo.</p>
      <div class="form"><label>Por dia (US$) <small>0 = sem teto</small><input type="number" name="budget_day_usd" min="0" step="any" value="${s.budget_day_usd}"></label>
      <label>Por mês (US$) <small>0 = sem teto</small><input type="number" name="budget_month_usd" min="0" step="any" value="${s.budget_month_usd}"></label>
      <label>Fuso do dia<input type="text" name="timezone" value="${esc(s.timezone)}"></label></div></div>
    <section><div class="card"><h2>Cada aparelho</h2><p class="sub">Os limites por minuto e por dia de cada pedido ficam em Modelos.</p>
      <div class="form"><label>Gasto por aparelho, por dia (US$) <small>0 = sem teto</small><input type="number" name="device_day_usd" min="0" step="any" value="${s.device_day_usd}"></label>
      <label>Aparelhos novos por endereço, por dia <small>0 = sem limite</small><input type="number" name="register_per_ip_day" min="0" value="${s.register_per_ip_day}"></label>
      <label>Aparelhos novos por dia, ao todo <small>0 = sem limite</small><input type="number" name="register_per_day" min="0" value="${s.register_per_day}"></label></div></div></section>
    <section><div class="card"><h2>Planos</h2><p class="sub">Quem decide o plano é o servidor, nunca o celular. Terminado o teste, a inteligência do Novelo para de atender aquele aparelho e o app segue com a inteligência própria (no celular ou API). Reinstalar o app não recomeça o teste.</p>
      <div class="form"><label>Aparelho novo entra como<select name="new_plan"><option value="plus" ${s.new_plan === 'plus' ? 'selected' : ''}>Novelo+</option><option value="trial" ${s.new_plan === 'trial' ? 'selected' : ''}>Teste</option></select></label>
      <label>Dias de teste<input type="number" name="trial_days" min="0" value="${s.trial_days}"></label></div></div></section>
    <section><div class="card"><h2>Backup na nuvem</h2><p class="sub">Só Novelo+ envia. Chega cifrado do celular: aqui ninguém consegue abrir. Ler de volta e apagar o próprio backup funciona em qualquer plano.</p>
      <div class="form"><label>Espaço por pessoa (MB)<input type="number" name="backup_quota_mb" min="1" value="${s.backup_quota_mb}"></label>
      <label>Versões guardadas<input type="number" name="backup_keep" min="1" value="${s.backup_keep}"></label>
      <label>Teto de tudo (GB) <small>0 = só o limite do disco</small><input type="number" name="backup_total_gb" min="0" step="any" value="${s.backup_total_gb}"></label></div></div></section>
    <section><div class="card"><h2>Registro dos pedidos</h2><p class="sub">Guarda só números (hora, modelo, tempo, tokens, custo). O que a pessoa disse e a resposta nunca são gravados.</p>
      <div class="form"><label>Dias guardando pedido por pedido <small>os totais por hora ficam</small><input type="number" name="keep_days" min="1" value="${s.keep_days}"></label></div></div></section>
    <div class="actions"><button class="btn primary">Salvar</button></div></form>`;
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
  return `<div class="head"><h1>Aparelhos</h1>
      <input type="search" name="q" placeholder="Buscar pelo código ou nota" value="${esc(q.q)}" class="search">
      ${seg('filter', [['all', 'Todos'], ['unverified', 'Não verificados'], ['blocked', 'Bloqueados']])}
      ${seg('sort', [['seen', 'Recentes'], ['cost', 'Gasto de hoje']])}</div>
    <div class="card scroll">${d?.devices.length ? `<table><thead><tr><th>Aparelho</th><th>Visto</th><th>Desde</th><th>App</th><th>Plano</th><th>Verificação</th><th class="r">Hoje</th><th class="r">Gasto hoje</th><th></th></tr></thead><tbody>
      ${d.devices.map((x) => `<tr><td><span class="mono" title="${esc(x.id)}">${esc(x.id.slice(0, 10))}</span>${x.note ? `<br><span class="faint small">${esc(x.note)}</span>` : ''}</td>
        <td>${ago(x.last_seen)}</td><td>${when(x.created)}</td><td>${esc(x.app_version || '—')}</td>
        <td><select class="plan" data-plan="${x.id}" title="${x.plan.kind === 'trial' ? `até ${when(x.plan.trial_ends)}` : ''}">
          <option value="plus" ${x.plan.kind === 'plus' ? 'selected' : ''}>Novelo+</option>
          <option value="trial" ${x.plan.kind === 'trial' ? 'selected' : ''}>${x.plan.kind === 'trial' ? `Teste até ${when(x.plan.trial_ends).slice(0, 5)}` : 'Teste (começar)'}</option>
          <option value="ended" ${x.plan.kind === 'ended' ? 'selected' : ''}>Encerrado</option></select></td>
        <td>${verified(x)}${x.boot && x.boot !== 'verified' ? ` <span class="faint small">sistema modificado</span>` : ''}</td>
        <td class="r">${num(x.requests)}</td><td class="r">${usd(x.cost)}</td>
        <td class="r">${x.status === 'blocked'
          ? `<button class="btn quiet" data-act="device" data-id="${x.id}" data-status="ok">Liberar</button>`
          : `<button class="btn quiet danger" data-act="device" data-id="${x.id}" data-status="blocked">Bloquear</button>`}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Nenhum aparelho.</p>'}</div>
    <div class="actions">${q.offset ? '<button class="btn" data-act="devices-page" data-d="-50">Anteriores</button>' : ''}${d?.more ? '<button class="btn" data-act="devices-page" data-d="50">Próximos</button>' : ''}</div>`;
}

// ── Segurança ──────────────────────────────────────────────────────────────
function seguranca() {
  const s = state.config.settings;
  const modes = [
    ['require', 'Exigir', 'Só entra aparelho de verdade rodando o app assinado por você. É o que vale em produção.'],
    ['observe', 'Observar', 'Confere e anota em Aparelhos, mas não barra ninguém. Use até ver o seu celular aparecer como verificado.'],
    ['off', 'Desligada', 'Qualquer um que copie o protocolo consegue se registrar. Só pra testes.'],
  ];
  return `<div class="head"><h1>Segurança</h1></div>
    <form data-form="settings"><div class="card"><h2>Verificação do aparelho</h2>
      <p class="sub">Cada instalação cria uma chave dentro do hardware seguro do celular e o Android atesta que ela é de um aparelho real, feita por este app. Todo pedido vem assinado com ela.</p>
      <div class="choice">${modes.map(([k, title, text]) => `<label><input type="radio" name="attestation" value="${k}" ${s.attestation === k ? 'checked' : ''}><b>${title}</b><small class="sub">${text}</small></label>`).join('')}</div>
      <div class="form"><label class="wide">Pacotes aceitos <small>um por linha</small><textarea name="app_packages">${esc(s.app_packages)}</textarea></label>
      <label class="wide">Certificado que assina o app (SHA-256) <small>um por linha; vazio = não confere a assinatura</small><textarea name="app_cert_sha256" placeholder="AB:CD:…">${esc(s.app_cert_sha256)}</textarea></label></div></div>
    <section><div class="card"><h2>Parar tudo</h2><p class="sub">O app recebe "em manutenção" e guarda o que a pessoa disse pra mandar depois.</p>
      <div class="form"><label class="check"><input type="checkbox" name="paused" ${s.paused ? 'checked' : ''}>Pausar a inteligência do Novelo</label></div></div></section>
    <div class="actions"><button class="btn primary">Salvar</button></div></form>`;
}

// ── what a click does ──────────────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-view],[data-act],[data-hours],[data-dq]');
  if (!t || dialog.contains(t)) return;
  const d = t.dataset;
  if (d.view) return go(d.view);
  if (d.hours) {
    state.hours = Number(d.hours);
    return loadOverview();
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
    case 'route-new':
      return routeDialog(d.job);
    case 'route-edit':
      return routeDialog(null, c.routes.find((r) => r.id === Number(d.id)));
    case 'route-move': {
      const out = await attempt(() => api('POST', `/routes/${d.id}/move`, { dir: Number(d.dir) }));
      return out && done(out);
    }
    case 'route-test': {
      state.tests[d.id] = 'running';
      render();
      state.tests[d.id] = (await attempt(() => api('POST', `/routes/${d.id}/test`, {}))) ?? undefined;
      return render();
    }
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
    case 'devices-page':
      state.deviceQuery.offset = Math.max(0, state.deviceQuery.offset + Number(d.d));
      return loadDevices();
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  for (const box of form.querySelectorAll('input[type=checkbox]')) f[box.name] = box.checked ? 1 : 0;
  let out;
  if (form.dataset.form === 'settings') out = await attempt(() => api('PUT', '/settings', f), 'Salvo');
  if (form.dataset.form === 'job') out = await attempt(() => api('PUT', `/jobs/${form.dataset.key}`, f), 'Salvo');
  if (form.dataset.form === 'key') {
    if (!f.value && !confirm('Sem nada escrito, a chave é removida. Remover?')) return;
    out = await attempt(() => api('PUT', `/providers/${form.dataset.id}/key`, f), f.value ? 'Chave guardada' : 'Chave removida');
  }
  if (out) done(out);
});

document.addEventListener('change', async (e) => {
  const id = e.target.dataset?.plan;
  if (!id) return;
  await attempt(() => api('PUT', `/devices/${id}`, { plan: e.target.value }), 'Plano trocado');
  loadDevices();
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
