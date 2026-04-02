# Context Window 管理架构深度分析

> 日期: 2026-02-15
> 触发: 发现 `agents.defaults.contextTokens: 20000` 设置不触发 auto-compaction
> 版本: `@mariozechner/pi-coding-agent@0.52.12` + OpenClaw dev branch

---

## 1. 核心问题

**现象**: 用户在 `openclaw.json` 中设置 `agents.defaults.contextTokens: 20000`，期望 context 超过 20K tokens 时自动触发 compaction，但实际上 compaction 从不触发。

**根因**: OpenClaw 的 `contextTokens` 设置与上游 pi-coding-agent 的 compaction 触发逻辑存在**架构断层**。`contextTokens` 只在 OpenClaw 层生效，**从未传递**到上游的 compaction 判断逻辑。

---

## 2. 双层架构总览

Context window 管理涉及两个独立层：

```
┌───────────────────────────────────────────────────────────┐
│                    OpenClaw Layer                          │
│  - resolveContextWindowInfo() → cap contextTokens         │
│  - Context Window Guard (warn/block)                      │
│  - Compaction Safeguard Extension (如何 compact)           │
│  - Context Pruning (in-memory 裁剪)                       │
│  - Memory Flush (compact 前写入持久记忆)                    │
└─────────────────────────┬─────────────────────────────────┘
                          │ model object (contextWindow 未修改)
                          ▼
┌───────────────────────────────────────────────────────────┐
│              pi-coding-agent Layer (upstream)              │
│  - AgentSession._checkCompaction()                        │
│  - shouldCompact(contextTokens, this.model.contextWindow) │
│  - 决定 **何时** 触发 compaction                           │
│  - prepareCompaction() + compact()                        │
└───────────────────────────────────────────────────────────┘
```

**关键断点**: OpenClaw 通过 `createAgentSession({ model })` 将原始 model 对象传给上游，model 的 `contextWindow` 属性**未被修改**。

---

## 3. Context Window 解析链路

### 3.1 OpenClaw 的解析逻辑

`src/agents/context-window-guard.ts` → `resolveContextWindowInfo()`:

```
优先级（从高到低）:
1. models.providers.<provider>.models[].contextWindow (modelsConfig)
2. model.contextWindow (pi-ai 模型目录)
3. DEFAULT_CONTEXT_TOKENS = 200,000 (默认值)
4. agents.defaults.contextTokens (作为上限 cap，仅在 < 以上值时生效)
```

代码：

```typescript
// src/agents/context-window-guard.ts:44-47
const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
if (capTokens && capTokens < baseInfo.tokens) {
  return { tokens: capTokens, source: "agentContextTokens" };
}
```

**这个解析结果用于**:

- Context window guard（warn < 32K, block < 16K）
- Compaction safeguard extension runtime（影响 compact 如何执行，不影响何时触发）
- Context pruning runtime
- Memory flush 阈值计算

### 3.2 上游的 compaction 触发逻辑

`node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js` → `_checkCompaction()`:

```javascript
// agent-session.js:1234 - 关键行!
const contextWindow = this.model?.contextWindow ?? 0;

// agent-session.js:1262-1264
const contextTokens = calculateContextTokens(assistantMessage.usage);
if (shouldCompact(contextTokens, contextWindow, settings)) {
  await this._runAutoCompaction("threshold", false);
}
```

`shouldCompact()` 的判断公式：

