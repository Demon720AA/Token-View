'use strict';
// Main page: live throughput, totals, and the live token feed.

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat();
const num = (n) => fmt.format(Math.round(n || 0));
const usd = (n) => '$' + ((n || 0) < 1 ? (n || 0).toFixed(4) : n.toFixed(2));
const pct = (n) => (n * 100).toFixed(1) + '%';

const compact = (n) => {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};

const filter = 'all';
let lastSnap = null;
let eventCount = 0;
const eventLog = [];

function quotaLevel(p) {
  if (p >= 0.85) return 'crit';
  if (p >= 0.65) return 'warn';
  return 'ok';
}

function colorFor(id) {
  if (!colorFor.map) colorFor.map = new Map();
  if (!colorFor.map.has(id)) {
    const pal = ['#e8a33d', '#9ece6a', '#5b8c5b', '#cfe3cf'];
    colorFor.map.set(id, pal[colorFor.map.size % pal.length]);
  }
  return colorFor.map.get(id);
}

// ---------------------------------------------------------------- chart

const canvas = $('chart');
const ctx = canvas.getContext('2d');

function drawChart() {
  const snap = lastSnap;
  if (!snap) return;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 46, r: 8, t: 10, b: 22 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  const buckets = snap.series
    .map((b) => {
      let input = 0;
      let output = 0;
      const srcs = filter === 'all' ? b.sources : { [filter]: b.sources[filter] };
      for (const s of Object.values(srcs)) {
        if (!s) continue;
        input += s.input;
        output += s.output;
      }
      return { sec: b.sec, input, output };
    })
    .filter((b) => b.input + b.output > 0 || filter === 'all');

  const max = Math.max(80, ...buckets.map((b) => b.input + b.output)) * 1.15;

  ctx.strokeStyle = '#292e42';
  ctx.fillStyle = '#565f89';
  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y + 0.5);
    ctx.lineTo(w - pad.r, y + 0.5);
    ctx.stroke();
    ctx.fillText(Math.round(max * (1 - i / 4)), pad.l - 8, y);
  }

  const n = Math.max(buckets.length, 60);
  const step = iw / (n - 1);
  const x = (i) => pad.l + iw - (n - 1 - i) * step;

  const bars = (key, color, share) => {
    ctx.fillStyle = color;
    buckets.forEach((b, i) => {
      if (i < n - buckets.length) return;
      const width = Math.max(1.5, step * share);
      const offset = key === 'input' ? -width / 2 : width / 2;
      let base = pad.t + ih;
      if (key === 'output') base -= (b.input / max) * ih;
      const bh = (b[key] / max) * ih;
      ctx.fillRect(x(i) + offset, base - bh, width, bh);
    });
  };
  bars('input', 'rgba(125,207,255,.5)', 0.55);
  bars('output', 'rgba(158,206,106,.85)', 0.9);

  const last = buckets[buckets.length - 1];
  if (last) {
    const py = pad.t + ih - ((last.input + last.output) / max) * ih;
    ctx.fillStyle = '#9ece6a';
    ctx.beginPath();
    ctx.arc(x(buckets.length - 1), py, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#3b4261';
  const tail = buckets.slice(-4);
  tail.forEach((b, k) => {
    const i = buckets.length - tail.length + k;
    const d = new Date(b.sec * 1000);
    ctx.fillText(
      String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'),
      x(i), pad.t + ih + 6
    );
  });
}

// ---------------------------------------------------------------- render

let prevTps = 0;
let prevActive = 0;

function render(snap) {
  lastSnap = snap;

  const isLive = snap.provenance?.mode === 'live';
  const mp = $('modePill');
  mp.textContent = isLive ? 'live data' : 'simulated';
  mp.className = 'pill ' + (isLive ? 'ok' : 'warn');

  const scope =
    filter === 'all'
      ? { tps: snap.tokensPerSec, active: snap.activeRequests, total: snap.totals.totalTokens,
          requests: snap.totals.requests, cost: snap.totals.costUsd, errors: snap.totals.errors }
      : (() => {
          const s = snap.sources.find((x) => x.id === filter);
          return s
            ? { tps: s.tokensPerSec, active: s.activeRequests, total: s.totalTokens,
                requests: s.requests, cost: s.costUsd, errors: s.errors }
            : null;
        })();

  if (scope) {
    $('tps').textContent = num(scope.tps);
    $('active').textContent = num(scope.active);
    $('totalTokens').textContent = num(scope.total);
    $('requests').textContent = num(scope.requests);
    $('cost').textContent = usd(scope.cost);
    setDelta($('tpsDelta'), scope.tps - prevTps, (v) => (v >= 0 ? '+' : '') + num(v) + ' tok/s');
    setDelta($('activeDelta'), scope.active - prevActive, (v) => (v >= 0 ? '+' : '') + num(v) + ' reqs');
    $('errors').textContent = scope.errors ? num(scope.errors) + ' errors' : 'no errors';
    $('errors').className = 'delta ' + (scope.errors ? 'down' : '');
    prevTps = scope.tps;
    prevActive = scope.active;
  }

  renderRemaining(snap);
  renderModels(snap);
  renderSources(snap);
  drawChart();
}

/** per-source totals, one card each, with that source's quota meter */
function renderSources(snap) {
  const grand = snap.sources.reduce((a, x) => a + x.totalTokens, 0) || 1;

  $('sourceCards').innerHTML = snap.sources
    .map((s) => {
      const q = s.quota;
      const lv = q ? quotaLevel(q.usedPct) : null;
      return `
      <div class="kpi src-card" style="--sc:${s.color}">
        <div class="src-head">
          <span class="chip" style="background:${s.color}"></span>
          <b>${s.label}</b>
          <a class="src-open" href="/${s.id}">open &rarr;</a>
          <span class="live">${num(s.tokensPerSec)} tok/s</span>
        </div>
        <div class="src-grid">
          <div><span>input</span><b>${compact(s.inputTokens)}</b></div>
          <div><span>output</span><b>${compact(s.outputTokens)}</b></div>
          <div><span>cache read</span><b>${compact(s.cacheReadTokens)}</b></div>
          <div><span>reasoning</span><b>${compact(s.reasoningTokens)}</b></div>
          <div><span>requests</span><b>${num(s.requests)}</b></div>
          <div><span>cost</span><b>${usd(s.costUsd)}</b></div>
        </div>
        <div class="src-bar">
          <i style="width:${((s.inputTokens / (s.totalTokens || 1)) * 100).toFixed(1)}%;background:${s.color};opacity:.35"></i>
          <i style="width:${((s.outputTokens / (s.totalTokens || 1)) * 100).toFixed(1)}%;background:${s.color}"></i>
        </div>
        <div class="delta" style="margin-top:6px">${pct(s.totalTokens / grand)} of all tokens · ${num(s.errors)} errors</div>
        ${q ? `<div class="quota">
          <div class="quota-top">
            <span class="qlabel">${s.label} · ${q.period} quota</span>
            <span class="qleft ${lv === 'crit' ? 'danger' : lv === 'warn' ? 'warnish' : ''}">${compact(q.remainingTokens)} tok left</span>
          </div>
          <div class="meter"><i class="${lv === 'crit' ? (q.usedPct >= 1 ? 'over' : 'crit') : lv === 'warn' ? 'warn' : ''}" style="width:${Math.min(100, q.usedPct * 100).toFixed(2)}%"></i></div>
          <div class="quota-sub"><span>${compact(q.usedTokens)} used — ${(q.usedPct * 100).toFixed(2)}%</span>
          <span>${q.resetAt ? 'resets ' + new Date(q.resetAt).toLocaleDateString() : 'no reset'}</span></div>
        </div>` : ''}
      </div>`;
    })
    .join('');
}

function renderRemaining(snap) {
  const qs = (filter === 'all' ? snap.sources : snap.sources.filter((s) => s.id === filter))
    .map((s) => s.quota)
    .filter(Boolean);
  if (!qs.length) {
    $('remaining').textContent = '—';
    $('remainingSub').textContent = 'no quota set';
    $('remaining').className = 'value';
    return;
  }
  const usedPct = Math.max(...qs.map((q) => q.usedPct));
  const left = qs.reduce((a, q) => a + q.remainingTokens, 0);
  const leftCost = qs.reduce((a, q) => a + (q.remainingCostUsd ?? 0), 0);
  const lv = quotaLevel(usedPct);
  $('remaining').textContent = compact(left);
  $('remaining').className = 'value ' + (lv === 'crit' ? 'bad' : lv === 'warn' ? 'warn' : 'good');
  $('remainingSub').innerHTML =
    `<span class="badge ${lv}">${lv === 'ok' ? 'healthy' : lv === 'warn' ? 'tight' : 'nearly out'}</span>` +
    ` · ${(usedPct * 100).toFixed(2)}% used` +
    (leftCost > 0 ? ` · $${leftCost.toFixed(2)} left` : '');
}

function renderModels(snap) {
  if (filter === 'all') {
    $('modelTitle').textContent = 'By model';
    const total = snap.models.reduce((s, m) => s + m.totalTokens, 0) || 1;
    $('models').innerHTML = snap.models
      .filter((m) => m.totalTokens > 0)
      .slice()
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map((m) => {
        const share = m.totalTokens / total;
        return `
      <div class="model-row">
        <div class="model-name">
          <span class="chip" style="background:${m.color}"></span>
          <b>${m.id}</b> <small>${m.provider} · ${num(m.requests)} reqs</small>
        </div>
        <div class="model-num">${compact(m.totalTokens)} tok · ${usd(m.costUsd)} · ${pct(share)}</div>
        <div class="bar"><i style="width:${(share * 100).toFixed(1)}%;background:${m.color}"></i></div>
      </div>`;
      })
      .join('') || '<div class="delta">no usage recorded yet</div>';
    return;
  }

  const s = snap.sources.find((x) => x.id === filter);
  $('modelTitle').textContent = (s ? s.label : filter) + ' · by model';
  const total = s ? s.totalTokens || 1 : 1;
  const colorOf = (id) => (snap.models.find((x) => x.id === id) || {}).color || colorFor(id);
  $('models').innerHTML =
    ((s ? s.models : []) || [])
      .slice()
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
      .map((m) => {
        const tok = m.inputTokens + m.outputTokens;
        const share = tok / total;
        const color = colorOf(m.id);
        return `
      <div class="model-row">
        <div class="model-name">
          <span class="chip" style="background:${color}"></span>
          <b>${m.id}</b> <small>${num(m.requests)} reqs</small>
        </div>
        <div class="model-num">${compact(tok)} tok · ${usd(m.costUsd)} · ${pct(share)}</div>
        <div class="bar"><i style="width:${(share * 100).toFixed(1)}%;background:${color}"></i></div>
      </div>`;
      })
      .join('') || '<div class="delta">no usage recorded yet</div>';
}

function setDelta(el, v, fn) {
  el.textContent = fn(v);
  el.className = 'delta ' + (v > 0 ? 'up' : v < 0 ? 'down' : '');
}

// ---------------------------------------------------------------- live tokens

function renderEvent(e) {
  colorFor(e.source);
  eventLog.unshift(e);
  if (eventLog.length > 300) eventLog.pop();
  eventCount++;
  $('streamCount').textContent = `${num(eventCount)} events`;

  if (filter !== 'all' && e.source !== filter) return;

  const box = $('stream');
  const row = document.createElement('div');
  row.className = 'ev' + (e.error ? ' err' : '');
  const t = new Date(e.ts);
  row.innerHTML =
    `<span class="t">${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</span>` +
    `<span class="src" style="color:${colorFor(e.source)}">${e.source}</span>` +
    `<span class="m" title="${e.model} · ${e.app} · ${e.endpoint}"><b>${e.model}</b> <span style="color:#565f89">${e.app}</span></span>` +
    `<span class="tok">+${num(e.outputTokens)} tok</span>` +
    `<span class="cost">${usd(e.costUsd)}</span>`;
  box.prepend(row);
  while (box.childElementCount > 120) box.lastElementChild.remove();
}

// ---------------------------------------------------------------- SSE

function setConn(ok) {
  $('statusDot').className = 'dot ' + (ok ? 'live' : 'down');
  const p = $('connPill');
  p.textContent = ok ? 'live' : 'reconnecting';
  p.className = 'pill ' + (ok ? 'ok' : 'err');
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('tick', (m) => {
    setConn(true);
    render(JSON.parse(m.data));
  });
  es.addEventListener('event', (m) => renderEvent(JSON.parse(m.data)));
  es.onerror = () => setConn(false);
}

setInterval(() => {
  const d = new Date();
  $('clock').textContent =
    d.toTimeString().slice(0, 8) + ' · ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}, 1000);

window.addEventListener('resize', drawChart);
connect();
drawChart();
