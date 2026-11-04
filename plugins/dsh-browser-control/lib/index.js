/**
 * Modified 2026-11-05: removed the unavailable screenshot tool from this distribution.
 *
 * Host half of browser control: registers the model-facing `browser_*` tools and
 * relays each call to the one live Harness page over a dedicated Connection RPC
 * channel. The page half drives the already-mounted Electron `<webview>` guest,
 * so every action happens in the user's own logged-in sidebar tab - no second
 * browser process, no re-login.
 *
 * Transport choice: a private `/tool-sidebar-browser` RPC channel instead of a
 * forwarded Cordis event. Forwarded events are a compile-time allowlist inside
 * `@deepseek-ai/dsh-api-remotes`, which a profile plugin cannot extend, so this
 * package mounts its own route on `ctx.webServer` and reuses the public
 * `ctx.connection.admit` trust check plus the existing `client-request` envelope.
 *
 * Tool contract: `ctx.tools.register` wants a canonical `output.schema` plus a
 * pure `output.render`, and `execute` returns the value that schema validates -
 * not model-facing content blocks. Each tool below therefore declares an
 * explicit result object so a page-side failure still validates.
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-browser-control'

/**
 * Services the Host half needs. `webServer` is required because
 * `ctx.connection.rpc.handle(channel, ...)` mounts a physical HTTP route through
 * the CALLING context (`owner.webServer.register`), so this scope must expose it.
 */
export const inject = ['tools', 'connection', 'webServer']

/** Private RPC channel carrying page-half calls. */
const CHANNEL = '/tool-sidebar-browser'

/** How long one tool call waits for the page half before reporting a timeout. */
const DEFAULT_TIMEOUT_MS = 30000

/** Answer reason used when no page half ever claimed a request. */
const NO_PAGE = 'no-page'

/**
 * The model-facing tools this plugin registers. Listed once so the diagnostics
 * route can report what is actually offered without duplicating the names.
 */
const TOOL_NAMES = [
  'browser_goto', 'browser_snapshot', 'browser_click', 'browser_fill',
  'browser_read_text', 'browser_eval',
]

/**
 * Correlate Host requests with page answers. The Host asks; the page polls with a
 * long-held `poll` call and posts results back through `resolve`.
 */
class PageBridge {
  #queue = []
  #claimed = new Set()
  #waiters = new Set()
  #sequence = 0
  #livePages = 0

  /**
   * Contact counters owned by this bridge, so diagnostics distinguish "the page
   * half never loaded" from "it loaded and then went away". Instance state also
   * keeps a reloaded plugin generation from inheriting a stale count.
   */
  polls = 0
  resolves = 0

  /** @returns whether any page half is currently polling. */
  get connected() {
    return this.#livePages > 0
  }

  /** @param connected - whether a page half is currently polling. */
  markPage(connected) {
    this.#livePages = Math.max(0, this.#livePages + (connected ? 1 : -1))
    this.#wake()
  }

