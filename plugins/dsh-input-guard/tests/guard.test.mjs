/**
 * Input guard: the consent state machine and the banner bundle's shape.
 *
 * The point of these tests is that authority is *withholdable*: a driver that
 * never asked, asked then stopped, or let its lease lapse must not be told it may
 * synthesize input. That is the whole guarantee this plugin makes.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** A minimal route fixture mirroring the host half's registration. */
function hostFixture() {
  const routes = new Map()
  const webServer = { register(route) { routes.set(route.path, route); return () => {} } }
  const ctx = {
    // The host half declares `inject: ['webServer']`, so Cordis resolves the
    // property on the context itself; the fixture must mirror that.
    webServer,
    effect(install) { install(); return () => {} },
    logger: { warn() {} },
  }
  return { ctx, routes }
}

/** One request against the route. */
function call(route, method, endpoint, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: `/tool-input-guard/${endpoint}`,
    on(event, handler) {
      if (event === 'data') for (const chunk of payload) handler(chunk)
      if (event === 'end') handler()
    },
  }
  return new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(code) { this.status = code; return this },
      end(text) { resolve({ status: this.status, body: text === undefined ? undefined : JSON.parse(text) }) },
    }
    route.handler(req, res)
  })
}

/** Load a fresh host half, since the lease lives in module scope. */
async function freshHost() {
  const mod = await import(`../lib/index.js?fresh=${Math.random()}`)
  const { ctx, routes } = hostFixture()
  mod.apply(ctx)
  return routes.get('/tool-input-guard')
}

test('the shipped client registers through the classic-script module loader', () => {
  const modules = []
  new Script(clientSource, { filename: 'dsh-input-guard/client.js' }).runInNewContext({
    window: { __ModuleLoader__: { load(module) { modules.push(module) } } },
  })
  assert.equal(modules.length, 1)
  assert.equal(modules[0].id, 'dsh-input-guard')
  // The factory must accept the loader-supplied require, or React is unreachable.
  assert.equal(modules[0].factory.length, 1)
  const plugin = modules[0].factory(() => ({}))
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(Array.from(plugin.inject), ['slots'])
})

test('the client bundle is a classic script with no ESM syntax', () => {
  assert.ok(clientSource.trimStart().startsWith('window.__ModuleLoader__.load({'))
  assert.equal(/^\s*(export\s|import\s)/m.test(clientSource), false)
})

test('nothing is authorized before a request', async () => {
  const route = await freshHost()
  const state = await call(route, 'GET', 'state')
  assert.equal(state.status, 200)
  assert.deepEqual({ ...state.body }, { active: false, revoked: false })
})

test('a request grants authority and reports its purpose', async () => {
  const route = await freshHost()
  const granted = await call(route, 'POST', 'request', { purpose: 'Clicking the console' })
  assert.equal(granted.status, 200)
  assert.equal(granted.body.granted, true)
  assert.equal(granted.body.active, true)
  assert.equal(granted.body.purpose, 'Clicking the console')

  const state = await call(route, 'GET', 'state')
  assert.equal(state.body.active, true)
})

test('Stop revokes authority and it stays revoked', async () => {
  const route = await freshHost()
  await call(route, 'POST', 'request', { purpose: 'Driving' })
  const stopped = await call(route, 'POST', 'stop')
  assert.equal(stopped.body.stopped, true)
  assert.equal(stopped.body.active, false)
  assert.equal(stopped.body.revoked, true)

  // A heartbeat after Stop must not silently restore permission.
  const beat = await call(route, 'POST', 'beat')
  assert.equal(beat.body.granted, false)
  assert.equal(beat.body.active, false)
})

test('a heartbeat keeps a live lease alive and counts itself', async () => {
  const route = await freshHost()
  await call(route, 'POST', 'request', { purpose: 'Driving' })
  const beat = await call(route, 'POST', 'beat')
  assert.equal(beat.body.granted, true)
  assert.equal(beat.body.beats, 1)
})

test('releasing clears the lease so a later state reads idle', async () => {
  const route = await freshHost()
  await call(route, 'POST', 'request', { purpose: 'Driving' })
  const released = await call(route, 'POST', 'release')
  assert.deepEqual({ ...released.body }, { active: false, revoked: false })
  const state = await call(route, 'GET', 'state')
  assert.deepEqual({ ...state.body }, { active: false, revoked: false })
})

