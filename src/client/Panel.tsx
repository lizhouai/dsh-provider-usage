/**
 * Sidebar footer quota widget: a trigger button beside Settings plus a
 * popover panel listing every configured provider's live balance/quota.
 * Polling interval is user-selectable (persisted in localStorage) and falls
 * back to the deployment-suggested value from the host plugin config.
 * The trigger can also live as a draggable floating ball (or both surfaces
 * at once), switched from the panel head and persisted in localStorage.
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

interface ProviderQuotaView {
  id: string
  displayName: string
  kind: 'balance' | 'usage' | null
  status: 'ok' | 'error' | 'missing-credential' | 'unsupported'
  message: string | null
  balances: BalanceRow[] | null
  usages: UsageRow[] | null
}

interface QuotaListResult {
  fetchedAt: string
  refreshSeconds: number
  /** Plugin package version (absent on older hosts). */
  version?: string
  providers: ProviderQuotaView[]
}

export interface QuotaActionProps {
  /** Sidebar expansion state, owned by the sidebar footer slot. */
  wide?: boolean
  /** Namespace translator injected by the locale seat. */
  t: (key: string, params?: Record<string, unknown>) => string
  /** Business face: call the host `quota/list` remote. */
  fetchQuota: () => Promise<QuotaListResult>
}

/* ------------------------------------------------------------------ *
 * Refresh interval
 * ------------------------------------------------------------------ */

const INTERVAL_OPTIONS = [15, 30, 60, 300, 900, 1800] as const
const STORAGE_KEY = 'dsh.provider-quota.refreshSeconds'
const LANG_KEY = 'dsh.provider-quota.lang'
const MODE_KEY = 'dsh.provider-quota.mode'
const POS_KEY = 'dsh.provider-quota.floatPos'
const DEFAULT_INTERVAL = 60

/** Floating ball diameter in px; drag math derives from it. */
const BALL_SIZE = 40

type Lang = 'zh' | 'en'
/** Trigger surface: sidebar button, floating ball, or both. */
type Mode = 'sidebar' | 'float' | 'both'
/** Which trigger surface the open panel is anchored to. */
type Anchor = 'sidebar' | 'float'
/** Docked ball position: viewport edge plus offset from the top. */
interface FloatPos {
  side: 'left' | 'right'
  top: number
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
function makeT(dict: Record<string, string>): QuotaActionProps['t'] {
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
 * Display mode + floating ball position
 * ------------------------------------------------------------------ */

function readStoredMode(): Mode {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    return raw === 'float' || raw === 'both' ? raw : 'sidebar'
  } catch {
    return 'sidebar'
  }
}

function storeMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* storage unavailable: keep the in-memory value only */
  }
}

function defaultFloatPos(): FloatPos {
  // Dock at the left edge by default: the ball rides next to the sidebar
  // rail, which reads as a natural extension of the sidebar button it
  // replaces. A user drag persists over this default.
  return { side: 'left', top: Math.round(window.innerHeight * 0.6) }
}

