/**
 * Floating-ball quota widget: a draggable ball portaled to document.body
 * (the sidebar slot only mounts the component; the button itself no longer
 * lives in the sidebar, avoiding slot layout contention with other plugins).
 * The popover panel lists every configured provider's live balance/quota.
 * Polling interval is user-selectable (persisted in localStorage) and falls
 * back to the deployment-suggested value from the host plugin config.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { en, zh } from './locales'

/* ------------------------------------------------------------------ *
 * Wire views (mirror of the host half)
 * ------------------------------------------------------------------ */

interface BalanceRow {
  currency: string
  total: string
  granted: string
  toppedUp: string
}

interface UsageRow {
  label: string
  used: number | null
  limit: number | null
  remaining: number | null
  percent: number | null
  resetAt: string | null
}

interface ProviderUsageView {
  id: string
  displayName: string
  kind: 'balance' | 'usage' | null
  status: 'ok' | 'error' | 'missing-credential' | 'missing-authorization' | 'unsupported'
  message: string | null
  balances: BalanceRow[] | null
  usages: UsageRow[] | null
  /** The provider in use (absent on older hosts); it alone drives the ball tone. */
  active?: boolean
}

interface UsageListResult {
  fetchedAt: string
  refreshSeconds: number
  /** Deployment-suggested balance thresholds (absent on older hosts);
      the panel may override them locally. */
  balanceRedThreshold?: number
  balanceYellowThreshold?: number
  /** Plugin package version (absent on older hosts). */
  version?: string
  providers: ProviderUsageView[]
}

export interface UsageActionProps {
  /** Sidebar expansion state, owned by the sidebar footer slot. Not read
      directly — a change re-renders us, which re-anchors the default dock. */
  wide?: boolean
  /** Namespace translator injected by the locale seat. */
  t: (key: string, params?: Record<string, unknown>) => string
  /** Business face: call the host `usage/list` remote. */
  fetchUsage: () => Promise<UsageListResult>
  /** Provider the FOCUSED session's composer would use (live client state);
      undefined when unavailable — the host's own flag then stands. */
  getActiveProvider?: () => string | undefined
  /** Subscribe to focused-session / model-selection changes; the panel
      re-derives the "in use" flag on every change, without a poll tick. */
  subscribeActiveChange?: (onChange: () => void) => (() => void)
}

/* ------------------------------------------------------------------ *
 * Refresh interval
 * ------------------------------------------------------------------ */

const INTERVAL_OPTIONS = [15, 30, 60, 300, 900, 1800] as const
const STORAGE_KEY = 'dsh.provider-usage.refreshSeconds'
const LANG_KEY = 'dsh.provider-usage.lang'
const POS_KEY = 'dsh.provider-usage.floatPos'
const THRESHOLD_RED_KEY = 'dsh.provider-usage.balanceRedThreshold'
const THRESHOLD_YELLOW_KEY = 'dsh.provider-usage.balanceYellowThreshold'
const PANEL_HEIGHT_KEY = 'dsh.provider-usage.panelHeight'
const DEFAULT_INTERVAL = 60
/** Balance thresholds fall back to these hardcoded defaults when neither the
    host config nor a stored override provides them. */
const DEFAULT_BALANCE_RED = 10
const DEFAULT_BALANCE_YELLOW = 30
/** Smallest panel height the top-edge drag allows (px). */
const PANEL_MIN_H = 120

/** Largest panel height the top-edge drag allows: the viewport minus a
    breathing margin, so the panel can never outgrow the screen. */
function panelMaxHeight(): number {
  return Math.max(PANEL_MIN_H, window.innerHeight - 24)
}

/** Bottom padding of the open panel (px), read live so the layout math stays
    correct if the stylesheet ever changes it. */
function panelPaddingBottom(panel: HTMLElement): number {
  const pad = Number.parseFloat(getComputedStyle(panel).paddingBottom)
  return Number.isFinite(pad) ? pad : 0
}

/**
 * Natural content height of the open panel — children plus padding — even
 * while the panel itself is height-constrained or scrolled (children rects
 * are compensated by scrollTop). This is the grow limit: at this height the
 * panel needs no scrolling and leaves no blank strip at the bottom.
 */
