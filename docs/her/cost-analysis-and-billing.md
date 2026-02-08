# Her 费用分析与自动账单架构

> 日期: 2026-02-08
> 触发: 发现单轮飞书对话成本高达 $3.7，调查根因并设计成本监控方案

---

## 1. Claude Opus 定价确认（官方 + OpenRouter）

### Opus 系列价格对比

| 模型 | 发布日期 | Context Window | Input $/M | Output $/M | Cache Read $/M | Cache Write $/M |
|------|----------|---------------|-----------|------------|---------------|----------------|
| Claude Opus 4 | 2025-05-22 | 200K | **$15.00** | **$75.00** | $1.50 | $18.75 |
| Claude Opus 4.5 | 2025-11-24 | 200K | **$5.00** | **$25.00** | $0.50 | $6.25 |
| Claude Opus 4.6 | 2026-02-04 | **1M** | **$5.00** | **$25.00** | $0.50 | $6.25 |

来源:
- https://openrouter.ai/anthropic/claude-opus-4.6 (确认 $5/$25, 1M context)
- https://openrouter.ai/anthropic/claude-opus-4.5 (确认 $5/$25, 200K context)
- https://openrouter.ai/anthropic/claude-opus-4 (确认 $15/$75, 200K context)
- https://platform.claude.com/docs/en/about-claude/pricing

### 优惠机制

- **Prompt caching**: cache read = input 的 1/10（$0.50 vs $5.00），最高节省 **90%**
- **Batch API**: 标准价格的 50% 折扣
- **US-only inference**: 标准价 × 1.1

### 关键发现：Opus 4.6 的 1M Context Window

Opus 4.6 是首个支持 1M context 的 Opus 模型。这直接导致了费用暴涨的根本原因（见第 3 节）。

---

## 2. 当前费用分析

### 数据来源

Session JSONL 文件位于 `~/.openclaw/agents/main/sessions/<sessionId>.jsonl`，每条 assistant 消息包含：

```json
{
  "usage": {
    "input": 296948,
    "output": 81,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 297029,
    "cost": {
      "input": 1.4847,
      "output": 0.002025,
      "cacheRead": 0,
      "cacheWrite": 0,
      "total": 1.4868
    }
  }
}
```

### 全量统计

| 指标 | 数值 |
|------|------|
| 所有 session 总花费 | **$256.45** |
| 有费用的 session 数 | 106 |
| 最贵的单个 session | $144.03 (ad74618b, 飞书 DM 主 session) |
| 第二贵 | $26.37 (d6eaebf2, realtime session) |

### 主 session 详细分析 (ad74618b)

| 指标 | 数值 |
|------|------|
| 持续时间 | 2026-02-05 00:14 → 2026-02-08 00:58 (约 73 小时) |
| 模型 | anthropic/claude-opus-4.6 |
| 用户消息轮数 | 158 |
| API 调用次数 | 570 |
| 总花费 | **$144.03** |
| 平均每轮 | $0.91 |
| 最高上下文 | 297,000 tokens |
| Cache miss 次数 | 327 / 570 (57%) |

### 每日费用分布

| 日期 | 花费 | 最大上下文 | 说明 |
|------|------|-----------|------|
| 2/5 | $1.25 | 51K | 初始阶段，上下文小 |
| 2/6 | **$65.18** | 187K | 大量工具调用（31次/轮），上下文快速膨胀 |
| 2/7 | **$63.76** | 285K | 持续累积 |
| 2/8 | $13.85 | 297K | session 在 01:07 被 daily reset |

### 单轮成本公式

每轮用户消息触发的 API 调用成本：

```
单轮成本 = Σ(每次 API 调用的输入成本)

每次 API 调用输入成本:
  - Cache MISS: context_tokens × $5/M
  - Cache HIT:  new_tokens × $5/M + cached_tokens × $0.50/M
```

以 297K 上下文为例：
- Cache miss: `297K × $5/M = $1.49`
- Cache hit:  `1K × $5/M + 296K × $0.50/M = $0.15`
- 每轮至少 2 次 API 调用（首次必 miss），最低成本: **$1.49 + $0.15 = $1.64**
- 多数轮次 2 次 miss（tool call 返回也改变前缀）: **$1.49 × 2 = $2.97**
- 复杂工具链（12 次调用）: **$4.55**

### 最贵的 10 轮

| 时间 | 花费 | API调用 | 上下文 |
|------|------|---------|--------|
| 2/8 00:36 | $4.55 | 12 | 294K |
| 2/7 14:31 | $3.10 | 4 | 281K |
| 2/6 08:01 | $3.10 | 31 | 183K |
| 2/7 02:19 | $3.05 | 11 | 208K |
| 2/7 13:39 | $3.03 | 4 | 275K |
| 2/8 00:57 | $2.97 | 2 | 297K |
| 2/8 00:52 | $2.97 | 2 | 296K |
| 2/8 00:26 | $2.86 | 2 | 286K |
| 2/7 03:36 | $2.79 | 5 | 246K |
| 2/7 05:19 | $2.77 | 3 | 263K |

---

## 3. 为什么没有触发 Compaction

