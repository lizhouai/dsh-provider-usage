/**
 * Volcengine Ark subscription-plan quota (Agent Plan / Coding Plan).
 *
 * These are the only adapters here whose quota does not come from the route's
 * own endpoint. A plan's usage lives on Volcengine's OpenTOP *control plane*
 * (`open.volcengineapi.com`, service `ark`, version `2024-01-01`) and is
 * authenticated with an IAM **AK/SK pair** under Volcengine's V4 HMAC-SHA256
 * scheme. The route's own key (`ARK_AGENT_PLAN_API_KEY` / `ARK_API_KEY`) is a
 * data-plane Bearer credential and is refused there — the live gateway answers
 * `GetAFPUsage requires Volcengine Ark SSO STS` — so these kinds resolve a
 * separate credential pair instead of `apiKeyEnv`.
 *
 * | product     | action               | payload                                   |
 * | ---         | ---                  | ---                                       |
 * | Agent Plan  | `GetAFPUsage`        | `Result.AFP{FiveHour,Weekly,Monthly}`     |
 * | Coding Plan | `GetCodingPlanUsage` | `Result.QuotaUsage[]`                     |
 *
 * Agent Plan windows are absolutes (`Quota`, `Used`, reset in epoch
 * milliseconds); Coding Plan windows are percentages (`Percent`, reset in
 * epoch seconds). Both use `-1`/`0` as the "no reset scheduled" sentinel, and
 * an Agent Plan's `AFPDaily` window is deliberately not rendered — the Ark
 * console and the official `arkcli` both omit it.
 * @module dsh-provider-usage/volcengine-ark
 */
import { createHash, createHmac } from 'node:crypto'
import { orderUsageRows, toNumber, toResetAt, usageRow, type UsageRow } from './wire.ts'

/** OpenTOP endpoint, service and version shared by both plan RPCs. */
const HOST = 'open.volcengineapi.com'
const REGION = 'cn-beijing'
const SERVICE = 'ark'
const VERSION = '2024-01-01'

/**
 * Agent Plan control-plane actions, primary first. Both names answer on the
 * live gateway for `ark` 2024-01-01 and return the same payload; the official
 * `arkcli` and CodexBar use the first, an earlier community plugin only the
 * second, so the adapter retries the alias when the gateway reports the
 * primary as unknown.
 */
export const AGENT_PLAN_ACTIONS = ['GetAFPUsage', 'GetAgentPlanAFPUsage'] as const

/** Coding Plan control-plane action. */
export const CODING_PLAN_ACTIONS = ['GetCodingPlanUsage'] as const

/**
 * IAM credential refs, each slot ordered most-specific first. The canonical
 * names match the `dsh-volcark-quota` plugin so one AK/SK pair serves both
 * panels; the trailing aliases let an environment that already exports the
 * official volcengine tooling variables work without a second copy of the
 * secret.
 */
export const ACCESS_KEY_REFS = ['VOLC_ARK_ACCESS_KEY_ID', 'VOLC_ACCESS_KEY_ID', 'VOLC_ACCESSKEY'] as const
export const SECRET_KEY_REFS = ['VOLC_ARK_ACCESS_KEY_SECRET', 'VOLC_ACCESS_KEY_SECRET', 'VOLC_SECRETKEY', 'VOLC_SECRET_KEY'] as const

/** Headers the signature covers, lower-cased and sorted as the canonical form requires. */
const SIGNED_HEADERS = 'host;x-content-sha256;x-date'

/** An OpenTOP call's URL plus the headers to send. */
export interface VolcengineSignedRequest {
  url: string
  /**
   * Headers to send, `Authorization` included. The signed set also covers
   * `host`, which is deliberately absent here: the Fetch specification
   * forbids setting it and the transport derives the identical value from the
   * URL, so the signature still verifies.
   */
  headers: Record<string, string>
}

/** `yyyyMMdd'T'HHmmss'Z'` plus the `yyyyMMdd` half the credential scope starts with. */
export function volcengineTimestamp(date: Date): { xDate: string; dateStamp: string } {
  const xDate = date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:\-]/g, '')
  return { xDate, dateStamp: xDate.slice(0, 8) }
}

