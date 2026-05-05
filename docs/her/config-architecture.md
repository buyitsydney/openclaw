# CarHer 配置架构

> 状态：已落地（2026-04-23 rebuild）
> 单一真源：`config/*.json5`（git tracked）
> 部署目标：admin Mac Her + S1/S3 docker 容器

---

## 1. 架构总览

```
config/
├── base.json5         所有 agent 共享的行为（Behavior）
├── host-mac.json5     $include base.json5 — macOS 环境差异（非 admin 身份）
├── docker.json5       $include base.json5 — docker 容器环境差异
├── admin.json5        $include host-mac.json5 — admin 身份（Mac 上 admin her）
├── u101.json5         $include docker.json5 — carher-101 身份
├── u102.json5         同上
└── u{N}.json5         同上 — 一个 docker 用户一个文件
```

三条 include 链，每条恰好 2 层：

| Agent         | 链路                                            |
| ------------- | ----------------------------------------------- |
| admin Mac Her | `admin.json5` → `host-mac.json5` → `base.json5` |
| docker user N | `u{N}.json5` → `docker.json5` → `base.json5`    |
| 任何新用户    | `u{N}.json5` → `docker.json5` → `base.json5`    |

`config/` 整棵树是 git-tracked 的**唯一真源**。所有其他位置（`~/.openclaw/*.json5`、容器内 `/data/.openclaw/*.json5`）都是启动时从 `config/` 派生的副本。

---

## 2. Include 合并机制（openclaw 引擎）

引擎只做两件事（源码：`src/config/includes.ts`、`src/config/env-substitution.ts`）：

### 2.1 `$include` + deep merge

```
被 include 的文件 → 先加载
include 它的文件 → 后加载，同 key 覆盖
```

规则按值类型分三种：

| 两侧值类型                | 行为                          |
| ------------------------- | ----------------------------- |
| object `{}` + object `{}` | 递归 deep merge               |
| array `[]` + array `[]`   | **concat 追加**（不是替换！） |
| primitive + primitive     | overlay 方覆盖 included 方    |

**数组 concat 陷阱——头号坑。** rebuild 前的老 config 撞过三次：

| 字段                                   | 旧状态                                                                         | 新状态                          |
| -------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| `agents.defaults.memorySearch.sources` | `[memory,sessions]` 被 shared/host/docker 各写一份 → 实际 6 元素               | 只写 `base.json5` 一次 → 2 元素 |
| `plugins.load.paths`                   | `["/app/docker/...", "docker/..."]`（shared + host 拼接，host 上 /app 不存在） | 只写 `base.json5` 一次          |
| `tools.media.audio.models`             | `[{groq},{groq},{groq}]` 叠加 3 次                                             | 只写 `base.json5` 一次          |

铁律：**任何数组字段，在整条 include 链上只能出现一次**。overlay 想"替换"数组，要么改成带 key 的 object，要么不碰。

### 2.2 路径安全限制（macOS + docker 都生效）

include resolver 在解析 `$include` 路径时会做 rootDir 逃逸检查：

- rootDir 固定为 `basePath` 的 dirname
- rootRealDir 是 rootDir 的 realpath
- `$include` 的目标文件 realpath 必须仍在 rootRealDir 里，否则拒绝

这个限制决定了两件事：

1. **include 路径必须同目录内**（`./xxx.json5`），不能用 `../` 跨目录 → config 是扁平结构，不分 subdir
2. **跨目录 symlink 会被拒绝**（realpath 校验会穿过 symlink 解析真实位置）→ host 侧用 cp（JSON5→JSON）而不是 symlink 把 `config/*` 同步到 `~/.openclaw/`

### 2.3 `${VAR}` env 替换

字符串值里的 `${UPPERCASE_NAME}` 在 config 加载完之后用 `process.env` 替换。

