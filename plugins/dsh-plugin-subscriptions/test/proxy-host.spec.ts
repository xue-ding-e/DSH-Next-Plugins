import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import { proxiedFetch, proxySetConfig, proxyTestConnection, resetProxyForTests } from '../src/http.js'

test('disabled and bypassed plugin proxy preserve the host global dispatcher, including probes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subscriptions-proxy-host-'))
  const previousHome = process.env.DSH_HOME
  const previousDispatcher = getGlobalDispatcher()
  const host = new MockAgent()
  host.disableNetConnect()
  process.env.DSH_HOME = dir
  await resetProxyForTests()
  setGlobalDispatcher(host)
  try {
    const target = 'https://subscriptions.example'
    const pool = host.get(target)
    for (const bypass of [false, true]) {
      await proxySetConfig({ enabled: bypass, url: 'http://127.0.0.1:1', bypass: ['subscriptions.example'] })
      pool.intercept({ path: '/', method: 'GET' }).reply(200, 'host-routed')
      assert.equal(await (await proxiedFetch(target)).text(), 'host-routed')
      pool.intercept({ path: '/', method: 'GET' }).reply(204)
      const probe = await proxyTestConnection(target)
      assert.equal(probe.ok, true)
      assert.equal(probe.status, 204)
      assert.equal(probe.viaProxy, false, 'means no plugin override, not direct transport')
      assert.equal(getGlobalDispatcher(), host, 'plugin must not replace the host dispatcher')
    }
    host.assertNoPendingInterceptors()
  } finally {
    await resetProxyForTests()
    setGlobalDispatcher(previousDispatcher)
    await host.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  }
})
