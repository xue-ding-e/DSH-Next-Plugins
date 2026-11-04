/**
 * Side-button navigation: one back/forward history over sessions, panels and tabs.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { NavHistory, ownsOwnHistory, sideButton } from '../lib/history.js'

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('the shipped client registers through the classic-script module loader', () => {
  const modules = []
  new Script(clientSource, { filename: 'dsh-nav-buttons/client.js' }).runInNewContext({
    window: { __ModuleLoader__: { load(module) { modules.push(module) } } },
  })
  assert.equal(modules.length, 1)
  assert.equal(modules[0].id, 'dsh-nav-buttons')
  const plugin = modules[0].factory()
  assert.equal(typeof plugin.apply, 'function')
  // Every service the code reads must be declared: Cordis resolves only declared
  // properties, so an undeclared `ctx.get('x')` is undefined with no error. The
  // declaration previously named only `sidebarRight` while the code also read
  // `sessions`, `layout` and `uiWorkspace`, which made the history permanently
  // empty. Pin all four.
  assert.deepEqual(Array.from(plugin.inject).sort(), ['layout', 'sessions', 'sidebarRight', 'uiWorkspace'])
})

test('the client bundle is a classic script with no ESM syntax', () => {
  // A top-level export/import crashes the Harness shell at boot.
  assert.ok(clientSource.trimStart().startsWith('window.__ModuleLoader__.load({'))
  assert.equal(/^\s*(export\s|import\s)/m.test(clientSource), false)
})

test('a fresh history cannot move in either direction', () => {
  const history = new NavHistory()
  assert.deepEqual(history.snapshot, { current: undefined, canGoBack: false, canGoForward: false, size: 0, keys: [] })
  assert.equal(history.back(), undefined)
  assert.equal(history.forward(), undefined)
})

test('visits accumulate and back/forward walk them', () => {
  const history = new NavHistory()
  history.visit('a')
  history.visit('b')
  history.visit('c')
  assert.deepEqual(history.snapshot, { current: { key: 'c' }, canGoBack: true, canGoForward: false, size: 3, keys: ['a', 'b', 'c'] })
  assert.deepEqual(history.back(), { key: 'b' })
  assert.deepEqual(history.back(), { key: 'a' })
  assert.equal(history.back(), undefined)
  assert.deepEqual(history.forward(), { key: 'b' })
  assert.deepEqual(history.forward(), { key: 'c' })
  assert.equal(history.forward(), undefined)
})

test('revisiting the current place is a no-op', () => {
  const history = new NavHistory()
  history.visit('a')
  assert.equal(history.visit('a'), false)
  assert.equal(history.snapshot.size, 1)
})

test('a new visit after going back drops the forward branch', () => {
  const history = new NavHistory()
  history.visit('a')
  history.visit('b')
  history.visit('c')
  history.back()
  history.back()
  history.visit('d')
  assert.deepEqual(history.snapshot, { current: { key: 'd' }, canGoBack: true, canGoForward: false, size: 2, keys: ['a', 'd'] })
  assert.deepEqual(history.back(), { key: 'a' })
})

test('revisiting a place already in the stack jumps to it without truncating', () => {
  const history = new NavHistory()
  for (const key of ['a', 'b', 'c', 'd']) history.visit(key)
  history.visit('b')
  assert.deepEqual(history.snapshot, { current: { key: 'b' }, canGoBack: true, canGoForward: true, size: 4, keys: ['a', 'b', 'c', 'd'] })
  assert.deepEqual(history.forward(), { key: 'c' })
})

test('the stack is bounded and keeps the newest entries', () => {
  const history = new NavHistory(3)
  for (const key of ['a', 'b', 'c', 'd', 'e']) history.visit(key)
  assert.equal(history.snapshot.size, 3)
  assert.deepEqual(history.snapshot.current, { key: 'e' })
  // Only the two most recent predecessors remain reachable.
  assert.deepEqual(history.back(), { key: 'd' })
  assert.deepEqual(history.back(), { key: 'c' })
  assert.equal(history.back(), undefined)
})

test('a limit below two is refused', () => {
  assert.throws(() => new NavHistory(1), /limit of at least 2/)
  assert.throws(() => new NavHistory(0), /limit of at least 2/)
})

test('clear forgets everything', () => {
  const history = new NavHistory()
  history.visit('a')
  history.visit('b')
  history.clear()
  assert.deepEqual(history.snapshot, { current: undefined, canGoBack: false, canGoForward: false, size: 0, keys: [] })
})

test('only the two thumb buttons are claimed', () => {
  assert.equal(sideButton(3), 'back')
  assert.equal(sideButton(4), 'forward')
  for (const button of [0, 1, 2, 5]) assert.equal(sideButton(button), undefined)
})

test('the sidebar browser guest keeps its own page history', () => {
  const guest = { tagName: 'WEBVIEW' }
  assert.equal(ownsOwnHistory(guest), true)
  const insideGuest = { tagName: 'DIV', closest: selector => (selector.includes('webview') ? { tagName: 'WEBVIEW' } : null) }
  assert.equal(ownsOwnHistory(insideGuest), true)
  const chat = { tagName: 'DIV', closest: () => null }
  assert.equal(ownsOwnHistory(chat), false)
  assert.equal(ownsOwnHistory(null), false)
  assert.equal(ownsOwnHistory(undefined), false)
})

test('a full session/panel/tab walk composes one history', () => {
  // The three id spaces are joined unambiguously, so switching only the panel
  // still records a distinct place.
  const history = new NavHistory()
  const place = (session, panel, tab) => [session, panel, tab].join('\u0001')
  history.visit(place('s1', 'chat', 't1'))
  history.visit(place('s1', 'files', 't1'))
  history.visit(place('s2', 'files', 't1'))
  history.visit(place('s2', 'files', 't2'))
  assert.equal(history.snapshot.size, 4)
  // Walking back retraces exactly the recorded order, one place per step.
  assert.deepEqual(history.back(), { key: place('s2', 'files', 't1') })
  assert.deepEqual(history.back(), { key: place('s1', 'files', 't1') })
  assert.deepEqual(history.back(), { key: place('s1', 'chat', 't1') })
  assert.equal(history.back(), undefined, 'the first place is the end of the past')
  assert.deepEqual(history.forward(), { key: place('s1', 'files', 't1') })
})

/** Minimal node request/response pair for one diagnostics call. */
function call(route, method, endpoint, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: `/tool-nav-buttons/${endpoint}`,
    on(event, handler) {
      if (event === 'data') for (const chunk of payload) handler(chunk)
      if (event === 'end') handler()
    },
  }
  return new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(code) { this.status = code; return this },
      end(text) { resolve({ status: this.status, body: text }) },
    }
    route.handler(req, res)
  })
}

