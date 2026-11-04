/**
 * How long to wait before retrying a failed model request.
 *
 * Two knobs, both readable from Settings: the ceiling for one wait, and how many
 * attempts to spend. Everything else is derived.
 *
 * Why a plugin at all: the harness retry executor refuses to own numbers (it reads
 * them from whatever the adapter registration captured), and the subscription
 * adapter can only raise its 60s ceiling — `Math.max(60_000, maxWaitMs)` — so no
 * configuration lowers it. This listener decides one step earlier in the waterfall
 * and writes the same durable `llm/retry` / `llm/retry-started` events, which keeps
 * the Chat retry row, the session log and replay unchanged.
 *
 * It always CLAMPS: a wait never exceeds the ceiling, including a provider-disclosed
 * reset. Retrying against a window that is still closed burns an attempt, which is
 * the price of not waiting 60s; `maxRetries` bounds that price.
 *
 * @module dsh-retry-tuning
 */

import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { MAX_TIMER_DELAY_MS, waitFor } from './wait.js'

/** Stable Cordis plugin name; matches the patch row id. */
export const name = 'dsh-retry-tuning'

// The listener needs no service of its own: `agent/request-error` is delivered to
// every fiber, and the session on the payload carries the durable log this reads.
export const inject = []

/**
 * Failures the harness repairs by shrinking the request rather than by waiting.
 * Claiming one here would silently disable that repair, so they always delegate.
 */
const STRUCTURAL = new Set(['CONTEXT_WINDOW_EXCEEDED', 'REQUEST_TOO_LARGE', 'IMAGE_OFFLOAD_REQUIRED'])

/** Default code set: the transient failures worth one more attempt. */
const DEFAULT_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

const Config = z.object({
  enabled: z.boolean().default(true).description('接管重试等待；关闭后交回内置策略'),
  maxWaitMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000)
    .description('单次重试最多等多久（毫秒）；本地退避和上游给出的重置时间都不超过它'),
  maxRetries: z.number().step(1).min(0).max(100).default(4)
    .description('首次请求之后最多再试几次'),
  retryableCodes: z.array(z.string()).default(DEFAULT_CODES)
    .description('值得等待的失败码；结构性修复类失败码永远交给原插件'),
}).volatile()

export { Config }

/** Read one Config member, whether it arrives as a Volatile reference or a plain value. */
function read(config, key) {
  const raw = config?.[key]
  return raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
}

/** Reject as soon as either signal aborts, leaving no pending timer behind. */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Count the attempts this plugin already spent on the current step, straight from
 * the committed log. Reading events rather than plugin memory keeps the budget
 * correct across resume, fork and replay.
 * @param {object} session - the agent's session.
 * @param {string} provider - failing route.
 * @param {number} turn - current turn.
 * @param {number} step - current step.
 * @returns {{ retry: number, retryId: string | undefined }} attempts so far, and the chain id.
 */
function spent(session, provider, turn, step) {
  const events = session.snapshotEvents()
  let retry = 0
  let retryId
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'step/start') break
    if (event.type !== 'llm/retry') continue
    const data = event.data
    // Only chains this plugin wrote: a different provider, or an attempt the
    // built-in policy recorded, must not consume our budget.
    if (data.provider !== provider || data.turn !== turn || data.step !== step) continue
    if (data.policyKey !== KEY) continue
    retry += 1
    retryId ??= data.retryId
  }
  return { retry, retryId }
}

/** Identity of this policy, recorded so a ceiling change starts a fresh budget. */
const KEY = 'retry-tuning'

/**
 * Mount the timed-retry decision point.
 * @param {object} ctx - host plugin context.
 * @param {object} config - parsed Config; members are Volatile references.
 */
export function apply(ctx, config) {
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error('dsh-retry-tuning disposed')) },
    'dsh-retry-tuning: abort waits')

  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next) => {
    if (lifetime.signal.aborted || signal.aborted) return next()
    if (read(config, 'enabled') === false) return next()
    if (STRUCTURAL.has(failure.code)) return next()

    const ceiling = read(config, 'maxWaitMs')
    if (!Number.isFinite(ceiling) || ceiling <= 0) return next()
    const maxRetries = read(config, 'maxRetries')
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) return next()
    const codes = read(config, 'retryableCodes')
    // An empty or malformed list must delegate rather than retry everything,
    // which would turn one bad Settings write into an unbounded retry storm.
    if (!Array.isArray(codes) || !codes.includes(failure.code)) return next()

    const { retry: already, retryId: knownId } = spent(agent.session, provider, turn, step)
    if (already >= maxRetries) return next()

    const retry = already + 1
    const delayMs = waitFor(ceiling, failure, retry)
    const retryId = knownId ?? randomUUID()
    // Durable before the wait: a crash mid-wait must not lose the attempt it spent.
    agent.session.append('llm/retry', {
      retryId, turn, step, provider,
      mode: 'normal',
      policyKey: KEY,
      retry,
      maxRetries,
      delayMs,
      failure,
    })
    if (!await cancellableDelay(delayMs, AbortSignal.any([signal, lifetime.signal]))) return
    if (signal.aborted || lifetime.signal.aborted) return
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }, { prepend: true })
}

export default { name, inject, Config, apply }
