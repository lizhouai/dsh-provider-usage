<p align="right">
  <strong>English</strong> · <a href="./README_ZH.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-provider-quota"><img src="https://img.shields.io/npm/v/dsh-provider-quota.svg" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/dsh-provider-quota.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724" alt="DeepSeek Harness plugin">
</p>

# dsh-provider-quota

**Every provider's balance, one glance away.** A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that shows the live account balance / quota of every configured LLM provider in the Web GUI sidebar — no more logging into each provider console to check whether you are about to run out of credit mid-session.

## Features

- **Auto-detection** — enumerates the provider routes registered in the current profile (`ctx.llm`); zero configuration for well-known routes.
- **Per-kind wire adapters**:
  - **DeepSeek** (`deepseek-official`, …) → `GET {baseURL}/user/balance` (total / granted / topped-up balance)
  - **Kimi Code subscription** (`kimi-coding`) → `GET {baseURL}/v1/usages` (weekly quota and rate-limit windows, with reset countdown)
  - **Moonshot open platform** (`moonshotai-cn` / `moonshotai`) → `GET {baseURL}/users/me/balance`
- **Credentials stay safe** — API keys are resolved per request through the harness credentials service (environment variables / `~/.dsh/.credentials.yaml`); never cached, never written to disk.
- **Sidebar widget** — an entry button in the sidebar footer opens the quota panel; the button shows a red dot when any provider errors out.
- **Configurable refresh** — adjustable in the panel (15s–30min, persisted in localStorage); the default comes from the plugin config.
- **Manual providers** — add arbitrary gateways (e.g. a self-hosted DeepSeek-compatible endpoint) via config.

## Install

> [!NOTE]
> Requires an existing [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation.

### npm

```sh
dsh plugin --profile web add dsh-provider-quota
```

### Build from source

```sh
git clone https://github.com/lizhouai/dsh-provider-quota.git
cd dsh-provider-quota
pnpm install
pnpm build
dsh plugin --profile web add .
```

Restart `dsh web` after changing the plugin set (a plugin add/remove requires a restart; afterwards, code changes only need a rebuild + re-add + page refresh).

## Configuration

Defaults work out of the box: the plugin auto-detects every provider route of the active profile. A trusted profile can tune behavior in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: provider-quota
      name: dsh-provider-quota
      config:
        refreshSeconds: 60   # suggested panel refresh interval (5–86400)
        autoDetect: true     # enumerate provider routes from the llm registry
        providers: []        # manual specs; an id matching a detected route overrides it
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `refreshSeconds` | number | `60` | Suggested widget refresh interval in seconds (5–86400) |
| `autoDetect` | boolean | `true` | Enumerate live provider routes from the llm registry |
| `providers` | array | `[]` | Manual provider specs: `{id, kind, baseURL, apiKeyEnv, displayName?, enabled?}`, `kind ∈ deepseek / kimi-coding / moonshot` |

The same fields can be hot-updated under the `provider-quota:` namespace in `~/.dsh/settings.yaml`.

### Adding a manual provider

```yaml
config:
  providers:
    - id: my-deepseek-gateway
      kind: deepseek
      baseURL: https://my-gateway.example.com
      apiKeyEnv: MY_GATEWAY_KEY
      displayName: My Gateway
```

## How it works

- **Host half** (`src/index.ts`): `QuotaService extends TypertRemoteService` exposes `quota/list` via `@Remote('list')` (SRC mode, no codegen). Config is declared with schemastery, and `installSettingsSection` enables hot updates from settings.
- **Client half** (`src/client/`): a `window.__ModuleLoader__.load({id, factory})` bundle (built by tsdown) registers into the `sidebar.footer.action` slot and polls `quota/list` through `ctx.connection.rpc.call('/api', 'quota/list', {args:{}})` on its own interval. The service stays stateless — every poll fetches live values.

## License

[MIT](./LICENSE)
