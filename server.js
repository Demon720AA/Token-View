'use strict';
/**
 * Real-time LLM token usage monitor.
 *
 * - Simulates streaming LLM traffic (or accepts real traffic via POST /api/ingest)
 * - Broadcasts every event to browsers over Server-Sent Events (SSE)
 * - Keeps a rolling in-memory window for history / summary
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { startReader } = require('./reader.js');
const { startAgyReader } = require('./agy.js');
const { startModelReader } = require('./opencode-models.js');

/** collapse $HOME to ~ so usernames never leak into API responses */
function toDisplayPath(p) {
  const home = process.env.HOME || '';
  const s = String(p ?? '');
  return home && s.startsWith(home) ? '~' + s.slice(home.length) : s;
}

const PORT = Number(process.env.PORT) || 4173;
const SIMULATE = process.env.SIMULATE === 'true';
const LIVE = process.env.LIVE !== 'false';
const WINDOW_MS = 5 * 60 * 1000; // rolling history window
const MAX_EVENTS = 20000;

// ---------------------------------------------------------------- models

const MODELS = [
  { id: 'gpt-4o', provider: 'OpenAI', inRate: 0.0000025, outRate: 0.00001, weight: 26, maxOut: 900, color: '#22d3ee' },
  { id: 'gpt-4o-mini', provider: 'OpenAI', inRate: 0.00000015, outRate: 0.0000006, weight: 30, maxOut: 1400, color: '#34d399' },
  { id: 'claude-sonnet-4', provider: 'Anthropic', inRate: 0.000003, outRate: 0.000015, weight: 18, maxOut: 1200, color: '#f59e0b' },
  { id: 'claude-haiku-4', provider: 'Anthropic', inRate: 0.00000025, outRate: 0.00000125, weight: 12, maxOut: 700, color: '#fb7185' },
  { id: 'llama-3.3-70b', provider: 'Meta (local)', inRate: 0, outRate: 0, weight: 14, maxOut: 1100, color: '#a78bfa' },
];

// ---------------------------------------------------------------- sources
// Top-level clients whose tokens are tracked separately.

const SOURCES = [
  {
    id: 'antigravity',
    label: 'Antigravity',
    color: '#f59e0b',
    weight: 45,
    maxOut: 1200,
    // token allowance for the current period (billed tokens, cache excluded)
    quota: { tokens: 200_000_000, costUsd: null, period: 'month' },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    color: '#22d3ee',
    weight: 55,
    maxOut: 1500,
    quota: { tokens: 200_000_000, costUsd: null, period: 'month' },
  },
];

const SOURCE_APPS = {
  antigravity: ['agent-loop', 'tool-runner', 'chat-pane', 'indexer'],
  opencode: ['web-app', 'api-gateway', 'batch-worker', 'ide-plugin'],
};

const ENDPOINTS = [
  '/v1/chat/completions',
  '/v1/messages',
  '/v1/embeddings',
  '/v1/completions',
];

const DEFAULT_SOURCE = 'antigravity';

// Allow overriding quotas from the environment, e.g.
//   QUOTA_antigravity=1000000 PERIOD=day node server.js
const PERIOD = process.env.PERIOD || null;
for (const s of SOURCES) {
  const envTokens = Number(process.env['QUOTA_' + s.id.toUpperCase()]);
  if (envTokens > 0) s.quota.tokens = envTokens;
  if (process.env['QUOTACOST_' + s.id.toUpperCase()]) {
    s.quota.costUsd = Number(process.env['QUOTACOST_' + s.id.toUpperCase()]);
  }
  if (PERIOD) s.quota.period = PERIOD;
}

