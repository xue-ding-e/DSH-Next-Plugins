import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionRelay, resolveConfig } from '../lib/relay.js'

/** The fixture preserves native inbox event fields so retry checks survive consumption and reload. */
function fixture(config = {}) {
  const agents = new Map()
  const sessions = new Map()
  const calls = { sends: [], resolves: 0, flushes: 0, releases: 0 }
  const create = (id, cwd = process.cwd(), origin) => {
    const session = { header: { id, cwd, ...(origin === undefined ? {} : { origin }) }, events: [] }
    sessions.set(id, session)
    const agent = {
      id, session, status: 'idle', inbox: { nextStep: [], nextTurn: [] },
      send(message, target, wake) {
        calls.sends.push({ id, message, target, wake })
        this.session.events.push({ type: 'agent/inbox/spliced', seq: this.session.events.length, data: { target, start: 0, inserted: [message] } })
        this.inbox[target === 'next-step' ? 'nextStep' : 'nextTurn'].push(message)
        if (wake) this.status = 'running'
      },
    }
    agents.set(id, agent)
    return agent
  }
  const sender = create('sender')
  const target = create('target')
  const ctx = {
    remoteAccess: { allows: () => true },
    workspaceRegistry: { archivedSessionIds: [] },
    agents: { get: id => agents.get(id) },
    sessions: {
      get: id => sessions.get(id),
      async flush() { calls.flushes++ },
    },
    sessionController: {
      async list() {
        return { items: [...sessions].map(([sessionId, session]) => ({
          ...session.header, sessionId, updatedAt: 1, running: false, agentAvailable: agents.has(sessionId),
        })) }
      },
      async resolveAgent(id) {
        calls.resolves++
        const agent = agents.get(id)
        if (agent === undefined) {
          const session = sessions.get(id)
          const resumed = create(id, session.header.cwd)
          resumed.session = session
          sessions.set(id, session)
          return { agent: resumed }
        }
        return { agent }
      },
    },
    sessionQuery: {
      async observeSession(id) {
        const session = sessions.get(id)
        if (!session) throw new Error('Session not found')
        return {
          header: session.header, inheritedEventCount: 0, cursor: session.events.length - 1,
          events: structuredClone(session.events),
          [Symbol.dispose]() { calls.releases++ },
        }
      },
    },
  }
  const relay = new SessionRelay(ctx, config, observation => observation.events
    .filter(event => ['user/message', 'assistant/message', 'tool/message'].includes(event.type))
    .map(event => event.data))
  const request = { session_id: 'target', request_id: 'progress-1', message: 'Shop build passed.' }
  return { ctx, relay, sender, target, agents, sessions, calls, create, request }
}

const hasCode = code => error => error.code === code

test('context delivery stays idle and records agent attribution before confirming durability', async () => {
  const f = fixture()
  const result = await f.relay.send(f.sender, f.request)
  assert.equal(result.durable, true)
  assert.equal(result.duplicate, false)
  assert.equal(f.target.status, 'idle')
  assert.equal(f.calls.flushes, 1)
  assert.deepEqual(f.calls.sends[0].message.source, { kind: 'agent-message', form: 'relay', senderSessionId: 'sender' })
  assert.match(f.calls.sends[0].message.content[0].text, /session "sender"/)
  assert.equal(f.calls.sends[0].target, 'next-step')
  assert.equal(f.calls.sends[0].wake, false)
})

test('queue and steer select native turn and step routing', async () => {
  for (const [delivery, target] of [['queue', 'next-turn'], ['steer', 'next-step']]) {
    const f = fixture()
    await f.relay.send(f.sender, { ...f.request, delivery })
    assert.equal(f.calls.sends[0].target, target)
    assert.equal(f.calls.sends[0].wake, true)
  }
})

test('parallel retries accept once; receipt survives consumption and a new plugin instance', async () => {
  const f = fixture()
  const results = await Promise.all(Array.from({ length: 8 }, () => f.relay.send(f.sender, f.request)))
  assert.equal(f.calls.sends.length, 1)
  assert.equal(results.filter(result => !result.duplicate).length, 1)
  const message = f.calls.sends[0].message
  f.target.inbox.nextStep.length = 0
  f.target.session.events.push({ type: 'user/message', seq: 1, data: message })
  await f.relay.dispose()
  const restarted = new SessionRelay(f.ctx, {}, () => [])
  assert.equal((await restarted.send(f.sender, f.request)).duplicate, true)
  assert.equal(f.calls.sends.length, 1)
  for (const changed of [{ message: 'different' }, { delivery: 'steer' }]) {
    await assert.rejects(restarted.send(f.sender, { ...f.request, ...changed }), hasCode('REQUEST_CONFLICT'))
  }
})

