/** Offline checks for session identity; cache hit rates require live evidence. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { deterministicSessionId } from '../src/providers/common.js'
import { CodexAdapter, CODEX_API_URL } from '../src/providers/codex.js'
import { GrokAdapter, GROK_API_URL } from '../src/providers/grok.js'
import { AccountTokenManager } from '../src/providers/accounts.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test('session header identity is deterministic and preserves existing UUIDs', () => {
  const first = deterministicSessionId('session-a')
  assert.equal(first, deterministicSessionId('session-a'))
  assert.notEqual(first, deterministicSessionId('session-b'))
  assert.match(first, UUID_RE)
  assert.equal(first[14], '8', 'custom deterministic layout uses UUIDv8')
  for (const id of ['123e4567-e89b-12d3-a456-426614174000', '123E4567-E89B-42D3-A456-426614174000']) {
    assert.equal(deterministicSessionId(id), id)
  }
})

test('missing and empty session IDs receive independent random UUIDs', () => {
  const ids = [undefined, undefined, '', ''].map(deterministicSessionId)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) {
    assert.match(id, UUID_RE)
    assert.equal(id[14], '4')
  }
})

for (const provider of ['codex', 'grok'] as const) {
  test(`${provider}: dispatch preserves the intended session and cache-key behavior`, async (t) => {
    const session = {
      accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
      expiresAt: Date.now() + 3_600_000, accountId: 'synthetic-account',
      tokenEndpoint: 'https://example.invalid/token',
    }
    const tokens = new AccountTokenManager({
      provider, displayName: 'Test',
      makeOptions: () => ({ preemptMs: 0, refresh: async () => session, isPermanent: () => false }),
      io: {
        list: async () => [{ key: 'acct', session }], get: async () => session,
        save: async () => {}, remove: async () => {},
      },
    })
    const settings = { models: [{ id: 'test-model', name: 'Test' }], tokens, discovery: false, streamIdleTimeoutMs: 1000 }
    const adapter = provider === 'codex' ? new CodexAdapter(settings) : new GrokAdapter(settings)
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n')
    })
    const ids = ['session-a', 'session-a', 'session-b', undefined, undefined, '', '']
    for (const id of ids) {
      const options: GenerateOptions = {
        provider, model: 'test-model',
        ...id === undefined ? {} : { sessionId: id as NonNullable<GenerateOptions['sessionId']> },
        messages: [{ id: MessageId('user'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
      }
      for await (const chunk of adapter.stream(options)) void chunk
    }
    assert.equal(calls.length, ids.length)
    for (const [index, call] of calls.entries()) {
      assert.equal(call.url, provider === 'codex' ? CODEX_API_URL : GROK_API_URL)
      assert.equal(call.body.prompt_cache_key, ids[index], 'body cache key keeps its existing semantics')
      assert.equal(call.headers.has('x-grok-conv-id'), false)
      if (provider === 'grok') assert.equal(call.headers.has('session-id'), false)
      else assert.match(call.headers.get('session-id')!, UUID_RE)
    }
    if (provider === 'codex') {
      const headers = calls.map(call => call.headers.get('session-id'))
      assert.equal(headers[0], headers[1])
      assert.notEqual(headers[0], headers[2])
      assert.equal(new Set(headers.slice(2)).size, 5, 'different and identity-less sessions stay distinct')
    }
  })
}
