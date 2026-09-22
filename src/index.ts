/**
 * provider-usage — host half.
 *
 * A `ctx.usage` Typert Remote service that reports the account balance/quota
 * of every configured LLM provider route. Provider routes are auto-detected
 * from the live `llm` registry plus the composed settings sections, keys are
 * resolved per request through the credentials service (never cached), and
 * each provider kind has its own wire adapter (see ADAPTERS below):
 *
 * - `deepseek`       → GET {baseURL}/user/balance              (充值余额)
 * - `kimi-coding`    → GET {baseURL}/v1/usages                 (订阅配额, weekly / 5h windows)
 * - `moonshot`       → GET {baseURL}/users/me/balance          (开放平台余额)
 * - `openrouter`     → GET {origin}/api/v1/credits             (credit 总额与已用量)
 * - `github-copilot` → GET api.github.com/copilot_internal/user (订阅配额快照, OAuth token)
 * - `openai-codex`   → GET {baseURL}/wham/usage                (ChatGPT 订阅 5h/weekly 窗口 + credits)
 *                     OAuth access token (no API key): reads the `llm-pi-ai/openai-codex`
 *                     grant record from the credentials service, refreshes it near expiry,
 *                     and sends `ChatGPT-Account-Id` derived from the token JWT.
 * - `openai`         → GET {origin}/v1/organization/costs      (Admin key, 当月花费)
 * - `anthropic`      → GET {baseURL}/v1/organizations/cost_report (Admin key, 当月花费)
 * - `minimax`        → GET {origin}/v1/api/openplatform/coding_plan/remains (Coding Plan 5h/weekly)
 * - `zai`            → GET {origin}/api/monitor/usage/quota/limit (GLM Coding Plan 配额)
 * - `opencode`       → GET {baseURL}/usage                     (Zen Go 订阅 5h/weekly/monthly)
 * - `vercel-ai-gateway` → GET {baseURL}/v1/credits             (团队 credit 余额)
 * - `xai`            → GET {baseURL}/billing/credits           (预付余额; Management API 见注释)
 * - `volcengine-ark-agent`  → POST open.volcengineapi.com GetAFPUsage
 *                     (火山方舟 Agent Plan 5h/weekly/monthly; IAM AK/SK V4 签名, 见 volcengine-ark.ts)
 * - `volcengine-ark-coding` → POST open.volcengineapi.com GetCodingPlanUsage
 *                     (火山方舟 Coding Plan session/weekly/monthly; 同一对 AK/SK)
 *
 * The browser widget polls `usage/list` on its own configurable interval, so
 * this service stays stateless: every call fetches live values.
 * @module dsh-provider-usage
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  OpenAiCodexReauthRequiredError,
  openAiCodexAccountId,
  parseOpenAiCodexGrant,
  resolveOpenAiCodexGrant,
  type OpenAiCodexGrant,
  type OpenAiCodexGrantStore,
} from './openai-codex.ts'
import { orderUsageRows, toNumber, toResetAt, usageRow, type BalanceRow, type ProviderUsageView, type UsageListResult, type UsageRow } from './wire.ts'
import {
  ACCESS_KEY_REFS,
  AGENT_PLAN_ACTIONS,
  CODING_PLAN_ACTIONS,
  SECRET_KEY_REFS,
  parseAgentPlanUsage,
  parseCodingPlanUsage,
  volcengineSignedRequest,
} from './volcengine-ark.ts'

export type { BalanceRow, ProviderUsageView, UsageListResult, UsageRow } from './wire.ts'

export const name = 'provider-usage'

/** Own package version, baked in by tsdown `define` at build time (the
    fallback only fires if the sources are compiled some other way). */
export const version: string = typeof __PLUGIN_VERSION__ === 'undefined' ? '0.0.0-dev' : __PLUGIN_VERSION__

/** Settings namespace this plugin owns (registered through `ctx.settings`). */
const NS = 'provider-usage'

/* ------------------------------------------------------------------ *
 * Provider kinds & adapters
 * ------------------------------------------------------------------ */

const PROVIDER_KINDS = [
  'deepseek',
  'kimi-coding',
  'moonshot',
  'openrouter',
  'github-copilot',
  'openai-codex',
  'openai',
  'anthropic',
  'minimax',
  'zai',
  'opencode',
  'vercel-ai-gateway',
  'xai',
  'volcengine-ark-agent',
  'volcengine-ark-coding',
] as const

type ProviderKind = (typeof PROVIDER_KINDS)[number]

/** What one quota probe returns: either balance rows or usage windows. */
interface AdapterPayload {
  balances: BalanceRow[] | null
  usages: UsageRow[] | null
}

/** Re-resolve the OAuth credential (refresh + persist) after a 401. */
type RefreshFn = (signal: AbortSignal) => Promise<string>