/** start timestamp of the current quota period, by period name */
function periodStart(period, now = Date.now()) {
  const d = new Date(now);
  switch (period) {
    case 'hour':
      d.setUTCMinutes(0, 0, 0);
      return d.getTime();
    case 'day':
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    case 'week': {
      const start = new Date(d);
      start.setUTCDate(d.getUTCDate() - d.getUTCDay());
      start.setUTCHours(0, 0, 0, 0);
      return start.getTime();
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case 'session':
    default:
      return 0;
  }
}

/**
 * Quota usage per source for the current period.
 * Periods roll over lazily: if the stored period start is stale, usage resets.
 */
const quotaState = new Map(
  SOURCES.map((s) => [
    s.id,
    { period: s.quota?.period ?? 'session', start: periodStart(s.quota?.period ?? 'session'), tokens: 0, costUsd: 0 },
  ])
);

/**
 * When reading real usage off disk, the counter is absolute (all-time), not
 * per-period. Set this to meter the quota bar against those real totals.
 */
const liveQuota = new Map();

/** real quota reported by the antigravity CLI (`agy -p /usage`) */
let agyQuota = null;

/** opencode free-model catalogue, refreshed from `opencode api GET /api/model` */
let modelCatalog = { state: 'pending', models: [], checkedAt: 0, error: null };

function setLiveQuota(source, tokens, costUsd) {
  if (tokens == null && costUsd == null) {
    liveQuota.delete(source);
    return;
  }
  liveQuota.set(source, { tokens: tokens ?? 0, costUsd: costUsd ?? 0 });
}

function chargeQuota(source, tokens, costUsd) {
  const q = quotaState.get(source);
  if (!q) return;
  const start = periodStart(q.period);
  if (start !== q.start) {
    q.start = start;
    q.tokens = 0;
    q.costUsd = 0;
  }
  q.tokens += tokens;
  q.costUsd += costUsd;
}

// ---------------------------------------------------------------- state

/** @type {Array<object>} */
const events = [];
const totals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  requests: 0,
  errors: 0,
};

/** where the numbers on screen actually came from */
const provenance = { mode: LIVE ? 'live' : 'simulated', sources: {} };
const byModel = new Map(
  MODELS.map((m) => [
    m.id,
    { id: m.id, provider: m.provider, color: m.color, inRate: m.inRate, outRate: m.outRate,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0,
      requests: 0, costUsd: 0, errors: 0, firstSeen: 0, lastSeen: 0 },
  ])
);

/** models seen on disk that are not in the MODELS list (e.g. opencode providers) */
function modelBucket(id, provider) {
  let m = byModel.get(id);
  if (!m) {
    m = { id, provider: provider || 'unknown', color: palette(byModel.size), inRate: 0, outRate: 0,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0,
      requests: 0, costUsd: 0, errors: 0, firstSeen: 0, lastSeen: 0 };
    byModel.set(id, m);
  }
  if (provider && m.provider === 'unknown') m.provider = provider;
  return m;
}

const PALETTE = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#fb7185', '#60a5fa', '#facc15', '#c084fc'];
const palette = (i) => PALETTE[i % PALETTE.length];
const bySource = new Map(
  SOURCES.map((s) => [
    s.id,
    { id: s.id, label: s.label, color: s.color, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
      cacheReadTokens: 0, requests: 0, costUsd: 0, errors: 0, models: new Map() },
  ])
);
/** clients listening on SSE */
const clients = new Set();
let seq = 0;

function record(ev) {
  const e = { id: ++seq, ts: ev.ts ?? Date.now(), ...ev, ts: ev.ts ?? Date.now() };
  events.push(e);
  totals.requests += 1;
  totals.inputTokens += e.inputTokens;
  totals.outputTokens += e.outputTokens;
  totals.totalTokens += e.inputTokens + e.outputTokens;
  totals.costUsd += e.costUsd;
  if (e.error) totals.errors += 1;

  const m = modelBucket(e.model, e.provider);
  m.requests += 1;
  m.inputTokens += e.inputTokens;
  m.outputTokens += e.outputTokens;
  m.reasoningTokens += e.reasoningTokens || 0;
  m.cacheReadTokens += e.cacheReadTokens || 0;
  m.costUsd += e.costUsd;
  if (e.error) m.errors += 1;
  if (!m.firstSeen || e.ts < m.firstSeen) m.firstSeen = e.ts;
  if (e.ts > m.lastSeen) m.lastSeen = e.ts;

  const s = bySource.get(e.source);
  if (s) {
    s.requests += 1;
    s.inputTokens += e.inputTokens;
    s.outputTokens += e.outputTokens;
    s.reasoningTokens += e.reasoningTokens || 0;
    s.cacheReadTokens += e.cacheReadTokens || 0;
    s.costUsd += e.costUsd;
    if (e.error) s.errors += 1;
    const sm = s.models.get(e.model) || { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 };
    sm.requests += 1;
    sm.inputTokens += e.inputTokens;
    sm.outputTokens += e.outputTokens;
    sm.costUsd += e.costUsd;
    s.models.set(e.model, sm);

    // Live events are metered against an absolute counter read from disk, so
    // they must not also charge the session-based quota accumulator.
    if (e.chargeQuota !== false) chargeQuota(e.source, e.inputTokens + e.outputTokens, e.costUsd);
  }

  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  broadcast('event', e);
}

