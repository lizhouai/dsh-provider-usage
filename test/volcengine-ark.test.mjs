/**
 * Regression tests for the Volcengine Ark plan adapters (`src/volcengine-ark.ts`).
 *
 * Two things here are easy to get subtly wrong and impossible to notice from
 * the panel, so both are pinned against an external reference:
 *
 * - **The V4 signature.** A wrong canonical string or signing-key chain is a
 *   blanket 403 that looks like "the account has no plan". The expected
 *   signatures below were produced by the *official* Volcengine SDK
 *   (`@volcengine/openapi` 1.36.2, `lib/base/sign.js`) for the exact inputs in
 *   `GOLDEN`, so this implementation is checked against Volcengine's own
 *   signer rather than against a restatement of the same code.
 * - **The two payload shapes.** Agent Plan reports absolutes with an epoch-ms
 *   reset, Coding Plan reports percentages with an epoch-second reset, both
 *   use a non-positive number as the "no reset" sentinel, and an Agent Plan
 *   also carries an `AFPDaily` window that must not reach the panel. The
 *   fixtures are real response bodies.
 *
 * Run with `pnpm test` (Node's built-in test runner, TypeScript stripped).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_PLAN_ACTIONS,
  CODING_PLAN_ACTIONS,
  canonicalQuery,
  parseAgentPlanUsage,
  parseCodingPlanUsage,
  volcengineSignedRequest,
  volcengineTimestamp,
} from '../src/volcengine-ark.ts'

/** Inputs the golden signatures were generated from. */
const GOLDEN = {
  accessKeyId: 'AKLTgoldenvector0001',
  secretKey: 'Z29sZGVuLXNlY3JldC1rZXk=',
  date: new Date('2026-06-17T00:00:00Z'),
  bodySha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  signedHeaders: 'host;x-content-sha256;x-date',
  scope: '20260617/cn-beijing/ark/request',
}

test('timestamp uses the compact OpenTOP form', () => {
  assert.deepEqual(volcengineTimestamp(GOLDEN.date), { xDate: '20260617T000000Z', dateStamp: '20260617' })
})

test('canonical query sorts keys and escapes values', () => {
  assert.equal(canonicalQuery({ Version: '2024-01-01', Action: 'GetAFPUsage' }), 'Action=GetAFPUsage&Version=2024-01-01')
})

test('Agent Plan request matches the official SDK signature', () => {
  const request = volcengineSignedRequest({
    accessKeyId: GOLDEN.accessKeyId,
    secretKey: GOLDEN.secretKey,
    action: AGENT_PLAN_ACTIONS[0],
    date: GOLDEN.date,
  })
  assert.equal(request.url, 'https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01')
  assert.equal(request.headers['x-date'], '20260617T000000Z')
  assert.equal(request.headers['x-content-sha256'], GOLDEN.bodySha256)
  assert.equal(
    request.headers.authorization,
    `HMAC-SHA256 Credential=${GOLDEN.accessKeyId}/${GOLDEN.scope}, SignedHeaders=${GOLDEN.signedHeaders}, `
      + 'Signature=c9e729d57f9aad86f0ed84bb4f76fae8afa207ecdccf526ae455ac1550f7cb01',
  )
})

test('Coding Plan request matches the official SDK signature', () => {
  const request = volcengineSignedRequest({
    accessKeyId: GOLDEN.accessKeyId,
    secretKey: GOLDEN.secretKey,
    action: CODING_PLAN_ACTIONS[0],
    date: GOLDEN.date,
  })
  assert.equal(request.url, 'https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01')
  assert.equal(
    request.headers.authorization,
    `HMAC-SHA256 Credential=${GOLDEN.accessKeyId}/${GOLDEN.scope}, SignedHeaders=${GOLDEN.signedHeaders}, `
      + 'Signature=5724b7aef6347d26c4223a311bb37628e7c4e560806bb5f7d42c6821ded0cd12',
  )
})

test('a different secret yields a different signature', () => {
  const other = volcengineSignedRequest({
    accessKeyId: GOLDEN.accessKeyId,
    secretKey: 'another-secret',
    action: CODING_PLAN_ACTIONS[0],
    date: GOLDEN.date,
  })
  assert.notEqual(other.headers.authorization, volcengineSignedRequest({
    accessKeyId: GOLDEN.accessKeyId,
    secretKey: GOLDEN.secretKey,
    action: CODING_PLAN_ACTIONS[0],
    date: GOLDEN.date,
  }).headers.authorization)
})