test('an expired lease reads as revoked rather than active', async () => {
  const route = await freshHost()
  await call(route, 'POST', 'request', { purpose: 'Driving' })
  // The lease TTL is short by design; waiting it out is the honest check that a
  // driver which stops heartbeating loses authority instead of holding it.
  await new Promise(resolve => setTimeout(resolve, 15_500))
  const state = await call(route, 'GET', 'state')
  assert.equal(state.body.active, false)
  assert.equal(state.body.revoked, true)
}, { timeout: 30_000 })

test('an unknown endpoint is a 404', async () => {
  const route = await freshHost()
  assert.equal((await call(route, 'GET', 'nope')).status, 404)
})

test('the banner receives its source through the hooks compartment', () => {
  // The slot framework renames `hooks: { authority }` into the `useAuthority`
  // selector prop (PropsHooks maps N to `use${Capitalize<N>}`). Handing the
  // observable across as a bare `useAuthority` member would reach the component
  // as an observable rather than a selector hook, and the banner would never
  // render. Pin the shape so that mistake cannot come back.
  assert.ok(clientSource.includes('hooks: { authority }'), 'source travels in `hooks`')
  assert.ok(clientSource.includes('function InputGuardBanner({ useAuthority, dismiss })'),
    'component reads the synthesized `useAuthority` prop')
  assert.equal(clientSource.includes('useAuthority: authority'), false,
    'the observable must not be passed outside the hooks compartment')
})

test('the observable handed to the framework satisfies HostObservable', () => {
  // HostObservable requires getSnapshot + subscribe; a plain object would type
  // out silently at runtime and the selector would throw on first render.
  assert.ok(clientSource.includes('getSnapshot: () => value'), 'getSnapshot present')
  assert.ok(clientSource.includes('subscribe(listener)'), 'subscribe present')
})

test('the banner renders null, active, and stopped states from its observable', () => {
  // Executes the real bundle against a fake loader and a fake React, then drives
  // the observable through the same three states the host route produces. This is
  // the only place the *rendered* shape is checked, so a regression in the slot
  // contract or the component would fail here instead of in the page.
  const modules = []
  const fakeWindow = { __ModuleLoader__: { load(module) { modules.push(module) } } }
  const createElement = (tag, props, ...children) => ({ tag, props, children })
  const fakeReact = {
    createElement,
    useState: value => [value, () => {}],
    useEffect: () => {},
  }
  // eslint-disable-next-line no-new-func -- the bundle is a classic script
  new Function('window', 'console', clientSource)(fakeWindow, console)
  const plugin = modules[0].factory(spec => {
    if (spec === 'react') return fakeReact
    throw new Error(`unexpected require ${spec}`)
  })

  let registration
  // `apply` starts a poll interval inside `ctx.effect`; its disposer must run or
  // the test process never exits.
  const disposers = []
  const ctx = {
    effect(install) { const dispose = install(); disposers.push(() => dispose?.()); return dispose ?? (() => {}) },
    slots: {
      inject(_name, factory) { factory() },
      register(options, component) { registration = { options, component }; return () => {} },
    },
  }
  plugin.apply(ctx)
  try {

  assert.equal(registration.options.name, 'shell.overlay')
  assert.equal(registration.options.id, 'input-guard.banner')

  const face = registration.options.inject()
  assert.deepEqual(Object.keys(face.hooks), ['authority'])
  const render = () => registration.component({
    useAuthority: select => select(face.hooks.authority.getSnapshot()),
    dismiss: () => {},
  })

  // Idle: nothing occupies the screen.
  assert.equal(render(), null)

  // Active: a readable purpose, a running clock, and a stop control.
  face.hooks.authority.set({
    active: true, revoked: false, purpose: "Script 'x' is using your keyboard",
    ageMs: 125_000, beats: 3,
  })
  const active = render()
  assert.notEqual(active, null)
  assert.equal(active.props['data-input-guard'], 'active')
  assert.equal(active.props.role, 'status')
  assert.equal(active.props['aria-live'], 'polite')
  const activeText = JSON.stringify(active)
  assert.ok(activeText.includes('keyboard'), 'the stated purpose is shown')
  assert.ok(activeText.includes('Stop'), 'the stop control is offered')
  assert.ok(activeText.includes('2:05'), 'elapsed time is shown')

  // Stopped: says so, and only offers a dismissal.
  face.hooks.authority.set({ active: false, revoked: true, purpose: 'x', ageMs: 0, beats: 4 })
  const stopped = render()
  assert.equal(stopped.props['data-input-guard'], 'stopped')
  const stoppedText = JSON.stringify(stopped)
  assert.ok(stoppedText.includes('Stopped'))
  assert.ok(stoppedText.includes('Dismiss'))
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
})
