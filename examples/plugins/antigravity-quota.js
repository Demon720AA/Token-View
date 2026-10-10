'use strict';
/**
 * Example plugin: antigravity account quota via the `agy` CLI.
 *
 *   agy -p "/usage"   -> weekly limit groups (Gemini, Claude/GPT, ...)
 *   agy -p "/credits" -> G1 credits remaining
 *
 * Multi-account: agy reads its OAuth token from
 * $HOME/.gemini/antigravity-cli/antigravity-oauth-token, so running it
 * with a different HOME queries a different Google account. List extra
 * profiles in AGY_EXTRA_ACCOUNTS as "Label=/path/to/home" pairs
 * (comma-separated); the main account (the service's own HOME) is
 * always polled first. Buckets and credits are labelled with the
 * account email decoded from each profile's id_token, so the
 * accounts are told apart.
 *
 * The service needs write access to each extra profile's
 * .gemini/antigravity-cli directory so agy can refresh its token —
 * add a ReadWritePaths line to the unit (see install/token-view.service).
 *
 * Returns { quota }. Copy to ../../plugins/ to use.
 */

const { execFile } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGY = process.env.AGY_BIN || 'agy';
const TIMEOUT_MS = Number(process.env.AGY_TIMEOUT) || 90_000;

/** main account first, then every AGY_EXTRA_ACCOUNTS="Label=/path/to/home" pair */
const ACCOUNTS = [{ label: 'Main', home: null }];
for (const pair of (process.env.AGY_EXTRA_ACCOUNTS || '').split(',').filter(Boolean)) {
  const eq = pair.indexOf('=');
  if (eq > 0) ACCOUNTS.push({ label: pair.slice(0, eq), home: pair.slice(eq + 1) });
}

/**
 * Account identity: the email claim of the profile's id_token
 * (a JWT inside antigravity-oauth-token). Falls back to the
 * configured label when the file is missing or unreadable.
 */
function accountEmail(home) {
  const base = home || process.env.HOME || os.homedir();
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(base, '.gemini/antigravity-cli/antigravity-oauth-token'), 'utf8')
    );
    const payload = String(j.id_token || '').split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
}

function runAgy(prompt, home) {
  return new Promise((resolve) => {
    execFile(
      AGY,
      ['-p', prompt, '--output-format', 'json'],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: home ? { ...process.env, HOME: home } : process.env,
      },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ ok: false, error: err.message || String(err), stderr });
        try {
          const line = String(stdout).trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
          if (!line) return resolve({ ok: false, error: 'no JSON in output', stderr });
          resolve({ ok: true, data: JSON.parse(line) });
        } catch (e) {
          resolve({ ok: false, error: 'bad JSON: ' + e.message });
        }
      }
    );
  });
}

async function pollAccount(a) {
  const label = accountEmail(a.home) || a.label;
  const [usage, credits] = await Promise.all([runAgy('/usage', a.home), runAgy('/credits', a.home)]);
  const out = { label, buckets: [], credits: null, error: null };
  if (!usage.ok) {
    out.error = usage.error;
    return out;
  }
  const groups = usage.data?.command?.data?.groups ?? [];
  for (const g of groups) {
    for (const b of g.buckets ?? []) {
      out.buckets.push({
        group: label + ' · ' + g.name,
        id: a.label.toLowerCase() + '-' + b.id,
        name: b.name,
        window: b.window,
        remainingFraction: b.remaining_fraction ?? null,
        resetTime: b.reset_time ?? null,
        description: b.description ?? null,
      });
    }
  }
  const c = credits.ok ? credits.data?.command?.data : null;
  if (c) {
    out.credits = { label, remaining: c.remaining_credits ?? null, upgradeUri: c.upgrade_uri ?? null };
  }
  return out;
}

module.exports = {
  id: 'antigravity',
  intervalMs: Number(process.env.AGY_INTERVAL) || 5 * 60_000,

  async poll() {
    const accounts = await Promise.all(ACCOUNTS.map(pollAccount));
    const buckets = [];
    const credits = [];
    const errors = [];
    for (const a of accounts) {
      buckets.push(...a.buckets);
      if (a.credits) credits.push(a.credits);
      if (a.error) errors.push(a.label + ': ' + a.error);
    }
    if (!buckets.length && errors.length) {
      return { quota: { state: 'error', error: errors.join('; '), buckets: [], credits: [], checkedAt: Date.now() } };
    }
    return {
      quota: {
        state: 'live',
        error: errors.length ? errors.join('; ') : null,
        buckets,
        credits,
        checkedAt: Date.now(),
      },
    };
  },
};
