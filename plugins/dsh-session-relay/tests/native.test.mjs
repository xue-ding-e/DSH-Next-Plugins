/** Keyless integration against an explicitly selected, already-built Harness checkout. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const hostRoot = process.env.DSH_RELAY_TEST_HOST
const hostUrl = path => pathToFileURL(join(hostRoot, path)).href
if (hostRoot) registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@deepseek-ai/dsh-session'
      ? { url: hostUrl('packages/core/session/lib/index.js'), shortCircuit: true }
      : next(specifier, context)
  },
})

/** Core routing, observation and JSONL are production services; model and owner inputs are fixtures. */
async function setup(t, adapterFactory) {
  const modules = await Promise.all([
    'vendor/cordis/lib/index.js', 'vendor/loader/lib/index.js',
    'packages/test-support/agent-loop-testkit/lib/index.js', 'packages/core/agent-loop/lib/index.js',
    'packages/session/session-persistence-jsonl/lib/index.js', 'packages/session-query/session-query/lib/index.js',
    'packages/api/session-controller/lib/types/agent.js', 'packages/llm/llm/lib/index.js',
  ].map(path => import(hostUrl(path))))
  const [{ Context }, { Loader }, testkit, { default: AgentLoop }, persistence,
    { SessionQueryEngine }, { ApiSessionAgentController }, llm] = modules
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-relay-'))
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    assert.equal(resolve(dirname(root)), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  await testkit.mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(persistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  class Query extends SessionQueryEngine {
    searchSessions() { throw new Error('No full-text search in this fixture') }
    searchEvents() { throw new Error('No full-text search in this fixture') }
  }
  await ctx.plugin(Query)
  const adapter = adapterFactory(llm.LlmAdapter)
  ctx.llm.registerAdapter(['relay-fixture'], adapter)
  const selection = { provider: 'relay-fixture', model: 'fixture-model' }
  ctx.provide('agentDefaultModel', { currentSelection: () => selection })
  ctx.provide('remoteAccess', { allows: () => true })
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
  const controller = new ApiSessionAgentController(ctx)
  ctx.provide('sessionController', {
    resolveAgent: id => controller.resolveAgent(id),
    async list() {
      return { items: (await ctx.sessionQuery.listSessions()).map(record => ({
        ...record.header, sessionId: record.header.id,
        updatedAt: record.header.createdAt, running: ctx.agents.get(record.header.id)?.status === 'running',
        agentAvailable: ctx.agents.get(record.header.id) !== undefined,
      })) }
    },
  })
  const loader = new Loader(ctx)
  const pluginUrl = process.env.DSH_RELAY_TEST_PACKAGE
    ? pathToFileURL(join(process.env.DSH_RELAY_TEST_PACKAGE, 'lib', 'index.js')).href
    : new URL('../lib/index.js', import.meta.url).href
  // JSON is a YAML subset; the Loader receives entries parsed from an actual isolated cordis.yml.
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([{ id: 'relay', name: pluginUrl, config: {} }]))
  await loader.root.update(JSON.parse(await readFile(configPath, 'utf8')))
  await loader.await()
  assert.ok(ctx.tools.get('send_message_to_session'), 'Loader must activate the shipped plugin')
  const sender = await ctx.agents.create({ sessionId: 'relay-sender', agentOptions: selection, meta: { cwd: root } })
  const target = await ctx.agents.create({ sessionId: 'relay-target', agentOptions: selection, meta: { cwd: root } })
  const exec = { agent: sender.agent, signal: new AbortController().signal }
  const call = async (name, args) => JSON.parse((await ctx.tools.get(name).execute(args, exec)).json)
  return { ctx, loader, sender, target, adapter, call, llm }
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(name, args, id = 'native-tool') {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const options = { skip: !hostRoot && 'Set DSH_RELAY_TEST_HOST to a built Harness checkout', timeout: 30000 }

test('real Loader, inbox and JSONL preserve source and deduplicate across cold native resume', options, async t => {
  const f = await setup(t, Base => new class extends Base {
    requests = []
    async *stream(request) { this.requests.push(request); yield* textChunks('Native recipient confirmed.') }
  }())
  const request = { session_id: 'relay-target', request_id: 'native-progress-1', message: '跨会话构建通过 😀' }
  const receipt = await f.call('send_message_to_session', request)
  assert.equal(receipt.durable, true)
  assert.equal(f.target.agent.status, 'idle')
  assert.equal(f.adapter.requests.length, 0)
  assert.equal(f.target.agent.inbox.nextStep.length, 1)
  assert.equal((await f.call('get_session_delivery', request)).delivery_status, 'pending')
  await f.call('send_message_to_session', { ...request, request_id: 'native-first-wakeup', delivery: 'queue', message: 'Process the pending update.' })
  await f.target.agent.whenIdle()
  assert.equal(f.adapter.requests.length, 1)
  assert.match(JSON.stringify(f.adapter.requests[0].messages), /跨会话构建通过/)
  assert.equal((await f.call('get_session_delivery', request)).delivery_status, 'consumed')
  await f.target.dispose()
  assert.equal(f.ctx.agents.get('relay-target'), undefined)
  assert.equal((await f.call('send_message_to_session', request)).duplicate, true)
  assert.equal(f.ctx.agents.get('relay-target'), undefined, 'a stored retry needs no activation')
  const queued = await f.call('send_message_to_session', { ...request, request_id: 'native-wakeup', delivery: 'queue', message: 'Process the pending update.' })
  assert.equal(queued.duplicate, false)
  const resumed = f.ctx.agents.get('relay-target')
  assert.ok(resumed)
  await resumed.whenIdle()
  assert.equal(f.adapter.requests.length, 2)
  const page = await f.call('read_session', { session_id: 'relay-target' })
  assert.equal(page.messages.filter(message => message.source === 'agent-message').length, 3)
  assert.equal(page.messages.at(-1).text, 'Native recipient confirmed.')
  assert.equal(page.messages.some(message => message.source === 'runtime-context'), false)
  assert.equal((await f.call('send_message_to_session', request)).duplicate, true)
  assert.equal(f.adapter.requests.length, 2)
  const cancelTarget = await f.ctx.agents.create({ sessionId: 'relay-cancel', agentOptions: f.sender.agent.options, meta: { cwd: f.sender.agent.session.header.cwd } })
  const cancelled = { ...request, session_id: 'relay-cancel' }
  await f.call('send_message_to_session', cancelled)
  await cancelTarget.dispose()
  assert.equal((await f.call('get_session_delivery', cancelled)).delivery_status, 'cancelled')
  await assert.rejects(f.call('send_message_to_session', cancelled), error => error.code === 'DELIVERY_CANCELLED')
  const pluginFiber = f.loader.store.relay.fiber
  await pluginFiber.dispose()
  assert.equal(f.ctx.tools.get('send_message_to_session'), undefined)
})

test('a real model tool call sends to an independent chat with the originating agent identity', options, async t => {
  const args = { session_id: 'relay-target', request_id: 'model-tool-1', message: 'Model-authored progress update.' }
  const f = await setup(t, Base => new class extends Base {
    requests = []
    async *stream(request) {
      this.requests.push(request)
      if (request.messages.some(message => message.role === 'tool')) {
        yield* textChunks('Progress delivered.')
        return
      }
      yield* toolChunks('send_message_to_session', args, 'native-send-1')
    }
  }())
  f.sender.agent.steer(f.llm.createUserMessage({ content: [{ type: 'text', text: 'Send the progress update to the other chat.' }], source: { kind: 'user' } }))
  await f.sender.agent.whenIdle()
  assert.equal(f.adapter.requests.length, 2)
  const toolResult = f.adapter.requests[1].messages.find(message => message.role === 'tool')
  assert.equal(toolResult.isError, false)
  assert.match(JSON.stringify(toolResult.content), /durable/)
  assert.equal(f.target.agent.status, 'idle')
  assert.equal(f.target.agent.inbox.nextStep.length, 1)
  assert.equal(f.target.agent.inbox.nextStep[0].source.senderSessionId, f.sender.agent.id)
  assert.equal((await f.call('get_session_delivery', args)).delivery_status, 'pending')
})

test('native tool failure retains the recovery code in the model-visible errored result', options, async t => {
  const args = { session_id: 'relay-target', request_id: 'oversized-1', message: '中'.repeat(12000) }
  const f = await setup(t, Base => new class extends Base {
    requests = []
    async *stream(request) {
      this.requests.push(request)
      yield* request.messages.some(message => message.role === 'tool')
        ? textChunks('Delivery refused.') : toolChunks('send_message_to_session', args)
    }
  }())
  f.sender.agent.steer(f.llm.createUserMessage({ content: [{ type: 'text', text: 'Report the oversized message.' }], source: { kind: 'user' } }))
  await f.sender.agent.whenIdle()
  const failure = f.adapter.requests[1].messages.find(message => message.role === 'tool')
  assert.equal(failure.isError, true)
  assert.match(JSON.stringify(failure.content), /MESSAGE_TOO_LARGE/)
  assert.equal(f.target.agent.inbox.nextStep.length, 0)
})

test('steering a working recipient joins its current turn at the next native step', options, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const f = await setup(t, Base => new class extends Base {
    requests = []
    async *stream(request) {
      this.requests.push(request)
      yield* this.requests.length === 1 ? toolChunks('fixture_checkpoint', {}) : textChunks('Steering received.')
    }
  }())
  const unregister = f.ctx.tools.register({
    name: 'fixture_checkpoint', description: 'Controlled fixture checkpoint.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'checkpoint released' }] },
    async execute() { entered.resolve(); await release.promise; return true },
  })
  t.after(unregister)
  f.target.agent.steer(f.llm.createUserMessage({ content: [{ type: 'text', text: 'Start the checkpoint.' }], source: { kind: 'user' } }))
  await entered.promise
  await f.call('send_message_to_session', {
    session_id: 'relay-target', request_id: 'working-steer-1', message: 'Please incorporate this update.', delivery: 'steer',
  })
  release.resolve()
  await f.target.agent.whenIdle()
  assert.equal(f.adapter.requests.length, 2)
  assert.match(JSON.stringify(f.adapter.requests[1].messages), /Please incorporate this update/)
  const observation = await f.ctx.sessionQuery.observeSession('relay-target', { projectionMode: 'none' })
  try { assert.equal(observation.events.filter(event => event.type === 'turn/start').length, 1) }
  finally { observation[Symbol.dispose]() }
})