function panelContentHeight(panel: HTMLElement): number {
  const panelTop = panel.getBoundingClientRect().top
  let bottom = 0
  for (const child of Array.from(panel.children)) {
    const rect = (child as HTMLElement).getBoundingClientRect()
    bottom = Math.max(bottom, rect.bottom - panelTop + panel.scrollTop)
  }
  return Math.ceil(bottom) + panelPaddingBottom(panel)
}

/**
 * Shrink limit: the height that keeps the panel head plus the FIRST provider
 * card fully visible (bottom padding included). Falls back to PANEL_MIN_H
 * when no provider card is present (e.g. empty list).
 */
function firstCardMinHeight(panel: HTMLElement): number {
  const card = panel.querySelector<HTMLElement>('.dsh-usage-card')
  if (card === null) return PANEL_MIN_H
  const panelTop = panel.getBoundingClientRect().top
  const cardRect = card.getBoundingClientRect()
  return Math.ceil(cardRect.bottom - panelTop + panel.scrollTop) + panelPaddingBottom(panel)
}

/** Floating ball diameter in px; drag math derives from it. */
const BALL_SIZE = 32

type Lang = 'zh' | 'en'
/** Docked ball position: the ball CENTER as fractions of the viewport, so
    both the default spot and dragged spots follow window resizes. */
interface FloatPos {
  fx: number
  fy: number
}

/** Panel-level override stored in localStorage; null means follow the harness language. */
function readStoredLang(): Lang | null {
  try {
    const raw = localStorage.getItem(LANG_KEY)
    return raw === 'zh' || raw === 'en' ? raw : null
  } catch {
    return null
  }
}

function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang)
  } catch {
    /* storage unavailable: keep the in-memory value only */
  }
}

/** Local translator over the bundled dictionaries, mirroring the shell's `{param}` interpolation. */
function makeT(dict: Record<string, string>): UsageActionProps['t'] {
  return (key, params) => {
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (raw, name: string) => (name in params ? String(params[name]) : raw))
  }
}

function readStoredInterval(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value >= 5 ? value : null
  } catch {
    return null
  }
}

function storeInterval(value: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    /* storage unavailable: keep the in-memory value only */
  }
}

/* ------------------------------------------------------------------ *
 * Balance thresholds (panel overrides, persisted in localStorage)
 * ------------------------------------------------------------------ */

/** Parse a threshold input: a finite number ≥ 0, or null while the field is
    empty/transiently invalid (the string is kept in state so typing never
    fights the controlled input). */
function parseThreshold(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function readStoredThreshold(key: string): string | null {
  try {
    const raw = localStorage.getItem(key)
    return raw !== null && parseThreshold(raw) !== null ? raw : null
  } catch {
    return null
  }
}

function storeThreshold(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: keep the in-memory value only */
  }
}

/* ------------------------------------------------------------------ *
 * Panel height (user-resized via the top-edge drag handle)
 * ------------------------------------------------------------------ */

function readStoredPanelHeight(): number | null {
  try {
    const raw = localStorage.getItem(PANEL_HEIGHT_KEY)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value >= PANEL_MIN_H ? value : null
  } catch {
    return null
  }
}

function storePanelHeight(value: number): void {
  try {
    localStorage.setItem(PANEL_HEIGHT_KEY, String(value))
  } catch {
    /* storage unavailable: keep the in-memory value only */
  }
}

/* ------------------------------------------------------------------ *
 * Floating ball position
 * ------------------------------------------------------------------ */

/** Equal margin from the chat area's left edge and the window's bottom edge. */
const DOCK_MARGIN = 24

/**
 * Default dock: bottom-left of the main chat area with equal margins on both
 * axes. Returned as viewport fractions of the ball CENTER, like every other
 * position. The chat area's left edge is the sidebar's right edge, derived
 * from the full-height ancestor of the settings slot (stable data-slot hook;
 * class names are build-hashed), so it adapts to sidebar collapse.
 */
function defaultFloatPos(): FloatPos {
  let sidebarRight = 264
  let node = document.querySelector('[data-slot="sidebar.settings"]')?.parentElement ?? null
  while (node) {
    const rect = node.getBoundingClientRect()
    if (rect.x <= 1 && rect.height >= window.innerHeight * 0.9) {
      sidebarRight = rect.right
      break
    }
    node = node.parentElement
  }
  return {
    fx: (sidebarRight + DOCK_MARGIN + BALL_SIZE / 2) / window.innerWidth,
    fy: (window.innerHeight - DOCK_MARGIN - BALL_SIZE / 2) / window.innerHeight,
  }
}