### Compaction 触发条件

Auto-compaction 在以下条件触发（由 Pi runtime 决定）：

```
contextTokens > contextWindow - reserveTokens
```

### 当前参数

| 参数 | 值 | 来源 |
|------|-----|------|
| contextWindow | **1,000,000** | Opus 4.6 模型目录（OpenRouter 返回） |
| reserveTokens | 20,000 | `DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR` |
| **compaction 阈值** | **980,000** | 1M - 20K |
| 当前 contextTokens | 297,000 | session 实际累计 |

### 根本原因

**297K << 980K，compaction 完全不会触发。**

Opus 4.6 的 1M context window 是 Opus 4.5 的 **5 倍**（200K → 1M）。OpenClaw 的 compaction 阈值随 context window 线性扩大，导致：

- Opus 4.5 (200K window): 在 ~180K tokens 时触发 compaction ✓
- **Opus 4.6 (1M window): 要到 ~980K tokens 才触发 compaction** ← 永远不会到

以正常对话速度，session 在 daily reset (默认 4:00 AM) 之前根本不可能到 980K tokens。但在到达之前，上下文已经足够大到让每轮成本高达 $3-5。

### Context Window 解析优先级

```
resolveContextWindowInfo() 优先级:
1. config: models.providers.<provider>.models[].contextWindow  (modelsConfig)
2. model catalog: model.contextWindow                         (model - OpenRouter 返回 1M)
3. 硬编码默认: DEFAULT_CONTEXT_TOKENS = 200,000              (default)
```

当前使用的是优先级 2（OpenRouter 返回的 1M），没有任何 config 覆盖。

### Daily Reset 的缓解

好消息是 daily reset (默认 4:00 AM) 确实在 02-08 01:07 触发了 session 重置：
- 旧 session `ad74618b`: 297K tokens, $144.03
- 新 session `94337d6e`: ~18K tokens, ~$0.09/call (已回归正常)

但 daily reset 只是打断了"失控"的 session，不是根本解决方案。一天之内 session 仍然可以膨胀到 200K+ tokens（如 2/6 当天从 51K 涨到 187K，花费 $65）。

---

## 4. Context 管理优化建议

### 立刻可做（配置层）

#### 方案 A: 限制 context window 上限

在 OpenClaw config 中设置 `agents.defaults.contextTokens`，强制把有效 context window 从 1M 压到合理值：

```json
{
  "agents": {
    "defaults": {
      "contextTokens": 128000
    }
  }
}
```

这样 compaction 阈值变为 `128K - 20K = 108K`，超过 108K 就自动压缩。

**推荐值**: 128K（平衡上下文长度和成本）
- 每次 cache miss: `128K × $5/M = $0.64`（vs 当前 $1.49）
- 每轮预估: $0.64 × 2 = $1.28（vs 当前 $2.97）
- **成本降低约 57%**

#### 方案 B: 提高 reserveTokens

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "reserveTokensFloor": 100000
      }
    }
  }
}
```

阈值变为 `1M - 100K = 900K`，改善有限。不推荐。

#### 方案 C: 缩短 idle reset

```json
{
  "session": {
    "reset": {
      "idleMinutes": 60
    }
  }
}
```

1 小时无消息自动重置 session，限制上下文累积。

#### 推荐组合

```json
{
  "agents": {
    "defaults": {
      "contextTokens": 128000
    }
  },
  "session": {
    "reset": {
      "idleMinutes": 120
    }
  }
}
```

### 中期（模型降级策略）

| 场景 | 推荐模型 | 成本 |
|------|---------|------|
| 日常闲聊、简单问答 | Sonnet 4.5 ($3/M) | 当前的 60% |
| 工具密集型任务 | Opus 4.6 ($5/M) | 当前 100% |
| 快速回复、状态查询 | Haiku 4.5 ($1/M) | 当前的 20% |

考虑在 Her prompt 中增加 "评估复杂度，必要时切换到更便宜的模型" 逻辑，或在 config 中为不同 session 指定不同模型。

### 手动压缩

在飞书或任何 channel 中发送 `/compact` 可手动触发 compaction。

---

## 5. 自动账单模块架构设计

### 目标

让 Her 每天自动推送费用报告给用户，包括：
- 当日总花费
- 每个 channel 的花费
- 上下文大小趋势
- 异常告警（单轮超过阈值）

### 数据源

费用数据已经完整记录在 session JSONL 中，每条 assistant 消息的 `usage.cost` 字段包含：
- `input`: 输入 token 费用
- `output`: 输出 token 费用
- `cacheRead`: 缓存读取费用
- `cacheWrite`: 缓存写入费用
- `total`: 本次 API 调用总费用

### 架构方案

```
┌──────────────────────────────────────────────────────────┐
│                   Cost Tracker Module                     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │ Cost        │   │ Cost         │   │ Cost         │  │
│  │ Collector   │──>│ Aggregator   │──>│ Reporter     │  │
│  │ (runtime)   │   │ (cron)       │   │ (delivery)   │  │
│  └─────────────┘   └──────────────┘   └──────────────┘  │
│        │                  │                  │            │
│        ▼                  ▼                  ▼            │
│  session JSONL      daily-cost.json    飞书/Telegram     │
│  (已有数据)         (汇总缓存)          推送消息         │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 组件设计