```javascript
// compaction.js:142-146
function shouldCompact(contextTokens, contextWindow, settings) {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

**`this.model?.contextWindow` 直接读取 model 对象的原生属性**，这个值来自 pi-ai 模型目录，不受 OpenClaw 的 `agents.defaults.contextTokens` 影响。

---

## 4. 具体数值分析（当前配置）

### 当前配置

```json
{
  "agents": {
    "defaults": {
      "contextTokens": 20000,
      "model": {
        "primary": "openrouter/minimax/minimax-m2.5"
      }
    }
  }
}
```

### 实际 contextWindow 值

| 来源                                 | 值          | 说明                         |
| ------------------------------------ | ----------- | ---------------------------- |
| pi-ai 模型目录 (Opus 4.6 anthropic)  | **200,000** | `models.generated.js` 中写死 |
| pi-ai 模型目录 (Opus 4.6 openrouter) | **200,000** | 同上                         |
| minimax-m2.5 (openclaw.json inline)  | **204,800** | 用户自定义的 inline model    |
| DEFAULT_CONTEXT_TOKENS               | **200,000** | OpenClaw 默认值              |
| agents.defaults.contextTokens        | **20,000**  | 用户设置的 cap               |

### Compaction 触发阈值计算

```
上游实际使用: contextWindow = model.contextWindow = 200,000 (或 204,800)
reserveTokens = max(16384, 20000) = 20,000 (OpenClaw floor)

触发条件: contextTokens > 200,000 - 20,000 = 180,000

用户期望: contextTokens > 20,000 - 20,000 = 0（立即触发）
```

**结论**: Context 需要达到 ~180K tokens 才会触发 compaction，而用户期望 20K 就触发。

---

## 5. `agents.defaults.contextTokens` 实际影响范围

| 功能                                              | 是否使用 OpenClaw cap            | 是否影响 compact 触发 |
| ------------------------------------------------- | -------------------------------- | --------------------- |
| Context Window Guard (warn/block)                 | 是                               | 否                    |
| Compaction Safeguard Extension (compact 执行方式) | 是                               | 否                    |
| Context Pruning (in-memory 裁剪)                  | 是                               | 否                    |
| Memory Flush 阈值                                 | 是（但基于错误的 contextWindow） | 否                    |
| **上游 \_checkCompaction() (compact 触发)**       | **否**                           | **否**                |
| **上游 shouldCompact() (阈值判断)**               | **否**                           | **否**                |

---

## 6. Auto-Compaction 触发的两种场景

### 场景 1: Overflow Recovery（溢出恢复）

当 LLM 返回 context overflow 错误时：

```
agent-session.js: _checkCompaction()
  → isContextOverflow(assistantMessage, contextWindow)
  → 移除错误消息
  → _runAutoCompaction("overflow", true)
  → compact + 自动重试
```

这是被动触发，只在已经超出模型限制时才发生。

### 场景 2: Threshold Maintenance（阈值维护）

每次成功的 assistant turn 后（`agent_end` 事件）：

```
agent-session.js: _checkCompaction()
  → 计算 contextTokens = calculateContextTokens(assistantMessage.usage)
  → shouldCompact(contextTokens, model.contextWindow, settings)
  → 如果 contextTokens > contextWindow - reserveTokens
  → _runAutoCompaction("threshold", false)