function readStoredFloatPos(): FloatPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<FloatPos> | null
    if (parsed === null || typeof parsed.fx !== 'number' || !Number.isFinite(parsed.fx)) return null
    if (typeof parsed.fy !== 'number' || !Number.isFinite(parsed.fy)) return null
    return { fx: Math.min(1, Math.max(0, parsed.fx)), fy: Math.min(1, Math.max(0, parsed.fy)) }
  } catch {
    return null
  }
}

function storeFloatPos(pos: FloatPos): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos))
  } catch {
    /* storage unavailable: keep the in-memory value only */
  }
}

/** 归位: forget the pinned spot; the ball follows the default dock again. */
function clearStoredFloatPos(): void {
  try {
    localStorage.removeItem(POS_KEY)
  } catch {
    /* storage unavailable */
  }
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

function formatCountdown(resetAt: string, now: number, t: UsageActionProps['t']): string | null {
  const diff = new Date(resetAt).getTime() - now
  if (!Number.isFinite(diff) || diff <= 0) return null
  const minutes = Math.floor(diff / 60000)
  if (minutes >= 60 * 24) return t('countdown.days', { days: Math.floor(minutes / (60 * 24)), hours: Math.floor((minutes % (60 * 24)) / 60) })
  if (minutes >= 60) return t('countdown.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
  return t('countdown.minutes', { minutes: Math.max(1, minutes) })
}

function barTone(percent: number | null): 'ok' | 'warn' | 'danger' {
  if (percent === null) return 'ok'
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/** Parse a balance amount string ("12.34", "0.00") into a number. */
function toAmount(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Tone for a monetary balance, compared in the balance's own currency:
 * below the red threshold → danger, below the yellow threshold → warn,
 * otherwise ok. The effective red threshold never exceeds the yellow one,
 * so the zones stay ordered no matter how the panel is configured.
 */
function balanceTone(value: number | null, red: number, yellow: number): 'ok' | 'warn' | 'danger' {
  if (value === null) return 'ok'
  const effRed = Math.min(red, yellow)
  if (value < effRed) return 'danger'
  if (value < yellow) return 'warn'
  return 'ok'
}

type Tone = 'ok' | 'warn' | 'danger'

const TONE_SEVERITY: Record<Tone, number> = { ok: 0, warn: 1, danger: 2 }

/** More severe of two tones; used WITHIN one category. */
function worseTone(a: Tone | null, b: Tone | null): Tone | null {
  if (a === null) return b
  if (b === null) return a
  return TONE_SEVERITY[a] >= TONE_SEVERITY[b] ? a : b
}

/**
 * Aggregate tone for one provider. The subscription/usage windows ("plan")
 * and the prepaid balance/credits are two INDEPENDENT categories joined with
 * OR semantics: the provider stays green while either category has enough
 * left (the plan is normally consumed before credits, so the surviving
 * resource sets the tone), and when both are running low the lighter warning
 * wins. Within one category the worst row still governs — an exhausted 5h
 * window is not "enough plan" just because the weekly window is healthy.
 */
function providerTone(provider: ProviderUsageView, red: number, yellow: number): Tone {
  let planTone: Tone | null = null
  let creditTone: Tone | null = null
  if (provider.kind === 'balance') {
    for (const row of provider.balances ?? []) {
      creditTone = worseTone(creditTone, balanceTone(toAmount(row.total), red, yellow))
    }
  }
  for (const row of provider.usages ?? []) {
    if (row.label === 'credits') {
      creditTone = worseTone(creditTone, balanceTone(row.remaining, red, yellow))
    } else {
      planTone = worseTone(planTone, barTone(row.percent))
    }
  }
  if (planTone === null) return creditTone ?? 'ok'
  if (creditTone === null) return planTone
  return TONE_SEVERITY[planTone] <= TONE_SEVERITY[creditTone] ? planTone : creditTone
}

/** Worst health across the fetch + the provider IN USE: drives the trigger's
    status dot. Only the active provider (the composer's current selection)
    colors the ball, so an idle low-quota provider does not alarm; when the
    host reports no active provider, fall back to every provider. */
function healthTone(data: UsageListResult | null, error: string | null, red: number, yellow: number): 'ok' | 'warn' | 'danger' {
  if (error !== null) return 'danger'
  const providers = data?.providers ?? []
  const active = providers.filter((provider) => provider.active)
  const relevant = active.length > 0 ? active : providers
  let tone: 'ok' | 'warn' | 'danger' = 'ok'
  for (const provider of relevant) {
    if (provider.status === 'error' || provider.status === 'missing-credential' || provider.status === 'missing-authorization') return 'danger'
    const providerToneValue = providerTone(provider, red, yellow)
    if (providerToneValue === 'danger') return 'danger'
    if (providerToneValue === 'warn') tone = 'warn'
  }
  return tone
}

function formatAmount(value: number | null): string {
  if (value === null) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/**
 * Refine the host's `active` flags with the provider of the FOCUSED session
 * (the composer's own state), so a session switch re-highlights instantly
 * even though the host only tracks the last explicit selection. Returns the
 * same object when nothing changes; `undefined` provider leaves the host's
 * flags untouched.
 */
function applyActiveProvider(data: UsageListResult, provider: string | undefined): UsageListResult {
  if (provider === undefined || !Array.isArray(data.providers)) return data
  let changed = false
  const providers = data.providers.map((entry) => {
    const active = entry.id === provider
    if (active === entry.active) return entry
    changed = true
    return { ...entry, active }
  })
  return changed ? { ...data, providers } : data
}

/* ------------------------------------------------------------------ *
 * Provider card
 * ------------------------------------------------------------------ */

function UsageRows({ provider, now, red, yellow, t }: { provider: ProviderUsageView; now: number; red: number; yellow: number; t: UsageActionProps['t'] }) {
  const rows = provider.usages ?? []
  if (rows.length === 0) return null
  return (
    <>
      {rows.map((row, index) => {
        const percent = row.percent
        const isCredits = row.label === 'credits'
        // Credits rows carry a remaining balance and are judged by the amount;
        // quota windows keep the percent-based tone.
        const tone = isCredits ? balanceTone(row.remaining, red, yellow) : barTone(row.percent)
        const reset = row.resetAt !== null ? formatCountdown(row.resetAt, now, t) : null
        return (
          <div className="dsh-usage-row" key={`${row.label}-${index}`}>
            <div className="dsh-usage-rowHead">
              <span className="dsh-usage-rowLabel">{row.label === 'weekly' ? t('usage.weekly') : row.label}</span>
              <span className={`dsh-usage-rowValue${tone === 'ok' ? '' : ` dsh-usage-rowValue--${tone}`}`}>
                {isCredits && row.remaining !== null
                  ? formatAmount(row.remaining)
                  : row.limit === null
                    ? row.used !== null
                      ? t('usage.used', { used: formatAmount(row.used) })
                      : row.remaining !== null
                        ? formatAmount(row.remaining)
                        : t('usage.unlimited')
                    : percent !== null
                      ? `${Math.round(percent)}%`
                      : t('usage.used', { used: formatAmount(row.used) })}
              </span>
            </div>
            {percent !== null ? (
              <div className="dsh-usage-barTrack">
                <div
                  className={`dsh-usage-barFill dsh-usage-barFill--${tone}`}
                  style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                />
              </div>
            ) : null}
            {reset !== null ? <span className="dsh-usage-rowReset">{t('usage.resetIn', { countdown: reset })}</span> : null}
          </div>
        )
      })}
    </>
  )
}

function ProviderCard({ provider, now, red, yellow, t }: { provider: ProviderUsageView; now: number; red: number; yellow: number; t: UsageActionProps['t'] }) {
  return (
    <div className={`dsh-usage-card${provider.active ? ' dsh-usage-card--active' : ''}`}>
      <div className="dsh-usage-cardHead">
        <span className="dsh-usage-providerName">{provider.displayName}</span>
        {provider.active ? <span className="dsh-usage-inUse">{t('status.inUse')}</span> : null}
      </div>
      {provider.status === 'unsupported' ? (
        <span className="dsh-usage-message">{t('status.unsupported')}</span>
      ) : provider.status === 'missing-credential' ? (
        <span className="dsh-usage-message">{t('status.missingCredential', { ref: provider.message })}</span>
      ) : provider.status === 'missing-authorization' ? (
        <span className="dsh-usage-message">{t('status.missingAuthorization', { key: provider.message })}</span>
      ) : provider.status === 'error' ? (
        <span className="dsh-usage-message">{t('status.error')}: {provider.message}</span>
      ) : provider.kind === 'balance' ? (
        (provider.balances ?? []).map((row, index) => {
          const tone = balanceTone(toAmount(row.total), red, yellow)
          return (
            <div key={`${row.currency}-${index}`}>
              <div className="dsh-usage-balanceRow">
                <span className={`dsh-usage-balanceTotal${tone === 'ok' ? '' : ` dsh-usage-balanceTotal--${tone}`}`}>{row.total}</span>
                <span className="dsh-usage-balanceCurrency">{row.currency}</span>
              </div>
              <span className="dsh-usage-balanceParts">
                {[row.granted !== '0' && row.granted !== '0.00' ? t('balance.granted', { amount: row.granted }) : null,
                  row.toppedUp !== '0' && row.toppedUp !== '0.00' ? t('balance.toppedUp', { amount: row.toppedUp }) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
          )
        })
      ) : (
        <UsageRows provider={provider} now={now} red={red} yellow={yellow} t={t} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Trigger + popover
 * ------------------------------------------------------------------ */

/** Battery level: remaining charge reads as remaining quota. */
function BatteryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="16" height="10" x="2" y="7" rx="2" ry="2" />
      <path d="M22 11v2" />
      <path d="M6 11v2" />
      <path d="M10 11v2" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v4h-4" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z" />
    </svg>
  )
}

/** Crosshair for the "reset ball to its default spot" head button. */
function HomeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export default function UsageAction({ t, fetchUsage, getActiveProvider, subscribeActiveChange }: UsageActionProps) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<UsageListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [intervalSec, setIntervalSec] = useState(() => readStoredInterval() ?? DEFAULT_INTERVAL)
  const [langOverride, setLangOverride] = useState<Lang | null>(() => readStoredLang())
  /** Balance thresholds as raw input strings (kept as text so typing never
      fights the controlled input); parsed on use, overridden locally only
      after the user edits them. */
  const [redThreshold, setRedThreshold] = useState<string>(() => readStoredThreshold(THRESHOLD_RED_KEY) ?? String(DEFAULT_BALANCE_RED))
  const [yellowThreshold, setYellowThreshold] = useState<string>(() => readStoredThreshold(THRESHOLD_YELLOW_KEY) ?? String(DEFAULT_BALANCE_YELLOW))
  const [now, setNow] = useState(() => Date.now())
  /** Pinned spot (user-dragged) as viewport fractions; null = follow the default dock. */
  const [pinnedPos, setPinnedPos] = useState<FloatPos | null>(() => readStoredFloatPos())
  /** Viewport size drives the fraction → px conversion and the default dock. */
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  /** Transient ball position while dragging (cursor-centered); null when docked. */
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)
  /** User-resized panel height in px; null = auto-size to content (max-height
      + scroll). Persisted, like every other panel preference. */
  const [panelHeight, setPanelHeight] = useState<number | null>(() => readStoredPanelHeight())

  // Follow the harness language by default: probe the shell-injected
  // translator with a known key, then let a panel-level override win.
  const harnessLang: Lang | null =
    t('lang.switch') === zh['lang.switch'] ? 'zh' : t('lang.switch') === en['lang.switch'] ? 'en' : null
  const lang: Lang = langOverride ?? harnessLang ?? 'en'
  const tt = useMemo(() => makeT(lang === 'zh' ? (zh as Record<string, string>) : (en as Record<string, string>)), [lang])
  const toggleLang = useCallback(() => {
    setLangOverride((current) => {
      const next: Lang = (current ?? harnessLang ?? 'en') === 'zh' ? 'en' : 'zh'
      storeLang(next)
      return next
    })
  }, [harnessLang])
  /** Panel-head home button: unpin the ball so it follows the default dock. */
  const resetFloatPos = () => {
    clearStoredFloatPos()
    setPinnedPos(null)
  }
  const [panelPos, setPanelPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const ballRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  /** Active ball-drag session; cleared on pointerup/pointercancel. */
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; dragging: boolean } | null>(null)
  /** Set when a drag ends so the trailing click does not toggle the panel. */
  const suppressClickRef = useRef(false)
  /** Active panel-height drag; cleared on pointerup/pointercancel. */
  const resizeRef = useRef<{ pointerId: number; startY: number; startHeight: number; current: number } | null>(null)
  /** Resize bounds snapshotted at drag start from the live layout: min = first
      provider card fully visible, max = content height (no scroll, no blank). */
  const resizeLimitsRef = useRef<{ min: number; max: number } | null>(null)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const result = await fetchUsage()
      // Refine "in use" with the focused session's provider (the host only
      // tracks the last explicit composer selection).
      setData(applyActiveProvider(result, getActiveProvider?.()))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [fetchUsage, getActiveProvider])

  // Initial fetch + fixed-interval polling; skip ticks while the tab is hidden.
  useEffect(() => {
    refresh()
  }, [refresh])
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, intervalSec * 1000)
    return () => clearInterval(timer)
  }, [intervalSec, refresh])

  // Adopt the deployment-suggested interval until the user picks one locally.
  useEffect(() => {
    if (data !== null && readStoredInterval() === null && data.refreshSeconds !== intervalSec) {
      setIntervalSec(data.refreshSeconds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Adopt the deployment-suggested balance thresholds until the user edits
  // them locally (a stored override always wins, like the refresh interval).
  useEffect(() => {
    if (data === null) return
    if (readStoredThreshold(THRESHOLD_RED_KEY) === null && typeof data.balanceRedThreshold === 'number') {
      setRedThreshold(String(data.balanceRedThreshold))
    }
    if (readStoredThreshold(THRESHOLD_YELLOW_KEY) === null && typeof data.balanceYellowThreshold === 'number') {
      setYellowThreshold(String(data.balanceYellowThreshold))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Follow the FOCUSED session: when it switches (or its model selection
  // changes), re-derive which provider is "in use" immediately — the host's
  // global-default flag would otherwise stay stale until the next poll. Falls
  // back to the host flag when no live client state is available.
  useEffect(() => {
    const unsubscribe = subscribeActiveChange?.(() => {
      setData((prev) => (prev === null ? prev : applyActiveProvider(prev, getActiveProvider?.())))
    })
    return unsubscribe
    // The subscription callbacks are stable closures created once by the
    // client half; re-subscribing on prop identity churn is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Slow tick so reset countdowns advance while the panel is open.
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [open])

  // Close on outside press / Escape, mirroring the shipped popover behavior.
  // The panel and the ball are portaled to document.body, so all trees count
  // as inside.
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target)) return
      if (ballRef.current?.contains(event.target)) return
      if (panelRef.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  // Anchor the fixed-position panel to the ball; recompute while open so a
  // position reset or window resize keeps it attached. A ball in the lower
  // half of the viewport opens the panel above it, upper half below.
  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = ballRef.current?.getBoundingClientRect()
      if (!rect) return
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 336))
      setPanelPos(
        rect.top > window.innerHeight / 2
          ? { left, bottom: window.innerHeight - rect.top + 6 }
          : { left, top: rect.bottom + 6 },
      )
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [open, pinnedPos, viewport])

  // Keep a persisted height honest while open: never render taller than the
  // current content (no blank strip at the bottom when providers vanish) or
  // the viewport. Runs before paint, so no flash; a no-op during a drag.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (panel === null || panelHeight === null) return
    const clamped = Math.min(panelHeight, panelContentHeight(panel), panelMaxHeight())
    if (clamped !== panelHeight) setPanelHeight(clamped)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelHeight, data, open])

  // Track the viewport: fraction-based positions and the default dock follow
  // window resizes automatically.
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Effective thresholds: parse the inputs, fall back to defaults, and keep
  // the red zone at or below the yellow one so both stay meaningful.
  const effYellow = parseThreshold(yellowThreshold) ?? DEFAULT_BALANCE_YELLOW
  const effRed = Math.min(parseThreshold(redThreshold) ?? DEFAULT_BALANCE_RED, effYellow)

  const tone = healthTone(data, error, effRed, effYellow)

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
  }

  /* Ball dragging: pointer events only (touch included via touch-action:
     none). A press becomes a drag past a 5px dead zone; while dragging the
     ball follows the cursor centered on it, and on release it stays exactly
     where dropped (no edge snapping). A plain press falls through to the
     click handler. */
  const onBallPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false }
  }

  const onBallPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    if (!drag.dragging) {
      if (Math.abs(event.clientX - drag.startX) < 5 && Math.abs(event.clientY - drag.startY) < 5) return
      drag.dragging = true
      // The panel would detach from a moving anchor: close it on drag start.
      if (open) setOpen(false)
    }
    const half = BALL_SIZE / 2
    setDragPos({
      x: Math.min(Math.max(half, event.clientX), window.innerWidth - half),
      y: Math.min(Math.max(half, event.clientY), window.innerHeight - half),
    })
  }

  const endBallDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag === null || drag.pointerId !== event.pointerId || !drag.dragging) return
    const half = BALL_SIZE / 2
    const x = Math.min(Math.max(half, event.clientX), window.innerWidth - half)
    const y = Math.min(Math.max(half, event.clientY), window.innerHeight - half)
    // Pin the drop point as viewport fractions so it follows window resizes.
    const next: FloatPos = { fx: x / window.innerWidth, fy: y / window.innerHeight }
    setPinnedPos(next)
    storeFloatPos(next)
    setDragPos(null)
    suppressClickRef.current = true
  }

  const cancelBallDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragPos(null)
  }

  /* Panel height resize: grab the top-edge handle, drag up to grow / down to
     shrink. The panel itself never moves — the anchored edge stays put, only
     the height changes. The drag is bounded at drag start: growing stops at
     the content height (no scroll, no blank strip), shrinking stops once the
     first provider card is fully visible. */
  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const panel = panelRef.current
    const rect = panel?.getBoundingClientRect()
    const startHeight = panelHeight ?? Math.round(rect?.height ?? 0)
    if (panel !== null) {
      const viewportMax = panelMaxHeight()
      const max = Math.min(panelContentHeight(panel), viewportMax)
      const min = Math.min(Math.max(firstCardMinHeight(panel), PANEL_MIN_H), max)
      resizeLimitsRef.current = { min, max }
    } else {
      resizeLimitsRef.current = { min: PANEL_MIN_H, max: panelMaxHeight() }
    }
    resizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight, current: startHeight }
  }

  const onResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current
    if (resize === null || resize.pointerId !== event.pointerId) return
    const limits = resizeLimitsRef.current
    const next = limits === null
      ? resize.startHeight + (resize.startY - event.clientY)
      : Math.min(Math.max(resize.startHeight + (resize.startY - event.clientY), limits.min), limits.max)
    resize.current = next
    setPanelHeight(next)
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current
    if (resize === null || resize.pointerId !== event.pointerId) return
    resizeRef.current = null
    resizeLimitsRef.current = null
    storePanelHeight(resize.current)
  }

  const onBallClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setNow(Date.now())
    setOpen((current) => !current)
    if (!open) refresh()
  }

  // Ball center in px: transient drag point > pinned fractions > default dock.
  // (The default reads the sidebar edge from the DOM at render time; cheap.)
  const docked = pinnedPos ?? defaultFloatPos()
  const centerX = dragPos !== null ? dragPos.x : docked.fx * viewport.w
  const centerY = dragPos !== null ? dragPos.y : docked.fy * viewport.h

  return (
    <div ref={rootRef} className="dsh-usage-root" onKeyDown={onKeyDown}>
      {createPortal(
        <button
          ref={ballRef}
          type="button"
          className={`dsh-usage-ball dsh-usage-tone-${tone}`}
          style={{ left: centerX - BALL_SIZE / 2, top: centerY - BALL_SIZE / 2 }}
          aria-expanded={open}
          aria-label={tt('action.aria')}
          title={`${tt('action.aria')} · ${tt(`status.tone.${tone}`)}`}
          onPointerDown={onBallPointerDown}
          onPointerMove={onBallPointerMove}
          onPointerUp={endBallDrag}
          onPointerCancel={cancelBallDrag}
          onClick={onBallClick}
          onKeyDown={onKeyDown}
        >
          <BatteryIcon />
        </button>,
        document.body,
      )}
      {open && panelPos !== null
        ? createPortal(
          <div
            ref={panelRef}
            className="dsh-usage-panel"
            role="dialog"
            aria-label={tt('panel.title')}
            style={{
              left: panelPos.left,
              top: panelPos.top,
              bottom: panelPos.bottom,
              ...(panelHeight !== null ? { height: Math.min(panelHeight, panelMaxHeight()), maxHeight: 'none' } : {}),
            }}
            onKeyDown={onKeyDown}
          >
          <div
            className="dsh-usage-resize"
            title={tt('panel.resize')}
            aria-label={tt('panel.resize')}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
          <div className="dsh-usage-head">
            <span className="dsh-usage-title">{tt('panel.title')}</span>
            {data?.version ? <span className="dsh-usage-version">v{data.version}</span> : null}
            <button
              type="button"
              className="dsh-usage-home"
              onClick={resetFloatPos}
              title={tt('panel.resetPos')}
              aria-label={tt('panel.resetPos')}
            >
              <HomeIcon />
            </button>
            <button
              type="button"
              className="dsh-usage-lang"
              onClick={toggleLang}
              title={tt('lang.switch')}
              aria-label={tt('lang.switch')}
            >
              <GlobeIcon />
              <span>{lang === 'zh' ? '中' : 'EN'}</span>
            </button>
            <button
              type="button"
              className={`dsh-usage-refresh${loading ? ' dsh-usage-refresh--loading' : ''}`}
              disabled={loading}
              onClick={refresh}
              title={tt('panel.refresh')}
              aria-label={tt('panel.refresh')}
            >
              <RefreshIcon />
            </button>
          </div>
          {data === null && error !== null ? (
            <span className="dsh-usage-message">{tt('status.error')}: {error}</span>
          ) : null}
          {data !== null && data.providers.length === 0 ? (
            <span className="dsh-usage-message">{tt('panel.empty')}</span>
          ) : null}
          {(data?.providers ?? []).map((provider) => (
            <ProviderCard key={provider.id} provider={provider} now={now} red={effRed} yellow={effYellow} t={tt} />
          ))}
          <div className="dsh-usage-foot">
            <span className="dsh-usage-footLabel">{tt('panel.interval')}</span>
            <select
              className="dsh-usage-select"
              value={intervalSec}
              onChange={(event) => {
                const value = Number(event.target.value)
                setIntervalSec(value)
                storeInterval(value)
              }}
            >
              {INTERVAL_OPTIONS.map((seconds) => (
                <option key={seconds} value={seconds}>{tt(`interval.${seconds}s`)}</option>
              ))}
            </select>
            <span className="dsh-usage-updated">
              {data === null
                ? tt('panel.never')
                : tt('panel.updated', { time: new Date(data.fetchedAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US') })}
            </span>
          </div>
          <div className="dsh-usage-thresholds">
            <span className="dsh-usage-footLabel">{tt('panel.thresholds')}</span>
            <label className="dsh-usage-thresholdField" title={tt('panel.thresholdRed')}>
              <span className="dsh-usage-thresholdLabel dsh-usage-thresholdLabel--red">{tt('panel.thresholdRed')}</span>
              <input
                className="dsh-usage-thresholdInput"
                type="number"
                min={0}
                step={0.01}
                inputMode="decimal"
                value={redThreshold}
                onChange={(event) => {
                  setRedThreshold(event.target.value)
                  storeThreshold(THRESHOLD_RED_KEY, event.target.value)
                }}
              />
            </label>
            <label className="dsh-usage-thresholdField" title={tt('panel.thresholdYellow')}>
              <span className="dsh-usage-thresholdLabel dsh-usage-thresholdLabel--yellow">{tt('panel.thresholdYellow')}</span>
              <input
                className="dsh-usage-thresholdInput"
                type="number"
                min={0}
                step={0.01}
                inputMode="decimal"
                value={yellowThreshold}
                onChange={(event) => {
                  setYellowThreshold(event.target.value)
                  storeThreshold(THRESHOLD_YELLOW_KEY, event.target.value)
                }}
              />
            </label>
          </div>
          </div>,
          document.body,
        )
        : null}
    </div>
  )
}
