/**
 * Retry wait arithmetic.
 *
 * These assertions exist because this number is the whole feature: it decides
 * whether a failed request comes back in seconds or sits for a minute. Two of
 * them guard behaviour that was wrong in an earlier draft and would have been
 * noticed only in production — a ceiling below the provider's disclosed reset
 * used to refuse the retry entirely, and a zero wait would have fired instantly.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { waitFor } from '../lib/wait.js'

describe('waitFor', () => {
  it('doubles from one second and stops at the ceiling', () => {
    assert.equal(waitFor(30_000, {}, 1), 1_000)
    assert.equal(waitFor(30_000, {}, 2), 2_000)
    assert.equal(waitFor(30_000, {}, 3), 4_000)
    assert.equal(waitFor(30_000, {}, 5), 16_000)
    assert.equal(waitFor(30_000, {}, 6), 30_000)
    assert.equal(waitFor(30_000, {}, 99), 30_000)
  })

  it('cuts a provider-disclosed reset down to the ceiling instead of refusing it', () => {
    // The case this plugin exists for: codex says "recover in 1m00s" and the user
    // allows 30s. Waiting the full minute is what they asked to avoid; giving up
    // is not what they asked for either.
    assert.equal(waitFor(30_000, { providerRetryAfterMs: 60_000 }, 1), 30_000)
    assert.equal(waitFor(5_000, { providerRetryAfterMs: 3_600_000 }, 1), 5_000)
  })

  it('honors a disclosed reset shorter than the ceiling', () => {
    // The provider is saying the window is genuinely open; there is no reason to
    // sit out the full local schedule instead.
    assert.equal(waitFor(30_000, { providerRetryAfterMs: 2_500 }, 1), 2_500)
  })

  it('always returns a schedulable positive wait', () => {
    for (const ceiling of [1, 2, 999, 30_000, 2_147_483_647]) {
      for (const retry of [1, 2, 10, 1_000]) {
        const delay = waitFor(ceiling, {}, retry)
        assert.ok(Number.isFinite(delay), `not finite: ${delay}`)
        assert.ok(delay >= 1, `a zero wait would fire instantly: ${delay}`)
        assert.ok(delay <= ceiling, `${delay} exceeded the ceiling ${ceiling}`)
      }
    }
  })

  it('treats an unusable disclosed value as absent', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, 'soon']) {
      assert.equal(waitFor(30_000, { providerRetryAfterMs: bad }, 1), 1_000)
    }
  })

  it('never schedules past a timer that Node can actually fire', () => {
    // A ceiling above Node's limit would otherwise produce a timer that fires
    // immediately, i.e. no wait at all.
    const huge = Number.MAX_SAFE_INTEGER
    assert.ok(waitFor(huge, {}, 60) <= 2_147_483_647)
    assert.ok(waitFor(huge, { providerRetryAfterMs: huge }, 1) <= 2_147_483_647)
  })

  it('stays finite across a long budget', () => {
    // 2 ** (retry - 1) overflows to Infinity without the exponent clamp.
    assert.ok(Number.isFinite(waitFor(30_000, {}, 5_000)))
  })
})