```

这是主动触发，但使用的是**模型原生 contextWindow**，不是 OpenClaw 的 cap。

---

## 7. OpenClaw 侧的额外机制

### 7.1 Overflow Recovery（OpenClaw 层）

`src/agents/pi-embedded-runner/run.ts` 在上游之外，额外处理 context overflow：

```typescript
// run.ts:374-409
if (isContextOverflowError(errorText)) {
  if (!isCompactionFailure && !overflowCompactionAttempted) {
    // 尝试手动触发一次 compaction
    const compactResult = await compactEmbeddedPiSessionDirect({...});
    if (compactResult.compacted) {
      continue; // 重试
    }
  }
}
```

这是 OpenClaw 对上游的补充，但只在已经发生 overflow 后才触发。

### 7.2 Compaction Safeguard Extension

当 `compaction.mode = "safeguard"` 时，OpenClaw 注册 `session_before_compact` 钩子：

- 使用自适应 chunk ratio
- 支持大消息剪枝（>50% context 的消息）
- 多阶段摘要
- 渐进式 fallback
- Tool failure 跟踪

**注意**: 这只影响 compact 执行方式，不影响何时触发。

### 7.3 Memory Flush（预 compact 记忆写入）

在 compaction 触发前，尝试写入持久记忆：

- 软阈值: `contextWindow - reserveTokens - softThresholdTokens`
- 默认 `softThresholdTokens: 4000`
- 只运行一次/compaction cycle

**问题**: Memory flush 的 contextWindow 来源也是 `resolveContextWindowInfo()`（OpenClaw cap），但实际 compaction 触发用的是上游的 model.contextWindow，两者不一致。

### 7.4 Context Pruning（内存裁剪）

- 仅 `cache-ttl` 模式下启用
- 仅在内存中裁剪 tool results，不修改 JSONL
- 使用 OpenClaw 解析的 contextWindow

---

## 8. Compaction 设置参数汇总

| 参数                                         | 默认值                                  | 来源                            | 说明                                               |
| -------------------------------------------- | --------------------------------------- | ------------------------------- | -------------------------------------------------- |
| `compaction.enabled`                         | `true`                                  | Pi settings                     | 启用/禁用 auto-compaction                          |
| `compaction.reserveTokens`                   | `16384` (Pi) / `20000` floor (OpenClaw) | Pi settings + OpenClaw override | compact 触发的预留空间                             |
| `compaction.keepRecentTokens`                | `20000`                                 | Pi settings                     | compact 后保留的最近消息 tokens                    |
| `compaction.reserveTokensFloor`              | `20000`                                 | OpenClaw                        | OpenClaw 对 reserveTokens 的最低保障               |
| `compaction.mode`                            | `"default"`                             | OpenClaw                        | `"safeguard"` 启用增强 compact 扩展                |
| `compaction.maxHistoryShare`                 | `0.5`                                   | OpenClaw                        | safeguard 模式下历史占 context 的最大比例          |
| `compaction.memoryFlush.enabled`             | `true`                                  | OpenClaw                        | 启用预 compact 记忆写入                            |
| `compaction.memoryFlush.softThresholdTokens` | `4000`                                  | OpenClaw                        | compact 阈值前多少 tokens 触发 flush               |
| `agents.defaults.contextTokens`              | 未设置                                  | OpenClaw                        | context window 上限 cap（**不影响 compact 触发**） |

---

## 9. 数据流图

```
用户消息 → Gateway → runEmbeddedPiAgent()
                         │
                         ├── resolveModel() → model (contextWindow=200K from pi-ai catalog)
                         │
                         ├── resolveContextWindowInfo() → 20K (OpenClaw cap)
                         │   └── 用于: guard, safeguard extension, pruning, flush
                         │
                         ├── createAgentSession({ model }) → AgentSession
                         │   │
                         │   └── model.contextWindow = 200K (未修改!)
                         │
                         └── Agent Loop:
                             │
                             ├── [turn completes] → agent_end event
                             │
                             └── _checkCompaction(assistantMessage)
                                 │
                                 ├── contextWindow = this.model.contextWindow = 200K
                                 ├── contextTokens = calculateContextTokens(usage)
                                 │
                                 └── shouldCompact(tokens, 200K, {reserveTokens: 20K})
                                     │
                                     └── tokens > 200K - 20K = 180K ?
                                         │
                                         ├── Yes → _runAutoCompaction()
                                         └── No  → 不触发（当前情况）
```

---

## 10. 潜在解决方案分析

### 方案 A: 修改 model 的 contextWindow（最直接）

在传给 `createAgentSession()` 之前，用 OpenClaw 解析的 contextWindow 覆盖 model 对象的 `contextWindow` 属性。

```typescript
// 在 attempt.ts 中 createAgentSession 之前
const resolvedCtxTokens = resolveContextWindowInfo({...}).tokens;
const modelWithCap = { ...params.model, contextWindow: resolvedCtxTokens };
({ session } = await createAgentSession({
  model: modelWithCap, // 使用 capped contextWindow
  ...
}));
```

**优点**: 最简单，直接在传递点修改
**缺点**: 可能影响上游其他依赖 model.contextWindow 的逻辑（如 token estimation, overflow detection）

### 方案 B: 通过 models.providers 配置 contextWindow

在 `openclaw.json` 中直接为每个 model 设置 `contextWindow`:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "models": [{ "id": "claude-opus-4-6", "contextWindow": 20000 }]
      }
    }
  }
}
```

