# CarHer Build/Deploy/Run 架构（compose + registry）

**配合文档**：
- [Her Image Architecture](/her/her-image-architecture) — A+B 三轴镜像解耦
- [Config Architecture](/her/config-architecture) — 三层 config

**状态**：compose + registry 已跑在 fleet；当前生产仍保留一层 git-synced runtime patch plane。

---

## 1. 核心原则

| 原则 | 含义 |
|---|---|
| **Image 不可变** | 同一个 image 被所有 user 复用；per-user 差异只在 compose yaml + bind mount |
| **Config 运行时注入** | Dockerfile 不 `COPY` 任何 config；全部通过 bind mount 从 git 仓库（static）+ env_file（secrets） |
| **Declarative run** | 所有运行时参数（ACP flag、A2A hub/spoke、memory、ports、volumes）写在 `compose.yaml` 里，caller 无需传 |
| **Registry 分发** | 目标态由 server 通过 `docker pull <registry>/carher-core:<tag>` 拿 image；当前生产仍保留 git-synced runtime patch control plane |
| **Upgrade = 改一行** | image 升级/回滚的唯一动作：编 `.env` 的 `IMAGE_TAG`，再 `docker compose up -d` |
| **Runtime patch 也算发布面** | `scripts/carher-entrypoint.sh` 和 `scripts/carher-patches/` 通过 bind mount 注入；改这些文件后，即使 image tag 不变，也必须 git sync + force-recreate |

---

## 2. 三层解耦

```
┌─────────────────────────────────────────────────────────────────┐
│  BUILD  —  CI / admin container / dev laptop                     │
│                                                                  │
│    deploy/build-and-push.sh                                      │
│      └─ docker build -f Dockerfile.carher.v2                     │
│           ARG OPENCLAW_TAG=<version>                             │
│           ARG BUILD_HASH=<git sha>                               │
│                                                                  │
│    产物:  ghcr.io/<you>/carher-core:<YYYY.M.D>                   │
│           或 localhost:5001/carher-core:<YYYY.M.D>               │
│           (image 带 labels: carher.openclaw.tag, .build.hash)    │
└─────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│  DISTRIBUTE  —  registry (ghcr.io / 自建 registry:2)             │
│                                                                  │
│    任何人 `docker pull` 拿同一份不可变 image                     │
│    不再 scp/ssh docker save|load                                 │
│    目标态不再依赖 server 上 git clone /Data/CarHer               │
└─────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│  RUN  —  S1 / S3 / Mac 本地                                      │
│                                                                  │
│    deploy/carher-{id}/                                           │
│      ├── compose.yaml       (service 定义，declarative)          │
│      ├── .env               (IMAGE_TAG 唯一入口)                 │
│      └── secrets.env        (gitignored: FEISHU_APP_SECRET 等)   │
│                                                                  │
│    命令: `docker compose up -d`                                  │
│                                                                  │
│    Config 运行时挂载:                                            │
│      config/u{id}.json5   → /data/.openclaw/openclaw.json:ro     │
│      config/base.json5    → /data/.openclaw/base.json5:ro        │
│      config/docker.json5  → /data/.openclaw/docker.json5:ro      │
│                                                                  │
│    持久化 volume:                                                │
│      carher-{id}-home  → /data           (skills, cli 安装等)    │
│      carher-{id}-data  → /data/.openclaw (sessions, memory)      │
└─────────────────────────────────────────────────────────────────┘
```

### 和 A+B 三轴镜像架构的关系

A+B 是 **Build** 层的内部结构（见 [Her Image Architecture](/her/her-image-architecture)）：

```
Dockerfile.carher.v2:
   FROM ghcr.io/openclaw/openclaw:${OPENCLAW_TAG}   ← 轴 A：上游 openclaw
     + COPY docker/plugins/feishu-her  + npm install ← 轴 B1：自家 channel
     + COPY docker/plugins/a2a-gateway + npm install ← 轴 B2：自家 A2A
     + COPY docker/plugins/shadow-daemon              ← 轴 B3
```

**Phase 2 关键改动（compose PoC）**：Dockerfile.carher.v2 **不再 `COPY docker/shared-config.json5` / `docker/user-configs/`**。Config 彻底离开 image，100% 运行时注入。Image 现在只含三轴代码，完全跨 user 复用。

---

## 3. 文件结构

