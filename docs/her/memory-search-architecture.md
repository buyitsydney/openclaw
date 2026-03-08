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

| Provider               | 默认模型                           | 特点                                    |
| ---------------------- | ---------------------------------- | --------------------------------------- |
| **openai**（我们在用） | `BAAI/bge-m3`（通过 OpenRouter）   | 中文专项优化，1024 维，35/35 全胜 small |
| openai                 | `text-embedding-3-small`           | 之前在用，1536 维，通用但中文偏弱       |
| gemini                 | `gemini-embedding-001`             | 免费层有速率限制（429 风险）            |
| voyage                 | `voyage-4-large`                   | Unicode 兼容性 bug，不推荐              |
| local                  | GGUF via node-llama-cpp            | 完全离线，需编译 native 模块            |
| auto                   | 按 local→openai→gemini→voyage 尝试 |                                         |

### 5.2 我们的配置（2026-02-19 更新）

```json5
// docker/shared-config.json5
memorySearch: {
  provider: "openai",
  remote: {
    baseUrl: "https://openrouter.ai/api/v1/",
    apiKey: "${OPENROUTER_API_KEY}",
  },
  model: "BAAI/bge-m3",
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

| 查询           | 结果数                         | 说明                                                                          |
| -------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `MATCH '杨哥'` | **467**                        | "杨哥" 在有标点/空格分隔时是独立 token（如 "搜索记忆：杨哥"），能被 FTS5 匹配 |
| 上述 467 条中  | **0 条**与 vector top 结果重叠 | Vector 最高分的 cron 提醒里 "杨哥" 粘在 "和杨哥开会了" 中，不是独立 token     |

**关键发现**：FTS5 对中文不是"完全无效"——当 "杨哥" 作为独立 token 出现时能找到 467 条。但 `bm25RankToScore` bug（见 10.11）导致所有匹配得分恒为 1.0，丧失排序区分度。详见 9.2.2 分词问题分析。

#### 9.1.3 Hybrid（混合）搜索得分

CLI 显示的 0.349 **已经是 hybrid 加权后的最终分数**，不是原始 vector cosine similarity：

```
CLI 输出:  hybridScore = 0.349
反推:      0.349 = 0.7 × rawVectorScore + 0.3 × 0
           rawVectorScore = 0.349 / 0.7 ≈ 0.499