interface QuotaAdapter {
  /** Panel data shape this adapter produces. */
  view: 'balance' | 'usage'
  /** Auto-classification: a route whose baseURL matches belongs to this kind. */
  match: RegExp
  /** Extra request headers beyond Authorization/Accept. */
  headers?: Record<string, string>
  /**
   * Credential slots this adapter owns, each a list of candidate refs resolved
   * in order (first hit wins). Present only where the endpoint is NOT
   * authenticated by the route's own `apiKeyEnv` — the Volcengine plan RPCs
   * sign with an IAM AK/SK pair rather than the route's data-plane Bearer key.
   * Every slot must resolve; the values arrive as the `credentials` argument.
   */
  credentialRefs?: readonly (readonly string[])[]
  fetch(baseURL: string, apiKey: string, signal: AbortSignal, refresh?: RefreshFn, credentials?: readonly string[]): Promise<AdapterPayload>
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const ProviderSpec = z.object({
  /** Route id this spec describes (manual specs may use any unique id). */
  id: z.string(),
  kind: z.union(PROVIDER_KINDS),
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  displayName: z.string().default(''),
  enabled: z.boolean().default(true),
})

export const Config = z.object({
  /** Suggested widget refresh interval in seconds (the panel may override it locally). */
  refreshSeconds: z.number().step(1).min(5).max(86400).default(60),
  /** Balance below this amount turns red, compared in the balance's own currency
      (the panel may override it locally). */
  balanceRedThreshold: z.number().step(0.01).min(0).default(10),
  /** Balance below this amount turns yellow, compared in the balance's own currency
      (the panel may override it locally). */
  balanceYellowThreshold: z.number().step(0.01).min(0).default(30),
  /** Enumerate live provider routes from the llm registry. */
  autoDetect: z.boolean().default(true),
  /** Per-attempt query timeout in milliseconds; each retry gets a fresh timeout. */
  queryTimeoutMs: z.number().step(1).min(1000).max(120000).default(20000),
  /** Retries after the first failed attempt for transient errors (timeout, network, HTTP 408/425/429/5xx). */
  queryRetries: z.number().step(1).min(0).max(10).default(2),
  /** Base delay between retries in milliseconds; doubles each attempt, capped at 10s. */
  queryRetryDelayMs: z.number().step(1).min(100).max(60000).default(2000),
  /** Manual provider specs; an id matching a detected route overrides it. */
  providers: z.array(ProviderSpec).default([]),
})

export interface ProviderUsageConfig {
  refreshSeconds: number
  balanceRedThreshold: number
  balanceYellowThreshold: number
  autoDetect: boolean
  queryTimeoutMs: number
  queryRetries: number
  queryRetryDelayMs: number
  providers: Array<{
    id: string
    kind: ProviderKind
    baseURL: string
    apiKeyEnv: string
    displayName: string
    enabled: boolean
  }>
}

interface ResolvedProvider {
  id: string
  displayName: string
  kind: ProviderKind
  baseURL: string
  /** Undefined only for OAuth-record providers such as OpenAI Codex. */
  apiKeyEnv?: string
}

/**
 * Credential record union as written by the harness credential service at
 * runtime (dsh ≥ 0.1.2; the locally pinned rc.6 typings predate the record
 * half of the seam). Declared here so the Codex OAuth read stays typed.
 */
type CredentialRecord =
  | { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string, string>> }
  | { readonly kind: 'grant'; readonly payload: unknown }

/** A live route whose endpoint has no quota adapter. */
interface UnsupportedRoute {
  unsupported: true
  route: { id: string; name: string }
}

type DetectedProvider = ResolvedProvider | UnsupportedRoute

/* ------------------------------------------------------------------ *
 * Provider route auto-detection
 * ------------------------------------------------------------------ */

/**
 * Catalog fallback for well-known routes when the settings section omits
 * connection facts. Mirrors the pi-ai catalog shipped with the harness, plus
 * the harness's own `deepseek-official` route; routes without a fixed
 * baseURL (cloud/OAuth providers) rely on the settings profile instead.
 */
const KNOWN_ROUTES: Record<string, { baseURL?: string; apiKeyEnv?: string; displayName: string }> = {
  'deepseek-official': { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' },
  deepseek: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' },
  'kimi-coding': { baseURL: 'https://api.kimi.com/coding', apiKeyEnv: 'KIMI_API_KEY', displayName: 'Kimi Code' },
  'moonshotai-cn': { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY', displayName: 'Moonshot AI CN' },
  moonshotai: { baseURL: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_API_KEY', displayName: 'Moonshot AI' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', displayName: 'OpenRouter' },
  anthropic: { baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', displayName: 'Anthropic' },
  openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', displayName: 'OpenAI' },
  'openai-codex': { baseURL: 'https://chatgpt.com/backend-api', displayName: 'OpenAI Codex' },
  google: { baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKeyEnv: 'GEMINI_API_KEY', displayName: 'Google' },
  'google-vertex': { apiKeyEnv: 'GOOGLE_CLOUD_API_KEY', displayName: 'Google Vertex' },
  xai: { baseURL: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY', displayName: 'xAI' },
  mistral: { baseURL: 'https://api.mistral.ai', apiKeyEnv: 'MISTRAL_API_KEY', displayName: 'Mistral' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', displayName: 'Groq' },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY', displayName: 'Cerebras' },
  fireworks: { baseURL: 'https://api.fireworks.ai/inference', apiKeyEnv: 'FIREWORKS_API_KEY', displayName: 'Fireworks' },
  together: { baseURL: 'https://api.together.ai/v1', apiKeyEnv: 'TOGETHER_API_KEY', displayName: 'Together' },
  nvidia: { baseURL: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY', displayName: 'NVIDIA' },
  huggingface: { baseURL: 'https://router.huggingface.co/v1', apiKeyEnv: 'HF_TOKEN', displayName: 'Hugging Face' },
  'github-copilot': { baseURL: 'https://api.individual.githubcopilot.com', apiKeyEnv: 'COPILOT_GITHUB_TOKEN', displayName: 'GitHub Copilot' },
  'vercel-ai-gateway': { baseURL: 'https://ai-gateway.vercel.sh', apiKeyEnv: 'AI_GATEWAY_API_KEY', displayName: 'Vercel AI Gateway' },
  'ant-ling': { baseURL: 'https://api.ant-ling.com/v1', apiKeyEnv: 'ANT_LING_API_KEY', displayName: 'Ant Ling' },
  'ark-agent-plan': { baseURL: 'https://ark.cn-beijing.volces.com/api/plan', apiKeyEnv: 'ARK_AGENT_PLAN_API_KEY', displayName: 'Volcengine Ark Agent Plan' },
  'ark-agent-plan-cn': { baseURL: 'https://ark.cn-beijing.volces.com/api/plan', apiKeyEnv: 'ARK_AGENT_PLAN_CN_API_KEY', displayName: 'Volcengine Ark Agent Plan' },
  'ark-coding-plan': { baseURL: 'https://ark.cn-beijing.volces.com/api/coding', apiKeyEnv: 'ARK_CODING_PLAN_API_KEY', displayName: 'Volcengine Ark Coding Plan' },
  'ark-coding-plan-cn': { baseURL: 'https://ark.cn-beijing.volces.com/api/coding', apiKeyEnv: 'ARK_CODING_PLAN_CN_API_KEY', displayName: 'Volcengine Ark Coding Plan' },
  minimax: { baseURL: 'https://api.minimax.io/anthropic', apiKeyEnv: 'MINIMAX_API_KEY', displayName: 'MiniMax' },
  'minimax-cn': { baseURL: 'https://api.minimaxi.com/anthropic', apiKeyEnv: 'MINIMAX_CN_API_KEY', displayName: 'MiniMax CN' },
  zai: { baseURL: 'https://api.z.ai/api/coding/paas/v4', apiKeyEnv: 'ZAI_API_KEY', displayName: 'Z.AI' },
  'zai-coding-cn': { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'ZAI_CODING_CN_API_KEY', displayName: 'Z.AI Coding CN' },
  'qwen-token-plan': { baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'QWEN_TOKEN_PLAN_API_KEY', displayName: 'Qwen Token Plan' },
  'qwen-token-plan-cn': { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY', displayName: 'Qwen Token Plan CN' },
  xiaomi: { baseURL: 'https://api.xiaomimimo.com/v1', apiKeyEnv: 'XIAOMI_API_KEY', displayName: 'Xiaomi MiMo' },
  'xiaomi-token-plan-ams': { baseURL: 'https://token-plan-ams.xiaomimimo.com/v1', apiKeyEnv: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY', displayName: 'Xiaomi Token Plan AMS' },
  'xiaomi-token-plan-cn': { baseURL: 'https://token-plan-cn.xiaomimimo.com/v1', apiKeyEnv: 'XIAOMI_TOKEN_PLAN_CN_API_KEY', displayName: 'Xiaomi Token Plan CN' },
  'xiaomi-token-plan-sgp': { baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1', apiKeyEnv: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY', displayName: 'Xiaomi Token Plan SGP' },
  opencode: { baseURL: 'https://opencode.ai/zen/v1', apiKeyEnv: 'OPENCODE_API_KEY', displayName: 'OpenCode Zen' },
  'opencode-go': { baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_API_KEY', displayName: 'OpenCode Zen Go' },
  'azure-openai-responses': { apiKeyEnv: 'AZURE_OPENAI_API_KEY', displayName: 'Azure OpenAI' },
  'amazon-bedrock': { apiKeyEnv: 'AWS_BEARER_TOKEN_BEDROCK', displayName: 'Amazon Bedrock' },
  'cloudflare-workers-ai': { displayName: 'Cloudflare Workers AI' },
  'cloudflare-ai-gateway': { displayName: 'Cloudflare AI Gateway' },
}

/** Classify a provider endpoint by host; returns null for endpoints with no quota adapter. */
function kindOfBaseURL(baseURL: string): ProviderKind | null {
  for (const kind of PROVIDER_KINDS) {
    if (ADAPTERS[kind].match.test(baseURL)) return kind
  }
  return null
}

/**
 * Whether a kind authenticates from refs it declares itself rather than from
 * the route's key. Such a route is worth listing even when the settings
 * profile names no `apiKeyEnv`, because its credential is resolved elsewhere.
 */
function ownsCredentials(kind: ProviderKind): boolean {
  return ADAPTERS[kind].credentialRefs !== undefined
}

/* ------------------------------------------------------------------ *
 * Response parsing helpers
 * ------------------------------------------------------------------ */

/** Parse the Kimi Code `/v1/usages` payload (both observed shapes). */
function parseKimiUsages(payload: any): UsageRow[] {
  const rows: UsageRow[] = []
  const data = payload?.data
  if (Array.isArray(data)) {
    for (const item of data) {
      const isOverall = item?.model_name === 'all'
      const row = usageRow(item, isOverall ? 'weekly' : 'limit')
      if (row) rows.push(isOverall ? { ...row, label: 'weekly' } : row)
    }
    return orderUsageRows(rows)
  }
  const usage = usageRow(payload?.usage, 'weekly')
  if (usage) rows.push({ ...usage, label: 'weekly' })
  const limits = payload?.limits
  if (Array.isArray(limits)) {
    for (const item of limits) {
      const detail = item?.detail && typeof item.detail === 'object' ? item.detail : item
      const window = item?.window && typeof item.window === 'object' ? item.window : {}
      const duration = toNumber(window.duration)
      const unit = String(window.timeUnit ?? window.time_unit ?? '').toUpperCase()
      let fallback = 'limit'
      if (duration !== null) {
        if (unit.includes('MINUTE') && duration >= 60 && duration % 60 === 0) fallback = `${duration / 60}h limit`
        else if (unit.includes('MINUTE')) fallback = `${duration}m limit`
        else if (unit.includes('HOUR')) fallback = `${duration}h limit`
        else if (unit.includes('DAY')) fallback = `${duration}d limit`
        else if (unit.includes('MONTH')) fallback = `${duration}mo limit`
      }
      const row = usageRow(detail, fallback)
      if (row) rows.push(row)
    }
  }
  return orderUsageRows(rows)
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

/**
 * Best-effort human detail from a provider error body: Volcengine's OpenTOP
 * `ResponseMetadata.Error` (whose `Code` carries the actionable part, e.g.
 * `AccessDenied` or `InvalidAccessKey`), the OpenAI-shaped `error.message`,
 * or a bare `message`/`msg`.
 */
function errorDetail(body: any): string | undefined {
  const volc = body?.ResponseMetadata?.Error
  if (volc !== null && typeof volc === 'object') {
    const parts = [typeof volc.Code === 'string' ? volc.Code : undefined, typeof volc.Message === 'string' ? volc.Message : undefined]
      .filter((part): part is string => part !== undefined && part !== '')
    if (parts.length > 0) return parts.join(': ')
  }
  const detail = body?.error?.message ?? body?.message ?? body?.msg
  return typeof detail === 'string' && detail !== '' ? detail : undefined
}

/**
 * GET a JSON endpoint, or POST one when `init` says so (the signed Volcengine
 * plan RPCs do).
 * @param apiKey - the route credential; omit it when `extraHeaders` already
 *   carries the authorization (signed requests, `x-api-key` adapters).
 */
async function fetchJson(
  url: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {},
  init: { method?: string; body?: string } = {},
): Promise<any> {
  // Adapters with a non-Bearer credential (x-api-key, `token <oauth>`) pass it
  // through extraHeaders; only then is the default Bearer header withheld.
  const hasAuth = Object.keys(extraHeaders).some((h) => {
    const lower = h.toLowerCase()
    return lower === 'authorization' || lower === 'x-api-key'
  })
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { accept: 'application/json', ...(hasAuth || apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }), ...extraHeaders },
    ...(init.body === undefined ? {} : { body: init.body }),
    signal,
  })
  const text = await response.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const detail = errorDetail(body)
    throw new Error(`HTTP ${response.status}${detail === undefined ? '' : `: ${detail}`}`)
  }
  return body
}

/**
 * POST one Volcengine plan RPC, retrying with an action alias only when the
 * gateway does not know the primary name for this service version. The signed
 * headers carry their own `Authorization`, so no Bearer key is attached.
 */
async function fetchVolcenginePlan(actions: readonly string[], credentials: readonly string[] | undefined, signal: AbortSignal): Promise<any> {
  const [accessKeyId, secretKey] = credentials ?? []
  // fetchProvider reports the missing pair before reaching an adapter; this
  // guards the adapter against being driven directly.
  if (accessKeyId === undefined || secretKey === undefined) throw new Error('Volcengine Ark plan quota needs an IAM AK/SK pair')
  let lastError: unknown
  for (const action of actions) {
    const request = volcengineSignedRequest({ accessKeyId, secretKey, action })
    try {
      return await fetchJson(request.url, undefined, signal, request.headers, { method: 'POST', body: '{}' })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('InvalidActionOrVersion')) throw error
      lastError = error
    }
  }
  throw lastError ?? new Error('Volcengine Ark plan quota request failed')
}

function okView(base: Omit<ProviderUsageView, 'status' | 'message'>): ProviderUsageView {
  return { ...base, status: 'ok', message: null }
}

/** Retryable HTTP statuses below 500 (the whole 5xx range is retryable). */
const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429])

/**
 * How long a "the stored Codex grant needs a new sign-in" verdict suppresses
 * further token-endpoint calls. Long enough to stop a poll loop from hammering
 * a dead grant, short enough to recover on its own from a misdiagnosis.
 */
const CODEX_REAUTH_BACKOFF_MS = 10 * 60_000

/**
 * Whether a failed provider query is worth retrying: per-attempt timeouts,
 * undici network failures, HTTP 408/425/429/5xx (including OAuth refresh
 * failures carrying `(HTTP <status>)`), and transient socket text. Permanent
 * 4xx (400/401/403/404/422, e.g. a model-unsupported or invalid_grant reply)
 * and adapter-side data errors fail immediately.
 */
function isTransientQueryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true
  const status = Number(/HTTP (\d+)/.exec(error.message)?.[1] ?? NaN)
  if (Number.isFinite(status)) return status >= 500 || TRANSIENT_HTTP_STATUS.has(status)
  if (error instanceof TypeError) return true
  return /\b(?:fetch failed|ECONN[A-Z]+|ETIMEDOUT|EAI_AGAIN|socket hang up|other side closed|premature close)\b/i.test(error.message)
}

/** Delay that resolves early (without throwing) when the outer signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

function failView(id: string, displayName: string, kind: ProviderUsageView['kind'], status: ProviderUsageView['status'], message: string, active: boolean): ProviderUsageView {
  return { id, displayName, kind, status, message, balances: null, usages: null, active }
}

/** Strip trailing slashes from a route baseURL. */
function root(baseURL: string): string {
  return baseURL.replace(/\/+$/, '')
}

/* ------------------------------------------------------------------ *
 * Quota adapters — one per ProviderKind
 * ------------------------------------------------------------------ */

const ADAPTERS: Record<ProviderKind, QuotaAdapter> = {
  deepseek: {
    view: 'balance',
    match: /deepseek/i,
    async fetch(baseURL, apiKey, signal) {
      const body = await fetchJson(`${root(baseURL)}/user/balance`, apiKey, signal)
      const infos: any[] = Array.isArray(body?.balance_infos) ? body.balance_infos : []
      return {
        balances: infos.map((info) => ({
          currency: String(info.currency ?? ''),
          total: String(info.total_balance ?? '0'),
          granted: String(info.granted_balance ?? '0'),
          toppedUp: String(info.topped_up_balance ?? '0'),
        })),
        usages: null,
      }
    },
  },

  'kimi-coding': {
    view: 'usage',
    match: /api\.kimi\.com\/coding/i,
    headers: { 'user-agent': 'KimiCLI/1.6' },
    async fetch(baseURL, apiKey, signal) {
      const base = root(baseURL)
      const url = base.endsWith('/v1') ? `${base}/usages` : `${base}/v1/usages`
      const body = await fetchJson(url, apiKey, signal, this.headers)
      return { balances: null, usages: parseKimiUsages(body) }
    },
  },

  moonshot: {
    view: 'balance',
    match: /moonshot/i,
    async fetch(baseURL, apiKey, signal) {
      const body = await fetchJson(`${root(baseURL)}/users/me/balance`, apiKey, signal)
      const data = body?.data ?? {}
      return {
        balances: [{
          currency: String(data.currency ?? 'CNY'),
          total: String(data.available_balance ?? '0'),
          granted: String(data.voucher_balance ?? '0'),
          toppedUp: String(data.cash_balance ?? '0'),
        }],
        usages: null,
      }
    },
  },

  openrouter: {
    view: 'usage',
    match: /openrouter\.ai/i,
    async fetch(baseURL, apiKey, signal) {
      // The route baseURL is https://openrouter.ai/api/v1; credits lives one level up.
      const origin = root(baseURL).replace(/\/api\/v1$/, '')
      const body = await fetchJson(`${origin}/api/v1/credits`, apiKey, signal)
      const data = body?.data ?? {}
      const limit = toNumber(data.total_credits)
      const used = toNumber(data.total_usage)
      const remaining = limit !== null && used !== null ? limit - used : null
      return {
        balances: null,
        usages: [{
          label: 'credits',
          used,
          limit,
          remaining,
          percent: limit !== null && limit > 0 && used !== null ? (used / limit) * 100 : null,
          resetAt: null,
        }],
      }
    },
  },

  'github-copilot': {
    view: 'usage',
    match: /githubcopilot\.com|copilot/i,
    async fetch(_baseURL, apiKey, signal) {
      // Undocumented but stable internal endpoint used by every community quota
      // tool; the credential is the GitHub OAuth token, sent with the `token`
      // scheme rather than Bearer. Editor headers are required.
      const body = await fetchJson('https://api.github.com/copilot_internal/user', apiKey, signal, {
        authorization: `token ${apiKey}`,
        'editor-version': 'vscode/1.96.2',
        'editor-plugin-version': 'copilot-chat/0.26.7',
        'user-agent': 'GitHubCopilotChat/0.26.7',
        'x-github-api-version': '2025-04-01',
      })
      const rows: UsageRow[] = []
      const resetAt = toResetAt(body?.quota_reset_date) ?? toResetAt(body?.limited_user_reset_date)
      const snapshots = body?.quota_snapshots
      if (snapshots !== null && typeof snapshots === 'object') {
        // Paid plans: per-feature snapshots with entitlement/remaining.
        for (const [key, snap] of Object.entries<any>(snapshots)) {
          if (snap === null || typeof snap !== 'object') continue
          const entitlement = toNumber(snap.entitlement)
          const remaining = toNumber(snap.remaining)
          if (entitlement === null && remaining === null) continue
          const percentRemaining = toNumber(snap.percent_remaining)
          const used = entitlement !== null && remaining !== null ? entitlement - remaining : null
          const percent = percentRemaining !== null
            ? 100 - percentRemaining
            : entitlement !== null && entitlement > 0 && used !== null ? (used / entitlement) * 100 : null
          rows.push({ label: String(snap.quota_id ?? key), used, limit: entitlement, remaining, percent, resetAt })
        }
      } else {
        // Free limited plan: monthly quotas minus limited-user remainder.
        const limited = body?.limited_user_quotas ?? {}
        const monthly = body?.monthly_quotas ?? {}
        for (const key of ['chat', 'completions']) {
          const limit = toNumber(monthly[key])
          const remaining = toNumber(limited[key])
          if (limit === null && remaining === null) continue
          const used = limit !== null && remaining !== null ? limit - remaining : null
          rows.push({
            label: key,
            used,
            limit,
            remaining,
            percent: limit !== null && limit > 0 && used !== null ? (used / limit) * 100 : null,
            resetAt,
          })
        }
      }
      return { balances: null, usages: rows }
    },
  },

  'openai-codex': {
    view: 'usage',
    match: /chatgpt\.com\/backend-api/i,
    headers: { originator: 'pi', 'user-agent': `dsh-provider-usage/${version}` },
    async fetch(baseURL, apiKey, signal, refresh) {
      // ChatGPT subscription endpoint. Codex OAuth calls require both the
      // bearer access token and the account id embedded in that token. A 401
      // (rotated token) triggers one refresh + retry, exactly like the CLI.
      const headers = (token: string) => {
        const accountId = openAiCodexAccountId(token)
        if (accountId === null) throw new Error('OpenAI Codex OAuth token has no ChatGPT account id')
        return { 'chatgpt-account-id': accountId, ...this.headers }
      }
      const attempt = async (token: string) => {
        const body = await fetchJson(`${root(baseURL)}/wham/usage`, token, signal, headers(token))
        return body
      }
      let body: any
      try {
        body = await attempt(apiKey)
      } catch (error) {
        const status = error instanceof Error ? Number(/^HTTP (\d+)/.exec(error.message)?.[1] ?? NaN) : NaN
        if (!(status === 401 && refresh !== undefined)) throw error
        body = await attempt(await refresh(signal))
      }
      const rows: UsageRow[] = []
      const windowRow = (label: string, win: any) => {
        if (win === null || typeof win !== 'object') return
        const percent = toNumber(win.used_percent)
        if (percent === null) return
        rows.push({ label, used: percent, limit: 100, remaining: 100 - percent, percent, resetAt: toResetAt(win.reset_at) })
      }
      windowRow('5h limit', body?.rate_limit?.primary_window)
      windowRow('weekly', body?.rate_limit?.secondary_window)
      const extra = body?.additional_rate_limits
      if (Array.isArray(extra)) {
        for (const item of extra) {
          windowRow(String(item?.limit_name ?? item?.metered_feature ?? 'limit'), item?.rate_limit?.primary_window)
        }
      }
      const credits = body?.credits
      if (credits !== null && typeof credits === 'object') {
        const balance = toNumber(credits.balance)
        if (balance !== null) {
          rows.push({ label: 'credits', used: null, limit: null, remaining: balance, percent: null, resetAt: null })
        }
      }
      const spend = body?.spend_control?.individual_limit
      if (spend !== null && typeof spend === 'object') {
        const spendLimit = toNumber(spend.limit)
        const spendUsed = toNumber(spend.used)
        const spendRemaining = toNumber(spend.remaining)
        if (spendLimit !== null || spendUsed !== null || spendRemaining !== null) {
          rows.push({
            label: 'spend control',
            used: spendUsed,
            limit: spendLimit,
            remaining: spendRemaining,
            percent: spendLimit !== null && spendLimit > 0 && spendUsed !== null ? (spendUsed / spendLimit) * 100 : null,
            resetAt: toResetAt(spend.reset_at),
          })
        }
      }
      return { balances: null, usages: orderUsageRows(rows) }
    },
  },

  openai: {
    view: 'usage',
    match: /api\.openai\.com/i,
    async fetch(baseURL, apiKey, signal) {
      // No balance endpoint exists; the organization costs report (admin keys
      // only) is the closest live signal. A regular sk- key fails with 403,
      // which the panel surfaces as the query error.
      const base = root(baseURL).replace(/\/v1$/, '')
      const monthStart = new Date()
      monthStart.setUTCDate(1)
      monthStart.setUTCHours(0, 0, 0, 0)
      const startTime = Math.floor(monthStart.getTime() / 1000)
      const body = await fetchJson(`${base}/v1/organization/costs?start_time=${startTime}`, apiKey, signal)
      let total = 0
      let currency = 'USD'
      for (const bucket of body?.data ?? []) {
        for (const result of bucket?.results ?? []) {
          total += toNumber(result?.amount?.value) ?? 0
          if (result?.amount?.currency) currency = String(result.amount.currency).toUpperCase()
        }
      }
      return {
        balances: null,
        usages: [{ label: `month spend (${currency})`, used: total, limit: null, remaining: null, percent: null, resetAt: null }],
      }
    },
  },

  anthropic: {
    view: 'usage',
    match: /api\.anthropic\.com/i,
    async fetch(baseURL, apiKey, signal) {
      // Admin API: x-api-key auth (not Bearer), admin keys only; prepaid
      // balance is not exposed, so this reports the current month's spend.
      const monthStart = new Date()
      monthStart.setUTCDate(1)
      monthStart.setUTCHours(0, 0, 0, 0)
      const body = await fetchJson(
        `${root(baseURL)}/v1/organizations/cost_report?starting_at=${encodeURIComponent(monthStart.toISOString())}`,
        apiKey,
        signal,
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      )
      let total = 0
      let currency = 'USD'
      for (const bucket of body?.data ?? []) {
        for (const result of bucket?.results ?? []) {
          total += toNumber(result?.amount) ?? 0
          if (result?.currency) currency = String(result.currency).toUpperCase()
        }
      }
      return {
        balances: null,
        usages: [{ label: `month spend (${currency})`, used: total, limit: null, remaining: null, percent: null, resetAt: null }],
      }
    },
  },

  minimax: {
    view: 'usage',
    match: /minimax/i,
    async fetch(baseURL, apiKey, signal) {
      // MiniMax Coding/Token Plan remains. The route baseURL is the
      // Anthropic-compatible endpoint (.../anthropic); the quota endpoint
      // hangs off the host root. Global: api.minimax.io, CN: api.minimaxi.com.
      const origin = new URL(baseURL).origin
      const body = await fetchJson(`${origin}/v1/api/openplatform/coding_plan/remains`, apiKey, signal)
      const statusCode = toNumber(body?.base_resp?.status_code)
      if (statusCode !== null && statusCode !== 0) {
        throw new Error(String(body?.base_resp?.status_msg ?? `MiniMax API error ${statusCode}`))
      }
      const rows: UsageRow[] = []
      const remains: any[] = Array.isArray(body?.model_remains) ? body.model_remains : []
      // Only the coding lane ('general') matters; video etc. are separate plans.
      const general = remains.find((item) => item?.model_name === 'general') ?? remains[0]
      if (general !== null && typeof general === 'object') {
        const intervalRemaining = toNumber(general.current_interval_remaining_percent)
        if (intervalRemaining !== null) {
          rows.push({
            label: '5h limit',
            used: 100 - intervalRemaining,
            limit: 100,
            remaining: intervalRemaining,
            percent: 100 - intervalRemaining,
            resetAt: toResetAt(general.end_time),
          })
        }
        // current_weekly_status === 1 means the plan carries a weekly cap.
        if (toNumber(general.current_weekly_status) === 1) {
          const weeklyRemaining = toNumber(general.current_weekly_remaining_percent)
          if (weeklyRemaining !== null) {
            rows.push({
              label: 'weekly',
              used: 100 - weeklyRemaining,
              limit: 100,
              remaining: weeklyRemaining,
              percent: 100 - weeklyRemaining,
              resetAt: toResetAt(general.weekly_end_time),
            })
          }
        }
      }
      return { balances: null, usages: orderUsageRows(rows) }
    },
  },

  zai: {
    view: 'usage',
    match: /api\.z\.ai|bigmodel\.cn/i,
    async fetch(baseURL, apiKey, signal) {
      // z.ai / GLM Coding Plan quota. The route baseURL is the coding endpoint
      // (.../api/coding/paas/v4); the quota monitor hangs off the host root.
      // Global: api.z.ai, CN: open.bigmodel.cn. Zhipu auth quirk: the raw key
      // goes in Authorization with NO Bearer prefix.
      const origin = new URL(baseURL).origin
      const body = await fetchJson(`${origin}/api/monitor/usage/quota/limit`, apiKey, signal, {
        authorization: apiKey,
        'content-type': 'application/json',
        'accept-language': 'en-US,en',
      })
      if (body?.success === false) {
        throw new Error(String(body?.msg ?? body?.message ?? 'z.ai quota query failed'))
      }
      const limits: any[] = Array.isArray(body?.data?.limits) ? body.data.limits : []
      // TOKENS_LIMIT entries are the coding-plan windows (percentage = used);
      // TIME_LIMIT is the MCP lane and carries no token quota. The nearer
      // reset is the 5h window, the further one the weekly window.
      const tokenLimits = limits
        .filter((item) => item?.type === 'TOKENS_LIMIT')
        .sort((a, b) => (toNumber(a?.nextResetTime) ?? Infinity) - (toNumber(b?.nextResetTime) ?? Infinity))
      const rows: UsageRow[] = []
      tokenLimits.forEach((item, index) => {
        const percent = toNumber(item?.percentage)
        if (percent === null) return
        rows.push({
          label: index === 0 ? '5h limit' : index === 1 ? 'weekly' : `limit ${index + 1}`,
          used: percent,
          limit: 100,
          remaining: 100 - percent,
          percent,
          resetAt: toResetAt(item?.nextResetTime),
        })
      })
      return { balances: null, usages: orderUsageRows(rows) }
    },
  },

  opencode: {
    view: 'usage',
    match: /opencode\.ai/i,
    async fetch(baseURL, apiKey, signal) {
      // OpenCode subscription quota. Confirmed for the Go plan
      // (/zen/go/v1/usage); the plain Zen route derives the symmetric path.
      const base = root(baseURL)
      const url = base.endsWith('/v1') ? `${base}/usage` : `${base}/v1/usage`
      const body = await fetchJson(url, apiKey, signal)
      const rows: UsageRow[] = []
      const windows: Array<[string, any]> = [
        ['5h limit', body?.usage?.rolling],
        ['weekly', body?.usage?.weekly],
        ['monthly', body?.usage?.monthly],
      ]
      for (const [label, win] of windows) {
        if (win === null || typeof win !== 'object') continue
        const percent = toNumber(win.percent)
        if (percent === null) continue
        rows.push({ label, used: percent, limit: 100, remaining: 100 - percent, percent, resetAt: toResetAt(win.resetsAt ?? win.resets_at) })
      }
      return { balances: null, usages: orderUsageRows(rows) }
    },
  },

  'vercel-ai-gateway': {
    view: 'balance',
    match: /ai-gateway\.vercel\.sh/i,
    async fetch(baseURL, apiKey, signal) {
      // Documented REST API: GET /v1/credits answers the team's remaining
      // credit balance (USD string) plus lifetime spend.
      const base = root(baseURL)
      const url = base.endsWith('/v1') ? `${base}/credits` : `${base}/v1/credits`
      const body = await fetchJson(url, apiKey, signal)
      const balance = body?.balance
      if (balance === undefined || balance === null) throw new Error('no balance in the credits response')
      return {
        balances: [{ currency: 'USD', total: String(balance), granted: '0', toppedUp: '0' }],
        usages: null,
      }
    },
  },

  xai: {
    view: 'balance',
    match: /x\.ai/i,
    async fetch(baseURL, apiKey, signal) {
      // Two documented-in-practice paths:
      // - inference route (api.x.ai/v1): undocumented but widely used
      //   GET /v1/billing/credits with the regular inference key;
      // - manual Management API spec (management-api.x.ai/v1/billing/teams/
      //   {teamId}): GET .../prepaid/balance with a management key.
      // Both answer {total:{val}} in USD cents with inverted sign
      // (negative = credit held).
      const base = root(baseURL)
      const url = /management-api\.x\.ai/i.test(base) ? `${base}/prepaid/balance` : `${base}/billing/credits`
      const body = await fetchJson(url, apiKey, signal)
      const cents = toNumber(body?.total?.val)
      if (cents === null) throw new Error('no balance data in the billing response')
      const balance = (Math.abs(cents) / 100).toFixed(2)
      return {
        balances: [{ currency: 'USD', total: balance, granted: '0', toppedUp: balance }],
        usages: null,
      }
    },
  },

  'volcengine-ark-agent': {
    view: 'usage',
    // The plan endpoint's own baseURL (`/api/plan`, with or without `/v3`);
    // the quota itself is a signed control-plane call (see volcengine-ark.ts).
    match: /volces\.com\/api\/plan/i,
    credentialRefs: [ACCESS_KEY_REFS, SECRET_KEY_REFS],
    async fetch(_baseURL, _apiKey, signal, _refresh, credentials) {
      const body = await fetchVolcenginePlan(AGENT_PLAN_ACTIONS, credentials, signal)
      return { balances: null, usages: parseAgentPlanUsage(body) }
    },
  },

  'volcengine-ark-coding': {
    view: 'usage',
    match: /volces\.com\/api\/coding/i,
    credentialRefs: [ACCESS_KEY_REFS, SECRET_KEY_REFS],
    async fetch(_baseURL, _apiKey, signal, _refresh, credentials) {
      const body = await fetchVolcenginePlan(CODING_PLAN_ACTIONS, credentials, signal)
      return { balances: null, usages: parseCodingPlanUsage(body) }
    },
  },
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export class UsageService extends TypertRemoteService {
  private readonly options: () => ProviderUsageConfig

  /**
   * Latched when upstream refuses the stored Codex refresh token. Keyed by the
   * dead token so a new authorization clears it with nothing to reset, and
   * time-boxed so a repaired credential is picked up even without a re-login.
   */
  private codexReauth: { refreshToken: string; message: string; until: number } | undefined

  constructor(ctx: Context, options: () => ProviderUsageConfig) {
    super(ctx, 'usage')
    this.options = options
  }

  /**
   * Fetch the live quota snapshot of every configured provider.
   * @param signal - optional cancellation signal carried over the RPC carrier.
   */
  async list(signal?: AbortSignal): Promise<UsageListResult> {
    const specs = await this.collectSpecs()
    const activeProviderId = this.currentProviderId()
    const providers = await Promise.all(specs.map((spec) => this.fetchProvider(spec, activeProviderId, signal)))
    return {
      fetchedAt: new Date().toISOString(),
      refreshSeconds: this.options().refreshSeconds,
      balanceRedThreshold: this.options().balanceRedThreshold,
      balanceYellowThreshold: this.options().balanceYellowThreshold,
      version,
      providers,
    }
  }

  /**
   * The provider route in use: the harness's current default model selection,
   * kept in sync whenever the composer's model seat selects a provider/model
   * (`session/selectModel` → `agent-default-model` settings). Null when the
   * service is not mounted or no selection is stored yet — the client then
   * falls back to judging every provider.
   */
  private currentProviderId(): string | null {
    const service = this.ctx.get('agentDefaultModel') as
      | { currentSelection?: () => { provider: string } }
      | undefined
    const provider = service?.currentSelection?.().provider
    return typeof provider === 'string' && provider !== '' ? provider : null
  }

  /** Enumerate provider routes (registry + settings), then apply manual overrides. */
  private async collectSpecs(): Promise<DetectedProvider[]> {
    const options = this.options()
    const specs: DetectedProvider[] = []
    if (options.autoDetect) {
      const llm = this.ctx.get('llm')
      const settings = this.ctx.get('settings')
      const routes: Array<{ id: string; name: string }> = llm?.listProviders?.() ?? []
      for (const route of routes) {
        specs.push(await this.resolveRoute(route, settings))
      }
    }
    for (const extra of options.providers) {
      if (!extra.enabled) continue
      const spec: ResolvedProvider = {
        id: extra.id,
        displayName: extra.displayName || extra.id,
        kind: extra.kind,
        baseURL: extra.baseURL,
        apiKeyEnv: extra.apiKeyEnv,
      }
      const index = specs.findIndex((existing) => !('unsupported' in existing) && existing.id === spec.id)
      if (index < 0) specs.push(spec)
      else specs[index] = spec
    }
    return specs
  }

  private async readSection(settings: any, ns: string): Promise<any> {
    if (!settings) return undefined
    try {
      return await Promise.resolve(settings.get(ns))
    } catch {
      return undefined
    }
  }

  private async resolveRoute(route: { id: string; name: string }, settings: any): Promise<DetectedProvider> {
    const known = KNOWN_ROUTES[route.id]
    let baseURL: string | undefined
    let apiKeyEnv: string | undefined
    if (route.id === 'deepseek-official') {
      const section = await this.readSection(settings, 'llm-deepseek')
      baseURL = section?.baseURL ?? launchEnvironmentOf(this.ctx).get('DEEPSEEK_BASE_URL')?.value ?? known?.baseURL
      apiKeyEnv = section?.apiKeyEnv ?? known?.apiKeyEnv
    } else {
      const section = await this.readSection(settings, 'llm-pi-ai')
      const profile = section?.providers?.[route.id]
      baseURL = profile?.baseURL ?? known?.baseURL
      apiKeyEnv = profile?.apiKeyEnv ?? known?.apiKeyEnv
    }
    if (baseURL !== undefined) {
      const kind = kindOfBaseURL(baseURL)
      if (kind !== null && (apiKeyEnv !== undefined || kind === 'openai-codex' || ownsCredentials(kind))) {
        return {
          id: route.id,
          displayName: route.name || known?.displayName || route.id,
          kind,
          baseURL,
          ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
        }
      }
    }
    return { unsupported: true, route }
  }

  private async resolveApiKey(ref: string): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(credentialRef(ref))
      if (hit !== undefined && hit.value.length > 0) return hit.value
      return undefined
    }
    const ambient = launchEnvironmentOf(this.ctx).get(ref)
    if (ambient !== undefined && ambient.value.length > 0) return ambient.value
    return undefined
  }

  /**
   * Resolve the Codex OAuth grant from the harness credential records,
   * refreshing it when close to expiry. The rotation itself runs inside the
   * credential store's exclusive lock (see {@link resolveOpenAiCodexGrant}),
   * and a grant upstream has already invalidated latches a re-auth verdict so
   * later polls report "sign in again" instead of spending a doomed round trip
   * on the token endpoint every interval.
   */
  private async resolveOpenAiCodexGrant(signal: AbortSignal): Promise<OpenAiCodexGrant | undefined> {
    const credentials = this.ctx.get('credentials') as OpenAiCodexGrantStore<CredentialRecord> | undefined
    if (credentials === undefined) return undefined
    const key: string = credentialKey('llm-pi-ai', 'openai-codex')

    const latched = this.codexReauth
    if (latched !== undefined) {
      // Re-check against the live record: a new sign-in stores a different
      // refresh token, which is the whole signal that the latch is obsolete.
      const record = await credentials.readRecord(key)
      const current = record === undefined || record.kind !== 'grant' ? null : parseOpenAiCodexGrant(record.payload)
      if (current !== null && current.refresh === latched.refreshToken && Date.now() < latched.until) {
        throw new OpenAiCodexReauthRequiredError(latched.message, latched.refreshToken)
      }
      this.codexReauth = undefined
    }

    try {
      const toRecord = (grant: OpenAiCodexGrant): CredentialRecord => ({ kind: 'grant', payload: grant })
      return await resolveOpenAiCodexGrant(credentials, key, toRecord, signal)
    } catch (error) {
      if (error instanceof OpenAiCodexReauthRequiredError) {
        this.codexReauth = {
          refreshToken: error.refreshToken,
          message: error.message,
          until: Date.now() + CODEX_REAUTH_BACKOFF_MS,
        }
      }
      throw error
    }
  }

  private async fetchProvider(spec: DetectedProvider, activeProviderId: string | null, outerSignal?: AbortSignal): Promise<ProviderUsageView> {
    if ('unsupported' in spec) {
      return failView(spec.route.id, spec.route.name || spec.route.id, null, 'unsupported', spec.route.id, spec.route.id === activeProviderId)
    }
    const active = spec.id === activeProviderId
    const adapter = ADAPTERS[spec.kind]
    const base = { id: spec.id, displayName: spec.displayName, kind: adapter.view, balances: null, usages: null, active }
    const options = this.options()
    const maxAttempts = options.queryRetries + 1
    // Each attempt gets a fresh per-attempt timeout fused with the caller's
    // signal; transient failures (timeout / network / HTTP 408/425/429/5xx)
    // back off exponentially, permanent errors fail immediately.
    for (let attempt = 1; ; attempt++) {
      const signal = AbortSignal.any([AbortSignal.timeout(options.queryTimeoutMs), ...(outerSignal ? [outerSignal] : [])])
      try {
        let apiKey: string
        let refresh: RefreshFn | undefined
        let credentials: string[] | undefined
        if (adapter.credentialRefs !== undefined) {
          // Adapters that sign with their own credential pair (Volcengine
          // AK/SK): the route's `apiKeyEnv` is the data-plane inference key and
          // is never sent to the quota endpoint. Each slot accepts the first
          // alias that resolves, and every slot must resolve.
          const slots: string[] = []
          for (const slot of adapter.credentialRefs) {
            let hit: string | undefined
            for (const ref of slot) {
              hit = await this.resolveApiKey(ref)
              if (hit !== undefined) break
            }
            if (hit === undefined) {
              const hint = adapter.credentialRefs.map((candidates) => candidates[0]).join(' + ')
              return failView(spec.id, spec.displayName, adapter.view, 'missing-credential', hint, active)
            }
            slots.push(hit)
          }
          credentials = slots
          apiKey = slots[0]
        } else if (spec.kind === 'openai-codex' && spec.apiKeyEnv === undefined) {
          // One resolution per attempt, shared by the quota call and the
          // adapter's post-401 retry: a second refresh built on the same
          // single-use refresh token is rejected upstream as
          // `refresh_token_reused`, which is exactly the failure this closes.
          // The adapter passes the same attempt signal it was given.
          let resolved: Promise<OpenAiCodexGrant | undefined> | undefined
          const grant = (): Promise<OpenAiCodexGrant | undefined> => (resolved ??= this.resolveOpenAiCodexGrant(signal))
          refresh = async (refreshSignal) => {
            const current = await (refreshSignal === signal ? grant() : this.resolveOpenAiCodexGrant(refreshSignal))
            if (current === undefined) throw new Error('OpenAI Codex OAuth authorization missing')
            return current.access
          }
          const current = await grant()
          if (current === undefined) {
            return failView(spec.id, spec.displayName, adapter.view, 'missing-authorization', 'llm-pi-ai/openai-codex', active)
          }
          apiKey = current.access
        } else {
          const resolved = await this.resolveApiKey(spec.apiKeyEnv!)
          if (resolved === undefined) {
            return failView(spec.id, spec.displayName, adapter.view, 'missing-credential', spec.apiKeyEnv!, active)
          }
          apiKey = resolved
        }
        const payload = await adapter.fetch(spec.baseURL, apiKey, signal, refresh, credentials)
        return okView({ ...base, ...payload })
      } catch (error) {
        if (outerSignal?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        // An unrecoverable grant is its own state, not a query failure: report
        // what a human must do, and never retry it into the token endpoint.
        if (error instanceof OpenAiCodexReauthRequiredError) {
          return failView(spec.id, spec.displayName, adapter.view, 'reauth-required', message, active)
        }
        if (attempt >= maxAttempts || !isTransientQueryError(error)) {
          return failView(spec.id, spec.displayName, adapter.view, 'error', message, active)
        }
        const delayMs = Math.min(options.queryRetryDelayMs * 2 ** (attempt - 1), 10000)
        await sleep(delayMs, outerSignal)
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

/**
 * Apply the standard-decorator Remote marker without decorator syntax (the
 * bundle targets Node 22, which cannot parse decorator syntax). The marker
 * table is keyed by prototype, so running the recorded initializer once
 * against a prototype-chained pseudo instance registers the method for every
 * future service instance (`remoteMethods` reads `Object.getPrototypeOf`).
 */
function markRemoteMethod(prototype: object, method: string, exportName: string): void {
  const initializers: Array<(this: object) => void> = []
  const decorate = Remote(exportName) as (method: unknown, context: object) => void
  decorate(undefined, {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer: (fn: (this: object) => void) => {
      initializers.push(fn)
    },
  })
  const pseudo = Object.create(prototype) as object
  for (const initializer of initializers) initializer.call(pseudo)
}

markRemoteMethod(UsageService.prototype, 'list', 'list')

export function apply(ctx: Context, config: ProviderUsageConfig) {
  let current = () => config
  // Register the `provider-usage` settings namespace through the settings
  // service (dsh ≥ 0.1.2: SettingsProvider.installSection replaces the old
  // installSettingsSection helper). The source thunk feeds the live config
  // below, so a `provider-usage:` section in settings.yaml hot-updates it.
  ctx.inject(['settings'], (settingsCtx: any) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source: () => ProviderUsageConfig) => {
        current = source
      },
      onChange: () => {},
    })
  })
  // Constructing the service registers `ctx.usage` and the `usage/*` wire namespace.
  new UsageService(ctx, () => current())
}