test('the host half exposes a diagnostics route for the browser half', async () => {
  const routes = new Map()
  const webServer = { register(route) { routes.set(route.path, route); return () => {} } }
  const ctx = {
    // The host half declares `inject: ['webServer']`, so Cordis resolves the
    // property on the context itself; the fixture must expose it the same way.
    webServer,
    effect(install) { install(); return () => {} },
  }
  const { apply } = await import('../lib/index.js')
  apply(ctx)
  const route = routes.get('/tool-nav-buttons')
  assert.ok(route, 'diagnostics route is registered')

  // Before any report, the status must say so rather than pretend all is well.
  const empty = await call(route, 'GET', 'status')
  assert.equal(empty.status, 200)
  const idle = JSON.parse(empty.body)
  assert.equal(idle.pageHalf, 'awaiting first report')
  // The wording matters: after a host reload this half has no state, and a
  // healthy page is indistinguishable from a missing one until it reports. The
  // response must say so rather than implying the page is broken.
  assert.ok(typeof idle.note === 'string' && idle.note.length > 0, 'explains what to do')

  // A report from the page flips it to a concrete, countable state.
  const posted = await call(route, 'POST', 'report', {
    loadedAt: 1700000000000, visits: 7, backs: 2, forwards: 1, entries: 5, index: 0,
  })
  assert.equal(posted.status, 204)

  const reported = await call(route, 'GET', 'status')
  const state = JSON.parse(reported.body)
  assert.equal(state.pageHalf, 'reported')
  assert.equal(state.visits, 7)
  assert.equal(state.backs, 2)
  assert.equal(state.forwards, 1)

  // A malformed report is refused instead of poisoning the counters.
  const bad = await call(route, 'POST', 'report', undefined)
  assert.equal(bad.status, 400)
  assert.equal(await call(route, 'GET', 'nope').then(r => r.status), 404)
})

