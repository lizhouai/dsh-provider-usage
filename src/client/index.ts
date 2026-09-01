/**
 * provider-usage — browser half.
 *
 * Registers the locale dictionaries and contributes the usage widget into the
 * sidebar footer's additive action slot. Data comes from the host `usage`
 * Typert Remote (SRC mode — no generated descriptors) through the raw RPC
 * caller on the connection service.
 *
 * The "provider in use" flag is refined CLIENT-side: the host marks the route
 * from the GLOBAL default model selection, which only moves on an explicit
 * composer pick — switching between sessions with different per-session
 * selections would leave it stale. The focused session's own effective
 * selection (pending → last used → host default, mirrored by the composer's
 * model seat) is read live from the client session services and overrides the
 * host flag, so the panel follows session switches immediately.
 */
import UsageAction, { type UsageActionProps } from './Panel'
import { en, zh } from './locales'
import { ensureStyles } from './styles'

/**
 * Required client services: slot registry, locale seats, the connection RPC
 * caller, and the live session/model-selection state used to refine the
 * "in use" flag (`sessions` + `modelDirectories`, both mounted by the web
 * app — the latter is the composer model seat's own service).
 */
const inject = ['slots', 'locale', 'connection', 'sessions', 'modelDirectories']

interface ClientContext {
  effect: (fn: () => unknown, label: string) => void
  locale: { register: (ns: string, dicts: { zh: unknown; en: unknown }) => unknown }
  slots: {
    inject: (name: string, callback: () => unknown) => void
    register: (entry: Record<string, unknown>, component: unknown) => unknown
  }
  connection: {
    rpc: {
      call: (
        channel: string,
        endpoint: string,
        payload: { args: Record<string, unknown> },
        signal?: AbortSignal,
      ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>
    }
  }
  /** Client session list: the focused session id rides the same snapshot as
      the sidebar highlight (duck-typed SnapshotStore face). */
  sessions: {
    list: {
      getSnapshot(): { current?: string }
      subscribe(fn: () => void): () => void
    }
  }
  /** Per-session model directories (the composer seat's shared state): the
      focused session's effective selection mirrors the agent's resolution —
      pending selection → last used → deployment default. */
  modelDirectories: {
    directoryFor(sessionId: string): {
      store: {
        getSnapshot(): { current?: { provider: string; model: string } | null }
        subscribe(fn: () => void): () => void
      }
    }
  }
}

function apply(ctx: ClientContext) {
  ensureStyles()
  ctx.effect(() => ctx.locale.register('provider-usage', { zh, en }), 'provider-usage: dictionaries')

  const fetchUsage: UsageActionProps['fetchUsage'] = async () => {
    const result = await ctx.connection.rpc.call('/api', 'usage/list', { args: {} })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as Awaited<ReturnType<UsageActionProps['fetchUsage']>>
  }

  /**
   * The provider the FOCUSED session's composer shows (and its agent would
   * use): the session's durable model selection, else the deployment default
   * — exactly what the host resolves per session. Undefined while the client
   * session state is not ready; the host's own flag then stands.
   */
  const getActiveProvider: UsageActionProps['getActiveProvider'] = () => {
    const current = ctx.sessions?.list?.getSnapshot()?.current
    if (typeof current !== 'string' || current === '') return undefined
    try {
      const directory = ctx.modelDirectories?.directoryFor(current)
      const provider = directory?.store?.getSnapshot()?.current?.provider
      return typeof provider === 'string' && provider !== '' ? provider : undefined
    } catch {
      // Session scope not resolvable yet — the next list event retries.
      return undefined
    }
  }

  /**
   * Re-derive the panel's "in use" flag the moment the focused session or its
   * model selection changes — no need to wait for the next poll tick. The
   * directory subscription follows the CURRENT focused session and is
   * re-pointed on every session switch, so a late projection load still lands.
   */
  const subscribeActiveChange: UsageActionProps['subscribeActiveChange'] = (onChange) => {
    const sessions = ctx.sessions
    if (typeof sessions?.list?.subscribe !== 'function') return () => {}
    let directoryUnsub: (() => void) | null = null
    const followDirectory = () => {
      directoryUnsub?.()
      directoryUnsub = null
      const current = sessions.list.getSnapshot()?.current
      if (typeof current === 'string' && current !== '') {
        try {
          const store = ctx.modelDirectories?.directoryFor(current)?.store
          if (typeof store?.subscribe === 'function') directoryUnsub = store.subscribe(onChange)
        } catch {
          /* directory not resolvable yet — the next session-list event retries */
        }
      }
    }
    const offList = sessions.list.subscribe(() => {
      followDirectory()
      onChange()
    })
    followDirectory()
    return () => {
      offList?.()
      directoryUnsub?.()
    }
  }

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'provider-usage',
        order: 10,
        locale: 'provider-usage',
        inject: () => ({ fetchUsage, getActiveProvider, subscribeActiveChange }),
      },
      UsageAction,
    ),
  )
}

export { apply, inject }
