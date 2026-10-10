'use strict';
/**
 * Generic plugin: poll any HTTP JSON endpoint for usage counters.
 *
 * Setup:
 *   1. Fill in URL + HEADERS below (use $NAME for secrets from the environment).
 *   2. Adapt map() to your endpoint's JSON shape.
 *   3. Set enabled: true.
 *   4. Copy this file to ../../plugins/ and add a matching source
 *      to config/sources.json (see config/sources.example.json).
 *
 * map() must return { total?, events? }:
 *   total  — absolute counters { input, output, reasoning?, cacheRead?, cost? }
 *   events — fresh items [ { model?, inputTokens?, outputTokens?, ... } ]
 * Return only what your endpoint provides; either key may be omitted.
 */

const CONFIG = {
  enabled: false, // <-- set true after configuring URL below
  id: 'my-llm', // must match a source id in config/sources.json
  intervalMs: 30_000,

  url: 'https://api.example.com/v1/usage',
  method: 'GET',
  headers: {
    Authorization: 'Bearer $MYLLM_API_KEY', // $VAR is expanded from process.env
    'Content-Type': 'application/json',
  },
  timeoutMs: 15_000,

  /**
   * Translate the endpoint's JSON into { total?, events? }.
   * Example shape handled here:
   *   { "usage": { "prompt_tokens": 120, "completion_tokens": 40 },
   *     "recent": [ { "model": "x", "prompt": 10, "completion": 5, "ts": 123 } ] }
   */
  map(json) {
    const u = json.usage || {};
    return {
      total: {
        input: u.prompt_tokens ?? 0,
        output: u.completion_tokens ?? 0,
        cost: u.cost_usd ?? 0,
      },
      events: (json.recent || []).map((r) => ({
        model: r.model || 'unknown',
        inputTokens: r.prompt ?? 0,
        outputTokens: r.completion ?? 0,
        ts: r.ts || Date.now(),
      })),
    };
  },
};

function expandEnv(s) {
  return String(s).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => process.env[k] ?? '');
}

module.exports = {
  id: CONFIG.id,
  intervalMs: CONFIG.intervalMs,
  enabled: CONFIG.enabled,

  async poll() {
    const headers = Object.fromEntries(
      Object.entries(CONFIG.headers).map(([k, v]) => [k, expandEnv(v)])
    );
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
    try {
      const res = await fetch(CONFIG.url, { method: CONFIG.method, headers, signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return CONFIG.map(await res.json());
    } finally {
      clearTimeout(timer);
    }
  },
};