test('the browser half reads the services that actually move for each axis', () => {
  // These three names are the whole correctness story for "which place is this":
  // the session controller keeps retention under `mainView` inside `sessions.list`,
  // the layout exposes selection as `panelInfo.activePanelId`, and the Sidebar
  // exposes its own session as `mounted`. Reading any other member silently
  // yields "unchanged" and the feature appears dead.
  assert.ok(clientSource.includes('sessions?.list?.getSnapshot'), 'session axis reads sessions.list')
  assert.ok(clientSource.includes('panelInfo?.getSnapshot'), 'panel axis reads layout.panelInfo')
  assert.ok(clientSource.includes("ctx.get('sidebarRight')?.mounted"), 'tab axis reads sidebarRight.mounted')
  assert.ok(clientSource.includes('retainedBy?.mainView'), 'session axis keys off mainView retention')
})

test('position reports the real cursor, not a placeholder', () => {
  // The plugin reports `index` to the Host so an operator can see where the stack
  // stands. It previously sent a constant 0/-1, which made every stack look empty
  // however deep it actually was.
  const history = new NavHistory()
  assert.equal(history.position, -1, 'empty stack is -1')

  history.visit('a')
  assert.equal(history.position, 0)
  history.visit('b')
  history.visit('c')
  assert.equal(history.position, 2)

  history.back()
  assert.equal(history.position, 1, 'back moves the cursor')
  history.forward()
  assert.equal(history.position, 2, 'forward moves it back')
})

test('position tracks revisit jumps without dropping the tail', () => {
  const history = new NavHistory()
  for (const key of ['a', 'b', 'c', 'd']) history.visit(key)
  history.back()
  history.back()
  assert.equal(history.position, 1)

  // Revisiting an earlier place moves the cursor there and keeps every entry:
  // the stack holds sessions/panels/tabs and hopping between them is the point,
  // so deleting the tail here would destroy the forward branch the user needs.
  history.visit('a')
  assert.equal(history.position, 0)
  assert.equal(history.snapshot.size, 4, 'the tail survived')
  assert.equal(history.snapshot.canGoForward, true)
})

test('the tab axis reads sidebarRight.active(), not a member that does not exist', () => {
  // `ctx.sidebarRight` has no `state` and no `getSnapshot`; it exposes `active()`
  // for "the active tab of the active pane". The earlier code read
  // `sidebarRight.state.getSnapshot()`, which is undefined forever, so switching
  // sidebar tabs never produced a new place — while `sources.tab` still reported
  // healthy because it only checked `mounted.subscribe`.
  // Strip comments first: the source documents the WRONG accessor it replaced, and
  // a raw substring check would fail on that documentation rather than on code.
  const code = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(code.includes('sidebarRight.active()'), 'reads the real accessor')
  assert.equal(code.includes('sidebarRight.state'), false, 'no phantom member in code')
  // The health check must cover the reader too, or the axis lies again.
  assert.ok(code.includes("sidebarRight')?.active === 'function'"), 'health checks active()')
})

test('the tab axis is sampled, because no observable reports it', () => {
  // `ISidebarRight` exposes exactly one observable, `mounted`, and its contract is
  // "moves only when the on-screen Session changes; the Session's own store
  // commits are silent". A tab switch therefore emits no event at all. The tab
  // axis must be sampled or every tab change is lost — which is what happened.
  const code = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  // Interaction-driven, not timer-driven: Chromium throttles background-tab
  // timers and this document is usually backgrounded (measured 1 tick per 10 s).
  assert.ok(code.includes("record(true), 0"), 'records on the interaction, deferred a task')
  assert.equal(code.includes('setInterval(() => record(true)'), false, 'no throttled timer')

  // Samples must not be counted as observer firings, or the diagnostic that
  // distinguishes "record is dead" from "nothing moved" stops meaning anything.
  assert.ok(code.includes('if (fromSample) sampleCalls++'), 'samples counted apart')
  assert.ok(code.includes('recordCalls++'), 'observer firings still counted')
  assert.ok(code.includes('sampleCalls,'), 'sample count is reported')
})

