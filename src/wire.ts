/**
 * Wire view shapes and the row-coercion helpers every quota adapter parses
 * into.
 *
 * Split out of the service module so a provider adapter (and its unit tests)
 * can share the panel's row vocabulary without loading the Cordis service
 * half. The shapes are mirrored by the client bundle, which declares its own
 * copies.
 * @module dsh-provider-usage/wire
 */

export interface BalanceRow {
  currency: string
  total: string
  granted: string
  toppedUp: string
}

export interface UsageRow {
  /** 'weekly' is the sentinel for the overall weekly window; other labels come from the provider. */
  label: string
  used: number | null
  limit: number | null
  remaining: number | null
  percent: number | null
  /** ISO timestamp when the window resets, when the provider reports one. */
  resetAt: string | null
}

export interface ProviderUsageView {
  id: string
  displayName: string
  kind: 'balance' | 'usage' | null
  status: 'ok' | 'error' | 'missing-credential' | 'missing-authorization' | 'reauth-required' | 'unsupported'
  message: string | null
  balances: BalanceRow[] | null
  usages: UsageRow[] | null
  /** True when this route is the harness's current default model selection —
      the provider in use, which alone drives the widget's health tone. */
  active: boolean
}

export interface UsageListResult {
  fetchedAt: string
  /** Deployment-suggested refresh interval; the widget may override it locally. */
  refreshSeconds: number
  /** Deployment-suggested balance thresholds (per the balance's own currency);
      the panel may override them locally. */
  balanceRedThreshold: number
  balanceYellowThreshold: number
  /** Plugin package version, surfaced in the panel header. */
  version: string
  providers: ProviderUsageView[]
}

/* ------------------------------------------------------------------ *
 * Response parsing helpers
 * ------------------------------------------------------------------ */

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function toResetAt(value: unknown): string | null {
  const numeric = toNumber(value)
  if (numeric !== null) {
    // Epoch seconds vs milliseconds.
    const ms = numeric > 1e12 ? numeric : numeric * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value === 'string' && value !== '') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  return null
}

export function usageRow(raw: any, fallbackLabel: string): UsageRow | null {
  if (raw === null || typeof raw !== 'object') return null
  const limit = toNumber(raw.limit ?? raw.limit_amount)
  let used = toNumber(raw.used ?? raw.used_amount)
  const remaining = toNumber(raw.remaining)
  if (used === null && remaining !== null && limit !== null) used = limit - remaining
  if (used === null && limit === null && remaining === null) return null
  const resetAt = toResetAt(raw.resetTime ?? raw.reset_at ?? raw.reset_time)
  const rem = remaining ?? (limit !== null && used !== null ? limit - used : null)
  return {
    label: String(raw.name ?? raw.title ?? raw.model_name ?? fallbackLabel),
    used,
    limit,
    remaining: rem,
    percent: limit !== null && limit > 0 && used !== null ? (used / limit) * 100 : null,
    resetAt,
  }
}

/**
 * Display priority for quota windows: the rolling 5h window comes first,
 * then the weekly window, then provider-ordered extras (stable sort).
 * Every adapter with a 5h/weekly pair (Kimi, Codex, MiniMax, z.ai,
 * OpenCode, Volcengine Ark) renders in this order.
 */
export function orderUsageRows(rows: UsageRow[]): UsageRow[] {
  const priority = (label: string) => (label === '5h limit' ? 0 : label === 'weekly' ? 1 : 2)
  return rows.sort((a, b) => priority(a.label) - priority(b.label))
}
