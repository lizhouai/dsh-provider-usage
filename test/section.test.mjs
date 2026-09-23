/**
 * Regression tests for reading foreign plugin sections (`src/section.ts`).
 *
 * The defect these lock down: the panel resolved route facts (`apiKeyEnv`,
 * `baseURL`) from a *foreign* settings section through `settings.get(ns)`,
 * which dsh ≥ 0.1.3 removed along with the old `SettingsProvider`. The call
 * then vanished into the catch-all and every auto-detected route fell back to
 * the built-in catalog, so a Kimi key stored under the profile's ref name
 * `KIMI_CODING_API_KEY` was probed as the catalog name `KIMI_API_KEY` and the
 * panel reported "No API key configured (KIMI_API_KEY)". The reader now tries
 * the legacy call first, falls back to the config editor's loader entries, and
 * unwraps the volatile `.get()` refs the new generation hands out.
 *
 * Run with `pnpm test` (Node's built-in test runner, TypeScript stripped).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { plainSection, readLiveSection, settingsNsForRoute } from '../src/section.ts'

/** A volatile config ref as newer dsh hands them out (`createVolatile`). */
function volatileRef(snapshot) {
  let current = snapshot
  return Object.freeze({
    get: () => current,
    write: (next) => {
      current = next
    },
  })
}

/** The new-generation settings service: a forms service with no `get`. */
const formsSettings = { describe: () => [], update: async () => {} }

/** The new-generation config editor: loader entries over a profile patch. */
function configEditor(entries) {
  return { entries: () => entries }
}

const piAiEntry = (config) => ({ options: { id: 'llm-pi-ai' }, fiber: { config } })

test('legacy generation: settings.get(ns) answers the section', async () => {
  const settings = { get: (ns) => (ns === 'llm-pi-ai' ? { providers: {} } : undefined) }
  assert.deepEqual(await readLiveSection(settings, undefined, 'llm-pi-ai'), { providers: {} })
})

test('legacy generation: a throwing get degrades to undefined, never breaks the query', async () => {
  const settings = { get: () => {
    throw new Error('settings broken')
  } }
  assert.equal(await readLiveSection(settings, undefined, 'llm-pi-ai'), undefined)
})

test('new generation: the live entry config is read off the loader entries, volatile refs unwrapped', async () => {
  const snapshot = {
    'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY' },
    'ark-agent-plan': { apiKeyEnv: 'ARK_AGENT_PLAN_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3' },
  }
  const editor = configEditor([piAiEntry({ providers: volatileRef(snapshot) })])
  const section = await readLiveSection(formsSettings, editor, 'llm-pi-ai')
  assert.equal(section.providers['kimi-coding'].apiKeyEnv, 'KIMI_CODING_API_KEY')
  assert.equal(section.providers['ark-agent-plan'].baseURL, 'https://ark.cn-beijing.volces.com/api/plan/v3')
})

test('new generation: the detached snapshot is not aliased to the live ref', async () => {
  const editor = configEditor([piAiEntry({ providers: volatileRef({}) })])
  const section = await readLiveSection(formsSettings, editor, 'llm-pi-ai')
  section.providers['kimi-coding'] = { apiKeyEnv: 'X' }
  assert.deepEqual(await readLiveSection(formsSettings, editor, 'llm-pi-ai'), { providers: {} })
})

test('new generation: missing config editor, non-matching entry, or missing fiber read as unconfigured', async () => {
  assert.equal(await readLiveSection(formsSettings, undefined, 'llm-pi-ai'), undefined)
  const fiberless = configEditor([{ options: { id: 'llm-pi-ai' } }])
  assert.equal(await readLiveSection(formsSettings, fiberless, 'llm-pi-ai'), undefined)
  assert.equal(await readLiveSection(formsSettings, configEditor([piAiEntry({})]), 'llm-deepseek'), undefined)
})

test('legacy miss falls through to the loader entries (hybrid composition)', async () => {
  const settings = { get: () => undefined }
  const editor = configEditor([piAiEntry({ providers: volatileRef({ 'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY' } }) })])
  const section = await readLiveSection(settings, editor, 'llm-pi-ai')
  assert.equal(section.providers['kimi-coding'].apiKeyEnv, 'KIMI_CODING_API_KEY')
})

test('plainSection copies plain data structurally', () => {
  const value = { a: 1, b: ['x', { c: true }], d: null }
  assert.deepEqual(plainSection(value), value)
  assert.equal(plainSection('flat'), 'flat')
  assert.equal(plainSection(undefined), undefined)
})

test('settingsNsForRoute: the directory answer wins, the plugin namespace is the fallback', () => {
  const llm = {
    listConfigurableProviders: () => [
      { provider: 'kimi-coding', settingsNs: 'llm-pi-ai' },
      { provider: 'renamed-route', settingsNs: 'renamed-pi-ai' },
    ],
  }
  assert.equal(settingsNsForRoute(llm, 'kimi-coding'), 'llm-pi-ai')
  assert.equal(settingsNsForRoute(llm, 'renamed-route'), 'renamed-pi-ai')
  assert.equal(settingsNsForRoute(llm, 'unknown-route'), 'llm-pi-ai')
  assert.equal(settingsNsForRoute(undefined, 'kimi-coding'), 'llm-pi-ai')
  assert.equal(settingsNsForRoute({}, 'kimi-coding'), 'llm-pi-ai')
})
