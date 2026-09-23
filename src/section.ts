/**
 * Reading a *foreign* plugin's live config section across dsh generations.
 *
 * The quota panel needs connection facts (`baseURL`, `apiKeyEnv`) that live in
 * another plugin's section — `llm-pi-ai` provider profiles, `llm-deepseek` —
 * while this plugin only receives its own config. How those sections are read
 * changed with dsh 0.1.3:
 *
 * - dsh ≤ 0.1.2 shipped a `SettingsProvider` whose `settings.get(ns)` returned
 *   the resolved section of a registered namespace.
 * - dsh ≥ 0.1.3 replaced that service with the settings *forms* service
 *   (backed by the config editor). It projects volatile fields for the UI and
 *   answers neither `get` nor `installSection`; a plugin's live config hangs
 *   off its loader entry's fiber instead.
 *
 * The reader below tries the legacy call first and falls back to the loader
 * entries, so route facts keep resolving on both sides of that boundary — on
 * the new generation this is what turns a stored `KIMI_CODING_API_KEY`
 * credential ref (written by the Models page into the profile patch) into the
 * ref the panel resolves, instead of the catalog fallback name.
 * @module section
 */

/** Loader entry shape as published by the config editor service. */
interface LoaderEntry {
  options?: { id?: string }
  fiber?: { config?: unknown }
}

/**
 * Detach a live entry config. Newer dsh hands volatile fields out as reactive
 * refs read through `.get()` (e.g. `llm-pi-ai`'s `providers` map), so unwrap
 * those and deep-copy plain data: callers index a stable snapshot and never a
 * live object.
 * @param value - a live config node.
 * @returns the detached plain value.
 */
export function plainSection(value: unknown): any {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return plainSection((value as { get: () => unknown }).get())
  }
  if (Array.isArray(value)) return value.map(plainSection)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, plainSection(child)]),
    )
  }
  return value
}

/**
 * Read one plugin's live config section, whichever settings generation is
 * mounted. The legacy `settings.get(ns)` is tried first — an `undefined`
 * answer (legacy reads throw only on a broken service, and answer `undefined`
 * for an unregistered namespace) falls through to the config editor's loader
 * entries, so nothing is lost on a hybrid composition either.
 * @param settings - `ctx.get('settings')`, any generation (may be undefined).
 * @param configEditor - `ctx.get('configEditor')`; only consulted when the
 *   legacy `get` is absent (may be undefined).
 * @param ns - the profile entry id / settings namespace to read.
 * @returns the detached section value, or undefined when unavailable.
 */
export async function readLiveSection(settings: unknown, configEditor: unknown, ns: string): Promise<any> {
  let legacy: unknown
  if (settings !== null && typeof settings === 'object' && typeof (settings as { get?: unknown }).get === 'function') {
    try {
      legacy = await Promise.resolve((settings as { get: (ns: string) => unknown }).get(ns))
    } catch {
      legacy = undefined
    }
    if (legacy !== undefined) return legacy
  }
  const entries: LoaderEntry[] =
    configEditor !== null && typeof configEditor === 'object' && typeof (configEditor as { entries?: unknown }).entries === 'function'
      ? ((configEditor as { entries: () => LoaderEntry[] }).entries() ?? [])
      : []
  const entry = (Array.isArray(entries) ? entries : []).find((row) => row?.options?.id === ns)
  if (entry?.fiber === undefined) return undefined
  return plainSection(entry.fiber.config)
}

/**
 * The settings namespace a pi-ai route's profile lives under. The
 * configurable-provider directory publishes each route's owning namespace
 * (which is the composing entry's id and may differ from the plugin default);
 * the directory is new in the same generation that removed `settings.get`, so
 * the plugin's own namespace stays the fallback for older harnesses.
 * @param llm - `ctx.get('llm')`, any generation.
 * @param routeId - the provider route id.
 * @param fallback - namespace assumed when no directory entry answers.
 * @returns the namespace to read the route's profile section from.
 */
export function settingsNsForRoute(llm: unknown, routeId: string, fallback = 'llm-pi-ai'): string {
  const directory: Array<{ provider?: string; settingsNs?: string }> =
    llm !== null && typeof llm === 'object' && typeof (llm as { listConfigurableProviders?: unknown }).listConfigurableProviders === 'function'
      ? ((llm as { listConfigurableProviders: () => Array<{ provider?: string; settingsNs?: string }> }).listConfigurableProviders() ?? [])
      : []
  const ns = (Array.isArray(directory) ? directory : []).find((row) => row?.provider === routeId)?.settingsNs
  return typeof ns === 'string' && ns !== '' ? ns : fallback
}