```
<repo>/
├── Dockerfile.carher.v2            # Build 层：A+B 三轴 image 定义
├── config/                          # Run 层：三层 config（git-tracked）
│   ├── base.json5                   # L1 全局默认
│   ├── docker.json5                 # L2 docker 共用（$include base）
│   ├── u101.json5                   # L3 per-user（$include docker）
│   ├── u13.json5
│   └── ...
├── docker/
│   ├── plugins/                     # B 层代码
│   │   ├── feishu-her/
│   │   ├── a2a-gateway/
│   │   └── shadow-daemon/
│   ├── users.csv                    # per-user CSV（gitignored：含 secret）
│   ├── servers.txt                  # SSH 凭证（gitignored）
│   └── server.env                   # 共享 API key（gitignored）
├── deploy/                          # Run 层：declarative manifest
│   ├── build-and-push.sh            # CI: build image + push to registry
│   ├── migrate-carher-101.sh        # 一次性迁移: compose → compose
│   ├── init-user.sh                 # first-boot: voice token + device pairing
│   ├── scaffold.sh                  # 从 users.csv 生成 deploy/carher-N/
│   ├── common/
│   │   ├── redis.yaml               # 共享 redis (a2a-gateway peer registry)
│   │   └── compose.template.yaml    # scaffold.sh 的模板
│   └── carher-{id}/
│       ├── compose.yaml             # declarative service 定义
│       ├── .env                     # IMAGE_TAG=... (唯一升级入口, git-tracked)
│       └── secrets.env              # FEISHU_APP_SECRET (gitignored)
└── scripts/
    ├── carher-entrypoint.sh          # Run 层：container 启动时的 runtime patch 编排
    └── carher-patches/               # Run 层：openclaw-lark 等闭源/上游漂移补丁
```

---

## 4. 关键 decoupling

### Build ↔ Run 解耦

| 维度 | 旧 `compose` | 新 compose |
|---|---|---|
| 启动命令 | `CARHER_ACP_ENABLED=1 A2A_ENABLED=1 CARHER_MEMORY_LIMIT=16g ./compose --id=13 --image=carher-core:0424-ab-v2` | `docker compose up -d` |
| 必须记住的参数 | ≥ 4 (flags + image tag + memory) | **0** |
| 升级唯一动作 | 重跑全 20 字参数的命令 | 编 `.env` 的 `IMAGE_TAG`，`docker compose up -d` |
| 回滚 | 重跑命令，tag 用旧值 | revert `.env` 一行 |
| Hub / Spoke 切换 | 加/减 `A2A_OUTBOUND=1` env | 编 `compose.yaml` 的 `environment:` 一行 |

### Code ↔ Server 解耦

| 旧 | 新 |
|---|---|
| S1/S3 都是 `/Data/CarHer` 的 git clone，**server = 开发机** | 目标态：S1/S3 只需要部署包放 compose + config + secrets，**不含源码** |
| 新版本：`git pull origin dev` + `build-image.sh` + restart | 新版本：`docker pull <registry>/carher-core:<new-tag>` + `docker compose up -d` |
| image 分发：`docker save \| ssh docker load` 给每台服务器 | image 分发：`docker push` 一次，所有 server `docker pull`（幂等，可审计，可签名） |
| SPOF：只有 admin 容器有 sshpass + `docker save` 能力 | 任何能 `docker pull` 的机器都能部署 |

**当前生产注记（2026-05-09）**：fleet 还没有完全达到“server 不含源码”的目标态。`compose.yaml` 会 bind mount repo 里的 `scripts/carher-entrypoint.sh` 和 `scripts/carher-patches/`，因此 `/Data/CarHer` 仍是运行时控制面的一部分。改 image 只需要 bump `IMAGE_TAG`；改 runtime patch、entrypoint、compose template 或 config，则必须先把服务器上的 repo fast-forward 到 dev，再 `docker compose up -d --force-recreate`。

### Config ↔ Image 解耦

| Phase 2 前 | Phase 2 后 |
|---|---|
| Dockerfile `COPY docker/shared-config.json5 /app/docker/shared-config.json5` | （删除） |
| Dockerfile `COPY docker/user-configs /app/docker/user-configs` | （删除） |
| image 里含 100+ per-user config JSON，每加用户要重 build | image 0 per-user 内容；config 纯运行时 bind mount |
| Image size 含 344 KB 无用 legacy config | Image = 纯代码 artifact |

### Build 版本可追溯

