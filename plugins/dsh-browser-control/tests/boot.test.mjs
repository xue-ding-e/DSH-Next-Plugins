// Modified 2026-11-05: verify the six supported tools and exclude screenshots.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { apply } from '../lib/index.js'

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function hostFixture() {
  const tools = new Map()
  const routes = new Map()
  const disposers = []
  const webServer = { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } }
  const connection = {
    admit() { return { peer: { principal: { kind: 'owner' } } } },
  }
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    effect(install) { const dispose = install(); if (dispose) disposers.push(dispose) },
    connection,
    get(service) { return service === 'webServer' ? webServer : undefined },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, { enabled: true })
  return { ctx, tools, routes, dispose() { for (const dispose of disposers.reverse()) dispose() } }
}

/** Minimal node request/response pair for one channel call. */
function channelCall(route, endpoint, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'rpc-test', method: endpoint, payload })
  const req = {
    method: 'POST',
    url: `/tool-sidebar-browser/${endpoint}`,
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
  return new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(code) { this.status = code; return this },
      end(text) { resolve({ status: this.status, body: text === undefined ? undefined : JSON.parse(text) }) },
    }
    route.handler(req, res)
    // A long poll answers asynchronously; the promise above settles when it does.
  })
}

test('the shipped client registers through the classic-script module loader', () => {
  const modules = []
  new Script(clientSource, { filename: 'dsh-browser-control/client.js' }).runInNewContext({
    window: { __ModuleLoader__: { load(module) { modules.push(module) } } },
  })
  assert.equal(modules.length, 1)
  assert.equal(modules[0].id, 'dsh-browser-control')
  const plugin = modules[0].factory()
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(Array.from(plugin.inject).join(','), 'connection')
})

test('all six model-facing tools declare object JSON schemas', () => {
  const { tools, dispose } = hostFixture()
  assert.equal(tools.size, 6)
  for (const definition of tools.values()) {
    assert.equal(definition.parameters.type, 'object', definition.name)
    assert.ok(definition.parameters.properties, definition.name)
  }
  assert.deepEqual(tools.get('browser_goto').parameters.required, ['url'])
  assert.deepEqual(tools.get('browser_fill').parameters.required, ['value'])
  assert.deepEqual(tools.get('browser_eval').parameters.required, ['expression'])
  dispose()
  assert.equal(tools.size, 0)
})

test('the installed Harness accepts all input and output schemas', { skip: !process.env.DSH_TEST_RUNTIME }, async () => {
  const runtime = pathToFileURL(join(process.env.DSH_TEST_RUNTIME, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href
  const { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } = await import(runtime)
  const { tools, dispose } = hostFixture()
  for (const definition of tools.values()) {
    assertObjectJsonSchema(definition.parameters)
    assertSupportedJsonSchema(definition.output.schema)
  }
  const goto = tools.get('browser_goto').parameters
  assert.ok(validateJsonSchemaValue(goto, {}).length > 0)
  assert.deepEqual(validateJsonSchemaValue(goto, { url: 'https://example.test' }), [])
  assert.ok(validateJsonSchemaValue(tools.get('browser_fill').parameters, {}).length > 0)
  dispose()
})

test('the unavailable screenshot tool is not offered to the model or renderer', t => {
  const { tools, dispose } = hostFixture()
  t.after(dispose)
  assert.equal(tools.has('browser_screenshot'), false)
  assert.ok([...tools.values()].every(tool => !/screenshot|截图/iu.test(tool.description)))
  assert.ok(!clientSource.includes("case 'screenshot':"))
})

test('the status endpoint reports whether the page half is attached', async t => {
  const { routes, dispose } = hostFixture()
  t.after(dispose)
  const route = routes.get('/tool-sidebar-browser')
  assert.ok(route, 'channel route is registered')
  const result = await channelCall(route, 'status', {})
  assert.equal(result.status, 200)
  assert.equal(result.body.channel, '/tool-sidebar-browser')
  assert.equal(result.body.pageAttached, false)
  assert.equal(result.body.polls, 0)
  assert.equal(result.body.resolves, 0)
})

test('the read-only diagnostics route answers without page authority', async t => {
  const { routes, dispose } = hostFixture()
  t.after(dispose)
  // The channel itself is behind connection.admit; this sibling route exists so
  // "is the page half attached" can be answered without a signed-in session.
  const route = routes.get('/tool-sidebar-browser-diagnostics')
  assert.ok(route, 'diagnostics route is registered')

  let status
  let body
  await route.handler({ method: 'GET' }, {
    writeHead(code) { status = code },
    end(value) { body = value },
  })
  assert.equal(status, 200)
  const parsed = JSON.parse(body)
  assert.equal(parsed.channel, '/tool-sidebar-browser')
  assert.equal(parsed.pageAttached, false)
  assert.equal(parsed.polls, 0)
  // It reports the offered tools so a missing registration is visible.
  assert.deepEqual(parsed.toolsRegistered, [
    'browser_goto', 'browser_snapshot', 'browser_click', 'browser_fill',
    'browser_read_text', 'browser_eval',
  ])
})
