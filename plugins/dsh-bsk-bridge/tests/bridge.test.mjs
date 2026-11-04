/**
 * Unit tests for the bsk bridge Host half.
 *
 * The plugin's whole job is shaping a CLI argument vector and normalising the
 * process result, so these tests drive `apply` against a fake context and a fake
 * `bsk` binary instead of the real daemon. That keeps them runnable with no
 * browser, no extension and no session.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../lib/index.js'

/**
 * Build a fake tool registry that records registrations.
 * @returns the fake context plus a name-to-definition map.
 */
function fakeContext() {
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(fn) {
      return fn()
    },
  }
  return { ctx, tools }
}

/**
 * Write a fake CLI as a plain `.mjs` and describe how to launch it.
 *
 * A `.cmd` shim cannot be spawned by `execFile` on Windows (`spawn EINVAL`), and
 * enabling `shell: true` to work around that would defeat the argument-array
 * safety the plugin relies on. The real `bsk` is an `.exe`, so production never
 * hits this; tests use the interpreter form the plugin supports via `binaryArgs`.
 * @param directory - temp directory to own the file.
 * @param body - script body.
 * @returns {{binary: string, binaryArgs: string[]}} launch description.
 */
function fakeBinary(directory, body) {
  const file = join(directory, 'bsk-fake.mjs')
  writeFileSync(file, body, 'utf8')
  return { binary: process.execPath, binaryArgs: [file] }
}

test('registers exactly two tools, so the schema surface stays flat', () => {
  const { ctx, tools } = fakeContext()
  apply(ctx, { enabled: true })
  assert.deepEqual([...tools.keys()].sort(), ['bsk', 'bsk_session'])
  assert.equal(name, 'dsh-bsk-bridge')
  assert.deepEqual(inject, ['tools'])
})

test('enabled:false registers nothing', () => {
  const { ctx, tools } = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(tools.size, 0)
})

test('passes the argument vector through untouched and returns JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsk-bridge-'))
  try {
    const binary = fakeBinary(dir, 'console.log(JSON.stringify({argv: process.argv.slice(2)}))\n')
    const { ctx, tools } = fakeContext()
    apply(ctx, { enabled: true, ...binary })
    const value = await tools.get('bsk').execute({ args: ['observe', '--session', 'abc'] }, {})
    assert.equal(value.ok, true)
    assert.deepEqual(JSON.parse(value.json).argv, ['observe', '--session', 'abc'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a non-zero exit is reported as a result, not thrown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsk-bridge-'))
  try {
    const binary = fakeBinary(dir, 'console.log(JSON.stringify({code:"invalid_params"})); process.exit(1)\n')
    const { ctx, tools } = fakeContext()
    apply(ctx, { enabled: true, ...binary })
    const value = await tools.get('bsk').execute({ args: ['nope'] }, {})
    assert.equal(value.ok, false)
    assert.match(value.error, /invalid_params/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an empty or non-string argument vector is rejected before spawning', async () => {
  const { ctx, tools } = fakeContext()
  apply(ctx, { enabled: true, binary: 'definitely-not-a-real-binary' })
  await assert.rejects(() => tools.get('bsk').execute({ args: [] }, {}), /non-empty array/)
  await assert.rejects(() => tools.get('bsk').execute({ args: ['ok', 7] }, {}), /must be a string/)
})

test('the pinned browser is applied to session start but never duplicated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsk-bridge-'))
  try {
    const binary = fakeBinary(dir, 'console.log(JSON.stringify({argv: process.argv.slice(2)}))\n')
    const { ctx, tools } = fakeContext()
    apply(ctx, { enabled: true, ...binary, browser: '90a7c4a3' })
    const session = tools.get('bsk_session')

    const pinned = await session.execute({ action: 'start' }, {})
    assert.deepEqual(
      JSON.parse(pinned.json).argv,
      ['session', 'start', '--json', '--browser', '90a7c4a3'],
    )

    const explicit = await session.execute({ action: 'start', browser: 'other' }, {})
    assert.deepEqual(
      JSON.parse(explicit.json).argv,
      ['session', 'start', '--json', '--browser', 'other'],
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stop needs a session id and passes it positionally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsk-bridge-'))
  try {
    const binary = fakeBinary(dir, 'console.log(JSON.stringify({argv: process.argv.slice(2)}))\n')
    const { ctx, tools } = fakeContext()
    apply(ctx, { enabled: true, ...binary })
    const session = tools.get('bsk_session')
    await assert.rejects(() => session.execute({ action: 'stop' }, {}), /needs a `session` id/)
    const stopped = await session.execute({ action: 'stop', session: 'qhul' }, {})
    assert.deepEqual(JSON.parse(stopped.json).argv, ['session', 'stop', 'qhul', '--json'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('state-changing subcommands are refused unless the operator opts in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsk-bridge-'))
  try {
    const binary = fakeBinary(dir, 'console.log("{}")\n')
    const { ctx, tools } = fakeContext()
    apply(ctx, { enabled: true, ...binary })
    await assert.rejects(() => tools.get('bsk').execute({ args: ['update'] }, {}), /changes this machine/)
    await assert.rejects(() => tools.get('bsk').execute({ args: ['daemon', 'stop'] }, {}), /changes this machine/)

    const allowed = fakeContext()
    apply(allowed.ctx, { enabled: true, ...binary, allowStateChanging: true })
    const value = await allowed.tools.get('bsk').execute({ args: ['update'] }, {})
    assert.equal(value.ok, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the pinned browser never leaks onto subcommands that reject it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsk-bridge-'))
  try {
    const binary = fakeBinary(dir, 'console.log(JSON.stringify({argv: process.argv.slice(2)}))\n')
    const { ctx, tools } = fakeContext()
    apply(ctx, { enabled: true, ...binary, browser: '90a7c4a3' })
    const bsk = tools.get('bsk')

    // bsk 0.4.1 rejects `--browser` on anything but `session start`, so injecting
    // it here would turn a valid call into a CLI parse error.
    const list = await bsk.execute({ args: ['session', 'list', '--json'] }, {})
    assert.deepEqual(JSON.parse(list.json).argv, ['session', 'list', '--json'])

    const observe = await bsk.execute({ args: ['observe', '--session', 'abc'] }, {})
    assert.deepEqual(JSON.parse(observe.json).argv, ['observe', '--session', 'abc'])

    const start = await bsk.execute({ args: ['session', 'start', '--json'] }, {})
    assert.deepEqual(
      JSON.parse(start.json).argv,
      ['session', 'start', '--browser', '90a7c4a3', '--json'],
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an oversized payload is clipped with an explicit notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsk-bridge-'))
  try {
    const binary = fakeBinary(dir, 'console.log("x".repeat(500))\n')
    const { ctx, tools } = fakeContext()
    apply(ctx, { enabled: true, ...binary, maxChars: 100 })
    const value = await tools.get('bsk').execute({ args: ['observe'] }, {})
    assert.equal(value.ok, true)
    assert.match(value.json, /truncated 400 characters/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('render emits the payload as text, and the failure path stays valid', () => {
  const { ctx, tools } = fakeContext()
  apply(ctx, { enabled: true })
  const definition = tools.get('bsk')
  assert.deepEqual(
    definition.output.render({}, { ok: true, json: '{"a":1}' }),
    [{ type: 'text', text: '{"a":1}' }],
  )
  assert.deepEqual(
    definition.output.render({}, { ok: false, error: 'boom' }),
    [{ type: 'text', text: '{"error":"boom"}' }],
  )
})
