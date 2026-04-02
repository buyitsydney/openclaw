# Anthropic Claude Max 企业级用量管理方案

> 状态：设计草案 v1 · 2026-02-19
>
> 基于实际 API 响应头测试验证，非猜测。

---

## 1. 背景与发现

### 1.1 Claude Max 订阅模型

Anthropic 提供 Claude Max 个人订阅，分为两档：

| 套餐    | 价格    | 用量倍率     | 5h 滚动窗口 | 7d 滚动窗口 |
| ------- | ------- | ------------ | ----------- | ----------- |
| Max 5x  | $100/月 | Pro 的 5 倍  | 有限制      | 有限制      |
| Max 20x | $200/月 | Pro 的 20 倍 | ~900 msg/5h | 周配额      |

每个 Max 订阅绑定一个 OAuth token（`sk-ant-oat01-...`），通过 `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` 调用 API。

### 1.2 关键发现：API 响应头包含完整用量信息

2026-02-19 实测发现，使用 OAuth token 调用 Anthropic Messages API 时，**每个响应**都携带以下 rate limit 头：

```
anthropic-ratelimit-unified-status: allowed
anthropic-ratelimit-unified-5h-status: allowed
anthropic-ratelimit-unified-5h-reset: 1771470000
anthropic-ratelimit-unified-5h-utilization: 0.07
anthropic-ratelimit-unified-7d-status: allowed
anthropic-ratelimit-unified-7d-reset: 1771984800
anthropic-ratelimit-unified-7d-utilization: 0.07
anthropic-ratelimit-unified-7d_sonnet-status: allowed
anthropic-ratelimit-unified-7d_sonnet-reset: 1772067600
anthropic-ratelimit-unified-7d_sonnet-utilization: 0.0
anthropic-ratelimit-unified-representative-claim: five_hour
anthropic-ratelimit-unified-fallback-percentage: 0.5
anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled
anthropic-ratelimit-unified-overage-status: rejected
```

**字段解读：**

| 头字段                  | 含义                                               |
| ----------------------- | -------------------------------------------------- |
| `unified-status`        | 当前请求是否被允许 (`allowed` / `limited`)         |
| `5h-utilization`        | 5 小时滚动窗口已用百分比 (0.0–1.0)                 |
| `5h-reset`              | 5h 窗口下次重置的 Unix 时间戳                      |
| `7d-utilization`        | 7 天滚动窗口已用百分比                             |
| `7d-reset`              | 7d 窗口下次重置的 Unix 时间戳                      |
| `7d_sonnet-utilization` | Sonnet 模型 7 天专属配额已用百分比                 |
| `representative-claim`  | 当前生效的主要限制维度 (`five_hour` / `seven_day`) |
| `fallback-percentage`   | 达到此百分比后可能降级（排队/限速）                |
| `overage-status`        | 超量请求是否被接受                                 |

### 1.3 限制特性

- **无官方公开 API** 直接查询 Max 用量 — 但每次 API 调用的响应头自带，零额外成本
- **OAuth token 是个人绑定** — 不能多人共享一个 Max 订阅，但可以做 Token Pool
- **`fallback-percentage: 0.5`** — utilization 达到 50% 后进入降级区，请求可能变慢或排队
- **`overage-disabled`** — Max 订阅不支持超量付费，到顶就停

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    企业飞书界面                            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │
│  │ 员工 A   │ │ 员工 B   │ │ 员工 C   │ │ 管理员   │        │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘        │
│       │           │           │           │              │
└───────┼───────────┼───────────┼───────────┼──────────────┘
        │           │           │           │
        ▼           ▼           ▼           ▼
