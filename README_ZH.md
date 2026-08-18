<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-provider-quota"><img src="https://img.shields.io/npm/v/dsh-provider-quota.svg" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/dsh-provider-quota.svg?cacheSeconds=300" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724" alt="DeepSeek Harness plugin">
</p>

# dsh-provider-quota

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在 Web GUI 侧边栏底部实时显示所有已配置 LLM provider 的账户额度——不用再逐个登录 provider 控制台确认余额。

## 功能

- **自动探测** —— 自动枚举当前 profile 中已注册的 provider 路由（`ctx.llm`），常见路由零配置。
- **按 provider 类型查询额度**：
  - **DeepSeek**（`deepseek-official` 等）→ `GET {baseURL}/user/balance`（余额，含赠送/充值明细）
  - **Kimi Code 订阅**（`kimi-coding`）→ `GET {baseURL}/v1/usages`（每周配额及各限速窗口，含重置倒计时）
  - **Moonshot 开放平台**（`moonshotai-cn` / `moonshotai`）→ `GET {baseURL}/users/me/balance`
- **密钥安全** —— 通过 harness 凭据服务按次解析（环境变量 / `~/.dsh/.credentials.yaml`），不缓存、不落地。
- **侧边栏入口** —— 侧边栏底部按钮点击弹出额度面板；任一 provider 异常时按钮显示红点。
- **刷新周期可调** —— 面板内调整（15s–30min，localStorage 持久化），默认值由插件配置提供。
- **手动 provider** —— 可通过配置添加任意网关（如自建 DeepSeek 兼容端点）。

## 安装

> [!NOTE]
> 需要先安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

### npm

```sh
dsh plugin --profile web add dsh-provider-quota
```

### 从源码构建

```sh
git clone https://github.com/lizhouai/dsh-provider-quota.git
cd dsh-provider-quota
pnpm install
pnpm build
dsh plugin --profile web add .
```

插件集合变化后需重启 `dsh web`；之后仅改动代码时重新 build + 重新 add + 刷新页面即可。

## 配置说明

默认开箱即用：自动探测当前 profile 的所有 provider 路由。也可以在 `~/.dsh/profiles/web/cordis.patch.yml` 中调整：

```yaml
- insert:
    - id: provider-quota
      name: dsh-provider-quota
      config:
        refreshSeconds: 60   # 面板默认刷新周期（秒）
        autoDetect: true     # 自动枚举 llm 注册表中的 provider
        providers: []        # 手动补充/覆盖 provider（id 相同则覆盖自动探测结果）
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `refreshSeconds` | number | `60` | 面板建议刷新周期（秒），5–86400 |
| `autoDetect` | boolean | `true` | 从 llm 注册表自动枚举 provider |
| `providers` | array | `[]` | 手动 provider 规格：`{id, kind, baseURL, apiKeyEnv, displayName?, enabled?}`，`kind ∈ deepseek / kimi-coding / moonshot` |

也可以在 `~/.dsh/settings.yaml` 中通过 `provider-quota:` 命名空间热更新同样字段。

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

- **Host 半**（`src/index.ts`）：`QuotaService extends TypertRemoteService`，`@Remote('list')` 暴露 `quota/list`（SRC 模式，无需代码生成）；`Config` 用 schemastery 声明，`installSettingsSection` 支持 settings 热更新。
- **Client 半**（`src/client/`）：`window.__ModuleLoader__.load({id, factory})` 格式 bundle（tsdown 构建），注册到 `sidebar.footer.action` slot，通过 `ctx.connection.rpc.call('/api', 'quota/list', {args:{}})` 轮询。服务本身无状态——每次轮询都取实时值。

## 许可证

[MIT](./LICENSE)
