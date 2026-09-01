<p align="right">
  <strong>English</strong> · <a href="./README_ZH.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-provider-usage"><img src="https://img.shields.io/npm/v/dsh-provider-usage.svg?cacheSeconds=300" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724" alt="DeepSeek Harness plugin">
</p>

# dsh-provider-usage

**Every provider's balance, one glance away.** A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that floats a small draggable usage ball over the Web GUI — no more logging into each provider console to check whether you are about to run out of credit mid-session.

## Features

- **Auto-detection** — enumerates the provider routes registered in the current profile (`ctx.llm`); zero configuration for well-known routes.
- **Per-kind wire adapters** — routes with no public balance/quota API (Google, Mistral, Groq, Bedrock, Azure, Qwen Token Plan, …) are listed as `unsupported` instead of being silently dropped:

  | kind | routes | query | shows |
  |---|---|---|---|
  | `deepseek` | `deepseek-official`, `deepseek` | `GET {baseURL}/user/balance` | total / granted / topped-up balance |
  | `moonshot` | `moonshotai-cn`, `moonshotai` | `GET {baseURL}/users/me/balance` | available / voucher / cash balance |
  | `kimi-coding` | `kimi-coding` | `GET {baseURL}/v1/usages` | weekly quota + rate-limit windows, reset countdown |
  | `openrouter` | `openrouter` | `GET {origin}/api/v1/credits` | credits used / total |
  | `github-copilot` | `github-copilot` | `GET api.github.com/copilot_internal/user` | plan quota snapshots (paid) or monthly quotas (free) |
  | `openai-codex` | `openai-codex` | `GET {baseURL}/wham/usage` | ChatGPT subscription 5h / weekly windows + credits + spend control (**OAuth login**, not an API key — see [OpenAI Codex via OAuth](#openai-codex-via-oauth)) |
  | `openai` | `openai` | `GET {origin}/v1/organization/costs` | current-month spend (**admin key required**; a regular key fails with 403) |
  | `anthropic` | `anthropic` | `GET {baseURL}/v1/organizations/cost_report` | current-month spend (**admin key required**, `x-api-key` auth) |
  | `minimax` | `minimax`, `minimax-cn` | `GET {origin}/v1/api/openplatform/coding_plan/remains` | Coding Plan 5h / weekly remaining % |
  | `zai` | `zai`, `zai-coding-cn` | `GET {origin}/api/monitor/usage/quota/limit` | GLM Coding Plan windows (raw key in `Authorization`, no Bearer) |
  | `opencode` | `opencode`, `opencode-go` | `GET {baseURL}/usage` | Zen Go rolling / weekly / monthly windows |
  | `vercel-ai-gateway` | `vercel-ai-gateway` | `GET {baseURL}/v1/credits` | team credit balance |
  | `xai` | `xai` | `GET {baseURL}/billing/credits` | prepaid balance (USD) |
- **Credentials stay safe** — API keys are resolved per request through the harness credentials service (environment variables / `~/.dsh/.credentials.yaml`); never cached, never written to disk. For OAuth providers (OpenAI Codex) the plugin reads the grant record the sign-in flow stored, and refreshes it transparently when it is about to expire.
- **Floating ball widget** — a draggable floating ball opens the usage panel. Drop it anywhere in the viewport (position persisted); it docks by default at the bottom-left of the chat area with equal margins, and the panel-header home button sends it back. The halo around the ball encodes the health of the provider **in use** (the composer's current model selection): green all good, amber some quota below 30% left, red on query failure / missing key / usage ≥90%. Idle providers with low quota do not color the ball — switch to another provider with enough quota and the ball turns green again; the panel marks the in-use provider and still lists every provider's numbers.
- **Version badge** — the panel header shows the running plugin version next to the title, so it is obvious which release is loaded.
- **Bilingual panel** — built-in Chinese/English UI; follows the harness language by default, with a one-click toggle in the panel header (persisted in localStorage).
- **Configurable refresh** — adjustable in the panel (15s–30min, persisted in localStorage); the default comes from the plugin config.
- **Manual providers** — add arbitrary gateways (e.g. a self-hosted DeepSeek-compatible endpoint) via config.

## Screenshots

The floating ball (bottom-left, with the green healthy halo) and the open usage panel:

![Usage panel in English](docs/panel-en.png)

## OpenAI Codex via OAuth

OpenAI Codex is a **ChatGPT-subscription** provider: it authenticates with an OAuth access token, not an API key, so there is nothing to paste into a key field. dsh itself has no OAuth *button* for this route — but this plugin can still query its quota, because it reads the OAuth grant out of the harness credential store. Set the provider up once, and the usage panel shows your real 5-hour / weekly Codex windows.

### 1. Make sure the route exists

The sign-in writes a grant record addressed `llm-pi-ai/openai-codex`, and the route has to be configured for `ctx.llm` to list it. With the stock `llm-pi-ai` adapter mounted (default in the web profile), an empty profile is enough — e.g. in `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    openai-codex: {}
```

### 2. Sign in through the harness authorization seam

`dsh-llm-pi-ai` registers an "OpenAI (ChatGPT Plus/Pro)" OAuth flow for `openai-codex` on the harness authorization seam (`ctx.authorization`, credential key `llm-pi-ai/openai-codex`). Complete it from any surface that runs that flow — a sign-in entry on the harness model/authorization UI, or any pi-ai client whose login persists through the harness credential store. Finish the browser (or device-code) flow with your ChatGPT account. The harness then stores the grant under `~/.dsh/.credentials.yaml` as `llm-pi-ai/openai-codex`:

```yaml
records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:
      type: oauth
      access: <access token>
      refresh: <refresh token>
      expires: <epoch ms>
      accountId: <chatgpt account id>
```

> The grant must land in the harness credential store (the record above). Codex clients that keep their own credential file (e.g. `dsh-codex`'s `$DSH_HOME/.openai-codex-auth.json`, or the Codex CLI's `~/.codex/auth.json`) do not write this record, so this plugin cannot see them.

### 3. Watch the quota

That's it. The route is auto-detected (`ctx.llm` lists `openai-codex`), and the plugin:

1. reads the grant record from the credential store on every poll (no caching),
2. refreshes the OAuth token automatically when it is within 30 s of expiry (and persists the rotated grant back through the store's locked `modifyRecord`),
3. calls `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access>` and the `ChatGPT-Account-Id` header derived from the token's own JWT claim, retrying once after a refresh if the endpoint answers `401`.

The panel then shows your subscription's **5h limit**, **weekly** windows (used %, reset countdown) plus **credits** and **spend control** balances when the plan reports them. If the grant is missing the card reads "OAuth authorization missing (llm-pi-ai/openai-codex)" — sign in again with step 2.

## Install

> [!NOTE]
> Requires an existing [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation.

### npm

```sh
dsh plugin --profile web add dsh-provider-usage@latest
```

### Build from source

```sh
git clone https://github.com/lizhouai/dsh-provider-usage.git
cd dsh-provider-usage
pnpm install
pnpm build
pnpm pack   # produces dsh-provider-usage-<version>.tgz
dsh plugin --profile web add ./dsh-provider-usage-<version>.tgz
```

Install the **tarball**, not the repo directory: `dsh plugin add .` links the repo, whose own `node_modules` then shadows the harness's shared `@deepseek-ai/cordis` instance and the host half never registers (RPC 404). The link form is still handy for client-only UI iteration — the browser bundle is self-contained, so a rebuild + page refresh picks it up — but switch to the tarball (or the npm release) whenever you need the host half. If pnpm fails with `EPERM ... symlink` while replacing a linked install, delete the stale `node_modules/dsh-provider-usage` junction in the profile directory and retry.

Restart `dsh web` after changing the plugin set (a plugin add/remove requires a restart; afterwards, code changes only need a rebuild + re-add + page refresh).

## Upgrade

```sh
dsh plugin --profile web add dsh-provider-usage@latest
```

Then restart `dsh web` and refresh the page. If the release you want was published very recently, your profile's supply-chain cooldown (`minimumReleaseAge`) may silently keep the older version — pin the exact version instead (`dsh plugin --profile web add dsh-provider-usage@0.3.1`) and dsh will exempt it automatically. The version badge in the panel header confirms which release is actually loaded.

## Configuration

Defaults work out of the box: the plugin auto-detects every provider route of the active profile. A trusted profile can tune behavior in `~/.dsh/profiles/web/cordis.patch.yml` — **override the bundle's row by id** (the package's own bundle patch already inserts it; a second `insert` of the same id fails the boot with `duplicate loader entry id`):

```yaml
- id: provider-usage
  name: dsh-provider-usage
  config:
    refreshSeconds: 60   # suggested panel refresh interval (5–86400)
    autoDetect: true     # enumerate provider routes from the llm registry
    providers: []        # manual specs; an id matching a detected route overrides it
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `refreshSeconds` | number | `60` | Suggested widget refresh interval in seconds (5–86400) |
| `autoDetect` | boolean | `true` | Enumerate live provider routes from the llm registry |
| `providers` | array | `[]` | Manual provider specs: `{id, kind, baseURL, apiKeyEnv, displayName?, enabled?}`; `kind` is one of the adapter table above |

The same fields can be hot-updated under the `provider-usage:` namespace in `~/.dsh/settings.yaml`.

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

- **Host half** (`src/index.ts`): `UsageService extends TypertRemoteService` exposes `usage/list` via `@Remote('list')` (SRC mode, no codegen). Config is declared with schemastery, and `installSettingsSection` enables hot updates from settings.
- **Client half** (`src/client/`): a `window.__ModuleLoader__.load({id, factory})` bundle (built by tsdown) mounts through the `sidebar.footer.action` slot (used purely as a mount point — the trigger itself is a floating ball portaled to `document.body`) and polls `usage/list` through `ctx.connection.rpc.call('/api', 'usage/list', {args:{}})` on its own interval. The service stays stateless — every poll fetches live values.

## License

[MIT](./LICENSE)