test('a persistence failure reports accepted input and a retry confirms without redelivery', async () => {
  const f = fixture()
  f.ctx.sessions.flush = async () => { throw new Error('disk full') }
  await assert.rejects(f.relay.send(f.sender, f.request), error => {
    assert.equal(error.code, 'PERSISTENCE_UNCONFIRMED')
    assert.equal(error.details.accepted, true)
    assert.equal(error.details.request_id, f.request.request_id)
    return true
  })
  f.ctx.sessions.flush = async () => {}
  assert.equal((await f.relay.send(f.sender, f.request)).duplicate, true)
  assert.equal(f.calls.sends.length, 1)
})

test('scope, self and subagent rules are enforced in execution', async () => {
  const f = fixture()
  f.create('other', `${process.cwd()}/other`)
  f.create('child', process.cwd(), 'subagent')
  for (const session_id of ['other', 'child']) {
    await assert.rejects(f.relay.send(f.sender, { ...f.request, session_id }), hasCode('OUT_OF_SCOPE'))
  }
  await assert.rejects(f.relay.send(f.sender, { ...f.request, session_id: 'sender' }), hasCode('SELF_SEND'))
  await assert.rejects(f.relay.send(f.agents.get('child'), f.request), hasCode('SUBAGENT_CALLER'))
  assert.equal(f.calls.resolves, 0)
  assert.equal(f.calls.sends.length, 0)
  assert.equal(f.calls.releases, 2)
  const listing = await f.relay.list(f.sender)
  assert.deepEqual(listing.sessions.map(row => row.session_id), ['sender', 'target'])
})

test('all-directory scope is explicit and cold activation is delegated only after discovery validates', async () => {
  const f = fixture({ scope: 'all' })
  f.create('other', `${process.cwd()}/other`)
  f.agents.delete('other')
  const listed = await f.relay.list(f.sender)
  assert.equal(listed.sessions.find(row => row.session_id === 'other').loaded, false)
  assert.equal(f.calls.resolves, 0)
  await f.relay.send(f.sender, { ...f.request, session_id: 'other' })
  assert.equal(f.calls.resolves, 1)
  assert.equal(f.calls.sends.length, 1)
  await assert.rejects(f.relay.send(f.sender, { ...f.request, session_id: 'missing' }), /not found/)
  assert.equal(f.calls.resolves, 1)
})

test('stale and cancelled senders cannot submit after an asynchronous target resume', async () => {
  const f = fixture()
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  f.ctx.sessionController.resolveAgent = async () => { entered.resolve(); return resume.promise }
  const delivery = f.relay.send(f.sender, f.request)
  await entered.promise
  f.agents.set('sender', { ...f.sender })
  resume.resolve({ agent: f.target })
  await assert.rejects(delivery, hasCode('STALE_CALLER'))
  assert.equal(f.calls.sends.length, 0)
  const canceled = new AbortController()
  canceled.abort(new Error('user cancelled'))
  await assert.rejects(f.relay.send(f.agents.get('sender'), f.request, canceled.signal), /user cancelled/)
})

test('unloading drains accepted persistence and rejects waiting submissions', async () => {
  const f = fixture()
  const entered = Promise.withResolvers()
  const flush = Promise.withResolvers()
  f.ctx.sessions.flush = () => { entered.resolve(); return flush.promise }
  const delivery = f.relay.send(f.sender, f.request)
  await entered.promise
  const waiting = f.relay.send(f.sender, { ...f.request, request_id: 'later' })
  const rejection = assert.rejects(waiting, hasCode('DISPOSED'))
  const unloading = f.relay.dispose()
  flush.resolve()
  await Promise.all([delivery, unloading, rejection])
  assert.equal(f.calls.sends.length, 1)
})

function appendText(session, text, role = 'assistant') {
  session.events.push({ type: `${role}/message`, seq: session.events.length, data: {
    id: `message-${session.events.length}`, role, source: { kind: role === 'user' ? 'user' : 'model' },
    content: [{ type: 'reasoning', text: 'PRIVATE REASONING' }, { type: 'text', text }, { type: 'image', data: 'PRIVATE IMAGE' }],
  } })
}

