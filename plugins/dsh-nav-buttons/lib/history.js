/**
 * Pure back/forward history for one window.
 *
 * The stack stores *where the user was*, not what kind of thing it was: a
 * session switch, a panel switch and a sidebar tab switch are all one entry.
 * That is what makes X1/X2 feel like a browser instead of three separate
 * features that each need their own shortcut.
 *
 * Serialization and pushing are trivial; the interesting part is that visiting
 * a place which already sits earlier in the stack must not grow the stack
 * forever — it truncates the forward branch, exactly like a browser.
 */

/**
 * One visited place. `key` is a stable identity the caller can reconstruct.
 * @typedef {{ readonly key: string }} NavEntry
 */

/**
 * The state a caller needs to render or act on.
 * @typedef {object} NavHistorySnapshot
 * @property {NavEntry | undefined} current Where the user is now, or undefined before the first entry.
 * @property {boolean} canGoBack Whether a back step exists.
 * @property {boolean} canGoForward Whether a forward step exists.
 * @property {number} size Bounded entry count, for diagnostics.
 */

/**
 * A bounded back/forward history of visited places.
 *
 * Entries are identified by `key`; pushing the key that is already current is a
 * no-op, so a re-render or a duplicate event cannot corrupt the stack. Pushing a
 * key that exists earlier in the stack moves to it and drops the forward branch.
 */
export class NavHistory {
  #entries = []
  #index = -1
  #limit

  /** @param limit - maximum retained entries; oldest are dropped first. */
  constructor(limit = 200) {
    if (!Number.isInteger(limit) || limit < 2) throw new Error('NavHistory needs a limit of at least 2')
    this.#limit = limit
  }

  /** @returns the immutable current view. */
  get snapshot() {
    return {
      current: this.#index >= 0 ? this.#entries[this.#index] : undefined,
      canGoBack: this.#index > 0,
      canGoForward: this.#index >= 0 && this.#index < this.#entries.length - 1,
      size: this.#entries.length,
      // The entries themselves, oldest first. `size` alone cannot distinguish
      // "two different places" from "one place recorded twice", which is exactly
      // the question when a back step reports there is nowhere to go.
      keys: this.#entries.map(entry => entry.key),
    }
  }

  /**
   * Cursor position in the stack: -1 when empty, otherwise the index of the entry
   * currently shown. Exposed because `canGoBack`/`canGoForward` are derived from
   * it, and a caller reporting history state needs the number rather than a guess.
   * @returns {number} the zero-based index, or -1 when there is no current entry.
   */
  get position() {
    return this.#index
  }

  /**
   * Record a visit.
   *
   * The forward branch is dropped only when the user moves to a place that is NOT
   * already ahead of the cursor. Moving forward onto an entry that is already
   * there is navigation along the existing history, not a new branch — truncating
   * it would delete the very entries a later "forward" step needs. That bug showed
   * up in practice: a heartbeat observed a place that sat earlier in the stack,
   * `visit` jumped the cursor back and cut everything after it, and the stack
   * collapsed from four entries to one, so forward then had nowhere to go.
   * @param key - stable identity of the place now shown.
   * @returns true when the history changed.
   */
  visit(key) {
    if (key === '') return false
    if (this.#entries[this.#index]?.key === key) return false
    const existing = this.#entries.findIndex(entry => entry.key === key)
    if (existing >= 0) {
      // Moving to a place that is ALREADY in the stack never truncates.
      //
      // The stack holds sessions/panels/tabs, and jumping between them is exactly
      // what this feature is for. Treating "went back to an earlier entry" as a
      // new branch deleted the entries after it — measured as `visit idx 8->3
      // size 9->4` — so the forward branch vanished mid-session and forward
      // appeared to work only sometimes. Only a genuinely NEW place truncates.
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

  /**
   * Step one entry toward the past.
   * @returns the entry to show, or undefined at the start.
   */
  back() {
    if (this.#index <= 0) return undefined
    this.#index -= 1
    return this.#entries[this.#index]
  }

  /**
   * Step one entry toward the future.
   * @returns the entry to show, or undefined at the end.
   */
  forward() {
    if (this.#index < 0 || this.#index >= this.#entries.length - 1) return undefined
    this.#index += 1
    return this.#entries[this.#index]
  }

  /**
   * Move the cursor back to a place already in the stack, without dropping later
   * entries.
   *
   * `back()`/`forward()` move the cursor and then return the entry, so a caller
   * that fails to actually show that place has already desynced the stack: it now
   * claims to be somewhere the screen is not, and the next step starts from the
   * wrong place. This undoes exactly that.
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

  /** Forget every entry, e.g. when the window's workspace context is replaced. */
  clear() {
    this.#entries = []
    this.#index = -1
  }
}

/**
 * Whether a keyboard event asks for a history step, independent of any DOM.
 *
 * Alt+Arrow is the Windows/Linux back/forward binding; on macOS the same two
 * directions are Cmd+[ and Cmd+]. The package promised Alt+Arrow from the start
 * and the code never implemented it, so the shortcut silently did nothing —
 * keeping the decision pure makes that promise testable.
 * @param event - object with `key`, `altKey`, `ctrlKey`, `shiftKey`, `metaKey`.
 * @param mac - whether the platform uses the Meta/bracket bindings.
 * @returns 'back', 'forward', or undefined.
 */
export function historyShortcut(event, mac) {
  if (event === null || typeof event !== 'object') return undefined
  const modifier = mac === true ? event.metaKey === true : event.altKey === true
  if (!modifier) return undefined
  // Alt+Ctrl and Alt+Shift are other applications' shortcuts; leave them alone.
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

/**
 * Whether a DOM `MouseEvent.button` names a browser back/forward side button.
 *
 * Chromium reports the two thumb buttons as `3` (back) and `4` (forward) on every
 * platform; `auxclick` and `mousedown`/`mouseup` all carry them. `button`
 * `0/1/2` stay untouched so normal clicks are never swallowed.
 * @param button - `MouseEvent.button`.
 * @returns 'back', 'forward', or undefined for an ordinary button.
 */
export function sideButton(button) {
  if (button === 3) return 'back'
  if (button === 4) return 'forward'
  return undefined
}

/**
 * Whether an element belongs to a surface that owns its own history.
 *
 * Side-button presses inside the sidebar browser's `<webview>` must reach that
 * guest, which is showing a real web page: hijacking them would break in-page
 * back/forward. The sidebar terminal and the chat composer likewise keep their
 * own expected behaviour.
 * @param target - the event target.
 * @returns true when the app should leave the event alone.
 */
export function ownsOwnHistory(target) {
  if (typeof target !== 'object' || target === null) return false
  const element = target
  if (typeof element.tagName === 'string' && element.tagName.toLowerCase() === 'webview') return true
  if (typeof element.closest !== 'function') return false
  return element.closest('webview[data-sidebar-browser-frame]') !== null
}
