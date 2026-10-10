'use strict';
// Detail page: per-model token breakdown.

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat();
const num = (n) => fmt.format(Math.round(n || 0));
const usd = (n) => '$' + (n < 1 ? (n || 0).toFixed(4) : n.toFixed(2));
const pct = (n) => (n * 100).toFixed(1) + '%';

const compact = (n) => {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};

function ago(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function quotaLevel(p) {
  if (p >= 0.85) return 'crit';
  if (p >= 0.65) return 'warn';
  return 'ok';
}

/** models belonging to the selected source scope */
function scopedModels(snap) {
  if (filter === 'all') return snap.models;
  return snap.models
    .map((m) => {
      const p = m.perSource[filter];
      if (!p || (p.inputTokens + p.outputTokens) === 0) return null;
      const scale = (x) => x * ((p.inputTokens + p.outputTokens) / Math.max(1, m.totalTokens));
      return {
        ...m,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        cacheReadTokens: p.cacheReadTokens,
        costUsd: p.costUsd,
        requests: p.requests,
        totalTokens: p.inputTokens + p.outputTokens,
        tokensPerSec: m.tokensPerSec * ((p.inputTokens + p.outputTokens) / Math.max(1, m.totalTokens)),
      };
    })
    .filter(Boolean);
}

const filter = 'all';
let lastSnap = null;

function render(snap) {
  lastSnap = snap;

  const models = scopedModels(snap).filter((m) => m.totalTokens > 0 || m.requests > 0);
  const total = models.reduce((s, m) => s + m.totalTokens, 0) || 1;
  const cacheRead = models.reduce((s, m) => s + (m.cacheReadTokens || 0), 0);
  const reasoning = models.reduce((s, m) => s + (m.reasoningTokens || 0), 0);
  const cost = models.reduce((s, m) => s + m.costUsd, 0);
  const unpriced = models.filter((m) => !m.priced && m.costUsd === 0).length;

  $('modelCount').textContent = num(models.length);
  $('modelCountSub').textContent = filter === 'all' ? 'all sources' : filter;
  $('detailTps').textContent = num(models.reduce((s, m) => s + m.tokensPerSec, 0));
  $('cacheRead').textContent = compact(cacheRead);
  $('cacheShare').textContent = total ? pct(cacheRead / (total + cacheRead)) + ' of all tokens' : 'no cache reads';
  $('reasoning').textContent = compact(reasoning);
  $('detailCost').textContent = usd(cost);
  $('unpriced').textContent = unpriced ? unpriced + ' model(s) free/unpriced' : 'all models priced';

  const top = models.slice().sort((a, b) => b.totalTokens - a.totalTokens)[0];
  $('topModel').textContent = top ? top.id : '—';
  $('topModelSub').textContent = top
    ? pct(top.totalTokens / total) + ' of ' + compact(total) + ' tok'
    : ' ';

  renderTable(models, total);
  renderShare(models, total);
}

function renderTable(models, total) {
  const body = $('modelTable').querySelector('tbody');
  if (!models.length) {
    body.innerHTML = '<tr><td colspan="15" class="empty">no usage recorded yet</td></tr>';
    return;
  }
  body.innerHTML = models
    .slice()
    .sort((a, b) => b.totalTokens - a.totalTokens || b.tokensPerSec - a.tokensPerSec)
    .map((m) => {
      const share = m.totalTokens / total;
      const split = Object.entries(m.perSource)
        .filter(([, p]) => p.inputTokens + p.outputTokens > 0)
        .map(([id, p]) => {
          const frac = (p.inputTokens + p.outputTokens) / m.totalTokens;
          return `<i style="width:${(frac * 100).toFixed(1)}%;background:${p.color}" title="${p.label}: ${num(p.inputTokens + p.outputTokens)} tok"></i>`;
        })
        .join('');
      return `<tr>
        <td><span class="chip" style="background:${m.color}"></span><b>${m.id}</b></td>
        <td class="dim">${m.provider}</td>
        <td class="r">${num(m.inputTokens)}</td>
        <td class="r">${num(m.outputTokens)}</td>
        <td class="r dim">${m.cacheReadTokens ? num(m.cacheReadTokens) : '—'}</td>
        <td class="r dim">${m.reasoningTokens ? num(m.reasoningTokens) : '—'}</td>
        <td class="r"><b>${num(m.totalTokens)}</b></td>
        <td class="r">${pct(share)}</td>
        <td class="r">${m.tokensPerSec.toFixed(1)}</td>
        <td class="r">${num(m.requests)}</td>
        <td class="r ${m.errors ? 'bad' : 'dim'}">${m.errors || '—'}</td>
        <td class="r">${m.costUsd ? usd(m.costUsd) : '—'}</td>
        <td><span class="split">${split || '<i style="width:100%;background:#2c3549"></i>'}</span></td>
        <td class="dim">${ago(m.lastSeen)}</td>
      </tr>`;
    })
    .join('');
}

function renderShare(models, total) {
  $('shareBars').innerHTML = models
    .slice()
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((m) => {
      const share = m.totalTokens / total;
      const inShare = m.totalTokens ? m.inputTokens / m.totalTokens : 0;
      return `
      <div class="model-row">
        <div class="model-name">
          <span class="chip" style="background:${m.color}"></span>
          <b>${m.id}</b> <small>${m.provider}</small>
        </div>
        <div class="model-num">${compact(m.totalTokens)} tok · ${m.tokensPerSec.toFixed(1)} tok/s · ${pct(share)}</div>
        <div class="bar"><i style="width:${(share * 100).toFixed(1)}%;background:${m.color}"></i></div>
        <div class="src-bar">
          <i style="width:${(inShare * 100).toFixed(1)}%;background:${m.color};opacity:.35"></i>
          <i style="width:${((1 - inShare) * 100).toFixed(1)}%;background:${m.color}"></i>
        </div>
      </div>`;
    })
    .join('') || '<div class="delta">no usage recorded yet</div>';
}

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
    const isLive = snap.provenance?.mode === 'live';
    const mp = $('modePill');
    mp.textContent = isLive ? 'live data' : 'simulated';
    mp.className = 'pill ' + (isLive ? 'ok' : 'warn');
    render(snap);
  });
  es.onerror = () => setConn(false);
}

setInterval(() => {
  const d = new Date();
  $('clock').textContent =
    d.toTimeString().slice(0, 8) + ' · ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}, 1000);

connect();
