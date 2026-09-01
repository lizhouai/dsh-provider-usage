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
| mistral | no | — | 无，console only |

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

## 6. mistral — no

无任何公开余额/用量查询接口。官方文档无 billing API；开源工具 check_balance 明确标注 "⚠️ Console only / 未开放余额查询 API"，控制台 https://console.mistral.ai/usage 。429 是唯一程序化信号。

**适配器结论：标记 no，UI 给 console 链接。**

来源：https://github.com/hanmumuHL/check_balance ；https://theneuralbase.com/mistral-api/learn/advanced/la-plateforme-dashboard-overview/

---

## 适配器落地建议

1. **三类管理凭证分开存**：OpenAI Admin key / Anthropic Admin key（走 `x-api-key` 头）/ xAI Management key（不同 baseURL），均与推理 key 不同，配置 UI 需单独字段+引导文案。
2. **Codex** 只读 `~/.codex/auth.json`，token stale 时不要自行回写，引导用户跑 codex CLI。
3. **Gemini / Mistral** 返回 `{ supported: false, consoleUrl: ... }`，不要臆造端点。
4. OpenAI `credit_grants` 仅 best-effort，失败静默降级。
5. xAI 余额注意美分单位与负号语义。
