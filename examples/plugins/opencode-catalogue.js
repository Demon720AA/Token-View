'use strict';
/**
 * Example plugin: opencode catalogue + quota.
 *
 * Catalogue (for the /models page) via the opencode background service:
 *   opencode api GET /api/model
 *
 * Quota (for the big block on the source page) from two observable signals —
 * opencode's free tier has no account-quota API, so this is the honest best:
 *
 *   1. OpenRouter key quota: GET https://openrouter.ai/api/v1/auth/key answers
 *      { limit, limit_remaining, usage_monthly, free_model_daily_requests }.
 *      Key comes from OPENROUTER_API_KEY, else from the opencode credential
 *      store as a convenience (same user, same machine).
 *   2. Observed rate limits: AI.Error.RateLimit / QuotaExceeded lines in the
 *      opencode log, joined to models through session_v2. Attached per model
 *      as `limited: { hits, lastHit }`.
 *
 * Returns { catalogue, quota }. Copy to ../../plugins/ to use.
 */

const { execFile } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // Node 18+, no npm needed

const OC = process.env.OPENCODE_BIN || 'opencode';
const TIMEOUT_MS = Number(process.env.OC_TIMEOUT) || 30_000;
const HOME = os.homedir();
const OPENCODE_DB = path.join(HOME, '.local/share/opencode/opencode.db');
const OPENCODE_LOG = path.join(HOME, '.local/share/opencode/log/opencode.log');

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
    // reachable = enabled and active in the catalogue (no test request sent)
    reachable: m.enabled !== false && (m.status === undefined || m.status === 'active'),
    status: m.status ?? 'unknown',
    enabled: m.enabled !== false,
  };
}

function fetchModels() {
  return new Promise((resolve) => {
    execFile(OC, ['api', 'GET', '/api/model'], { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
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

// ---------------------------------------------------------------- OpenRouter key quota

function openRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  // convenience: reuse the key opencode itself stored (same user, same machine)
  try {
    const db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
    try {
      const row = db
        .prepare("select value from credential where integration_id='openrouter' and active=1 limit 1")
        .get();
      if (!row) return null;
      const v = JSON.parse(row.value);
      return typeof v === 'string' ? v : v.key || null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function fetchKeyQuota() {
  const key = openRouterKey();
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: 'Bearer ' + key },
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: 'HTTP ' + res.status };
    return { ok: true, data: (await res.json()).data };
  } catch (err) {
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** next UTC midnight — the free daily allowance resets every day */
function nextUtcMidnight() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

function keyQuotaToBuckets(k) {
  const buckets = [];
  const free = k.free_model_daily_requests;
  if (free && free.limit > 0) {
    buckets.push({
      group: 'Free models · daily requests',
      id: 'openrouter-free-daily',
      name: 'Daily free requests remaining',
      window: 'daily',
      remainingFraction: Math.max(0, (free.remaining ?? 0) / free.limit),
      resetTime: nextUtcMidnight(),
      description:
        `Used ${free.used ?? 0} of ${free.limit} free-model requests today. ` +
        `When this hits zero the free models answer with rate-limit errors until midnight UTC.`,
    });
  }
  if (k.limit != null && k.limit > 0) {
    const remaining = k.limit_remaining ?? Math.max(0, k.limit - (k.usage_monthly ?? k.usage ?? 0));
    buckets.push({
      group: 'Key budget · monthly $',
      id: 'openrouter-budget',
      name: 'Monthly spend remaining',
      window: 'monthly',
      remainingFraction: Math.max(0, Math.min(1, remaining / k.limit)),
      resetTime: null,
      description:
        `Spent $${(k.usage_monthly ?? k.usage ?? 0).toFixed(4)} of $${k.limit} this month` +
        (k.limit_reset ? ` (resets ${k.limit_reset})` : '') +
        `. Paid models only — free models do not consume this.`,
    });
  }
  return buckets;
}

// ---------------------------------------------------------------- observed rate limits

/** session id -> model id, from the local sessions table */
function sessionModels() {
  const map = new Map();
  try {
    const db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
    try {
      for (const r of db.prepare('select id, model from session_v2').all()) {
        try {
          const m = JSON.parse(r.model);
          if (m && m.id) map.set(r.id, m.id);
        } catch {}
      }
    } finally {
      db.close();
    }
  } catch {}
  return map;
}

/**
 * Scan the opencode log for RateLimit / QuotaExceeded errors and attribute
 * them to models via the session id on each line.
 * Returns Map modelId -> { hits, lastHit }.
 */
function readRateLimits() {
  const out = new Map();
  let text = '';
  try {
    const st = fs.statSync(OPENCODE_LOG);
    const fd = fs.openSync(OPENCODE_LOG, 'r');
    try {
      // last 2 MB is plenty: errors are recent by definition of relevance
      const size = Math.min(st.size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, st.size - size);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return out;
  }

  const sessions = sessionModels();
  const re = /timestamp=([0-9T:.\-]+Z).*?AI\.Error\.(RateLimit|QuotaExceeded)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = text.slice(m.index, m.index + 2000);
    const sid = /sessionID=([A-Za-z0-9_]+)/.exec(line)?.[1];
    const model = (sid && sessions.get(sid)) || null;
    if (!model) continue; // session pruned: cannot attribute
    const ts = Date.parse(m[1]) || Date.now();
    const cur = out.get(model) || { hits: 0, lastHit: 0 };
    cur.hits++;
    if (ts > cur.lastHit) cur.lastHit = ts;
    out.set(model, cur);
  }
  return out;
}

// ---------------------------------------------------------------- plugin

module.exports = {
  id: 'opencode',
  intervalMs: Number(process.env.OC_INTERVAL) || 60_000,

  async poll() {
    const [modelsRes, keyRes] = await Promise.all([fetchModels(), fetchKeyQuota()]);

    let catalogue;
    if (!modelsRes.ok) {
      catalogue = { state: 'error', models: [], error: modelsRes.error, checkedAt: Date.now() };
    } else {
      const all = (modelsRes.data?.data || []).map(normalise);
      const limited = readRateLimits();
      const models = all.filter(isFree).map((m) => {
        const hit = limited.get(m.id) || limited.get(m.modelID);
        return hit ? { ...m, limited: hit } : m;
      });
      catalogue = { state: 'live', models, allCount: all.length, error: null, checkedAt: Date.now() };
    }

    let quota = null;
    if (keyRes && keyRes.ok) {
      const buckets = keyQuotaToBuckets(keyRes.data);
      if (buckets.length) {
        quota = { state: 'live', error: null, buckets, credits: null, checkedAt: Date.now() };
      }
    } else if (keyRes && keyRes.error) {
      quota = { state: 'error', error: 'key quota: ' + keyRes.error, buckets: [], checkedAt: Date.now() };
    }

    const out = { catalogue };
    if (quota) out.quota = quota;
    return out;
  },
};
