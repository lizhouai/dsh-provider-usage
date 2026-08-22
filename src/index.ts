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
 * - `openai-codex`   → GET {baseURL}/wham/usage                (ChatGPT 订阅 5h/weekly 窗口)
 * - `openai`         → GET {origin}/v1/organization/costs      (Admin key, 当月花费)
 * - `anthropic`      → GET {baseURL}/v1/organizations/cost_report (Admin key, 当月花费)
 * - `minimax`        → GET {origin}/v1/api/openplatform/coding_plan/remains (Coding Plan 5h/weekly)
 * - `zai`            → GET {origin}/api/monitor/usage/quota/limit (GLM Coding Plan 配额)
 * - `opencode`       → GET {baseURL}/usage                     (Zen Go 订阅 5h/weekly/monthly)
 * - `vercel-ai-gateway` → GET {baseURL}/v1/credits             (团队 credit 余额)
 * - `xai`            → GET {baseURL}/billing/credits           (预付余额; Management API 见注释)
 *
 * The browser widget polls `usage/list` on its own configurable interval, so
 * this service stays stateless: every call fetches live values.
 * @module dsh-provider-usage
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'provider-usage'

/** Own package version, baked in by tsdown `define` at build time (the
    fallback only fires if the sources are compiled some other way). */
export const version: string = typeof __PLUGIN_VERSION__ === 'undefined' ? '0.0.0-dev' : __PLUGIN_VERSION__

const NS = settingsNamespace('provider-usage')

/* ------------------------------------------------------------------ *
 * Wire views (mirrored by the client bundle)
 * ------------------------------------------------------------------ */

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
  status: 'ok' | 'error' | 'missing-credential' | 'unsupported'
  message: string | null
  balances: BalanceRow[] | null
  usages: UsageRow[] | null
}

export interface UsageListResult {
  fetchedAt: string
  /** Deployment-suggested refresh interval; the widget may override it locally. */
  refreshSeconds: number
  /** Plugin package version, surfaced in the panel header. */
  version: string
  providers: ProviderUsageView[]
}

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
] as const

type ProviderKind = (typeof PROVIDER_KINDS)[number]

/** What one quota probe returns: either balance rows or usage windows. */
interface AdapterPayload {
  balances: BalanceRow[] | null
  usages: UsageRow[] | null
}

interface QuotaAdapter {
  /** Panel data shape this adapter produces. */
  view: 'balance' | 'usage'
  /** Auto-classification: a route whose baseURL matches belongs to this kind. */
  match: RegExp
  /** Extra request headers beyond Authorization/Accept. */
  headers?: Record<string, string>
  fetch(baseURL: string, apiKey: string, signal: AbortSignal): Promise<AdapterPayload>
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
  /** Enumerate live provider routes from the llm registry. */
  autoDetect: z.boolean().default(true),
  /** Manual provider specs; an id matching a detected route overrides it. */
  providers: z.array(ProviderSpec).default([]),
})

export interface ProviderUsageConfig {
  refreshSeconds: number
  autoDetect: boolean
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
  apiKeyEnv: string
}

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

/* ------------------------------------------------------------------ *
 * Response parsing helpers
 * ------------------------------------------------------------------ */

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toResetAt(value: unknown): string | null {
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

function usageRow(raw: any, fallbackLabel: string): UsageRow | null {
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
    return rows
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
  return rows
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

async function fetchJson(url: string, apiKey: string, signal: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<any> {
  // Adapters with a non-Bearer credential (x-api-key, `token <oauth>`) pass it
  // through extraHeaders; only then is the default Bearer header withheld.
  const hasAuth = Object.keys(extraHeaders).some((h) => {
    const lower = h.toLowerCase()
    return lower === 'authorization' || lower === 'x-api-key'
  })
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...(hasAuth ? {} : { authorization: `Bearer ${apiKey}` }), ...extraHeaders },
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
    const detail = body?.error?.message ?? body?.message
    throw new Error(`HTTP ${response.status}${typeof detail === 'string' ? `: ${detail}` : ''}`)
  }
  return body
}

function okView(base: Omit<ProviderUsageView, 'status' | 'message'>): ProviderUsageView {
  return { ...base, status: 'ok', message: null }
}

function failView(id: string, displayName: string, kind: ProviderUsageView['kind'], status: ProviderUsageView['status'], message: string): ProviderUsageView {
  return { id, displayName, kind, status, message, balances: null, usages: null }
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
    async fetch(baseURL, apiKey, signal) {
      // ChatGPT subscription side endpoint (OAuth access token, not an API key).
      const body = await fetchJson(`${root(baseURL)}/wham/usage`, apiKey, signal)
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
      const credits = toNumber(body?.credits?.balance)
      if (credits !== null) {
        rows.push({ label: 'credits', used: null, limit: null, remaining: credits, percent: null, resetAt: null })
      }
      return { balances: null, usages: rows }
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
      return { balances: null, usages: rows }
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
      return { balances: null, usages: rows }
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
      return { balances: null, usages: rows }
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
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export class UsageService extends TypertRemoteService {
  private readonly options: () => ProviderUsageConfig

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
    const providers = await Promise.all(specs.map((spec) => this.fetchProvider(spec, signal)))
    return {
      fetchedAt: new Date().toISOString(),
      refreshSeconds: this.options().refreshSeconds,
      version,
      providers,
    }
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
      if (kind !== null && apiKeyEnv !== undefined) {
        return { id: route.id, displayName: route.name || known?.displayName || route.id, kind, baseURL, apiKeyEnv }
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

  private async fetchProvider(spec: DetectedProvider, outerSignal?: AbortSignal): Promise<ProviderUsageView> {
    if ('unsupported' in spec) {
      return failView(spec.route.id, spec.route.name || spec.route.id, null, 'unsupported', spec.route.id)
    }
    const adapter = ADAPTERS[spec.kind]
    const base = { id: spec.id, displayName: spec.displayName, kind: adapter.view, balances: null, usages: null }
    const apiKey = await this.resolveApiKey(spec.apiKeyEnv)
    if (apiKey === undefined) {
      return failView(spec.id, spec.displayName, adapter.view, 'missing-credential', spec.apiKeyEnv)
    }
    const signal = AbortSignal.any([AbortSignal.timeout(15000), ...(outerSignal ? [outerSignal] : [])])
    try {
      const payload = await adapter.fetch(spec.baseURL, apiKey, signal)
      return okView({ ...base, ...payload })
    } catch (error) {
      if (outerSignal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      return failView(spec.id, spec.displayName, adapter.view, 'error', message)
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
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source as () => ProviderUsageConfig
    },
    onChange: () => {},
  })
  // Constructing the service registers `ctx.usage` and the `usage/*` wire namespace.
  new UsageService(ctx, () => current())
}
