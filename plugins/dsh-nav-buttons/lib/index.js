/**
 * Host half of the navigation-buttons plugin.
 *
 * The feature itself lives in the browser: it listens for pointer side buttons
 * and walks a history of the places this window has shown. This half exists for
 * one reason — evidence. A client plugin that never activates is invisible from
 * outside the page (its module simply never runs), so the browser half reports
 * its own liveness here and the operator can ask over plain HTTP.
 *
 * `GET /tool-nav-buttons/status` returns what the page last reported. It reads
 * counters only: no session titles, no URLs, nothing about where the user went.
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-nav-buttons'

/** Route prefix owned by this plugin; the browser half posts to it. */
const ROUTE = '/tool-nav-buttons'

/**
 * The browser half's self-report. `loadedAt` proves the module executed; the
 * counters prove the listeners fire; `entries`/`index` show the history moving.
 * @typedef {object} PageReport
 * @property {number} loadedAt Epoch ms when the page half's apply() ran.
 * @property {number} visits Recorded places so far.
 * @property {number} backs Back steps taken.
 * @property {number} forwards Forward steps taken.
 * @property {number} entries Entries currently retained.
 * @property {number} index Current position in the stack.
 */

/**
 * Latest report per page-half instance.
 *
 * Electrons runs more than one renderer for one app, and every renderer that
 * loads the plugin runs its own page half. A single slot let them overwrite each
 * other, so `status` returned whichever reported last — the counters appeared to
 * jump backwards and a back/forward step looked like it did nothing. Keying by
 * instance keeps them apart; `status` then reports the freshest one.
 */
const reports = new Map()

/** Cap the map so a reload loop cannot grow it without bound. */
const MAX_REPORTED_INSTANCES = 8

/** Keys the last page report actually carried; empty until one arrives. */
let lastRawKeys = []

/** First bytes of the last page report, for reading the real payload. */
let lastRawSample = ''

/** Monotonic counter so reports inside the same millisecond still order. */
let reportSeq = 0

/** Ids of every instance that has reported since this host half started. */
let seenInstances = []

/**
 * The most recently reporting instance.
 *
 * Several renderers can each run a page half, so "the current state" is the one
 * that reported last rather than "whatever landed in a single slot".
 * @returns {{id: string, at: number, data: object}|undefined} the freshest entry.
 */
function freshestReport() {
  let best
  for (const [id, entry] of reports) {
    if (best === undefined || entry.seq > best.seq) best = { id, at: entry.at, seq: entry.seq, data: entry.data }
  }
  return best
}

/** Commands the page half accepts from the diagnostics mailbox. */
const COMMANDS = new Set(['back', 'forward', 'probe', 'selftest', 'peers', 'switch'])

/** The one queued command, if any. Single slot: a queue would let stale input pile up. */
let pendingCommand

/** Optional argument for the queued command (currently only switch). */
let pendingTarget

