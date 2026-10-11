'use strict';
// Catalogue page: which models exist, which still respond,
// and how much traffic each one has carried.

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat();

const num = (n) => fmt.format(Math.round(n || 0));
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

/** Format model traffic row for the models table.
 *  Returns a DOM string with tokens, requests, and cost. */
function modelTrafficRow(m) {
  const tok = m.inputTokens + m.outputTokens;
  if (!tok) return '';
  const share = tok / (window.modelTotalTokens || 1);
  const cost = m.costUsd ? '$' + m.costUsd.toFixed(2) : '—';
  return `
    <div class="model-row">
      <div class="model-name">
        <span class="chip" style="background:${m.color || '#22d3ee'}"></span>
        <b>${m.id}</b> <small>${m.requests || 0} reqs</small>
      </div>
      <div class="model-num">${compact(tok)} tok · ${cost} · ${pct(share)}</div>
      <div class="bar"><i style="width:${(share * 100).toFixed(1)}%;background:${m.color || '#22d3ee'}"></i></div>
    </div>`;
}

let last = null;

function stateOf(m) {
  if (!m.reachable) return { key: 'bad', label: 'blocked' };
  if (m.used) return { key: 'ok', label: 'in use' };
  return { key: 'idle', label: 'available' };
}

/** extra badge when the backend log shows this model being rate-limited */
function limitedBadge(m) {
  const l = m.limited;
  if (!l || !l.hits) return '';
  return ` <span class="badge crit" title="rate-limited ${l.hits}× · last ${ago(l.lastHit)}">limited ×${l.hits}</span>`;
}

function render(data) {
  last = data;

  const mp = $('modePill');
  mp.textContent = data.state === 'live' ? 'catalogue' : data.state;
  mp.className = 'pill ' + (data.state === 'live' ? 'ok' : 'warn');

  const models = data.models || [];
  const reachable = models.filter((m) => m.reachable);
  const used = models.filter((m) => m.used);
  const idle = reachable.filter((m) => !m.used);
  const totalTokens = models.reduce((a, m) => a + m.traffic.inputTokens + m.traffic.outputTokens, 0);
  const bestCtx = reachable.slice().sort((a, b) => (b.context || 0) - (a.context || 0))[0];

  $('freeCount').textContent = num(models.length);
  $('catalogueNote').textContent = data.totalCatalogue ? `of ${data.totalCatalogue} total models` : ' ';

  $('reachableCount').textContent = num(reachable.length);
  $('reachableNote').textContent = models.length ? pct(reachable.length / models.length) + ' can connect' : ' ';

  $('usedCount').textContent = num(used.length);
  $('idleCount').textContent = num(idle.length);
  $('idleNote').textContent = idle.length
    ? 'e.g. ' + idle.slice(0, 2).map((m) => m.id).join(', ')
    : 'none free left';

  $('bestContext').textContent = bestCtx ? compact(bestCtx.context) : '—';
  $('bestContextNote').textContent = bestCtx ? bestCtx.id : ' ';

  $('freeTraffic').textContent = compact(totalTokens);
  $('freeTrafficNote').textContent = data.checkedAt ? 'checked ' + new Date(data.checkedAt).toLocaleTimeString() : ' ';

  if (data.error && data.state !== 'live') {
    $('catalogueNote').textContent = 'backend unreachable: ' + data.error;
  }

  renderTable(models, totalTokens);
  renderShare(models, totalTokens);
}

function renderTable(models, total) {
  const body = $('modelTable').querySelector('tbody');
  if (!models.length) {
    body.innerHTML = '<tr><td colspan="14" class="empty">no models yet — is a catalogue plugin active?</td></tr>';
    return;
  }

  body.innerHTML = models
    .map((m) => {
      const t = m.traffic;
      const tok = t.inputTokens + t.outputTokens;
      const share = total ? tok / total : 0;
      const st = stateOf(m);
      return `<tr>
        <td><b>${m.id}</b></td>
        <td class="dim">${m.provider}</td>
        <td><span class="badge ${st.key === 'bad' ? 'crit' : st.key === 'ok' ? 'ok' : ''}">${st.label}</span>${limitedBadge(m)}</td>
        <td class="r">${m.context ? compact(m.context) : '—'}</td>
        <td class="r">${m.maxOutput ? compact(m.maxOutput) : '—'}</td>
        <td class="dim">${m.tools ? 'yes' : 'no'}</td>
        <td class="r">${t.requests ? num(t.requests) : '—'}</td>
        <td class="r">${t.inputTokens ? num(t.inputTokens) : '—'}</td>
        <td class="r">${t.outputTokens ? num(t.outputTokens) : '—'}</td>
        <td class="r dim">${t.cacheReadTokens ? num(t.cacheReadTokens) : '—'}</td>
        <td class="r"><b>${tok ? num(tok) : '—'}</b></td>
        <td class="r">${tok ? pct(share) : '—'}</td>
        <td><span class="split"><i style="width:${(share * 100).toFixed(1)}%;background:#9ece6a"></i></span></td>
        <td class="dim">${t.lastSeen ? ago(t.lastSeen) : 'never'}</td>
      </tr>`;
    })
    .join('');
}

function renderShare(models, total) {
  const rows = models
    .filter((m) => m.traffic.inputTokens + m.traffic.outputTokens > 0)
    .sort((a, b) => b.traffic.inputTokens + b.traffic.outputTokens - (a.traffic.inputTokens + a.traffic.outputTokens));

  $('shareBars').innerHTML =
    rows
      .map((m) => {
        const t = m.traffic;
        const tok = t.inputTokens + t.outputTokens;
        const share = tok / total;
        const inShare = t.inputTokens / tok;
        return `
      <div class="model-row">
        <div class="model-name">
          <span class="chip" style="background:#9ece6a"></span>
          <b>${m.id}</b> <small>${m.provider} · ${num(t.requests)} reqs${m.reachable ? '' : ' · blocked'}</small>
        </div>
        <div class="model-num">${compact(tok)} tok · ${pct(share)}</div>
        <div class="bar"><i style="width:${(share * 100).toFixed(1)}%;background:#9ece6a"></i></div>
        <div class="src-bar">
          <i style="width:${(inShare * 100).toFixed(1)}%;background:#9ece6a;opacity:.35"></i>
          <i style="width:${((1 - inShare) * 100).toFixed(1)}%;background:#9ece6a"></i>
        </div>
      </div>`;
      })
      .join('') || '<div class="delta">no traffic recorded on any free model yet</div>';
}

// ---------------------------------------------------------------- polling

function setConn(ok) {
  $('statusDot').className = 'dot ' + (ok ? 'live' : 'down');
  const p = $('connPill');
  p.textContent = ok ? 'live' : 'reconnecting';
  p.className = 'pill ' + (ok ? 'ok' : 'err');
}

async function poll() {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    render(await res.json());
    setConn(true);
  } catch (err) {
    setConn(false);
  }
}

// refresh traffic counters between catalogue polls
poll();
setInterval(poll, 10_000);

setInterval(() => {
  const d = new Date();
  $('clock').textContent =
    d.toTimeString().slice(0, 8) + ' · ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}, 1000);