/** Canonical query string: keys sorted, both halves percent-encoded. */
export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key]!)}`)
    .join('&')
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmac(key: string | Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest()
}

/**
 * Sign one OpenTOP `POST /?Action=…&Version=…` call with an empty `{}` body.
 *
 * Byte-for-byte compatible with the official `@volcengine/openapi` signer:
 * the signed set is `host;x-content-sha256;x-date` (that SDK leaves
 * `content-type` unsigned), the credential scope is
 * `<yyyyMMdd>/cn-beijing/ark/request`, and the signing key comes from the
 * HMAC chain secret → date → region → service → `request`.
 * @param options - AK/SK pair, action name, and an optional clock override for tests.
 * @returns the request URL and its headers.
 */
export function volcengineSignedRequest(options: {
  accessKeyId: string
  secretKey: string
  action: string
  date?: Date
}): VolcengineSignedRequest {
  const body = '{}'
  const contentSha256 = sha256Hex(body)
  const { xDate, dateStamp } = volcengineTimestamp(options.date ?? new Date())
  const query = canonicalQuery({ Action: options.action, Version: VERSION })
  const canonicalHeaders = [`host:${HOST}`, `x-content-sha256:${contentSha256}`, `x-date:${xDate}`].join('\n')
  const canonicalRequest = ['POST', '/', query, `${canonicalHeaders}\n`, SIGNED_HEADERS, contentSha256].join('\n')
  const scope = `${dateStamp}/${REGION}/${SERVICE}/request`
  const stringToSign = ['HMAC-SHA256', xDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(options.secretKey, dateStamp), REGION), SERVICE), 'request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  return {
    url: `https://${HOST}/?${query}`,
    headers: {
      'content-type': 'application/json',
      'x-date': xDate,
      'x-content-sha256': contentSha256,
      authorization: `HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Plan payloads
 * ------------------------------------------------------------------ */

/**
 * Reset instant for a plan window. Both products mark "no reset scheduled"
 * with a non-positive number, which must read as absent rather than as 1970.
 * Epoch milliseconds (Agent Plan) and seconds (Coding Plan) are told apart
 * downstream by magnitude.
 */
function planResetAt(value: unknown): string | null {
  const numeric = toNumber(value)
  if (numeric !== null && numeric <= 0) return null
  return toResetAt(value)
}

/** Backend Coding Plan window names → the panel's canonical labels. */
function codingWindowLabel(level: unknown): string {
  const name = String(level ?? '').toLowerCase()
  if (name === 'session' || name === '5-hour' || name === 'five_hour' || name === '5h') return '5h limit'
  if (name === 'weekly' || name === 'week') return 'weekly'
  if (name === 'monthly' || name === 'month') return 'monthly'
  return typeof level === 'string' && level !== '' ? level : 'limit'
}

/**
 * Parse a `GetAFPUsage` payload into the panel's usage rows: the 5h, weekly
 * and monthly windows in that order, each judged by its absolute
 * `Used`/`Quota` pair. A window the plan does not carry (absent, or a
 * non-positive quota) is skipped, and `AFPDaily` is never rendered.
 * @param payload - decoded `GetAFPUsage` body.
 * @returns the Agent Plan windows, empty when the account has no active plan.
 */
export function parseAgentPlanUsage(payload: any): UsageRow[] {
  const result = payload?.Result
  const windows: ReadonlyArray<readonly [string, string]> = [
    ['5h limit', 'AFPFiveHour'],
    ['weekly', 'AFPWeekly'],
    ['monthly', 'AFPMonthly'],
  ]
  const rows: UsageRow[] = []
  for (const [label, key] of windows) {
    const window = result?.[key]
    if (window === null || typeof window !== 'object') continue
    const quota = toNumber(window.Quota)
    if (quota === null || quota <= 0) continue
    const row = usageRow({ name: label, limit: quota, used: window.Used, resetTime: planResetAt(window.ResetTime) }, label)
    if (row !== null) rows.push(row)
  }
  return orderUsageRows(rows)
}

/**
 * Parse a `GetCodingPlanUsage` payload into the panel's usage rows. Windows
 * are percentage-only, so each is rendered as a 100-wide window. An inactive
 * or reclaimed plan answers with `Status` alone and no `QuotaUsage`, which
 * yields no rows.
 * @param payload - decoded `GetCodingPlanUsage` body.
 * @returns the Coding Plan windows, empty when the account has no active plan.
 */
export function parseCodingPlanUsage(payload: any): UsageRow[] {
  const entries: any[] = Array.isArray(payload?.Result?.QuotaUsage) ? payload.Result.QuotaUsage : []
  const rows: UsageRow[] = []
  for (const entry of entries) {
    const percent = toNumber(entry?.Percent)
    if (percent === null) continue
    rows.push({
      label: codingWindowLabel(entry?.Level),
      used: percent,
      limit: 100,
      remaining: 100 - percent,
      percent,
      resetAt: planResetAt(entry?.ResetTimestamp),
    })
  }
  return orderUsageRows(rows)
}