#### 1. Cost Collector（数据采集）

**成本: 极低 — 数据已经存在**

不需要额外采集。所有费用数据已记录在 session JSONL 的 `usage.cost` 中。只需读取和解析。

实现方式:
- **方案 A (离线扫描)**: cron job 定时扫描所有 session JSONL → 汇总 → 写入 `daily-cost.json`
- **方案 B (实时钩子)**: 在 Pi runner 返回 usage 时 emit 事件 → 实时累加到内存计数器 → 定期落盘

推荐方案 A（简单、可靠、不侵入核心逻辑）。

#### 2. Cost Aggregator（汇总引擎）

输入: session JSONL 文件
输出: 结构化的费用汇总

```typescript
interface DailyCostReport {
  date: string;                          // "2026-02-08"
  totalCost: number;                     // 总花费 ($)
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  cacheHitRate: number;                  // 0-1
  apiCalls: number;
  userTurns: number;
  avgCostPerTurn: number;
  maxCostTurn: number;                   // 最贵单轮
  maxContextTokens: number;              // 最大上下文
  bySession: Record<string, {           // 按 session 分
    sessionKey: string;
    cost: number;
    turns: number;
    maxContext: number;
  }>;
  byModel: Record<string, {             // 按模型分
    cost: number;
    calls: number;
  }>;
}
```

实现复杂度: **~200 行 TypeScript**（解析 JSONL + 分组汇总）。
核心逻辑就是本次分析中使用的 Python 脚本的 TS 版本。

#### 3. Cost Reporter（报告推送）

两种推送方式:

**A. Cron Job 推送（推荐）**

利用 OpenClaw 已有的 cron 机制:

```yaml
# 在 cron 配置中添加
- id: daily-cost-report
  schedule: "0 9 * * *"        # 每天早上 9 点
  channel: feishu               # 推送到飞书
  message: "生成今天的费用报告"
```

Her 收到 cron 消息后，使用 `exec` 工具运行 cost aggregator 脚本，然后格式化输出。

**B. Heartbeat 集成**

在 heartbeat 中增加费用摘要字段，Her 在每日 heartbeat 中自动包含费用信息。

#### 4. 异常告警

在 Cost Aggregator 中加入阈值检查:

```typescript
interface CostAlert {
  type: "high_turn_cost" | "high_daily_cost" | "context_growing" | "cache_miss_spike";
  message: string;
  severity: "warning" | "critical";
  value: number;
  threshold: number;
}
```

默认阈值:
- 单轮 > $1.00 → warning
- 单轮 > $3.00 → critical
- 日花费 > $20 → warning
- 日花费 > $50 → critical
- 上下文 > 100K tokens → warning
- Cache miss rate > 70% → warning

### 实现优先级

| 阶段 | 内容 | 工作量 |
|------|------|--------|
| **P0** | CLI 命令 `openclaw cost` — 读取 JSONL 输出费用汇总 | 半天 |
| **P1** | Cron job + Her 自动推送日报 | 1 天 |
| **P2** | 异常告警（超过阈值时实时通知） | 半天 |
| **P3** | Web UI 仪表盘（费用趋势图、按 channel 分） | 2-3 天 |

### 数据精度说明

- OpenRouter 返回的 `cost` 字段是**基于其定价表的估算值**
- 实际账单可能因 provider fallback、区域定价等略有差异
- 本方案的数据精度约 95-99%，可作为成本监控和趋势分析的可靠依据
- 精确账单仍需以 OpenRouter dashboard 为准

---

## 6. 统计方法说明

### 本次分析使用的统计方法

以下是本次调查中实际使用的数据提取方法，可直接复用为 Cost Aggregator 的核心逻辑：

**1. 读取 session JSONL**

每行是一个 JSON 对象，assistant 消息包含 `message.usage.cost` 字段。

**2. 按 user turn 分组**

遇到 `role: "user"` 的消息标记为新的一轮，后续所有 assistant 消息的 cost 累加到这一轮。

**3. Cache 分析**

通过 `usage.cacheRead` 字段判断：
- `cacheRead > 0` → cache hit（便宜）
- `cacheRead == 0 && input > 10K` → cache miss（昂贵）

**4. 上下文大小**

`usage.input + usage.cacheRead` = 本次调用的完整上下文大小。

**5. 时间维度**

`timestamp` 字段用于按日/小时分组。

---

## 7. 总结

| 问题 | 根因 | 解决方案 |
|------|------|---------|
| 单轮 $3.7 | 297K 上下文 × Opus $5/M × 2 次 cache miss | 限制 contextTokens 到 128K |
| Compaction 不触发 | 1M context window → 阈值 980K → 永远不到 | 配置 `agents.defaults.contextTokens: 128000` |
| 日花费 $65+ | Session 跨天累积无限制 | idle reset + context 上限 |
| 无费用可见性 | 数据存在但没有展示 | 实现 Cost Tracker 模块 |
