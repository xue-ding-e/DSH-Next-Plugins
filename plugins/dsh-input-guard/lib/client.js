window.__ModuleLoader__.load({
  id: 'dsh-input-guard',
  // `require` is supplied by the loader's module table; React must come from
  // there rather than a second copy, and the factory must accept the parameter.
  factory(require) {
/**
 * Input guard banner: the visible, stoppable surface for synthesized input.
 *
 * An agent driving the real mouse and keyboard takes the machine away from the
 * person using it. ChatGPT/Codex make that visible and revocable; this banner is
 * that surface for the Harness. It sits in `shell.overlay`, which is above every
 * column and outside their scroll containers, so it cannot be missed while input
 * is being synthesized.
 *
 * Data flow follows the slot contract: the registration's `inject` face returns
 * an ObservableSnapshot, and the component reads it through the framework's
 * `use<HookName>` selector. The page polls the host's consent route and writes
 * that snapshot; the component never fetches during render.
 */

/** How often the page refreshes its view of the lease. */
const POLL_MS = 1000

/** The shape rendered by the banner. */
const IDLE = { active: false, revoked: false }

/**
 * Read the consent state from the host half.
 * @returns {Promise<object>} the state, or IDLE when the route is absent.
 */
async function readAuthority() {
  try {
    const response = await fetch('/tool-input-guard/state', { cache: 'no-store' })
    if (!response.ok) return IDLE
    const body = await response.json()
    return body !== null && typeof body === 'object' ? body : IDLE
  } catch {
    return IDLE
  }
}

/**
 * Ask the host to revoke the lease.
 * @returns {Promise<void>}
 */
async function stopDriving() {
  try {
    await fetch('/tool-input-guard/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  } catch {
    // The lease also expires on its own; the banner clears on the next poll.
  }
}

/**
 * Format an elapsed duration as m:ss.
 * @param {number} ms - elapsed milliseconds.
 * @returns {string} the label.
 */
function elapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Build one small observable snapshot. The store lives in this factory closure,
 * so it is created once per plugin activation and shared by every render.
 * @param {object} initial - the first value.
 * @returns {{getSnapshot: () => object, subscribe: (fn: () => void) => () => void, set: (value: object) => void}}
 */
function createSnapshot(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (next === value) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * The banner component.
 *
 * Written with `React.createElement` because a client bundle is a classic script
 * and no JSX transform runs over it. Props arrive from the slot framework: the
 * `useAuthority` selector hook from `inject`, plus `dismiss` for the stopped state.
 * @param {object} props - framework-bound props.
 */
function InputGuardBanner({ useAuthority, dismiss }) {
  const React = require('react')
  const authority = useAuthority(value => value)
  const [dismissed, setDismissed] = React.useState(false)

  const active = authority?.active === true
  const revoked = authority?.revoked === true
  if (!active && !revoked) return null
  if (!active && dismissed) return null

  const label = active
    ? (authority.purpose ?? 'Agent is using your mouse and keyboard')
    : 'Stopped — the agent no longer has input control'

  const buttonLabel = active ? 'Stop' : 'Dismiss'
  const onClick = active
    ? () => { void stopDriving() }
    : () => { setDismissed(true); dismiss?.() }

  return React.createElement('div', {
    role: 'status',
    'aria-live': 'polite',
    'data-input-guard': active ? 'active' : 'stopped',
    style: {
      position: 'fixed',
      zIndex: 2147483000,
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      maxWidth: 'min(720px, calc(100vw - 32px))',
      padding: '8px 12px',
      borderRadius: '10px',
      // Amber means "attention", green means "handed back"; the border carries
      // the signal so the banner still reads in either theme.
      background: active ? 'rgba(255, 176, 32, 0.16)' : 'rgba(64, 200, 120, 0.16)',
      border: `1px solid ${active ? 'rgba(255, 176, 32, 0.6)' : 'rgba(64, 200, 120, 0.6)'}`,
      fontSize: '13px',
      lineHeight: '18px',
      boxShadow: '0 6px 24px rgba(0, 0, 0, 0.3)',
    },
  },
  React.createElement('span', {
    'aria-hidden': 'true',
    style: {
      width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto',
      background: active ? 'rgb(255, 176, 32)' : 'rgb(64, 200, 120)',
    },
  }),
  React.createElement('span', { style: { flex: '1 1 auto', minWidth: 0 } }, label),
  active
    ? React.createElement('span', {
      style: { opacity: 0.7, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' },
    }, elapsed(authority.ageMs ?? 0))
    : null,
  React.createElement('button', {
    type: 'button',
    onClick,
    style: {
      flex: '0 0 auto', padding: '4px 12px', borderRadius: '6px', cursor: 'pointer',
      border: `1px solid ${active ? 'rgba(255, 176, 32, 0.85)' : 'rgba(64, 200, 120, 0.85)'}`,
      background: 'transparent', color: 'inherit', fontSize: '12px', fontWeight: 600,
    },
  }, buttonLabel))
}

/**
 * Install the banner and the poll loop behind it.
 * @param {object} ctx - client plugin context.
 */
function apply(ctx) {
  const authority = createSnapshot(IDLE)

  ctx.effect(() => {
    let stopped = false
    const tick = async () => {
      const next = await readAuthority()
      if (!stopped) authority.set(next)
    }
    void tick()
    const timer = setInterval(tick, POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
  }, 'dsh-input-guard: authority poll')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'input-guard.banner',
    order: 1000,
    // `hooks` is the framework's observable compartment: each entry arrives as a
    // `use<Name>` selector prop, so `hooks: { authority }` reaches the component
    // as `useAuthority`. Plain members such as `dismiss` pass through unchanged.
    inject: () => ({
      hooks: { authority },
      dismiss: () => { authority.set(IDLE) },
    }),
  }, InputGuardBanner))
}

return { inject: ['slots'], apply }
  },
})
