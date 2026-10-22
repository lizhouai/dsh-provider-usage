/** Regression coverage for the z.ai quota shapes described by the adapter. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseZaiUsage } from '../src/zai.ts'

const payload = (...limits) => ({ success: true, data: { limits } })
const window = (type, unit, number, percentage, nextResetTime) => ({ type, unit, number, percentage, nextResetTime })

test('a single monthly credit window keeps its reported period', () => {
  assert.deepEqual(parseZaiUsage(payload(window('CREDIT_LIMIT', 6, 1, 20, 1793491200000))), [{
    label: '1mo limit', used: 20, limit: 100, remaining: 80, percent: 20,
    resetAt: '2026-11-01T00:00:00.000Z',
  }])
})

test('a month resetting before the five-hour window cannot rename either window', () => {
  const rows = parseZaiUsage(payload(
    window('CREDIT_LIMIT', 6, 1, 25, 1793401200000),
    window('TOKENS_LIMIT', 3, 5, 10, 1793402200000),
  ))
  assert.deepEqual(rows.map(({ label, percent }) => [label, percent]), [['5h limit', 10], ['1mo limit', 25]])
})

test('a 168-hour window uses the weekly sentinel and precedes monthly extras', () => {
  const rows = parseZaiUsage(payload(
    window('CREDIT_LIMIT', 6, 1, 25, 1793401200000),
    window('TOKENS_LIMIT', 3, 168, 30, 1793491200000),
    window('TOKENS_LIMIT', 3, 5, 10, 1793402200000),
  ))
  assert.deepEqual(rows.map(({ label, percent }) => [label, percent]), [
    ['5h limit', 10], ['weekly', 30], ['1mo limit', 25],
  ])
})

test('other explicit hour and month spans are preserved, including numeric strings', () => {
  const rows = parseZaiUsage(payload(
    window('CREDIT_LIMIT', '3', '12', '40', 1793401200000),
    window('CREDIT_LIMIT', '6', '2', '70', 1793491200000),
  ))
  assert.deepEqual(rows.map(({ label, percent }) => [label, percent]), [['12h limit', 40], ['2mo limit', 70]])
})

test('legacy windows without period metadata retain reset-ordered fallback labels', () => {
  const rows = parseZaiUsage(payload(
    { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: 1793491200000 },
    { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: 1793401200000 },
    { type: 'CREDIT_LIMIT', percentage: 50 },
  ))
  assert.deepEqual(rows.map(({ label, percent }) => [label, percent]), [
    ['5h limit', 10], ['weekly', 30], ['limit 3', 50],
  ])
})

test('missing, non-positive, or unsupported period metadata uses the legacy fallback', () => {
  const rows = parseZaiUsage(payload(
    window('CREDIT_LIMIT', 6, undefined, 10, 1793401200000),
    window('CREDIT_LIMIT', 3, 0, 20, 1793402200000),
    window('CREDIT_LIMIT', 3, -1, 30, 1793403200000),
    window('CREDIT_LIMIT', 99, 1, 40, 1793404200000),
  ))
  assert.deepEqual(rows.map((row) => row.label), ['5h limit', 'weekly', 'limit 3', 'limit 4'])
})

test('both quota types are retained, while MCP and unknown entries are ignored', () => {
  const rows = parseZaiUsage(payload(
    window('TIME_LIMIT', 3, 5, 99, 1793400200000),
    null,
    window('UNKNOWN_LIMIT', 3, 1, 90, 1793400200000),
    window('TOKENS_LIMIT', 3, 5, 0, 1793401200000),
    window('CREDIT_LIMIT', 6, 1, 20, 1793491200000),
  ))
  assert.deepEqual(rows.map(({ label, percent }) => [label, percent]), [['5h limit', 0], ['1mo limit', 20]])
})

test('unparseable percentages are skipped without coercing them to zero', () => {
  const rows = parseZaiUsage(payload(
    window('TOKENS_LIMIT', 3, 5, '', 1793401200000),
    window('CREDIT_LIMIT', 6, 1, 'not-a-number', 1793491200000),
    window('CREDIT_LIMIT', 6, 2, 0, 1796083200000),
  ))
  assert.deepEqual(rows.map(({ label, percent }) => [label, percent]), [['2mo limit', 0]])
})

test('missing quota containers produce no rows', () => {
  for (const body of [undefined, null, {}, { data: {} }, { data: { limits: {} } }]) {
    assert.deepEqual(parseZaiUsage(body), [])
  }
})

test('an explicit unsuccessful response retains the provider error message', () => {
  assert.throws(() => parseZaiUsage({ success: false, msg: 'expired key' }), /expired key/)
  assert.throws(() => parseZaiUsage({ success: false, message: 'not allowed' }), /not allowed/)
  assert.throws(() => parseZaiUsage({ success: false }), /z\.ai quota query failed/)
})

test('sorting quota rows does not reorder the response limits array', () => {
  const body = payload(
    window('CREDIT_LIMIT', 6, 1, 20, 1793491200000),
    window('TOKENS_LIMIT', 3, 5, 10, 1793401200000),
  )
  const original = structuredClone(body)
  parseZaiUsage(body)
  assert.deepEqual(body, original)
})
