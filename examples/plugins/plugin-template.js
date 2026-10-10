'use strict';
/**
 * Minimal plugin skeleton. Copy to ../../plugins/<name>.js and fill in poll().
 *
 * The server calls poll() every intervalMs and merges the result into the
 * dashboard. Throw (or resolve null) when the backend is unreachable — the
 * source is then shown as unavailable until the next poll.
 *
 * Result fields (all optional):
 *   total     absolute counters { input, output, reasoning?, cacheRead?,
 *                                 cacheWrite?, cost? }  -> quota meters
 *   events    fresh items since last poll for the live feed + chart:
 *             [ { requestId?, model?, provider?, app?, endpoint?,
 *                 inputTokens?, outputTokens?, cacheReadTokens?,
 *                 reasoningTokens?, costUsd?, ts? } ]
 *   quota     external account quota for the big block on the source page:
 *             { state: 'live', buckets: [ { group, name, window,
 *               remainingFraction, resetTime?, description? } ],
 *               credits?: { remaining }, checkedAt }
 *   catalogue model list for /models: { state: 'live', models: [ {
 *               id, provider?, context?, maxOutput?, tools?, reachable?,
 *               status?, limited?: { hits, lastHit } } ] }
 *   meta      extra provenance fields shown in footnotes, e.g. { sessions: 6 }
 *   file      origin string shown in footnotes, e.g. '~/.cache/myllm/usage.db'
 */

module.exports = {
  id: 'my-llm', // must match a source id in config/sources.json
  intervalMs: 10_000,
  enabled: false, // the loader skips plugins with enabled === false

  async poll() {
    // ... read your backend here ...
    return {
      total: { input: 0, output: 0 },
      events: [],
    };
  },
};
