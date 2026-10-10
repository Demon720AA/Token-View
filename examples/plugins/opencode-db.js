'use strict';
/**
 * Example plugin: read real usage from the opencode SQLite database.
 *
 * Copy this file to ../../plugins/ to activate it (the plugins/ directory is
 * git-ignored, so your local setup never gets committed).
 *
 * A plugin is any CommonJS module that exports:
 *   { id, intervalMs, enabled?, poll }
 *
 * poll() may be async and must resolve to one of:
 *   null                       -> source temporarily unavailable
 *   {
 *     total:   { input, output, reasoning?, cacheRead?, cacheWrite?, cost? },
 *              absolute counters; used for quota meters + provenance. Optional.
 *     events:  [ { requestId?, model?, provider?, app?, endpoint?,
 *                  inputTokens?, outputTokens?, cacheReadTokens?,
 *                  reasoningTokens?, costUsd?, ts? } ],
 *              fresh events since the last poll; shown in the live feed
 *              and the throughput chart. Optional.
 *     quota:   { state, buckets?, credits?, checkedAt? },
 *              external account quota, rendered as the big block on the
 *              source page. Optional.
 *     catalogue: { state, models: [...] },
 *              model list for the /models page. Optional.
 *     meta:    { ... },   // extra provenance fields, shown in footnotes
 *     file:    '...'      // where the data came from (home dir is
 *                         // collapsed to ~ by the server). Optional.
 *   }
 */

const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // Node 18+, no npm needed

// Which source this instance feeds, and which provider it tracks.
// Copy this file per provider: plugins/opencode-db.js
// (SOURCE_ID 'opencode', PROVIDER 'opencode') and plugins/openrouter-db.js
// (SOURCE_ID 'openrouter', PROVIDER 'openrouter').
const SOURCE_ID = 'opencode';
const PROVIDER = 'opencode'; // model.providerID to track, or null for all providers

const DB = path.join(os.homedir(), '.local/share/opencode/opencode.db');
const DISPLAY = DB.replace(os.homedir(), '~');

function openReadonly(file) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

function safeJson(v) {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function readDb() {
  const db = openReadonly(DB);
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        `select id, model, cost,
                tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write
         from session_v2`
      )
      .all();

    const total = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    let sessions = 0;
    for (const r of rows) {
      if (PROVIDER) {
        let pid = null;
        try {
          pid = JSON.parse(r.model)?.providerID ?? null;
        } catch {}
        if (pid !== PROVIDER) continue;
      }
      sessions++;
      total.input += r.tokens_input ?? 0;
      total.output += r.tokens_output ?? 0;
      total.reasoning += r.tokens_reasoning ?? 0;
      total.cacheRead += r.tokens_cache_read ?? 0;
      total.cacheWrite += r.tokens_cache_write ?? 0;
      total.cost += r.cost ?? 0;
    }

    let messages = [];
    try {
      messages = db
        .prepare(
          `select id, session_id, time_created, data
           from session_message
           where json_extract(data, '$.tokens.input') is not null
           order by time_created desc
           limit 400`
        )
        .all()
        .map((r) => {
          let d = {};
          try {
            d = JSON.parse(r.data);
          } catch {}
          const t = d.tokens || {};
          const m = d.model || {};
          return {
            id: r.id,
            sessionId: r.session_id,
            ts: r.time_created,
            model: m.id || 'unknown',
            provider: m.providerID || 'opencode',
            input: t.input || 0,
            output: t.output || 0,
            reasoning: t.reasoning || 0,
            cacheRead: (t.cache || {}).read || 0,
            cacheWrite: (t.cache || {}).write || 0,
            cost: d.cost || 0,
          };
        })
        .filter((m) => !PROVIDER || m.provider === PROVIDER);
    } catch {}

    return { total, sessions, messages };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** messages the server has not seen yet (list is newest-first) */
function freshSince(prev, messages) {
  if (!prev) {
    // first poll: emit only the last minute so the chart starts populated
    const cutoff = Date.now() - 60_000;
    return messages.filter((m) => (m.ts ?? 0) >= cutoff);
  }
  const pm = prev.messages;
  const fresh = messages.filter((m, i) => i < pm.length && m.id !== pm[i].id);
  if (!fresh.length && messages.length && messages[0]?.id !== pm[0]?.id) {
    return messages.slice(0, 20); // fell behind: take the newest few
  }
  return fresh;
}

let prev = null;

module.exports = {
  id: SOURCE_ID,
  intervalMs: 2000,

  async poll() {
    const now = readDb();
    if (!now) {
      prev = null;
      return null;
    }
    const fresh = freshSince(prev, now.messages);
    prev = { total: now.total, messages: now.messages };
    return {
      total: now.total,
      events: fresh.map((m) => ({
        requestId: m.sessionId,
        model: m.model,
        provider: m.provider,
        app: (m.sessionId || 'local').slice(0, 12),
        endpoint: 'local',
        inputTokens: m.input,
        outputTokens: m.output,
        cacheReadTokens: m.cacheRead,
        reasoningTokens: m.reasoning,
        costUsd: m.cost,
        ts: m.ts,
      })),
      meta: { sessions: now.sessions },
      file: DISPLAY,
    };
  },
};
