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
  export function credentialRef(value: string): CredentialRef
}

declare module '@deepseek-ai/dsh-launch-environment' {
  import type { Context } from '@deepseek-ai/cordis'
  export function launchEnvironmentOf(ctx: Context): {
    get(key: string): { value: string } | undefined
  }
}

declare module '@deepseek-ai/dsh-settings' {
  import type { Context } from '@deepseek-ai/cordis'
  export function settingsNamespace(name: string): string
  export function installSettingsSection(
    ctx: Context,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: { setSource?: (source: () => unknown) => void; onChange?: () => void },
  ): void
}
