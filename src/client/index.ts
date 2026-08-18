/**
 * provider-quota — browser half.
 *
 * Registers the locale dictionaries and contributes the quota widget into the
 * sidebar footer's additive action slot. Data comes from the host `quota`
 * Typert Remote (SRC mode — no generated descriptors) through the raw RPC
 * caller on the connection service.
 */
import QuotaAction, { type QuotaActionProps } from './Panel'
import { en, zh } from './locales'
import { ensureStyles } from './styles'

/** Required client services: slot registry, locale seats, and the connection RPC caller. */
const inject = ['slots', 'locale', 'connection']

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
}

function apply(ctx: ClientContext) {
  ensureStyles()
  ctx.effect(() => ctx.locale.register('provider-quota', { zh, en }), 'provider-quota: dictionaries')

  const fetchQuota: QuotaActionProps['fetchQuota'] = async () => {
    const result = await ctx.connection.rpc.call('/api', 'quota/list', { args: {} })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as Awaited<ReturnType<QuotaActionProps['fetchQuota']>>
  }

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'provider-quota',
        order: 10,
        locale: 'provider-quota',
        inject: () => ({ fetchQuota }),
      },
      QuotaAction,
    ),
  )
}

export { apply, inject }
