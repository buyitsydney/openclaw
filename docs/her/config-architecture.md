# CarHer 配置架构

> 日期: 2026-02-27
> 状态: 现状记录 + 改进建议

---

## 1. 概述

CarHer 有 3 类运行环境，共 4 个配置层级。所有环境通过 `$include` 指令共享同一份基础功能配置（`shared-config.json5`），各自只覆盖环境特有的部分。

| 环境           | 实例数 | 说明                            |
| -------------- | ------ | ------------------------------- |
| Mac 本地 Her   | 1      | 管理员日常使用，macOS 原生进程  |
| S1 Admin Her   | 1      | 服务器上的管理员 Her，tmux 进程 |
| S1 Docker 容器 | 8-14   | 每个员工一个独立容器            |

---

## 2. `$include` 合并机制

OpenClaw 配置支持 `$include` 指令，合并规则（源码: `src/config/includes.ts`）:

```
included file (被包含文件) → 先加载
including file (包含文件) → 后加载，同名 key 覆盖 included 的值
```

**关键规则: sibling keys override included values（同级 key 覆盖被包含的值）**

示例：

```json5
// base.json (被包含)
{ "a": 1, "b": 2 }

// overlay.json (包含方)
{ "$include": "./base.json", "b": 99 }

// 合并结果
{ "a": 1, "b": 99 }  // b 被 overlay 覆盖
```

对于嵌套对象，执行 deep merge:

```json5
// base.json
{ "agents": { "defaults": { "contextTokens": 200000, "compaction": { "mode": "safeguard" } } } }

// overlay.json
{ "$include": "./base.json", "agents": { "defaults": { "model": { "primary": "opus" } } } }

// 合并结果 — deep merge，不同 key 合并，同名 key 覆盖
{ "agents": { "defaults": { "contextTokens": 200000, "compaction": { "mode": "safeguard" }, "model": { "primary": "opus" } } } }
```

---

## 3. 配置文件清单

### 3.1 repo 管控的配置文件（Git truth source）

| 文件                | 路径                                         | 用途                                                     |
| ------------------- | -------------------------------------------- | -------------------------------------------------------- |
| shared-config.json5 | `docker/shared-config.json5`                 | 所有环境共享的功能配置                                   |
| carher-config.json  | `docker/carher-config.json`                  | Docker 容器共享的中间层                                  |
| user-configs/       | `docker/user-configs/carher-config-{N}.json` | 每个 Docker 用户的个性化配置（`start-user.sh` 自动生成） |

### 3.2 运行时配置文件（不在 Git 中）

| 文件                         | 位置                                       | 用途                                        |
| ---------------------------- | ------------------------------------------ | ------------------------------------------- |
| Mac 本地 Her openclaw.json   | `~/.openclaw/openclaw.json`                | Mac 本地 Her 主配置                         |
| Mac 本地 shared-config.json5 | `~/.openclaw/shared-config.json5`          | Mac 本地 shared-config 副本（当前未被引用） |
| S1 Admin openclaw.json       | `/home/cltx/.openclaw/openclaw.json`       | S1 Admin Her 主配置                         |
| S1 Admin shared-config.json5 | `/home/cltx/.openclaw/shared-config.json5` | S1 Admin Her 的 shared-config 副本          |

---

## 4. 三类环境的配置层级

### 4.1 Mac 本地 Her（当前: 不使用 $include）

```
~/.openclaw/openclaw.json    ← 独立配置，所有内容直写
```

- 直写了 `contextTokens: 200000`、`compaction`、`memorySearch`、`models`、`tools`、`messages` 等全部配置
- 不使用 `$include`，与 `shared-config.json5` 完全独立
- `~/.openclaw/shared-config.json5` 存在但未被引用

**特有配置:**

- `env.vars` (Anthropic/OpenRouter/Groq API keys)
- `models.providers.anthropic.apiKey` (直连 Anthropic API)
- `browser.headless: false`
- `gateway.bind: loopback`, `gateway.auth.mode: none`
- `channels.telegram`, `channels.imessage`
- `commands.restart: true`

### 4.2 S1 Admin Her（使用 $include → shared-config.json5）

```
/home/cltx/.openclaw/openclaw.json
    └── $include: ./shared-config.json5    ← 2 层
```

- 继承 shared-config 的: `contextTokens`、`compaction`、`memorySearch`、`tools`、`messages`、`browser`、`plugins`、`channels.feishu` 基础
- 自己定义: `env`、`gateway`、`agents.defaults.model`、`channels.feishu` 凭证、`commands.ownerAllowFrom`、`plugins.entries.realtime`
- **不定义 `models` provider** — 使用 SDK 内置默认 model 列表