┌──────────────────────────────────────────────────────────┐
│              OpenClaw Gateway (per-user Docker)           │
│                                                          │
│  ┌──────────────────────────────────────────────┐        │
│  │           Token Pool Manager                  │        │
│  │                                              │        │
│  │  Token A ── utilization: 0.07 ── allowed     │        │
│  │  Token B ── utilization: 0.45 ── allowed     │        │
│  │  Token C ── utilization: 0.92 ── WARNING     │        │
│  │  Token D ── utilization: 1.00 ── BLOCKED     │        │
│  │                                              │        │
│  │  ┌─────────────────────────────────┐         │        │
│  │  │  Smart Router: 选择最优 token   │         │        │
│  │  │  • 最低 utilization 优先       │         │        │
│  │  │  • 避开 ≥fallback 的 token     │         │        │
│  │  │  • blocked token 自动跳过      │         │        │
│  │  └─────────────────────────────────┘         │        │
│  └──────────────────────────────────────────────┘        │
│                          │                                │
│  ┌──────────────────────────────────────────────┐        │
│  │         Usage Tracker (per response)          │        │
│  │  • 提取 rate limit headers                   │        │
│  │  • 更新 token 状态                           │        │
│  │  • 写入 usage.jsonl 日志                     │        │
│  │  • 触发告警检查                              │        │
│  └──────────────────────────────────────────────┘        │
│                          │                                │
│  ┌──────────────────────────────────────────────┐        │
│  │             Alert Engine                      │        │
│  │  • 飞书消息：通知当前用户                     │        │
│  │  • 飞书消息：通知管理员                       │        │
│  │  • 大面积限流 → 紧急事故告警                  │        │
│  └──────────────────────────────────────────────┘        │
│                                                          │
└──────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│           Anthropic Messages API                         │
│           (响应头自带 rate limit 信息)                     │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Token Pool（账号池）设计

### 3.1 核心概念

企业购买 N 个 Claude Max 订阅，每个生成一个 OAuth token。所有 token 汇入一个**中央池**，由系统根据实时 utilization 自动分配。

**优势：**

- 员工 A 高峰期用完额度时，自动切换到员工 B 闲置的 token
- N 个 Max 20x 订阅 = 总容量 N×20x，峰值能力远超单人
- 没有人因为个人 token 触顶而完全不可用

### 3.2 配置格式

在 `openclaw.json` 或 `carher-config.json` 中新增 `tokenPool` 配置：

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "https://api.anthropic.com",
        "tokenPool": {
          "enabled": true,
          "strategy": "lowest-utilization",
          "fallbackThreshold": 0.5,
          "blockThreshold": 0.95,
          "tokens": [
            {
              "id": "cto",
              "label": "CTO 的 Max 订阅",
              "oauthToken": "${ANTHROPIC_TOKEN_CTO}",
              "tier": "max-20x"
            },
            {
              "id": "ceo",
              "label": "董事长 Max 订阅",
              "oauthToken": "${ANTHROPIC_TOKEN_CEO}",
              "tier": "max-20x"
            },
            {
              "id": "dev1",
              "label": "开发1 Max 订阅",
              "oauthToken": "${ANTHROPIC_TOKEN_DEV1}",
              "tier": "max-20x"
            },
            {
              "id": "shared",
              "label": "公共备用 Max 订阅",
              "oauthToken": "${ANTHROPIC_TOKEN_SHARED}",
              "tier": "max-20x"
            }
          ]
        },
        "models": [
          {
            "id": "claude-opus-4-6",
            "name": "Claude Opus 4.6",
            "api": "anthropic-messages",
            "reasoning": true,
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 128000
          }
        ]
      }
    }
  }
}
```

### 3.3 路由策略

```
                    ┌─────────────────────┐
                    │   新 API 请求到达     │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  按 5h-utilization   │
                    │  从低到高排序所有 token│
                    └─────────┬───────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
     ┌────────▼──────┐ ┌────▼──────┐ ┌──────▼──────┐
     │ util < 50%    │ │ 50%~95%   │ │ util ≥ 95%  │
     │ ✅ 最优选择   │ │ ⚠️ 降级区  │ │ 🚫 blocked  │
     └───────────────┘ └───────────┘ └─────────────┘
              │               │               │
              │        使用但告警       跳过，选下一个
              │               │               │
              ▼               ▼               │
     ┌─────────────────────────────┐         │
     │  选中 utilization 最低的     │         │
     │  未 blocked token           │◄────────┘
     └─────────────────────────────┘   全部 blocked
              │                               │
              ▼                               ▼
     正常发送请求                    返回限流错误 + 预估恢复时间
