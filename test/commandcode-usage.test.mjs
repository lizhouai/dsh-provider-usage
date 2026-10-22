/**
 * Regression tests for Command Code billing parsing. The usage summary is
 * optional: fetchJson returns undefined for an HTTP-success empty/non-JSON
 * body, while a failed summary request falls back to null in the adapter.
 * Neither response may hide the independently fetched billing rows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCommandCodeUsage } from '../src/commandcode.ts'

const billing = {
  windowLimits: {
    fiveHour: { used: 2, cap: 10, resetAt: 1792670400 },
    weekly: { used: 3, cap: 20, resetAt: 1793275200000 },
  },
  credits: { monthlyCredits: 50, purchasedCredits: 7, freeCredits: 3 },
}

const expectedWindows = [
  { label: '5h limit', used: 2, limit: 10, remaining: 8, percent: 20, resetAt: '2026-10-22T12:00:00.000Z' },
  { label: 'weekly', used: 3, limit: 20, remaining: 17, percent: 15, resetAt: '2026-10-29T12:00:00.000Z' },
]

test('a missing summary from an HTTP-success empty/non-JSON response preserves billing rows', () => {
  const rows = parseCommandCodeUsage(billing, undefined)
  assert.deepEqual(rows.slice(0, 2), expectedWindows)
  assert.deepEqual(rows[2], {
    label: 'monthly credits', used: null, limit: null, remaining: 60, percent: null, resetAt: null,
  })
})

test('a failed or unusable summary preserves the known balance without inventing usage', () => {
  for (const summary of [null, {}, [], '', 'unavailable', false, 0, { totalCredits: 'invalid' }]) {
    const rows = parseCommandCodeUsage(billing, summary)
    assert.deepEqual(rows.slice(0, 2), expectedWindows)
    assert.equal(rows[2].remaining, 60)
    assert.equal(rows[2].used, null)
    assert.equal(rows[2].limit, null)
    assert.equal(rows[2].percent, null)
  }
})

test('valid summary usage enriches the existing monthly credits calculation', () => {
  const rows = parseCommandCodeUsage(billing, { totalCredits: '40' })
  assert.deepEqual(rows.slice(0, 2), expectedWindows)
  assert.deepEqual(rows[2], {
    label: 'monthly credits', used: 40, limit: 100, remaining: 60, percent: 40, resetAt: null,
  })
})

test('zero remaining credits are kept without dividing by a zero limit', () => {
  const rows = parseCommandCodeUsage({ credits: { monthlyCredits: 0 } }, { totalCredits: 0 })
  assert.deepEqual(rows, [
    { label: 'monthly credits', used: 0, limit: 0, remaining: 0, percent: null, resetAt: null },
  ])
})

test('missing credits still return the valid five-hour and weekly windows', () => {
  assert.deepEqual(parseCommandCodeUsage({ windowLimits: billing.windowLimits }), expectedWindows)
})

test('numeric strings and zero window usage are valid, non-positive resets are absent', () => {
  const rows = parseCommandCodeUsage({ windowLimits: {
    fiveHour: { used: '0', cap: '10', resetAt: 0 },
    weekly: { used: '0', cap: '20', resetAt: -1 },
  } })
  assert.deepEqual(rows, [
    { label: '5h limit', used: 0, limit: 10, remaining: 10, percent: 0, resetAt: null },
    { label: 'weekly', used: 0, limit: 20, remaining: 20, percent: 0, resetAt: null },
  ])
})

test('malformed windows do not hide a valid credits row', () => {
  const rows = parseCommandCodeUsage({
    windowLimits: { fiveHour: { used: 2, cap: 0 }, weekly: null },
    credits: { monthlyCredits: '5' },
  }, null)
  assert.deepEqual(rows, [
    { label: 'monthly credits', used: null, limit: null, remaining: 5, percent: null, resetAt: null },
  ])
})

test('missing billing data does not synthesize quota rows from a summary alone', () => {
  for (const body of [undefined, null, {}]) {
    assert.deepEqual(parseCommandCodeUsage(body, { totalCredits: 40 }), [])
  }
})