- 缺变量直接 throw `MissingEnvVarError`（fail-fast，不会静默变空串）
- `$${VAR}` 是转义，输出字面量 `${VAR}`
- 只匹配全大写 `[A-Z_][A-Z0-9_]*` 形式

**所有 secret 在 config 里都写 `${VAR}`**，真值来自 env file，不进 git。

---

## 3. 文件职责

### 3.1 `config/base.json5`（layer 1，所有 agent 共享）

放：

- `agents.defaults` 里跨环境一致的 — `userTimezone`、`llm.idleTimeoutSeconds`、`maxConcurrent`、`subagents.maxConcurrent`、`compaction`、`memorySearch`
- `browser.{enabled, defaultProfile, cdpPortRangeStart}`
- `channels.feishu.{enabled, groups}`
- `commands.{native, nativeSkills}`
- `gateway.{mode, port}`（只放 mode 和 port；bind/auth 放 env 层）
- `messages.{ackReactionScope, tts 共享}`
- `models.providers.{anthropic,openrouter}.baseUrl`（URL 共享；apiKey 放 env 层）
- `plugins.{load.paths, entries}` 所有 agent 都需要的 plugin 功能配置
- `tools.{sessions.visibility, agentToAgent.enabled, web, media}`

不放：

- 任何 secret（`${VAR}` 也只用在 `memorySearch.remote.apiKey` 这样每 agent 都需要的字段）
- 环境差异字段（gateway.bind、browser.headless、commands.restart）
- 身份字段（feishu appId、primary model、imessage）

### 3.2 `config/host-mac.json5`（layer 2，macOS 原生环境）

加 / 覆盖：

- `acp.enabled: true`（只有 Mac 上跑 ACP Claude）
- `browser.headless: false`（Mac 有显示器）
- `commands.restart: true`
- `gateway.bind: "loopback"`
- `gateway.auth.mode: "none"`（Mac 本机，不做 token 校验）
- `gateway.auth.token: "${CARHER_GATEWAY_TOKEN_HOST}"`（mode=none 时不读，但保留以备切换）
- `agents.defaults.{contextTokens, heartbeat, workspace}`
- `plugins.entries.{acpx, anthropic, browser, openrouter}.enabled: true`

### 3.3 `config/docker.json5`（layer 2，docker 容器环境）

加 / 覆盖：

- `browser.{headless: true, noSandbox: true}`
- `channels.feishu.groupPolicy: "open"`（docker 默认开放群策略；admin 在 allowlist）
- `commands.restart: false`
- `gateway.bind: "lan"`
- `gateway.auth.{mode: "token", token: "${CARHER_GATEWAY_TOKEN}"}`
- `gateway.controlUi.*`（容器隔离下允许 dangerous 开关）
- `agents.defaults.model.primary: "anthropic/anthropic.claude-opus-4-7"`（所有 docker 默认 Wangsu opus-4-7）
- `agents.defaults.models` 的 alias 表（Wangsu + OpenRouter 两套）
- `models.providers.anthropic.{apiKey: "${ANTHROPIC_AUTH_TOKEN}", models: [...]}` — Wangsu 4 个 model（opus-4-7/opus-4-6/sonnet-4-6/haiku-4-5），id 必须带 `anthropic.` 前缀
- `models.providers.openrouter.{apiKey: "${OPENROUTER_API_KEY}", models: [...]}` — 8 个 OpenRouter 可用 model

**docker 的 anthropic apiKey 用 `${ANTHROPIC_AUTH_TOKEN}`**（docker/server.env 注入），Wangsu 的 LiteLLM 要求带前缀的 model id；不带前缀会返回 401 `key_model_access_denied`。

### 3.4 `config/admin.json5`（layer 3，admin 身份）

Admin 的身份 + 私人凭证：