这会通过 `ensureOpenClawModelsJson()` 写入 `models.json`，被上游的 model registry 读取。

**优点**: 不需要改代码，利用现有机制
**缺点**: 需要为每个 model 单独配置；可能影响 overflow detection（模型实际支持 200K 但被告知只有 20K）
**验证需要**: 确认 model registry 是否会用 models.json 中的 contextWindow 覆盖模型目录的值

### 方案 C: 上游支持 contextWindow override

向上游 pi-coding-agent 提 PR，在 `SettingsManager` 中添加 `contextWindowOverride` 设置。

**优点**: 最正确的架构解决方案
**缺点**: 依赖上游接受和发布

### 方案 D: 通过 extension hook 拦截

使用 `session_before_compact` 之外的机制（如果上游提供 `agent_end` 扩展点）来手动检查并触发 compaction。

**优点**: 不修改上游
**缺点**: 上游可能没有合适的 hook 点

---

## 11. 当前 workaround

在上游修复之前，可以通过**方案 B**（`models.providers` 配置）来间接实现，但需要验证 model registry 的行为。

如果方案 B 不可行，最实际的是**方案 A**：在 `attempt.ts` 中修改传递给上游的 model 对象。

---

## 12. 相关代码文件索引

| 文件                                               | 作用                                  |
| -------------------------------------------------- | ------------------------------------- |
| `src/agents/context-window-guard.ts`               | OpenClaw context window 解析 + guard  |
| `src/agents/defaults.ts`                           | `DEFAULT_CONTEXT_TOKENS = 200,000`    |
| `src/agents/compaction.ts`                         | OpenClaw compaction 辅助函数          |
| `src/agents/pi-settings.ts`                        | `ensurePiCompactionReserveTokens()`   |
| `src/agents/pi-embedded-runner/run.ts`             | 嵌入式 agent 运行 + overflow recovery |
| `src/agents/pi-embedded-runner/run/attempt.ts`     | `createAgentSession()` 调用点         |
| `src/agents/pi-embedded-runner/extensions.ts`      | 构建扩展路径 + runtime 设置           |
| `src/agents/pi-extensions/compaction-safeguard.ts` | Safeguard compaction 扩展             |
| `src/agents/models-config.ts`                      | `ensureOpenClawModelsJson()`          |
| `pi-coding-agent/.../agent-session.js`             | 上游 `_checkCompaction()`             |
| `pi-coding-agent/.../compaction/compaction.js`     | 上游 `shouldCompact()`                |
| `pi-coding-agent/.../settings-manager.js`          | 上游 compaction settings              |
| `pi-ai/.../models.generated.js`                    | 模型目录（contextWindow 定义）        |

## 13. 相关文档

- [context-compact-architecture.md](context-compact-architecture.md) - Compact 系统完整架构设计（原理、对比、改进建议）
- `docs/concepts/compaction.md` - compaction 概念文档
- `docs/reference/session-management-compaction.md` - session 管理与 compaction 深度文档
- `docs/her/cost-analysis-and-billing.md` - 费用分析（包含 context window 溢出的历史分析）
- `docs/concepts/session-pruning.md` - session pruning 文档
- `docs/token-use.md` - token 使用文档

---

## 14. 当前状态与实验记录

### 14.1 已做的改动

| 改动               | 文件                        | 内容                                                  | 状态                   |
| ------------------ | --------------------------- | ----------------------------------------------------- | ---------------------- |
| contextWindow 降低 | `~/.openclaw/openclaw.json` | minimax-m2.5 的 `contextWindow` 从 **204800 → 40000** | **已生效，未提交 git** |

原始值备份：`"contextWindow": 204800`，回退只需改回这一行。

### 14.2 实验结果 (2026-02-15)

**测试 session**: `458b90bd-3a3c-4ad9-b708-0f13ae64866b`

