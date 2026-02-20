# 记忆/搜索 架构设计

## 参考文档索引

### 官方文档（在线）

- [Memory - OpenClaw](https://docs.openclaw.ai/concepts/memory) — 记忆系统完整文档
- [memory CLI](https://docs.openclaw.ai/cli/memory) — CLI 管理命令
- [Memory Configuration (DeepWiki)](https://deepwiki.com/openclaw/openclaw/7.1-memory-configuration) — 配置参考

### 本地文档

- `docs/concepts/memory.md` — 记忆系统主文档（本文的主要源）
- `docs/experiments/research/memory.md` — 离线记忆架构研究笔记（Workspace Memory v2）
- `docs/concepts/agent-workspace.md` — workspace 布局（记忆文件位置）
- `docs/concepts/system-prompt.md` — system prompt 如何注入记忆
- `docs/concepts/context.md` — 记忆 vs 上下文的区别
- `docs/gateway/configuration-reference.md` — memory flush 配置

### 本地代码（src/memory/）

- `src/memory/manager.ts` — MemoryIndexManager 主类
- `src/memory/manager-search.ts` — 向量搜索 + 关键词搜索实现
- `src/memory/hybrid.ts` — 混合搜索合并逻辑
- `src/memory/temporal-decay.ts` — 时间衰减评分
- `src/memory/mmr.ts` — MMR 去重排序
- `src/memory/embeddings.ts` — embedding provider 接口
- `src/memory/embeddings-openai.ts` / `embeddings-gemini.ts` / `embeddings-voyage.ts` — 远程 embedding
- `src/memory/qmd-manager.ts` — QMD 后端实现
- `src/memory/backend-config.ts` — 后端选择与配置解析
- `src/agents/tools/memory-tool.ts` — `memory_search` 和 `memory_get` 工具定义
- `src/agents/workspace.ts` — workspace bootstrap 文件加载（含 MEMORY.md）
- `src/agents/system-prompt.ts` — system prompt 中 Memory Recall 段落生成
- `src/config/types.tools.ts:272` — `MemorySearchConfig` 类型定义
- `src/config/zod-schema.agent-runtime.ts:455` — MemorySearchSchema zod 校验

### GitHub Issues（已知问题）

- [#13987: New session doesn't auto-load memory files](https://github.com/openclaw/openclaw/issues/13987)
- [#1004: memorySearch embeddings 429 with no failover](https://github.com/moltbot/clawdbot/issues/1004)

---

## 一、认知架构：术语对照

| 认知科学概念                | OpenClaw 对应                        | 说明                                                          |
| --------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| 长期记忆 (Long-term Memory) | `MEMORY.md` + `memory/*.md`          | 磁盘上的 Markdown 文件，持久化、可编辑、可 git 追踪           |
| 工作记忆 (Working Memory)   | LLM context window                   | 每次 API 调用的上下文窗口（我们配了 240K tokens），有容量限制 |
| 回忆/检索 (Recall)          | `memory_search` 工具                 | 从长期记忆中语义搜索，提取相关片段到工作记忆                  |
| 感觉记忆 (Sensory)          | 当前消息 + inbound context           | 用户发送的当前消息、附件、群组上下文等                        |
| 记忆编码 (Encoding)         | agent 写入 memory/ 文件              | 模型通过 write 工具将信息持久化到 memory 文件                 |
| 记忆巩固 (Consolidation)    | memory flush (compaction 前自动触发) | 即将压缩上下文前，系统静默提醒模型保存关键记忆                |
| 遗忘曲线 (Forgetting)       | temporal decay（可选）               | 旧记忆得分随时间衰减，模拟遗忘                                |

### MEMORY.md 的加载方式

**MEMORY.md 同时以两种方式进入工作记忆：**

1. **Bootstrap 注入（被动）**：session 启动时，MEMORY.md 作为 bootstrap context file 被整体注入到 system prompt 的 "Workspace Files (injected)" 区域。每次 API 调用都带着。
2. **工具检索（主动）**：`memory_search` 语义搜索 MEMORY.md + memory/\*.md，返回相关片段。`memory_get` 按路径读取具体文件。

**注意**：代码中 `filterBootstrapFilesForSession` 只对 subagent/cron 会话过滤（仅保留 AGENTS.md + TOOLS.md）。普通会话（包括群组聊天）都会加载 MEMORY.md。文档说"仅在主私聊加载"是设计意图，代码层面未强制执行群组排除。

---

## 二、记忆文件布局

```
~/.openclaw/workspace/
├── MEMORY.md              # 长期策划记忆（决策、偏好、持久事实）
├── memory/
│   ├── YYYY-MM-DD.md      # 每日追加日志（session 启动读今天+昨天）
│   └── reference.md       # 非日期文件（不受时间衰减影响）
├── AGENTS.md              # agent 行为规则
├── SOUL.md                # 人格/角色定义
├── IDENTITY.md            # 身份信息
├── USER.md                # 用户信息
├── TOOLS.md               # 工具使用指南
└── HEARTBEAT.md           # 心跳任务
```

索引存储：`~/.openclaw/memory/{agentId}.sqlite`

---

## 三、搜索系统架构

### 3.1 两个后端

| 后端                          | 类型                       | 说明                                           |
| ----------------------------- | -------------------------- | ---------------------------------------------- |
| **Builtin**（默认，我们在用） | SQLite + FTS5 + sqlite-vec | 内置，无需额外安装                             |
| **QMD**（实验性）             | 外部 sidecar 进程          | BM25 + 向量 + reranking，需额外安装 qmd 二进制 |

### 3.2 Builtin 搜索管线

```
用户查询
    │
    ├──→ Embedding API ──→ 向量余弦相似度搜索（语义匹配）
    │                       取 top maxResults × candidateMultiplier 候选
    │
    ├──→ FTS5 BM25 ──→ 关键词匹配搜索（精确 token 匹配）
    │                   取 top maxResults × candidateMultiplier 候选
    │
    ├──→ 加权合并
    │    finalScore = vectorWeight × vectorScore + textWeight × textScore
    │    默认：70% 向量 + 30% 关键词
    │
    ├──→ [可选] 时间衰减 (Temporal Decay)
    │    decayedScore = score × e^(-λ × ageInDays)
    │    默认关闭
    │
    ├──→ 按分数排序
    │
    ├──→ [可选] MMR 去重排序
    │    平衡相关性与多样性，去除近似重复
    │    默认关闭
    │
    └──→ 返回 Top-K 结果（默认 6 条，minScore ≥ 0.25 [已从 0.35 调低]）
```

### 3.3 索引机制

- **文件类型**：仅 Markdown（`.md`）
- **分块**：~400 token/块，80 token 重叠
- **监听**：file watcher 监控 memory/ 目录，1.5s 去抖
- **同步触发**：session 启动时、搜索时、或定时间隔
- **指纹校验**：索引存储 provider/model + endpoint + chunking 参数的指纹，任何变更自动全量重建
- **Embedding 缓存**：SQLite 中缓存 chunk embedding，避免重复计算

---

## 四、Session 与记忆的关系

### 4.1 dmScope 与 session key

我们使用 `dmScope = "main"`（默认值）：

| 渠道          | session key                      | 说明                            |
| ------------- | -------------------------------- | ------------------------------- |
| 飞书私聊      | `agent:main:main`                | 所有私聊共享一个 session        |
| Telegram 私聊 | `agent:main:main`                | 同上                            |
| Webchat       | `agent:main:main`                | 同上                            |
| Realtime 语音 | `realtime:xxx`（独立前缀）       | 独立 session，不受 dmScope 控制 |
| 飞书群组      | `agent:main:feishu:group:{id}`   | 每个群独立 session              |
| Telegram 群组 | `agent:main:telegram:group:{id}` | 每个群独立 session              |

### 4.2 各渠道加载哪些记忆

| 内容                            | 私聊    | 群组                  | Subagent/Cron      |
| ------------------------------- | ------- | --------------------- | ------------------ |
| MEMORY.md（bootstrap 注入）     | ✅ 加载 | ✅ 加载（代码未过滤） | ❌ 不加载          |
| AGENTS.md                       | ✅      | ✅                    | ✅                 |
| SOUL.md / USER.md / IDENTITY.md | ✅      | ✅                    | ❌                 |
| memory_search 工具              | ✅      | ✅                    | 取决于 tool policy |
| memory_get 工具                 | ✅      | ✅                    | 取决于 tool policy |

---

## 五、Embedding Provider

### 5.1 可选 Provider

| Provider               | 默认模型                           | 特点                                 |
| ---------------------- | ---------------------------------- | ------------------------------------ |
| **openai**（我们在用） | `text-embedding-3-small`           | 通过 OpenRouter 代理，支持 Batch API |
| gemini                 | `gemini-embedding-001`             | 免费层有速率限制（429 风险）         |
| voyage                 | `voyage-4-large`                   |                                      |
| local                  | GGUF via node-llama-cpp            | 完全离线，需编译 native 模块         |
| auto                   | 按 local→openai→gemini→voyage 尝试 |                                      |

### 5.2 我们的配置（2026-02-19 更新）

```json5
// docker/shared-config.json5
memorySearch: {
  provider: "openai",
  remote: {
    baseUrl: "https://openrouter.ai/api/v1/",
    apiKey: "${OPENROUTER_API_KEY}",
  },
  model: "text-embedding-3-small",
  sources: ["memory", "sessions"],
  experimental: { sessionMemory: true },
  query: { minScore: 0.25 },
}
```

通过 OpenRouter 代理调用 OpenAI embedding API。已启用 session 转录索引。`minScore` 从默认 0.35 降至 0.25 以适配中文。

---

## 六、完整配置参数清单

### 6.1 记忆搜索配置 (`agents.defaults.memorySearch.*`)

| 参数                                      | 默认值                                | 说明                        |
| ----------------------------------------- | ------------------------------------- | --------------------------- |
| `enabled`                                 | `true`                                | 是否启用向量记忆搜索        |
| `provider`                                | `"auto"`                              | embedding 提供者            |
| `model`                                   | 取决于 provider                       | embedding 模型名            |
| `fallback`                                | `"none"`                              | 主 provider 失败时的备选    |
| `sources`                                 | `["memory"]`                          | 索引源（可加 `"sessions"`） |
| `extraPaths`                              | `[]`                                  | 额外索引的 Markdown 路径    |
| `remote.baseUrl`                          | —                                     | 自定义 embedding 端点       |
| `remote.apiKey`                           | —                                     | API 密钥                    |
| `remote.headers`                          | `{}`                                  | 自定义请求头                |
| `remote.batch.enabled`                    | `false`                               | 启用 Batch API 索引         |
| `remote.batch.wait`                       | `true`                                | 等待 batch 完成             |
| `remote.batch.concurrency`                | `2`                                   | 并行 batch 任务数           |
| `remote.batch.pollIntervalMs`             | `5000`                                | 轮询间隔                    |
| `remote.batch.timeoutMinutes`             | `60`                                  | batch 超时                  |
| `local.modelPath`                         | —                                     | GGUF 路径或 hf: URI         |
| `local.modelCacheDir`                     | —                                     | 模型缓存目录                |
| `store.driver`                            | `"sqlite"`                            | 存储驱动                    |
| `store.path`                              | `~/.openclaw/memory/{agentId}.sqlite` | 索引文件路径                |
| `store.vector.enabled`                    | `true`                                | 启用 sqlite-vec 加速        |
| `store.vector.extensionPath`              | —                                     | sqlite-vec 扩展路径         |
| `chunking.tokens`                         | `400`                                 | 分块大小（token）           |
| `chunking.overlap`                        | `80`                                  | 分块重叠（token）           |
| `sync.onSessionStart`                     | `true`                                | session 启动时同步          |
| `sync.onSearch`                           | `true`                                | 搜索时同步                  |
| `sync.watch`                              | `true`                                | 文件监听                    |
| `sync.watchDebounceMs`                    | `1500`                                | 监听去抖时间                |
| `sync.intervalMinutes`                    | `0`（禁用）                           | 定时同步间隔                |
| `sync.sessions.deltaBytes`                | `100000`                              | session 增量触发阈值        |
| `sync.sessions.deltaMessages`             | `50`                                  | session 消息数触发阈值      |
| `query.maxResults`                        | `6`                                   | 最大返回结果数              |
| `query.minScore`                          | `0.35`                                | 最低分数阈值                |
| `query.hybrid.enabled`                    | `true`                                | 启用混合搜索                |
| `query.hybrid.vectorWeight`               | `0.7`                                 | 向量权重                    |
| `query.hybrid.textWeight`                 | `0.3`                                 | 关键词权重                  |
| `query.hybrid.candidateMultiplier`        | `4`                                   | 候选倍数                    |
| `query.hybrid.mmr.enabled`                | `false`                               | 启用 MMR 去重               |
| `query.hybrid.mmr.lambda`                 | `0.7`                                 | MMR 权衡参数                |
| `query.hybrid.temporalDecay.enabled`      | `false`                               | 启用时间衰减                |
| `query.hybrid.temporalDecay.halfLifeDays` | `30`                                  | 半衰期（天）                |
| `cache.enabled`                           | `true`                                | 启用 embedding 缓存         |
| `cache.maxEntries`                        | —                                     | 缓存条目上限                |
| `experimental.sessionMemory`              | `false`                               | 启用 session 转录索引       |

### 6.2 记忆后端配置 (`memory.*`)

| 参数        | 默认值      | 说明                         |
| ----------- | ----------- | ---------------------------- |
| `backend`   | `"builtin"` | 后端引擎                     |
| `citations` | `"auto"`    | 搜索结果是否带来源引用       |
| `qmd.*`     | —           | QMD 后端专用（~20 个子参数） |

### 6.3 记忆刷盘配置 (`agents.defaults.compaction.memoryFlush.*`)

| 参数                  | 默认值   | 说明                             |
| --------------------- | -------- | -------------------------------- |
| `enabled`             | `true`   | 启用 compaction 前自动记忆保存   |
| `softThresholdTokens` | `4000`   | 触发阈值                         |
| `systemPrompt`        | 内置提示 | 提醒 AI 保存记忆的 system prompt |
| `prompt`              | 内置提示 | 提醒 AI 保存记忆的 user prompt   |

---

## 七、我们的当前状态

### 7.1 已启用的功能

| 功能                                  | 状态              | 配置来源                                                      |
| ------------------------------------- | ----------------- | ------------------------------------------------------------- |
| MEMORY.md + daily logs                | ✅ 启用           | 默认 workspace 布局                                           |
| 向量语义搜索                          | ✅ 启用           | `provider: "openai"` via OpenRouter                           |
| BM25 关键词搜索                       | ✅ 启用           | 默认（FTS5）                                                  |
| 混合搜索                              | ⚠️ 启用但中文有害 | 默认 70/30 权重，FTS5 对中文贡献 0 分反而拉低得分             |
| Session 转录索引                      | ✅ 启用           | `sources: ["memory", "sessions"]`，1162 个 session 文件已索引 |
| 自定义 minScore                       | ✅ 已调低         | `query.minScore: 0.25`（默认 0.35 对中文过高）                |
| 文件监听自动索引                      | ✅ 启用           | 默认 `sync.watch = true`                                      |
| Embedding 缓存                        | ✅ 启用           | 默认 `cache.enabled = true`                                   |
| Memory Flush（compaction 前自动保存） | ✅ 启用           | 默认 + `compaction.mode: "safeguard"`                         |

### 7.2 未启用的功能

| 功能                  | 状态      | 影响                                                   |
| --------------------- | --------- | ------------------------------------------------------ |
| **MMR 去重**          | ❌ 关闭   | 搜索结果可能有近似重复（session 中大量 cron 重复内容） |
| **时间衰减**          | ❌ 关闭   | 旧记忆可能压过新记忆                                   |
| **Batch 索引**        | ❌ 关闭   | 大量文件时索引效率不是最优                             |
| **Fallback provider** | ❌ 未配置 | OpenRouter 失败时无备选                                |
| **额外索引路径**      | ❌ 未配置 | skills/ 和 docs/ 不被搜索                              |
| **QMD 后端**          | ❌ 关闭   | 无 reranking 能力                                      |

### 7.3 实际文件统计

```
~/.openclaw/workspace/MEMORY.md          — 5KB（长期记忆）
~/.openclaw/workspace/memory/            — 16 个日志文件 + reference.md
~/.openclaw/memory/main.sqlite           — 向量索引数据库
~/.openclaw/agents/main/sessions/        — 大量 session JSONL 文件
```

---

## 八、关键概念详解（附具体例子）

### 8.1 QMD 后端

**QMD** = 一个独立的本地搜索 sidecar 进程（类似 Elasticsearch 的轻量替代），由 OpenClaw 社区成员开发。

**与 Builtin 的区别**：

| 对比          | Builtin               | QMD                                 |
| ------------- | --------------------- | ----------------------------------- |
| 架构          | 内嵌在 gateway 进程中 | 独立 sidecar 进程                   |
| BM25          | SQLite FTS5           | QMD 自己的 BM25                     |
| 向量搜索      | sqlite-vec            | 本地 GGUF 模型                      |
| **Reranking** | ❌ 无                 | ✅ 有（本地 reranker 模型）         |
| 安装          | 内置，零配置          | 需额外安装 qmd 二进制               |
| Session 导出  | 不支持                | 支持导出 session 为 Markdown 供搜索 |

**例子**：搜索 "家里的路由器配置"

- Builtin：向量搜索找到 3 条语义相关结果，BM25 找到 2 条含 "路由器" 关键词的结果，混合排序
- QMD：同上，但额外用 reranker 模型对结果重新评分，精度更高（代价是首次搜索需下载 ~500MB GGUF reranker 模型）

### 8.2 Batch 索引

**问题**：当记忆文件很多（如几百个日志文件），逐条发送 embedding API 请求很慢、成本高。

**Batch 索引**：将多个 embedding 请求打包成一个 batch job 提交给 OpenAI/Gemini，异步处理。

**例子**：

- 不用 Batch：300 个 chunk → 300 次 API 调用 → 串行 ~60 秒
- 用 Batch：300 个 chunk → 1 个 batch job → OpenAI 异步处理 → 轮询等待 → ~15 秒完成，且 OpenAI Batch API 有 50% 折扣

**适用场景**：首次索引或大量文件变更时。日常增量更新影响不大。

### 8.3 MMR（最大边际相关性）去重

**问题**：日记忆中经常记录相似内容（如每天都提到"开会时间"），搜索结果充斥近似重复。

**MMR 原理**：迭代选择结果，每次选 `λ × 相关性 − (1−λ) × 与已选结果的最大相似度`，平衡相关性和多样性。

**例子** — 搜索 "开会安排"：

不开 MMR（默认）：

```
1. memory/2026-02-19.md  (0.92) — "每周二 14:00 产品评审会"
2. memory/2026-02-18.md  (0.89) — "每周二 14:00 产品评审会，本周讨论Q1规划"  ← 近似重复！
3. memory/2026-02-17.md  (0.85) — "每周二 14:00 产品评审会"  ← 又是近似重复！
```

开了 MMR (λ=0.7)：

```
1. memory/2026-02-19.md  (0.92) — "每周二 14:00 产品评审会"
2. memory/2026-02-15.md  (0.78) — "周五 10:00 技术分享会"  ← 不同信息！
3. memory/2026-02-12.md  (0.75) — "1:1 与老板每周三 16:00"  ← 不同信息！
```

### 8.4 时间衰减（Temporal Decay）

**问题**：6 个月前一条措辞精确的旧笔记，语义分数可能高于昨天的更新。

**时间衰减公式**：`decayedScore = score × e^(-λ × ageInDays)`，其中 `λ = ln(2) / halfLifeDays`。

**半衰期 30 天的衰减效果**：

| 时间距离 | 保留比例 |
| -------- | -------- |
| 今天     | 100%     |
| 7 天前   | ~84%     |
| 30 天前  | 50%      |
| 90 天前  | 12.5%    |
| 180 天前 | ~1.6%    |

**例子** — 搜索 "小明的工作时间"（今天是 2 月 19 日）：

不开时间衰减：

```
1. memory/2025-09-15.md  (0.91) — "小明工作时间：周一至周五，10:00 standup"  ← 5个月前的旧数据
2. memory/2026-02-19.md  (0.82) — "小明改为周二至周六，standup 改 14:15"
```

开了时间衰减 (halfLife=30)：

```
1. memory/2026-02-19.md  (0.82 × 1.00 = 0.82) — "小明改为周二至周六"  ← 今天的数据排第一
2. memory/2025-09-15.md  (0.91 × 0.03 = 0.03) — 旧数据几乎消失
```

**重要**：`MEMORY.md` 和 `memory/reference.md` 等非日期文件**不受时间衰减影响**，它们是"常青"参考文档。

---

## 九、实测结果（2026-02-19）

### 9.1 测试场景：搜索 "杨哥"

**背景**：杨哥（杨泓泽）是 Autolink 车联天下董事长，天哥的合作伙伴。在 MEMORY.md 和大量 session 中频繁出现。

#### 9.1.1 Vector（语义）搜索得分

| 查询                   | 最高得分  | 结果来源                         | 结论                           |
| ---------------------- | --------- | -------------------------------- | ------------------------------ |
| "杨哥"                 | **0.348** | session transcripts（cron 提醒） | 刚好卡在默认阈值 0.35 **以下** |
| "杨哥 Autolink CarHer" | ~0.38+    | session transcripts              | 加长查询词后勉强过线           |

`text-embedding-3-small` 对 2 字中文人名 "杨哥" 的语义相似度只有 **0.346-0.348**，一个 0.001 的差距让搜索彻底失败。

#### 9.1.2 FTS5（关键词）搜索得分

| 查询           | 结果数 | 原因                                                                    |
| -------------- | ------ | ----------------------------------------------------------------------- |
| `MATCH '杨哥'` | **0**  | `unicode61` 把 "和杨哥开会了" 视为一个整体 token，"杨哥" 不是独立 token |
| `MATCH '杨'`   | **3**  | 单字 CJK 在某些边界场景能匹配                                           |

**FTS5 对中文完全无效。** 详见 9.2.2。

#### 9.1.3 Hybrid（混合）搜索得分

```
finalScore = 0.7 × vectorScore + 0.3 × textScore
           = 0.7 × 0.348    + 0.3 × 0
           = 0.244
```

**混合搜索反而比纯 vector 更差！** 因为 FTS5 贡献为 0，30% 的权重被浪费，拉低了最终得分。

#### 9.1.4 修复：降低 minScore 阈值

| 配置   | 值                       | 效果                                      |
| ------ | ------------------------ | ----------------------------------------- |
| 修改前 | `minScore: 0.35`（默认） | "杨哥" 得分 0.348 → 被过滤 → **0 条结果** |
| 修改后 | `minScore: 0.25`         | "杨哥" 得分 0.348 → 通过 → **6 条结果**   |

修改位置：`docker/shared-config.json5` → `agents.defaults.memorySearch.query.minScore`

**注意**：修改 config 后必须**重启 gateway**，因为 `MemoryIndexManager` 在 gateway 启动时创建一次，其 `minScore` 固化在内存中。`agents.*` 的 hot-reload 规则是 `kind: "none"`，不会重建已有的 manager 实例。

---

### 9.2 中文搜索的两大致命问题

#### 9.2.1 Vector 搜索：`text-embedding-3-small` 对中文短查询效果差

**根因**：OpenAI `text-embedding-3-small`（1536 维）虽然支持多语言，但对中文短查询的余弦相似度系统性偏低：

| 查询类型       | 英文示例            | 中文示例     | 预期得分范围                       |
| -------------- | ------------------- | ------------ | ---------------------------------- |
| 精确实体名     | "John"              | "杨哥"       | 英文 0.4-0.5，**中文 0.34-0.35**   |
| 带上下文的查询 | "meeting with John" | "和杨哥开会" | 英文 0.5-0.6，**中文 0.38-0.42**   |
| 语义描述       | "who did I meet?"   | "我见了谁"   | 英文 0.45-0.55，**中文 0.35-0.40** |

**原因**：

- 模型训练数据以英文为主，中文 token 粒度更粗、语义密度不均
- 2 字中文名（"杨哥"）语义信息极少，无法建立强关联
- chunk 内容通常很长（~400 token），短查询与长 chunk 的余弦相似度天然偏低

**备选方案**（未测试）：

- `text-embedding-3-large`（3072 维）：中文效果好 ~10-15%，成本 ×6.5
- `voyage-3-large`：号称多语言优化
- 本地中文优化模型（如 BAAI/bge-m3）：需要 QMD 或 local provider

#### 9.2.2 FTS5 搜索：`unicode61` 分词器对中文彻底失效

**根因**：SQLite FTS5 默认使用 `unicode61` 分词器，按 Unicode 字符类别（空格、标点）分词。中文没有空格，导致：

```
原文: "⏰ 提醒天哥：下午2点了，该去 Autolink 和杨哥开会了！别迟到～"

unicode61 分词结果:
  token[0] = "提醒天哥"    ← 冒号前的所有 CJK 字符粘在一起
  token[1] = "下午"
  token[2] = "2"
  token[3] = "点了"
  token[4] = "该去"
  token[5] = "autolink"
  token[6] = "和杨哥开会了"  ← "杨哥" 被粘在 "和...开会了" 里面！
  token[7] = "别迟到"
```

当你搜 `MATCH '杨哥'` 时，FTS5 找 token 精确等于 "杨哥" 的记录——没有！因为 "杨哥" 被包裹在 "和杨哥开会了" 这个大 token 里。

**对比**：如果文本是 "杨哥 开会"（有空格），那 "杨哥" 就是独立 token，能搜到。但中文自然文本几乎不会有这种空格。

**解决方案**（需要 OpenClaw 上游支持）：

- **ICU 分词器**：`CREATE VIRTUAL TABLE ... USING fts5(text, tokenize='icu zh_CN')`，需要 SQLite 编译时带 ICU 扩展
- **中文分词预处理**：用 jieba/pkuseg 分词后以空格分隔存入 FTS5
- **trigram 分词器**：`tokenize='trigram'`，按 3 字符滑窗切分，支持子串匹配但索引膨胀
- **临时方案**：对中文用户将 `hybrid.textWeight` 设为 0，禁用无效的 FTS5

#### 9.2.3 当前实际搜索能力矩阵

| 搜索方式            | 英文             | 中文                 | 说明                      |
| ------------------- | ---------------- | -------------------- | ------------------------- |
| Vector 语义搜索     | ✅ 好（0.4-0.6） | ⚠️ 勉强（0.34-0.42） | 中文短查询得分系统性偏低  |
| FTS5 关键词搜索     | ✅ 好            | ❌ 完全无效          | unicode61 不支持中文分词  |
| Hybrid 混合搜索     | ✅ 最优          | ❌ 比纯 vector 更差  | FTS5=0 拖累了 vector 得分 |
| grep（AI 自行调用） | ✅               | ✅                   | 精确子串匹配，中英文都行  |

**结论**：对于中文用户，目前 `memory_search` 的有效搜索能力**仅来自 vector 搜索**，且被 FTS5 的 0 分拖累。grep 反而是最可靠的中文搜索手段。

---

## 十、已知问题

### 10.1 Context Rot（上下文腐烂）

记忆文件作为 bootstrap context 每次 API 调用都带上，3 个月后从 ~50KB 涨到 150KB+，重要指令被淹没在 LLM 注意力死区。

### 10.2 Embedding 429 崩溃（#1004）

embedding 请求被 rate limit 时，gateway 产生未处理的 Promise Rejection 直接崩溃，无优雅降级。我们通过 OpenRouter 代理一定程度缓解了这个问题。

### 10.3 新 Session 记忆加载（#13987）

`/new` 或 `/reset` 后，agent 可能不自动读取 MEMORY.md。近期版本已修复。

### 10.4 Memory Flush 不保证成功

compaction 前触发的 memory flush 是"尽力而为"的，如果 AI 回复 NO_REPLY 或调用失败，记忆可能丢失。

### 10.5 群组 MEMORY.md 泄露

代码中未对群组会话过滤 MEMORY.md，私密长期记忆会进入群组上下文。

### 10.6 FTS5 中文分词完全失效（实测确认）

SQLite FTS5 默认 `unicode61` 分词器不支持中文。`MATCH '杨哥'` 返回 0 条结果，因为连续 CJK 字符被粘成一个大 token。这导致 hybrid 搜索的 30% 关键词权重完全浪费，反而拉低最终得分。

### 10.7 默认 minScore 阈值对中文过高

默认 `minScore: 0.35` 对 `text-embedding-3-small` 的中文查询过于严格。中文专有名词（人名、地名）的 vector 得分通常在 0.34-0.35 之间，刚好被过滤。已通过 `query.minScore: 0.25` 临时修复。

### 10.8 Session 首次索引设计缺陷

启用 `sources: ["memory", "sessions"]` 后首次重启 gateway，`shouldSyncSessions()` 的判断逻辑 `this.sessionsDirty && this.sessionsDirtyFiles.size > 0` 初始值均为 `false`，导致历史 session 不被自动索引。需手动 `pnpm openclaw memory index --force` 触发全量重建。

### 10.9 Config 变更需 Gateway 重启

`MemoryIndexManager` 在 gateway 启动时创建并缓存，`agents.*` 配置的 hot-reload 规则是 `kind: "none"`（不重建已有实例）。修改 `minScore`、`sources`、`hybrid` 等参数后必须重启 gateway 才能生效。

### 10.10 Anthropic API 连续失败导致 Session Lane 死锁（实测确认）

Docker 1 重启后首次搜索 "杨哥"：`memory_search` 本身 1 秒完成，但后续 Anthropic `claude-sonnet-4-6` API 连续 2 次 `isError=true`，gateway 的 embedded run 进入无限重试但不释放 lane，整个 session 被阻塞 **10 分钟**（`timeoutMs=600000` 硬超时）。期间用户发的所有消息（"怎么了"、"/queue"、"你在吗"）均因 `run active check: active=true` 被拒绝处理。最终只有 `/new` 或等待 10 分钟超时才能恢复。此问题为 OpenClaw 上游 run 管理 bug，非记忆功能引起，但启用 session search 后上下文变大可能增加 API 超时概率。

---

## 十一、TODO 优先级清单

### P0 — 紧急（影响中文搜索基本可用性）

| #   | 任务                              | 状态      | 说明                                                                   |
| --- | --------------------------------- | --------- | ---------------------------------------------------------------------- |
| 1   | ~~降低 minScore 阈值~~            | ✅ 已修复 | `query.minScore: 0.25`，2026-02-19                                     |
| 2   | ~~启用 Session 转录索引~~         | ✅ 已启用 | `sources: ["memory", "sessions"]` + `experimental.sessionMemory: true` |
| 3   | **禁用/降低 FTS5 权重（中文）**   | 🔴 待做   | `hybrid.textWeight: 0` 或 `0.05`，避免 FTS5 零分拖累 vector 得分       |
| 4   | **评估更好的中文 embedding 模型** | 🔴 待做   | `text-embedding-3-large` 或 `voyage-3-large` 或 `bge-m3`               |

### P1 — 高优先级（搜索质量提升）

| #   | 任务                   | 状态    | 说明                                                         |
| --- | ---------------------- | ------- | ------------------------------------------------------------ |
| 5   | 开启 MMR 去重          | 🟡 待做 | session 中大量重复内容（如每天的 cron 提醒），MMR 去重很必要 |
| 6   | 开启时间衰减           | 🟡 待做 | 旧 session 结果压过新结果                                    |
| 7   | 增加 maxResults        | 🟡 待做 | 从 6 提升到 10，给 AI 更多上下文                             |
| 8   | 配置 fallback provider | 🟡 待做 | OpenRouter 失败时无备选                                      |

### P2 — 中优先级（扩展能力）

| #   | 任务                                    | 状态    | 说明                                        |
| --- | --------------------------------------- | ------- | ------------------------------------------- |
| 9   | 向 OpenClaw 上游提 Issue：FTS5 中文分词 | 🟡 待做 | 建议支持 ICU/trigram 分词器或中文分词预处理 |
| 10  | 添加 extraPaths                         | 🟡 待做 | 让 skills/、docs/her/ 也被搜索              |
| 11  | 启用 Batch 索引                         | 🟡 待做 | 大量 session 文件时提升效率                 |

### P3 — 低优先级

| #   | 任务               | 状态    | 说明                               |
| --- | ------------------ | ------- | ---------------------------------- |
| 12  | 评估 QMD 后端      | 🟡 待做 | reranking 能力更强，但运维成本增加 |
| 13  | 定期整理 MEMORY.md | 🟡 待做 | 避免 Context Rot                   |
