/**
 * Modified by DSH Next Plugins: version 0.1.1 requires an explicit browser
 * selection and removes the development computer's default browser binding.
 *
 * Host half of the bsk bridge: exposes the BrowserSkill `bsk` CLI to the model as
 * exactly two tools.
 *
 * Why a CLI bridge and not a page half: `bsk` already owns the transport between
 * this machine and the user's real browser (a local daemon plus a browser
 * extension). DSH therefore only needs to run the CLI and hand back its JSON, so
 * there is no second RPC channel, no client bundle, and no cookie handling here.
 * The user's existing logins live in their own profile, which is the point.
 *
 * Why only two tools: one tool per bsk subcommand would put ~50 schemas on the
 * model surface on every turn. This profile has already measured that failure
 * mode once (an MCP server whose 209 tool definitions came to ~66k tokens per
 * turn and were never called). So the surface stays at `bsk_session` for
 * lifecycle and one `bsk` runner that takes a command line, and the long tail of
 * subcommands is documented in the bundled skill rather than in schemas.
 *
 * Tool contract: `ctx.tools.register` wants a canonical `output.schema` plus a
 * pure `output.render`, and `execute` returns the value that schema validates.
 * bsk's own answers are arbitrary per command, so the payload travels as a JSON
 * string in `json` and a failure still validates.
 */

import { execFile } from 'node:child_process'

/** Stable Cordis plugin name. */
export const name = 'dsh-bsk-bridge'

/** This plugin needs the tool registry and nothing else from the Host. */
export const inject = ['tools']

/** Fallback location of the CLI when the profile does not configure one. */
const DEFAULT_BINARY = 'bsk'

/** One command's wall-clock budget. bsk's own default navigate timeout is 30s. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Output guard: a huge `observe` tree must not silently flood the context. */
const DEFAULT_MAX_CHARS = 60_000

/**
 * Subcommands that change the user's machine or browser session lifecycle.
 * Kept deliberately small: everything here is still reachable, but the tool
 * description warns the model to get consent first.
 */
const CONSENT_REQUIRED = new Set(['update', 'daemon', 'install-skill'])

/** Raw-schema output declaration shared by both tools. */
const JSON_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'Whether the command exited successfully.' },
      json: { type: 'string', description: 'The command result, JSON-encoded when bsk emitted JSON.' },
      error: { type: 'string', description: 'Why the command failed, when ok is false.' },
    },
    required: ['ok'],
    additionalProperties: false,
  },
  render(_args, value) {
    return [{ type: 'text', text: value.ok === true ? value.json ?? 'null' : JSON.stringify({ error: value.error }) }]
  },
}

/**
 * Run the CLI once and capture both streams.
 *
 * `execFile` (not `exec`) is deliberate: arguments are passed as an array with no
 * shell, so a page-derived string such as a selector cannot turn into a command.
 * @param binary - CLI to run.
 * @param args - argument vector, already validated by the caller.
 * @param timeoutMs - hard wall-clock limit.
 * @param prefix - fixed arguments inserted before the caller's vector, used to
 *   launch an interpreter-hosted CLI (e.g. a `.mjs`) without a shell.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} the finished run.
 */
function run(binary, args, timeoutMs, prefix = []) {
  return new Promise(resolve => {
    execFile(binary, [...prefix, ...args], {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      // A non-zero exit is data, not an exception: bsk reports its own failures
      // as JSON on stdout with a matching exit code, and the model needs to see
      // them to decide what to do next.
      const code = error === null
        ? 0
        : typeof error.code === 'number' ? error.code : 1
      const failure = error !== null && typeof error.code !== 'number'
        ? String(error.message ?? error)
        : ''
      resolve({ code, stdout: String(stdout ?? ''), stderr: `${String(stderr ?? '')}${failure}` })
    })
  })
}

/**
 * Turn one finished run into the declared result shape.
 * @param finished - the run's exit status and streams.
 * @param maxChars - cap applied to the payload sent back to the model.
 * @returns {{ok: boolean, json?: string, error?: string}} the canonical result.
 */
function result(finished, maxChars) {
  const stdout = finished.stdout.trim()
  const stderr = finished.stderr.trim()
  if (finished.code !== 0) {
    // bsk puts its machine-readable failure on stdout; prefer it over stderr,
    // which often only carries a human sentence.
    const detail = stdout !== '' ? stdout : stderr
    return { ok: false, error: `bsk exited with ${finished.code}: ${clip(detail, maxChars)}` }
  }
  return { ok: true, json: clip(stdout === '' ? 'null' : stdout, maxChars) }
}

/**
 * Cut an over-long payload and say so, so truncation is never mistaken for the
 * command's real answer.
 * @param text - payload to bound.
 * @param maxChars - allowed length.
 * @returns {string} the original or a truncation notice.
 */
function clip(text, maxChars) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\nâ€?truncated ${text.length - maxChars} characters `
    + '(use a narrower selector/ref, or write long output to a file with --out)'
}

/**
 * Reject an argument vector that would escape the intended command position.
 *
 * Only the shape is checked here; bsk validates semantics itself and reports
 * those errors back as JSON, which is the behaviour the model should learn.
 * @param args - caller-supplied arguments.
 * @returns {string[]} the arguments to pass.
 * @throws when the vector is empty or not an array of strings.
 */
function assertArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('bsk: `args` must be a non-empty array such as ["browsers"] or ["observe","--session","abc"]')
  }
  for (const item of args) {
    if (typeof item !== 'string') throw new Error(`bsk: every element of \`args\` must be a string, got ${typeof item}`)
  }
  return args
}

