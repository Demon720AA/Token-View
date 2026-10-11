'use strict';
/**
 * Example plugin: antigravity model catalogue via the `agy` CLI:
 *
 *   agy models
 *
 * Prints one "<id>\t<Name>" pair per line (after a leading
 * "Fetching available models..." status line). The list is the
 * account's model menu — Gemini models draw from the gemini
 * weekly limit, Claude/GPT models from the 3p weekly limit
 * (see antigravity-quota.js for those meters).
 *
 * Returns { catalogue }. Copy to ../../plugins/ to use.
 */

const { execFile } = require('node:child_process');

const AGY = process.env.AGY_BIN || 'agy';
const TIMEOUT_MS = Number(process.env.AGY_TIMEOUT) || 90_000;

function fetchModels() {
  return new Promise((resolve) => {
    execFile(
      AGY,
      ['models'],
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, error: err.message || String(err) });
        resolve({ ok: true, text: String(stdout) });
      }
    );
  });
}

/** "id\tName" lines; skip the "Fetching..." status line and blanks */
function parseModels(text) {
  const models = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.includes('\t')) continue;
    const [id, ...rest] = t.split('\t');
    const name = rest.join('\t').trim();
    if (!id) continue;
    models.push({
      id: id.trim(),
      name: name || id.trim(),
      provider: 'antigravity',
      // everything `agy models` lists is on the account's menu
      reachable: true,
      status: 'active',
    });
  }
  return models;
}

module.exports = {
  id: 'antigravity',
  intervalMs: Number(process.env.AGY_MODELS_INTERVAL) || 15 * 60_000,

  async poll() {
    const res = await fetchModels();
    if (!res.ok) {
      return { catalogue: { state: 'error', models: [], error: res.error, checkedAt: Date.now() } };
    }
    const models = parseModels(res.text);
    return {
      catalogue: {
        state: 'live',
        models,
        allCount: models.length,
        error: null,
        checkedAt: Date.now(),
      },
    };
  },
};
