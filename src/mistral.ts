/**
 * Mistral billing (`api.mistral.ai/v1/billing/*`) parsing.
 *
 * Mistral publishes no public "how much is left" API, but its own Vibe CLI
 * reads two billing endpoints with the ordinary inference key, so the same two
 * calls work here — no console cookie, no browser session:
 *
 * - `GET /v1/billing/budget` → the month's allowance, per budget:
 *   `{ vibe_budget: { usage_percentage, initial_budget, currency, reset_at,
 *   payg_enabled? }, api_budget: { … } }`. `usage_percentage` is a percentage
 *   of `initial_budget` (150 × 6.02% = $9.03 spent), not an amount.
 * - `GET /v1/billing/subscription` → `{ plan_name, payg_enabled,
 *   vibe_payg_enabled, enterprise }`.
 *
 * Both budgets belong to the **organization**, so every key of one
 * organization reads the same `vibe_budget` and `api_budget`; what differs per
 * key is which one the key spends. A console API key (`plan_type: "api"`)
 * spends `api_budget`, a Vibe key (`"chat"`) spends `vibe_budget` — the
 * `console.mistral.ai/api/vibe/whoami` fact magpie ([yetone/magpie],
 * `internal/provider/mistral_plan.go`) reads to pick one. This adapter shows
 * **both** rows instead of picking, which stays honest for either key kind and
 * costs no extra request.
 *
 * [yetone/magpie]: https://github.com/yetone/magpie/blob/main/internal/provider/mistral_plan.go
 * @module dsh-provider-usage/mistral
 */

import { toNumber, toResetAt, type UsageRow } from './wire.ts'

/** One budget's counter, as the endpoint reports it. */
export interface MistralBudgetDetail {
  /** Percentage consumed (0–100), the endpoint's native unit. */
  usagePercentage: number | null
  /** Allowance for the period, in `currency`. */
  initialBudget: number | null
  currency: string | null
  resetAt: string | null
  /** Pay-as-you-go spending past the allowance, when the budget says. */
  paygEnabled: boolean | null
}

/** Both budgets of one organization, either possibly absent. */
export interface MistralBudget {
  vibe: MistralBudgetDetail | null
  api: MistralBudgetDetail | null
}

/** `/v1/billing/subscription`, with billing's plan names kept raw. */
export interface MistralSubscription {
  planName: string | null
  paygEnabled: boolean | null
  vibePaygEnabled: boolean | null
  enterprise: boolean | null
}

/** What the panel needs from one provider query. */
export interface MistralUsageResult {
  /** Month windows: the API allowance and the Vibe allowance. */
  usages: UsageRow[]
  /** Plan title, when a subscription body was read (`EDU` → “Student”). */
  plan: string | null
  /**
   * Pay-as-you-go flags from the subscription body, verbatim. They do not
   * change a row today (the endpoint's percentage is already the truth), but
   * they are what tells a reader whether hitting 100% stops the models or
   * simply starts billing.
   */
  payg: { enabled: boolean | null; vibeEnabled: boolean | null } | null
}

/**
 * Billing's plan names as Vibe titles them (`mistral_plan.go`,
 * `mistralPlanTitles`). An unknown name is passed through untouched.
 */
const PLAN_TITLES: Record<string, string> = {
  FREE: 'Free',
  INDIVIDUAL: 'Pro',
  EDU: 'Student',
  TEAM: 'Team',
  ENTERPRISE: 'Enterprise',
}

/** Window labels; the API and Vibe allowances are separate months. */
const API_LABEL = 'API · Month'
const VIBE_LABEL = 'Vibe · Month'

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function toBooleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * Coerce one `*_budget` block.
 *
 * A block with no positive `initial_budget` is "no allowance", not a zero
 * window: Mistral omits a plan's budget entirely rather than reporting 0, and
 * rendering a 0/0 bar reads as "exhausted" instead of "not on this plan".
 * @param raw - the endpoint's budget object.
 * @returns the normalised block, or null when the block grants nothing.
 */
