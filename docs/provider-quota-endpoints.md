# LLM Provider 余额/配额查询接口调研结论

> 调研日期：2026（已用官方文档 + 开源实现交叉验证，未臆造端点）
> 用途：「LLM provider 余额/配额查询面板」插件适配器开发依据

## 总览

| Provider | 可查性 | 认证方式 | 核心端点 |
|---|---|---|---|
| openai | partial | Admin key (Bearer) | `GET /v1/organization/costs`, `GET /v1/organization/usage/completions` |
| openai-codex | yes (OAuth) | OAuth Bearer token | `GET https://chatgpt.com/backend-api/wham/usage` |
| anthropic | partial | Admin key (`x-api-key` 头) | `GET /v1/organizations/usage_report/messages`, `GET /v1/organizations/cost_report` |
| gemini | no (API key) | — | 无；仅私有 OAuth 接口 |
| xai | yes | Management key (Bearer) | `GET https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance` |
| mistral | yes | 推理 key (Bearer) | `GET /v1/billing/budget`, `GET /v1/billing/subscription` |
| volcengine-ark (Agent Plan / Coding Plan) | yes | IAM **AK/SK**（V4 HMAC-SHA256 签名） | `POST https://open.volcengineapi.com/?Action=GetAFPUsage\|GetCodingPlanUsage&Version=2024-01-01` |

---

## 1. openai — partial

普通 `sk-...` key **无法**查询余额。需 Organization **Admin key**（`sk-admin...`，platform.openai.com → Organization → Admin keys 创建；不能用于推理）。

### 1.1 Costs（推荐，费用为权威口径）

```
GET https://api.openai.com/v1/organization/costs
    ?start_time=<unix 秒，必填>
    &end_time=<unix 秒>
    &bucket_width=1d            # 1d | 1h | 1m
    &group_by=line_item         # project_id | line_item
    &project_ids=proj_...       # 可选项目过滤
    &limit=31&page=<cursor>
Authorization: Bearer sk-admin-...
```

```json
{
  "object": "page",
  "data": [{
    "object": "bucket",
    "start_time": 1730419200,
    "end_time": 1730505600,
    "results": [{
      "object": "organization.costs.result",
      "amount": { "value": 0.06, "currency": "usd" },
      "line_item": "gpt-4o",
      "project_id": null
    }]
  }],
  "has_more": false,
  "next_page": null
}
```

### 1.2 Usage（token/请求量）

```
GET https://api.openai.com/v1/organization/usage/completions?start_time=...&bucket_width=1d&group_by=model
```

`results[]` 字段：`model`、`input_tokens`、`output_tokens`、`input_cached_tokens`、`num_model_requests`、`project_id`、`api_key_id`。
同族端点：`/v1/organization/usage/{embeddings|images|moderations|audio_speeches|audio_transcriptions|vector_stores|code_interpreter_sessions}`。

### 1.3 遗留余额接口（仅兜底，勿依赖）

```
GET https://api.openai.com/v1/dashboard/billing/credit_grants
Authorization: Bearer <旧式 user key>
# → {"object":"credit_summary","total_granted":..,"total_used":..,"total_available":..,"expires_at":..}
```

**不在 OpenAI 现行公开 API reference**，历史上主要面向 web session，多数普通 key 已返回错误；适配器应将其失败视为"不可用"而非报错。

### 注意事项
- Admin key 组织级、不能推理；project service-account key（`sk-...svcacct`）**不能**读 organization usage/costs。
- Admin API 失败时不要降级到 credit_grants 做项目级过滤（该端点无 project 过滤）。
- 来源：https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs ；https://github.com/steipete/CodexBar/blob/main/docs/openai.md ；https://github.com/dougschaefer6/swamp-openai-usage

---

## 2. openai-codex — yes（ChatGPT 订阅 OAuth，非 API key）

