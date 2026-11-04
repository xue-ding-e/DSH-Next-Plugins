window.__ModuleLoader__.load({
  id: 'dsh-nav-buttons',
  factory() {
/**
 * Mouse side buttons for the Harness web app.
 *
 * One history, three kinds of movement. A "place" is `session|panel|tab`, so
 * switching session, switching the main panel and focusing a sidebar tab all
 * append to the same stack. X1 walks back, X2 walks forward — no new shortcuts
 * to learn, and the gesture works even while focus sits in the chat composer.
 *
 * The sidebar browser page is exempt: its `<webview>` shows a real web page and
 * keeps its own history, so a side press inside it must reach that guest.
 *
 * The history primitives live in `./history.js` for the Node test suite and are
 * pasted here verbatim: a client bundle is delivered as a classic script, so it
 * cannot carry an ESM `import`.
 */

/** Separator that keeps the three id spaces unambiguous in one key. */
const SEP = '\u0001'

/**
 * Version of the payload this page half sends.
 *
 * Bumped whenever the reported shape changes. `set_plugin` reloads the host half
 * but does NOT re-execute a page that is already loaded, so the two halves can
 * legitimately disagree about the payload — comparing this against the host's
 * expectation turns "the new field is mysteriously missing" into one glance.
 * Module scope (not inside `install`) so `apply` can report it even when
 * `install` throws before reaching the reporter.
 */
const PAYLOAD_SHAPE = 8

/**
 * Identity of this page half.
 *
 * Electron runs several renderers for one app, and each one that loads this
 * plugin runs its own page half against the same host route. Without an id the
 * host cannot tell them apart: they overwrite one slot, so the counters appear to
 * jump backwards and a back/forward step looks like it did nothing. A per-load id
 * lets the host report the freshest one instead of an arbitrary mixture.
 */
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** A bounded back/forward history of visited places. */
class NavHistory {
  #entries = []
  #index = -1
  #limit

  constructor(limit = 200) {
    if (!Number.isInteger(limit) || limit < 2) throw new Error('NavHistory needs a limit of at least 2')
    this.#limit = limit
  }

  get snapshot() {
    return {
      current: this.#index >= 0 ? this.#entries[this.#index] : undefined,
      canGoBack: this.#index > 0,
      canGoForward: this.#index >= 0 && this.#index < this.#entries.length - 1,
      size: this.#entries.length,
      // The entries themselves, oldest first. `size` alone cannot distinguish
      // "two different places" from "one place recorded twice", which is exactly
      // the question when a back step reports there is nowhere to go.
      //
      // KEEP IN SYNC with lib/history.js. This bundle is a classic script and
      // cannot import that module, so the class is duplicated here; a field added
      // to only one copy is invisible until something reads it. That happened:
      // `stack` read `snapshot.keys.map(...)` against a copy without `keys` and
      // install() threw "Cannot read properties of undefined (reading 'map')".
      keys: this.#entries.map(entry => entry.key),
    }
  }

  /**
   * Cursor position in the stack: -1 when empty, otherwise the index of the entry
   * currently shown. Also duplicated from lib/history.js — keep both copies equal.
   * @returns {number} the zero-based index, or -1 when there is no current entry.
   */
  get position() {
    return this.#index
  }

  visit(key) {
    if (key === '') return false
    if (this.#entries[this.#index]?.key === key) return false
    const existing = this.#entries.findIndex(entry => entry.key === key)
    if (existing >= 0) {
      // Revisiting an entry NEVER truncates. This stack holds sessions/panels/tabs
      // and jumping between them is the whole point; treating "went back to an
      // earlier entry" as a new branch deleted everything after it (measured:
      // `visit idx 8->3 size 9->4`), which is why forward worked only sometimes.
      // KEEP IN SYNC with lib/history.js.
      this.#index = existing
      return true
    }
    this.#entries = this.#entries.slice(0, this.#index + 1)
    this.#entries.push({ key })
    this.#index = this.#entries.length - 1
    if (this.#entries.length > this.#limit) {
      const excess = this.#entries.length - this.#limit
      this.#entries = this.#entries.slice(excess)
      this.#index -= excess
    }
    return true
  }

  back() {
    if (this.#index <= 0) return undefined
    this.#index -= 1
    return this.#entries[this.#index]
  }

  forward() {
    if (this.#index < 0 || this.#index >= this.#entries.length - 1) return undefined
    this.#index += 1
    return this.#entries[this.#index]
  }

  /**
   * Move the cursor back to a place already in the stack, without dropping later
   * entries. KEEP IN SYNC with lib/history.js — see the note on `snapshot`.
   * @param key - the place the caller ended up at, or undefined when nothing moved.
   * @returns true when the cursor was moved.
   */
  returnTo(key) {
    if (key === undefined) return false
    const at = this.#entries.findIndex(entry => entry.key === key)
    if (at < 0 || at === this.#index) return false
    this.#index = at
    return true
  }

  clear() {
    this.#entries = []
    this.#index = -1
  }
}

/**
 * Whether a keyboard event asks for a history step. KEEP IN SYNC with
 * lib/history.js — see the note on NavHistory.snapshot for why this is duplicated.
 * @param event - object with `key`, `altKey`, `ctrlKey`, `shiftKey`, `metaKey`.
 * @param mac - whether the platform uses the Meta/bracket bindings.
 * @returns 'back', 'forward', or undefined.
 */
function historyShortcut(event, mac) {
  if (event === null || typeof event !== 'object') return undefined
  const modifier = mac === true ? event.metaKey === true : event.altKey === true
  if (!modifier) return undefined
  if (event.ctrlKey === true || event.shiftKey === true) return undefined
  if (mac === true && event.metaKey === true && event.altKey === true) return undefined
  switch (event.key) {
    case 'ArrowLeft': return 'back'
    case 'ArrowRight': return 'forward'
    default: return mac === true && event.key === '[' ? 'back'
      : mac === true && event.key === ']' ? 'forward'
        : undefined
  }
}

/** @param button - `MouseEvent.button`. @returns 'back', 'forward', or undefined. */
function sideButton(button) {
  if (button === 3) return 'back'
  if (button === 4) return 'forward'
  return undefined
}

/** @param target - event target. @returns true when that surface owns its own history. */
function ownsOwnHistory(target) {
  if (typeof target !== 'object' || target === null) return false
  if (typeof target.tagName === 'string' && target.tagName.toLowerCase() === 'webview') return true
  if (typeof target.closest !== 'function') return false
  return target.closest('webview[data-sidebar-browser-frame]') !== null
}

/**
 * Compose the identity of one place.
 * @param sessionId - owning session, or undefined before one is open.
 * @param panel - main panel id, or null.
 * @param tabId - focused sidebar tab, or undefined.
 * @returns the history key.
 */
function placeKey(sessionId, panel, tabId) {
  return [sessionId ?? '', panel ?? '', tabId ?? ''].join(SEP)
}

/**
 * Split a history key back into its parts.
 * @param key - a key produced by {@link placeKey}.
 * @returns the three parts.
 */
function parseKey(key) {
  const [sessionId = '', panel = '', tabId = ''] = key.split(SEP)
  return {
    sessionId: sessionId === '' ? undefined : sessionId,
    panel: panel === '' ? null : panel,
    tabId: tabId === '' ? undefined : tabId,
  }
}

/**
 * Read the session occupying the MAIN view.
 *
 * `sidebarRight.mounted` only tracks what the right Sidebar is showing, so it
 * stays put while the user switches sessions in the main area — the exact
 * movement this feature exists for. The authoritative signal is retention: the
 * session some view holds under `mainView`. Reading the session list and taking
 * the one retained by the main view follows the same rule as the session
 * controller's own `publishMain`.
 * @param sessions - `ctx.sessions`.
 * @returns the main-view session id, or undefined when none is open.
 */
function mainSessionId(sessions) {
  const list = sessions?.list?.getSnapshot?.()
  const byId = list?.byId
  if (byId === undefined || byId === null) return undefined
  for (const candidate of Object.values(byId)) {
    if ((candidate?.retainedBy?.mainView ?? 0) > 0) return candidate.id
  }
  return undefined
}

/**
 * Read the place the window is showing right now.
 * @param ctx - client plugin context.
 * @returns the current key, or undefined when nothing is open yet.
 */
function currentPlace(ctx) {
  const sessions = ctx.get('sessions')
  const layout = ctx.get('layout')
  const sidebarRight = ctx.get('sidebarRight')
  // The main view is what X1/X2 must walk; the sidebar's own session is a
  // separate axis that would otherwise mask every main-view switch.
  const sessionId = mainSessionId(sessions)
  const panel = layout === undefined ? null : layoutPanel(layout)
  const tabId = sidebarRight === undefined ? undefined : focusedTab(ctx)
  if (sessionId === undefined && panel === null && tabId === undefined) return undefined
  return placeKey(sessionId, panel, tabId)
}

/**
 * Read the currently selected main panel.
 *
 * `ctx.layout` exposes the selection as `panelInfo` (a `HostObservable` whose
 * snapshot is `{ activePanelId }`), not as a plain `getSnapshot()` on the
 * service. Reading the wrong member silently yields "no panel", which would make
 * every place look identical apart from its session.
 * @param layout - `ctx.layout`.
 * @returns the panel id, or null when the Conversation is showing.
 */
function layoutPanel(layout) {
  const info = layout?.panelInfo?.getSnapshot?.()
  const selected = info?.activePanelId
  return typeof selected === 'string' ? selected : null
}

/**
 * Read the focused sidebar tab.
 *
 * `ctx.sidebarRight` exposes `active()` — "the active tab of the active pane" —
 * and that is the only public reader for the selection. The previous version
 * reached for `sidebarRight.state.getSnapshot()`, which does not exist on the
 * controller, so this returned undefined forever and the tab axis was silently
 * dead: switching sidebar tabs never produced a new place.
 * @param ctx - client plugin context.
 * @returns the tab id or undefined.
 */
function focusedTab(ctx) {
  const sidebarRight = ctx.get('sidebarRight')
  if (typeof sidebarRight?.active !== 'function') return undefined
  const tab = sidebarRight.active()
  // TabRecord carries `id`; guard the shape rather than trusting a duck type.
  return typeof tab?.id === 'string' && tab.id !== '' ? tab.id : undefined
}

/**
 * Read the three axis inputs separately.
 *
 * `currentPlace` joins them into one opaque key, which is exactly the wrong shape
 * for diagnosis: a key that never changes cannot say whether all three axes are
 * stuck or just the one being noticed. Reported alongside the key so a stuck axis
 * is identifiable instead of inferred.
 * @param ctx - client plugin context.
 * @returns the raw per-axis values.
 */
function placeParts(ctx) {
  const sessions = ctx.get('sessions')
  const layout = ctx.get('layout')
  const sessionId = mainSessionId(sessions)
  return {
    session: sessionId === undefined ? null : sessionId,
    panel: layout === undefined ? null : layoutPanel(layout),
    tab: focusedTab(ctx) ?? null,
    // How many sessions claim the main view right now. The contract calls
    // `retainedBy` "local ownership counts", so more than one is possible (a
    // preloading neighbour, a closing older one). `mainSessionId` returns the
    // first match, and if that count is ever >1 the chosen session may not be
    // the one on screen — invisible without this number.
    mainCandidates: mainViewCandidates(sessions).length,
    // How many sessions the catalog knows at all. The session axis reads
    // `sessions.list`, so a list that only holds the current session would make
    // switching invisible no matter how the selection is read.
    knownSessions: knownSessionCount(sessions),
  }
}

/**
 * Every session currently holding a positive main-view reference.
 * @param sessions - the sessions service, or undefined.
 * @returns the candidate ids, in catalog order.
 */
/**
 * How many sessions the catalog currently holds.
 * @param sessions - the sessions service, or undefined.
 * @returns the count, or 0 when the list is unavailable.
 */
function knownSessionCount(sessions) {
  const byId = sessions?.list?.getSnapshot?.()?.byId
  return byId === undefined || byId === null ? 0 : Object.keys(byId).length
}

function mainViewCandidates(sessions) {
  const byId = sessions?.list?.getSnapshot?.()?.byId
  if (byId === undefined || byId === null) return []
  return Object.values(byId)
    .filter(candidate => (candidate?.retainedBy?.mainView ?? 0) > 0)
    .map(candidate => candidate.id)
}

/**
 * Show one place, restoring as much of it as the services allow.
 *
 * Every step is best-effort. A history entry records where the user WAS; by the
 * time they walk back to it, that panel may have been unregistered or that tab
 * closed. `layout.selectPanel` throws on an unknown panel, and one throw here
 * would abort the rest of the restore and leave the user somewhere arbitrary — so
 * each axis is attempted independently and a dead one is skipped.
 * @param ctx - client plugin context.
 * @param key - the place to show.
 * @returns the axes that could not be restored, for the caller's diagnostics.
 */
function restorePlace(ctx, key) {
  const { sessionId, panel, tabId } = parseKey(key)
  const failed = []
  const uiWorkspace = ctx.get('uiWorkspace')
  const sessions = ctx.get('sessions')
  if (sessionId !== undefined && mainSessionId(sessions) !== sessionId) {
    // `openSession` is the same entry the workspace list uses, so it re-points the
    // main view without touching the right Sidebar's own session.
    try {
      if (uiWorkspace !== undefined) uiWorkspace.openSession(sessionId)
      else sessions?.open?.(sessionId)
    } catch { failed.push('session') }
  }
  const layout = ctx.get('layout')
  if (layout !== undefined && panel !== null) {
    // Throws when the panel is no longer registered; that must not stop the tab.
    try { layout.selectPanel(panel) } catch { failed.push('panel') }
  }
  if (tabId !== undefined) {
    try { ctx.get('sidebarRight')?.focus?.(tabId) } catch { failed.push('tab') }
  }
  return failed
}

/**
 * Install the side-button history.
 * @param ctx - client plugin context.
 */
function apply(ctx) {
  // A thrown client half is invisible from outside the page: the module simply
  // never activates and nothing reaches the Host. Report the failure instead of
  // only rethrowing, so the console and the Host status route both see it.
  try {
    install(ctx)
    // Proof of a successful INSTALL (not just of a loaded module). Without this,
    // "the module never ran" and "install threw and the error report also failed"
    // both leave the host with no report at all and look identical.
    report({ shape: PAYLOAD_SHAPE, instance: INSTANCE_ID, installed: true, loadedAt: Date.now() })
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    window.dshNavButtonsError = message
    report({ shape: PAYLOAD_SHAPE, instance: INSTANCE_ID, installed: false, loadedAt: Date.now(), error: message })
    throw error
  }
}

/**
 * Send this page half's counters to the Host's diagnostics route.
 * @param {object} payload - counters plus, on failure, the error message.
 */
function report(payload) {
  try {
    void fetch('/tool-nav-buttons/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Diagnostics must never break the feature.
  }
}

/**
 * Build the history and attach the listeners.
 * @param ctx - client plugin context.
 */
function install(ctx) {
  const history = new NavHistory(200)
  // While replaying a history step, the observation that echoes it must not be
  // recorded as a new visit: that would turn every back step into a fresh branch.
  // See `restoring` below — it is keyed on the place being restored rather than on
  // a time window, because a window also swallows whatever the user does meanwhile.
  let visits = 0
  let backs = 0
  let forwards = 0
  // Diagnostics. `recordCalls` proves record() runs; `lastKeys` shows what the
  // place resolved to. Without them, "visits stayed at 1" is ambiguous between
  // "nothing moved" and "record never ran". Kept apart from the sampler below so
  // a 750 ms tick does not drown the signal an operator is looking for.
  let recordCalls = 0
  let sampleCalls = 0
  let lastKeys = []
  // Which axes failed on the most recent step, so a desync is explainable.\r
  let lastRestoreError = null
  // Every non-primary mouse event seen, with the direction it mapped to.
  const buttonLog = []
  // Whether the desktop shell's navigation bridge was found. When it is absent the
  // plugin still works through DOM events, but only for buttons Chromium translates.
  let ipcAttached = false
  // Visits that dropped the forward branch, with the restore state at the time.
  const visitLog = []
  // Every cursor mutation from a visit, with before/after index and size.
  const stepTrace = []
  // Result of the most recent selftest command: whether the three restore axes\r
  // were callable against the live services. Null until one is asked for.\r
  let lastSelftest = null
  // Sessions the catalog knows, for the read-only peers command.
  let lastPeers = null
  // Proof the interaction listener is attached and firing. Without these two, a
  // zero sample count is ambiguous between "not installed" and "nobody clicked".
  let listenersInstalled = 0
  let lastEvent = null
  // Per-observable firing counts; see the subscription site.
  const fired = {}
  // The raw per-axis inputs behind the last key. A key that never changes can mean
  // "one axis is stuck" or "the axes are all stuck together"; only the parts say
  // which, and the joined key hides them.
  let lastParts = null

  // The place this plugin is currently restoring, or null while idle.
  //
  // While it is set, observations are ignored entirely — see the guard in
  // `record`. Comparing against the restored value alone was not enough: the
  // observers fire BEFORE the new selection commits, so they report the place
  // being left, which is not the value being restored and slipped through.
  let restoring = null
  // One restore timer at a time; a stale one must not clear a newer guard.
  let rearmRestore

  const record = (fromSample = false) => {
    if (fromSample) sampleCalls++
    else recordCalls++
    lastParts = placeParts(ctx)
    const key = currentPlace(ctx)
    lastKeys.push(key === undefined ? null : key.slice(0, 60))
    if (lastKeys.length > 8) lastKeys.shift()
    // While a restore is in flight, EVERY observation reports the place we are
    // leaving, not the one we are going to: `restorePlace` is asynchronous and the
    // observers fire before React commits the new selection. Recording that stale
    // place ran `visit(oldPlace)`, which sat earlier in the stack and truncated the
    // forward branch — the stack collapsed from four entries to one, and then even
    // back had nowhere to go.
    //
    // So ignore everything until the target itself is observed. That same
    // observation is the completion signal: it clears the guard.
    if (restoring !== null) {
      if (key !== undefined && key === restoring) restoring = null
      return
    }
    if (key !== undefined) {
      const before = history.snapshot.size
      const beforeIdx = history.position
      if (history.visit(key)) {
        visits++
        stepTrace.push(`visit idx ${beforeIdx}->${history.position} size ${before}->${history.snapshot.size}`)
        if (stepTrace.length > 12) stepTrace.shift()
        const after = history.snapshot.size
        // A visit that SHRINKS the stack means the forward branch was dropped. That
        // is correct when the user really moved somewhere new, and wrong when it is
        // a heartbeat re-reporting a place we just restored to. Log the shape so the
        // two cases are distinguishable instead of inferred.
        if (after < before) {
          visitLog.push(`shrink ${before}->${after} at=${key.slice(-5)} was=${(restoring ?? '').slice(-5)}`)
          if (visitLog.length > 10) visitLog.shift()
        }
      }
    }
  }

  const step = (direction) => {
    // Remember where the stack stood BEFORE stepping: `back()`/`forward()` move the
    // cursor and then hand back the entry, so a restore that cannot show that place
    // would leave the stack claiming a position the screen is not on. The next step
    // would then start from the wrong place.
    const previousKey = history.snapshot.current?.key
    const entry = direction === 'back' ? history.back() : history.forward()
    if (entry === undefined) return
    if (direction === 'back') backs++
    else forwards++
    // Cleared by the observer once it has seen this exact place, and unconditionally
    // after a short settle in case the restore never produces an observation (the
    // selection may already have been there). Without the timeout a restore that
    // changes nothing would suppress the NEXT unrelated visit forever.
    restoring = entry.key
    let failed
    try {
      failed = restorePlace(ctx, entry.key)
    } catch {
      failed = ['unknown']
    } finally {
      // The observer clears this the moment it sees the restored place. The timeout
      // is only a safety net for when no observation ever arrives (the selection may
      // already have been there). It used to be 250 ms, shorter than a React commit
      // plus an observable notification under load: the guard expired, a later
      // heartbeat observed the restored place as if it were a brand-new visit, and
      // `visit` truncated the forward branch — the stack collapsed from four entries
      // to one, after which forward had nowhere to go.
      // The guard is NOT released on a timer any more. A 2 s timer was still too
      // short under load, and when it expired a stale observation ran visit(oldKey),
      // which sat earlier in the stack and truncated it — measured: idx 8->3 with
      // size 9->4, idx 6->1 with size 7->2. Each truncation destroyed the forward
      // branch, which is why "forward" came and went between presses.
      //
      // Instead, wait for the target place to actually be observed, with a long
      // safety limit; and if the target never arrives, clear the guard WITHOUT
      // letting that observation rewrite the stack (see record()).
      clearTimeout(rearmRestore)
      rearmRestore = setTimeout(() => { restoring = null }, 15000)
    }
    // A total failure means the user is still where they were, so put the cursor
    // back or the stack silently diverges from the screen. A partial failure is
    // left alone: part of the place did change, and rewinding would fight it.
    if (failed !== undefined && failed.length === 3) {
      restoring = null
      // `returnTo` returns false when the entry it wants is no longer in the stack
      // (new visits can evict it while the restore is in flight). Undo the counter
      // only when the cursor really went back, so the counters keep describing what
      // actually happened rather than what was attempted.
      if (history.returnTo(previousKey)) {
        if (direction === 'back') backs--
        else forwards--
      }
      lastRestoreError = failed.join(',')
    } else if (failed !== undefined && failed.length > 0) {
      lastRestoreError = failed.join(',')
    }
  }

  /**
   * Alt+Left / Alt+Right as a keyboard equivalent of X1/X2.
   *
   * The package description promised this from the start and the code never had
   * it, so the shortcut silently did nothing. Alt+Arrow is the conventional
   * back/forward binding on Windows and Linux, while Cmd+[ / Cmd+] is the macOS
   * one; both are matched here because the same bundle ships everywhere.
   * @param event - KeyboardEvent.
   */
  const onKeyDown = (event) => {
    if (event.defaultPrevented) return
    if (ownsOwnHistory(event.target)) return
    const mac = typeof navigator === 'object' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')
    const direction = historyShortcut(event, mac)
    if (direction === undefined) return
    // Never steal the key from a text field, and never act twice for one press.
    const target = event.target
    if (typeof target === 'object' && target !== null) {
      const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (target.isContentEditable === true) return
    }
    event.preventDefault()
    event.stopPropagation()
    step(direction)
  }

  ctx.effect(() => {
    // `auxclick` is the modern "non-primary button released" event and fires for
    // buttons 3/4 in Chromium; `mouseup` covers older embeddings that suppress it.
    //
    // Only ONE of them may act per press. Both fire for the same physical click, so
    // listening to both ran `step()` twice: a single X1 jumped two places, and a
    // single X2 moved once and then found the stack already at its end — which
    // reads as "forward does nothing" while back appears to work. Whichever
    // arrives first wins; a short quiet period re-arms the pair.
    const target = window
    let handled = false
    let rearm
    /**
     * Announce and perform one history step.
     *
     * Shared by the IPC path and the DOM fallback so both are throttled by the same
     * guard: one physical press must never step twice.
     * @param direction - which way to move.
     * @param source - how the press arrived, for diagnostics.
     */
    const begin = (direction, source) => {
      if (handled) return
      handled = true
      clearTimeout(rearm)
      rearm = setTimeout(() => { handled = false }, 250)
      buttonLog.push(`${source}->${direction}`)
      if (buttonLog.length > 10) buttonLog.shift()
      step(direction)
    }
    const onPointerOnce = (event) => {
      const direction = sideButton(event.button)
      if (direction === undefined) return
      if (ownsOwnHistory(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      begin(direction, `${event.type}:${event.button}`)
    }
    // The desktop shell forwards App Commands here. On Windows and Linux the OS
    // delivers side buttons to the WINDOW, never to the page, so this is the only
    // path that sees every press; the DOM listeners below remain for embedders
    // (and browser builds) that do produce `auxclick`.
    const bridge = typeof globalThis === 'object' && globalThis !== null
      ? globalThis.dshDesktop
      : undefined
    const navigation = bridge?.protocolVersion === 1 ? bridge.navigation : undefined
    ipcAttached = typeof navigation?.subscribe === 'function'
    const unsubscribe = ipcAttached
      ? navigation.subscribe(command => { begin(command, 'ipc') })
      : undefined
    target.addEventListener('auxclick', onPointerOnce, true)
    target.addEventListener('mouseup', onPointerOnce, true)
    target.addEventListener('keydown', onKeyDown, true)
    // Chromium maps X1/X2 to browser back/forward on some platforms; suppress it
    // so the app decides instead of the embedder navigating away.
    const suppress = (event) => {
      if (sideButton(event.button) !== undefined && !ownsOwnHistory(event.target)) event.preventDefault()
    }
    target.addEventListener('mousedown', suppress, true)
    return () => {
      clearTimeout(rearm)
      unsubscribe?.()
      target.removeEventListener('auxclick', onPointerOnce, true)
      target.removeEventListener('mouseup', onPointerOnce, true)
      target.removeEventListener('keydown', onKeyDown, true)
      target.removeEventListener('mousedown', suppress, true)
    }
  }, 'dsh-nav-buttons: pointer')

  // Record on every settled selection change rather than polling. Two sources,
  // each the one that actually moves for its axis: `sessions.list` for a session
  // switch and `layout.panelInfo` for a main-panel switch.
  //
  // `sidebarRight.mounted` is NOT a tab source, despite its name: its contract is
  // explicitly "moves only when the on-screen Session changes; the Session's own
  // store commits are silent". Subscribing to it caught sidebar *session* changes
  // and never a tab switch, so the tab axis would still have missed every click.
  // The interface exposes no observable for the active tab, so that axis is
  // sampled below instead.
  ctx.effect(() => {
    record()
    const disposers = []
    // Counted per source: one total cannot say which observable is churning, and a
    // source that fires hundreds of times while the place never changes is the
    // difference between "quiet window" and "a subscription is looping".
    const sources = [
      ['list', ctx.get('sessions')?.list],
      ['panel', ctx.get('layout')?.panelInfo],
      ['mounted', ctx.get('sidebarRight')?.mounted],
    ]
    for (const [name, observable] of sources) {
      if (typeof observable?.subscribe !== 'function') continue
      disposers.push(observable.subscribe(() => {
        fired[name] = (fired[name] ?? 0) + 1
        record()
      }))
    }
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-nav-buttons: record')

  // The active tab has no observable on the public sidebar face, so a tab switch
  // emits no event we can subscribe to. Record on the interactions that can cause
  // one instead: a tab switch IS a click, and a keyboard-driven one arrives right
  // after a key on the focused tab strip.
  //
  // A timer was tried first and is not enough: Chromium throttles background-tab
  // timers, and this document is usually backgrounded. Measured 1 tick in 10 s
  // against a 750 ms interval, so the tab axis would still have missed most
  // switches. Pointer events are not throttled.
  ctx.effect(() => {
    // Deferred one macrotask: the click that switches the tab is still travelling
    // through React when the pointer handler runs, so reading the place
    // synchronously would see the old one. `record()` ignores repeats anyway.
    const onPointer = (event) => {
      // Recorded so "the listener never ran" is distinguishable from "it ran and
      // found nothing new" — the counters alone cannot tell those apart.
      lastEvent = event.type
      setTimeout(() => record(true), 0)
    }
    const events = ['pointerdown', 'mouseup', 'keydown', 'focusin']
    for (const event of events) window.addEventListener(event, onPointer, true)
    listenersInstalled = events.length
    return () => {
      for (const event of events) window.removeEventListener(event, onPointer, true)
      listenersInstalled = 0
    }
  }, 'dsh-nav-buttons: sample on interaction')

  // A diagnostic handle for the operating console (`window.dshNavButtons`): the
  // service face is reachable only to other plugins, and the first thing an
  // operator wants is "did the half load, and what does the stack hold".
  const face = {
    back: () => step('back'),
    forward: () => step('forward'),
    get snapshot() { return history.snapshot },
  }
  window.dshNavButtons = face
  window.dshNavButtonsLoaded = true

  ctx.provide('navButtons', face)

  // Prove to the Host that this half actually ran: without this, a module that
  // never activates is indistinguishable from one that works but was not used.
  // `sources` names which observables the plugin could reach, so a dead axis is
  // visible as a missing name rather than as a feature that silently does nothing.
  const sources = {
    session: typeof ctx.get('sessions')?.list?.subscribe === 'function',
    panel: typeof ctx.get('layout')?.panelInfo?.subscribe === 'function',
    // The tab axis needs BOTH: `active()` to read the selection and `mounted`
    // to hear it change. Checking only `mounted` (as this did) reported the axis
    // healthy while `focusedTab()` was reading a member that does not exist.
    tab: typeof ctx.get('sidebarRight')?.active === 'function'
      && typeof ctx.get('sidebarRight')?.mounted?.subscribe === 'function',
    workspace: typeof ctx.get('uiWorkspace')?.openSession === 'function',
  }
  // Captured once: this is when the page half activated. Reporting `Date.now()`
  // on every event made the Host believe the page had just loaded whenever the
  // mouse moved, which hid genuinely stale pages.
  const activatedAt = Date.now()
  // Bumped whenever the reported shape changes. `set_plugin` reloads the host half
  // but does NOT re-execute a page that is already loaded, so the two halves can
  // legitimately disagree about the payload. Comparing this against the host's
  // expectation turns "the new field is mysteriously missing" into one glance.
  const live = () => {
    const snapshot = history.snapshot
    // Only the instance that actually owns the on-screen session reports.
    //
    // Electron runs a renderer per window/webview, and every one that loads this
    // bundle runs a complete page half with its own history stack. When all of
    // them reported, `status` answered with whichever landed last: counters ran
    // backwards and a back/forward step appeared to do nothing because the reply
    // came from an instance whose stack was empty. The others still work — they
    // just do not speak for the window.
    const owns = placeParts(ctx).mainCandidates > 0
    if (!owns) return
    report({
      shape: PAYLOAD_SHAPE,
      instance: INSTANCE_ID,
      loadedAt: activatedAt,
      visits, backs, forwards,
      entries: snapshot.size,
      // The true cursor position, not a placeholder: `canGoBack`/`canGoForward`
      // and any future UI depend on where the stack actually stands.
      index: history.position,
      sources,
      // How often the observers fired and what they saw. A stuck `recordCalls`
      // means the subscriptions are dead; a growing one with an unchanging `key`
      // means the place simply is not moving.
      recordCalls,
      sampleCalls,
      listenersInstalled,
      lastEvent,
      lastRestoreError,
      buttonLog,
      ipcAttached,
      visitLog,
      stepTrace,
      lastSelftest,
      lastPeers,
      fired,
      lastParts,
      // The stack itself, not the observation log. `entries: 2, index: 0` cannot
      // say whether that is two distinct places or one place recorded twice, and
      // only the contents answer whether a back/forward step has anywhere to go.
      stack: snapshot.keys.map(key => key.slice(0, 60)),
      lastKeys,
      current: snapshot.current === undefined ? null : snapshot.current.key,
    })
  }
  live()
  // Re-report on activity so the Host sees progress.
  for (const event of ['auxclick', 'mouseup']) window.addEventListener(event, live, true)

  // One timer, two jobs: report the current state, and drain the diagnostics
  // command mailbox that lets the navigation path be exercised without
  // synthesizing real mouse or keyboard input.
  //
  // These were two timers and both were unreliable, for the reason a 750 ms
  // sampler was abandoned earlier: Chromium throttles timers in a backgrounded
  // document, and this one is backgrounded whenever the operator is reading the
  // terminal instead of the app. Measured a 1 s drain being consumed only every
  // 16–24 s. One timer halves the loss and keeps the code honest about it; while
  // the window is actually in front, these run at full rate.
  //
  // Chained rather than overlapped: a fetch that outlives its interval must not
  // start stacking requests.
  ctx.effect(() => {
    let stopped = false
    let timer
    const tick = async () => {
      try {
        const response = await fetch('/tool-nav-buttons/command', { cache: 'no-store' })
        if (response.ok && !stopped) {
          const body = await response.json()
          if (typeof body?.command === 'string') {
            if (body.command === 'back') step('back')
            else if (body.command === 'forward') step('forward')
            // Forces one observation and reports it, so the sampling path can be
            // verified without synthesizing a mouse or keyboard event.
            else if (body.command === 'probe') record(true)
            // Restores the CURRENT place, which is idempotent, but exercises all
            // three restore branches against the live services. Without it the
            // session/panel/tab calls only ever run when a history step happens,
            // so their wiring is unverified until the day a user presses X1.
            else if (body.command === 'selftest') {
              const here = currentPlace(ctx)
              lastSelftest = here === undefined
                ? { skipped: 'no place' }
                : { key: here.slice(0, 60), failed: restorePlace(ctx, here) }
            }
            // Switch the main view to a named session, then report. This exists so
            // the session axis can be exercised end-to-end without synthesizing a
            // mouse click; the operator passes an id from `peers`.
            else if (body.command === 'switch' && typeof body.target === 'string') {
              lastSelftest = { target: body.target, failed: restorePlace(ctx, `${body.target}${SEP}${SEP}`) }
              setTimeout(() => record(true), 300)
            }
            // Read-only: list the sessions the catalog knows, so an operator can
            // see what the session axis could switch between. It changes nothing.
            else if (body.command === 'peers') {
              const byId = ctx.get('sessions')?.list?.getSnapshot?.()?.byId
              lastPeers = byId === undefined || byId === null
                ? []
                : Object.values(byId).slice(0, 12).map(candidate => ({
                  id: candidate.id,
                  main: (candidate.retainedBy?.mainView ?? 0) > 0,
                }))
            }
          }
        }
      } catch {
        // The route is absent in a profile without the host half; harmless.
      }
      if (stopped) return
      // Sample the place here as well as in the observers. The subscriptions fire
      // for session/panel/mounted changes, but Electron throttles timers only in
      // BACKGROUND documents — this app is usually foreground, so a 2 s tick is
      // reliable, while an observer can go quiet for minutes (measured:
      // recordCalls frozen at 60 for a whole minute while the window was idle).
      // Without this, a position change during a quiet spell was never recorded and
      // the stack stayed at one entry, which reads as "back does nothing".
      record(true)
      live()
      timer = setTimeout(tick, 2000)
    }
    void tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, 'dsh-nav-buttons: heartbeat and command drain')
}

// Every service `apply` reads through `ctx.get()` must be declared here: Cordis
// resolves only declared properties, and an undeclared `ctx.get('x')` is
// `undefined` with no error. This previously declared `sidebarRight` alone while
// the code also read `sessions`, `layout` and `uiWorkspace`, so `currentPlace()`
// returned undefined forever and the whole history stayed empty.
return { inject: ['sessions', 'layout', 'sidebarRight', 'uiWorkspace'], apply }
  },
})
