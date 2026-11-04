/**
 * How long one retry waits.
 *
 * Kept apart from the plugin entry so it can be tested without the Host's own
 * packages, and so the rule stays readable in one place: start at a second,
 * double, and let nothing — local backoff or a provider-disclosed reset — exceed
 * the configured ceiling.
 *
 * @module dsh-retry-tuning/wait
 */

/** Node cannot schedule a longer timer; a longer delay fires immediately instead. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** The local schedule starts here and doubles per attempt. */
const FIRST_WAIT_MS = 1_000

/**
 * The wait one attempt uses.
 *
 * A disclosed reset shorter than the ceiling is kept as-is, because the provider
 * is saying the window is genuinely open. A longer one is cut to the ceiling: this
 * plugin exists so a wait is never longer than the user allowed, and refusing the
 * retry outright would trade a slow recovery for no recovery at all.
 * @param {number} ceiling - the configured maximum for one wait, in milliseconds.
 * @param {{ providerRetryAfterMs?: number }} failure - the failed attempt's facts.
 * @param {number} retry - 1-based attempt number.
 * @returns {number} the wait in milliseconds, always at least 1 and never above the ceiling.
 */
export function waitFor(ceiling, failure, retry) {
  const bounded = Math.min(ceiling, MAX_TIMER_DELAY_MS)
  const disclosed = failure?.providerRetryAfterMs
  if (typeof disclosed === 'number' && Number.isFinite(disclosed) && disclosed > 0) {
    return Math.max(1, Math.min(disclosed, bounded))
  }
  // The exponent clamp keeps 2 ** (retry - 1) from overflowing to Infinity on a
  // long budget; the ceiling makes the result identical either way.
  const exponential = Math.min(FIRST_WAIT_MS * 2 ** Math.min(retry - 1, 1_024), bounded)
  // Rounded because the product of two floats otherwise lands on values such as
  // 1200.0000000000002, and a fractional timer delay means nothing.
  return Math.max(1, Math.round(exponential))
}