| 轮次             | 内容                           | totalTokens | 触发 compact | compact 结果                                    |
| ---------------- | ------------------------------ | ----------- | ------------ | ----------------------------------------------- |
| L6 问候          | Hey天哥                        | 17,635      | 否 (< 20K)   | -                                               |
| L10 5000字化学文 | 化学学科五千年发展史           | 23,381      | 是 (> 20K)   | summary 为空 (firstKept=L2, 实际未丢弃任何消息) |
| L13 短回复       | 哈哈天哥你说啥                 | 23,769      | 是 (> 20K)   | summary 为空 (**7条消息被丢弃，包括5000字文**)  |
| L16 500字AI史    | AI发展简史                     | 18,025      | 否 (< 20K)   | -                                               |
| L22 回忆测试     | 通过 sessions_history 工具回忆 | 27,154      | 是           | summary 为空                                    |
| L35 prompt输出   | 完整输出prompt内容             | 35,653      | 是           | summary 为空                                    |

**关键发现**:

1. **compaction 触发机制生效** -- 阈值 = 40000 - 20000 = 20000，所有 > 20K 的 turn 都正确触发
2. **compaction summary 全部失败** -- minimax 模型无法正确处理上游的 `<conversation>` 标签摘要格式，所有 summary 都是 "conversation is empty"
3. **`fromHook: false`** -- 使用的是上游默认摘要器，不是 OpenClaw safeguard 扩展
4. **AI 可通过 `sessions_history` 工具回忆历史** -- JSONL 文件永不删除，工具可读取完整历史
5. **第一次 compact 是空操作** -- keepRecentTokens(20K) ≈ totalTokens(23K)，所有消息都被保留
6. **第二次 compact 才真正丢弃** -- 5000字文和之前对话从 context 中移除，但 summary 为空导致记忆丢失

### 14.3 Opus 4.6 测试 (2026-02-15 10:45-11:00)

**配置**: Opus 4.6 主模型 + contextWindow: 40000（快速测试值）

| 事件                 | tokens    | 结果                                        |
| -------------------- | --------- | ------------------------------------------- |
| L51 第一轮回复       | 22,124    | 正常，未触发 compact                        |
| L53 工具链完成       | 35,041    | 触发 compact (fromHook=false, 空 summary)   |
| L56-L63 工具链 (4轮) | 35K → 64K | **远超 40K 上限**，工具链期间不触发 compact |
| L64 compact          | 64,199    | 空 summary，session 进入异常状态            |
| 用户消息             | -         | **2 分钟超时，AI 无响应**                   |
| /new 后 cron session | 21,852    | 又触发 compact，又超时                      |

**关键教训**: 40K 对 Opus 4.6 完全不可用。Opus 的 system prompt + 工具定义 ≈ 18K，加一轮对话就到阈值。工具链期间 token 可以无限增长（compaction 只在 agent_end 后触发）。

### 14.4 已确认的事实

| 项目                                    | 确认值                           | 来源                    |
| --------------------------------------- | -------------------------------- | ----------------------- |
| OpenRouter Opus 4.6 context_length      | **1,000,000** (1M)               | OpenRouter API          |
| Anthropic 官方 context window           | 200K (默认) / 1M (beta)          | docs.anthropic.com      |
| pi-ai 模型目录 contextWindow            | 200,000                          | models.generated.js     |
| OpenRouter > 200K 定价                  | premium ($10/$37.5 per MTok)     | OpenRouter docs         |
| Opus 4.6 max output                     | 128,000                          | Anthropic 官方          |
| upstream reserveTokens 默认             | 16,384                           | settings-manager.js     |
| upstream keepRecentTokens 默认          | 20,000                           | settings-manager.js     |
| `models.providers` contextWindow 优先级 | 最高 (> model catalog > default) | context-window-guard.ts |

### 14.5 企业级部署配置 (240K)

**当前配置** (`~/.openclaw/openclaw.json` + `docker/carher-config.json`):

