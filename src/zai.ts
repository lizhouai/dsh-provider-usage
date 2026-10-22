/**
 * z.ai / GLM Coding Plan quota parsing.
 *
 * Token and credit windows share the same percentage-based view. Explicit
 * period metadata wins over reset order: a monthly window can reset before
 * a rolling five-hour window. Legacy payloads without usable period metadata
 * retain the original reset-ordered labels.
 * @module dsh-provider-usage/zai
 */
import { orderUsageRows, toNumber, toResetAt, type UsageRow } from './wire.ts'

function windowLabel(item: any, index: number): string {
  const unit = toNumber(item?.unit)
  const span = toNumber(item?.number)
  if (span !== null && span > 0) {
    // Only the unit codes described by this endpoint's adapter are known.
    if (unit === 3) return span === 168 ? 'weekly' : `${span}h limit`
    if (unit === 6) return `${span}mo limit`
  }
  return index === 0 ? '5h limit' : index === 1 ? 'weekly' : `limit ${index + 1}`
}

export function parseZaiUsage(body: any): UsageRow[] {
  if (body?.success === false) {
    throw new Error(String(body?.msg ?? body?.message ?? 'z.ai quota query failed'))
  }
  const limits: any[] = Array.isArray(body?.data?.limits) ? body.data.limits : []
  const limitEntries = limits
    .filter((item) => item?.type === 'TOKENS_LIMIT' || item?.type === 'CREDIT_LIMIT')
    .sort((a, b) => (toNumber(a?.nextResetTime) ?? Infinity) - (toNumber(b?.nextResetTime) ?? Infinity))
  const rows: UsageRow[] = []
  limitEntries.forEach((item, index) => {
    const percent = toNumber(item?.percentage)
    if (percent === null) return
    rows.push({
      label: windowLabel(item, index),
      used: percent,
      limit: 100,
      remaining: 100 - percent,
      percent,
      resetAt: toResetAt(item?.nextResetTime),
    })
  })
  return orderUsageRows(rows)
}
