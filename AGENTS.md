# AGENTS.md — Token View

Instructions for AI coding agents working in this repo. Read this before
making any change.

## What this project is

Real-time LLM token usage dashboard (Node.js 18+, zero npm dependencies, SSE).
**Generic core + local plugins**: the core knows no specific backend; everything
vendor-specific lives in git-ignored local files.

## The split (most important rule)

| Committed to GitHub | Local only, NEVER commit |
| --- | --- |
| `server.js`, `public/`, `examples/`, `install/`, `config/sources.example.json`, docs | `plugins/*.js` (except `.gitkeep`), `config/sources.json` |

- `plugins/` = one small module per backend, API: `{ id, intervalMs, enabled?, poll }`
  where `poll()` resolves to `{ total?, events?, quota?, catalogue?, meta?, file? }` or `null`.
- `config/sources.json` = `[{ id, label, color, quota }]`. Source ids must match
  `^[a-z0-9-]+$` (they become URL paths `/<id>`).
- `examples/` shows the pattern (opencode readers, generic REST/CLI pollers, template).
- Never add vendor-specific code, paths (`~/.gemini/`, `*.db` locations, `$HOME`,
  usernames), or machine paths to the committed tree. The privacy scan in
  `SKILL.md` enforces this — run it before every push.

## How to work here

- **Add a source**: entry in local `config/sources.json` + plugin in local
  `plugins/`. No core change needed — page, nav, and quota appear automatically.
- **Edit the core** (`server.js`): sources come from config, real data only via
  `applyPluginResult()`. Keep `snapshot()` shape stable — all four pages consume it.
- **Edit pages** (`public/`): `nav.js` builds the menu from `/api/sources`, so
  never hardcode backend links. `source.html`/`source.js` serve every `/<id>`.
- **Theme**: terminal aesthetic, Tokyo Night palette (`public/style.css` `:root`).
  Canvas chart colors live in `app.js`/`source.js`/`models.js` — update them too.
- **Env vars**: `PORT`, `LIVE`, `SIMULATE`, `PERIOD`, `QUOTA_<ID>`, `QUOTACOST_<ID>`,
  `TOKEN_VIEW_URL`. Plugin-specific (`AGY_*`, `OC_*`) belong in plugin files, not core.

## Verify before push

```bash
for f in server.js public/*.js plugins/*.js examples/plugins/*.js; do node --check $f; done
systemctl --user restart token-view.service && sleep 10
for p in / /detail /models /api/summary /api/sources /api/models; do
  printf "%-14s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' localhost:4173$p)"
done
# plus each configured source page: /<id> (e.g. whatever is in config/sources.json)
```

All `200`. Then follow **`SKILL.md` (github-push skill)** step by step for the
privacy scan, commit, rebase, and push. Do not skip the privacy scan.

## Service

```bash
systemctl --user status token-view     # status
journalctl --user -u token-view -f     # logs ([plugins] lines show what loaded)
```

The service runs this directory. Static files (`public/`) take effect on browser
refresh; `server.js`/plugin changes need `systemctl --user restart token-view`.