function readStoredFloatPos(): FloatPos {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw === null) return defaultFloatPos()
    const parsed = JSON.parse(raw) as Partial<FloatPos> | null
    if (parsed === null || (parsed.side !== 'left' && parsed.side !== 'right')) return defaultFloatPos()
    if (typeof parsed.top !== 'number' || !Number.isFinite(parsed.top)) return defaultFloatPos()
    return { side: parsed.side, top: parsed.top }
  } catch {
    return defaultFloatPos()
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

function formatCountdown(resetAt: string, now: number, t: QuotaActionProps['t']): string | null {
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

function formatAmount(value: number | null): string {
  if (value === null) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/* ------------------------------------------------------------------ *
 * Provider card
 * ------------------------------------------------------------------ */

function UsageRows({ provider, now, t }: { provider: ProviderQuotaView; now: number; t: QuotaActionProps['t'] }) {
  const rows = provider.usages ?? []
  if (rows.length === 0) return null
  return (
    <>
      {rows.map((row, index) => {
        const percent = row.percent
        const reset = row.resetAt !== null ? formatCountdown(row.resetAt, now, t) : null
        return (
          <div className="dsh-quota-usageRow" key={`${row.label}-${index}`}>
            <div className="dsh-quota-usageHead">
              <span className="dsh-quota-usageLabel">{row.label === 'weekly' ? t('usage.weekly') : row.label}</span>
              <span className="dsh-quota-usageValue">
                {row.limit === null
                  ? t('usage.unlimited')
                  : percent !== null
                    ? `${Math.round(percent)}%`
                    : t('usage.used', { used: formatAmount(row.used) })}
              </span>
            </div>
            {percent !== null ? (
              <div className="dsh-quota-barTrack">
                <div
                  className={`dsh-quota-barFill dsh-quota-barFill--${barTone(percent)}`}
                  style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                />
              </div>
            ) : null}
            {reset !== null ? <span className="dsh-quota-usageReset">{t('usage.resetIn', { countdown: reset })}</span> : null}
          </div>
        )
      })}
    </>
  )
}

function ProviderCard({ provider, now, t }: { provider: ProviderQuotaView; now: number; t: QuotaActionProps['t'] }) {
  return (
    <div className="dsh-quota-card">
      <div className="dsh-quota-cardHead">
        <span className="dsh-quota-providerName">{provider.displayName}</span>
      </div>
      {provider.status === 'unsupported' ? (
        <span className="dsh-quota-message">{t('status.unsupported')}</span>
      ) : provider.status === 'missing-credential' ? (
        <span className="dsh-quota-message">{t('status.missingCredential', { ref: provider.message })}</span>
      ) : provider.status === 'error' ? (
        <span className="dsh-quota-message">{t('status.error')}: {provider.message}</span>
      ) : provider.kind === 'balance' ? (
        (provider.balances ?? []).map((row, index) => (
          <div key={`${row.currency}-${index}`}>
            <div className="dsh-quota-balanceRow">
              <span className="dsh-quota-balanceTotal">{row.total}</span>
              <span className="dsh-quota-balanceCurrency">{row.currency}</span>
            </div>
            <span className="dsh-quota-balanceParts">
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

function CoinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M15.5 9.5c-.7-1-2-1.5-3.5-1.5-2 0-3.5 1-3.5 2.5s1.5 2 3.5 2 3.5.8 3.5 2.5-1.5 2.5-3.5 2.5c-1.5 0-2.8-.5-3.5-1.5" />
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

/** Mode toggle icon reflects the CURRENT surface: sidebar strip, ball, or both. */
function ModeIcon({ mode }: { mode: Mode }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {mode === 'float' ? (
        <circle cx="12" cy="12" r="8" />
      ) : mode === 'both' ? (
        <>
          <rect x="2.5" y="5" width="13" height="14" rx="2" />
          <path d="M7.5 5v14" />
          <circle cx="17.5" cy="16" r="4" />
        </>
      ) : (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M10 5v14" />
        </>
      )}
    </svg>
  )
}

export default function QuotaAction({ wide, t, fetchQuota }: QuotaActionProps) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<QuotaListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [intervalSec, setIntervalSec] = useState(() => readStoredInterval() ?? DEFAULT_INTERVAL)
  const [langOverride, setLangOverride] = useState<Lang | null>(() => readStoredLang())
  const [now, setNow] = useState(() => Date.now())
  const [mode, setMode] = useState<Mode>(() => readStoredMode())
  const [anchor, setAnchor] = useState<Anchor>('sidebar')
  const [floatPos, setFloatPos] = useState<FloatPos>(() => readStoredFloatPos())
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
  // Cycle sidebar → float → both; float hides the sidebar trigger, so an
  // open panel anchored there must re-anchor to the ball.
  const toggleMode = () => {
    const next: Mode = mode === 'sidebar' ? 'float' : mode === 'float' ? 'both' : 'sidebar'
    storeMode(next)
    setMode(next)
    if (next === 'float' && open && anchor === 'sidebar') setAnchor('float')
  }
  const [panelPos, setPanelPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
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
      const result = await fetchQuota()
      setData(result)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [fetchQuota])

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

  // Anchor the fixed-position panel to the active trigger (sidebar button or
  // floating ball); recompute while open so sidebar collapse and window
  // resizes keep it attached. Triggers in the lower half of the viewport open
  // the panel above them, upper-half triggers below.
  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = (anchor === 'float' ? ballRef.current : triggerRef.current)?.getBoundingClientRect()
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
  }, [open, wide, anchor])

  // Keep the docked ball inside the viewport across window resizes.
  useEffect(() => {
    if (mode === 'sidebar') return
    const clampTop = () => {
      setFloatPos((current) => {
        const top = Math.min(Math.max(8, current.top), window.innerHeight - BALL_SIZE - 8)
        if (top === current.top) return current
        const next = { ...current, top }
        storeFloatPos(next)
        return next
      })
    }
    clampTop()
    window.addEventListener('resize', clampTop)
    return () => window.removeEventListener('resize', clampTop)
  }, [mode])

  const hasFailure = error !== null || (data?.providers.some((p) => p.status === 'error' || p.status === 'missing-credential') ?? false)

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
  }

  /* Ball dragging: pointer events only (touch included via touch-action:
     none). A press becomes a drag past a 5px dead zone; while dragging the
     ball follows the cursor centered on it, and on release it snaps to the
     nearer viewport edge. A plain press falls through to the click handler. */
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
      if (open && anchor === 'float') setOpen(false)
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
    const next: FloatPos = {
      side: x <= window.innerWidth / 2 ? 'left' : 'right',
      top: Math.min(Math.max(8, y - half), window.innerHeight - BALL_SIZE - 8),
    }
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
    setAnchor('float')
    setNow(Date.now())
    setOpen((current) => !current)
    if (!open) refresh()
  }

  return (
    <div ref={rootRef} className="dsh-quota-root" onKeyDown={onKeyDown}>
      {mode !== 'float' ? (
        <button
          ref={triggerRef}
          type="button"
          className={wide ? 'dsh-quota-trigger' : 'dsh-quota-trigger dsh-quota-trigger--icon'}
          aria-expanded={open && anchor === 'sidebar'}
          aria-label={tt('action.aria')}
          title={tt('action.aria')}
          onClick={() => {
            setAnchor('sidebar')
            setNow(Date.now())
            setOpen((current) => !current)
            if (!open) refresh()
          }}
        >
          <span className="dsh-quota-triggerIcon"><CoinIcon /></span>
          {wide ? <span>{tt('action.label')}</span> : null}
          {hasFailure ? <span className="dsh-quota-errorDot" /> : null}
        </button>
      ) : null}
      {mode !== 'sidebar'
        ? createPortal(
          <button
            ref={ballRef}
            type="button"
            className="dsh-quota-ball"
            style={
              dragPos !== null
                ? { left: dragPos.x - BALL_SIZE / 2, top: dragPos.y - BALL_SIZE / 2 }
                : floatPos.side === 'left'
                  ? { left: 8, top: floatPos.top }
                  : { right: 8, top: floatPos.top }
            }
            aria-expanded={open && anchor === 'float'}
            aria-label={tt('action.aria')}
            title={tt('action.aria')}
            onPointerDown={onBallPointerDown}
            onPointerMove={onBallPointerMove}
            onPointerUp={endBallDrag}
            onPointerCancel={cancelBallDrag}
            onClick={onBallClick}
            onKeyDown={onKeyDown}
          >
            <CoinIcon />
            {hasFailure ? <span className="dsh-quota-errorDot" /> : null}
          </button>,
          document.body,
        )
        : null}
      {open && panelPos !== null
        ? createPortal(
          <div
            ref={panelRef}
            className="dsh-quota-panel"
            role="dialog"
            aria-label={tt('panel.title')}
            style={{ left: panelPos.left, top: panelPos.top, bottom: panelPos.bottom }}
            onKeyDown={onKeyDown}
          >
          <div className="dsh-quota-head">
            <span className="dsh-quota-title">{tt('panel.title')}</span>
            {data?.version ? <span className="dsh-quota-version">v{data.version}</span> : null}
            <button
              type="button"
              className={`dsh-quota-mode${mode !== 'sidebar' ? ' dsh-quota-mode--active' : ''}`}
              onClick={toggleMode}
              title={`${tt('panel.mode')}: ${tt(`mode.${mode}`)}`}
              aria-label={`${tt('panel.mode')}: ${tt(`mode.${mode}`)}`}
            >
              <ModeIcon mode={mode} />
            </button>
            <button
              type="button"
              className="dsh-quota-lang"
              onClick={toggleLang}
              title={tt('lang.switch')}
              aria-label={tt('lang.switch')}
            >
              <GlobeIcon />
              <span>{lang === 'zh' ? '中' : 'EN'}</span>
            </button>
            <button
              type="button"
              className={`dsh-quota-refresh${loading ? ' dsh-quota-refresh--loading' : ''}`}
              disabled={loading}
              onClick={refresh}
              title={tt('panel.refresh')}
              aria-label={tt('panel.refresh')}
            >
              <RefreshIcon />
            </button>
          </div>
          {data === null && error !== null ? (
            <span className="dsh-quota-message">{tt('status.error')}: {error}</span>
          ) : null}
          {data !== null && data.providers.length === 0 ? (
            <span className="dsh-quota-message">{tt('panel.empty')}</span>
          ) : null}
          {(data?.providers ?? []).map((provider) => (
            <ProviderCard key={provider.id} provider={provider} now={now} t={tt} />
          ))}
          <div className="dsh-quota-foot">
            <span className="dsh-quota-footLabel">{tt('panel.interval')}</span>
            <select
              className="dsh-quota-select"
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
            <span className="dsh-quota-updated">
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
