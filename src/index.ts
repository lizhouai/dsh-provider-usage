/**
 * provider-quota — host half.
 *
 * A `ctx.quota` Typert Remote service that reports the account balance/quota
 * of every configured LLM provider route. Provider routes are auto-detected
 * from the live `llm` registry plus the composed settings sections, keys are
 * resolved per request through the credentials service (never cached), and
 * each provider kind has its own wire adapter:
 *
 * - `deepseek`    → GET {baseURL}/user/balance          (充值余额)
 * - `kimi-coding` → GET {baseURL}/v1/usages             (订阅配额, weekly / 5h windows)
 * - `moonshot`    → GET {baseURL}/users/me/balance      (开放平台余额)
 *
 * The browser widget polls `quota/list` on its own configurable interval, so
 * this service stays stateless: every call fetches live values.
 * @module dsh-provider-quota
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'provider-quota'

const NS = settingsNamespace('provider-quota')

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

export interface ProviderQuotaView {
  id: string
  displayName: string
  kind: 'balance' | 'usage' | null
  status: 'ok' | 'error' | 'missing-credential' | 'unsupported'
  message: string | null
  balances: BalanceRow[] | null
  usages: UsageRow[] | null
}

export interface QuotaListResult {
  fetchedAt: string
  /** Deployment-suggested refresh interval; the widget may override it locally. */
  refreshSeconds: number
  providers: ProviderQuotaView[]
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const ProviderSpec = z.object({
  /** Route id this spec describes (manual specs may use any unique id). */
  id: z.string(),
  kind: z.union(['deepseek', 'kimi-coding', 'moonshot']),
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

export interface ProviderQuotaConfig {
  refreshSeconds: number
  autoDetect: boolean
  providers: Array<{
    id: string
    kind: 'deepseek' | 'kimi-coding' | 'moonshot'
    baseURL: string
    apiKeyEnv: string
    displayName: string
    enabled: boolean
  }>
}

type ProviderKind = 'deepseek' | 'kimi-coding' | 'moonshot'

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

/** Catalog fallback for well-known routes when the settings section omits connection facts. */
const KNOWN_ROUTES: Record<string, { baseURL: string; apiKeyEnv: string; displayName: string }> = {
  'deepseek-official': { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' },
  deepseek: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' },
  'kimi-coding': { baseURL: 'https://api.kimi.com/coding', apiKeyEnv: 'KIMI_API_KEY', displayName: 'Kimi Code' },
  'moonshotai-cn': { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY', displayName: 'Moonshot' },
  moonshotai: { baseURL: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_API_KEY', displayName: 'Moonshot' },
}

/** Classify a provider endpoint by host; returns null for endpoints with no quota adapter. */
function kindOfBaseURL(baseURL: string): ProviderKind | null {
  if (/api\.kimi\.com\/coding/i.test(baseURL)) return 'kimi-coding'
  if (/moonshot/i.test(baseURL)) return 'moonshot'
  if (/deepseek/i.test(baseURL)) return 'deepseek'
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
  const response = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...extraHeaders },
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

function okView(base: Omit<ProviderQuotaView, 'status' | 'message'>): ProviderQuotaView {
  return { ...base, status: 'ok', message: null }
}

function failView(id: string, displayName: string, kind: ProviderQuotaView['kind'], status: ProviderQuotaView['status'], message: string): ProviderQuotaView {
  return { id, displayName, kind, status, message, balances: null, usages: null }
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export class QuotaService extends TypertRemoteService {
  private readonly options: () => ProviderQuotaConfig

  constructor(ctx: Context, options: () => ProviderQuotaConfig) {
    super(ctx, 'quota')
    this.options = options
  }

  /**
   * Fetch the live quota snapshot of every configured provider.
   * @param signal - optional cancellation signal carried over the RPC carrier.
   */
  async list(signal?: AbortSignal): Promise<QuotaListResult> {
    const specs = await this.collectSpecs()
    const providers = await Promise.all(specs.map((spec) => this.fetchProvider(spec, signal)))
    return {
      fetchedAt: new Date().toISOString(),
      refreshSeconds: this.options().refreshSeconds,
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

  private async fetchProvider(spec: DetectedProvider, outerSignal?: AbortSignal): Promise<ProviderQuotaView> {
    if ('unsupported' in spec) {
      return failView(spec.route.id, spec.route.name || spec.route.id, null, 'unsupported', spec.route.id)
    }
    const kind: ProviderQuotaView['kind'] = spec.kind === 'kimi-coding' ? 'usage' : 'balance'
    const base = { id: spec.id, displayName: spec.displayName, kind, balances: null, usages: null }
    const apiKey = await this.resolveApiKey(spec.apiKeyEnv)
    if (apiKey === undefined) {
      return failView(spec.id, spec.displayName, kind, 'missing-credential', spec.apiKeyEnv)
    }
    const signal = AbortSignal.any([AbortSignal.timeout(15000), ...(outerSignal ? [outerSignal] : [])])
    try {
      if (spec.kind === 'deepseek') {
        const body = await fetchJson(`${spec.baseURL.replace(/\/+$/, '')}/user/balance`, apiKey, signal)
        const infos: any[] = Array.isArray(body?.balance_infos) ? body.balance_infos : []
        return okView({
          ...base,
          balances: infos.map((info) => ({
            currency: String(info.currency ?? ''),
            total: String(info.total_balance ?? '0'),
            granted: String(info.granted_balance ?? '0'),
            toppedUp: String(info.topped_up_balance ?? '0'),
          })),
          usages: null,
        })
      }
      if (spec.kind === 'kimi-coding') {
        const root = spec.baseURL.replace(/\/+$/, '')
        const url = root.endsWith('/v1') ? `${root}/usages` : `${root}/v1/usages`
        const body = await fetchJson(url, apiKey, signal, { 'user-agent': 'KimiCLI/1.6' })
        return okView({ ...base, balances: null, usages: parseKimiUsages(body) })
      }
      const body = await fetchJson(`${spec.baseURL.replace(/\/+$/, '')}/users/me/balance`, apiKey, signal)
      const data = body?.data ?? {}
      return okView({
        ...base,
        balances: [{
          currency: String(data.currency ?? 'CNY'),
          total: String(data.available_balance ?? '0'),
          granted: String(data.voucher_balance ?? '0'),
          toppedUp: String(data.cash_balance ?? '0'),
        }],
        usages: null,
      })
    } catch (error) {
      if (outerSignal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      return failView(spec.id, spec.displayName, kind, 'error', message)
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

markRemoteMethod(QuotaService.prototype, 'list', 'list')

export function apply(ctx: Context, config: ProviderQuotaConfig) {
  let current = () => config
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source as () => ProviderQuotaConfig
    },
    onChange: () => {},
  })
  // Constructing the service registers `ctx.quota` and the `quota/*` wire namespace.
  new QuotaService(ctx, () => current())
}