function cost(model, inputTokens, outputTokens) {
  return inputTokens * model.inRate + outputTokens * model.outRate;
}

// ---------------------------------------------------------------- simulator

let requestSeq = 0;
/** active streams: each emits output token chunks over time */
const streams = [];

function weightedModel() {
  const total = MODELS.reduce((s, m) => s + m.weight, 0);
  let r = Math.random() * total;
  for (const m of MODELS) {
    r -= m.weight;
    if (r <= 0) return m;
  }
  return MODELS[0];
}

function weightedSource() {
  const total = SOURCES.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const s of SOURCES) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return SOURCES[0];
}

function startStream() {
  const model = weightedModel();
  const source = weightedSource();
  const promptTokens = Math.floor(80 + Math.random() * 3800);
  const targetOut = Math.floor(60 + Math.random() * source.maxOut);
  const apps = SOURCE_APPS[source.id] || SOURCE_APPS.opencode;
  const app = apps[Math.floor(Math.random() * apps.length)];
  const endpoint = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
  const stream = {
    id: ++requestSeq,
    model,
    source: source.id,
    app,
    endpoint,
    promptTokens,
    emitted: 0,
    targetOut,
    startedAt: Date.now(),
    ttft: Math.floor(120 + Math.random() * 900), // time to first token, ms
    error: Math.random() < 0.02,
  };
  streams.push(stream);
  return stream;
}

function tickStream(stream, now) {
  if (now - stream.startedAt < stream.ttft) return;

  // burst of tokens for this tick
  const remaining = stream.targetOut - stream.emitted;
  if (remaining <= 0) {
    streams.splice(streams.indexOf(stream), 1);
    return;
  }
  const chunk = Math.min(remaining, 1 + Math.floor(Math.random() * 14));
  stream.emitted += chunk;

  // Prompt tokens are billed once per request, not once per chunk.
  const first = stream.promptCounted !== true;
  stream.promptCounted = true;
  const inputTokens = first ? stream.promptTokens : 0;

  record({
    type: 'chunk',
    requestId: stream.id,
    model: stream.model.id,
    provider: stream.model.provider,
    source: stream.source,
    app: stream.app,
    endpoint: stream.endpoint,
    inputTokens,
    outputTokens: chunk,
    costUsd: cost(stream.model, inputTokens, chunk),
    latencyMs: stream.ttft + Math.floor(Math.random() * 200),
    error: stream.error,
  });
}

// Keep roughly `targetActive` requests in flight.
let targetActive = 14;
setInterval(() => {
  const now = Date.now();

  if (SIMULATE) {
    while (streams.length < targetActive) startStream();
    // randomize load a little
    if (Math.random() < 0.05) targetActive = 8 + Math.floor(Math.random() * 22);
    for (const s of streams.slice()) tickStream(s, now);
  }

  prune(now);
  broadcast('tick', snapshot(now));
}, 250);

function prune(now) {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < events.length && events[i].ts < cutoff) i++;
  if (i > 0) events.splice(0, i);
}