/** Real `GetAFPUsage` body for an Agent Plan "medium" account. */
const AGENT_PLAN_BODY = {
  Result: {
    PlanType: 'medium',
    AFPFiveHour: { Quota: 10000, Used: 0, ResetTime: -1 },
    AFPWeekly: { Quota: 35000, Used: 8750, ResetTime: 1785686400000 },
    AFPMonthly: { Quota: 100000, Used: 25000, ResetTime: 1787846399000 },
    AFPDaily: { Quota: 50000, Used: 0, ResetTime: 1785340800000 },
  },
}

test('Agent Plan windows report absolutes with millisecond resets', () => {
  const rows = parseAgentPlanUsage(AGENT_PLAN_BODY)
  assert.deepEqual(rows.map((row) => row.label), ['5h limit', 'weekly', 'monthly'])

  const [fiveHour, weekly, monthly] = rows
  assert.deepEqual(fiveHour, { label: '5h limit', used: 0, limit: 10000, remaining: 10000, percent: 0, resetAt: null })
  assert.equal(weekly.used, 8750)
  assert.equal(weekly.limit, 35000)
  assert.equal(weekly.remaining, 26250)
  assert.equal(weekly.percent, 25)
  assert.equal(weekly.resetAt, '2026-08-02T16:00:00.000Z')
  assert.equal(monthly.percent, 25)
  assert.equal(monthly.resetAt, '2026-08-27T15:59:59.000Z')
})

test('Agent Plan never renders the daily window', () => {
  const labels = parseAgentPlanUsage(AGENT_PLAN_BODY).map((row) => row.label)
  assert.equal(labels.includes('daily'), false)
})

test('Agent Plan skips windows the plan does not carry', () => {
  assert.deepEqual(parseAgentPlanUsage({ Result: { AFPFiveHour: { Quota: 0, Used: 0, ResetTime: -1 } } }), [])
  assert.deepEqual(parseAgentPlanUsage({ Result: { PlanType: 'small' } }), [])
  assert.deepEqual(parseAgentPlanUsage(undefined), [])
})

test('Agent Plan treats a non-positive reset as absent', () => {
  const [row] = parseAgentPlanUsage({ Result: { AFPWeekly: { Quota: 100, Used: 1, ResetTime: 0 } } })
  assert.equal(row.resetAt, null)
})

/** Real `GetCodingPlanUsage` body for an active Coding Plan. */
const CODING_PLAN_BODY = {
  ResponseMetadata: { Action: 'GetCodingPlanUsage', Version: '2024-01-01', Service: 'ark', Region: 'cn-beijing' },
  Result: {
    Status: 'Running',
    UpdateTimestamp: 1782226444,
    QuotaUsage: [
      { Level: 'session', Percent: 0.116, ResetTimestamp: 1782226478 },
      { Level: 'weekly', Percent: 3.182143, ResetTimestamp: 1782662400 },
      { Level: 'monthly', Percent: 7.5730535, ResetTimestamp: 1782403199 },
    ],
  },
}

test('Coding Plan windows report percentages with second resets', () => {
  const rows = parseCodingPlanUsage(CODING_PLAN_BODY)
  assert.deepEqual(rows.map((row) => row.label), ['5h limit', 'weekly', 'monthly'])
  assert.deepEqual(rows[0], {
    label: '5h limit',
    used: 0.116,
    limit: 100,
    remaining: 99.884,
    percent: 0.116,
    resetAt: '2026-06-23T14:54:38.000Z',
  })
  assert.equal(rows[1].percent, 3.182143)
  assert.equal(rows[1].resetAt, '2026-06-28T16:00:00.000Z')
  assert.equal(rows[2].resetAt, '2026-06-25T15:59:59.000Z')
})

test('Coding Plan treats a non-positive reset as absent', () => {
  const rows = parseCodingPlanUsage({
    Result: { QuotaUsage: [{ Level: 'session', Percent: 12.5, ResetTimestamp: 0 }, { Level: 'weekly', Percent: 24, ResetTimestamp: -1 }] },
  })
  assert.deepEqual(rows.map((row) => row.resetAt), [null, null])
})

test('an inactive Coding Plan yields no rows rather than a parse failure', () => {
  assert.deepEqual(parseCodingPlanUsage({ Result: { Status: 'Reclaimed', UpdateTimestamp: 1785322689 } }), [])
  assert.deepEqual(parseCodingPlanUsage({ Result: { QuotaUsage: [] } }), [])
  assert.deepEqual(parseCodingPlanUsage(undefined), [])
})

test('Coding Plan keeps an unrecognized window name and its backend order', () => {
  const rows = parseCodingPlanUsage({
    Result: { QuotaUsage: [{ Level: 'hourly', Percent: 5, ResetTimestamp: 1782662400 }, { Level: '', Percent: 1, ResetTimestamp: -1 }] },
  })
  assert.deepEqual(rows.map((row) => row.label), ['hourly', 'limit'])
})
