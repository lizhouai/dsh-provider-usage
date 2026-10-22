/** Adapter regression tests through the real service with offline HTTP responses. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

const CONFIG = {
  refreshSeconds: 60,
  balanceRedThreshold: 10,
  balanceYellowThreshold: 30,
  autoDetect: true,
  queryTimeoutMs: 5000,
  queryRetries: 0,
  queryRetryDelayMs: 1000,
  providers: [],
}

const BILLING = {
  windowLimits: { fiveHour: { used: 2, cap: 10 }, weekly: { used: 3, cap: 20 } },
  credits: { monthlyCredits: 50, purchasedCredits: 7, freeCredits: 3 },
}
const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
})

async function listProvider(t, route, reply) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), headers: init.headers })
    return reply(String(url))
  })
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [{ id: route, name: route }],
    listConfigurableProviders: () => [],
  })
  ctx.provide('settings', { get: async () => undefined })
  ctx.provide('credentials', {
    readRecord: async () => undefined,
    modifyRecord: async () => undefined,
    resolve: async () => ({ value: 'test-provider-key' }),
  })
  ctx.provide('logger', { warn: () => {} })
  apply(ctx, CONFIG)
  const result = await ctx.usage.list()
  return { provider: result.providers[0], calls }
}

test('Command Code is detected and sends billing and summary data to the panel', async (t) => {
  const { provider, calls } = await listProvider(t, 'commandcode', (url) =>
    jsonResponse(url.endsWith('/billing/credits') ? BILLING : { totalCredits: 40 }))
  assert.equal(provider.id, 'commandcode')
  assert.equal(provider.status, 'ok')
  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.commandcode.ai/alpha/billing/credits',
    'https://api.commandcode.ai/alpha/usage/summary',
  ])
  assert.ok(calls.every((call) => call.headers.authorization === 'Bearer test-provider-key'))
  assert.deepEqual(provider.usages.map((row) => row.label), ['5h limit', 'weekly', 'monthly credits'])
  assert.equal(provider.usages[2].used, 40)
  assert.equal(provider.usages[2].remaining, 60)
  assert.equal(provider.usages[2].percent, 40)
})

for (const [name, summary] of [
  ['HTTP 200 empty body', () => new Response('', { status: 200 })],
  ['HTTP 200 non-JSON body', () => new Response('<html>unavailable</html>', { status: 200 })],
  ['HTTP 500', () => new Response('unavailable', { status: 500 })],
  ['network failure', () => { throw new TypeError('fetch failed') }],
]) {
  test(`Command Code preserves billing when the optional summary has ${name}`, async (t) => {
    const { provider } = await listProvider(t, 'commandcode', (url) =>
      url.endsWith('/billing/credits') ? jsonResponse(BILLING) : summary())
    assert.equal(provider.status, 'ok')
    assert.equal(provider.message, null)
    assert.deepEqual(provider.usages.map((row) => row.label), ['5h limit', 'weekly', 'monthly credits'])
    assert.deepEqual(provider.usages.slice(0, 2).map((row) => row.remaining), [8, 17])
    assert.equal(provider.usages[2].remaining, 60)
    assert.equal(provider.usages[2].used, null)
    assert.equal(provider.usages[2].limit, null)
  })
}

test('a Command Code billing failure remains a visible error and skips the summary', async (t) => {
  const { provider, calls } = await listProvider(t, 'commandcode', () => new Response('', { status: 401 }))
  assert.equal(provider.status, 'error')
  assert.match(provider.message, /HTTP 401/)
  assert.equal(provider.usages, null)
  assert.equal(calls.length, 1)
})

test('z.ai credit windows retain periods, ordering, and raw-key authorization at the service boundary', async (t) => {
  const { provider, calls } = await listProvider(t, 'zai', () => jsonResponse({
    success: true,
    data: { limits: [
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 20, nextResetTime: 1793401200000 },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, nextResetTime: 1793402200000 },
      { type: 'TOKENS_LIMIT', unit: 3, number: 168, percentage: 30, nextResetTime: 1793491200000 },
    ] },
  }))
  assert.equal(provider.status, 'ok')
  assert.equal(calls[0].url, 'https://api.z.ai/api/monitor/usage/quota/limit')
  assert.equal(calls[0].headers.authorization, 'test-provider-key')
  assert.deepEqual(provider.usages.map(({ label, percent }) => [label, percent]), [
    ['5h limit', 10], ['weekly', 30], ['1mo limit', 20],
  ])
})
