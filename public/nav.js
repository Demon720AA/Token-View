'use strict';
// Shared navigation and utility functions, included on every page:
//   <nav class="nav" id="mainNav"></nav><script src="/nav.js"></script>

async function buildNav() {
  const nav = document.getElementById('mainNav');
  if (!nav) return;

  let sources = [];
  try {
    sources = await (await fetch('/api/sources')).json();
  } catch {
    // server unreachable: leave the nav empty, connection pill explains why
  }

  const path = location.pathname.replace(/\/+$/, '') || '/';
  const active =
    path === '/' ? 'all'
    : path === '/detail' ? 'detail'
    : path === '/models' ? 'models'
    : path.slice(1);

  const link = (href, id, label) =>
    `<a class="nav-link${active === id ? ' active' : ''}" href="${href}">${label}</a>`;

  nav.innerHTML =
    link('/', 'all', 'All') +
    sources.map((s) => link('/' + s.id, s.id, s.label)).join('') +
    link('/models', 'models', 'Models') +
    link('/detail', 'detail', 'Detail');
}

/** Format a timestamp into human-readable ago string.
 *  Used by detail page, models page, and source page. */
function ago(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

/** Determine quota badge level from used percentage.
 *  Returns 'crit' (p >= 0.85), 'warn' (p >= 0.65), or 'ok'. */
function quotaLevel(p) {
  if (p >= 0.85) return 'crit';
  if (p >= 0.65) return 'warn';
  return 'ok';
}

/** Update the connection status pill.
 *  ok = live, err = disconnected/reconnecting. */
function setConn(ok) {
  const dot = document.getElementById('statusDot');
  if (!dot) return;
  dot.className = 'dot ' + (ok ? 'live' : 'down');
  const pill = document.getElementById('connPill');
  if (!pill) return;
  pill.textContent = ok ? 'live' : 'reconnecting';
  pill.className = 'pill ' + (ok ? 'ok' : 'err');
}

function connect() {
  // intentionally minimal – each page-specific connect()
  // below will override or extend as needed.
}

buildNav();