凭证：OAuth access token。在 dsh 中由 `llm-pi-ai/openai-codex` 授权记录提供（`~/.dsh/.credentials.yaml` 的 `kind: grant`，字段 `type/access/refresh/expires/accountId`）；CLI 场景则是 `~/.codex/auth.json`。baseURL：`https://chatgpt.com/backend-api`。

### 2.1 用量窗口

```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <oauth access_token>
ChatGPT-Account-Id: <chatgpt account/workspace id>   # 从 access token 的 JWT claim https://api.openai.com/auth.chatgpt_account_id 解析
```

```json
{
  "plan_type": "plus",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window":   { "used_percent": 23, "limit_window_seconds": 18000,  "reset_after_seconds": 3600, "reset_at": 1730000000 },
    "secondary_window": { "used_percent": 5,  "limit_window_seconds": 604800, "reset_after_seconds": 86400, "reset_at": 1730500000 }
  },
  "additional_rate_limits": [ { "limit_name": "codex", "metered_feature": "codex", "rate_limit": { "...": "模型专属窗口，如 Codex-Spark" } } ],
  "credits": { "has_credits": true, "unlimited": false, "balance": "12.34" },
  "spend_control": { "reached": false, "individual_limit": { "limit": "100", "used": "40", "remaining": "60", "used_percent": 40, "reset_at": 1730000000 } }
}
```

- `primary_window` = 5 小时会话窗口；`secondary_window` = 周窗口。
- `credits.balance`、`spend_control.individual_limit` 的 `limit/used/remaining` 都是**十进制字符串**，不是数字。
- 401 时刷新一次 OAuth 并重试（本插件已实现：从凭据库读 grant → 临近过期自动 refresh → `Bearer` + `ChatGPT-Account-Id` 请求 → 401 重试一次）。

### 2.2 重置积分（可选）

```
GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits
Authorization: Bearer <oauth access_token>
```

### 注意事项
- **未公开内部接口**，无官方文档，可能随时变更/加 Cloudflare 校验。
- token 会过期：本插件读取 dsh 凭据库中的 grant 并在临近过期（30s 内）时用 `client_id=app_EMoamEEZ73f0CkXaXp7hrann` 刷新一次，把旋转后的 grant 通过凭据库的 `modifyRecord` 写回（带跨进程锁，不会与 LLM 请求的刷新互相覆盖）。
- 网页兜底：`https://chatgpt.com/codex/settings/usage`（需 cookie，不推荐）。
- 来源：https://github.com/openai/codex （`backend-client/src/client/rate_limit_resets.rs`、`model-provider/src/bearer_auth_provider.rs`）；https://github.com/steipete/CodexBar/blob/main/docs/codex.md

---

## 3. anthropic — partial

普通 `sk-ant-api...` key **无法**查询。需 **Admin API key**（`sk-ant-admin...`，Console → Settings → Admin keys 创建；不能用于推理）。

### 3.1 Token 用量报表

```
GET https://api.anthropic.com/v1/organizations/usage_report/messages
    ?starting_at=2025-11-01T00:00:00Z   # RFC3339，必填
    &ending_at=...
    &bucket_width=1d                     # 1d | 1h
    &group_by=model                      # workspace_id | api_key_id | model | service_tier | context_window（可多值）
    &models=claude-...&workspace_ids=...&limit=20&page=<cursor>
x-api-key: sk-ant-admin-...
anthropic-version: 2023-06-01
```

```json
{
  "data": [{
    "starting_at": "2025-11-01T00:00:00Z",
    "ending_at": "2025-11-02T00:00:00Z",
    "results": [{
      "model": "claude-sonnet-4-5",
      "workspace_id": null,
      "uncached_input_tokens": 861880,
      "output_tokens": 42000,
      "cache_read_input_tokens": 1200000,
      "cache_creation_5m_input_tokens": 3000,
      "cache_creation_1h_input_tokens": 0,
      "server_tool_use": { "web_search_requests": 12 }
    }]
  }],
  "has_more": false,
  "next_page": null
}
```

