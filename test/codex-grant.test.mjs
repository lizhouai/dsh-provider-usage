/**
 * Regression tests for Codex OAuth grant resolution (`src/openai-codex.ts`).
 *
 * The defect these lock down: the resolver used to read the grant, refresh it
 * over the network, and only then call `modifyRecord` — and it swallowed a
 * failed write. Because the refresh token is single-use upstream, a lost write
 * destroyed the rotation permanently, and because the adapter retries a 401 by
 * resolving the grant again, one attempt could spend the same refresh token
 * twice. The store fake below models the real seam (`dsh-credentials-local`):
 * `readRecord` answers from an in-memory snapshot without the lock, while
 * `modifyRecord` serializes read-decide-replace behind an exclusive queue.
 *
 * Run with `pnpm test` (Node's built-in test runner, TypeScript stripped).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OpenAiCodexReauthRequiredError,
  openAiCodexGrantNeedsRefresh,
  resolveOpenAiCodexGrant,
} from '../src/openai-codex.ts'

const KEY = 'llm-pi-ai/openai-codex'
const grantRecord = (grant) => ({ kind: 'grant', payload: grant })

/** A three-part token whose middle segment carries the ChatGPT account id. */
function accessToken(accountId) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${segment({ alg: 'none' })}.${segment({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.signature`
}

const grant = ({ refresh = 'rt.old', expiresInMs = -1_000, access = accessToken('acct_1') } = {}) => ({
  type: 'oauth',
  access,
  refresh,
  expires: Date.now() + expiresInMs,
  accountId: 'acct_1',
})

/**
 * Credentials seam fake. `snapshot` is what a lock-free `readRecord` answers;
 * it may lag behind `current`, exactly as a stale read does before another
 * writer takes the lock.
 */
function createStore(initial) {
  let current = initial
  let snapshot = initial
  let tail = Promise.resolve()
  let modifyCalls = 0
  return {
    get current() {
      return current
    },
    set current(next) {
      current = next
      snapshot = next
    },
    /** Simulate a read taken before another writer committed. */
    stale(value) {
      snapshot = value
    },
    get modifyCalls() {
      return modifyCalls
    },
    readRecord: async () => snapshot,
    modifyRecord: (_key, mutate) => {
      const run = tail.then(async () => {
        modifyCalls += 1
        const next = await mutate(current)
        if (next !== undefined) {
          current = next
          snapshot = next
        }
        return current
      })
      tail = run.then(
        () => {},
        () => {},
      )
      return run
    },
  }
}

/** Replace `globalThis.fetch` for one test, recording every token-endpoint call. */
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? '')) })
    return handler(calls.length, init)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

const tokenResponse = ({ access = accessToken('acct_1'), refresh = 'rt.new', expiresIn = 3600 } = {}) =>
  new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const reusedResponse = () =>
  new Response(
    JSON.stringify({
      error: {
        message: 'Your refresh token has already been used to generate a new access token. Please try signing in again.',
        type: 'invalid_request_error',
        code: 'refresh_token_reused',
      },
    }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  )

test('a grant that is still valid is used as-is: no network, no write', async () => {
  const store = createStore(grantRecord(grant({ expiresInMs: 3_600_000 })))
  const fetchStub = stubFetch(() => assert.fail('the token endpoint must not be called'))
  try {
    const resolved = await resolveOpenAiCodexGrant(store, KEY, grantRecord, new AbortController().signal)
    assert.equal(resolved.access, store.current.payload.access)
    assert.equal(fetchStub.calls.length, 0)
    assert.equal(store.modifyCalls, 0)
  } finally {
    fetchStub.restore()
  }
})

test('no record resolves to undefined without touching the network', async () => {
  const store = createStore(undefined)
  const fetchStub = stubFetch(() => assert.fail('the token endpoint must not be called'))
  try {
    assert.equal(await resolveOpenAiCodexGrant(store, KEY, grantRecord, new AbortController().signal), undefined)
    assert.equal(fetchStub.calls.length, 0)
  } finally {
    fetchStub.restore()
  }
})

test('an expiring grant is rotated against the stored refresh token and persisted', async () => {
  const store = createStore(grantRecord(grant()))
  const rotated = accessToken('acct_2')
  const fetchStub = stubFetch(() => tokenResponse({ access: rotated, refresh: 'rt.new' }))
  try {
    const before = Date.now()
    const resolved = await resolveOpenAiCodexGrant(store, KEY, grantRecord, new AbortController().signal)

    assert.equal(fetchStub.calls.length, 1)
    assert.equal(fetchStub.calls[0].body.get('refresh_token'), 'rt.old')
    assert.equal(fetchStub.calls[0].body.get('grant_type'), 'refresh_token')
    assert.equal(resolved.access, rotated)
    // The rotation reached the store, and the settled record is what is returned.
    assert.equal(store.current.payload.access, rotated)
    assert.equal(store.current.payload.refresh, 'rt.new')
    assert.equal(store.modifyCalls, 1)
    assert.equal(openAiCodexGrantNeedsRefresh(store.current.payload, before), false)
  } finally {
    fetchStub.restore()
  }
})

test('concurrent resolutions spend one single-use refresh token exactly once', async () => {
  // Two pollers (the panel's interval and a manual refresh, or two processes)
  // both observe the same expired grant.
  const store = createStore(grantRecord(grant()))
  const rotated = accessToken('acct_2')
  const fetchStub = stubFetch((call) => (call === 1 ? tokenResponse({ access: rotated, refresh: 'rt.new' }) : reusedResponse()))
  try {
    const [first, second] = await Promise.all([
      resolveOpenAiCodexGrant(store, KEY, grantRecord, new AbortController().signal),
      resolveOpenAiCodexGrant(store, KEY, grantRecord, new AbortController().signal),
    ])

    assert.equal(fetchStub.calls.length, 1, 'the second resolver must not spend the consumed refresh token')
    assert.equal(first.access, rotated)
    assert.equal(second.access, rotated, 'the loser of the race must read the committed rotation')
    assert.equal(store.current.payload.refresh, 'rt.new')
  } finally {
    fetchStub.restore()
  }
})

test('a grant another writer already rotated is adopted, never refreshed again', async () => {
  const fresh = grant({ refresh: 'rt.other', expiresInMs: 3_600_000, access: accessToken('acct_9') })
  const store = createStore(grantRecord(fresh))
  // The lock-free read still sees the expired grant this call decided on.
  store.stale(grantRecord(grant({ refresh: 'rt.old' })))
  const fetchStub = stubFetch(() => assert.fail('the token endpoint must not be called'))
  try {
    const resolved = await resolveOpenAiCodexGrant(store, KEY, grantRecord, new AbortController().signal)
    assert.equal(resolved.refresh, 'rt.other')
    assert.equal(fetchStub.calls.length, 0)
    assert.equal(store.modifyCalls, 1, 'the decision is re-judged inside the lock')
    assert.equal(store.current.payload.refresh, 'rt.other')
  } finally {
    fetchStub.restore()
  }
})

test('refresh_token_reused surfaces as a re-auth error and leaves the record intact', async () => {
  const store = createStore(grantRecord(grant()))
  const fetchStub = stubFetch(() => reusedResponse())
  try {
    await assert.rejects(
      resolveOpenAiCodexGrant(store, KEY, grantRecord, new AbortController().signal),
      (error) => {
        assert.ok(error instanceof OpenAiCodexReauthRequiredError)
        assert.equal(error.code, 'OPENAI_CODEX_REAUTH_REQUIRED')
        assert.equal(error.refreshToken, 'rt.old')
        // The upstream detail used to be dropped entirely (it is a nested object).
        assert.match(error.message, /already been used/)
        assert.match(error.message, /refresh_token_reused/)
        assert.match(error.message, /HTTP 401/)
        return true
      },
    )
    // Nothing was half-written: the record still holds what it held before.
    assert.equal(store.current.payload.refresh, 'rt.old')
    assert.equal(store.modifyCalls, 1)
  } finally {
    fetchStub.restore()
  }
})

test('a failed write propagates instead of reporting success', async () => {
  // The consumed refresh token is lost either way — no local transaction can
  // span the network — but the caller must see the failure rather than a
  // healthy panel drawn over a dead grant.
  const store = createStore(grantRecord(grant()))
  store.modifyRecord = async () => {
    throw new Error('atomic-write: timed out waiting for the writer lock at ~/.dsh/.credentials.yaml.lock')
  }
  const fetchStub = stubFetch(() => tokenResponse())
  try {
    await assert.rejects(
      resolveOpenAiCodexGrant(store, KEY, grantRecord, new AbortController().signal),
      /timed out waiting for the writer lock/,
    )
  } finally {
    fetchStub.restore()
  }
})

test('a malformed grant is treated as no authorization', async () => {
  const store = createStore({ kind: 'grant', payload: { type: 'oauth', access: accessToken('acct_1'), refresh: 'rt.old' } })
  const fetchStub = stubFetch(() => assert.fail('the token endpoint must not be called'))
  try {
    assert.equal(await resolveOpenAiCodexGrant(store, KEY, grantRecord, new AbortController().signal), undefined)
  } finally {
    fetchStub.restore()
  }
})