test('bounded read fragments reconstruct Chinese, emoji, quotes and newlines without leaking hidden content', async () => {
  const f = fixture()
  const original = '中文😀"\\\n'.repeat(500)
  appendText(f.target.session, original)
  f.target.session.events.push({ type: 'tool/message', seq: 1, data: {
    id: 'tool-private', role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: 'PRIVATE TOOL' }],
  } })
  let cursor
  let reconstructed = ''
  let pages = 0
  do {
    const page = await f.relay.read(f.sender, { session_id: 'target', max_chars: 750, cursor })
    const json = JSON.stringify(page)
    assert.ok(json.length <= 750)
    assert.doesNotMatch(json, /PRIVATE/)
    for (const message of page.messages) {
      assert.equal(message.char_offset, reconstructed.length)
      assert.doesNotMatch(message.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
      reconstructed += message.text
    }
    cursor = page.next_cursor ?? undefined
    assert.ok(++pages < 200)
  } while (cursor !== undefined)
  assert.equal(reconstructed, original)
  assert.ok(pages > 1)
  assert.equal(f.calls.resolves, 0)
  await assert.rejects(f.relay.read(f.sender, { session_id: 'target', max_chars: 1 }), hasCode('OUTPUT_LIMIT'))
})

test('read cursors reject changed sources and other chat ids; reads keep the latest 20 messages', async () => {
  const f = fixture()
  for (let index = 0; index < 25; index++) appendText(f.target.session, `reply ${index} ` + 'x'.repeat(100))
  const first = await f.relay.read(f.sender, { session_id: 'target', max_chars: 750 })
  assert.equal(first.omitted_before, 5)
  assert.equal(first.messages[0].id, 'message-5')
  assert.ok(first.next_cursor)
  await assert.rejects(f.relay.read(f.sender, { session_id: 'sender', cursor: first.next_cursor }), hasCode('INVALID_CURSOR'))
  appendText(f.target.session, 'changed')
  await assert.rejects(f.relay.read(f.sender, { session_id: 'target', cursor: first.next_cursor }), hasCode('INVALID_CURSOR'))
})

test('wire argument and complete UTF-8 message limits fail before activation', async () => {
  const f = fixture({ maxMessageBytes: 500 })
  await assert.rejects(f.relay.send(f.sender, { ...f.request, message: '中'.repeat(100) }), hasCode('MESSAGE_TOO_LARGE'))
  for (const changed of [{ request_id: '' }, { message: '' }, { delivery: 'wake' }]) {
    await assert.rejects(f.relay.send(f.sender, { ...f.request, ...changed }), hasCode('INVALID_ARGUMENT'))
  }
  assert.equal(f.calls.resolves, 0)
  for (const config of [{ scope: 'workspace' }, { maxReadChars: 0 }, { maxMessageBytes: NaN }, { mystery: true }]) {
    assert.throws(() => resolveConfig(config), hasCode('INVALID_CONFIG'))
  }
})

test('archived and unauthorized destinations reject before activation or log writes', async () => {
  const f = fixture()
  f.ctx.workspaceRegistry.archivedSessionIds.push('target')
  assert.equal((await f.relay.list(f.sender)).sessions.find(row => row.session_id === 'target').archived, true)
  await assert.rejects(f.relay.send(f.sender, f.request), hasCode('ARCHIVED_TARGET'))
  f.ctx.workspaceRegistry.archivedSessionIds.length = 0
  f.ctx.remoteAccess.allows = resource => resource.id !== 'target'
  await assert.rejects(f.relay.send(f.sender, f.request), hasCode('OUT_OF_SCOPE'))
  assert.equal(f.calls.sends.length, 0)
  assert.equal(f.calls.resolves, 0)
})

test('delivery status reports native cancellation and prevents a cancelled retry from appearing pending', async () => {
  const f = fixture()
  assert.equal((await f.relay.status(f.sender, f.request)).delivery_status, 'not-found')
  await f.relay.send(f.sender, f.request)
  assert.equal((await f.relay.status(f.sender, f.request)).delivery_status, 'pending')
  f.target.session.events.push({ type: 'agent/inbox/spliced', seq: 1, data: {
    target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
  } })
  assert.equal((await f.relay.status(f.sender, f.request)).delivery_status, 'cancelled')
  await assert.rejects(f.relay.send(f.sender, f.request), hasCode('DELIVERY_CANCELLED'))
  assert.equal(f.calls.sends.length, 1)
})
