/** Portable installs require a selected browser instead of a developer-machine binding. */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

function tools(config = {}) {
  const registered = new Map()
  const ctx = {
    tools: { register(tool) { registered.set(tool.name, tool); return () => {} } },
    effect(register) { return register() },
  }
  apply(ctx, { binary: process.execPath, binaryArgs: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))'], ...config })
  return registered
}

test('an unbound lifecycle start reports setup before running a CLI', async () => {
  const registered = tools({ binary: 'must-not-be-executed' })
  await assert.rejects(registered.get('bsk_session').execute({ action: 'start' }), /choose a browser/)
  await assert.rejects(registered.get('bsk').execute({ args: ['session', 'start'] }), /choose a browser/)
  await assert.rejects(registered.get('bsk').execute({ args: ['session', 'start', '--browser', ''] }), /choose a browser/)
})

test('an explicitly selected browser is forwarded without a machine-specific fallback', async () => {
  const result = await tools().get('bsk_session').execute({ action: 'start', browser: 'selected-browser' })
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(result.json), ['session', 'start', '--json', '--browser', 'selected-browser'])
})

test('a configured binding applies to session start but does not break session listing', async () => {
  const registered = tools({ browser: 'profile-browser' })
  const start = await registered.get('bsk').execute({ args: ['session', 'start', '--json'] })
  assert.deepEqual(JSON.parse(start.json), ['session', 'start', '--browser', 'profile-browser', '--json'])
  const list = await registered.get('bsk_session').execute({ action: 'list' })
  assert.deepEqual(JSON.parse(list.json), ['session', 'list', '--json'])
})

test('an explicit raw selector takes precedence over the profile binding', async () => {
  const result = await tools({ browser: 'profile-browser' }).get('bsk').execute({ args: ['session', 'start', '--browser=chosen-browser'] })
  assert.deepEqual(JSON.parse(result.json), ['session', 'start', '--browser=chosen-browser'])
})
