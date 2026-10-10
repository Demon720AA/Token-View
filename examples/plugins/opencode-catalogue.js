'use strict';
/**
 * Example plugin: opencode (Zen) catalogue — free models of the opencode
 * provider, with per-model rate-limit flags scraped from the opencode log:
 *
 *   opencode api GET /api/model   -> catalogue
 *   AI.Error.RateLimit / QuotaExceeded in the log, joined to models
 *   through session_v2            -> `limited: { hits, lastHit }`
 *
 * Note: the free tier has no quota API, so observed rate limits are the only
 * quota signal here. Returns { catalogue }. Copy to ../../plugins/ to use.
 * Pair with the opencode-db.js copy (SOURCE_ID/PROVIDER 'opencode').
 */

const { execFile } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // Node 18+, no npm needed

const SOURCE_ID = 'opencode';
const PROVIDER = 'opencode'; // catalogue + log attribution limited to this provider
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

// ---------------------------------------------------------------- observed rate limits

/** session id -> { id, provider }, from the local sessions table */
function sessionModels() {
  const map = new Map();
  try {
    const db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
    try {
      for (const r of db.prepare('select id, model from session_v2').all()) {
        try {
          const m = JSON.parse(r.model);
          if (m && m.id) map.set(r.id, { id: m.id, provider: m.providerID || null });
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
 * them to models of THIS provider via the session id on each line.
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
    const sm = (sid && sessions.get(sid)) || null;
    if (!sm || (PROVIDER && sm.provider !== PROVIDER)) continue;
    const ts = Date.parse(m[1]) || Date.now();
    const cur = out.get(sm.id) || { hits: 0, lastHit: 0 };
    cur.hits++;
    if (ts > cur.lastHit) cur.lastHit = ts;
    out.set(sm.id, cur);
  }
  return out;
}

// ---------------------------------------------------------------- plugin

module.exports = {
  id: SOURCE_ID,
  intervalMs: Number(process.env.OC_INTERVAL) || 60_000,

  async poll() {
    const res = await fetchModels();
    if (!res.ok) {
      return { catalogue: { state: 'error', models: [], error: res.error, checkedAt: Date.now() } };
    }
    const limited = readRateLimits();
    const scoped = (res.data?.data || []).map(normalise).filter((m) => m.provider === PROVIDER);
    const models = scoped.filter(isFree).map((m) => {
      const hit = limited.get(m.id) || limited.get(m.modelID);
      return hit ? { ...m, limited: hit } : m;
    });
    return {
      catalogue: { state: 'live', models, allCount: scoped.length, error: null, checkedAt: Date.now() },
    };
  },
};
