---
name: upgrade-model
description: Add or upgrade LLM models in OpenClaw. Use when the user asks to add a new model, change/upgrade/switch models, or mentions a new model version like opus 4.6, gpt-5, gemini-3.1, etc.
---

# Add / Upgrade LLM Model

## 核心认知

OpenClaw 对 OpenRouter 和 Anthropic 直连**没有**模型自动发现。新增模型必须手动定义元数据。

## 配置体系（必须理解）

### 本地 Her

```
~/.openclaw/openclaw.json
  └─ $include → ~/.openclaw/shared-config.json5（如果有）
```

一个文件搞定。模型定义 + 白名单 + primary 都在这里。

### Docker 容器（CarHer）

```
/tmp/carher-config-N.json       ← start-user.sh 自动生成（per-user）
  └─ $include → docker/carher-config.json     ← 模型定义在这里
       └─ $include → docker/shared-config.json5  ← 共享功能配置
```

**关键**：Docker 用户的配置是**三层 $include 链**：

| 层级 | 文件                         | 包含什么                                 | 谁写的                        |
| ---- | ---------------------------- | ---------------------------------------- | ----------------------------- |
| 顶层 | `/tmp/carher-config-N.json`  | model.primary + 白名单 + 飞书凭证        | `start-user.sh` Python 生成器 |
| 中层 | `docker/carher-config.json`  | 模型定义（models.providers.\*.models[]） | 人工维护                      |
| 底层 | `docker/shared-config.json5` | memorySearch、tools、tts 等共享功能      | 人工维护                      |

**用户默认模型来源**：`docker/users.csv` 的 model 列（短名如 `sonnet`、`opus`、`gemini-3.1`）

容器内 `/data/.openclaw/openclaw.json` 是 **read-only bind mount**，指向 `/tmp/carher-config-N.json`。永远不要 `docker exec` 写容器内配置。

## 新增 OpenRouter 模型：完整 Checklist

### Step 1：从 OpenRouter 获取模型元数据（不要猜！）

```bash
# 网页查看
open https://openrouter.ai/<provider>/<model-id>

# 或 API 获取
curl -s https://openrouter.ai/api/v1/models | \
  jq '.data[] | select(.id == "google/gemini-3.1-pro-preview") | {id, context_length, pricing}'
```

**字段映射**：

- `context_length` → `contextWindow`
- `max_completion_tokens` → `maxTokens`
- 页面 Pricing 表 → `cost.input / output / cacheRead / cacheWrite`（单位：$/M tokens）

> **警告**：不同 provider 的 cacheWrite 比例不同！Anthropic 是 input×1.25，Google 不是。不要套用公式推算，去官网查！

### Step 2：添加模型定义（2 个文件）

#### 2a. `~/.openclaw/openclaw.json`（本地 Her）

在 `models.providers.openrouter.models[]` 数组中添加：

```json
{
  "id": "google/gemini-3.1-pro-preview",
  "name": "Gemini 3.1 Pro",
  "api": "openai-completions",
  "reasoning": true,
  "input": ["text", "image", "audio", "video"],
  "contextWindow": 1048576,
  "maxTokens": 65536,
  "cost": { "input": 2, "output": 12, "cacheRead": 0.2, "cacheWrite": 0.375 }
}
```

#### 2b. `docker/carher-config.json`（Docker 基础配置）

在 `models.providers.openrouter.models[]` 中添加**同样的**模型定义。

> 注意：如果是 Anthropic 直连模型，还需要在 `models.providers.anthropic.models[]` 中添加（`api` 用 `"anthropic-messages"`，`id` 用连字符格式如 `claude-opus-4-6`）。

### Step 3：添加白名单 alias（2 个文件）

白名单让用户可以通过 `/model <alias>` 切换到新模型。

#### 3a. `~/.openclaw/openclaw.json`（本地 Her）

在 `agents.defaults.models` 中添加：

```json
"openrouter/google/gemini-3.1-pro-preview": { "alias": "gemini" }
```

> **注意**：白名单 key 用 `openrouter/` 前缀（provider-qualified），模型定义的 `id` 不带前缀。

#### 3b. `start-user.sh` Python 配置生成器（Docker 用户）

在 `~行 443-458` 的 **两个 provider 分支**（`if provider == 'anthropic'` 和 `else`）的 `agents['defaults']['models']` 中都添加：

```python
'openrouter/google/gemini-3.1-pro-preview': {'alias': 'gemini'},
```

> **两个分支都要加**，否则某些 Docker 用户看不到新模型。

### Step 4：添加短名映射（1 个文件）

#### `start-user.sh` 的 `resolve_model()` 函数（~行 34-47）

添加短名 → 完整 ID 的映射，让 `docker/users.csv` 和 `--model=` 参数可以用短名：

```bash
gemini-3.1|gemini-3.1-pro) echo "openrouter/google/gemini-3.1-pro-preview" ;;
```

### Step 5（可选）：设为某 Docker 用户的默认模型

编辑 `docker/users.csv` 的 model 列（用短名），然后正常启动：

```csv
1,测试用户,gemini-3.1,cli_xxx,...
```

```bash
./start-user.sh --id=1
```

这就够了。`start-user.sh` 会从 CSV 读取 model 列并自动 resolve。

模型优先级（高到低）：CLI `--model=`（临时覆盖，不改 CSV） > `users.csv` model 列（标准做法） > `carher-config.json` 中的 `agents.defaults.model.primary`

### Step 6：验证

```bash
# Docker 容器验证
docker exec carher-N python3 -c \
  'import json; d=json.load(open("/data/.openclaw/openclaw.json")); print(d["agents"]["defaults"]["model"]["primary"])'

# 日志确认
docker logs carher-N --tail 50 2>&1 | grep -i 'model\|gemini'
```