  /**
   * Enqueue one action and wait for its answer.
   *
   * A request no page claims before `waitMs` leaves the queue with {@link NO_PAGE}
   * so the tool can tell "no Harness page is driving this channel" apart from an
   * action the page ran and failed.
   * @param {object} request - action name plus its JSON arguments.
   * @param {AbortSignal} signal - caller cancellation; a cancelled request leaves the queue.
   * @param {number} waitMs - how long an unclaimed request stays queued.
   * @returns {Promise<object>} the page answer.
   */
  async submit(request, signal, waitMs) {
    const id = `b${++this.#sequence}`
    const answer = new Promise((resolve) => { this.#queue.push({ id, request, resolve }) })
    this.#wake()
    const drop = () => {
      const index = this.#queue.findIndex(entry => entry.id === id)
      if (index >= 0) this.#queue.splice(index, 1)
      this.#claimed.delete(id)
    }
    const aborted = new Promise((resolve) => {
      const onAbort = () => { drop(); resolve({ ok: false, error: 'cancelled' }) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    const expired = new Promise((resolve) => {
      const timer = setTimeout(() => { drop(); resolve({ ok: false, error: NO_PAGE }) }, waitMs)
      void answer.finally(() => { clearTimeout(timer) })
    })
    return await Promise.race([answer, aborted, expired])
  }

  /**
   * Claim the oldest unclaimed request for a page half. Long-polls: resolves with
   * undefined when nothing arrives before the timeout, so the page can retry.
   * @param {AbortSignal} signal - poll cancellation.
   * @param {number} timeoutMs - how long to hold the poll open.
   * @returns {Promise<object|undefined>} the next request, or undefined on timeout/cancellation.
   */
  async claim(signal, timeoutMs) {
    const head = this.#queue.find(entry => !this.#claimed.has(entry.id))
    if (head !== undefined) {
      this.#claimed.add(head.id)
      return { id: head.id, request: head.request }
    }
    return await new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        this.#waiters.delete(wake)
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const wake = () => {
        const next = this.#queue.find(entry => !this.#claimed.has(entry.id))
        if (next === undefined) return
        this.#claimed.add(next.id)
        finish({ id: next.id, request: next.request })
      }
      const onAbort = () => { finish(undefined) }
      const timer = setTimeout(() => { finish(undefined) }, timeoutMs)
      this.#waiters.add(wake)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Deliver a page answer for one claimed request.
   * @param {string} id - request identity from `claim`.
   * @param {object} answer - the page answer.
   */
  settle(id, answer) {
    const index = this.#queue.findIndex(entry => entry.id === id)
    this.#claimed.delete(id)
    if (index < 0) return
    const [entry] = this.#queue.splice(index, 1)
    entry?.resolve(answer)
  }

  /** Release every waiting caller, e.g. when the channel is disposed. */
  dispose() {
    for (const entry of this.#queue.splice(0)) entry.resolve({ ok: false, error: 'page half unloaded' })
    this.#claimed.clear()
    for (const wake of [...this.#waiters]) wake()
    this.#waiters.clear()
  }

  #wake() {
    for (const wake of [...this.#waiters]) wake()
  }
}

/**
 * Reject navigation outside HTTP(S) or to hosts the opt-in does not allow.
 * @param {string} url - requested address.
 * @param {boolean} allowPrivate - whether loopback and private hosts are permitted.
 */
function assertNavigable(url, allowPrivate) {
  let parsed
  try { parsed = new URL(url) } catch { throw new Error(`browser_goto: ${JSON.stringify(url)} is not an absolute URL`) }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`browser_goto: only http and https are allowed, got ${parsed.protocol}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('browser_goto: embedded credentials are not allowed')
  }
  if (allowPrivate) return
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)
  const privateV4 = /^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
  const privateV6 = host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  if (loopback || privateV4 || privateV6) {
    throw new Error(
      `browser_goto: ${host} is a loopback or private address. Set allowPrivateHosts: true in the plugin config `
      + 'to permit it; the visited page then runs inside your own network position.',
    )
  }
}

/**
 * Normalise one page answer into the declared result shape. The payload travels
 * as a JSON string because the enforced output schema subset has no unconstrained
 * JSON node: page results are arbitrary per action.
 * @param {object} answer - the page half's answer.
 * @returns {{ok: boolean, json?: string, error?: string}} the canonical result.
 */
function result(answer) {
  return answer.ok === true
    ? { ok: true, json: JSON.stringify(answer.value ?? null) }
    : { ok: false, error: String(answer.error) }
}

/** Raw-schema output declaration shared by the JSON-shaped tools. */
const JSON_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'Whether the action completed.' },
      json: { type: 'string', description: 'The action result, JSON-encoded.' },
      error: { type: 'string', description: 'Why the action failed, when ok is false.' },
    },
    required: ['ok'],
    additionalProperties: false,
  },
  render(_args, value) {
    return [{ type: 'text', text: value.ok === true ? value.json ?? 'null' : JSON.stringify({ error: value.error }) }]
  },
}

/**
 * Concatenate body chunks into one Uint8Array.
 * @param {Uint8Array[]} chunks - received body parts.
 * @returns {Uint8Array} the joined bytes.
 */
function joinChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}

/**
 * Answer one page-half call on the private channel.
 *
 * The wire envelope is the one `createWebConnectionRpc` already sends on the
 * browser side (`client-request` in, `server-response` out), so the page half
 * needs no second protocol. Trust is the same: `ctx.connection.admit` performs
 * the browser-token and Host/Origin checks before any body is read, and only the
 * owner principal may drive the user's browser.
 *
 * @param {object} ctx - Host plugin context providing `connection`.
 * @param {PageBridge} bridge - request/answer correlator.
 * @param {object} req - node IncomingMessage.
 * @param {object} res - node ServerResponse.
 * @param {number} timeoutMs - per-call budget.
 */
async function handleChannelRequest(ctx, bridge, req, res, timeoutMs) {
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  try {
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission) {
      res.writeHead(admission.rejection)
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (admission.peer.principal.kind !== 'owner') {
      res.writeHead(403).end('forbidden')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://browser-control.invalid')
    const endpoint = url.pathname.slice(CHANNEL.length + 1)
    if (endpoint === 'status') {
      reply(200, { channel: CHANNEL, pageAttached: bridge.connected, polls: bridge.polls, resolves: bridge.resolves })
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    // Chunks arrive as Buffers/Uint8Arrays; TextDecoder decodes either without
    // assuming Node's Buffer is visible from this module's realm.
    const envelope = JSON.parse(new TextDecoder().decode(joinChunks(chunks)))
    const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'unknown'
    if (envelope?.method !== endpoint) {
      reply(200, { type: 'server-response', rpcId, result: { ok: false, error: {
        code: 'browser-control/bad-request', message: `method ${JSON.stringify(envelope?.method)} does not match ${JSON.stringify(endpoint)}`, details: {} } } })
      return
    }
    const answer = await dispatchChannel(bridge, endpoint, envelope.payload ?? {}, timeoutMs)
    reply(200, { type: 'server-response', rpcId, result: { ok: true, value: answer } })
  } catch (error) {
    reply(500, `browser-control channel failure: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Run one decoded channel endpoint.
 * @param {PageBridge} bridge - correlator.
 * @param {string} endpoint - decoded endpoint name.
 * @param {object} body - decoded payload.
 * @param {number} timeoutMs - hold time for a long poll.
 * @returns {Promise<object>} the endpoint value.
 */
async function dispatchChannel(bridge, endpoint, body, timeoutMs) {
  switch (endpoint) {
    case 'poll': {
      bridge.polls++
      bridge.markPage(true)
      try {
        const next = await bridge.claim(new AbortController().signal, Math.min(timeoutMs, 20000))
        return next === undefined ? { idle: true } : { id: next.id, request: next.request }
      } finally {
        bridge.markPage(false)
      }
    }
    case 'resolve': {
      bridge.resolves++
      if (typeof body.id !== 'string') throw new Error('resolve needs a string id')
      bridge.settle(body.id, body.answer)
      return { accepted: true }
    }
    case 'hello':
      return { connected: bridge.connected, polls: bridge.polls, resolves: bridge.resolves }
    default:
      throw new Error(`unknown endpoint ${JSON.stringify(endpoint)}`)
  }
}

/**
 * Register the browser tools. The row stays inert without `enabled`, so the
 * default profile pays no tool-definition tokens.
 * @param {object} ctx - Host plugin context.
 * @param {object} [config] - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const enabled = config?.enabled ?? true
  if (!enabled) return
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const allowPrivate = config?.allowPrivateHosts ?? false
  const bridge = new PageBridge()
  ctx.effect(() => () => { bridge.dispose() }, 'dsh-browser-control: page bridge')

  // `ctx.connection.rpc.handle(channel, …)` mounts its HTTP route through the
  // CALLING context's own `webServer` property (`owner.webServer.register`), and
  // that property access throws unless the reading fiber declares it. A profile
  // row's fiber cannot rely on that, so the route is mounted here directly on the
  // server this activation resolved, with the same admission policy.
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    ctx.logger.warn(`dsh-browser-control: no webServer here; ${CHANNEL} stays unmounted`)
  } else {
    // One prefix route owns the whole channel, including its `status` page, so a
    // request no endpoint matches is answered by the channel itself instead of
    // colliding with a sibling exact route.
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: (req, res) => {
        void handleChannelRequest(ctx, bridge, req, res, timeoutMs)
      },
    }), 'dsh-browser-control: rpc channel')

    // The channel's own `status` endpoint sits behind `connection.admit`, which is
    // correct for anything that drives a page: only the owner may. Diagnosing
    // "is the page half attached" then needed a signed-in browser session, so this
    // separate route answers that one question with counters and booleans. It
    // exposes no page content, no URLs, and cannot drive anything.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: `${CHANNEL}-diagnostics`,
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          channel: CHANNEL,
          pageAttached: bridge.connected,
          polls: bridge.polls,
          resolves: bridge.resolves,
          toolsRegistered: TOOL_NAMES,
        }))
      },
    }), 'dsh-browser-control: read-only diagnostics')
  }

  /**
   * Forward one action to the page half.
   *
   * The request is queued before checking whether a page is attached: a page
   * between long polls (its previous poll returned idle and the next has not
   * arrived yet) is still attached and will pick the request up. Only a page that
   * never polled at all, or one that has gone for the whole call budget, is
   * reported as unattached.
   * @param {object} request - action name plus its JSON arguments.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {Promise<object>} the declared tool result.
   */
  const call = async (request, signal) => {
    const answer = await bridge.submit(request, signal, timeoutMs)
    if (!answer.ok && answer.error === 'cancelled') throw new Error('browser call cancelled')
    // A page that has never polled cannot answer; distinguish it from a page
    // whose action ran and failed, which keeps the page's own message.
    if (!answer.ok && answer.error === NO_PAGE) {
      throw new Error(
        'The browser half has never contacted the Host in this page session. '
        + 'Reload the DSH window, open the 浏览器 tab in the right sidebar, then retry.',
      )
    }
    return result(answer)
  }

  /** Register one tool whose only job is forwarding an action to the page half. */
  const tool = (id, definition) => {
    ctx.effect(() => ctx.tools.register(definition), `dsh-browser-control: ${id}`)
  }

  tool('goto', {
    name: 'browser_goto',
    description: 'Navigate the user-visible sidebar browser tab to an http(s) URL, keeping its cookies and login state. '
      + 'Returns the resolved final URL and document title once the load settles.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http or https URL.' },
        tabId: { type: 'string', description: 'Optional sidebar browser tab id; defaults to the active browser tab.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      assertNavigable(args.url, allowPrivate)
      return await call({ action: 'goto', url: args.url, ...args.tabId === undefined ? {} : { tabId: args.tabId } }, exec.signal)
    },
  })

  tool('snapshot', {
    name: 'browser_snapshot',
    description: 'Read the current sidebar browser page as a compact list of interactive and textual elements, '
      + 'each with a stable ref usable by browser_click and browser_fill. Returns URL, title and the elements.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Optional sidebar browser tab id.' },
        maxElements: { type: 'number', description: 'Cap on returned elements; defaults to 200.' },
        selector: { type: 'string', description: 'Optional CSS selector scoping the snapshot.' },
      },
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return await call({ action: 'snapshot', ...args }, exec.signal)
    },
  })

  tool('click', {
    name: 'browser_click',
    description: 'Click an element in the sidebar browser page, by snapshot ref or CSS selector. '
      + 'Returns the element that was clicked and the URL the page was on before the click.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "e12".' },
        selector: { type: 'string', description: 'CSS selector, used when ref is absent.' },
        tabId: { type: 'string', description: 'Optional sidebar browser tab id.' },
      },
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      if (args.ref === undefined && args.selector === undefined) throw new Error('browser_click needs ref or selector')
      return await call({ action: 'click', ...args }, exec.signal)
    },
  })

  tool('fill', {
    name: 'browser_fill',
    description: 'Focus an input, textarea or contenteditable element in the sidebar browser page and set its value, '
      + 'dispatching the input and change events a real user would produce. Optionally submits the owning form.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
        selector: { type: 'string', description: 'CSS selector, used when ref is absent.' },
        value: { type: 'string', description: 'Text to enter.' },
        submit: { type: 'boolean', description: 'Submit the owning form after filling; defaults to false.' },
        tabId: { type: 'string', description: 'Optional sidebar browser tab id.' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      if (args.ref === undefined && args.selector === undefined) throw new Error('browser_fill needs ref or selector')
      return await call({ action: 'fill', ...args }, exec.signal)
    },
  })

  tool('read_text', {
    name: 'browser_read_text',
    description: 'Read visible text from the sidebar browser page, optionally scoped to a CSS selector. '
      + 'Use it after a navigation to read the page body without listing every element.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector; defaults to the document body.' },
        maxChars: { type: 'number', description: 'Cap on returned characters; defaults to 8000.' },
        tabId: { type: 'string', description: 'Optional sidebar browser tab id.' },
      },
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return await call({ action: 'read_text', ...args }, exec.signal)
    },
  })

  tool('eval', {
    name: 'browser_eval',
    description: 'Evaluate a JavaScript expression in the sidebar browser page and return its JSON-serialisable result. '
      + 'The expression runs in the page, so it can read that origin\'s DOM and storage but cannot reach Harness APIs.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Expression evaluated in the page; its value is returned.' },
        awaitPromise: { type: 'boolean', description: 'Await a returned promise; defaults to true.' },
        tabId: { type: 'string', description: 'Optional sidebar browser tab id.' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return await call({ action: 'eval', ...args }, exec.signal)
    },
  })

  ctx.logger.info(`dsh-browser-control: ${TOOL_NAMES.length} browser tools registered on ${CHANNEL}`)
}

/**
 * Default export as the plugin object. Cordis reads `plugin.inject` off the value
 * it is handed; a bare `apply` function carries no `inject`, so the loader would
 * start the fiber without `webServer` and `rpc.handle` would throw. Exporting the
 * object form keeps `name`, `inject`, and `apply` together regardless of whether
 * the loader resolves this module's default or its namespace.
 */
export default { name, inject, apply }