/**
 * Register the two model-facing tools.
 * @param ctx - Cordis context carrying the `tools` service.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const enabled = config?.enabled ?? true
  if (!enabled) return
  const binary = config?.binary ?? DEFAULT_BINARY
  /**
   * Fixed arguments placed before every caller vector. This is how an
   * interpreter-hosted CLI is launched (binary: "node", binaryArgs: ["bsk.mjs"])
   * without enabling a shell, which would let page-derived strings become
   * commands.
   */
  const binaryArgs = Array.isArray(config?.binaryArgs) ? config.binaryArgs : []
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxChars = config?.maxChars ?? DEFAULT_MAX_CHARS
  const browser = config?.browser

  /** Require an explicit browser binding before any session can control tabs. */
  const requireBrowser = value => {
    if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
      throw new Error('bsk: choose a browser from bsk_session action "browsers", then supply its id for "start" or configure browser in the plugin profile')
    }
    return value
  }

  /**
   * Prefix a browser selector onto a lifecycle call when no `--browser` was
   * given. The profile pins one instance, and silently starting a session on a
   * different one is the mistake this guard exists to prevent.
   *
   * Only `session start` accepts `--browser`; other subcommands reject it
   * outright. Injecting it unconditionally turns a valid call into a parse
   * error -- verified against bsk 0.4.1, where `session list --browser X` fails
   * with "unexpected argument '--browser' found".
   * @param args - the caller's argument vector.
   * @returns {string[]} the vector with the pinned browser applied where valid.
   */
  const withBrowser = args => {
    if (args[0] !== 'session' || args[1] !== 'start') return args
    const explicit = args.indexOf('--browser')
    if (explicit !== -1) { requireBrowser(args[explicit + 1]); return args }
    const inline = args.find(value => value.startsWith('--browser='))
    if (inline !== undefined) { requireBrowser(inline.slice('--browser='.length)); return args }
    return [args[0], args[1], '--browser', requireBrowser(browser), ...args.slice(2)]
  }

  ctx.effect(() => ctx.tools.register({
    name: 'bsk_session',
    description: 'Control the BrowserSkill session that drives the user\'s own logged-in Edge/Chromium browser. '
      + 'Actions: "start" opens a session (optionally --browser ID), "stop" ends it, "list" shows active sessions, '
      + '"browsers" lists connected browser instances. Returns bsk\'s JSON. '
      + 'Always stop the session when the task is done so borrowed tabs are returned.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'list', 'browsers'],
          description: 'Session lifecycle action.',
        },
        session: { type: 'string', description: 'Session id, required for "stop".' },
        browser: {
          type: 'string',
          description: 'Browser instance id or label for "start". '
            + 'Omit to use the id pinned in this plugin\'s config.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const { action } = args
      let argv
      if (action === 'browsers') argv = ['browsers', '--json']
      else if (action === 'list') argv = ['session', 'list', '--json']
      else if (action === 'start') {
        const chosen = requireBrowser(args.browser ?? browser)
        argv = ['session', 'start', '--json', '--browser', chosen]
      } else if (action === 'stop') {
        if (args.session === undefined || args.session === '') {
          throw new Error('bsk_session: action "stop" needs a `session` id (see action "list")')
        }
        argv = ['session', 'stop', args.session, '--json']
      } else {
        throw new Error(`bsk_session: unknown action ${JSON.stringify(action)}`)
      }
      return result(await run(binary, argv, timeoutMs, binaryArgs), maxChars)
    },
  }), 'dsh-bsk-bridge: bsk_session')

  ctx.effect(() => ctx.tools.register({
    name: 'bsk',
    description: 'Run one BrowserSkill (`bsk`) command against the user\'s real Edge/Chromium browser and return its JSON. '
      + 'Pass the argument vector WITHOUT the program name, e.g. '
      + '["navigate","https://example.com","--session","ID"] or ["observe","--session","ID"]. '
      + 'Typical flow: bsk_session start -> navigate -> cooperate sync -> observe -> click/fill using @eN refs '
      + 'with --context from sync. Read the browser-skill skill for the full command list, cooperation rules and '
      + 'settling guidance. Never use it to change the user\'s machine state (update/daemon/install-skill) without consent.',
    parameters: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Argument vector excluding the program name, e.g. ["observe","--session","qhul"].',
        },
        timeoutMs: { type: 'number', description: 'Optional wall-clock budget for this command.' },
      },
      required: ['args'],
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const argv = withBrowser(assertArgs(args.args))
      const budget = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : timeoutMs
      if (CONSENT_REQUIRED.has(argv[0]) && config?.allowStateChanging !== true) {
        throw new Error(
          `bsk: "${argv[0]}" changes this machine's BrowserSkill install or daemon. `
          + 'Ask the user first; an operator can opt in with allowStateChanging: true in the plugin config.',
        )
      }
      return result(await run(binary, argv, budget, binaryArgs), maxChars)
    },
  }), 'dsh-bsk-bridge: bsk')
}