```

**策略优先级：**

1. **`lowest-utilization`**（默认）：选 5h-utilization 最低的 token
2. **`round-robin`**：轮询，适合均匀分散用量
3. **`sticky`**：每个用户绑定一个 primary token，仅在触顶时 failover

### 3.4 Token 状态机

```
    ┌──────────┐   util < fallback   ┌──────────┐
    │  ACTIVE  │◄───────────────────│ DEGRADED │
    │  (正常)   │───────────────────►│  (降级)   │
    └──────────┘  util ≥ fallback    └──────────┘
         │                                │
         │   util ≥ block                 │  util ≥ block
         │                                │
         ▼                                ▼
    ┌──────────────────────────────────────────┐
    │                BLOCKED (限流)              │
    │  等待 reset 时间戳                        │
    │  到达后自动恢复为 ACTIVE                   │
    └──────────────────────────────────────────┘
```

---

## 4. Usage Tracker（用量追踪器）

### 4.1 数据采集点

**在 Anthropic HTTP 响应处理层**，每次 API 调用后提取 headers：

```typescript
interface RateLimitSnapshot {
  tokenId: string;
  timestamp: number;

  // 5 小时滚动窗口
  fiveHour: {
    status: "allowed" | "limited";
    utilization: number; // 0.0 ~ 1.0
    resetAt: number; // Unix timestamp
  };

  // 7 天滚动窗口
  sevenDay: {
    status: "allowed" | "limited";
    utilization: number;
    resetAt: number;
  };

  // Sonnet 专属 7 天配额（如果响应头中存在）
  sevenDaySonnet?: {
    status: "allowed" | "limited";
    utilization: number;
    resetAt: number;
  };

  // 元信息
  representativeClaim: string; // "five_hour" | "seven_day"
  fallbackPercentage: number; // 通常 0.5
  overageStatus: string; // "allowed" | "rejected"
}
```

### 4.2 存储设计

**实时状态**（内存 + 持久化）：

```
~/.openclaw/token-pool/
├── state.json          # 当前所有 token 的最新 snapshot
├── usage.jsonl         # 追加写入的时间序列日志
└── alerts.jsonl        # 告警事件日志
```

`state.json` 示例：

```json
{
  "updatedAt": 1771470000,
  "tokens": {
    "cto": {
      "status": "active",
      "fiveHour": { "utilization": 0.07, "resetAt": 1771470000 },
      "sevenDay": { "utilization": 0.07, "resetAt": 1771984800 },
      "lastUsedAt": 1771466400,
      "requestCount": 42,
      "totalInputTokens": 150000,
      "totalOutputTokens": 85000
    },
    "ceo": {
      "status": "degraded",
      "fiveHour": { "utilization": 0.52, "resetAt": 1771470000 },
      "sevenDay": { "utilization": 0.35, "resetAt": 1771984800 },
      "lastUsedAt": 1771466500,
      "requestCount": 218,
      "totalInputTokens": 2800000,
      "totalOutputTokens": 1200000
    }
  }
}
```

`usage.jsonl` — 每次 API 调用追加一行：

```jsonl
{"ts":1771466400,"tokenId":"cto","model":"claude-opus-4-6","inputTokens":5200,"outputTokens":3100,"5h_util":0.07,"7d_util":0.07,"userId":"user-1","sessionKey":"main"}
{"ts":1771466500,"tokenId":"ceo","model":"claude-opus-4-6","inputTokens":12000,"outputTokens":8500,"5h_util":0.52,"7d_util":0.35,"userId":"user-3","sessionKey":"main"}
```

### 4.3 月度统计报告

每月 1 号自动生成上月报告，存储在 `~/.openclaw/token-pool/reports/YYYY-MM.json`：

```json
{
  "period": "2026-02",
  "generatedAt": "2026-03-01T00:00:00Z",
  "summary": {
    "totalRequests": 8420,
    "totalInputTokens": 45000000,
    "totalOutputTokens": 28000000,
    "estimatedCost": "$525.00",
    "peakConcurrentUsers": 4,
    "throttleEvents": 12,
    "throttleDays": ["2026-02-05", "2026-02-12", "2026-02-18"]
  },
  "perUser": [
    {
      "userId": "user-1",
      "name": "测试用户",
      "requests": 3200,
      "inputTokens": 18000000,
      "outputTokens": 12000000,
      "estimatedCost": "$210.00",
      "avgDailyRequests": 114,
      "peakDailyRequests": 280,
      "throttleEvents": 3,
      "throttleDates": ["2026-02-12"],
      "peak5hUtilization": 0.78,
      "peak7dUtilization": 0.45
    }
  ],
  "perToken": [
    {
      "tokenId": "cto",
      "label": "CTO 的 Max 订阅",
      "totalRequests": 2800,
      "peak5hUtilization": 0.65,
      "peak7dUtilization": 0.42,
      "throttleCount": 2,
      "availability": 0.98
    }
  ]
}
```

---

## 5. 告警系统设计

### 5.1 告警级别与触发条件

| 级别         | 触发条件                                        | 通知对象                | 通知方式              |
| ------------ | ----------------------------------------------- | ----------------------- | --------------------- |
| **INFO**     | 任一 token 5h-util ≥ 30%                        | 仅记录日志              | 写入 alerts.jsonl     |
| **WARNING**  | 任一 token 5h-util ≥ `fallbackPercentage` (50%) | 当前使用该 token 的用户 | 飞书卡片消息          |
| **CRITICAL** | 任一 token 5h-util ≥ 90% 或 status=limited      | 用户 + 管理员           | 飞书紧急卡片          |
| **INCIDENT** | ≥50% 的 token 同时 blocked                      | 所有管理员              | 飞书紧急群消息 + @all |

### 5.2 用户侧告警：飞书卡片

当用户的请求触发限流时，在飞书对话中发送卡片：

**WARNING 卡片（即将限流）：**

```
⚠️ AI 用量提醒

