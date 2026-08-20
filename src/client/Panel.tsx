/**
 * Floating-ball quota widget: a draggable ball portaled to document.body
 * (the sidebar slot only mounts the component; the button itself no longer
 * lives in the sidebar, avoiding slot layout contention with other plugins).
 * The popover panel lists every configured provider's live balance/quota.
 * Polling interval is user-selectable (persisted in localStorage) and falls
 * back to the deployment-suggested value from the host plugin config.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  status: 'ok' | 'error' | 'missing-credential' | 'unsupported'
  message: string | null
  balances: BalanceRow[] | null
  usages: UsageRow[] | null
}

interface UsageListResult {
  fetchedAt: string
  refreshSeconds: number
  /** Plugin package version (absent on older hosts). */
  version?: string
  providers: ProviderUsageView[]
}

export interface UsageActionProps {
  /** Namespace translator injected by the locale seat. */
  t: (key: string, params?: Record<string, unknown>) => string
  /** Business face: call the host `usage/list` remote. */
  fetchUsage: () => Promise<UsageListResult>
}

/* ------------------------------------------------------------------ *
 * Refresh interval
 * ------------------------------------------------------------------ */

const INTERVAL_OPTIONS = [15, 30, 60, 300, 900, 1800] as const
const STORAGE_KEY = 'dsh.provider-usage.refreshSeconds'
const LANG_KEY = 'dsh.provider-usage.lang'
const POS_KEY = 'dsh.provider-usage.floatPos'
const DEFAULT_INTERVAL = 60

/** Floating ball diameter in px; drag math derives from it. */
const BALL_SIZE = 32

