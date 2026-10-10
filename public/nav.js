'use strict';
// Shared navigation, built from the configured sources so pages never
// hardcode any specific backend. Include on every page:
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

buildNav();
