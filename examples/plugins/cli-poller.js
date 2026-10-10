'use strict';
/**
 * Generic plugin: run any CLI that prints JSON and expose it as the source's
 * account quota block (the big meter on the source page).
 *
 * Setup:
 *   1. Fill in COMMAND + ARGS below so the command prints one JSON object.
 *   2. Adapt map() so it returns { quota } in this shape:
 *        { state: 'live',
 *          buckets: [ { group, name, window,
 *                       remainingFraction,   // 0..1
 *                       resetTime?,           // ISO string, shown + counted down
 *                       description? } ],
 *          credits: { remaining }?,          // optional second row
 *          checkedAt: Date.now() }
 *   3. Set enabled: true.
 *   4. Copy this file to ../../plugins/.
 *
 * This is the same pattern quota CLIs use (e.g. a `/usage` slash-command that
 * answers with JSON): poll slowly, the command itself is the API.
 */

const { execFile } = require('node:child_process');

const CONFIG = {
  enabled: false, // <-- set true after configuring COMMAND below
  id: 'my-llm', // must match a source id in config/sources.json
  intervalMs: 5 * 60_000,

  command: 'mycli',
  args: ['usage', '--json'],
  timeoutMs: 60_000,

  /** stdout (JSON string) -> { quota } */
  map(stdout) {
    const line = String(stdout).trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
    if (!line) throw new Error('no JSON in command output');
    const data = JSON.parse(line);
    // ---- adapt these paths to your CLI's output ----
    return {
      quota: {
        state: 'live',
        buckets: (data.groups || []).map((g) => ({
          group: g.name,
          name: g.bucket_name || 'Remaining',
          window: g.window || '',
          remainingFraction: g.remaining_fraction ?? 0,
          resetTime: g.reset_time || null,
          description: g.description || null,
        })),
        credits: data.credits_remaining != null ? { remaining: data.credits_remaining } : null,
        checkedAt: Date.now(),
      },
    };
  },
};

module.exports = {
  id: CONFIG.id,
  intervalMs: CONFIG.intervalMs,
  enabled: CONFIG.enabled,

  async poll() {
    const stdout = await new Promise((resolve, reject) => {
      execFile(CONFIG.command, CONFIG.args, { timeout: CONFIG.timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (err, out) => (err && !out ? reject(err) : resolve(out)));
    });
    return CONFIG.map(stdout);
  },
};