/** quota usage, remaining allowance and burn-rate projection for one source */
function quotaInfo(sourceId, recentTokens, now) {
  const cfg = SOURCES.find((s) => s.id === sourceId);
  const q = quotaState.get(sourceId);
  const quota = cfg?.quota;
  if (!q || !quota) return null;

  const start = periodStart(q.period, now);
  if (start !== q.start && !liveQuota.has(sourceId)) {
    q.start = start;
    q.tokens = 0;
    q.costUsd = 0;
  }

  // Real usage is counted all-time by the tools on disk, so prefer it when present.
  const live = liveQuota.get(sourceId);
  const usedTokens = live ? live.tokens : q.tokens;
  const usedCostUsd = live ? live.costUsd : q.costUsd;

  const totalTokens = quota.tokens ?? Infinity;
  const totalCost = quota.costUsd ?? Infinity;
  const remainingTokens = Math.max(0, totalTokens - usedTokens);
  const remainingCost = Math.max(0, totalCost - usedCostUsd);

  // whichever limit binds first determines the "used" percentage
  const usedPct = Math.max(
    totalTokens === Infinity ? 0 : usedTokens / totalTokens,
    totalCost === Infinity ? 0 : usedCostUsd / totalCost
  );

  // burn rate over the last 60s -> when will we run out?
  const perSec = recentTokens / 60;
  const secondsLeft = perSec > 0 ? remainingTokens / perSec : Infinity;

  const periodMs = { hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[q.period] ?? 0;
  const resetAt = periodMs ? q.start + periodMs : null;

  return {
    period: q.period,
    live: Boolean(live),
    totalTokens: quota.tokens ?? null,
    totalCostUsd: quota.costUsd ?? null,
    usedTokens,
    usedCostUsd,
    remainingTokens,
    remainingCostUsd: quota.costUsd != null ? remainingCost : null,
    usedPct,
    tokensPerSec: perSec,
    exhaustedInSec: secondsLeft,
    resetAt,
  };
}

/** aggregate events into per-second buckets for the live chart */
function snapshot(now) {
  prune(now);
  const buckets = new Map();
  const since = now - 60_000;
  const emptyBucket = (sec) => ({ sec, input: 0, output: 0, sources: {} });
  for (const e of events) {
    if (e.ts < since) continue;
    const sec = Math.floor(e.ts / 1000);
    let b = buckets.get(sec);
    if (!b) buckets.set(sec, (b = emptyBucket(sec)));
    b.input += e.inputTokens;
    b.output += e.outputTokens;
    const sb = (b.sources[e.source] = b.sources[e.source] || { input: 0, output: 0 });
    sb.input += e.inputTokens;
    sb.output += e.outputTokens;
  }
  const series = [...buckets.values()].sort((a, b) => a.sec - b.sec).slice(-60);
  const recent = events.filter((e) => e.ts >= since);
  const outputLast5 = recent.reduce((s, e) => s + e.outputTokens, 0);
  const active = new Set(recent.map((e) => e.requestId)).size;

  // per-source live rates + session totals
  const sources = [...bySource.values()].map((s) => {
    const recentOfSource = recent.filter((e) => e.source === s.id);
    const output5 = recentOfSource.reduce((a, e) => a + e.outputTokens, 0);
    const recentTokens = recentOfSource.reduce((a, e) => a + e.inputTokens + e.outputTokens, 0);
    return {
      id: s.id,
      label: s.label,
      color: s.color,
      tokensPerSec: output5 / 5,
      activeRequests: new Set(recentOfSource.map((e) => e.requestId)).size,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      reasoningTokens: s.reasoningTokens,
      cacheReadTokens: s.cacheReadTokens,
      totalTokens: s.inputTokens + s.outputTokens,
      requests: s.requests,
      costUsd: s.costUsd,
      errors: s.errors,
      quota: quotaInfo(s.id, recentTokens, now),
      provenance: provenance.sources[s.id] ?? null,
      providerQuota: s.id === 'antigravity' ? agyQuota : null,
      models: [...s.models.entries()].map(([id, m]) => ({ id, ...m })),
    };
  });

  return {
    ts: now,
    series,
    tokensPerSec: outputLast5 / 5,
    activeRequests: active,
    provenance,
    sources,
    models: [...byModel.values()].map((m) => {
      const ev = events.filter((e) => e.model === m.id);
      const recentModel = ev.filter((e) => e.ts >= since);
      const perSource = {};
      for (const s of SOURCES) {
        const se = ev.filter((e) => e.source === s.id);
        perSource[s.id] = {
          label: s.label,
          color: s.color,
          requests: se.length,
          inputTokens: se.reduce((a, e) => a + e.inputTokens, 0),
          outputTokens: se.reduce((a, e) => a + e.outputTokens, 0),
          cacheReadTokens: se.reduce((a, e) => a + e.cacheReadTokens || 0, 0),
          costUsd: se.reduce((a, e) => a + e.costUsd, 0),
        };
      }
      const out5 = recentModel.reduce((a, e) => a + e.outputTokens, 0);
      return {
        id: m.id,
        provider: m.provider,
        color: m.color,
        priced: Boolean(m.inRate || m.outRate),
        requests: m.requests,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        reasoningTokens: m.reasoningTokens,
        cacheReadTokens: m.cacheReadTokens,
        totalTokens: m.inputTokens + m.outputTokens,
        costUsd: m.costUsd,
        errors: m.errors,
        firstSeen: m.firstSeen,
        lastSeen: m.lastSeen,
        tokensPerSec: out5 / 5,
        eventsLast60s: recentModel.length,
        perSource,
      };
    }),
    totals,
  };
}

/** free-model catalogue joined with observed traffic for each model */
function modelTraffic() {
  const traffic = new Map(
    [...byModel.values()].map((m) => [
      m.id,
      {
        requests: m.requests,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cacheReadTokens: m.cacheReadTokens,
        reasoningTokens: m.reasoningTokens,
        costUsd: m.costUsd,
        lastSeen: m.lastSeen,
      },
    ])
  );

  // traffic may reference a model id the catalogue spells differently
  const byModelId = new Map(
    [...byModel.values()].map((m) => [m.modelID || m.id, m])
  );

  const rows = modelCatalog.models.map((m) => {
    const t = traffic.get(m.id) || traffic.get(m.modelID) || null;
    const agg = byModelId.get(m.modelID) || byModelId.get(m.id) || null;
    return {
      ...m,
      traffic: t || {
        requests: agg?.requests ?? 0,
        inputTokens: agg?.inputTokens ?? 0,
        outputTokens: agg?.outputTokens ?? 0,
        cacheReadTokens: agg?.cacheReadTokens ?? 0,
        reasoningTokens: agg?.reasoningTokens ?? 0,
        costUsd: agg?.costUsd ?? 0,
        lastSeen: agg?.lastSeen ?? 0,
      },
      used: Boolean(t || (agg && agg.requests > 0)),
    };
  });

  rows.sort((a, b) => b.traffic.requests - a.traffic.requests || a.id.localeCompare(b.id));

  return {
    state: modelCatalog.state,
    error: modelCatalog.error,
    checkedAt: modelCatalog.checkedAt,
    totalCatalogue: modelCatalog.allCount ?? rows.length,
    reachable: rows.filter((r) => r.reachable).length,
    models: rows,
  };
}

// ---------------------------------------------------------------- SSE

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  else if (rel === '/detail' || rel === '/detail/') rel = '/detail.html';
  else if (/^\/(antigravity|opencode)\/?$/.test(rel)) rel = '/source.html';
  else if (/^\/models\/?$/.test(rel)) rel = '/models.html';
  const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: tick\ndata: ${JSON.stringify(snapshot(Date.now()))}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/api/summary') {
    res.writeHead(200, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify(snapshot(Date.now())));
    return;
  }

  // free opencode models, reachability, and the traffic each has carried
  if (url.pathname === '/api/models') {
    res.writeHead(200, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify(modelTraffic()));
    return;
  }

  if (url.pathname === '/api/events') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    res.writeHead(200, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify(events.slice(-limit).reverse()));
    return;
  }

  // ingest real usage from your own app:
  //   curl -X POST /api/ingest -d '{"model":"gpt-4o","inputTokens":100,"outputTokens":50}'
  if (url.pathname === '/api/ingest' && req.method === 'POST') {
    const body = await readBody(req);
    const model = MODELS.find((m) => m.id === body.model) || MODELS[0];
    const source = bySource.has(body.source) ? body.source : DEFAULT_SOURCE;
    const inputTokens = Number(body.inputTokens) || 0;
    const outputTokens = Number(body.outputTokens) || 0;
    record({
      type: 'ingest',
      requestId: Number(body.requestId) || Date.now(),
      model: model.id,
      provider: model.provider,
      source,
      app: body.app || 'external',
      endpoint: body.endpoint || '/external',
      inputTokens,
      outputTokens,
      costUsd: cost(model, inputTokens, outputTokens),
      latencyMs: Number(body.latencyMs) || null,
      error: Boolean(body.error),
    });
    res.writeHead(202, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  serveStatic(req, res);
});

