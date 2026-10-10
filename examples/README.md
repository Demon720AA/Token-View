# Examples: connecting your own LLM backends

The dashboard core knows nothing about any specific tool. Everything real comes
from **plugins** — small CommonJS modules in `plugins/` (git-ignored, local only).

## Quick start

```bash
# 1. declare your sources
cp config/sources.example.json config/sources.json
# 2. activate a plugin
cp examples/plugins/opencode-db.js plugins/
cp examples/plugins/opencode-catalogue.js plugins/
# 3. restart the service
systemctl --user restart token-view
```

With no `config/sources.json` and no plugins, the server runs built-in demo
traffic so the pages are never blank.

## Available examples

| File | What it does |
| --- | --- |
| `plugins/opencode-db.js` | Real usage from the opencode SQLite database (totals + per-message feed) |
| `plugins/opencode-catalogue.js` | Model list/prices/reachability via `opencode api GET /api/model` |
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
