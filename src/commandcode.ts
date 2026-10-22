/**
 * Command Code billing rows. Kept separate from the host service so optional
 * usage-summary responses can be tested without loading Cordis.
 */
import { orderUsageRows, toNumber, toResetAt, type UsageRow } from './wire.ts'

export function parseCommandCodeUsage(body: any, summary?: any): UsageRow[] {
  const rows: UsageRow[] = []
  const windows: Record<string, any> = body?.windowLimits ?? {}
  const windowRow = (label: string, win: any) => {
    if (win === null || typeof win !== 'object') return
    const used = toNumber(win.used)
    const cap = toNumber(win.cap)
    if (used === null || cap === null || cap <= 0) return
    const reset = toNumber(win.resetAt)
    rows.push({
      label,
      used,
      limit: cap,
      remaining: cap - used,
      percent: (used / cap) * 100,
      resetAt: reset !== null && reset > 0 ? toResetAt(win.resetAt) : null,
    })
  }
  windowRow('5h limit', windows.fiveHour)
  windowRow('weekly', windows.weekly)
  const credits: Record<string, any> = body?.credits ?? {}
  const monthly = toNumber(credits.monthlyCredits)
  if (monthly !== null) {
    const purchased = toNumber(credits.purchasedCredits) ?? 0
    const free = toNumber(credits.freeCredits) ?? 0
    const remaining = monthly + purchased + free
    // A successful HTTP response with no JSON body is undefined, whereas a
    // failed optional request is null. Both leave the billing data usable.
    const usedPeriod = toNumber(summary?.totalCredits)
    const total = usedPeriod !== null ? usedPeriod + remaining : null
    rows.push({
      label: 'monthly credits',
      used: usedPeriod,
      limit: total,
      remaining,
      percent: total !== null && total > 0 && usedPeriod !== null ? (usedPeriod / total) * 100 : null,
      resetAt: null,
    })
  }
  return orderUsageRows(rows)
}
