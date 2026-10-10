'use strict';
/**
 * antigravity usage/quota reader.
 *
 * There is no local HTTP API for antigravity — the desktop language server that
 * normally injects ANTIGRAVITY_LS_ADDRESS is not running here. The supported
 * interface is the `agy` CLI, which answers read-only slash commands with a
 * structured JSON payload:
 *
 *   agy -p "/usage"   --output-format json   -> weekly limit buckets
 *   agy -p "/credits" --output-format json   -> remaining G1 credits
 *
 * Each invocation costs ~5s, so this polls on a slow interval.
 */

const { execFile } = require('node:child_process');

const AGY = process.env.AGY_BIN || 'agy';
const TIMEOUT_MS = Number(process.env.AGY_TIMEOUT) || 90_000;

function runAgy(prompt) {
  return new Promise((resolve) => {
    execFile(
      AGY,
      ['-p', prompt, '--output-format', 'json'],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ ok: false, error: err.message || String(err), stderr });
        try {
          // the CLI may print leading log lines; take the last JSON object
          const line = stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
          if (!line) return resolve({ ok: false, error: 'no JSON in output', stderr });
          resolve({ ok: true, data: JSON.parse(line) });
        } catch (e) {
          resolve({ ok: false, error: 'bad JSON: ' + e.message });
        }
      }
    );
  });
}

/** flatten the /usage quota tree into rows we can render */
function parseUsage(data) {
  const groups = data?.command?.data?.groups ?? [];
  const buckets = [];
  for (const g of groups) {
    for (const b of g.buckets ?? []) {
      buckets.push({
        group: g.name,
        id: b.id,
        name: b.name,
        window: b.window,
        remainingFraction: b.remaining_fraction ?? null,
        resetTime: b.reset_time ?? null,
        description: b.description ?? null,
      });
    }
  }
  return buckets;
}

function parseCredits(data) {
  const c = data?.command?.data;
  if (!c) return null;
  return { remaining: c.remaining_credits ?? null, upgradeUri: c.upgrade_uri ?? null };
}

/**
 * Poll agy for quota + credits.
 * @param {{intervalMs?: number, onUpdate?: Function, onError?: Function}} opts
 */
function startAgyReader({ intervalMs = 5 * 60_000, onUpdate, onError } = {}) {
  let stopped = false;
  let running = false;

  const poll = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const [usage, credits] = await Promise.all([runAgy('/usage'), runAgy('/credits')]);
      if (stopped) return;

      const out = {
        state: usage.ok ? 'live' : 'error',
        error: usage.ok ? null : usage.error,
        buckets: usage.ok ? parseUsage(usage.data) : [],
        credits: credits.ok ? parseCredits(credits.data) : null,
        // per-turn token counts the CLI reports; zero for read-only commands
        usage: usage.ok ? usage.data.usage ?? null : null,
        checkedAt: Date.now(),
      };
      onUpdate?.(out);
    } catch (err) {
      onError?.(err);
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

module.exports = { startAgyReader, runAgy, parseUsage, parseCredits, AGY };