## 涉及文件总结

| 文件                            | 改什么                       | 本地 Her | Docker |
| ------------------------------- | ---------------------------- | -------- | ------ |
| `~/.openclaw/openclaw.json`     | 模型定义 + 白名单 + primary  | ✅       | —      |
| `docker/carher-config.json`     | 模型定义（$include 链中层）  | —        | ✅     |
| `start-user.sh` resolve_model() | 短名 → 完整 ID 映射          | —        | ✅     |
| `start-user.sh` Python 生成器   | 白名单（两个 provider 分支） | —        | ✅     |
| `docker/users.csv`              | 用户默认模型（可选，用短名） | —        | ✅     |

## 升级上游依赖中的模型

如果新模型已被 `@mariozechner/pi-ai`（`models.generated.js`）内置支持，可以不手动定义：

1. `npm view @mariozechner/pi-ai version` 检查最新版
2. 如果已有 → 升级四个 `@mariozechner/pi-*` 包（必须同版本）
3. 如果没有 → 手动定义（按上面的 Checklist），待上游跟进后删除

## Compaction 触发与 contextWindow 对齐（极其重要）

**`agents.defaults.contextTokens` 不控制 compact 触发！** compact 触发完全由 `model.contextWindow` 决定。

上游 pi-coding-agent 的触发公式：

```
shouldCompact(contextTokens, contextWindow):
  return contextTokens > contextWindow - reserveTokens
```

其中 `contextWindow` = `models.providers.<provider>.models[].contextWindow`，`reserveTokens` = max(16384, 20000)。

**`contextTokens` 只影响**: Context Window Guard 显示、Safeguard extension runtime、Context Pruning、Memory Flush 阈值。

**如果要让 compact 在 N tokens 时触发**，必须同时设置：

1. `models.providers.<provider>.models[].contextWindow` = N（控制 compact 何时触发）
2. `agents.defaults.contextTokens` = N（控制其他子系统的 cap）

两个值必须对齐，否则 compact 永远不触发。详见 `docs/her/context-window-architecture.md` 第 4-11 节。

## 热更新 vs 重启

修改 `openclaw.json` 后仍需 gateway restart 才能生效。通过 `gateway config.patch` 或 `/restart` 可自动触发，不需要手动重启进程。

| 配置项                          | 改后生效方式    | 说明                                  |
| ------------------------------- | --------------- | ------------------------------------- |
| `models.providers.*` 模型定义   | gateway restart | config.patch 自动触发                 |
| `agents.defaults.models` 白名单 | gateway restart | restart 后 `/model` 立即可见          |
| `agents.defaults.model.primary` | gateway restart | 新 session 使用新模型                 |
| 依赖升级（pi-ai 等）            | ❌ 需完整重启   | start.sh / start-user.sh 重启         |
| Docker 容器配置                 | ❌ 需重建       | `./start-user.sh --id=N --no-rebuild` |

## Quick Mapping（当前短名）

"有模型定义"指 `carher-config.json` 或 `openclaw.json` 中有完整的 cost/context 元数据。无定义的短名仅在 `resolve_model()` 中有映射，OpenRouter 会兜底处理，但缺少正确的 cost tracking 和 context window 限制。

### 本地 Her（`~/.openclaw/openclaw.json` 白名单）

| Alias       | 完整 ID                                    | 有模型定义 |
| ----------- | ------------------------------------------ | ---------- |
| `opus`      | `anthropic/claude-opus-4-6`                | ✅         |
| `sonnet`    | `anthropic/claude-sonnet-4-6`              | ✅         |
| `or-opus`   | `openrouter/anthropic/claude-opus-4.6`     | ✅         |
| `or-sonnet` | `openrouter/anthropic/claude-sonnet-4.6`   | ✅         |
| `gemini`    | `openrouter/google/gemini-3.1-pro-preview` | ✅         |
| `minimax`   | `openrouter/minimax/minimax-m2.5`          | ✅         |

> **直连 vs OpenRouter 同模型**：`opus`（Anthropic 直连）更便宜、延迟更低；`or-opus`（OpenRouter）有 fallback 和统一计费。

### Docker（`start-user.sh` resolve_model）

| 短名                            | 完整 ID                                                                                   | 有模型定义    |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ------------- |
| `sonnet` / `sonnet-4.6`         | 按 provider 分：`anthropic/claude-sonnet-4-6` 或 `openrouter/anthropic/claude-sonnet-4.6` | ✅            |
| `opus` / `opus-4.6`             | 按 provider 分：`anthropic/claude-opus-4-6` 或 `openrouter/anthropic/claude-opus-4.6`     | ✅            |
| `gemini-3.1` / `gemini-3.1-pro` | `openrouter/google/gemini-3.1-pro-preview`                                                | ✅            |
| `haiku` / `haiku-3.5`           | `openrouter/anthropic/claude-3.5-haiku`                                                   | ❌ 仅短名映射 |
| `gemini-2.5` / `gemini-pro`     | `openrouter/google/gemini-2.5-pro-preview`                                                | ❌ 仅短名映射 |
| `gemini-flash`                  | `openrouter/google/gemini-2.0-flash-001`                                                  | ❌ 仅短名映射 |
| `gpt-4o`                        | `openrouter/openai/gpt-4o`                                                                | ❌ 仅短名映射 |
| `gpt-4o-mini`                   | `openrouter/openai/gpt-4o-mini`                                                           | ❌ 仅短名映射 |
| `minimax` / `minimax-m2.5`      | `openrouter/minimax/minimax-m2.5`                                                         | ✅            |