test('the command mailbox lets navigation be exercised without real input', async () => {
  // Driving X1/X2 for real means synthesizing mouse input on the operator's
  // machine. The mailbox replaces that: the test asks for a direction over HTTP
  // and the page half performs it on its next drain. Without this the navigation
  // path can only be verified by taking over the user's mouse.
  const routes = new Map()
  const webServer = { register(route) { routes.set(route.path, route); return () => {} } }
  const ctx = { webServer, effect(install) { install(); return () => {} } }
  const { apply } = await import('../lib/index.js')
  apply(ctx)
  {
    const route = routes.get('/tool-nav-buttons')

    const empty = await call(route, 'GET', 'command')
    assert.equal(JSON.parse(empty.body).command, null, 'mailbox starts empty')

    const queued = await call(route, 'POST', 'command', { command: 'back' })
    assert.equal(queued.status, 202)
    assert.equal(JSON.parse(queued.body).queued, 'back')

    const drained = await call(route, 'GET', 'command')
    assert.equal(JSON.parse(drained.body).command, 'back')

    // Single slot: draining clears it, so stale directions cannot pile up.
    const afterDrain = await call(route, 'GET', 'command')
    assert.equal(JSON.parse(afterDrain.body).command, null)

    // An unknown command is rejected rather than parked for the page to misread.
    const bad = await call(route, 'POST', 'command', { command: 'explode' })
    assert.equal(bad.status, 400)
  }
})

test('snapshot.keys exposes the entries, so a stuck cursor is diagnosable', () => {
  // `size` alone cannot distinguish "two distinct places" from "one place recorded
  // twice", and when a back step reports there is nowhere to go that is exactly
  // the question. The contents answer it.
  const history = new NavHistory()
  assert.deepEqual(history.snapshot.keys, [])

  for (const key of ['a', 'b', 'c']) history.visit(key)
  assert.deepEqual(history.snapshot.keys, ['a', 'b', 'c'])

  history.back()
  assert.deepEqual(history.snapshot.keys, ['a', 'b', 'c'], 'moving does not drop entries')
  assert.equal(history.position, 1)

  // Revisiting moves the cursor but keeps every key.
  history.visit('a')
  assert.deepEqual(history.snapshot.keys, ['a', 'b', 'c'])
  assert.equal(history.position, 0)
})

test('walks a real session+tab key stream the way X1/X2 must', () => {
  // Mirrors the exact key format the page half builds (session, panel, tab joined
  // by U+0001) with the tab axis active and the panel axis empty — the shape this
  // workspace actually reports. Proves the navigation logic is sound on its own,
  // independent of whether the running page has the latest code.
  const SESSION = 'session-1717371d-adf4-4c37-8d02-0d61ee5e23ac'
  const key = tab => `${SESSION}\u0001\u0001${tab}`
  const tabOf = entry => entry.key.split('\u0001').pop()

  const history = new NavHistory()
  history.visit(key('tab5'))
  history.visit(key('tab7'))
  assert.equal(history.position, 1, 'two places, cursor at the newest')

  // X1
  assert.equal(tabOf(history.back()), 'tab5')
  assert.equal(history.position, 0)
  assert.equal(history.snapshot.canGoBack, false, 'at the oldest end')

  // X2
  assert.equal(tabOf(history.forward()), 'tab7')
  assert.equal(history.position, 1)

  // Walking back past the start yields nothing rather than wrapping or throwing.
  assert.equal(tabOf(history.back()), 'tab5')
  assert.equal(history.back(), undefined)
  assert.equal(history.position, 0)
})

test('a place key collapses when a service is missing, which is why inject must be complete', () => {
  // Cordis resolves only DECLARED services; an undeclared ctx.get() is undefined
  // with no error. The page half builds its key from three services, so a missing
  // declaration does not throw — it silently produces a key with empty segments,
  // and two genuinely different places then look identical. That is exactly how
  // the history stayed at one entry while the code looked correct.
  const SEP = '\u0001'
  const placeKey = (sessionId, panel, tabId) => [sessionId ?? '', panel ?? '', tabId ?? ''].join(SEP)

  // Every service present: the key identifies all three axes.
  assert.equal(placeKey('session-abc', 'chat', 'tab5'), `session-abc${SEP}chat${SEP}tab5`)

  // Session and panel services missing: the key degrades to something that cannot
  // tell this place from any other tab, in any session, on any panel.
  assert.equal(placeKey(undefined, null, 'tab5'), `${SEP}${SEP}tab5`)
  assert.equal(placeKey(undefined, null, 'tab5'), placeKey(undefined, null, 'tab5'))
  assert.notEqual(placeKey(undefined, null, 'tab5'), placeKey(undefined, null, 'tab7'))
})

