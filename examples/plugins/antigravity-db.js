'use strict';
/**
 * LOCAL-ONLY plugin (never committed): antigravity usage scraped from
 * conversation database blobs. Best-effort — most conversations persist
 * no token counts at all.
 *
 * Polls the SQLite conversation DBs every 10s and returns any new
 * token records as events. The model is 'unknown' (blobs don't carry
 * a reliable model name). Use antigravity-catalogue.js for the model menu.
 *
 * Returns { total, events, meta, file }. Copy to ../../plugins/ to use.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DIR = path.join(os.homedir(), '.gemini/antigravity-cli/conversations');
const DISPLAY = DIR.replace(os.homedir(), '~');

function openReadonly(file) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

/** pull every {"input_tokens":N,...} object out of a blob */
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
    out.push({
      input: Number(m[1]),
      output: num('output_tokens'),
      cacheRead: num('cache_read_tokens'),
      cacheWrite: num('cache_creation_tokens'),
      reasoning: num('reasoning_tokens'),
      ts: tsMatch ? Date.parse(tsMatch[1]) || 0 : 0,
    });
    if (out.length >= 200) break;
  }
  return out;
}

function scan() {
  if (!fs.existsSync(DIR)) return null;
  let files = [];
  try {
    files = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const full = path.join(DIR, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {}
        return { name: f, full, mtime };
      });
  } catch {
    return null;
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const found = [];
  const seen = new Set();
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  for (const f of files.slice(0, 12)) {
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
          for (const rec of extractTokenRecords(Buffer.from(blob).toString('utf8'))) {
            const key = f.name + ':' + r.idx + ':' + rec.ts;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({ conversation: f.name, step: r.idx, ...rec });
            total.input += rec.input;
            total.output += rec.output;
            total.cacheRead += rec.cacheRead;
          }
        }
      }
    } catch {
      // conversation format varies; skip what we cannot read
    } finally {
      db.close();
    }
  }

  if (!found.length) return { total: null, records: [], files: files.length };
  return { total, records: found, files: files.length };
}

let prevCount = -1;

module.exports = {
  id: 'antigravity',
  intervalMs: 10_000,

  async poll() {
    const now = scan();
    if (!now) return null;
    const fresh = prevCount < 0 ? [] : now.records.slice(prevCount);
    prevCount = now.records.length;
    return {
      total: now.total,
      events: fresh.map((m) => ({
        requestId: m.conversation,
        model: 'unknown',
        provider: 'antigravity',
        app: 'step ' + m.step,
        endpoint: 'local',
        inputTokens: m.input,
        outputTokens: m.output,
        cacheReadTokens: m.cacheRead,
        reasoningTokens: m.reasoning,
        costUsd: 0,
        ts: m.ts || Date.now(),
      })),
      meta: { records: now.records.length, conversations: now.files },
      file: DISPLAY,
    };
  },
};