当前 5 小时用量已达 52%，接近限制。
• 7 天用量：35%
• 预计恢复：今天 19:00
• 当前模型：Claude Opus 4.6

建议：降低对话频率，或等待窗口重置。
系统已自动切换到备用额度。
```

**CRITICAL 卡片（已限流）：**

```
🚫 AI 暂时不可用

当前额度已用完，正在等待恢复。
• 5h 用量：98% → 等待重置
• 预计恢复时间：2026-02-19 19:00（约 2 小时 15 分）
• 7 天用量：67%

当前所有备用额度也已用尽。
请稍后再试，或联系管理员。
```

**限流恢复通知：**

```
✅ AI 已恢复

额度已重置，可以正常使用了。
• 当前 5h 用量：3%
• 7 天剩余：33%
```

### 5.3 管理员告警

**单人限流通知（发送到管理员飞书群或私聊）：**

```
⚠️ [用量告警] 员工限流

用户：张三（user-1）
Token：CTO 的 Max 订阅
5h 用量：92% → 已触发限流
7d 用量：67%
预计恢复：2026-02-19 19:00
Token Pool 状态：3/4 可用
```

**事故告警（≥50% token blocked）：**

```
🔴 [紧急事故] 大面积 AI 限流

当前 Token Pool 状态：
• CTO ── 🚫 BLOCKED (98%) ── 恢复 19:00
• 董事长 ── 🚫 BLOCKED (95%) ── 恢复 20:30
• 开发1 ── ⚠️ DEGRADED (62%)
• 公共备用 ── ✅ ACTIVE (15%)