export function normalizeBudgetDetail(raw: any): MistralBudgetDetail | null {
  if (raw === null || typeof raw !== 'object') return null
  const initialBudget = toNumber(raw.initial_budget)
  if (initialBudget === null || initialBudget <= 0) return null
  return {
    usagePercentage: toNumber(raw.usage_percentage),
    initialBudget,
    currency: toStringOrNull(raw.currency),
    resetAt: toResetAt(raw.reset_at),
    paygEnabled: toBooleanOrNull(raw.payg_enabled),
  }
}

/**
 * Read both budgets out of a `/v1/billing/budget` body.
 * @param payload - the parsed JSON body.
 * @returns the two blocks, each null when the organization has no allowance.
 */
export function parseMistralBudget(payload: any): MistralBudget {
  return {
    vibe: normalizeBudgetDetail(payload?.vibe_budget),
    api: normalizeBudgetDetail(payload?.api_budget),
  }
}

/**
 * Read the plan out of a `/v1/billing/subscription` body.
 * @param payload - the parsed JSON body.
 * @returns the subscription, or null for a body this parser cannot read.
 */
export function parseMistralSubscription(payload: any): MistralSubscription | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  return {
    planName: toStringOrNull(payload.plan_name),
    paygEnabled: toBooleanOrNull(payload.payg_enabled),
    vibePaygEnabled: toBooleanOrNull(payload.vibe_payg_enabled),
    enterprise: toBooleanOrNull(payload.enterprise),
  }
}

/**
 * Billing's plan name as a title (`EDU` → `Student`, `INDIVIDUAL` → `Pro`).
 * @param name - the raw `plan_name`.
 * @returns the title, the raw name when unknown, or null.
 */
export function planTitle(name: string | null): string | null {
  if (name === null) return null
  return PLAN_TITLES[name.toUpperCase()] ?? name
}

/**
 * Build the panel row for one budget block.
 *
 * The row is in the panel's own unit: `used`/`limit` in the budget's currency
 * and `percent` as the endpoint's percentage, so the bar and the amount agree
 * without re-deriving one from the other.
 * @param detail - the normalised block.
 * @param label - the window label.
 * @returns the usage row.
 */
export function budgetRow(detail: MistralBudgetDetail, label: string): UsageRow {
  const limit = detail.initialBudget ?? 0
  // The endpoint's percentage is authoritative; clamp only for the bar.
  const percent = Math.max(0, detail.usagePercentage ?? 0)
  const used = Math.round(limit * percent) / 100
  return {
    label,
    used,
    limit,
    remaining: Math.max(0, Math.round((limit - used) * 100) / 100),
    percent: Math.min(100, percent),
    resetAt: detail.resetAt,
  }
}

/**
 * Turn the two bodies into panel rows plus the plan title.
 *
 * Order is API then Vibe — the order the endpoint itself lists them.
 * @param budgetBody - the `/v1/billing/budget` JSON.
 * @param subscriptionBody - the `/v1/billing/subscription` JSON (optional; the
 *   card stands without it).
 * @returns the rows and the plan title.
 */
export function parseMistralUsage(budgetBody: any, subscriptionBody?: any): MistralUsageResult {
  const budget = parseMistralBudget(budgetBody)
  const subscription = parseMistralSubscription(subscriptionBody)
  const rows: UsageRow[] = []
  if (budget.api !== null) rows.push(budgetRow(budget.api, API_LABEL))
  if (budget.vibe !== null) rows.push(budgetRow(budget.vibe, VIBE_LABEL))
  return {
    usages: rows,
    plan: planTitle(subscription?.planName ?? null),
    payg:
      subscription === null
        ? null
        : { enabled: subscription.paygEnabled, vibeEnabled: subscription.vibePaygEnabled },
  }
}
