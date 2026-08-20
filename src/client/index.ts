/**
 * provider-usage — browser half.
 *
 * Registers the locale dictionaries and contributes the usage widget into the
 * sidebar footer's additive action slot. Data comes from the host `usage`
 * Typert Remote (SRC mode — no generated descriptors) through the raw RPC
 * caller on the connection service.
 */
import UsageAction, { type UsageActionProps } from './Panel'
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
  ctx.effect(() => ctx.locale.register('provider-usage', { zh, en }), 'provider-usage: dictionaries')

  const fetchUsage: UsageActionProps['fetchUsage'] = async () => {
    const result = await ctx.connection.rpc.call('/api', 'usage/list', { args: {} })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as Awaited<ReturnType<UsageActionProps['fetchUsage']>>
  }

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'provider-usage',
        order: 10,
        locale: 'provider-usage',
        inject: () => ({ fetchUsage }),
      },
      UsageAction,
    ),
  )
}

export { apply, inject }