### 3.2 费用报表

```
GET https://api.anthropic.com/v1/organizations/cost_report?starting_at=...&group_by=workspace_id
```

`results[]` 字段：`amount`（字符串美元）、`currency`、`cost_type`（如 `tokens`）、`description`、`model`、`workspace_id`、`service_tier`、`starting_at`/`ending_at`。cost_report 的 bucket_width 仅支持 `1d`。

### 3.3 Claude 订阅侧（Pro/Max，OAuth，非 API key）

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <claude code oauth token>
anthropic-beta: oauth-2025-04-20
# 需 user:profile scope；返回 five_hour / seven_day / seven_day_sonnet 等窗口 utilization
```

### 注意事项
- 认证头是 `x-api-key`，**不是** `Authorization: Bearer`。
- 没有"剩余余额"概念——只有花费/用量报表。
- 来源：https://platform.claude.com/docs/en/manage-claude/usage-cost-api ；https://platform.claude.com/docs/en/api/admin/usage_report/retrieve_messages ；https://platform.claude.com/cookbook/observability-usage-cost-api ；https://github.com/steipete/CodexBar/blob/main/docs/claude.md

---

## 4. gemini — no（API key 不可查）

AI Studio key（generativelanguage.googleapis.com）**没有任何**查询配额/用量/余额的 HTTP 接口：

- 官方 rate limits 文档只给静态限额表；tier 状态只能看 AI Studio 网页。
- 响应无标准 rate-limit 头；社区只能靠 429 反推。
- 开源配额工具（CodexBar）对 `api-key` 认证类型直接报"不支持"。

### 灰区参考（私有 OAuth，非 API key，慎用）

```
POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
Authorization: Bearer <google oauth token>          # ~/.gemini/oauth_creds.json（gemini CLI 产生）
{ "project": "<projectId>" }                        # → buckets[].{modelId, remainingFraction, resetTime}

POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
{ "metadata": { "ideType": "GEMINI_CLI", "pluginType": "GEMINI" } }   # → paidTier / currentTier（tier 检测）
```

注意：未公开 internal API；Google 已于 2026-06 停止对个人/AI Pro/Ultra 账号的该 OAuth 通道。

**适配器结论：标记 no，UI 给 https://aistudio.google.com/usage 链接。**

来源：https://github.com/steipete/CodexBar/blob/main/docs/gemini.md ；https://discuss.ai.google.dev/t/gemini-api-429-resource-exhausted-error-on-tier-1/114413

---

## 5. xai — yes（需 Management key）

普通推理 key（`xai-...`，api.x.ai）**不可用**。需 **Management key**（console.x.ai → Management Keys 创建），baseURL 为 `https://management-api.x.ai`，Bearer 认证。`team_id` 在 console Team settings 页复制。

### 5.1 预付余额

```
GET https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance
Authorization: Bearer <management key>
```

```json
{
  "total": { "val": "-1000" },
  "changes": [{
    "teamId": "65c1e471-...",
    "changeOrigin": "PURCHASE",        // PURCHASE|SPEND|REFUND|MANUAL|AUTO_PURCHASE
    "topupStatus": "SUCCEEDED",
    "amount": { "val": "-1000" },
    "createTime": "2025-02-24T15:28:02.308840Z"
  }]
}
```

⚠️ 单位是**美元美分**，且符号反直觉：`SPEND` 为正、`PURCHASE` 为负；`total.val` 为**负值**表示持有额度（可用余额 = `-total.val / 100` 美元）。

