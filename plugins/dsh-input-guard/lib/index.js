/**
 * Input guard: make synthesized mouse/keyboard activity visible and stoppable.
 *
 * Why this plugin exists
 * ----------------------
 * An agent driving the real mouse and keyboard is unlike an agent editing files:
 * it takes the machine away from the person using it. ChatGPT/Codex make that
 * visible — the UI shows what is being driven and the user can stop it. This
 * plugin is that surface for the Harness.
 *
 * How it works
 * ------------
 * The host half owns the authorization state and exposes it over a small HTTP
 * route. A caller that wants to synthesize input must:
 *
 *   1. POST /tool-input-guard/request  → ask for a short-lived lease
 *   2. repeat POST /tool-input-guard/beat → keep it alive while driving
 *   3. POST /tool-input-guard/release  → hand control back
 *
 * The browser half renders a persistent banner in `shell.overlay` for as long as
 * a lease is live, with a Stop control. Stopping revokes the lease, so the driver
 * loses permission on its next check rather than at the end of its run.
 *
 * This is a consent surface, not a sandbox: a script that ignores the lease can
 * still move the mouse. What it guarantees is that such a script cannot do so
 * *quietly* through this plugin, and that the user has a visible, working stop.
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-input-guard'

/**
 * The consent route needs the HTTP carrier. Declaring it here makes Cordis wait
 * for `webServer` before activation; reading it through `ctx.get()` with an empty
 * `inject` raced the carrier's own startup and silently mounted nothing.
 */
export const inject = ['webServer']

/** Prefix owned by this plugin. */
const ROUTE = '/tool-input-guard'

/** How long a lease survives without a heartbeat before it self-revokes. */
const LEASE_TTL_MS = 15_000

/**
 * State of one lease.
 * @typedef {object} Lease
 * @property {string} id Opaque lease identity.
 * @property {string} purpose Human-readable reason shown in the banner.
 * @property {number} startedAt Epoch ms when the lease was granted.
 * @property {number} beats Heartbeats observed.
 * @property {boolean} revoked Set when the user pressed Stop.
 * @property {number} expiresAt Epoch ms after which the lease is invalid.
 */

/** The single live lease, or undefined when nothing is being driven. */
let lease

/**
 * Read the current authorization.
 * @returns {{active: boolean, revoked: boolean, purpose?: string, ageMs?: number, beats?: number}}
 */
function state() {
  if (lease === undefined) return { active: false, revoked: false }
  const expired = Date.now() > lease.expiresAt
  return {
    active: !expired && !lease.revoked,
    revoked: lease.revoked || expired,
    purpose: lease.purpose,
    ageMs: Date.now() - lease.startedAt,
    beats: lease.beats,
  }
}

/**
 * Read one JSON body without stream bookkeeping.
 * @param {object} req - node IncomingMessage.
 * @returns {Promise<object>} the parsed object, or an empty object.
 */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', chunk => { chunks.push(chunk) })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { resolve({}) }
    })
  })
}

/**
 * Host half: expose the consent route.
 * @param {object} ctx - host plugin context.
 */
export function apply(ctx) {
  // `inject: ['webServer']` guaranteed this is resolved before apply() runs.
  const webServer = ctx.webServer

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://input-guard.invalid').pathname
      const endpoint = path.slice(ROUTE.length + 1)
      const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }

      if (endpoint === 'state' && req.method === 'GET') { json(200, state()); return }

      if (endpoint === 'request' && req.method === 'POST') {
        const body = await readJson(req)
        const purpose = typeof body.purpose === 'string' && body.purpose.trim() !== ''
          ? body.purpose.trim().slice(0, 160)
          : 'Agent is using your mouse and keyboard'
        lease = {
          id: `lease-${Date.now().toString(36)}`,
          purpose,
          startedAt: Date.now(),
          beats: 0,
          revoked: false,
          expiresAt: Date.now() + LEASE_TTL_MS,
        }
        json(200, { granted: true, ...state() })
        return
      }

      if (endpoint === 'beat' && req.method === 'POST') {
        if (lease === undefined) { json(200, { granted: false, active: false, revoked: false }); return }
        if (lease.revoked) { json(200, { granted: false, ...state() }); return }
        lease.beats++
        lease.expiresAt = Date.now() + LEASE_TTL_MS
        json(200, { granted: true, ...state() })
        return
      }

      if (endpoint === 'stop' && req.method === 'POST') {
        // Marks rather than deletes: the driver must observe the revocation on
        // its next check instead of seeing a fresh, re-grantable slot.
        if (lease !== undefined) lease.revoked = true
        json(200, { stopped: true, ...state() })
        return
      }

      if (endpoint === 'release' && req.method === 'POST') {
        lease = undefined
        json(200, { active: false, revoked: false })
        return
      }

      res.writeHead(404).end()
    },
  }), 'dsh-input-guard: consent route')
}

export default { name, inject, apply }