test('suppressing the restore echo must not swallow a real switch', () => {
  // The page half ignores the observation its own restore causes, so a back step
  // does not rewrite the stack. Suppressing by TIME (a 0 ms window) also drops
  // whatever the user does inside it — pressing X1 and immediately switching a tab
  // lost the switch. Keying on the restored place instead drops only the echo.
  const SEP = '\u0001'
  const key = tab => `session-a${SEP}${SEP}${tab}`
  const history = new NavHistory()
  let restoring = null
  let visits = 0

  const record = (k) => {
    if (k === restoring) { restoring = null; return }
    if (history.visit(k)) visits++
  }

  record(key('tab5'))
  record(key('tab7'))
  record(key('tab9'))

  // Back: the plugin sets `restoring`, then the observer echoes that place.
  const entry = history.back()
  restoring = entry.key
  record(entry.key)
  assert.equal(history.position, 1, 'the back step moved')
  assert.equal(history.snapshot.size, 3, 'the echo did not rewrite the stack')

  // A genuine switch immediately afterwards must still be recorded.
  record(key('tab1'))
  assert.equal(visits, 4, 'the real switch counted')
  assert.deepEqual(history.snapshot.keys.map(k => k.split(SEP).pop()), ['tab5', 'tab7', 'tab1'])
})

test('returnTo rewinds the cursor without dropping later entries', () => {
  // back()/forward() move the cursor and THEN return the entry, so a caller whose
  // restore fails has already desynced the stack: it claims a position the screen
  // is not on, and the next step starts from the wrong place. returnTo undoes
  // exactly that, and must not truncate the way visit() does.
  const history = new NavHistory()
  for (const key of ['a', 'b', 'c']) history.visit(key)
  assert.equal(history.position, 2)

  const entry = history.back()
  assert.equal(entry.key, 'b')
  assert.equal(history.position, 1, 'the cursor moved before the restore ran')

  // Restore failed: put the cursor back where it was.
  assert.equal(history.returnTo('c'), true)
  assert.equal(history.position, 2)
  assert.equal(history.snapshot.size, 3, 'entries were not dropped')

  // No-op cases.
  assert.equal(history.returnTo('c'), false, 'already there')
  assert.equal(history.returnTo('nope'), false, 'not in the stack')
  assert.equal(history.returnTo(undefined), false, 'nothing to return to')
})

test('a completely failed restore rewinds the stack and the counters', () => {
  // Mirrors step()'s failure path: back() moves the cursor, restorePlace fails on
  // every axis, and the plugin must leave the user where they were. Otherwise the
  // stack claims a position the screen is not on, and the counters report a move
  // that never happened.
  const SEP = '\u0001'
  const key = tab => `session-a${SEP}${SEP}${tab}`
  const history = new NavHistory()
  let backs = 0

  history.visit(key('t1'))
  history.visit(key('t2'))
  history.visit(key('t3'))

  const previousKey = history.snapshot.current.key
  const entry = history.back()
  assert.equal(entry.key, key('t2'))
  backs++

  // restorePlace reports every axis as failed.
  assert.equal(history.returnTo(previousKey), true, 'the rewind succeeded')
  backs--

  assert.equal(history.position, 2, 'cursor is back on the newest')
  assert.equal(history.snapshot.current.key, key('t3'))
  assert.equal(backs, 0, 'the counter describes what happened, not what was tried')
  assert.equal(history.snapshot.size, 3, 'no entries were dropped')
})