### 5.2 配套端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/v1/billing/teams/{team_id}/postpaid/invoice/preview` | 当前账期应付、`effectiveSpendingLimit`、`prepaidCredits` |
| GET | `/v1/billing/teams/{team_id}/postpaid/spending-limits` | 月度软硬限额 |
| POST | `/v1/billing/teams/{team_id}/usage` | 历史用量聚合（body: `analyticsRequest.{timeRange,timeUnit,values,groupBy,filters}`） |
| GET | `/auth/teams/{teamId}/models` | 每模型价格与 rate limit（rps/rpm/tpm/tier） |
| GET | `/auth/management-keys/validation` | 校验 management key、查看 scope/ACL |

### 注意事项
- Management key 需在 console 授予相应 ACL；与推理 key 完全分开。
- 来源：https://docs.x.ai/developers/rest-api-reference/management ；https://docs.x.ai/developers/rest-api-reference/management/billing ；https://docs.x.ai/console/billing

---

## 6. mistral — yes（推理 key 即可，无需后台 cookie）

**更正**：早期结论写的是 "no / console only"，但有两个已上线实现证明可以用普通推理 key（`MISTRAL_API_KEY`）读官方计费接口：

- Mistral 自己的 Vibe CLI：`mistralai/mistral-vibe`（`vibe/app_server/_billing.py`、`_account.py`）；
- [yetone/magpie](https://github.com/yetone/magpie/blob/main/internal/provider/mistral_plan.go) 的 `internal/provider/mistral_plan.go`（含数据来源与评论区实测记录）。

### 6.1 Budget（月度额度，权威口径）

```
GET https://api.mistral.ai/v1/billing/budget
Authorization: Bearer <MISTRAL_API_KEY>
```

```json
{
  "vibe_budget": {"usage_percentage": 6.02, "initial_budget": 150.0,
                  "currency": "USD", "reset_at": "2026-12-01T00:00:00Z", "payg_enabled": false},
  "api_budget":  {"usage_percentage": 0.0,  "initial_budget": 15.0,
                  "currency": "USD", "reset_at": "2026-12-01T00:00:00Z", "payg_enabled": false},
  "usage_percentage": 0.0, "initial_budget": 15.0, "currency": "USD", "reset_at": "2026-12-01T00:00:00Z"
}
```

要点：

- `usage_percentage` 是**百分比**，已用金额 = `initial_budget × usage_percentage / 100`（不能当金额读）。
- 两个 budget 都是**组织级**的：同一组织的任何 key 读到同一对数值。区别在于 key 花哪个：console 建的 API key（`plan_type: "api"`）花 `api_budget`，Vibe key（`"chat"`）花 `vibe_budget`。
- 套餐没有的额度，该块**缺失**或 `initial_budget: 0`——是「不在该套餐」，不是「0/0 已用尽」。
- 顶层那组扁平字段是 `api_budget` 的副本，不是独立的第三个 budget。
- `reset_at` 为每月 1 日 00:00 UTC，与订阅续费日无关。

### 6.2 Subscription（套餐名）

```
GET https://api.mistral.ai/v1/billing/subscription
→ {"plan_name": "EDU", "payg_enabled": false, "vibe_payg_enabled": false, "enterprise": false}
```

`plan_name` 常见值：`FREE` / `INDIVIDUAL`(Pro) / `EDU`(Student) / `TEAM` / `ENTERPRISE`。

### 6.3 key 类型（可选，需 console 域）

```
GET https://console.mistral.ai/api/vibe/whoami
→ {"plan_type": "CHAT", "plan_name": "EDU", ...}
```

同一个 key 在 `api.mistral.ai` 上取不到 whoami（404），所以想「按 key 类型只显示对应那一个额度」才需要这一步；本插件的适配器选择**同时展示两个额度**，因此只用 6.1 + 6.2，不依赖 console 域。

### 6.4 实测

用 EDU（Student）套餐的推理 key 验证：

```
GET /v1/billing/budget       → 200，vibe_budget 与 api_budget 均有 usage_percentage / initial_budget /
                                currency / reset_at；reset_at 为下月 1 日 00:00 UTC
GET /v1/billing/subscription → 200，plan_name "EDU"，payg_enabled false
GET /v1/billing/budget       带错误 key → 401 {"detail":"Invalid API Key"}
```

未在 IDE/推理以外的套餐上验证；`FREE` 等无额度的账号预期返回空或缺失的 budget 块，适配器把这种情况报为「无生效中的套餐」。

**适配器结论：标记 yes，`kind: mistral`，`view: 'usage'`，两个本月窗口 + 套餐名。**

来源：https://github.com/yetone/magpie/blob/main/internal/provider/mistral_plan.go ；https://github.com/mistralai/mistral-vibe

---

## 适配器落地建议

1. **三类管理凭证分开存**：OpenAI Admin key / Anthropic Admin key（走 `x-api-key` 头）/ xAI Management key（不同 baseURL），均与推理 key 不同，配置 UI 需单独字段+引导文案。
2. **Codex** 只读 `~/.codex/auth.json`，token stale 时不要自行回写，引导用户跑 codex CLI。
3. **Gemini** 返回 `{ supported: false, consoleUrl: ... }`，不要臆造端点（Mistral 已更正为 yes，见第 6 节）。
4. OpenAI `credit_grants` 仅 best-effort，失败静默降级。
5. xAI 余额注意美分单位与负号语义。

---

## 7. volcengine-ark — yes（Agent Plan / Coding Plan，需 IAM AK/SK）

火山方舟**订阅套餐**（Agent Plan / Coding Plan）的额度不在数据面 endpoint 上，而在火山 **OpenTOP 控制面**（`open.volcengineapi.com`，service `ark`，version `2024-01-01`）。两个产品各一个 action：

| product | action | 返回 |
|---|---|---|
| Agent Plan | `GetAFPUsage` | `Result.AFP{FiveHour,Weekly,Monthly}`（绝对值 `Quota`/`Used`，`ResetTime` = epoch **毫秒**） |
| Coding Plan | `GetCodingPlanUsage` | `Result.QuotaUsage[]`（`Level`/`Percent`，`ResetTimestamp` = epoch **秒**） |

### 7.1 请求

```
POST https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01
Content-Type: application/json
X-Date: 20260617T000000Z
X-Content-Sha256: <sha256(body)>
Authorization: HMAC-SHA256 Credential=<AK>/20260617/cn-beijing/ark/request,
               SignedHeaders=host;x-content-sha256;x-date, Signature=<hex>
body: {}
```

签名即火山 V4（同 AWS SigV4）：canonical request = `METHOD\n/path\ncanonicalQuery\ncanonicalHeaders\n\nsignedHeaders\nbodyHash`；stringToSign = `HMAC-SHA256\n<x-date>\n<scope>\nsha256(canonicalRequest)`；签名密钥链 `HMAC(sk → yyyyMMdd → region → service → "request")`。`X-Date` 宽松，但过期会 `InvalidTimestamp`。

### 7.2 返回示例

```json
// GetAFPUsage（Agent Plan "medium" 档）
{ "Result": {
    "PlanType": "medium",
    "AFPFiveHour": { "Quota": 10000,  "Used": 0,     "ResetTime": -1 },
    "AFPWeekly":   { "Quota": 35000,  "Used": 8750,  "ResetTime": 1785686400000 },
    "AFPMonthly":  { "Quota": 100000, "Used": 25000, "ResetTime": 1787846399000 },
    "AFPDaily":    { "Quota": 50000,  "Used": 0,     "ResetTime": 1785340800000 }
} }

// GetCodingPlanUsage（生效中）
{ "Result": {
    "Status": "Running",
    "UpdateTimestamp": 1782226444,
    "QuotaUsage": [
      { "Level": "session", "Percent": 0.116,     "ResetTimestamp": 1782226478 },
      { "Level": "weekly",  "Percent": 3.182143,  "ResetTimestamp": 1782662400 },
      { "Level": "monthly", "Percent": 7.5730535, "ResetTimestamp": 1782403199 }
    ]
} }

// GetCodingPlanUsage（套餐已回收/未订阅：只有 Status，没有 QuotaUsage）
{ "Result": { "Status": "Reclaimed", "UpdateTimestamp": 1785322689 } }
```

### 7.3 注意事项

- **推理 key 查不了额度**。数据面 `/api/plan/v3`、`/api/coding/v3` 的 `Authorization: Bearer <ARK_API_KEY>` 只能调模型；控制面额度接口要 IAM AK/SK 签名。实测（本机 `arkcli usage plan` + 网关直连）：
  - `GetAFPUsage requires Volcengine Ark SSO STS`（仅 API Key 时 arkcli 的报错）；
  - 数据面 `/api/plan/v3/usage`、`/api/coding/v3/usage` 等猜测路径全部 404。
  唯一替代是 SSO 登录态（浏览器流程），不适合插件。
- `-1` / `0` 是"本周期无需重置"的哨兵值，必须当作 **无重置时间**，不能当 epoch 0 渲染成 1970。
- Agent Plan 的 `AFPDaily` 控制台与 arkcli 都不展示，适配器同样跳过。
- `GetAgentPlanAFPUsage` 与 `GetAFPUsage` 在 2024-01-01 下都存在（网关探测 + 社区实现各用一个），返回结构相同；适配器以 `GetAFPUsage` 为主、`InvalidActionOrVersion` 时回退别名。
- 团队版另走 `GetSeatAFPUsage` / `ListSeatAFPUsage` / `GetSeatInfoUsage`（需 SeatID），本插件未适配。
- BytePlus 区域（`ark.ap-southeast.bytepluses.com`）是另一套 OpenAPI 域名，未适配。
- 来源：官方 `@volcengine/openapi`（V4 签名实现）、`volcengine/ark-cli`（`skills/arkcli-usage`）、[CodexBar PR #2496](https://github.com/steipete/CodexBar/pull/2496)（Agent Plan AFP 读取）、[dsh-volcark-quota](https://github.com/ZnonEn/dsh-volcark-quota)（同类 DSH 插件）、网关实测。

---

## 8. deepseek-account — yes（dsh ≥ 0.1.7 内置账号登录，非 API key）

dsh 0.1.7 起 `llm-deepseek` 拆为两条路由：`deepseek-official`（API key，走 `deepseek` 适配器）与 `deepseek-account`（harness 内置浏览器 PKCE 登录，见 `@deepseek-ai/dsh-deepseek-account-platform`）。账号余额查询不走 `/user/balance`（那是 API key 的接口），而是账号平台（platform.deepseek.com）的钱包接口：

```
GET {platformOrigin}/api/v0/users/get_user_summary
x-dsh-auth-token: <存储的账号 grant token>
```

- **grant 存储**：凭据记录 `credentialKey('deepseek-account-platform', 'default')`，payload 为 `{ version: 1, token, issuer }`，`issuer` 即配置的 `platformOrigin`（默认 `https://platform.deepseek.com`），token 只在签发它的 origin 上有效。
- **响应信封**：`{ code: 0, data: { biz_code: 0, biz_data: { normal_wallets: [{currency, balance}], bonus_wallets: [...] } } }`；`normal_wallets` 是充值余额，`bonus_wallets` 是赠送余额，面板合并为 total/granted/toppedUp 展示。
- **金额格式**：平台 Web 端 big.js 语法（允许 `0E-16`、`5.0000000000000000` 等十进制指数形式）。
- **失效判定**：HTTP 401 或顶层 `code: 40003` 表示登录失效，只能重新走浏览器登录（token 不可刷新）。
- **来源**：harness 包 `@deepseek-ai/dsh-deepseek-account-platform`（README 与 lib 实现，0.1.7-rc.2）。

---
