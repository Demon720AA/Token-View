'use strict';
// One page per source: /antigravity and /opencode.
// The source comes from the path, so there is no filter widget to get out of sync.

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

const SRC = (location.pathname.replace(/^\/+|\/+$/g, '') || 'opencode').toLowerCase();

document.title = SRC === 'antigravity' ? 'Antigravity — Token View' : 'OpenCode — Token View';
$('pageSub').textContent = SRC === 'antigravity' ? 'antigravity' : 'opencode';
document.documentElement.style.setProperty('--src', SRC === 'antigravity' ? '#f59e0b' : '#22d3ee');
$('navAg').classList.toggle('active', SRC === 'antigravity');
$('navOc').classList.toggle('active', SRC === 'opencode');

let lastSnap = null;
let eventCount = 0;
let prevTps = 0;
let prevActive = 0;

function quotaLevel(p) {
  if (p >= 0.85) return 'crit';
  if (p >= 0.65) return 'warn';
  return 'ok';
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
      const s = b.sources[SRC] || { input: 0, output: 0 };
      return { sec: b.sec, input: s.input, output: s.output };
    })
    .filter((b) => b.input + b.output > 0 || SRC === 'all');

  const max = Math.max(80, ...buckets.map((b) => b.input + b.output)) * 1.15;

  ctx.strokeStyle = '#1c2333';
  ctx.fillStyle = '#7b87a1';
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
  bars('input', 'rgba(125,140,170,.55)', 0.55);
  bars('output', 'rgba(167,139,250,.9)', 0.9);

  const last = buckets[buckets.length - 1];
  if (last) {
    const py = pad.t + ih - ((last.input + last.output) / max) * ih;
    ctx.fillStyle = '#a78bfa';
    ctx.beginPath();
    ctx.arc(x(buckets.length - 1), py, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#5c6780';
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

function render(snap) {
  lastSnap = snap;

  const s = snap.sources.find((x) => x.id === SRC);
  if (!s) {
    $('provNote').textContent = 'unknown source: ' + SRC;
    return;
  }

  const isLive = snap.provenance?.mode === 'live';
  const mp = $('modePill');
  mp.textContent = isLive ? 'live data' : 'simulated';
  mp.className = 'pill ' + (isLive ? 'ok' : 'warn');

  $('tps').textContent = num(s.tokensPerSec);
  $('active').textContent = num(s.activeRequests);
  $('totalTokens').textContent = num(s.totalTokens);
  $('tokenSplit').textContent = `in ${compact(s.inputTokens)} · out ${compact(s.outputTokens)}`;
  $('requests').textContent = num(s.requests);
  $('errors').textContent = s.errors ? num(s.errors) + ' errors' : 'no errors';
  $('errors').className = 'delta ' + (s.errors ? 'down' : '');
  $('cost').textContent = usd(s.costUsd);

  setDelta($('tpsDelta'), s.tokensPerSec - prevTps, (v) => (v >= 0 ? '+' : '') + num(v) + ' tok/s');
  setDelta($('activeDelta'), s.activeRequests - prevActive, (v) => (v >= 0 ? '+' : '') + num(v) + ' reqs');
  prevTps = s.tokensPerSec;
  prevActive = s.activeRequests;

  renderRemaining(s);
  renderModels(s, snap);
  renderQuota(s);
  drawChart();
}

function setDelta(el, v, fn) {
  el.textContent = fn(v);
  el.className = 'delta ' + (v > 0 ? 'up' : v < 0 ? 'down' : '');
}

function renderRemaining(s) {
  const q = s.quota;
  if (!q) {
    $('remaining').textContent = '—';
    $('remainingSub').textContent = 'no quota set';
    $('remaining').className = 'value';
    return;
  }
  const lv = quotaLevel(q.usedPct);
  $('remaining').textContent = compact(q.remainingTokens);
  $('remaining').className = 'value ' + (lv === 'crit' ? 'bad' : lv === 'warn' ? 'warn' : 'good');
  $('remainingSub').innerHTML =
    `<span class="badge ${lv}">${lv === 'ok' ? 'healthy' : lv === 'warn' ? 'tight' : 'nearly out'}</span>` +
    ` · ${(q.usedPct * 100).toFixed(2)}% used` +
    (q.totalCostUsd != null ? ` · $${q.remainingCostUsd.toFixed(2)} left` : '');
}

function renderModels(s, snap) {
  const colorOf = (id) => (snap.models.find((x) => x.id === id) || {}).color || '#22d3ee';
  const rows = (s.models || []).slice().sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  const total = s.totalTokens || 1;
  $('models').innerHTML =
    rows
      .map((m) => {
        const tok = m.inputTokens + m.outputTokens;
        if (!tok) return '';
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

function renderQuota(s) {
  const color = s.color;
  const q = s.quota;

  const tokenBar = q
    ? (() => {
        const lv = quotaLevel(q.usedPct);
        const cls = q.usedPct >= 1 ? 'over' : lv === 'crit' ? 'crit' : lv === 'warn' ? 'warn' : '';
        const leftColor = lv === 'crit' ? 'danger' : lv === 'warn' ? 'warnish' : '';
        const reset = q.resetAt ? 'resets ' + new Date(q.resetAt).toLocaleDateString() : 'no reset';
        const burn =
          q.exhaustedInSec < Infinity && q.exhaustedInSec < 86400
            ? 'runs out in ' + duration(q.exhaustedInSec)
            : reset;
        return `
        <div class="bucket">
          <div class="quota-top">
            <span class="qlabel">local allowance · ${q.period}</span>
            <span class="qleft ${leftColor}">${compact(q.remainingTokens)} tok left</span>
          </div>
          <div class="meter"><i class="${cls}" style="width:${Math.min(100, q.usedPct * 100).toFixed(2)}%"></i></div>
          <div class="quota-sub"><span>${compact(q.usedTokens)} used — ${(q.usedPct * 100).toFixed(2)}%</span>
          <span class="${leftColor}">${burn}</span></div>
        </div>`;
      })()
    : '';

  const pq = s.providerQuota;
  let provider = '';
  if (pq) {
    if (pq.state !== 'live') {
      provider = `<div class="bucket"><div class="quota-top">
        <span class="qlabel">antigravity account quota</span><span class="qleft danger">unavailable</span></div>
        <div class="delta">agy CLI: ${pq.error || 'no response'}</div></div>`;
    } else {
      provider =
        `<div class="qlabel" style="margin-bottom:8px">antigravity account quota · from agy CLI</div>` +
        pq.buckets
          .map((b) => {
            const frac = b.remainingFraction ?? 0;
            const used = 1 - frac;
            const lv = quotaLevel(used);
            const cls = used >= 1 ? 'over' : lv === 'crit' ? 'crit' : lv === 'warn' ? 'warn' : '';
            const txt = (frac * 100).toFixed(frac > 0 && frac < 0.01 ? 2 : 0) + '% left';
            return `<div class="bucket">
          <div class="quota-top">
            <span class="qlabel">${b.group}</span>
            <span class="qleft ${lv === 'crit' ? 'danger' : lv === 'warn' ? 'warnish' : ''}">${txt}</span>
          </div>
          <div class="meter"><i class="${cls}" style="width:${Math.min(100, frac * 100).toFixed(2)}%"></i></div>
          <div class="quota-sub"><span>${b.window} · ${b.name}</span>
          <span>${b.resetTime ? 'resets ' + new Date(b.resetTime).toLocaleString() : ''}</span></div>
        </div>`;
          })
          .join('') +
        (pq.credits && pq.credits.remaining != null
          ? `<div class="quota-sub" style="margin-top:8px"><span>G1 credits</span><b>${pq.credits.remaining}</b></div>`
          : '') +
        `<div class="quota-sub" style="margin-top:6px"><span>checked ${new Date(pq.checkedAt).toLocaleTimeString()}</span></div>`;
    }
  }

  $('provNote').textContent = s.provenance?.state === 'live'
    ? 'reading ' + String(s.provenance.file).replace(/^\/home\/[^/]+/, '~')
    : 'no local data';

  $('quotaBox').innerHTML =
    (tokenBar || provider ? tokenBar + provider : '') ||
    '<div class="delta">no usage recorded yet</div>';
}

function duration(sec) {
  if (!isFinite(sec)) return 'no burn';
  if (sec <= 0) return 'now';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(sec % 60)}s`;
}

// ---------------------------------------------------------------- live tokens

function renderEvent(e) {
  if (e.source !== SRC) return;
  eventCount++;
  $('streamCount').textContent = `${num(eventCount)} events`;

  const box = $('stream');
  const row = document.createElement('div');
  row.className = 'ev' + (e.error ? ' err' : '');
  const t = new Date(e.ts);
  row.innerHTML =
    `<span class="t">${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</span>` +
    `<span class="src" style="color:${colorOf(e.model)}">${e.model}</span>` +
    `<span class="m" title="${e.model} · ${e.app} · ${e.endpoint}">${e.app}</span>` +
    `<span class="tok">+${num(e.outputTokens)} tok</span>` +
    `<span class="cost">${usd(e.costUsd)}</span>`;
  box.prepend(row);
  while (box.childElementCount > 120) box.lastElementChild.remove();
}

const modelColor = new Map();
function colorOf(id) {
  if (!modelColor.has(id)) modelColor.set(id, '#7b87a1');
  return modelColor.get(id);
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
    const snap = JSON.parse(m.data);
    (snap.models || []).forEach((mm) => modelColor.set(mm.id, mm.color));
    render(snap);
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