**特有配置:**

- `gateway.bind: lan`, `gateway.auth.mode: token`
- `commands.ownerAllowFrom` (限制飞书管理命令的用户范围)

### 4.3 S1 Docker 容器（3 层 $include 链）

```
/data/.openclaw/openclaw.json           ← 每用户 (start-user.sh 生成)
    └── $include: ./carher-config.json  ← Docker 共享层
            └── $include: ./shared-config.json5  ← 全局共享层
```

**挂载方式** (来自 `start-user.sh`):

```bash
-v "carher-${USER_ID}-data:/data/.openclaw"                                      # named volume (持久数据)
-v "${CONFIG_MOUNT}:/data/.openclaw/openclaw.json:ro"                             # per-user config (bind mount)
-v "${SCRIPT_DIR}/docker/carher-config.json:/data/.openclaw/carher-config.json:ro"  # Docker 共享层 (bind mount)
-v "${SCRIPT_DIR}/docker/shared-config.json5:/data/.openclaw/shared-config.json5:ro" # 全局共享层 (bind mount)
```

Docker 配置是 **bind mount**，直接读 repo 目录下的文件。所以 `git pull` 后文件立即更新，但需要重启容器才能生效（gateway 启动时加载配置）。

**三层职责分工:**

| 层               | 文件                | 职责                                                                                              |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| L1 (全局共享)    | shared-config.json5 | contextTokens, compaction, memorySearch, tools, messages, browser 基础, plugins 基础, feishu 基础 |
| L2 (Docker 共享) | carher-config.json  | models 定义 (含 contextWindow/cost), browser.headless, gateway, commands.restart                  |
| L3 (用户个性化)  | openclaw.json       | primary model, model aliases, feishu appId/appSecret/dm.allowFrom, gemini config                  |

---

## 5. contextTokens 的决定链路

`contextTokens` 控制 compaction (上下文压缩) 的触发阈值。

| 环境         | contextTokens 来源                            | 当前值 |
| ------------ | --------------------------------------------- | ------ |
| Mac 本地 Her | openclaw.json 直写                            | 200000 |
| S1 Admin Her | 继承 shared-config.json5                      | 200000 |
| S1 Docker    | carher-config.json 定义（覆盖 shared-config） | 200000 |

注意: Docker 的 `carher-config.json` 显式写了 `contextTokens: 200000`。即使 `shared-config.json5` 的值不同，Docker 容器也会使用 `carher-config.json` 的值（sibling override）。

---

## 6. 配置同步机制

### 当前状态

| 文件                               | 同步方式             | 问题                              |
| ---------------------------------- | -------------------- | --------------------------------- |
| repo `docker/shared-config.json5`  | Git                  | truth source                      |
| S1 Docker 用的 shared-config.json5 | bind mount repo 文件 | `git pull` 即同步，需重启容器生效 |
| S1 Admin 用的 shared-config.json5  | 手动维护的独立副本   | 容易与 repo 版本 drift            |
| Mac 本地的 shared-config.json5     | 手动维护的独立副本   | 容易与 repo 版本 drift            |

### 当前的同步风险

1. **S1 Docker**: `git pull` 后 bind mount 的文件自动更新，但 **需重启容器** 才能生效
2. **S1 Admin**: `/home/cltx/.openclaw/shared-config.json5` 是独立副本，与 repo 无关联，必须手动更新
3. **Mac 本地**: `~/.openclaw/shared-config.json5` 是独立副本，当前甚至未被 `openclaw.json` 引用

---

## 7. 当前问题总结

### P1: Mac 本地 Her 不使用 $include（配置方式不一致）

Mac 本地 Her 的 `openclaw.json` 直写所有配置，不通过 `$include` 引用 `shared-config.json5`。导致:

- 修改 `shared-config.json5` 不会影响 Mac 本地 Her
- 同一个功能配置（如 memorySearch、tools）需要在 Mac 本地和 shared-config 各维护一份
- 配置 drift 风险高

### P2: shared-config.json5 存在多份手动维护的副本

repo、Mac 本地、S1 Admin 各有一份 `shared-config.json5`，没有自动同步机制。改了 repo 的不等于改了运行时的。

### P3: carher-config.json 的 contextTokens 冗余

`carher-config.json` 显式写了 `contextTokens: 200000`，与 `shared-config.json5` 的值相同。这个冗余覆盖当初是为了防止 shared-config 的值错误，但增加了维护负担。

