'use strict';
/**
 * opencode model catalogue reader.
 *
 * Talks to the opencode background service over its HTTP API:
 *   opencode api GET /api/model
 *
 * That endpoint returns every model with its provider, pricing (`cost`),
 * reachability (`status`, `enabled`) and token limits (`limit`). We keep only
 * the free models (cost 0) and cache the result, since the service is not
 * always running.
 */

const { execFile } = require('node:child_process');

const OC = process.env.OPENCODE_BIN || 'opencode';
const TIMEOUT_MS = Number(process.env.OC_TIMEOUT) || 30_000;

function runOpencodeApi(path) {
  return new Promise((resolve) => {
    execFile(OC, ['api', 'GET', path], { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, error: err.message || String(err) });
        try {
          const start = stdout.indexOf('{');
          if (start < 0) return resolve({ ok: false, error: 'no JSON in response' });
          resolve({ ok: true, data: JSON.parse(stdout.slice(start)) });
        } catch (e) {
          resolve({ ok: false, error: 'bad JSON: ' + e.message });
        }
      });
  });
}

/** the API returns cost as an array of pricing tiers; take the base tier */
const baseCost = (m) => (Array.isArray(m.cost) ? m.cost[0] : m.cost) || null;

const isFree = (m) => {
  const c = baseCost(m);
  if (!c) return false;
  return (c.input || 0) === 0 && (c.output || 0) === 0;
};

function normalise(m) {
  const c = baseCost(m) || {};
  return {
    id: m.id,
    modelID: m.modelID,
    provider: m.providerID,
    name: m.name || m.id,
    family: m.family || null,
    context: m.limit?.context ?? null,
    maxInput: m.limit?.input ?? null,
    maxOutput: m.limit?.output ?? null,
    tools: Boolean(m.capabilities?.tools),
    modalities: [...(m.capabilities?.input || [])],
    variants: (m.variants || []).map((v) => v.id),
    cost: { input: c.input || 0, output: c.output || 0, cacheRead: c.cache?.read || 0, cacheWrite: c.cache?.write || 0 },
    // a model is reachable when opencode reports it enabled and active
    reachable: m.enabled !== false && (m.status === undefined || m.status === 'active'),
    status: m.status ?? 'unknown',
    enabled: m.enabled !== false,
  };
}

/**
 * Poll the opencode model endpoint.
 * @param {{intervalMs?: number, freeOnly?: boolean, onUpdate?: Function}} opts
 */
function startModelReader({ intervalMs = 60_000, freeOnly = true, onUpdate } = {}) {
  let stopped = false;
  let running = false;
  let cached = { state: 'pending', models: [], checkedAt: 0, error: null };

  const poll = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const res = await runOpencodeApi('/api/model');
      if (stopped) return;

      if (!res.ok) {
        cached = { ...cached, state: cached.models.length ? 'stale' : 'error', error: res.error, checkedAt: Date.now() };
      } else {
        const all = (res.data?.data || []).map(normalise);
        const models = freeOnly ? all.filter(isFree) : all;
        cached = { state: 'live', models, allCount: all.length, error: null, checkedAt: Date.now() };
      }
      onUpdate?.(cached);
    } finally {
      running = false;
    }
  };

  poll();
  const timer = setInterval(poll, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = { startModelReader, runOpencodeApi, normalise, isFree };
