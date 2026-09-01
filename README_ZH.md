<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-provider-usage"><img src="https://img.shields.io/npm/v/dsh-provider-usage.svg?cacheSeconds=300" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724" alt="DeepSeek Harness plugin">
</p>

# dsh-provider-usage

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在 Web GUI 上悬浮一个可任意拖动的用量球，实时查看所有已配置 LLM provider 的账户余额与配额用量——不用再逐个登录 provider 控制台确认。

## 功能

- **自动探测** —— 自动枚举当前 profile 中已注册的 provider 路由（`ctx.llm`），常见路由零配置。
- **按 provider 类型查询额度** —— 没有公开余额/配额接口的路由（Google、Mistral、Groq、Bedrock、Azure、Qwen Token Plan 等）会在面板中标注为「不支持」，而不是被静默忽略：

  | kind | 路由 | 查询接口 | 展示内容 |
  |---|---|---|---|
  | `deepseek` | `deepseek-official`、`deepseek` | `GET {baseURL}/user/balance` | 余额（含赠送/充值明细） |
  | `moonshot` | `moonshotai-cn`、`moonshotai` | `GET {baseURL}/users/me/balance` | 可用/代金券/现金余额 |
  | `kimi-coding` | `kimi-coding` | `GET {baseURL}/v1/usages` | 每周配额及各限速窗口，含重置倒计时 |
  | `openrouter` | `openrouter` | `GET {origin}/api/v1/credits` | credit 已用/总额 |
  | `github-copilot` | `github-copilot` | `GET api.github.com/copilot_internal/user` | 付费档配额快照 / 免费档月度配额 |
  | `openai-codex` | `openai-codex` | `GET {baseURL}/wham/usage` | ChatGPT 订阅 5h/周窗口 + credits + spend control（**OAuth 登录**，非 API key，见 [通过 OAuth 添加 OpenAI Codex](#通过-oauth-添加-openai-codex)） |
  | `openai` | `openai` | `GET {origin}/v1/organization/costs` | 当月花费（**需 Admin key**，普通 key 会 403） |
  | `anthropic` | `anthropic` | `GET {baseURL}/v1/organizations/cost_report` | 当月花费（**需 Admin key**，`x-api-key` 头） |
  | `minimax` | `minimax`、`minimax-cn` | `GET {origin}/v1/api/openplatform/coding_plan/remains` | Coding Plan 5h/周剩余百分比 |
  | `zai` | `zai`、`zai-coding-cn` | `GET {origin}/api/monitor/usage/quota/limit` | GLM Coding Plan 窗口（`Authorization` 直接放 key，无 Bearer） |
  | `opencode` | `opencode`、`opencode-go` | `GET {baseURL}/usage` | Zen Go 滚动/周/月窗口 |
  | `vercel-ai-gateway` | `vercel-ai-gateway` | `GET {baseURL}/v1/credits` | 团队 credit 余额 |
  | `xai` | `xai` | `GET {baseURL}/billing/credits` | 预付余额（USD） |
- **密钥安全** —— 通过 harness 凭据服务按次解析（环境变量 / `~/.dsh/.credentials.yaml`），不缓存、不落地。对 OAuth 类 Provider（OpenAI Codex）则直接读取登录流程存入的授权记录，并在令牌临近过期时自动刷新。
- **悬浮球入口** —— 可任意拖动的悬浮球点击弹出用量面板，位置持久化；默认停靠在主对话区域左下角（左边距 = 底边距），面板头部的归位按钮一键回到默认位置；球体光晕表达**当前正在使用**的 Provider（composer 中选中的模型）的健康度：绿色正常、黄色配额剩余不足 30%、红色查询失败/缺密钥/用量 ≥90%。闲置的 Provider 余量不足不再影响悬浮球颜色——切换到余量充足的另一个 Provider 后球体会恢复绿色；面板会标注"使用中"的 Provider，并照常列出所有 Provider 的用量明细。
- **版本徽章** —— 面板标题旁显示当前运行的插件版本，一眼确认加载的是哪个发布版。
- **中英双语** —— 面板内置中英文界面，默认跟随 harness 系统语言，标题栏按钮一键切换（localStorage 持久化）。
- **刷新周期可调** —— 面板内调整（15s–30min，localStorage 持久化），默认值由插件配置提供。
- **手动 provider** —— 可通过配置添加任意网关（如自建 DeepSeek 兼容端点）。

## 截图

悬浮球（左下角，绿色光晕表示全部正常）与打开的用量面板：

![用量面板（中文）](docs/panel-zh.png)

## 通过 OAuth 添加 OpenAI Codex

OpenAI Codex 是 **ChatGPT 订阅制** Provider：它用 OAuth access token 认证，而不是 API key，所以没有任何密钥可填。dsh 本身没有为该路由内置 OAuth 登录按钮——但本插件依然能查询它的余量，因为插件会直接从 harness 凭据库读取登录后存入的授权记录。按下面步骤配置一次，用量面板就能展示真实的 Codex 5 小时 / 每周窗口。

### 1. 确认路由已配置

登录会把授权记录写入 `llm-pi-ai/openai-codex`，且路由需要已配置，`ctx.llm` 才会列出它。默认 web profile 已挂载 `llm-pi-ai` 适配器，空 profile 即可——例如在 `~/.dsh/settings.yaml` 中：

```yaml
llm-pi-ai:
  providers:
    openai-codex: {}
```

### 2. 通过 harness 授权 seam 登录

`dsh-llm-pi-ai` 在 harness 授权 seam（`ctx.authorization`，凭据键 `llm-pi-ai/openai-codex`）上为 `openai-codex` 注册了 "OpenAI (ChatGPT Plus/Pro)" 的 OAuth 流程。从任何调起该流程的入口完成登录——harness 模型/授权界面上的登录入口，或任何会把登录结果持久化到 harness 凭据库的 pi-ai 客户端。用你的 ChatGPT 账号完成浏览器（或设备码）流程后，harness 会把授权记录存到 `~/.dsh/.credentials.yaml` 的 `llm-pi-ai/openai-codex` 下：

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

> 授权记录必须落在 harness 凭据库（即上面的记录）。使用独立凭据文件的 Codex 客户端（如 `dsh-codex` 的 `$DSH_HOME/.openai-codex-auth.json`，或 Codex CLI 的 `~/.codex/auth.json`）不会写入该记录，本插件无法读取。

### 3. 查看余量

配置完成。路由会被自动探测（`ctx.llm` 会列出 `openai-codex`），插件会：

1. 每次轮询都从凭据库**实时读取**授权记录（不缓存）；
2. access token 距过期不足 30 秒时**自动刷新** OAuth 令牌（并通过凭据库带锁的 `modifyRecord` 回写旋转后的授权）；
3. 用 `Authorization: Bearer <access>` + 从令牌 JWT 中解析出的 `ChatGPT-Account-Id` 头请求 `GET https://chatgpt.com/backend-api/wham/usage`；若返回 `401` 会自动刷新一次并重试。

面板随即展示订阅的 **5h 上限**、**每周**窗口（已用百分比 + 重置倒计时），以及计划上报的 **credits** 与 **spend control** 余额。若授权记录缺失，卡片会显示「未完成 OAuth 授权（llm-pi-ai/openai-codex）」，按第 2 步重新登录即可。

## 安装

> [!NOTE]
> 需要先安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

### npm

```sh
dsh plugin --profile web add dsh-provider-usage@latest
```

### 从源码构建

```sh
git clone https://github.com/lizhouai/dsh-provider-usage.git
cd dsh-provider-usage
pnpm install
pnpm build
pnpm pack   # 产出 dsh-provider-usage-<version>.tgz
dsh plugin --profile web add ./dsh-provider-usage-<version>.tgz
```

注意要安装 **tarball** 而不是仓库目录：`dsh plugin add .` 会链接整个仓库，仓库自带 `node_modules` 里的 `@deepseek-ai/cordis` 会遮蔽 harness 的共享实例，导致 host 半注册不上（RPC 404）。link 方式仍适合纯 UI 迭代（浏览器 bundle 自包含，重新 build + 刷新页面即生效），但需要 host 半时请切换到 tarball 或 npm 正式版。若替换 link 安装时 pnpm 报 `EPERM ... symlink`，手动删除 profile 目录下残留的 `node_modules/dsh-provider-usage` 联结后重试即可。

插件集合变化后需重启 `dsh web`；之后仅改动代码时重新 build + 重新 add + 刷新页面即可。

## 升级

```sh
dsh plugin --profile web add dsh-provider-usage@latest
```

然后重启 `dsh web` 并刷新页面。如果目标版本刚发布不久，profile 的供应链冷静期（`minimumReleaseAge`）可能会静默停留在旧版——这时指定精确版本号（如 `dsh plugin --profile web add dsh-provider-usage@0.3.1`），dsh 会自动豁免该版本。面板标题旁的版本徽章可以确认实际加载的版本。

## 配置说明

默认开箱即用：自动探测当前 profile 的所有 provider 路由。也可以在 `~/.dsh/profiles/web/cordis.patch.yml` 中调整——**按 id 覆盖**包内 bundle 已挂载的行（包自带的 bundle patch 已经 insert 过该行，再 insert 一次相同 id 会导致启动报 `duplicate loader entry id`）：

```yaml
- id: provider-usage
  name: dsh-provider-usage
  config:
    refreshSeconds: 60   # 面板默认刷新周期（秒）
    autoDetect: true     # 自动枚举 llm 注册表中的 provider
    providers: []        # 手动补充/覆盖 provider（id 相同则覆盖自动探测结果）
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `refreshSeconds` | number | `60` | 面板建议刷新周期（秒），5–86400 |
| `autoDetect` | boolean | `true` | 从 llm 注册表自动枚举 provider |
| `providers` | array | `[]` | 手动 provider 规格：`{id, kind, baseURL, apiKeyEnv, displayName?, enabled?}`，`kind` 取上表中的任一适配器 |

也可以在 `~/.dsh/settings.yaml` 中通过 `provider-usage:` 命名空间热更新同样字段。

### 手动添加一个 provider 示例

```yaml
config:
  providers:
    - id: my-deepseek-gateway
      kind: deepseek
      baseURL: https://my-gateway.example.com
      apiKeyEnv: MY_GATEWAY_KEY
      displayName: 自建网关
```

## 架构

- **Host 半**（`src/index.ts`）：`UsageService extends TypertRemoteService`，`@Remote('list')` 暴露 `usage/list`（SRC 模式，无需代码生成）；`Config` 用 schemastery 声明，`installSettingsSection` 支持 settings 热更新。
- **Client 半**（`src/client/`）：`window.__ModuleLoader__.load({id, factory})` 格式 bundle（tsdown 构建），通过 `sidebar.footer.action` slot 挂载（仅作为挂载点——触发器本体是 portal 到 `document.body` 的悬浮球），通过 `ctx.connection.rpc.call('/api', 'usage/list', {args:{}})` 轮询。服务本身无状态——每次轮询都取实时值。

## 许可证

[MIT](./LICENSE)