```json
{
  "agents": {
    "defaults": {
      "contextTokens": 240000,
      "model": { "primary": "openrouter/anthropic/claude-opus-4.6" },
      "compaction": { "mode": "safeguard" }
    }
  },
  "models": {
    "providers": {
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "models": [
          {
            "id": "anthropic/claude-opus-4.6",
            "contextWindow": 240000,
            "maxTokens": 128000
          }
        ]
      }
    }
  }
}
```

**关键**: `contextTokens` 和 `contextWindow` 必须对齐（2026-02-15 实测验证）。

**效果**:

- compaction 触发点: 240K - 16K = **224K tokens**
- 避免 OpenRouter > 200K premium 定价（240K 仍在安全范围内）
- 工具链空间充足（224K 足够处理复杂多轮工具调用）

### 14.6 已解决：两套 context 配置的混淆

> **已解决（2026-02-15）**: 两个值已统一为 240K，不再混淆。以下为原始问题记录。

**原始问题**: `/status` 显示 `Context: 34k/20k (172%)` 中的 "20k" 来自 `agents.defaults.contextTokens: 20000`（OpenClaw 内部 cap），而**实际 compaction 阈值是 184K**（来自 `models.providers...contextWindow: 200000`）。

两者是独立的系统：

| 配置                               | 原始值  | 当前值      | 实际控制什么                                         |
| ---------------------------------- | ------- | ----------- | ---------------------------------------------------- |
| `agents.defaults.contextTokens`    | 20,000  | **240,000** | OpenClaw /status 显示的 cap + safeguard runtime 参考 |
| `models.providers...contextWindow` | 200,000 | **240,000** | upstream pi-coding-agent 的 compaction 触发          |

这是**架构断层**的表现：OpenClaw 的 `contextTokens` 不传递给 upstream compaction 逻辑。**解决方案**: 将两个值手动对齐为 240K。

### 14.7 已完成工作

- [x] ~~contextWindow 配置方案验证~~ — `models.providers` 配置有效，已在 minimax + Opus 测试验证
- [x] ~~企业级 240K 部署配置~~ — 已配置并同步本地 + Docker carher-4
- [x] ~~Docker Browser Use 修复~~ — 根因: stale SingletonLock，已修复 entrypoint + 手动清理
- [x] ~~Skills 统一到 repo~~ — 删除 workspace skills，强制 repo-only 管理
- [x] ~~`/status` 显示修复~~ — 本地 + Docker: `contextTokens` 和 `contextWindow` 对齐为 240K
- [x] ~~Docker 配置同步~~ — `carher-config.json` 已包含 contextTokens + compaction + 双模型定义
- [x] ~~CardKit 状态 footer~~ — 每条飞书 AI 回复底部显示 `🧠 **模型名** · 📊 Xk/240k (Y%) · 🧹 N次压缩`
- [x] ~~compaction 架构断层实测确认~~ — contextTokens (cap) 与 contextWindow (compaction 阈值) 必须对齐，否则 compaction 永远不触发

**第一阶段总结（2026-02-15 完成）**：

| 环境            | 模型                | contextTokens | contextWindow | compaction | browser       | 状态            |
| --------------- | ------------------- | ------------- | ------------- | ---------- | ------------- | --------------- |
| 本地 Her        | Opus 4.6            | 240K          | 240K          | safeguard  | 未验证        | 配置完成        |
| Docker carher-4 | Sonnet 4 / Opus 4.6 | 240K          | 240K          | safeguard  | Chrome 运行中 | 配置完成 + 验证 |

### 14.8 Claude Setup-Token 的 200K 上下文限制 (2026-02-19)

**问题**: 使用 Claude Max 订阅 + setup-token 直连 Anthropic 时，配置了 `contextWindow: 1000000` 和 `context-1m-2025-08-07` beta header，导致所有请求返回 429：

```
429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for long context requests."}}
```

**错误日志** (session `9ee03d04-1d80-4413-9bc5-b9a0cc6438d9`, 2026-02-19 08:14):