- `channels.feishu.{name, appId, appSecret: "${FEISHU_APP_SECRET_ADMIN}", botOpenId, oauthRedirectUri, dm.allowFrom}`
- `channels.feishu.{knownBots, knownBotOpenIds}` — admin 维护的 bot 注册表（snapshot；start.sh 每次从 `docker/users.csv` 覆盖派生副本）
- `channels.imessage.*`（Mac 上 iMessage 访问）
- `commands.{ownerAllowFrom, ownerDisplay}`
- `models.providers.anthropic.apiKey: "${ANTHROPIC_AUTH_TOKEN}"`
- `models.providers.openrouter.apiKey: "${OPENROUTER_API_KEY}"`
- `models.providers.shanxia.{apiKey: "${SHANXIA_API_KEY}", ...}` — Mac-only 中国代理
- `agents.defaults.model.primary: "anthropic/anthropic.claude-opus-4-7"`
- `agents.defaults.models.*` 的 admin 专属 alias（Wangsu + OpenRouter + shanxia）
- `session.agentToAgent.maxPingPongTurns`
- `skills.limits.*`
- `tools.agentToAgent.enabled` 继承 base，不额外限制 allowlist（admin 需要 `sessions_history` 读 ACP child session，Claude agent id 不是 `main`）
- `plugins.entries.imessage.enabled: true`

### 3.5 `config/u{N}.json5`（layer 3，docker 用户身份）

一个 docker 用户一个文件，只放 feishu 身份：

```json5
{
  $include: "./docker.json5",
  channels: {
    feishu: {
      name: "<tester>的her",
      appId: "cli_a92c99d102b8dbca",
      appSecret: "${FEISHU_APP_SECRET}",
      botOpenId: "ou_...",
      oauthRedirectUri: "https://u{N}-auth.carher.net/feishu/oauth/callback",
      dm: { allowFrom: ["ou_..."] },
    },
  },
}
```

每个 u{N}.json5 10 行左右。primary model、alias 表、provider apiKey 全部从 `docker.json5` 继承。

---

## 4. Secret 管理

原则：

1. **git 里零明文 secret**
2. 所有 secret 用 `${VAR}` 引用
3. secret 真值来自 env file：
   - admin Mac Her：`~/.openclaw/.env`（chmod 600，gitignored）
   - docker 服务器：`docker/server.env`（per-server，gitignored）
   - docker per-user：`docker/users.csv` 第 5 列（feishu appSecret），compose 注入为 `-e FEISHU_APP_SECRET`

env 文件模板（作为公共 scaffolding 进 git）：

```
docker/server.env.example          docker 服务器共享 var 模板
docker/users/template.env.example  per-user docker secret 模板
openclaw-host.env.example          admin Mac secret 模板
```

### 4.1 Admin Mac Her env vars（`~/.openclaw/.env`）

```
FEISHU_APP_SECRET_ADMIN=...
ANTHROPIC_API_KEY=...
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_BASE_URL=https://litellm.carher.net
SHANXIA_API_KEY=...
OPENROUTER_API_KEY=...
VOYAGE_API_KEY=...
GROQ_API_KEY=...
CARHER_GATEWAY_TOKEN_HOST=...
```

启动前 source：

```bash
set -a; source ~/.openclaw/.env; set +a
./start.sh
```

或配合 launchd EnvironmentFile / direnv。

### 4.2 Docker 服务器共享 env（`docker/server.env`）

```
ANTHROPIC_BASE_URL=https://litellm.carher.net
ANTHROPIC_AUTH_TOKEN=...
OPENROUTER_API_KEY=...
VOYAGE_API_KEY=...
GROQ_API_KEY=...
CARHER_GATEWAY_TOKEN=...
CARHER_AUTH_HOST=...              # per-server OAuth hostname
CARHER_SERVER=S1|S3|local
```

`compose` 自动 source 这个文件，所有 docker 容器都收到这些 env。

### 4.3 Per-user docker secrets

`docker/users.csv` 第 5 列是 feishu appSecret。`compose` 读 CSV 后通过 `-e FEISHU_APP_SECRET=<value>` 注入进单个容器。

