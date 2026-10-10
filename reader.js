'use strict';
/**
 * Real local usage readers.
 *
 * opencode    -> ~/.local/share/opencode/opencode.db  (SQLite, full fidelity)
 * antigravity -> ~/.gemini/antigravity-cli/conversations/*.db (best-effort)
 *
 * Both expose only cumulative counters, so this module reports an absolute
 * total plus the delta since the previous poll. The server uses the delta for
 * the live feed and the absolute total for the quota meters.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const HOME = os.homedir();
const OPENCODE_DB = path.join(HOME, '.local/share/opencode/opencode.db');
const ANTIGRAVITY_DIR = path.join(HOME, '.gemini/antigravity-cli/conversations');

/** open a sqlite file read-only, tolerating a missing/locked file */
function openReadonly(file) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- opencode

function readOpencode() {
  const db = openReadonly(OPENCODE_DB);
  if (!db) return null;
  try {
    // Authoritative cumulative totals per session.
    const rows = db
      .prepare(
        `select id, model, cost,
                tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write
         from session_v2`
      )
      .all();

    const sessions = new Map();
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;

    for (const r of rows) {
      sessions.set(r.id, {
        id: r.id,
        model: safeJson(r.model),
        cost: r.cost ?? 0,
        input: r.tokens_input ?? 0,
        output: r.tokens_output ?? 0,
        reasoning: r.tokens_reasoning ?? 0,
        cacheRead: r.tokens_cache_read ?? 0,
        cacheWrite: r.tokens_cache_write ?? 0,
      });
      input += r.tokens_input ?? 0;
      output += r.tokens_output ?? 0;
      reasoning += r.tokens_reasoning ?? 0;
      cacheRead += r.tokens_cache_read ?? 0;
      cacheWrite += r.tokens_cache_write ?? 0;
      cost += r.cost ?? 0;
    }

    // Per-message usage gives the live feed its granularity.
    let recent = [];
    try {
      recent = db
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
          const cache = t.cache || {};
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
            cacheRead: cache.read || 0,
            cacheWrite: cache.write || 0,
            cost: d.cost || 0,
          };
        });
    } catch {}

    return {
      available: true,
      file: OPENCODE_DB,
      total: { input, output, reasoning, cacheRead, cacheWrite, cost },
      sessions,
      messages: recent,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function safeJson(v) {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- antigravity
//
// Antigravity stores usage only inside serialized blobs. We scan the steps of
// recently modified conversations for JSON objects carrying token fields.
// This is best-effort: most conversations never persist token counts.

function readAntigravity() {
  if (!fs.existsSync(ANTIGRAVITY_DIR)) return { available: false, total: null, found: [] };

  let files = [];
  try {
    files = fs
      .readdirSync(ANTIGRAVITY_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const full = path.join(ANTIGRAVITY_DIR, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {}
        return { name: f, full, mtime };
      });
  } catch {
    return { available: false, total: null, found: [] };
  }

  // Newest first: the live conversation is almost always at the top.
  files.sort((a, b) => b.mtime - a.mtime);
  const scan = files.slice(0, 12);

  const found = [];
  const seen = new Set();
  let input = 0;
  let output = 0;
  let cacheRead = 0;

  for (const f of scan) {
    const db = openReadonly(f.full);
    if (!db) continue;
    try {
      const rows = db
        .prepare(
          `select idx, metadata, step_payload, task_details, render_info
           from steps
           where cast(step_payload as text) like '%input_tokens%'
              or cast(metadata as text) like '%input_tokens%'
              or cast(task_details as text) like '%input_tokens%'`
        )
        .all();

      for (const r of rows) {
        for (const blob of [r.metadata, r.step_payload, r.task_details, r.render_info]) {
          if (!blob) continue;
          const text = Buffer.from(blob).toString('utf8');
          for (const rec of extractTokenRecords(text)) {
            const key = f.name + ':' + r.idx + ':' + rec.ts;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({ conversation: f.name, step: r.idx, ...rec });
            input += rec.input;
            output += rec.output;
            cacheRead += rec.cacheRead;
          }
        }
      }
    } catch {
      // conversation format varies between versions; skip what we cannot read
    } finally {
      db.close();
    }
  }

  return {
    available: true,
    file: ANTIGRAVITY_DIR,
    total: found.length ? { input, output, cacheRead, cacheWrite: 0, cost: 0 } : null,
    records: found,
    conversationsScanned: scan.length,
    conversationsTotal: files.length,
  };
}

/** pull every {"input_tokens":N,"output_tokens":N,...} object out of a blob */
function extractTokenRecords(text) {
  const out = [];
  const re = /"input_tokens"\s*:\s*(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 300);
    const window = text.slice(start, m.index + 400);
    const num = (key) => {
      const r = new RegExp('"' + key + '"\\s*:\\s*(\\d+)').exec(window);
      return r ? Number(r[1]) : 0;
    };
    const tsMatch = /"created_at"\s*:\s*"([^"]+)"/.exec(window);
    const ts = tsMatch ? Date.parse(tsMatch[1]) || 0 : 0;
    out.push({
      input: Number(m[1]),
      output: num('output_tokens'),
      cacheRead: num('cache_read_tokens'),
      cacheWrite: num('cache_creation_tokens'),
      reasoning: num('reasoning_tokens'),
      ts,
    });
    if (out.length >= 200) break;
  }
  return out;
}

