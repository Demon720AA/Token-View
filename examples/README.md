# Examples: connecting your own LLM backends

The dashboard core knows nothing about any specific tool. Everything real comes
from **plugins** — small CommonJS modules in `plugins/` (git-ignored, local only).

## Quick start

```bash
# 1. declare your sources (this folder's sources.json has opencode + openrouter + template)
cp examples/sources.json config/sources.json
# 2. activate plugins (one copy per provider for the db reader)
cp examples/plugins/opencode-db.js examples/plugins/opencode-catalogue.js plugins/
cp examples/plugins/openrouter.js plugins/
cp examples/plugins/opencode-db.js plugins/openrouter-db.js
#   then in plugins/openrouter-db.js set SOURCE_ID and PROVIDER to 'openrouter'
# 3. restart the service
systemctl --user restart token-view
```

With no `config/sources.json` and no plugins, the server runs built-in demo
traffic so the pages are never blank.

## Available examples

| File | What it does |
| --- | --- |
| `plugins/opencode-db.js` | Real usage from the opencode SQLite database (totals + per-message feed). Tracks one provider per copy — set `SOURCE_ID`/`PROVIDER` at the top (e.g. copy to `openrouter-db.js` with both set to `'openrouter'`) |
| `plugins/opencode-catalogue.js` | Free models of the opencode (Zen) provider via `opencode api GET /api/model`, plus per-model rate-limit hits scraped from the opencode log |
| `plugins/openrouter.js` | Free models of the OpenRouter provider, plus real quota from `GET /api/v1/auth/key` (monthly budget + free daily allowance) and per-model rate-limit hits |
| `plugins/antigravity-db.js` | Antigravity usage scraped from local conversation SQLite DBs (best-effort — most conversations lack token counts; not real-time, ~10s delay) |
| `plugins/antigravity-catalogue.js` | Antigravity model menu via `agy models` (one `id<TAB>Name` pair per line) |
| `plugins/antigravity-quota.js` | Antigravity quota via `agy -p "/usage"` + `/credits`, with multi-account support (`AGY_EXTRA_ACCOUNTS="Label=/path/to/home"`); buckets are labelled with the account email decoded from each profile's id_token |
| `plugins/rest-poller.js` | **Template**: poll any HTTP JSON endpoint (`enabled: false` until configured) |
| `plugins/cli-poller.js` | **Template**: run any CLI that prints JSON, expose it as the account quota block |
| `plugins/plugin-template.js` | Minimal skeleton with the full result reference |

`sources.json` in this folder shows an `opencode` source plus a `my-llm` template
source to pair with the pollers above.

## Writing a plugin for another LLM
1. Copy `plugins/plugin-template.js` to `plugins/<name>.js`.
2. Set `id` to a source id from your `config/sources.json` and `enabled: true`.
3. Implement `poll()` to return `{ total?, events?, quota?, catalogue? }`
   (all optional — return what your backend provides).
4. Return `null` (or throw) when the backend is unreachable.

Two common patterns:

- **The backend has an HTTP usage endpoint** → start from `rest-poller.js`,
  fill in `url`/`headers` (use `$VAR` for secrets from the environment) and adapt
  `map()` to the endpoint's JSON shape.
- **The backend only has a CLI** (e.g. a `/usage` slash-command that answers
  with JSON) → start from `cli-poller.js`, fill in `command`/`args` and adapt
  `map()`. Poll slowly — these commands can take seconds.

Source ids must match `^[a-z0-9-]+$` (they become URL paths: `/<id>`).

## Quota without a quota API

Many free tiers expose no "remaining allowance" endpoint. Two workarounds,
both demonstrated by `openrouter.js` (key API) and `opencode-catalogue.js` (log scraping):

- **Provider key API**: some providers (e.g. OpenRouter `GET /api/v1/auth/key`)
  report budget + daily free allowance for the key. Return it as `quota.buckets`
  and the source page renders the big remaining blocks. Secrets go in env vars
  (`OPENROUTER_API_KEY`); reusing a locally stored credential is acceptable only
  because it never leaves the machine.
- **Observed rate limits**: scrape the backend's own log for
  `RateLimit`/`QuotaExceeded` errors and attribute them (via session/request id)
  to models as `limited: { hits, lastHit }`. The Models page renders a badge.
  Absence of hits means "not recently limited", not "unlimited" — say so in docs.