Dockerfile 通过 `ARG BUILD_HASH` + `ARG OPENCLAW_TAG` 注入 image 级 LABEL：

```dockerfile
LABEL carher.build.hash=$BUILD_HASH
LABEL carher.openclaw.tag=$OPENCLAW_TAG
LABEL carher.build.dockerfile=Dockerfile.carher.v2
```

运维查询：
```bash
docker inspect <container> --format '{{.Image}}' \
  | xargs docker inspect --format '{{index .Config.Labels "carher.build.hash"}}'
# 直接拿到 git sha，对应 prod 实际跑的 commit
```

---

## 5. Runtime Patch Plane

当前 fleet 的可运行形态不是“只靠 image”。为了把官方 OpenClaw base、闭源 `@larksuite/openclaw-lark`、自家 CarHer plugin、以及快速变化的三组件架构拼在一起，container 启动时还会执行一组 runtime patches。它们由 `scripts/carher-entrypoint.sh` 编排，主要 patch target 来自 runtime npm install 或 bind mount，因此不能只在 Docker build 时打一次。

这层 patch plane 不是临时 hack；它是当前架构的显式兼容层。未来每次升级 OpenClaw base、`@larksuite/openclaw-lark`、三组件插件契约、或 entrypoint 时，都必须把它当作发布面验证。

### 为什么需要 runtime patches

| Patch | 作用 | 为什么不能只靠 image |
|---|---|---|
| `stripBotMentions` | 群里同时 @ 多个 bot 时保留 bot mention，避免 bot 误判“没被 @”而 NO_REPLY | `@larksuite/openclaw-lark` 是 runtime npm package，且上游硬编码行为会覆盖 image 内状态 |
| `command-body mention normalization` | `/new @bot`、`@bot /new`、`/new @bot1 @bot2` 归一成裸 `/new`，让系统命令直接 reset session，不进 LLM | 必须在 Feishu inbound dispatch 的 command surface 上修，不应退回直接发 Feishu ack 或 `CommandSource:native` |
| `openclaw-lark channel-only` | 三组件架构下只保留 channel，tools/skills 交给 `lark-cli` | manifest 来自 runtime package，升级或 reinstall 会恢复上游 manifest |
| `feishu-her contracts.tools` | 显式声明 30 个 Feishu tools 和 startup activation | OpenClaw 插件契约升级后，manifest 和 runtime 注册必须对齐 |
| `shadow-daemon activation` | container 启动即跑 shadow sync | 自家 plugin manifest 需要显式 onStartup |
| `patch-agent-loop` | 给 antitalker stop-hook pipeline 接入 agent loop | 上游 agent loop 没有足够 extension point |
| `history-fill` + `inbound-history metadata` | 群聊冷启动或重启后主动补最近 20 条消息，避免上下文失忆 | Feishu group history 不应只依赖被动 WS event 累积；补历史的 primary path 必须走 `lark-cli im +chat-messages-list --chat-id <oc_...> --page-size 20 --sort desc --format json` 的默认 user-token 视图，和 Her 自己做 1:1 审计时看到的“真实群消息”保持一致；entry 必须携带 `messageId` / `messageType` / `replyToId` 并在模型的 `InboundHistory` JSON 里渲染为 `message_id` / `message_type` / `reply_to_id`；只有 lark-cli 不可用时才 fallback 到裸 `/im/v1/messages` + `card_msg_content_type=raw_card_content`，并继续保证 sender 可读、card 不退化、坏占位不进模型 |

曾经的 build-time `apply-reset-archive-patches.sh` 现在是 no-op stub。它保留为历史记忆，不代表当前有 active build-time patch。

### Upgrade Invariants