未来也可以切到 `docker/users/{N}.env` 独立 env file（模板见 `docker/users/template.env.example`），但目前沿用 CSV。

---

## 5. 运行时部署

### 5.1 Admin Mac Her（`./start.sh`）

`start.sh` 启动时做三件 config 相关事：

1. **Sync config → `~/.openclaw/`**（macOS 上 bind-mount 的等价实现，用 cp 而不是 symlink 以绕过 openclaw 的 realpath 校验）：

   ```
   node -e "JSON5.parse(config/admin.json5) | JSON.stringify" > ~/.openclaw/admin.json5
   node -e "JSON5.parse(config/base.json5) | JSON.stringify"  > ~/.openclaw/base.json5
   node -e "JSON5.parse(config/host-mac.json5) | JSON.stringify" > ~/.openclaw/host-mac.json5
   ln -sfn ./admin.json5 ~/.openclaw/openclaw.json   (同目录 symlink，安全)
   ```

   - 为什么是 JSON 而不是 JSON5：下游 python3 sync 段用 stdlib json 读写，不支持注释
   - 为什么文件名保留 `.json5`：openclaw 的 resolver 用 JSON5.parse（JSON 是 JSON5 的超集），include 路径查找按文件名，保留 `.json5` 兼容

2. **Python3 同步 feishu bot registry**：从 `docker/users.csv` 读所有 bot 的 appId/botOpenId/label，派生 `channels.feishu.{knownBots, knownBotOpenIds, oauthRedirectUri}`，写回 `~/.openclaw/admin.json5`（经 openclaw.json symlink 透传）。下次 start.sh 的 cp 会重新覆盖，所以 **git 源不被污染**。

3. **启动 gateway**：`node dist/index.js gateway run --port 18789 --bind loopback --force`

启动后的 openclaw 视角：

```
~/.openclaw/openclaw.json → ./admin.json5   (same-dir symlink)
rootDir           = ~/.openclaw/
rootRealDir       = ~/.openclaw/
managedSkillsDir  = ~/.openclaw/skills/      (host-deployed, bind mount from ~/.openclaw/skills)
$include 链：
  admin.json5  → ~/.openclaw/host-mac.json5  ✓ inside rootRealDir
  host-mac    → ~/.openclaw/base.json5        ✓
```

### 5.2 Docker 容器（`./compose --id=N`）

`compose` 对每个容器：

1. 检查 `config/u{N}.json5` 存在，不存在报错退出
2. 读 `docker/users.csv` 第 N 行拿 feishu appSecret + 其他派生信息
3. `docker run` 挂载单个 config 文件到 `/data/.openclaw/` 根（不是挂目录）：

   ```bash
   -v config/u{N}.json5      :/data/.openclaw/openclaw.json:ro
   -v config/base.json5      :/data/.openclaw/base.json5:ro
   -v config/docker.json5    :/data/.openclaw/docker.json5:ro
   -e FEISHU_APP_SECRET=<from CSV>
   -e CARHER_GATEWAY_TOKEN=<from AUTH_TOKEN>
   ```

4. 容器内 openclaw 读默认路径 `/data/.openclaw/openclaw.json`（= u{N}.json5 bind mount）
5. include 链 `./docker.json5` → `./base.json5` 都在 `/data/.openclaw/` 内，realpath 校验通过
6. `CONFIG_DIR = /data/.openclaw/`，`managedSkillsDir = /data/.openclaw/skills/`（compose 也 bind mount 了 `~/.openclaw/skills`）

为什么是**单个文件挂载**而不是整个 `config/` 目录挂载：

- 之前试过挂 `config/:/data/.openclaw/config/:ro` + `OPENCLAW_CONFIG_PATH=/data/.openclaw/config/u{N}.json5`
- 结果 CONFIG_DIR 变成 `/data/.openclaw/config/`，managedSkillsDir 跑到 `/data/.openclaw/config/skills/`（不存在）
- 所有 `openclaw-managed` source 的 skill（`feishu-chat`、`feishu-doc` 等 10 个）全部 not ready
- 单文件扁平挂载让 CONFIG_DIR 保持在 `/data/.openclaw/`，skills 正常加载

