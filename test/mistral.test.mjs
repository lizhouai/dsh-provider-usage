/**
 * Regression tests for the Mistral billing parser (`src/mistral.ts`).
 *
 * The endpoint facts these pin down, none of which the panel shows directly:
 *
 * - **`usage_percentage` is a percentage of `initial_budget`**, not an amount.
 *   Reading it as money would report `6.03` spent against a `$150` allowance.
 * - **Both budgets are the organization's, and either may be absent.** A key on
 *   a plan with no API allowance gets no `api_budget` block (or one with
 *   `initial_budget: 0`), and that is "not on this plan", never "0% of $0".
 * - **A subscription failure must not sink the card.** The plan name is a
 *   nicety; the two budgets are what the reader opened the panel for.
 *
 * Run with `pnpm test` (Node's built-in test runner, TypeScript stripped).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  budgetRow,
  normalizeBudgetDetail,
  parseMistralBudget,
  parseMistralSubscription,
  parseMistralUsage,
  planTitle,
} from '../src/mistral.ts'

/** The shape `GET /v1/billing/budget` answered for a Student (EDU) account. */
const EDU_BUDGET = {
  vibe_budget: {
    usage_percentage: 6.021812316,
    initial_budget: 150.0,
    currency: 'USD',
    reset_at: '2026-12-01T00:00:00Z',
    payg_enabled: false,
  },
  api_budget: {
    usage_percentage: 0.0,
    initial_budget: 15.0,
    currency: 'USD',
    reset_at: '2026-12-01T00:00:00Z',
    payg_enabled: false,
  },
  usage_percentage: 0.0,
  initial_budget: 15.0,
  currency: 'USD',
  reset_at: '2026-12-01T00:00:00Z',
}

/** `GET /v1/billing/subscription` for the same account. */
const EDU_SUBSCRIPTION = {
  plan_name: 'EDU',
  payg_enabled: false,
  vibe_payg_enabled: false,
  enterprise: false,
}

test('usage_percentage is a percentage of initial_budget, not an amount', () => {
  const { usages } = parseMistralUsage(EDU_BUDGET, EDU_SUBSCRIPTION)
  const vibe = usages.find((row) => row.label === 'Vibe · Month')
  assert.ok(vibe !== undefined)
  assert.equal(vibe.limit, 150)
  assert.ok(Math.abs(vibe.percent - 6.021812316) < 1e-9, `percent was ${vibe.percent}`)
  assert.ok(Math.abs(vibe.used - 9.03) < 1e-9, `used was ${vibe.used}`)
  assert.ok(Math.abs(vibe.remaining - 140.97) < 1e-9, `remaining was ${vibe.remaining}`)
  assert.equal(vibe.resetAt, '2026-12-01T00:00:00.000Z')
})

test('both organization budgets are listed, API first, from one key', () => {
  const { usages } = parseMistralUsage(EDU_BUDGET, EDU_SUBSCRIPTION)
  assert.deepEqual(
    usages.map((row) => row.label),
    ['API · Month', 'Vibe · Month'],
  )
  const api = usages[0]
  assert.equal(api.limit, 15)
  assert.equal(api.percent, 0)
  assert.equal(api.used, 0)
})

test('an absent or zero API budget is not a 0/0 window', () => {
  const withoutApi = parseMistralUsage(
    { vibe_budget: EDU_BUDGET.vibe_budget },
    EDU_SUBSCRIPTION,
  )
  assert.deepEqual(
    withoutApi.usages.map((row) => row.label),
    ['Vibe · Month'],
  )

  const zeroApi = parseMistralUsage(
    { vibe_budget: EDU_BUDGET.vibe_budget, api_budget: { ...EDU_BUDGET.api_budget, initial_budget: 0 } },
    EDU_SUBSCRIPTION,
  )
  assert.deepEqual(
    zeroApi.usages.map((row) => row.label),
    ['Vibe · Month'],
  )
})