1. Runtime patch 文件和 image 一样重要。改 `scripts/carher-entrypoint.sh` 或 `scripts/carher-patches/` 后，即使 `IMAGE_TAG` 不变，也必须在目标服务器 fast-forward dev 并 force-recreate 容器。
2. 不要直接 SSH 改服务器代码。正确路径是本地 commit + push，服务器 `git pull --ff-only <remote> dev`，再 compose recreate。
3. S1 和 S3 的 remote 名称可以不同。当前 S1 使用 `carher`，S3 使用 `origin`；升级脚本不能假设 remote 名固定。
4. `command-body mention normalization` 必须保持 V2 marker：`CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER`。V1 只能算未升级。
5. `history-fill` 不能退化成 raw API dump。回归测试必须覆盖 lark-cli default-user primary path、sender name label、`message_id` / `message_type` / `reply_to_id` 注入、interactive/card converter、API 降级占位拦截、interactive fallback canonical refetch。模型视角的 group history 应和 `lark-cli im +chat-messages-list --format json` 的可读正文保持内容等价，不允许出现 `请升级至最新版本客户端，以查看内容` 或 raw card JSON 穿透，不能丢 reply 链结构。
6. 任一 patch anchor 失效都不要 ship。先读目标上游文件，更新 patch script，再跑本地和服务器上的 patch tests。
7. 功能 smoke 至少覆盖：`/new @bot`、`@bot /new`、`/new @bot1 @bot2`、`/status @bot`。期望日志是 `detected system command` 和 `system command dispatched (delivered=true)`，不应出现命令消息 `dispatching to agent`。
8. 不要用直接 Feishu ack 或 `CommandSource:native` 修 `/new`。前者绕过 core reset 语义，后者曾导致 `/status` 双回复。

### Runtime Patch Self-Check

每台容器启动后必须看到 8 个 runtime patch 全中：

```bash
docker logs carher-<id> 2>&1 \
  | grep -E "stripBotMentions|command-body normalize|channel-only|contracts.tools \(30\)|shadow-daemon|history-fill|inbound-history metadata|patch-agent-loop|session-decay|PATCHED"
```

`command-body` 还要查容器内 marker：

```bash
docker exec carher-<id> sh -lc '
  p=/data/.openclaw/extensions/node_modules/@larksuite/openclaw-lark/src/messaging/inbound/dispatch.js
  grep -n "CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER" "$p"
  grep -n "carherStripMentionsForCommandBody" "$p"
  grep -n "CARHER_HISTORY_META_PATCH_MARKER" "$p"
  grep -n "CARHER_INBOUND_HISTORY_META_PATCH_MARKER" /app/dist/get-reply-*.js
'
```

---

## 6. 日常运维命令速查

### 升级（Build + Deploy）

```bash
# 1. Build + push 新 image 到 registry
cd <repo> && ./deploy/build-and-push.sh --registry=ghcr.io/YOUR_USER \
                                         --openclaw-tag=2026.4.26

# 2. server 上 bump tag
cd /etc/carher/carher-13
sed -i 's|IMAGE_TAG=.*|IMAGE_TAG=ghcr.io/YOUR_USER/carher-core:2026.4.26|' .env
docker compose up -d   # auto-pull + recreate
```

### 回滚（1 行）

```bash
# 改回旧 IMAGE_TAG
sed -i 's|2026.4.26|2026.4.24|' .env
docker compose up -d
# volume 保留，sessions/memory 不丢
```

### 诊断

```bash
# 容器当前跑的 image 是从哪个 git commit 来的
docker inspect carher-13 --format '{{.Image}}' \
  | xargs docker inspect --format 'hash={{index .Config.Labels "carher.build.hash"}} openclaw={{index .Config.Labels "carher.openclaw.tag"}}'

# 日志
cd /etc/carher/carher-13 && docker compose logs -f

# 健康
docker inspect carher-13 --format '{{.State.Health.Status}}'
```

### 新建用户

```bash
# 1. 在 users.csv 加一行（已有流程）
# 2. 生成 deploy/carher-N/ 目录
./deploy/scaffold.sh N
# 3. 填 deploy/carher-N/.env (IMAGE_TAG) + secrets.env
# 4. docker compose up -d
cd deploy/carher-N && docker compose up -d
```

---

## 7. 迁移路径（分阶段，不 disrupt 生产）

| Step | 动作 | 影响 | 可回滚性 |
|---|---|---|---|
| 1 | 本地 registry（`registry:2` 容器） + `build-and-push.sh` PoC | 无生产影响 | 直接删 |
| 2 | carher-101 (Mac tester) 用 compose 启动 | 单容器 | 改回 compose |
| 3 | S1 carher-12（卜弋天 test bot）迁移 | 一个非关键 user | 改回 compose |
| 4 | 搭 ghcr.io（或自建 S1 registry） | 分发路径切换 | registry 挂不影响已拉过的 image |
| 5 | Phase 2：删 Dockerfile 的 config COPY，build 新 image | image 进一步解耦 | revert commit |
| 6 | 其他所有 her 渐进迁移（一天一个） | 全 fleet | 每台单独回滚 |
| 7 | 服务器 `/Data/CarHer` → `/etc/carher`（删源码） | 服务器干净化 | 重新 git clone 能恢复 |