```
model-snapshot: provider=anthropic, modelApi=anthropic-messages, modelId=claude-opus-4-6
429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for long context requests."},"request_id":"req_011CYGTox76PRdZBvJwkVQEx"}
429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for long context requests."},"request_id":"req_011CYGTpM11ASLgnhkMx8u1V"}
429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for long context requests."},"request_id":"req_011CYGTpwuiMF8sFxhU8i5Po"}
```

连续 3 次重试全部 429，session 进入错误状态。

**根因链路**:

1. 配置中加了 `context-1m-2025-08-07` header → 启用了 1M 上下文窗口
2. Anthropic 检测到 long context request（>200K）→ 要求开启 "Extra usage"
3. 开启 "Extra usage" 需要在 claude.ai → Settings → Usage 底部打开开关
4. 该开关需要绑定信用卡（额外付费），对于已付 $240 Max 订阅的用户不合理

**结论（二选一）**:

| 方案                             | 配置                                    | 上下文上限 | 限制                                          |
| -------------------------------- | --------------------------------------- | ---------- | --------------------------------------------- |
| **Anthropic 直连 (setup-token)** | 默认 200K，**不加** `context-1m` header | 200K       | 无需额外付费，Max 订阅内                      |
| **OpenRouter**                   | 可自由设置 200K–1M                      | 取决于配置 | OpenRouter 按 token 计费，无 Extra usage 限制 |

**规则（必须遵守）**:

- Anthropic 直连（setup-token auth）: `contextWindow` **不超过 200000**，`anthropic-beta` header **不包含** `context-1m-2025-08-07`
- OpenRouter: `contextWindow` 可根据需要设置（当前 240K）
- `agents.defaults.contextTokens` 作为全局 cap，不影响此限制（cap 只向下生效）

**配置变更记录**:

| 文件                               | 变更                    | 原值                       | 新值        |
| ---------------------------------- | ----------------------- | -------------------------- | ----------- |
| `~/.openclaw/openclaw.json` (本地) | anthropic contextWindow | 1,000,000                  | 200,000     |
| `~/.openclaw/openclaw.json` (本地) | anthropic-beta header   | 含 `context-1m-2025-08-07` | 移除该 flag |
| `docker/carher-config.json`        | anthropic contextWindow | 1,000,000                  | 200,000     |
| `docker/carher-config.json`        | anthropic-beta header   | 含 `context-1m-2025-08-07` | 移除该 flag |

### 14.9 待解决问题 (TODO)

- [ ] **P0: session 异常静默失败 + 用户无感知** — 当 session 因 compaction 失败/token 超限进入异常状态后：
  - 用户在飞书端发消息，gateway 收到但 agent 无响应
  - 飞书只看到 "typing TTL reached (2m)" 然后完全静默
  - **用户完全不知道发生了什么**，无法自行恢复
  - **需要方案**: 飞书插件捕获此异常，主动发消息提醒用户发 `/new` 开始新 session
  - 需要定义检测条件：typing TTL reached + 无 assistant 响应 = session 异常
  - **可修改范围**: `extensions/feishu-her/`（自有插件代码）
- [ ] **P0: compaction summary 质量 (fromHook: false)** — OpenClaw 代码 bug，safeguard 扩展未接入
  - 根因: `attempt.ts:613` `buildEmbeddedExtensionPaths()` 返回值被丢弃，extension paths 未传给 `createAgentSession`
  - 修复需要改 `src/`（upstream），需提 GitHub issue/PR
  - 200K 下影响较小（compaction 极少触发），但触发时 summary 仍为空
- [ ] **P1: 向 OpenClaw 上游提 issue** — safeguard extension wiring bug
- [ ] **P1: 本地 Her browser use 验证** — Docker 已确认工作，本地 Mac 环境未验证
- [ ] **P2: 验证 240K 配置下 compaction 正确性** — 需要长对话测试（超过 240K 才触发）
- [x] ~~**P2: entrypoint 永久修复上线**~~ — `carher-entrypoint.sh` 修改已烤入 Docker 镜像（2026-02-15 重建确认）

