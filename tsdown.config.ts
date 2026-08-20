/**
 * tsdown config for dsh-provider-usage, adapted from the harness's
 * shared `packages/client/tsdown.client.ts` preset:
 *
 * - Node half: `src/index.ts` → `lib/index.js` (ESM; @deepseek-ai/* peers
 *   stay external and resolve through $DSH_HOME/profiles/node_modules).
 * - Browser half: `src/client/index.ts` → `lib/client.js`, a lazy CJS factory
 *   registered through `window.__ModuleLoader__.load({ id, factory })`.
 */
import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/**
 * Module id this bundle registers under via `__ModuleLoader__.load`. The host
 * looks the bundle up by the plugin's package name, so this must BE the
 * package name — read it from package.json rather than restating it, so a
 * rename cannot leave the client half registering a stale id.
 */
const ID: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).name

/**
 * Externals answered by the shell's loader module table (PLATFORM_MODULES in
 * dsh-client-web plus the documented runtime exemption). Everything else the
 * client imports is inlined into the bundle.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig([
  {
    name: ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    sourcemap: false,
    clean: true,
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    // clean must stay off — the node half above already emitted into lib/.
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