---

## 8. PoC 验证记录（carher-101, 2026-04-29）

- ✅ `migrate-carher-101.sh` 一键接管（stop compose 版 + compose up + wait healthy 31s）
- ✅ 升级实验：`.env` IMAGE_TAG 切到 `test-build-hash-101` → recreate 8s → healthy 26s
- ✅ 回滚实验：revert tag → recreate 1s → healthy 28s（volume 保留 185 个 session jsonl）
- ✅ Registry PoC：删本地 image → `docker compose up -d` 从 `localhost:5001` 自动 pull → 31s healthy
- ✅ Image labels：`carher.build.hash=bdf72f8503…`, `carher.openclaw.tag=2026.4.24`
- ✅ `models list` 显示所有 alias 正确解析（gpt-5.5 1M ctx、ds=deepseek-v4-pro）
- ✅ 飞书 bot 正常响应（`starting WebSocket connection` / `WSClient connected` + `/or-opus` 切换 + 自然对话）

## 9. 已知限制与后续工作

### 已解决
- **Anthropic auth mirror** — compose.yaml 里显式 mirror `ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY`（compose 在 bash 里做这件事；compose 需要显式声明，否则 bot 回 `Missing API key for provider "anthropic"`）
- **Compose `${VAR}` substitution on server** — compose 的 `${VAR}` 展开发生在 parse 时，从 shell env / `--env-file` / project `.env` 读取，**不从 `env_file` 指令读取**。`scaffold.sh` 现在在生成 `.env` 时自动从 `docker/server.env` 提取 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`CARHER_LAN_IP` 写入 `.env`，确保 server 部署时变量不为空。`compose.template.yaml` 的 `CARHER_LAN_IP` 改为 `${CARHER_LAN_IP:-127.0.0.1}` fallback。

### 首次启动慢（3-5 分钟，非 bug）

openclaw 2026.4.24+ 引入 **"lazy runtime deps"** 机制：plugin 依赖（`@anthropic-ai/sdk`、`@mariozechner/pi-ai`、`@aws-sdk/*` 等 25+ 包）不在 image 里 bundle，改为首次启动时 npm install 到持久化 volume `/data/.openclaw/plugin-runtime-deps/openclaw-<version>-<hash>/`。

**表现**：
- **首次启动**（新容器、volume 里没有对应 openclaw 版本的 plugin-runtime-deps）= **3-5 分钟**直到 feishu websocket 初始化（`starting WebSocket connection` 或 `WSClient connected`）。期间 log 显示 "starting channels and sidecars..." 后没动静，直到 npm install 完成。
- **第二次起及以后**（同 volume）= **< 10 秒**。
- **跨版本升级**（openclaw tag 变）= 视为首次启动，重装一遍（目录按 `<version>-<hash>` 隔离）。

**应对**：
- compose.yaml `healthcheck.start_period=300s`（5 min）给足首启时间，避免被误判 unhealthy。
- 观察 log `plugins] * staging bundled runtime deps` → `installed bundled runtime deps in *ms` 确认在装什么。

**未来优化**：Dockerfile 里预 `RUN node openclaw.mjs plugins stage-runtime-deps --all` 把 deps 预装到 image（但会让 image 大 ~600MB，需权衡）。

### 尚未做
- **GitHub Actions**：`.github/workflows/build-image.yml` 自动化 build+push（需要 gh token 加 `write:packages` scope）
- **Image 签名**：`cosign sign` + `cosign verify` 供应链安全
- **SBOM**：`syft` 生成 image 内容清单
- **carher-102/103/104 volume state**：Mac 本地 tester 的 feishu 插件在某些 volume state 下启动后不触发 `starting Feishu bot`；需要 A/B 对照 compose 定位根因（独立任务）
- **server 不含源码目标态**：生产 fleet 已 compose 化；下一步是把 `/Data/CarHer` 里的 runtime patch/control-plane 文件打包成部署 artifact，减少服务器源码 clone 依赖。

### 设计未覆盖
- **K8s / Nomad**：容器数 <20 时 docker compose 足够；扩到 50+ 时换 orchestrator
- **Secret 管理升级**：secrets.env 目前放 host 文件系统；生产应接 HashiCorp Vault / SOPS / cloud KMS