影响范围：2/4 token 不可用
受影响用户：张三、李四
建议操作：
1. 降低非紧急 AI 对话频率
2. 考虑增购 Max 订阅扩容 Pool
```

### 5.4 告警防抖

- 同一级别、同一 token 的告警，**5 分钟内不重复发送**
- 级别升级（WARNING → CRITICAL）**立即发送**
- 恢复通知（CRITICAL → 正常）**立即发送**
- 管理员事故告警 **每 15 分钟更新一次状态**，直到解除

---

## 6. 飞书集成细节

### 6.1 卡片状态栏扩展

在现有的 `buildCardStatusFooter` 基础上，增加 token pool 用量信息：

**当前 footer 格式：**

```
🧠 Opus 4.6 · 📊 42k/200k (21%) · 🧹 0次压缩
```

**扩展后 footer 格式：**

```
🧠 Opus 4.6 · 📊 42k/200k (21%) · 🧹 0 次压缩 · 💳 5h:7% 7d:7%
```

- `💳 5h:7%` — 5 小时窗口 utilization
- `7d:7%` — 7 天窗口 utilization
- 当 util > 50% 时变色：`⚠️ 5h:52%`
- 当 util > 90% 时变色：`🚫 5h:92%`

### 6.2 /quota 命令

新增飞书命令，让用户主动查询用量：

```
/quota

📊 AI 用量报告

Token Pool 总览：
┌──────────┬───────┬───────┬────────┐
│ Token    │ 5h    │ 7d    │ 状态   │
├──────────┼───────┼───────┼────────┤
│ CTO      │ 7%    │ 7%    │ ✅ 正常 │
│ 董事长    │ 52%   │ 35%   │ ⚠️ 注意 │
│ 开发1    │ 12%   │ 8%    │ ✅ 正常 │
│ 公共备用  │ 0%    │ 0%    │ ✅ 正常 │
└──────────┴───────┴───────┴────────┘

你的今日用量：
• 请求次数：42 次
• Token 消耗：~150K input / ~85K output
• 使用 Token：CTO（主）→ 董事长（1 次 failover）

预估安全度：
• 5h 窗口：充裕 ✅
• 7d 窗口：充裕 ✅（按当前速率，本周不会触顶）
```

### 6.3 管理员 /pool 命令

管理员专属命令，查看和管理 Token Pool：

```
/pool status    — 查看所有 token 状态
/pool report    — 生成当月用量报告
/pool add       — 添加新 token（按提示操作）
/pool rotate    — 强制刷新指定 token
```

---

## 7. Token Pool vs 一人一号

### 7.1 方案对比

| 维度       | 一人一号                       | Token Pool                |
| ---------- | ------------------------------ | ------------------------- |
| 配置复杂度 | 低 — 每人一个 token            | 中 — 需要 pool 管理层     |
| 容错能力   | 无 — 个人额度用完就停          | 高 — 自动 failover        |
| 峰值处理   | 差 — 受个人上限约束            | 优 — 多人错峰互补         |
| 成本效率   | 可能浪费（低活跃用户额度闲置） | 高 — 闲置额度自动分配     |
| 审计追踪   | 简单 — token ↔ 人              | 需要额外记录 token 使用者 |
| 实现难度   | 已具备（当前架构）             | 需开发 Pool Manager       |
| 合规风险   | 无                             | 低 — token 仍属于实名订阅 |

### 7.2 建议方案

**推荐：Token Pool + 个人 Primary Token**

- 每人购买自己的 Max 订阅，获得 primary token
- 所有 token 汇入 Pool
- 默认使用自己的 primary token（审计清晰）
- 当 primary 接近限流时，自动 failover 到 Pool 中最空闲的 token
- 相当于 **N 个保险互保** — 单人高峰不影响使用

### 7.3 成本分析

以 4 人团队、每人 Max 20x ($200/月) 为例：

```
月成本：4 × $200 = $800/月

相比 API 付费（按量计费）:
• Opus 4.6: $5/M input + $25/M output
• 假设每人每月 ~30M input + 15M output
• API 成本: 4 × ($150 + $375) = $2,100/月