test('the two NavHistory copies expose the same members', () => {
  // `lib/client.js` is a classic script the page loads directly, so it CANNOT
  // import `lib/history.js`; the class is duplicated and history.js is the copy
  // only the tests exercise. A member added to one copy is invisible until
  // something reads it, and then it fails inside the page. That already happened
  // once: `stack` read `snapshot.keys.map(...)` against a copy without `keys` and
  // install() threw "Cannot read properties of undefined (reading 'map')".
  //
  // This is the same comparison as extensions/dsh-next/check-history-copies.ps1,
  // but running it here means `npm test` catches drift without anyone remembering
  // to run a PowerShell script.
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  const bodyOf = (source, label) => {
    const at = source.indexOf('class NavHistory')
    assert.notEqual(at, -1, `no NavHistory class in ${label}`)
    const rest = source.slice(at)
    // The class ends at the first line that is just `}` in column 0.
    const end = rest.indexOf('\n}\n')
    return end < 0 ? rest : rest.slice(0, end)
  }

  const membersOf = (body) => {
    const names = new Set()
    for (const line of body.split('\n')) {
      const method = line.match(/^\s{2}(get\s+)?([A-Za-z#][A-Za-z0-9_#]*)\s*\(/)
      if (method !== null) names.add((method[1] + method[2]).trim())
      const snapshotField = line.match(/^\s+([A-Za-z][A-Za-z0-9_]*):\s/)
      if (snapshotField !== null) names.add(`snapshot.${snapshotField[1]}`)
      for (const field of line.matchAll(/this\.#([A-Za-z][A-Za-z0-9_]*)/g)) names.add(`#${field[1]}`)
    }
    return names
  }

  const pageCopy = membersOf(bodyOf(clientSource, 'client.js'))
  const testCopy = membersOf(bodyOf(readFileSync(new URL('../lib/history.js', import.meta.url), 'utf8'), 'history.js'))

  const onlyPage = [...pageCopy].filter(name => !testCopy.has(name))
  const onlyTest = [...testCopy].filter(name => !pageCopy.has(name))
  assert.deepEqual(onlyPage, [], 'members only in the copy that runs')
  assert.deepEqual(onlyTest, [], 'members only in the copy the tests exercise')
  assert.ok(pageCopy.size > 10, `sanity: found ${pageCopy.size} members`)
})

test('every module-level history helper exists in both copies', () => {
  // The page bundle cannot import, so the helpers beside NavHistory are duplicated
  // too. The class-member comparison above does not see them: it only walks the
  // class body. `historyShortcut` was added for Alt+Arrow and would have been
  // silently missing from the page copy without this check.
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const namesOf = (source) => new Set(
    [...source.matchAll(/^(?:export )?function ([A-Za-z][A-Za-z0-9_]*)/gm)].map(m => m[1]),
  )
  const pageCopy = namesOf(clientSource)
  const moduleCopy = namesOf(readFileSync(new URL('../lib/history.js', import.meta.url), 'utf8'))

  const onlyModule = [...moduleCopy].filter(name => !pageCopy.has(name))
  assert.deepEqual(onlyModule, [], 'helpers exported by history.js but missing from client.js')

  // The three that must exist on both sides for the feature to work at all.
  for (const required of ['historyShortcut', 'sideButton', 'ownsOwnHistory']) {
    assert.ok(pageCopy.has(required), `client.js is missing ${required}`)
  }
})

test('reports from several page halves do not overwrite each other', async () => {
  // Electron runs more than one renderer for a single app, and every renderer
  // that loads the plugin runs its own page half against this one route. With a
  // single slot they overwrote each other, so `status` returned whichever landed
  // last: the counters appeared to jump backwards and a back/forward step looked
  // like it did nothing. Each instance now keeps its own slot and `status` answers
  // with the freshest one.
  const routes = new Map()
  const webServer = { register(route) { routes.set(route.path, route); return () => {} } }
  const ctx = { webServer, effect(install) { install(); return () => {} } }
  const { apply } = await import('../lib/index.js')
  apply(ctx)
  const route = routes.get('/tool-nav-buttons')

  const post = (instance, visits, entries) => call(route, 'POST', 'report', {
    shape: 2, instance, loadedAt: Date.now(), visits, backs: 0, forwards: 0, entries, index: 0,
  })

  await post('instance-a', 59, 5)
  await post('instance-b', 1, 1)

  const state = JSON.parse((await call(route, 'GET', 'status')).body)
  // The freshest report wins, and both instances are visible by name.
  assert.equal(state.instance, 'instance-b', 'the newest report answers')
  assert.equal(state.visits, 1)
  assert.ok(Array.isArray(state.instances), 'instance list is exposed')
  assert.ok(state.instances.includes('instance-a'))
  assert.ok(state.instances.includes('instance-b'))
  // The report map is module state, so an earlier test in this file may already
  // have registered an instance. Assert the two we posted are present rather than
  // pinning the total, which would couple this test to execution order.
  assert.ok(state.instanceCount >= 2, `expected at least 2 instances, saw ${state.instanceCount}`)

  // A later report from the other instance takes over again, rather than the
  // counters being stuck on whichever wrote last forever.
  await post('instance-a', 60, 5)
  const again = JSON.parse((await call(route, 'GET', 'status')).body)
  assert.equal(again.instance, 'instance-a')
  assert.equal(again.visits, 60)
})

test('one physical side-button press must step exactly once', () => {
  // `auxclick` and `mouseup` BOTH fire for the same non-primary click. Listening
  // to both ran step() twice per press. Back looked fine (two steps back are still
  // "back") but forward moved once and then found the stack already at its end, so
  // a single X2 appeared to do nothing. Whatever arrives first must win.
  const history = new NavHistory()
  for (const key of ['a', 'b', 'c']) history.visit(key)
  assert.equal(history.position, 2)

  let handled = false
  let steps = 0
  const press = () => {
    if (handled) return
    handled = true
    steps++
    history.back()
  }
  press()   // auxclick
  press()   // mouseup, same physical click
  assert.equal(steps, 1, 'only one step per press')
  assert.equal(history.position, 1, 'moved exactly one entry')
})

test('visiting a place that is already ahead must not truncate the stack', () => {
  // Observed in the field: the stack collapsed from four entries to one, after
  // which "forward" had nowhere to go and the user reported that forward was
  // broken while back appeared to work.
  //
  // The cause was `visit(key)` truncating whenever the key already existed. But
  // arriving at an entry that is ALREADY AHEAD of the cursor is navigation along
  // the existing history, not a new branch — cutting the tail there deletes the
  // entries a subsequent forward step needs.
  const history = new NavHistory()
  for (const key of ['a', 'b', 'c', 'd']) history.visit(key)
  assert.equal(history.position, 3)

  history.back()
  history.back()
  assert.equal(history.position, 1, 'cursor is on b, c/d are ahead')

  // Something observes the place we are already on: no change, no truncation.
  assert.equal(history.visit('b'), false)
  assert.equal(history.snapshot.size, 4)

  // Moving FORWARD onto c is navigation, not a detour: c and d must survive.
  assert.equal(history.visit('c'), true)
  assert.equal(history.position, 2)
  assert.equal(history.snapshot.size, 4, 'the tail survived')
  assert.equal(history.snapshot.canGoForward, true, 'forward is still possible')

  // A genuine detour — going back and then somewhere NEW — does drop the tail.
  history.back()
  history.visit('x')
  assert.deepEqual(history.snapshot.keys, ['a', 'b', 'x'])
})

test('a restore must ignore every observation until its target arrives', () => {
  // The observers fire BEFORE the new selection commits, so during a restore they
  // report the place being LEFT. Filtering only on "is this the restored value"
  // let those stale observations through: each one ran visit(oldPlace), which sat
  // earlier in the stack and truncated the forward branch. In the field the stack
  // collapsed 4 -> 1 and then even back had nowhere to go.
  //
  // The guard is therefore "ignore everything while restoring", and the target
  // observation is itself the completion signal.
  const history = new NavHistory()
  for (const key of ['a', 'b', 'c', 'd']) history.visit(key)
  assert.equal(history.position, 3)

  let restoring = null
  const observe = (key) => {
    if (restoring !== null) {
      if (key === restoring) restoring = null
      return false          // ignored
    }
    return history.visit(key)
  }

  // Press X1: the plugin starts restoring 'c'.
  const entry = history.back()          // cursor -> 2 ('c')
  assert.equal(entry.key, 'c')
  restoring = entry.key

  // Two stale observations of places we are passing through or leaving.
  assert.equal(observe('a'), false, 'old place a ignored')
  assert.equal(observe('b'), false, 'old place b ignored')
  assert.equal(history.snapshot.size, 4, 'nothing was truncated')

  // The target finally arrives: guard clears, no truncation, forward survives.
  assert.equal(observe('c'), false, 'target observation clears the guard only')
  assert.equal(restoring, null)
  assert.equal(history.position, 2)
  assert.equal(history.snapshot.canGoForward, true, 'd is still reachable')
})