/** Inert host body: no tools, one diagnostics route. */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://nav-buttons.invalid')
      const endpoint = url.pathname.slice(ROUTE.length + 1)

      if (endpoint === 'status' && req.method === 'GET') {
        // "never reported" alone is misleading: after THIS host half reloads its
        // module state is empty, so a perfectly healthy page looks identical to
        // a page that never loaded until it next reports. Say which one it is.
        //
        // A reload of the host half does NOT re-execute an already-loaded page, so
        // the two halves can legitimately disagree about the payload shape. An
        // older page half reports shape 1 (no stack contents); saying so explains
        // a missing field without anyone guessing.
        const EXPECTED_SHAPE = 8
        const freshest = freshestReport()
        const body = JSON.stringify(freshest === undefined
          ? {
            pageHalf: 'awaiting first report',
            route: ROUTE,
            note: 'No report since this host half started. Reload the page, then wait up to 20s '
              + '(the page reports on a heartbeat) or move the mouse once.',
          }
          : {
            pageHalf: 'reported',
            ageMs: Date.now() - freshest.at,
            shapeStale: (freshest.data.shape ?? 1) < EXPECTED_SHAPE,
            // What the page actually sent. `shape: 1` says the loaded bundle is
            // old, but only the key list says whether the field is absent or the
            // whole payload is from a different build.
            reportKeys: lastRawKeys,
            reportSample: lastRawSample,
            // Every renderer that loaded the plugin runs its own page half. With
            // one slot they overwrote each other, so the counters appeared to move
            // backwards and a back/forward step looked like it did nothing. Naming
            // them makes that condition visible instead of mysterious.
            instance: freshest.id,
            instances: seenInstances,
            instanceCount: seenInstances.length,
            ...freshest.data,
          })
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(body)
        return
      }

      if (endpoint === 'command' && req.method === 'POST') {
        // A one-slot mailbox the page half drains. It exists so the navigation
        // logic can be exercised without synthesizing real mouse or keyboard input:
        // a test asks for `back`/`forward` and observes the resulting report.
        const chunks = []
        req.on('data', chunk => { chunks.push(chunk) })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const name = typeof parsed?.command === 'string' ? parsed.command : ''
            if (!COMMANDS.has(name)) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: `unknown command: ${name}` }))
              return
            }
            // switch carries a target session id; every other command is a bare name.
            pendingTarget = typeof parsed?.target === 'string' ? parsed.target : undefined
            pendingCommand = name
            res.writeHead(202, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ queued: name }))
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'body must be JSON' }))
          }
        })
        return
      }

      // The page half drains the mailbox through this. GET rather than POST so a
      // plain browser fetch cannot be mistaken for a state change by a proxy.
      if (endpoint === 'command' && req.method === 'GET') {
        const command = pendingCommand
        const target = pendingTarget
        pendingCommand = undefined
        pendingTarget = undefined
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ command: command ?? null, target: target ?? null }))
        return
      }

      if (endpoint === 'report' && req.method === 'POST') {
        // The body is a small JSON object; buffering it keeps this handler free of
        // stream bookkeeping for what is a diagnostics ping.
        const chunks = []
        req.on('data', chunk => { chunks.push(chunk) })
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            const parsed = JSON.parse(raw)
            // Keep the raw keys so "the field is missing" can be distinguished
            // from "the field is present but the wrong value" without guessing at
            // which page version is running.
            lastRawKeys = Object.keys(parsed).sort()
            lastRawSample = raw.slice(0, 300)
            // The instance id lets several renderers coexist instead of overwriting.
            const instance = typeof parsed.instance === 'string' && parsed.instance !== ''
              ? parsed.instance
              : 'unknown'
            if (!seenInstances.includes(instance)) {
              seenInstances = [...seenInstances, instance].slice(-MAX_REPORTED_INSTANCES)
            }
            const report = {
              // Which payload shape the page half speaks; compared in `status`.
              shape: Number(parsed.shape) || 1,
              installed: parsed.installed === true,
              error: typeof parsed.error === 'string' ? parsed.error : null,
              loadedAt: Number(parsed.loadedAt) || 0,
              visits: Number(parsed.visits) || 0,
              backs: Number(parsed.backs) || 0,
              forwards: Number(parsed.forwards) || 0,
              entries: Number(parsed.entries) || 0,
              index: Number(parsed.index) || 0,
              // Which observables the page half could actually reach. A missing
              // axis means that part of the feature is inert, which is otherwise
              // invisible from outside the page.
              sources: parsed.sources ?? null,
              // The place key the history currently holds: session/panel/tab,
              // separated by U+0001. Diagnostics only — it carries ids, not text.
              current: typeof parsed.current === 'string' ? parsed.current : null,
              // Proves whether the page half's observers actually fire, and what
              // they resolved to. Distinguishes "nothing moved" from "record is
              // dead", which look identical in the counters alone.
              recordCalls: Number(parsed.recordCalls) || 0,
              sampleCalls: Number(parsed.sampleCalls) || 0,
              listenersInstalled: Number(parsed.listenersInstalled) || 0,
              lastEvent: typeof parsed.lastEvent === 'string' ? parsed.lastEvent : null,
              lastRestoreError: typeof parsed.lastRestoreError === 'string' ? parsed.lastRestoreError : null,
              buttonLog: Array.isArray(parsed.buttonLog) ? parsed.buttonLog.slice(-10) : [],
              visitLog: Array.isArray(parsed.visitLog) ? parsed.visitLog.slice(-10) : [],
              stepTrace: Array.isArray(parsed.stepTrace) ? parsed.stepTrace.slice(-12) : [],
              lastSelftest: parsed.lastSelftest !== null && typeof parsed.lastSelftest === 'object' ? parsed.lastSelftest : null,
              lastPeers: Array.isArray(parsed.lastPeers) ? parsed.lastPeers : null,
              fired: parsed.fired !== null && typeof parsed.fired === 'object' ? parsed.fired : null,
              lastParts: parsed.lastParts !== null && typeof parsed.lastParts === 'object' ? parsed.lastParts : null,
              stack: Array.isArray(parsed.stack) ? parsed.stack : [],
              lastKeys: Array.isArray(parsed.lastKeys) ? parsed.lastKeys.slice(-8) : [],
            }
            // Date.now() alone cannot order two reports inside one millisecond,
            // which made status answer with an arbitrary one of them. A monotonic
            // counter makes 'freshest' unambiguous.
            reportSeq += 1
            reports.set(instance, { at: Date.now(), seq: reportSeq, data: report })
            // Drop the oldest instances once the cap is reached.
            if (reports.size > MAX_REPORTED_INSTANCES) {
              const oldest = [...reports.entries()].sort((a, b) => a[1].seq - b[1].seq)[0]
              if (oldest !== undefined) reports.delete(oldest[0])
            }
            res.writeHead(204).end()
          } catch {
            res.writeHead(400).end('bad report')
          }
        })
        return
      }

      res.writeHead(404).end()
    },
  }), 'dsh-nav-buttons: diagnostics route')
}

export default { name, inject: ['webServer'], apply }