Max 订阅节省: $2,100 - $800 = $1,300/月 (62% 节省)
```

> **前提**：使用量足够大时 Max 订阅远比按量计费划算。
> 但 Max 订阅的代价是有**频率限制**（5h/7d 窗口），Token Pool 就是对冲这个风险的方案。

---

## 8. 实现计划

### Phase 1：基础监控（1-2 天）

**目标**：提取 rate limit headers，展示到飞书卡片

- [ ] 在 Anthropic HTTP 响应处理层提取 `anthropic-ratelimit-unified-*` headers
- [ ] 存储最新 snapshot 到 `state.json`
- [ ] 扩展 `buildCardStatusFooter` 展示 `5h:xx% 7d:xx%`
- [ ] 追加写入 `usage.jsonl` 时间序列

**改动文件**：

- `extensions/feishu-her/src/gateway.ts` — footer 展示
- 新文件：`extensions/feishu-her/src/usage-tracker.ts` — headers 提取与存储

### Phase 2：告警系统（2-3 天）

**目标**：限流时自动通知用户和管理员

- [ ] 实现告警引擎（级别判定、防抖）
- [ ] 用户侧飞书卡片告警（WARNING / CRITICAL / 恢复）
- [ ] 管理员飞书通知（单人限流 / 事故告警）
- [ ] `/quota` 命令

**改动文件**：

- 新文件：`extensions/feishu-her/src/alert-engine.ts`
- `extensions/feishu-her/src/gateway.ts` — /quota 命令处理

### Phase 3：Token Pool（3-5 天）

**目标**：多 token 智能路由，自动 failover

- [ ] Token Pool 配置解析
- [ ] 路由策略实现（lowest-utilization / round-robin / sticky）
- [ ] API 请求拦截层 — 注入选中的 token
- [ ] Failover 逻辑 — 429 错误自动重试下一个 token
- [ ] `/pool` 管理员命令

**改动文件**：

- 新文件：`extensions/feishu-her/src/token-pool.ts`
- 配置 schema 扩展

### Phase 4：报表与运维（2-3 天）

**目标**：月度报表、长期趋势

- [ ] 月度报告自动生成
- [ ] 日/周趋势分析
- [ ] Token 健康度评分
- [ ] 容量规划建议（是否需要增购 Max 订阅）

---

## 9. Token 安全与合规

### 9.1 Token 存储

- OAuth token 通过环境变量注入（`${ANTHROPIC_TOKEN_xxx}`），不写入配置文件
- Docker 容器通过 `start-user.sh` 传入环境变量
- Token 文件权限 `600`，仅 owner 可读

### 9.2 Token 刷新

- Claude Max OAuth token 有效期不确定，可能随时失效
- Usage Tracker 检测到 401 响应时：
  1. 标记 token 为 `EXPIRED`
  2. 通知管理员刷新 token
  3. Pool 自动绕过该 token

### 9.3 审计日志

- 每次 API 调用记录：`userId`, `tokenId`, `model`, `timestamp`, `inputTokens`, `outputTokens`
- 月度报告包含 per-user 和 per-token 明细
- 日志保留 90 天，可配置

---

## 10. 风险与缓解

| 风险                              | 概率 | 影响         | 缓解措施                                      |
| --------------------------------- | ---- | ------------ | --------------------------------------------- |
| Anthropic 移除 rate limit headers | 低   | 失去实时监控 | 降级为本地 token 计数估算                     |
| OAuth token 批量过期              | 中   | 全部不可用   | 管理员告警 + token 自动健康检查               |
| Anthropic TOS 禁止 token 共享     | 低   | 需停用 Pool  | 每个 token 仍属于实名订阅，不违反个人使用条款 |
| 大面积限流（团队同时高峰）        | 中   | 降低效率     | 增购 Max 订阅扩容 Pool + 错峰提醒             |
| 5h 窗口过小导致频繁触顶           | 中   | 用户体验差   | Token Pool 互补 + 降级到 Sonnet 4 省额度      |
| 月报数据量过大                    | 低   | 存储压力     | 日志按月轮转 + 压缩归档                       |

---

## 11. 未来扩展

1. **模型降级策略**：5h 接近限额时自动从 Opus 切换到 Sonnet（Sonnet 有独立 7d 配额）
2. **预测引擎**：基于历史用量模式预测本周是否会触顶，提前预警
3. **API Key 混合模式**：Pool 中同时支持 OAuth token 和 API Key，互为备份
4. **Web Dashboard**：独立的用量监控页面，展示实时仪表盘和趋势图
5. **Slack/Telegram 告警**：除飞书外支持其他渠道的告警推送
6. **自动扩容**：当 Pool 容量不足时，自动开通新的 Max 订阅（需 Anthropic 支持 API 购买）