type Lang = 'zh' | 'en'
/** Docked ball position: absolute viewport coordinates of the ball's top-left. */
interface FloatPos {
  x: number
  y: number
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
 * Floating ball position
 * ------------------------------------------------------------------ */

/** Equal margin from the chat area's left edge and the window's bottom edge. */
const DOCK_MARGIN = 24

function defaultFloatPos(): FloatPos {
  // Bottom-left of the main chat area with equal margins on both axes. The
  // chat area's left edge is the sidebar's right edge, derived from the
  // full-height ancestor of the settings slot (stable data-slot hook; class
  // names are build-hashed), so it adapts to sidebar collapse.
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
  return { x: Math.round(sidebarRight + DOCK_MARGIN), y: window.innerHeight - DOCK_MARGIN - BALL_SIZE }
}

function readStoredFloatPos(): FloatPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<FloatPos> | null
    if (parsed === null || typeof parsed.x !== 'number' || !Number.isFinite(parsed.x)) return null
    if (typeof parsed.y !== 'number' || !Number.isFinite(parsed.y)) return null
    return { x: parsed.x, y: parsed.y }
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

/** Worst health across the fetch + every provider: drives the trigger's status dot. */
function healthTone(data: UsageListResult | null, error: string | null): 'ok' | 'warn' | 'danger' {
  if (error !== null) return 'danger'
  let tone: 'ok' | 'warn' | 'danger' = 'ok'
  for (const provider of data?.providers ?? []) {
    if (provider.status === 'error' || provider.status === 'missing-credential') return 'danger'
    for (const row of provider.usages ?? []) {
      const rowTone = barTone(row.percent)
      if (rowTone === 'danger') return 'danger'
      if (rowTone === 'warn') tone = 'warn'
    }
  }
  return tone
}

function formatAmount(value: number | null): string {
  if (value === null) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/* ------------------------------------------------------------------ *
 * Provider card
 * ------------------------------------------------------------------ */

function UsageRows({ provider, now, t }: { provider: ProviderUsageView; now: number; t: UsageActionProps['t'] }) {
  const rows = provider.usages ?? []
  if (rows.length === 0) return null
  return (
    <>
      {rows.map((row, index) => {
        const percent = row.percent
        const reset = row.resetAt !== null ? formatCountdown(row.resetAt, now, t) : null
        return (
          <div className="dsh-usage-row" key={`${row.label}-${index}`}>
            <div className="dsh-usage-rowHead">
              <span className="dsh-usage-rowLabel">{row.label === 'weekly' ? t('usage.weekly') : row.label}</span>
              <span className="dsh-usage-rowValue">
                {row.limit === null
                  ? t('usage.unlimited')
                  : percent !== null
                    ? `${Math.round(percent)}%`
                    : t('usage.used', { used: formatAmount(row.used) })}
              </span>
            </div>
            {percent !== null ? (
              <div className="dsh-usage-barTrack">
                <div
                  className={`dsh-usage-barFill dsh-usage-barFill--${barTone(percent)}`}
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

function ProviderCard({ provider, now, t }: { provider: ProviderUsageView; now: number; t: UsageActionProps['t'] }) {
  return (
    <div className="dsh-usage-card">
      <div className="dsh-usage-cardHead">
        <span className="dsh-usage-providerName">{provider.displayName}</span>
      </div>
      {provider.status === 'unsupported' ? (
        <span className="dsh-usage-message">{t('status.unsupported')}</span>
      ) : provider.status === 'missing-credential' ? (
        <span className="dsh-usage-message">{t('status.missingCredential', { ref: provider.message })}</span>
      ) : provider.status === 'error' ? (
        <span className="dsh-usage-message">{t('status.error')}: {provider.message}</span>
      ) : provider.kind === 'balance' ? (
        (provider.balances ?? []).map((row, index) => (
          <div key={`${row.currency}-${index}`}>
            <div className="dsh-usage-balanceRow">
              <span className="dsh-usage-balanceTotal">{row.total}</span>
              <span className="dsh-usage-balanceCurrency">{row.currency}</span>
            </div>
            <span className="dsh-usage-balanceParts">
              {[row.granted !== '0' && row.granted !== '0.00' ? t('balance.granted', { amount: row.granted }) : null,
                row.toppedUp !== '0' && row.toppedUp !== '0.00' ? t('balance.toppedUp', { amount: row.toppedUp }) : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        ))
      ) : (
        <UsageRows provider={provider} now={now} t={t} />
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

export default function UsageAction({ t, fetchUsage }: UsageActionProps) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<UsageListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [intervalSec, setIntervalSec] = useState(() => readStoredInterval() ?? DEFAULT_INTERVAL)
  const [langOverride, setLangOverride] = useState<Lang | null>(() => readStoredLang())
  const [now, setNow] = useState(() => Date.now())
  const [floatPos, setFloatPos] = useState<FloatPos>(() => readStoredFloatPos() ?? defaultFloatPos())
  /** Transient ball position while dragging (cursor-centered); null when docked. */
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)

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
  /** Panel-head home button: send the ball back to its default spot. */
  const resetFloatPos = () => {
    const next = defaultFloatPos()
    storeFloatPos(next)
    setFloatPos(next)
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

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const result = await fetchUsage()
      setData(result)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [fetchUsage])

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
  }, [open, floatPos])

  // Keep the docked ball inside the viewport across window resizes.
  useEffect(() => {
    const clampPos = () => {
      setFloatPos((current) => {
        const x = Math.min(Math.max(8, current.x), window.innerWidth - BALL_SIZE - 8)
        const y = Math.min(Math.max(8, current.y), window.innerHeight - BALL_SIZE - 8)
        if (x === current.x && y === current.y) return current
        const next = { x, y }
        storeFloatPos(next)
        return next
      })
    }
    clampPos()
    window.addEventListener('resize', clampPos)
    return () => window.removeEventListener('resize', clampPos)
  }, [])

  const tone = healthTone(data, error)

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
    const next: FloatPos = { x: x - half, y: y - half }
    setFloatPos(next)
    storeFloatPos(next)
    setDragPos(null)
    suppressClickRef.current = true
  }

  const cancelBallDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragPos(null)
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

  return (
    <div ref={rootRef} className="dsh-usage-root" onKeyDown={onKeyDown}>
      {createPortal(
        <button
          ref={ballRef}
          type="button"
          className={`dsh-usage-ball dsh-usage-tone-${tone}`}
          style={
            dragPos !== null
              ? { left: dragPos.x - BALL_SIZE / 2, top: dragPos.y - BALL_SIZE / 2 }
              : { left: floatPos.x, top: floatPos.y }
          }
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
            style={{ left: panelPos.left, top: panelPos.top, bottom: panelPos.bottom }}
            onKeyDown={onKeyDown}
          >
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
            <ProviderCard key={provider.id} provider={provider} now={now} t={tt} />
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
          </div>,
          document.body,
        )
        : null}
    </div>
  )
}