### 5.3 添加新 docker 用户

```bash
# 1. 选 ID（唯一，1-999）
ID=105

# 2. 复制模板 + 改身份字段
cp config/u101.json5 config/u${ID}.json5
$EDITOR config/u${ID}.json5
# 改：feishu.{name, appId, botOpenId, oauthRedirectUri, dm.allowFrom}

# 3. users.csv 加一行（id, label, model-alias, appId, appSecret, ownerOpenId, provider, note, _, botOpenId）
echo "${ID},...,..." >> docker/users.csv

# 4. commit
git add config/u${ID}.json5 docker/users.csv
git commit -m "feat: add docker user ${ID}"

# 5. 启动（bind mount 自动生效，不用 build image）
./compose --id=${ID} --image=carher-core:<current-tag>
```

---

## 6. Rebuild 简史（从 3 层到 2 层）

2026-04-23 之前：

```
docker/shared-config.json5 (rebrand 源)
├── cp → ~/.openclaw/shared-config.json5      (start.sh 每次启动 cp，hack)
│   └── ~/.openclaw/openclaw.json $include ./shared-config.json5
│       └── (还有 52 行 python mutation 注入 $include/A2A/ACP 到 openclaw.json)
└── bind mount 到 /data/.openclaw/shared-config.json5 (docker)
    └── docker/carher-config.json $include ./shared-config.json5
        └── docker/user-configs/carher-config-{N}.json $include ./carher-config.json
            └── 每次 compose 由 110 行 python3 现生成
```

病灶：

- 3 层嵌套，数组 concat 陷阱，同字段在多层重复导致不确定行为
- start.sh + compose 都在运行时 mutate 配置文件
- admin openclaw.json 完全不在 git，明文 secret 硬编码
- shared-config.json5 在 git 与 `~/.openclaw/` 各有一份，手工同步易 drift

2026-04-23 rebuild 后：

- 所有非 secret config 进 git (`config/*.json5`)
- 3 层 include → 固定 2 层
- 运行时 mutation 限定在派生副本（每次启动覆盖重写，不污染 git 源）
- Secret 全部 `${VAR}` + env file

`docker/{shared-config.json5, carher-config.json, user-configs/*}` 作为 **safety net 保留**，运行时不再被任何 path 挂载 / cp 到生效位置。

---

## 7. 已知局限

- **Admin Mac Her 的 feishu.knownBots drift**：`config/admin.json5` 里是 snapshot，`start.sh` python3 段每次从 `docker/users.csv` 重新派生覆盖副本。CSV 加新 bot → 下次启动 Mac 侧自动获取；git 源不自动更新，需手工重新 snapshot 以保持 diff 可读。
- **OpenRouter provider 用户的 docker alias**：`config/docker.json5` 默认把 `opus`/`sonnet` 等短别名绑到 `anthropic/anthropic.claude-*`（Wangsu）。如果某 docker 用户 CSV provider=openrouter，需要在 `config/u{N}.json5` 里覆盖 `agents.defaults.models.*` 重指到 openrouter 变体，否则 `/opus` 会走到 Wangsu 而不是 OpenRouter。
- **Memory search embedding provider**：当前 `base.json5` 指 `https://openrouter.ai/api/v1/` + model `BAAI/bge-m3`。openrouter.ai 在部分网络环境下 docker 容器不可达，`memory_search` 会报 `fetch failed`。此为 rebuild 前即有的问题，独立修复路径（换 voyage 或 wangsu embedding endpoint）。
- **1000 用户 scaling**：每用户一个 `config/u{N}.json5` 在 10-100 用户量级可维护；更大规模建议做 bootstrap 脚本从 `docker/users.csv` 批量生成。