// ---------------------------------------------------------------- live reader
// Pulls real usage written to disk by opencode / antigravity.

let liveStarted = false;

function startLiveReader() {
  if (liveStarted) return;
  liveStarted = true;

  startReader({
    intervalMs: 2000,
    onError: (err) => console.error('[reader]', err.message),
    onUpdate: (update) => {
      for (const [source, u] of Object.entries(update)) {
        if (!u.available) {
          provenance.sources[source] = { state: 'unavailable', file: null };
          setLiveQuota(source, null, null);
          continue;
        }

        // Quota meters the billed tokens. Cache reads are reported alongside but
        // do not consume allowance — they are prompt-cache hits, not new tokens.
        const t = u.total;
        if (t) setLiveQuota(source, (t.input || 0) + (t.output || 0), t.cost);

        provenance.sources[source] = {
          state: 'live',
          // never expose the absolute home path to clients
          file: toDisplayPath(u.file),
          total: u.total,
          ...(u.meta || {}),
        };

        // Emit the newly finished messages so the feed and chart move.
        for (const m of u.fresh || []) {
          const inputTokens = (m.input || 0) + (m.cacheRead || 0);
          record({
            type: 'live',
            chargeQuota: false,
            requestId: m.sessionId || m.conversation || 'live',
            model: m.model || 'unknown',
            provider: m.provider || source,
            source,
            app: m.sessionId ? m.sessionId.slice(0, 12) : m.step ?? 'local',
            endpoint: 'local',
            inputTokens: m.input || 0,
            cacheReadTokens: m.cacheRead || 0,
            reasoningTokens: m.reasoning || 0,
            outputTokens: m.output || 0,
            costUsd: m.cost || 0,
            latencyMs: null,
            error: false,
            ts: m.ts || Date.now(),
          });
        }
      }
      // Events carry their original timestamp; keep any older ones out of the feed.
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    },
  });

  console.log('reading local usage: opencode + antigravity');

  // opencode's own model endpoint: which models exist, which are free, which respond
  startModelReader({
    intervalMs: Number(process.env.OC_INTERVAL) || 60_000,
    freeOnly: true,
    onUpdate: (c) => {
      const prevState = modelCatalog.state;
      modelCatalog = c;
      if (c.state !== 'live') console.error('[models] ' + (c.error || c.state));
      else if (prevState !== 'live') console.log(`[models] ${c.models.length} free models, ${c.models.filter((m) => m.reachable).length} reachable`);
    },
  });

  // antigravity has no local API; its quota comes from the agy CLI (~5s per call)
  startAgyReader({
    intervalMs: Number(process.env.AGY_INTERVAL) || 5 * 60_000,
    onUpdate: (q) => {
      agyQuota = q;
      if (q.state !== 'live') console.error('[agy] ' + (q.error || 'unknown error'));
    },
    onError: (err) => console.error('[agy]', err.message),
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — another token-view is probably running.\n` +
      `  Stop it:        fuser -k ${PORT}/tcp\n` +
      `  Or use another: PORT=4174 node server.js\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`token-view running at http://localhost:${PORT}`);
  if (LIVE) startLiveReader();
  else console.log('live readers disabled (LIVE=false) — no data will appear unless something POSTs to /api/ingest');
});