### 14.8 Docker Browser Use 故障根因与修复 (2025-02-15)

**现象**: Docker 容器中 AI 无法使用 browser tool

- 第一次调用 → "Sandbox browser is unavailable"（AI 选了 target=sandbox）
- 第二次调用 → "Can't reach the openclaw browser control service (timed out)"

**根因**: Chrome `SingletonLock` 文件阻止启动

Docker 容器每次重启 hostname 变化（如 `2c404b3d7403` → `e49c3bce4df2`），但 `/data/` 持久卷上的 Chrome profile 目录保留了旧容器的 `SingletonLock` 锁文件。Chromium 启动时检测到锁文件指向不同 hostname，认为另一个进程正在使用该 profile，拒绝启动。

错误链：

```
1. gateway 启动 → browser control service "ready"（不启动 Chrome，lazy launch）
2. AI 使用 browser tool → 触发 Chrome 启动
3. Chrome 检测到 SingletonLock → "profile in use by another computer"
4. Chrome 退出 → CDP 永远不可达 → 15秒超时
5. 错误包装为 "Can't reach the openclaw browser control service"
```

**修复**:

- 临时: 手动删除 `/data/.openclaw/browser/*/user-data/SingletonLock` 等文件
- 永久: 在 `scripts/carher-entrypoint.sh` 添加容器启动时自动清理

```bash
# Clean stale Chrome singleton locks
find /data/.openclaw/browser -name "SingletonLock" -o -name "SingletonSocket" -o -name "SingletonCookie" | xargs rm -f
```

**架构要点**:

- 重构后（`e7fdccce3`），browser tool 使用 in-process dispatch，不走 HTTP
- browser control server 不再单独开端口（18791），而是通过 gateway 内部调用
- Chrome lazy launch：service "ready" 不等于 Chrome 运行，首次 browser action 才启动
- `ensureProfileCleanExit()` 只清理 Preferences 中的 exit_type，不清理 SingletonLock

### 14.10 当前配置快照 (2026-02-15)

**本地 Her** (`~/.openclaw/openclaw.json`):

- `agents.defaults.contextTokens`: 240,000
- `agents.defaults.compaction.mode`: safeguard
- `agents.defaults.model.primary`: openrouter/anthropic/claude-opus-4.6
- `models.providers`: sonnet-4.6 (contextWindow=240000) + opus-4.6 (contextWindow=240000)

**Docker carher-4** (`/data/.openclaw/openclaw.json`, 基于 `docker/carher-config.json`):

- `agents.defaults.contextTokens`: 240,000
- `agents.defaults.compaction.mode`: safeguard
- `agents.defaults.model.primary`: openrouter/anthropic/claude-sonnet-4.6
- `models.providers`: sonnet-4.6 (contextWindow=240000) + opus-4.6 (contextWindow=240000)
- `browser`: enabled + headless + noSandbox

### 14.11 CardKit 状态 Footer (2026-02-15)

每条飞书 AI 回复的 CardKit 卡片底部自动追加状态行，数据源复用 `/status` 的 session store。

**格式**：

- 正常: `🧠 **Opus 4.6** · 📊 42k/240k (18%) · 🧹 0次压缩`
- 警告 (>=70%): `⚠️ **Opus 4.6** · 📊 170k/240k (71%) · 🧹 2次压缩`

**实现**: `extensions/feishu-her/src/gateway.ts`

- `buildCardStatusFooter()`: dispatch 完成后读 session store，格式化 model + totalTokens/contextTokens + compactionCount
- 追加到 `cardStreamFinalText`，在 `stopCardStream()` 之前写入卡片

**关键发现（实测）**: `contextTokens` (OpenClaw cap) 和 `contextWindow` (模型定义) 必须对齐。如果只改 `contextTokens` 而不改 `contextWindow`，pi-coding-agent 仍然用 `contextWindow` 做 compaction 判断，导致 compaction 永远不触发。