```

**真实 cosine similarity 其实是 ~0.499**（不算低），但被 `vectorWeight=0.7` 压到 0.349，差 0.001 就被默认 `minScore=0.35` 过滤。FTS5 对这些 cron 提醒 chunk 贡献为 0（"杨哥" 不是独立 token），30% 权重被浪费。

Vector 和 FTS5 结果完全不重叠：vector top 结果是 cron 提醒（hybridScore ≈ 0.349），FTS5 top 结果是独立 "杨哥" 出现的其他对话（hybridScore = 0.3 × 1.0 = 0.300）。

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

**已测试的备选方案**（2026-02-21）：

- `text-embedding-3-large`（3072 维）：实测中文反而不如 small（small 在 27/35 题胜出）
- `voyage-4-large`：API 存在 Unicode 兼容性 bug（某些合法 UTF-8 字符导致 400 错误），不可用
- **`BAAI/bge-m3`（1024 维）：全面碾压 small，35/35 题全胜，平均 top-1 提升 +27%** ← 已切换

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

当你搜 `MATCH '杨哥'` 时，FTS5 找 token 精确等于 "杨哥" 的记录。在 "和杨哥开会了" 中搜不到（"杨哥" 被包裹在大 token 里），但在 "搜索记忆：杨哥" 中能搜到（冒号是分隔符，"杨哥" 是独立 token）。

**实测**：`MATCH '杨哥'` 返回 467 条结果——都是 "杨哥" 前后有标点/空格作为分隔符的文本。但 vector 搜索排名最高的 cron 提醒（"去Autolink和杨哥开会"）中 "杨哥" 不是独立 token，FTS5 找不到它们。结果：**vector 和 FTS5 结果完全不重叠**，hybrid 合并无法产生协同效应。

**解决方案**（需要 OpenClaw 上游支持）：

- **ICU 分词器**：`CREATE VIRTUAL TABLE ... USING fts5(text, tokenize='icu zh_CN')`，需要 SQLite 编译时带 ICU 扩展
- **中文分词预处理**：用 jieba/pkuseg 分词后以空格分隔存入 FTS5
- **trigram 分词器**：`tokenize='trigram'`，按 3 字符滑窗切分，支持子串匹配但索引膨胀
- **临时方案**：对中文用户将 `hybrid.textWeight` 设为 0，禁用无效的 FTS5

#### 9.2.3 当前实际搜索能力矩阵

| 搜索方式            | 英文             | 中文（text-embedding-3-small） | 中文（BAAI/bge-m3）✅ 当前 | 说明                      |
| ------------------- | ---------------- | ------------------------------ | -------------------------- | ------------------------- |
| Vector 语义搜索     | ✅ 好（0.4-0.6） | ⚠️ 勉强（0.25-0.44）           | ✅ 好（0.29-0.49）         | BGE-M3 专为中文优化       |
| FTS5 关键词搜索     | ✅ 好            | ❌ 完全无效                    | ❌ 完全无效                | unicode61 不支持中文分词  |
| Hybrid 混合搜索     | ✅ 最优          | ❌ 比纯 vector 更差            | ⚠️ FTS5 仍拖累             | FTS5=0 拖累了 vector 得分 |
| grep（AI 自行调用） | ✅               | ✅                             | ✅                         | 精确子串匹配，中英文都行  |

**结论**：切换到 BGE-M3 后，Vector 搜索的中文性能大幅提升（+27%），接近英文水平。FTS5 问题仍存在（unicode61 不支持中文分词），但 Vector 搜索本身已足够可靠。grep 仍是最可靠的精确搜索手段，MMR 去重能显著改善搜索结果多样性。

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

默认 `minScore: 0.35` 对 `text-embedding-3-small` 的中文查询过于严格。切换到 `BAAI/bge-m3` 后，中文 top-1 分数普遍在 0.29-0.49 范围，当前 `minScore: 0.25` 可以保留。BGE-M3 最低分 Q23 = 0.2893，安全在阈值之上。

### 10.8 Session 首次索引设计缺陷

启用 `sources: ["memory", "sessions"]` 后首次重启 gateway，`shouldSyncSessions()` 的判断逻辑 `this.sessionsDirty && this.sessionsDirtyFiles.size > 0` 初始值均为 `false`，导致历史 session 不被自动索引。需手动 `pnpm openclaw memory index --force` 触发全量重建。

### 10.9 Config 变更需 Gateway 重启

`MemoryIndexManager` 在 gateway 启动时创建并缓存，`agents.*` 配置的 hot-reload 规则是 `kind: "none"`（不重建已有实例）。修改 `minScore`、`sources`、`hybrid` 等参数后必须重启 gateway 才能生效。

### 10.11 [Upstream Bug] `bm25RankToScore` 所有 FTS5 匹配得分恒为 1.0

**代码位置**：`src/memory/hybrid.ts:46-49`

```typescript
export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}
```

**Bug 描述**：SQLite FTS5 的 `bm25()` 函数对所有匹配结果返回**负数**（越负越好匹配）。但 `Math.max(0, rank)` 把所有负数钳位到 0，导致 `1 / (1 + 0) = 1.0`。**所有 FTS5 匹配结果无论相关性高低，textScore 恒等于 1.0。**

**影响**：

- FTS5 退化为纯"布尔存在性检测"（找到 = 1.0，没找到 = 0），失去 BM25 排序能力
- Hybrid 合并中，FTS5-only 结果得分 = `textWeight × 1.0 = 0.3`，无法区分高质量匹配和低质量匹配
- 对英文搜索实测：rank = -3.6（强匹配）和 rank = -0.1（弱匹配）都得到 textScore = 1.0

**验证**：现有测试 `hybrid.test.ts:17` 明确断言 `bm25RankToScore(-100)` ≈ 1.0，说明此行为是"有意设计"但功能上不正确

**正确实现应为**（将负数翻转为正数后归一化）：

```typescript
export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, -rank) : 999;
  return normalized / (1 + normalized);
  // rank = -3.6 → 3.6/(1+3.6) = 0.783（强匹配 → 高分）
  // rank = -0.1 → 0.1/(1+0.1) = 0.091（弱匹配 → 低分）
  // rank = 0   → 0/(1+0) = 0.0（无匹配 → 零分）
}
```

### 10.12 [Upstream Bug] MMR tokenizer 完全忽略 CJK 字符

**代码位置**：`src/memory/mmr.ts:32-35`

```typescript
export function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return new Set(tokens);
}
```

**Bug 描述**：正则 `/[a-z0-9_]+/g` 只匹配 ASCII 字母和数字，**完全忽略中日韩（CJK）字符**。导致纯中文文本 tokenize 后得到空集。

**影响**：

- 两段内容完全不同的纯中文文本 → 都得到空 token 集 → `jaccardSimilarity({}, {}) = 1.0` → MMR 误判为"完全相同"
- 两段内容相同的纯中文文本（实际重复）→ 同样 Jaccard = 1.0 → 行为偶然正确
- 包含英文的中文混合文本（如 "去 Autolink 和杨哥开会"）→ 只提取 `{"autolink"}` → 勉强能工作

**验证**：`mmr.test.ts` 没有任何 CJK 测试用例。`tokenize("杨哥开会")` 返回空 `Set`

**正确实现**：至少应使用 Unicode 字符类 `\p{L}` 替代 `[a-z]`，并对 CJK 文本做字符级/bigram 分词：

```typescript
export function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  // ASCII + Unicode letter tokens
  const wordTokens = lower.match(/[\p{L}\p{N}_]+/gu) ?? [];
  // CJK character bigrams for sub-word matching
  const cjk = [...lower.matchAll(/\p{Unified_Ideograph}/gu)].map((m) => m[0]);
  const bigrams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i++) {
    bigrams.push(cjk[i] + cjk[i + 1]);
  }
  return new Set([...wordTokens, ...cjk, ...bigrams]);
}
```

### 10.10 Anthropic API 连续失败导致 Session Lane 死锁（实测确认）

Docker 1 重启后首次搜索 "杨哥"：`memory_search` 本身 1 秒完成，但后续 Anthropic `claude-sonnet-4-6` API 连续 2 次 `isError=true`，gateway 的 embedded run 进入无限重试但不释放 lane，整个 session 被阻塞 **10 分钟**（`timeoutMs=600000` 硬超时）。期间用户发的所有消息（"怎么了"、"/queue"、"你在吗"）均因 `run active check: active=true` 被拒绝处理。最终只有 `/new` 或等待 10 分钟超时才能恢复。此问题为 OpenClaw 上游 run 管理 bug，非记忆功能引起，但启用 session search 后上下文变大可能增加 API 超时概率。

---

## 十一、Upstream PR 可行性评估

### PR 1: 修复 `bm25RankToScore` 负数处理

| 维度         | 评估                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **代码改动** | 1 行核心代码 + 1 行测试                                                                                                                             |
| **修改文件** | `src/memory/hybrid.ts` (1行), `src/memory/hybrid.test.ts` (1行)                                                                                     |
| **风险**     | **中等** — 改变所有用户的 FTS5 得分分布。英文用户目前受益于 FTS5 恒 1.0 的 boost，修复后 FTS5 得分会从 1.0 降至 0.1-0.8，可能影响他们的混合搜索排序 |
| **争议性**   | **中等** — 现有测试明确断言 `bm25RankToScore(-100) ≈ 1`，说明开发者**有意设计**此行为。PR 需要说服维护者这是 bug 而非 feature                       |
| **收益**     | FTS5 从"布尔过滤器"恢复为"排序信号"，强匹配得高分、弱匹配得低分                                                                                     |
| **可行性**   | ⭐⭐⭐ — 改动小、收益明确，但需要充分说明为什么现有行为是错误的                                                                                     |

**PR 关键论点**：

1. FTS5 `bm25()` 的返回值约定是负数（更负 = 更好），当前实现丢失了排序信号
2. 实测数据：rank=-3.6（强匹配）和 rank=-0.1（弱匹配）得到同样的 1.0 分
3. 对英文用户的影响有限：混合搜索中 FTS5 只占 30% 权重，排序主要由 vector 决定
4. 对 CJK 用户有重大改善：使 FTS5 得分有区分度，高质量关键词匹配能真正 boost hybrid 结果

### PR 2: MMR tokenizer 支持 Unicode/CJK

| 维度         | 评估                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| **代码改动** | ~10 行核心代码 + ~20 行测试                                                                                       |
| **修改文件** | `src/memory/mmr.ts` (tokenize 函数), `src/memory/mmr.test.ts` (新增 CJK 用例)                                     |
| **风险**     | **低** — MMR 默认关闭 (`enabled: false`)，只有主动启用的用户受影响。且 `\p{L}` 对纯 ASCII 文本行为与 `[a-z]` 一致 |
| **争议性**   | **低** — 这是明显的国际化缺失，没有任何 CJK 测试。不存在"有意设计"的可能                                          |
| **收益**     | CJK 用户的 MMR 去重从"完全失效"变为"可用"                                                                         |
| **可行性**   | ⭐⭐⭐⭐⭐ — 最容易被接受的 PR。bug 明确、改动小、不影响现有英文用户                                              |

**PR 关键论点**：

1. `tokenize()` 的正则 `/[a-z0-9_]+/g` 不支持任何非 ASCII 字符（中文、日文、韩文、阿拉伯文等全部失效）
2. 两段完全不同的中文文本被 Jaccard 判定为"完全相同"（空集 ∩ 空集 / 空集 ∪ 空集 = 1.0）
3. 修复方案对英文用户零影响（`.toLowerCase()` + `\p{L}` 对 ASCII 等价于 `[a-z]`）
4. 附 CJK bigram 分词方案，对中文子串匹配更精确

### PR 提交顺序建议

1. **先提 PR 2（MMR tokenizer）** — 争议最小、收益最大、最容易被合并
2. **再提 PR 1（bm25RankToScore）** — 需要更多论证，可以在 PR 2 被接受后作为 follow-up

---

## 十一-B、Her 实测报告：Round 1 (Base) vs Round 2 (MMR ON)

**测试日期**：2026-02-20
**测试方式**：Her 在飞书上使用 35 道 ground-truth 题目，逐题调用 `memory_search` 工具
**数据存档**：`~/.openclaw/workspace/ground-truth/`

### 配置对比

| 参数                | Round 1 (Base) | Round 2 (MMR)           |
| ------------------- | -------------- | ----------------------- |
| vectorWeight        | 0.7            | 0.7                     |
| textWeight          | 0.3            | 0.3                     |
| minScore            | 0.25           | 0.25                    |
| maxResults          | 6              | **8**                   |
| MMR                 | disabled       | **enabled, lambda=0.4** |
| bm25RankToScore bug | 存在           | **仍存在（未修复）**    |

### 总分对比

| 指标               | Round 1 (Base) | Round 2 (MMR)   | 变化    |
| ------------------ | -------------- | --------------- | ------- |
| **HIT**            | 14/35 (40%)    | **21/35 (60%)** | **+7**  |
| **PARTIAL**        | 7/35 (20%)     | 10/35 (29%)     | +3      |
| **MISS**           | 14/35 (40%)    | **4/35 (11%)**  | **-10** |
| **Memory文件命中** | 3/35 (9%)      | **12/35 (34%)** | **+9**  |
| 平均 Top Score     | 0.388          | ~0.39           | 持平    |

### 关键发现

**1. MMR 去重效果显著**

- 重复 cron 提醒不再独占 top-K（如"杨哥开会" cron 从占满 6 条 → 被 MMR 压缩为 1-2 条）
- Sub-agent task prompt 噪声被去重后，真正相关的结果浮出

**2. Memory 文件可见性大幅提升（3→12）**

- Base 中 memory/\*.md 几乎不可见（被 session 噪声淹没），MMR 后 memory 文件排名大幅上升
- 典型案例：Q07 "旭东道别" → memory/2026-02-11 浮到 #3；Q19 "TTS" → memory/reference.md 浮出

**3. MISS→HIT 的关键翻转**

- Q26 "为什么 session transcript 纳入索引" → Base 全是 sub-agent 噪声 = MISS；R2 #2 精确命中 = **HIT**
- Q01 "配置 LLM 失败" → Base 真答案在 #2 但被噪声压后 = PARTIAL；R2 直接命中 = **HIT**
- Q29 "健康记录" → Base 只有碎片 = PARTIAL；R2 展开多种健康场景 = **HIT**

**4. MISS→PARTIAL 的改善**（9 题）

- Q06 "杨哥"、Q09 "老王"、Q22 "小区"、Q34 "董事长" 等人物/地点查询从完全 MISS 变为有线索

**5. 残留的 4 个 MISS**

- Q02 "生产环境崩了" — sub-agent task prompt + BM25 floor 0.3 污染（修复 bm25 bug 后可能解决）
- Q12 "Momenta 离职" — 确实不在任何索引文件中
- Q15 "最近技术决策" — 语义太泛，向量搜索无法聚焦
- Q17 "查看 gateway 日志" — "tmux capture-pane" 方法未被索引为独立知识

### 逐题变化汇总

| 变化类型           | 题数  | 具体题号                                    |
| ------------------ | ----- | ------------------------------------------- |
| MISS→HIT           | 1     | Q26                                         |
| MISS→PARTIAL       | 9     | Q06,Q07,Q09,Q22,Q23,Q27,Q31,Q34,Q35         |
| PARTIAL→HIT        | 6     | Q01,Q04,Q05,Q20,Q28,Q29                     |
| HIT→HIT (质量提升) | 多题  | Q03,Q10,Q11,Q13,Q14,Q18,Q19,Q24,Q25,Q30,Q32 |
| MISS→MISS          | 4     | Q02,Q12,Q15,Q17                             |
| PARTIAL→PARTIAL    | 1     | Q08                                         |
| 退化               | **0** | 无任何退化                                  |

### 结论

**MMR (lambda=0.4) + maxResults=8 是一次纯增益的配置改进**：

- 零退化（没有任何题从好变差）
- HIT 率从 40% → 60%（+50%）
- MISS 率从 40% → 11%（-73%）
- Memory 文件可见性从 9% → 34%（+278%）

**bm25RankToScore bug 仍未修复**。当前 BM25 对所有匹配结果恒返回 textScore=1.0（`Math.max(0, negativeRank)=0 → score=1.0`），导致 hybrid 合并中 FTS5 只提供"存在/不存在"的布尔信号，无排序区分度。修复后理论上 Q02/Q17 等 sub-agent 噪声问题可能进一步改善（强关键词匹配得高分，弱匹配/噪声得低分）。

---

## 十一-C、Her 实测报告：Round 3（纯向量 + MMR）

**测试日期**：2026-02-20
**配置**：`vectorWeight: 1.0, textWeight: 0, mmr: { enabled: true, lambda: 0.4 }, maxResults: 8, minScore: 0.25`
**含义**：FTS5 关键词搜索仍执行但分数乘以 0，等效于纯向量搜索 + MMR 去重
**数据存档**：`~/.openclaw/workspace/ground-truth/r3_results.json`

### R2 vs R3 总分对比（同一 35 题集）

| 指标        | R2 (hybrid+MMR) | R3 (vector+MMR) | 变化 |
| ----------- | --------------- | --------------- | ---- |
| **HIT**     | 21/35 (60%)     | 23/35 (65%)     | +2   |
| **PARTIAL** | 10/35 (28%)     | 7/35 (20%)      | -3   |
| **MISS**    | 4/35 (11%)      | 5/35 (14%)      | +1   |

### 改善 (8 题)

| 题  | R2→R3        | 查询         | 原因                                           |
| --- | ------------ | ------------ | ---------------------------------------------- |
| Q02 | MISS→PARTIAL | 生产环境搞崩 | FTS5 floor 0.3 噪声消失，真实向量结果浮出      |
| Q06 | PARTIAL→HIT  | 杨哥是谁     | FTS5 cron 噪声消失，语义匹配到"Autolink董事长" |
| Q07 | PARTIAL→HIT  | 旭东道别     | memory/2026-02-17 中望京凯悦信息被向量直接找到 |
| Q12 | MISS→HIT     | Momenta 离职 | 向量匹配到离职面谈 session                     |
| Q15 | MISS→HIT     | 技术决策     | 向量匹配到 Opus 升级/HA 接入等 session         |
| Q17 | MISS→HIT     | gateway 日志 | 向量匹配到 tmux her session 日志               |
| Q22 | PARTIAL→HIT  | 家在哪个小区 | 向量匹配到华升新苑导航记录                     |
| Q34 | PARTIAL→HIT  | 董事长见过   | 向量匹配到杨哥合作关系 session                 |

### 退化 (9 题)

| 题  | R2→R3        | 查询            | 原因                                            |
| --- | ------------ | --------------- | ----------------------------------------------- |
| Q01 | HIT→PARTIAL  | LLM 配置失败    | 失去 FTS5 关键词匹配，精确命中降级              |
| Q08 | PARTIAL→MISS | 小刘是谁        | 短中文人名向量搜索弱，失去 FTS5 布尔 boost      |
| Q09 | PARTIAL→MISS | 老王约事        | 同上，短中文人名向量搜索弱                      |
| Q18 | HIT→MISS     | Docker 容器用途 | TOOLS.md 注入内容失去 FTS5 匹配                 |
| Q23 | PARTIAL→MISS | 旭东道别在哪    | 向量搜索"旭东道别"语义弱于 FTS5 "旭东" 精确匹配 |
| Q24 | HIT→PARTIAL  | 为什么选 Opus   | 失去 FTS5 "Opus" 关键词 boost                   |
| Q27 | PARTIAL→MISS | 人名列表        | 聚合查询 + 失去 FTS5                            |
| Q28 | HIT→PARTIAL  | 技术故障汇总    | 同上，聚合查询退化                              |
| Q29 | HIT→PARTIAL  | 健康记录        | 失去 FTS5 "禁酒"等关键词匹配                    |

### 结论

**R3 纯向量与 R2 hybrid 基本持平，但退化题数(9)略多于改善(8)**：

- 纯向量的优势：消除了 broken FTS5 的噪声（cron 重复、sub-agent prompt），使部分 MISS 翻转为 HIT
- 纯向量的劣势：失去了 FTS5 的关键词精确匹配能力（尤其短中文人名、聚合查询）
- **根因**：不是"该不该用 hybrid"，而是"FTS5 的 bm25RankToScore bug 让 hybrid 质量打折"

**最佳策略**：回退到 R2 配置（hybrid + MMR），等 upstream 修复 bm25RankToScore 后再次测试。修复后的 hybrid 理论上应同时获得 R2 和 R3 的优势：关键词精确匹配 + 正确排序（不再有 0.3 floor 噪声）。

---

## 十一-D、Her 实测报告：Round 4（hybrid + MMR + CJK tokenizer fix）

**测试日期**：2026-02-20
**配置**：R2 + P0-1 CJK fix — `vectorWeight: 0.7, textWeight: 0.3, mmr: { enabled: true, lambda: 0.4 }, maxResults: 8, minScore: 0.25`
**代码修改**：`src/memory/mmr.ts:tokenize` — 新增 CJK unigram + bigram 支持，修复纯中文内容 Jaccard(∅,∅)=1.0 误判 bug
**数据存档**：`~/.openclaw/workspace/ground-truth/r4_results.json`

### 全轮总分对比

| 指标     | R1(Base) | R2(hybrid+MMR) | R3(vector+MMR) | **R4(hybrid+MMR+CJK)** |
| -------- | -------- | -------------- | -------------- | ---------------------- |
| HIT      | 14 (40%) | 21 (60%)       | 23 (65%)       | 21 (60%)               |
| PARTIAL  | 7 (20%)  | 10 (28%)       | 7 (20%)        | **13 (37%)**           |
| **MISS** | 14 (40%) | 4 (11%)        | 5 (14%)        | **1 (2%)**             |

### R4 vs R2 对比（CJK fix 的效果）

**改善 7 题**：
| 题 | R2→R4 | 查询 | 原因 |
|----|-------|------|------|
| Q02 | MISS→PARTIAL | 生产环境搞崩 | CJK MMR 更好地去重，浮出相关 session |
| Q07 | PARTIAL→HIT | 旭东道别 | memory/2026-02-17 望京凯悦命中 |
| Q09 | PARTIAL→HIT | 老王约事 | BM25 关键词匹配 + CJK MMR 去重 |
| Q12 | MISS→PARTIAL | Momenta 离职 | 找到前 Momenta 引用 |
| Q15 | MISS→PARTIAL | 技术决策 | 结果分散但不再为 0 |
| Q17 | MISS→PARTIAL | gateway 日志 | 找到调试 session |
| Q34 | PARTIAL→HIT | 董事长见过 | cron + 合作确认 |

**退化 4 题**：
| 题 | R2→R4 | 查询 | 原因 |
|----|-------|------|------|
| Q01 | HIT→PARTIAL | LLM 配置失败 | cron 噪声稀释（bm25RankToScore bug 未修） |
| Q23 | PARTIAL→MISS | 旭东道别在哪 | 语义+BM25 都太弱，0 结果 |
| Q28 | HIT→PARTIAL | 技术故障汇总 | 聚合查询退化 |
| Q29 | HIT→PARTIAL | 健康记录 | 缺完整时间线 |

### R4 关键发现

1. **MISS=1 是历史最低**（R1: 14, R2: 4, R3: 5, R4: 1）。CJK fix 让 MMR 不再误判纯中文内容
2. **HIT 未提升**（与 R2 持平 21）。原因：`bm25RankToScore` bug 仍在，cron 噪声仍占高分位（Q06 "杨哥被8条cron淹没"）
3. **Her 自己的注释佐证**：Q09 "BM25帮忙！"、Q18 "BM25完美命中！" — FTS5 关键词匹配在人名/专有名词场景不可替代
4. **下一步 P0-2**：修复 bm25RankToScore 让 FTS5 有真实排序，cron 噪声自然降权，HIT 率预计进一步提升

---

## 十一-E、CLI 基准测试：Round 5（hybrid + MMR + CJK fix + BM25 fix，无污染）

**测试日期**：2026-02-20
**配置**：R2 + P0-1 CJK fix + P0-2 BM25 fix — `vectorWeight: 0.7, textWeight: 0.3, mmr: { enabled: true, lambda: 0.4 }, maxResults: 8, minScore: 0.25`
**代码修改**：

- `src/memory/mmr.ts:tokenize` — CJK unigram + bigram（P0-1）
- `src/memory/hybrid.ts:bm25RankToScore` — 负值转比例分数（P0-2）

**执行方式**：CLI 脚本 `scripts/memory-search-bench.sh`，直接调用 `openclaw memory search --json`，不创建 session，零测试污染
**索引状态**：1668 chunks（memory 27 + sessions 1641），已清除所有历史测试 session
**数据存档**：`~/.openclaw/workspace/ground-truth/cli_bench_20260220_211430.json`

### R5 逐题结果

| Q   | 查询                                       | 结果数 | 最高分 | 判定        | 说明                                             |
| --- | ------------------------------------------ | ------ | ------ | ----------- | ------------------------------------------------ |
| Q01 | 之前配置新LLM失败，正确方法是什么？        | 1      | 0.25   | **MISS**    | 唯一结果是 "New session started"，零模型配置方法 |
| Q02 | 上次把生产环境搞崩了是怎么回事？           | 1      | 0.25   | **MISS**    | 唯一结果是 pip 包列表，零 config.apply 事故      |
| Q03 | cron 提醒设置踩过哪些坑？                  | 8      | 0.35   | **HIT**     | cron enabled:true 坑 + rate limit + 绝对时间铁律 |
| Q04 | memory search 之前测试过，结论是什么？     | 8      | 0.38   | **HIT**     | 40%命中率 baseline + BM25 bug + M1-M7 检索方法   |
| Q05 | 飞书文档写入出过什么 bug？                 | 8      | 0.44   | **HIT**     | docx.ts 根因 + 表格静默丢弃                      |
| Q06 | 杨哥是谁，跟天哥什么关系？                 | 8      | 0.35   | **PARTIAL** | cron含"杨泓泽/Autolink"但缺"董事长"关键身份      |
| Q07 | 旭东和天哥最后一次见面是什么情况？         | 8      | 0.32   | **MISS**    | 8个结果全是杨哥/小刘/林森见面提醒，零旭东内容    |
| Q08 | 小刘是谁，什么时候见过？                   | 8      | 0.35   | **HIT**     | 8个结果全是"小刘会面 2/11 下午2点 华升新苑"      |
| Q09 | 老王是谁，约过什么事？                     | 3      | 0.26   | **PARTIAL** | 1个结果含"老王晚餐 2/11 7PM"，但不知老王是谁     |
| Q10 | 天哥的核心团队有哪些人？                   | 8      | 0.35   | **HIT**     | "核心骨干5人（林森/Andy/曹明等）" + 江南大学8人  |
| Q11 | Mac Mini 什么时候买的，什么时候到货？      | 2      | 0.36   | **HIT**     | memory/2026-02-12: M4 Pro 64GB/1TB，3/15到货     |
| Q12 | 天哥什么时候从 Momenta 离职的？            | 8      | 0.31   | **PARTIAL** | 多处"Momenta→Autolink"但无具体离职日期           |
| Q13 | Autolink 是怎么决定加入的？                | 8      | 0.33   | **PARTIAL** | "带下属一起去autolink"但缺决策过程               |
| Q14 | 飞书连接出过什么故障，怎么解决的？         | 8      | 0.35   | **HIT**     | 401诊断 + AccessToken 2h过期机制                 |
| Q15 | 最近两周做了哪些重要的技术决策？           | 8      | 0.32   | **PARTIAL** | 散落活动记录但无聚焦决策清单                     |
| Q16 | browser 自动化用哪个 profile？             | 8      | 0.31   | **MISS**    | 8个结果无一提及 openclaw/chrome profile          |
| Q17 | 怎么查看 gateway 运行日志？                | 8      | 0.34   | **MISS**    | 无 tmux capture-pane 命令                        |
| Q18 | Docker 容器分别是干什么用的？              | 8      | 0.32   | **PARTIAL** | 有Docker2/3信息但缺完整4容器映射                 |
| Q19 | TTS 语音应该怎么用，之前犯过什么错？       | 8      | 0.35   | **HIT**     | memory/2026-02-02 TTS方法 + 多个语音交互         |
| Q20 | 怎么读取天哥的 Apple Notes？               | 8      | 0.36   | **HIT**     | Apple Notes 2128条 + osascript方法               |
| Q21 | 高老庄饭店是哪次去的，在哪？               | 8      | 0.36   | **HIT**     | 2026-02-11 + 4家分店 + 青浦区地址                |
| Q22 | 天哥家在哪个小区？                         | 8      | 0.28   | **HIT**     | 多个结果含"华升新苑"★R5修复！R4/Redo均MISS       |
| Q23 | 和旭东道别是在哪里？                       | 0      | —      | **MISS**    | 零结果                                           |
| Q24 | 为什么选 Opus 不用便宜模型？               | 2      | 0.36   | **MISS**    | 不含"100分×贵>80分×便宜"产品原则                 |
| Q25 | Gemini 模型测试过吗，表现怎么样？          | 8      | 0.37   | **HIT**     | memory/2026-02-20 Gemini 3.1 Pro 测试记录        |
| Q26 | 为什么 session transcript 也纳入搜索索引？ | 8      | 0.38   | **HIT**     | reference.md 直接回答                            |
| Q27 | 这两周所有提到过的人名列表？               | 8      | 0.28   | **PARTIAL** | 散落少量人名，严重缺失                           |
| Q28 | 所有出过的技术故障/bug 汇总？              | 8      | 0.32   | **HIT**     | MEMORY.md 铁律 + WS2 mismatch + docx bug         |
| Q29 | 天哥的健康相关记录有哪些？                 | 8      | 0.30   | **HIT**     | "绝对禁酒" + "慢性病" + "心脏病史"               |
| Q30 | 天哥新买的那台电脑                         | 8      | 0.30   | **HIT**     | Mac Mini M4 Pro 64GB/1TB，3/15到货               |
| Q31 | 语音助手出了什么问题                       | 8      | 0.43   | **PARTIAL** | 各种语音交互但缺聚焦问题清单                     |
| Q32 | 上次吃饭去了哪家店                         | 8      | 0.37   | **HIT**     | 高老庄饭店 2/11 带老婆，交叉验证                 |
| Q33 | 那个搞崩了的配置问题                       | 8      | 0.30   | **MISS**    | 零 config.apply 事故内容                         |
| Q34 | 董事长什么时候见过                         | 8      | 0.33   | **PARTIAL** | Docker巡检+杨哥提醒，非直接回答                  |
| Q35 | 天哥最近在忙什么                           | 8      | 0.37   | **HIT**     | Autolink CTO/CarHer/飞书/记忆系统全面概览        |

### R5 总计

| 指标            | R5 CLI 基准       | R4 (CJK fix) | R2 (MMR)    | R1 (Base)   |
| --------------- | ----------------- | ------------ | ----------- | ----------- |
| **HIT**         | **18/35 (51.4%)** | 21/35 (60%)  | 21/35 (60%) | 14/35 (40%) |
| **PARTIAL**     | 9/35 (25.7%)      | 13/35 (37%)  | 10/35 (29%) | 7/35 (20%)  |
| **MISS**        | **8/35 (22.9%)**  | 1/35 (3%)    | 4/35 (11%)  | 14/35 (40%) |
| **HIT+PARTIAL** | 27/35 (77.1%)     | 34/35 (97%)  | 31/35 (89%) | 21/35 (60%) |

### ⚠️ R1-R4 vs R5 数据可比性说明

**R5 是第一份无污染基准**。R1-R4 均由 Her 在 session 中执行，测试对话本身被实时索引，导致：

- 测试分析文本（含问题关键词"旭东""老王""Opus"等）被索引为可搜索内容
- 部分 MISS 题因测试讨论内容出现假阳性（如 Q23 R5Redo 有 2 个"Opus定价"结果实为测试分析）
- 部分 HIT 题可能因测试内容提供了额外上下文而膨胀

**R5 的 HIT 51.4% 低于 R2/R4 的 60%，但更真实**。关键证据：

- Q22（天哥家小区）：R5Redo MISS → R5 CLI HIT（去污后 MMR 不再压分，"华升新苑"回来了）
- Q09（老王）：R5Redo MISS(8结果全假) → R5 CLI PARTIAL(3结果含1真) — 去掉假结果后反而找到了
- Q24（Opus原则）：R5Redo PARTIAL(含测试讨论) → R5 CLI MISS — 真实情况是搜不到

### R5 MISS 清单（8题）与失败模式

| Q   | 查询                   | 失败模式                                                                   |
| --- | ---------------------- | -------------------------------------------------------------------------- |
| Q01 | 之前配置新LLM失败      | **口语→技术鸿沟**：用户"配置失败"与技术记录"models.json/SDK版本"语义距离远 |
| Q02 | 生产环境搞崩了         | **口语→技术鸿沟**："搞崩"与"config.apply事故"语义不匹配                    |
| Q07 | 旭东最后一次见面       | **人名盲区**：embedding 对"旭东"无信号，BM25 未补救                        |
| Q16 | browser 自动化 profile | **短fact被淹没**：答案"openclaw profile"只是 MEMORY 中一行 bullet          |
| Q17 | gateway 运行日志       | **口语→技术鸿沟**："查看日志"与"tmux capture-pane"语义距离远               |
| Q23 | 旭东道别在哪里         | **人名盲区**：零结果，所有候选分数 < minScore 0.25                         |
| Q24 | 为什么选 Opus          | **短fact被淹没**："100分×贵>80分×便宜"是 capsule 中一句话                  |
| Q33 | 搞崩了的配置问题       | **口语→技术鸿沟**："搞崩了"与"config.apply 全量替换事故"语义距离远         |

### R5 关键发现

1. **去污后 HIT 率 51.4%** — 这是系统在 P0-1 + P0-2 修复后的真实水平
2. **Q22 从 MISS 翻转为 HIT** — P0-2 bm25RankToScore 修复的直接效果：低分但相关的结果不再被全部过滤
3. **8 题 MISS 的根因稳定**：人名盲区(2)、口语→技术鸿沟(4)、短fact被淹没(2) — 这些不是配置能解决的，需要 upstream 改进（FTS5 中文分词、query expansion、reranking）
4. **CLI 测试脚本是可靠的基准工具** — 零污染、可重复、4分钟跑完，后续调参可直接对比

---

## 十二、Embedding 模型对比实验（2026-02-19 ~ 2026-02-21）

### 12.1 实验背景

`text-embedding-3-small`（OpenAI，1536 维）对中文短查询的余弦相似度系统性偏低，人名/地名查询 top-1 分数通常只有 0.25-0.35。需要找到更适合中文的 embedding 模型。

### 12.2 测试方法

- **Benchmark 脚本**: `scripts/memory-search-bench.sh`，35 条中文 ground-truth 查询
- **对比方式**: 每个模型 force reindex 全部 ~1700 chunks，minScore=0 跑 benchmark，对比 top-1 分数
- **数据源**: 1019 个文件（17 memory + 1002 sessions），~1694 chunks

### 12.3 测试的模型

| 模型                     | Provider              | 维度     | 来源               | 结果            |
| ------------------------ | --------------------- | -------- | ------------------ | --------------- |
| `text-embedding-3-small` | OpenAI via OpenRouter | 1536     | 基线（之前在用）   | 基线            |
| `text-embedding-3-large` | OpenAI via OpenRouter | 3072     | OpenAI 高维模型    | 不如 small      |
| `voyage-4-large`         | Voyage AI 直连        | 1024     | 2025 年多语言 SOTA | API bug，不可用 |
| **`BAAI/bge-m3`**        | BAAI via OpenRouter   | **1024** | 中文专项优化       | **全面碾压**    |

### 12.4 详细结果

#### 12.4.1 text-embedding-3-large vs small（2026-02-20）

`text-embedding-3-large`（3072 维）反而不如 `text-embedding-3-small`：

- small 胜出 27/35 题，large 仅胜 8 题
- 结论：**更高维度 ≠ 更好的中文性能**

#### 12.4.2 voyage-4-large（2026-02-20）

Voyage AI 的 `voyage-4-large` 在 reindex 阶段失败：

- API 对某些合法 UTF-8 字符（如 `½`）返回 400 错误
- 这是 Voyage AI API 的已知 bug，非 OpenClaw 问题
- 结论：**API 稳定性不合格，不可用**

#### 12.4.3 BAAI/bge-m3 vs text-embedding-3-small（2026-02-21）

**公平对比（均 minScore=0）**：

| Q       | 查询                             | small top1 | BGE-M3 top1 | 差异        | 胜出         |
| ------- | -------------------------------- | ---------- | ----------- | ----------- | ------------ |
| Q01     | 之前配置新LLM失败                | 0.2521     | 0.4202      | +0.1681     | BGE          |
| Q02     | 上次把生产环境搞崩了             | 0.2524     | 0.3978      | +0.1454     | BGE          |
| Q03     | cron 提醒设置踩过哪些坑          | 0.3524     | 0.4763      | +0.1239     | BGE          |
| Q04     | memory search 之前测试过         | 0.3835     | 0.4870      | +0.1035     | BGE          |
| Q05     | 飞书文档写入出过什么 bug         | 0.4389     | 0.4706      | +0.0317     | BGE          |
| Q06     | 杨哥是谁                         | 0.3538     | 0.3765      | +0.0227     | BGE          |
| Q07     | 旭东和天哥最后一次见面           | 0.3208     | 0.3485      | +0.0277     | BGE          |
| Q08     | 小刘是谁                         | 0.3504     | 0.4208      | +0.0704     | BGE          |
| Q09     | 老王是谁                         | 0.2642     | 0.3808      | +0.1166     | BGE          |
| Q10     | 天哥的核心团队                   | 0.3529     | 0.3736      | +0.0207     | BGE          |
| Q11     | Mac Mini 什么时候买的            | 0.3618     | 0.4831      | +0.1213     | BGE          |
| Q12     | 天哥什么时候从 Momenta 离职      | 0.3127     | 0.3381      | +0.0254     | BGE          |
| Q13     | Autolink 是怎么决定加入的        | 0.3331     | 0.4278      | +0.0947     | BGE          |
| Q14     | 飞书连接出过什么故障             | 0.3496     | 0.4893      | +0.1397     | BGE          |
| Q15     | 最近两周做了哪些重要技术决策     | 0.3228     | 0.3908      | +0.0680     | BGE          |
| Q16     | browser 自动化用哪个 profile     | 0.3114     | 0.4197      | +0.1083     | BGE          |
| Q17     | 怎么查看 gateway 运行日志        | 0.3420     | 0.4220      | +0.0800     | BGE          |
| Q18     | Docker 容器分别是干什么用的      | 0.3237     | 0.4153      | +0.0916     | BGE          |
| Q19     | TTS 语音应该怎么用               | 0.3531     | 0.4802      | +0.1271     | BGE          |
| Q20     | 怎么读取天哥的 Apple Notes       | 0.3586     | 0.4356      | +0.0770     | BGE          |
| Q21     | 高老庄饭店是哪次去的             | 0.3577     | 0.4811      | +0.1234     | BGE          |
| Q22     | 天哥家在哪个小区                 | 0.2766     | 0.3703      | +0.0937     | BGE          |
| Q23     | 和旭东道别是在哪里               | 0.0000     | 0.2893      | +0.2893     | BGE          |
| Q24     | 为什么选 Opus 不用便宜模型       | 0.3616     | 0.4015      | +0.0399     | BGE          |
| Q25     | Gemini 模型测试过吗              | 0.3714     | 0.4383      | +0.0669     | BGE          |
| Q26     | 为什么 session transcript 也纳入 | 0.3807     | 0.4097      | +0.0290     | BGE          |
| Q27     | 这两周所有提到过的人名列表       | 0.2788     | 0.3479      | +0.0691     | BGE          |
| Q28     | 所有出过的技术故障/bug 汇总      | 0.3201     | 0.3920      | +0.0719     | BGE          |
| Q29     | 天哥的健康相关记录               | 0.2963     | 0.3634      | +0.0671     | BGE          |
| Q30     | 天哥新买的那台电脑               | 0.3024     | 0.3959      | +0.0935     | BGE          |
| Q31     | 语音助手出了什么问题             | 0.4258     | 0.4849      | +0.0591     | BGE          |
| Q32     | 上次吃饭去了哪家店               | 0.3710     | 0.4843      | +0.1133     | BGE          |
| Q33     | 那个搞崩了的配置问题             | 0.2996     | 0.4003      | +0.1007     | BGE          |
| Q34     | 董事长什么时候见过               | 0.3302     | 0.3869      | +0.0567     | BGE          |
| Q35     | 天哥最近在忙什么                 | 0.3721     | 0.4167      | +0.0446     | BGE          |
| **AVG** | **平均 top-1**                   | **0.3267** | **0.4148**  | **+0.0881** | **BGE 35:0** |

### 12.5 结论

| 指标                   | text-embedding-3-small | BAAI/bge-m3         |
| ---------------------- | ---------------------- | ------------------- |
| 平均 top-1 分数        | 0.3267                 | **0.4148** (+27%)   |
| 胜出题数（35题）       | 0                      | **35**              |
| 维度                   | 1536                   | **1024**（更紧凑）  |
| 最低 top-1             | 0.0000 (Q23)           | **0.2893** (Q23)    |
| 最高 top-1             | 0.4389 (Q05)           | **0.4893** (Q14)    |
| 中文人名查询 (Q06-Q10) | 0.26-0.35              | **0.37-0.42**       |
| Provider               | OpenAI via OpenRouter  | BAAI via OpenRouter |

**关键发现**：

1. **BGE-M3 全面碾压 small**：35 题全胜，无一败绩
2. **中文人名查询提升最大**：如"老王"从 0.2642→0.3808（+44%），"小刘"从 0.3504→0.4208（+20%）
3. **消除了零召回**：Q23"和旭东道别在哪里"从 0.0000→0.2893
4. **维度更低但效果更好**：1024 维 < 1536 维，但分数更高，存储和计算也更省
5. **无需新 API key**：通过 OpenRouter 调用，复用现有 key

**当前配置**（`docker/shared-config.json5`）：

```json5
memorySearch: {
  provider: "openai",
  remote: {
    baseUrl: "https://openrouter.ai/api/v1/",
    apiKey: "${OPENROUTER_API_KEY}",
  },
  model: "BAAI/bge-m3",  // ← 2026-02-21 从 text-embedding-3-small 切换
}
```

---

## 十三、跨 Session Recall 验证（2026-03-08）

### 13.1 问题定义

当前配置已开启：

- `sources: ["memory", "sessions"]`
- `experimental.sessionMemory: true`

但这**不等于**“所有历史 session 都会进入索引”。

根因在于 `src/memory/session-files.ts` 当前只筛选：

```ts
.filter((name) => name.endsWith(".jsonl"))
```

这会导致：

- 活跃 session（`*.jsonl`）会进入 `sessions` source
- `/new` 或 `/reset` 后归档出的 `.jsonl.reset.*` **不会**进入索引
- 因而频繁 `/new` 的用户会出现“明明历史对话还在磁盘上，但 memory search 找不到”的现象

### 13.2 确定性实验设计

为避免实验内部互相污染，本次没有直接和 Her 连续对话，而是采用**离线固定夹具 + 每题独立 stateDir** 的方式：

- 同一份固定 session 语料
- 旧代码 / 新代码分别回放
- 每轮独立 `stateDir`
- 每轮独立 `memory/main.sqlite`
- 每轮独立搜索查询集

这样可以同时隔离：

- session transcript 污染
- sqlite index 污染
- 上一题新增内容对下一题的影响

测试题覆盖 6 类查询：

- 中文关键词
- 英文关键词
- ID 查询
- 中文语义改写
- 英文语义改写
- 中文模糊语义

### 13.3 实验结论

#### `/new` / 跨 session 场景

- 旧方案：`0/6` 命中
- 新方案（把 `.jsonl.reset.*` 纳入索引）：`6/6` 命中

量化结果：

| 指标         | 旧方案    | 新方案    |
| ------------ | --------- | --------- |
| 命中数       | `0/6`     | `6/6`     |
| files        | `2`       | `5`       |
| chunks       | `10`      | `55`      |
| sqlite       | `4.81 MB` | `7.06 MB` |
| sync 时间    | `9.10s`   | `21.40s`  |
| 平均搜索时间 | `3.05s`   | `2.54s`   |

**结论**：跨 session recall 差异非常大，而且是机制性差异，不是随机波动。

#### 长时间不 `/new` 的单 session 场景

- 旧方案：`6/6` 命中
- 新方案：`6/6` 命中

量化结果：

| 指标   | 旧方案    | 新方案    |
| ------ | --------- | --------- |
| 命中数 | `6/6`     | `6/6`     |
| files  | `2`       | `2`       |
| chunks | `32`      | `32`      |
| sqlite | `5.91 MB` | `5.91 MB` |

**结论**：如果用户长期不做 `/new`，这次改动对 recall 机制本身没有本质影响；变化只会出现在“产生了 `.reset` archive”的用户身上。

### 13.4 云端现状快照（S1 只读巡检）

2026-03-08 只读检查 `carher-1` 与 `carher-13`，结论如下：

- 两个容器的核心配置一致
- 都开启了 `memorySearch.sources = ["memory", "sessions"]`
- 都开启了 `experimental.sessionMemory = true`
- 都**没有**启用 `session-memory` hook

这说明当前线上问题的关键不在 hook，而在 **`.reset` archive 没有进入 `sessions` 索引**。

真实数据快照：

#### `carher-1`

- 活跃 `.jsonl`：`111` 个，`17,674,806 B`
- `.reset` 归档：`19` 个，`23,760,344 B`
- `memory/`：`19` 个文件，`57,459 B`

#### `carher-13`

- 活跃 `.jsonl`：`2208` 个，`35,618,847 B`
- `.reset` 归档：`284` 个，`79,253,585 B`
- `memory/`：`51` 个文件，`90,264 B`

### 13.5 风险、成本与上线建议

风险不在“是否有效”，而在“有效之后的代价”：

- sqlite 会变大
- 初次 sync / reindex 会更慢
- 历史 archive 进入候选集后，搜索结果可能更杂

但 embedding 成本非常低。按 OpenRouter 上 `BAAI/bge-m3` 当时公开价格 `$0.01 / 1M input tokens` 粗略上限估算：

- `carher-1`：两周旧方案约 `$0.0308`，新方案约 `$0.0722`，增量约 `$0.0413`
- `carher-13`：两周旧方案约 `$0.0621`，新方案约 `$0.1999`，增量约 `$0.1378`

线性外推 1 年：

- `carher-1`：旧方案约 `$0.804`，新方案约 `$1.881`，年增量约 `$1.077`
- `carher-13`：旧方案约 `$1.619`，新方案约 `$5.213`，年增量约 `$3.593`

**结论**：

- 功能收益明确，成本不是阻碍
- 真正需要灰度观察的是：sqlite 增长、sync 时间、搜索噪音
- 如果后续落地，建议优先灰度到 `carher-13` 这类重度 `/new` 用户，而不是直接全量推广

---

## 十四、TODO 优先级清单

### P0 — 紧急（影响中文搜索基本可用性）

| #   | 任务                              | 状态        | 说明                                                                                        |
| --- | --------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| 1   | ~~降低 minScore 阈值~~            | ✅ 已修复   | `query.minScore: 0.25`，2026-02-19                                                          |
| 2   | ~~启用 Session 转录索引~~         | ✅ 已启用   | `sources: ["memory", "sessions"]` + `experimental.sessionMemory: true`                      |
| 3   | ~~textWeight 调整~~               | ✅ 保持 0.3 | R3 实测纯向量(textWeight=0)退化 9 题 > 改善 8 题。broken FTS5 仍提供有价值的布尔关键词信号  |
| 4   | ~~评估更好的中文 embedding 模型~~ | ✅ 已完成   | 实测 3 个模型后切换到 `BAAI/bge-m3`，35/35 全胜 small，+27%。详见「Embedding 模型对比实验」 |

### P0.5 — 核心设计缺陷（已确认，影响 68%+ 对话内容）

| #   | 任务                                            | 状态                    | 说明                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **memory search 搜索所有历史 session**          | 🟢 upstream PR #20183   | 2026-03-08 的隔离回放实验已确定性证明：旧逻辑只索引 `*.jsonl`，跨 session 场景 `0/6`；纳入 `.jsonl.reset.*` 后 `6/6`。详见「跨 Session Recall 验证（2026-03-08）」。**upstream 已有 PR [#20183](https://github.com/openclaw/openclaw/pull/20183) 对应这个修复方向**，后续可优先等待 merge 或择机本地最小 patch。                                                                                               |
| B   | **飞书 session 生命周期管理（新建/列表/切换）** | 🟡 upstream Issue #9959 | 需求：飞书中能 `/new` 新建、`/sessions` 列表、`/switch <id>` 切换旧 session。**upstream Issue [#9959](https://github.com/openclaw/openclaw/issues/9959) 已提出完全一致的需求**，指出底层全部就绪（TUI `/session <key>` + Gateway `sessions.list` RPC + Agent `sessions_list` tool + Dashboard/WebChat/macOS UI），仅缺 chat 命令入口。0 comments，无人领取。可考虑在 `feishu-her` 扩展层实现或贡献 upstream PR |

**关联说明**：任务 A 是任务 B 的前置条件。任务 A 已有 upstream PR 待合并；任务 B 已有 upstream Issue 但无实现。

**Upstream 现有 session 管理能力一览**（2026-02-21 调查确认）：

- **TUI**: `/sessions`（列表）+ `Ctrl+P`（picker）+ `/session <key>`（切换）+ `setSession()` 函数
- **Dashboard**: 完整 session list + 点击查看
- **WebChat/macOS app**: Session switcher UI
- **Agent tools**: `sessions_list`、`sessions_history`、`sessions_send`
- **Gateway RPC**: `sessions.list`、`sessions.reset`、`sessions.delete`
- **Chat 命令（Telegram/Discord/WhatsApp/Feishu）**: 仅有 `/new`、`/reset`、`/compact`、`/status`，**缺少 `/sessions` 和 `/session <key>`**

### P1 — 高优先级（搜索质量提升，已 CLI 实测验证）

| #   | 任务                     | 状态              | 说明                                                                                                                 |
| --- | ------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| 5   | ~~开启 MMR 去重~~        | ✅ 已部署         | `mmr: { enabled: true, lambda: 0.4 }`。**R2 实测：HIT 40%→60%，MISS 40%→11%，零退化**                                |
| 6   | ~~增加 maxResults 到 8~~ | ✅ 已部署         | 配合 MMR，8 条多样化结果 > 6 条重复结果                                                                              |
| 6b  | ~~R3 纯向量实验~~        | ✅ 已完成（回退） | textWeight=0 测试：HIT +2 但 MISS +1、退化 9 题。**结论：hybrid 比纯向量好，回退到 R2 配置**                         |
| 7   | ~~开启时间衰减~~         | ❌ 暂不启用       | halfLifeDays=30 太激进，3 个月前的重要对话会衰减到 12.5%。MEMORY.md 不受影响（evergreen），但 session 历史会大幅衰减 |
| 8   | 配置 fallback provider   | 🟡 待做           | OpenRouter 失败时无备选                                                                                              |

### P2 — 中优先级（Upstream PR + 扩展能力）

| #   | 任务                                       | 状态          | 说明                                                                                                                               |
| --- | ------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 9   | ~~提 Upstream PR：MMR tokenizer CJK 支持~~ | ✅ 本地已修复 | `/[a-z0-9_]+/g` → ASCII + CJK unigram + bigram。**R4 实测：MISS 4→1，改善 7 题退化 4 题**                                          |
| 9b  | 提 Upstream PR：MMR tokenizer CJK 支持     | 🔴 待做       | 将本地验证过的修复提交 upstream PR                                                                                                 |
| 10  | ~~bm25RankToScore 修复~~                   | ✅ 本地已修复 | `Math.max(0,rank)` → `abs(rank)/(1+abs(rank))`。FTS5 匹配从全部 1.0 → 按相关度 0-1 排序（弱匹配 cron 0.33 vs 强匹配详细讨论 0.91） |
| 10b | 提 Upstream PR：bm25RankToScore 修复       | 🔴 待做       | 将本地验证过的修复提交 upstream PR                                                                                                 |
| 11  | 向 OpenClaw 上游提 Issue：FTS5 中文分词    | 🟡 待做       | 建议支持 ICU/trigram 分词器或中文分词预处理                                                                                        |
| 12  | 添加 extraPaths                            | 🟡 待做       | 让 skills/、docs/her/ 也被搜索                                                                                                     |
| 13  | 启用 Batch 索引                            | 🟡 待做       | 大量 session 文件时提升效率                                                                                                        |

### P3 — 低优先级

| #   | 任务               | 状态    | 说明                               |
| --- | ------------------ | ------- | ---------------------------------- |
| 14  | 评估 QMD 后端      | 🟡 待做 | reranking 能力更强，但运维成本增加 |
| 15  | 定期整理 MEMORY.md | 🟡 待做 | 避免 Context Rot                   |
