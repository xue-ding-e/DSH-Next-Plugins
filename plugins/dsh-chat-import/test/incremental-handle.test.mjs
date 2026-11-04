import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendHostEvents } from '../lib/host-session.mjs'

const events = [{ seq: 1, time: 10, type: 'session/end-seed', data: {} }]

function context(handle, options = {}) {
  const calls = []
  const persistence = {
    formatVersion: 4,
    list: async () => [{ header: { id: 'import-probe', version: 4 } }],
    open: async (id, access) => {
      calls.push(['open', id, access])
      if (options.openFailure) throw options.openFailure
      return handle
    },
  }
  return { calls, persistence, get: name => name === 'sessionPersistence'
    ? persistence : name === 'agents' ? { get: () => options.live } : undefined }
}

test('incremental import appends, flushes and releases the current host write handle', async () => {
  const operations = []
  const ctx = context({
    append: async value => { operations.push(['append', value]) },
    flush: async () => { operations.push(['flush']) },
    close: async () => { operations.push(['close']) },
  })
  await appendHostEvents(ctx, 'import-probe', events)
  assert.deepEqual(ctx.calls, [['open', 'import-probe', 'write']])
  assert.deepEqual(operations, [['append', events], ['flush'], ['close']])
})

test('write ownership rejection does not attempt another write path', async () => {
  const failure = new Error('already owned by an active write handle')
  const ctx = context({}, { openFailure: failure })
  await assert.rejects(appendHostEvents(ctx, 'import-probe', events), error => error === failure)
  assert.equal(ctx.calls.length, 1)
})

test('a failed append still closes its handle and does not flush a rejected batch', async () => {
  const operations = []
  const failure = new Error('invalid event batch')
  const ctx = context({
    append: async () => { operations.push('append'); throw failure },
    flush: async () => { operations.push('flush') },
    close: async () => { operations.push('close') },
  })
  await assert.rejects(appendHostEvents(ctx, 'import-probe', events), error => error === failure)
  assert.deepEqual(operations, ['append', 'close'])
})

test('incremental import refuses a live conversation before opening persistence', async () => {
  const ctx = context({}, { live: { id: 'import-probe' } })
  await assert.rejects(appendHostEvents(ctx, 'import-probe', events), /unloaded conversation/)
  assert.deepEqual(ctx.calls, [])
})

test('legacy direct-write persistence receives the same prepared event batch', async () => {
  const operations = []
  const ctx = context({})
  delete ctx.persistence.open
  ctx.persistence.append = async (id, batch) => { operations.push([id, batch]) }
  await appendHostEvents(ctx, 'import-probe', events)
  assert.deepEqual(operations, [['import-probe', events]])
})