// ---------------------------------------------------------------- polling

/**
 * Poll both readers on an interval and report absolute totals + deltas.
 * @param {(update: object) => void} onUpdate
 */
function startReader({ intervalMs = 2000, onUpdate, onError } = {}) {
  let prev = { opencode: null, antigravity: null };
  let stopped = false;

  const poll = () => {
    if (stopped) return;
    const update = {};
    try {
      const oc = readOpencode();
      const ag = readAntigravity();

      update.opencode = oc ? delta('opencode', prev.opencode, oc) : { available: false };
      update.antigravity = ag ? delta('antigravity', prev.antigravity, ag) : { available: false };

      prev = {
        opencode: oc ? { total: oc.total, lastId: oc.messages?.[0]?.id ?? null } : null,
        antigravity: ag ? { size: (ag.records || []).length } : null,
      };

      onUpdate?.(update);
    } catch (err) {
      onError?.(err);
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

/** build { total, delta } for one source, relative to the previous poll */
function delta(source, prevState, now) {
  const total = now.total;
  const messages = now.messages || now.records || [];
  const prevMessages = prevState?.messages;
  let fresh = messages;

  if (prevMessages) {
    fresh = messages.filter((m, i) => i < prevMessages.length && m.id !== prevMessages[i].id);
    // if we fell behind and the window moved, just take the newest few
    if (!fresh.length && messages.length && messages[0].id !== prevMessages[0].id) {
      fresh = messages.slice(0, 20);
    }
  } else {
    // First poll: emit only the last minute of activity so the chart starts
    // populated instead of blank, without replaying the whole history.
    const cutoff = Date.now() - 60_000;
    fresh = messages.filter((m) => (m.ts ?? 0) >= cutoff);
  }

  const d = prevState?.total
    ? {
        input: (total?.input ?? 0) - (prevState.total.input ?? 0),
        output: (total?.output ?? 0) - (prevState.total.output ?? 0),
        reasoning: (total?.reasoning ?? 0) - (prevState.total.reasoning ?? 0),
        cacheRead: (total?.cacheRead ?? 0) - (prevState.total.cacheRead ?? 0),
        cacheWrite: (total?.cacheWrite ?? 0) - (prevState.total.cacheWrite ?? 0),
        cost: (total?.cost ?? 0) - (prevState.total.cost ?? 0),
      }
    : { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  return {
    available: true,
    file: now.file,
    source,
    total,
    delta: d,
    fresh,
    meta:
      source === 'opencode'
        ? { sessions: now.sessions?.size ?? 0 }
        : {
            conversationsScanned: now.conversationsScanned,
            conversationsTotal: now.conversationsTotal,
            records: (now.records || []).length,
          },
  };
}

module.exports = { startReader, readOpencode, readAntigravity, OPENCODE_DB, ANTIGRAVITY_DIR };
