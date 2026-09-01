/**
 * Ambient declarations for the harness packages this plugin consumes at
 * runtime. They resolve through $DSH_HOME/profiles/node_modules (the dsh
 * install's dependency closure) when the plugin is mounted in a profile, so
 * they are runtime peers — declared here only for local type-checking.
 */

declare module '@deepseek-ai/cordis' {
  export type Context = any
  export class Service {
    constructor(ctx: Context, name: string)
    readonly ctx: Context
    readonly name: string
  }
}

declare module '@deepseek-ai/schemastery' {
  const z: any
  export default z
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  import type { Context } from '@deepseek-ai/cordis'
  /** Standard (TC39) method decorator marking a Typert Remote method. */
  export function Remote(exportName?: string): (method: unknown, context: unknown) => void
  export class TypertRemoteService {
    constructor(ctx: Context, serviceKey: string, options?: { namespace?: string })
    readonly ctx: Context
    readonly name: string
    readonly typertRemote: unknown
  }
}

declare module '@deepseek-ai/dsh-credentials' {
  export type CredentialRef = string & { readonly __credentialRef: unique symbol }
  export type CredentialKey = string & { readonly __credentialKey: unique symbol }
  export type CredentialRecord =
    | { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string, string>> }
    | { readonly kind: 'grant'; readonly payload: unknown }
  export function credentialRef(value: string): CredentialRef
  export function credentialKey(scope: string, id: string): CredentialKey
}

declare module '@deepseek-ai/dsh-credentials/types' {
  export type CredentialRecord =
    | { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string, string>> }
    | { readonly kind: 'grant'; readonly payload: unknown }
}

declare module '@deepseek-ai/dsh-launch-environment' {
  import type { Context } from '@deepseek-ai/cordis'
  export function launchEnvironmentOf(ctx: Context): {
    get(key: string): { value: string } | undefined
  }
}

declare module '@deepseek-ai/dsh-settings' {
  /** A lowercase hyphenated settings namespace identifier. */
  export type SettingsNamespace = string
  /** Owner-facing handle for one registered namespace. */
  export interface SettingsScope<T> {
    get(): T
    watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
    update(patch: object): Promise<void>
    replace(section: object): Promise<void>
  }
  /** Hooks a consumer hands to `SettingsProvider.installSection`. */
  export interface SettingsSectionHooks<T> {
    setSource(current: () => T): void
    onChange(): void
    validate?(value: T): void
  }
  /** The settings service (`ctx.settings`); registration + resolution. */
  export class SettingsProvider {
    register<T>(ns: string, schema: unknown, options?: { base?: Partial<T>; applies?: 'live' | 'restart' }): SettingsScope<T>
    installSection<T>(owner: unknown, ns: string, schema: unknown, entry: T, hooks: SettingsSectionHooks<T>): void
    describe(options?: { redactSecrets?: boolean }): unknown[]
    get<T = unknown>(ns: string): T
    update(ns: string, patch: object, expectedRevision?: number): Promise<void>
    replace(ns: string, section: object, expectedRevision?: number): Promise<void>
    mutate(ns: string, ops: readonly unknown[], expectedRevision?: number): Promise<void>
  }
  export class SettingsConflictError extends Error {
    readonly code: 'SETTINGS_CONFLICT'
    readonly expected: number
    readonly actual: number
  }
  export function redactSecrets(value: unknown): unknown
}

/** Own package version, injected by tsdown `define` at build time. */
declare const __PLUGIN_VERSION__: string