test('a key with only an API allowance renders one row', () => {
  const { usages } = parseMistralUsage(
    { api_budget: { usage_percentage: 40, initial_budget: 50, currency: 'EUR', reset_at: '2026-12-01T00:00:00Z' } },
  )
  assert.deepEqual(
    usages.map((row) => row.label),
    ['API · Month'],
  )
  assert.equal(usages[0].percent, 40)
  assert.equal(usages[0].limit, 50)
  assert.equal(usages[0].used, 20)
  assert.equal(usages[0].remaining, 30)
})

test('an overdrawn budget clamps the bar but keeps the amount honest', () => {
  const row = budgetRow(
    { usagePercentage: 137.5, initialBudget: 150, currency: 'USD', resetAt: null, paygEnabled: true },
    'Vibe · Month',
  )
  assert.equal(row.percent, 100)
  assert.equal(row.remaining, 0)
  assert.ok(Math.abs(row.used - 206.25) < 1e-9, `used was ${row.used}`)
})

test('no budget at all yields no rows, so the service reports no-subscription', () => {
  assert.deepEqual(parseMistralUsage({}).usages, [])
  assert.deepEqual(parseMistralUsage(null).usages, [])
  // The endpoint's flat top-level copy of api_budget is not a budget block.
  assert.deepEqual(parseMistralUsage({ usage_percentage: 0, initial_budget: 15 }).usages, [])
})

test('the plan title follows billing names, unknown names pass through', () => {
  assert.equal(planTitle('EDU'), 'Student')
  assert.equal(planTitle('INDIVIDUAL'), 'Pro')
  assert.equal(planTitle('TEAM'), 'Team')
  assert.equal(planTitle('FREE'), 'Free')
  assert.equal(planTitle('enterprise'), 'Enterprise')
  assert.equal(planTitle('REGIONAL_TEST'), 'REGIONAL_TEST')
  assert.equal(planTitle(null), null)
})

test('rows render without the subscription body, and the plan is then unknown', () => {
  const { usages, plan, payg } = parseMistralUsage(EDU_BUDGET)
  assert.equal(usages.length, 2)
  assert.equal(plan, null)
  assert.equal(payg, null)
})

test('the subscription blocks carry the pay-as-you-go flags', () => {
  const { plan, payg } = parseMistralUsage(EDU_BUDGET, EDU_SUBSCRIPTION)
  assert.equal(plan, 'Student')
  assert.deepEqual(payg, { enabled: false, vibeEnabled: false })

  const enabled = parseMistralUsage(EDU_BUDGET, {
    plan_name: 'INDIVIDUAL',
    payg_enabled: true,
    vibe_payg_enabled: false,
    enterprise: false,
  })
  assert.deepEqual(enabled.payg, { enabled: true, vibeEnabled: false })
})

test('a string-typed reset date is normalised, garbage is dropped', () => {
  const detail = normalizeBudgetDetail({
    usage_percentage: 1,
    initial_budget: 10,
    currency: 'USD',
    reset_at: '2026-12-01T00:00:00Z',
  })
  assert.equal(detail?.resetAt, '2026-12-01T00:00:00.000Z')

  const bad = normalizeBudgetDetail({
    usage_percentage: 1,
    initial_budget: 10,
    currency: 'USD',
    reset_at: 'not-a-date',
  })
  assert.equal(bad?.resetAt, null)
})

test('missing numeric fields default rather than crash', () => {
  const detail = normalizeBudgetDetail({ initial_budget: 10 })
  assert.ok(detail !== null)
  assert.equal(detail.usagePercentage, null)
  assert.equal(detail.currency, null)
  assert.equal(detail.paygEnabled, null)

  const block = parseMistralBudget({ vibe_budget: { initial_budget: 10 } }).vibe
  assert.ok(block !== null)
  const row = budgetRow(block, 'Vibe · Month')
  assert.equal(row.percent, 0)
  assert.equal(row.used, 0)
})

test('a malformed subscription body is "no plan", not a throw', () => {
  assert.equal(parseMistralSubscription([]), null)
  assert.equal(parseMistralSubscription('EDU'), null)
  assert.equal(parseMistralSubscription(null), null)
  assert.deepEqual(parseMistralSubscription({}), {
    planName: null,
    paygEnabled: null,
    vibePaygEnabled: null,
    enterprise: null,
  })
})