### P4: S1 Admin Her 缺少 models 定义

S1 Admin Her 的 `openclaw.json` 没有定义 `models.providers`，使用 SDK 内置默认。而 Mac 本地和 Docker 都显式定义了 models（含 contextWindow、cost）。如果 SDK 默认值与预期不符，Admin Her 的行为会不同。

---

## 8. 改进建议

### 建议 1: Mac 本地 Her 改为使用 $include（优先级: 高）

让 Mac 本地 `~/.openclaw/openclaw.json` 也通过 `$include: ./shared-config.json5` 引用共享配置，移除重复内容，只保留 Mac 特有配置。

**改动后配置方式统一为 2 种:**

| 配置方式                                                 | 环境                | 层数 |
| -------------------------------------------------------- | ------------------- | ---- |
| openclaw.json → shared-config.json5                      | Mac 本地 + S1 Admin | 2    |
| openclaw.json → carher-config.json → shared-config.json5 | Docker 容器         | 3    |

**Mac 本地 openclaw.json 需保留的特有配置:**

- `env.vars` (API keys)
- `models.providers` (anthropic 直连需要真实 apiKey)
- `agents.defaults.model.primary`、`agents.defaults.models` (aliases)
- `agents.defaults.maxConcurrent`、`agents.defaults.subagents`
- `browser.headless: false`
- `gateway` (loopback, no auth)
- `commands.restart: true`、`commands.ownerDisplay`
- `channels.telegram`、`channels.imessage`
- `channels.feishu` 凭证
- `plugins.entries` (telegram/imessage)

### 建议 2: 统一 shared-config.json5 同步机制（优先级: 高）

方案 A — **符号链接** (推荐):

```bash
# S1 Admin
ln -sf /Data/CarHer/docker/shared-config.json5 /home/cltx/.openclaw/shared-config.json5

# Mac 本地
ln -sf ~/Documents/work/openclaw/docker/shared-config.json5 ~/.openclaw/shared-config.json5
```

优点: git pull 后所有环境自动同步，零维护。

方案 B — 同步脚本:
在 `start.sh` / Admin Her 启动脚本中加入 `cp docker/shared-config.json5 ~/.openclaw/`。
缺点: 需要记得每次启动前运行。

### 建议 3: 移除 carher-config.json 中的冗余 contextTokens（优先级: 低）

`shared-config.json5` 已经定义了 `contextTokens: 200000`，`carher-config.json` 的同值覆盖可以移除。未来修改只需改一处。

但如果作为防御性措施保留也不会出错。

### 建议 4: 将 models 定义提升到 shared-config.json5（优先级: 中）

目前 models 定义在 Mac 本地 `openclaw.json` 和 `carher-config.json` 各维护一份。可以把 models 定义移到 `shared-config.json5`。

**障碍:** Mac 本地的 `anthropic` provider 需要真实 `apiKey`，Docker 用假 key (`sk-ant-not-used-on-server`)。需要通过环境变量 `${ANTHROPIC_API_KEY}` 统一。

### 建议 5: S1 Admin Her 补充 models 定义（优先级: 中）

S1 Admin Her 缺少显式 models 定义，依赖 SDK 默认值。如果实施建议 4，此问题自动解决。如果不实施建议 4，应在 S1 Admin 的 `openclaw.json` 中补充 models 配置。

---

## 9. 目标架构（实施全部建议后）

```
docker/shared-config.json5 (Git truth source)
│
├── contextTokens, compaction, memorySearch
├── models 定义 (含 contextWindow, cost)
├── tools, commands 基础, messages, browser 基础
├── plugins 基础, channels.feishu 基础
│
├── ~/.openclaw/shared-config.json5 (symlink → repo)
│   └── Mac 本地 openclaw.json ($include → shared-config.json5)
│       └── 特有: env, browser.headless, gateway, telegram, imessage
│
├── /home/cltx/.openclaw/shared-config.json5 (symlink → repo)
│   └── S1 Admin openclaw.json ($include → shared-config.json5)
│       └── 特有: env, gateway, feishu 凭证, ownerAllowFrom
│
└── Docker bind mount → /data/.openclaw/shared-config.json5
    └── carher-config.json ($include → shared-config.json5)
        ├── 特有: browser.headless, gateway, commands.restart
        └── per-user openclaw.json ($include → carher-config.json)
            └── 特有: primary model, feishu 凭证, gemini config
```

**结果: 改一处 shared-config.json5 + git pull → 所有环境自动生效（需重启）**
