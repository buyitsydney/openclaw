# CarHer Build/Deploy/Run 架构（compose + registry）

**配合文档**：
- [`her-image-architecture.md`](./her-image-architecture.md) — A+B 三轴镜像解耦
- [`config-architecture.md`](./config-architecture.md) — 三层 config

**状态**：PoC 已在 carher-101（Mac local tester）跑通；生产 S1/S3 尚未迁移。

---

## 1. 核心原则

| 原则 | 含义 |
|---|---|
| **Image 不可变** | 同一个 image 被所有 user 复用；per-user 差异只在 compose yaml + bind mount |
| **Config 运行时注入** | Dockerfile 不 `COPY` 任何 config；全部通过 bind mount 从 git 仓库（static）+ env_file（secrets） |
| **Declarative run** | 所有运行时参数（ACP flag、A2A hub/spoke、memory、ports、volumes）写在 `compose.yaml` 里，caller 无需传 |
| **Registry 分发** | server 通过 `docker pull <registry>/carher-core:<tag>` 拿 image，**不再 `git clone` 或 `docker save\|load`** |
| **Upgrade = 改一行** | 升级/回滚唯一动作：编 `.env` 的 `IMAGE_TAG`，再 `docker compose up -d` |

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
│    不再 server 上 git clone /Data/CarHer                         │
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

A+B 是 **Build** 层的内部结构（见 [`her-image-architecture.md`](./her-image-architecture.md)）：

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
└── deploy/                          # Run 层：declarative manifest
    ├── build-and-push.sh            # CI: build image + push to registry
    ├── migrate-carher-101.sh        # 一次性迁移: start-user.sh → compose
    ├── init-user.sh                 # first-boot: voice token + device pairing
    ├── scaffold.sh                  # 从 users.csv 生成 deploy/carher-N/
    ├── common/
    │   ├── redis.yaml               # 共享 redis (a2a-gateway peer registry)
    │   └── compose.template.yaml    # scaffold.sh 的模板
    └── carher-{id}/
        ├── compose.yaml             # declarative service 定义
        ├── .env                     # IMAGE_TAG=... (唯一升级入口, git-tracked)
        └── secrets.env              # FEISHU_APP_SECRET (gitignored)
```

---

## 4. 关键 decoupling

### Build ↔ Run 解耦

| 维度 | 旧 `start-user.sh` | 新 compose |
|---|---|---|
| 启动命令 | `CARHER_ACP_ENABLED=1 A2A_ENABLED=1 CARHER_MEMORY_LIMIT=16g ./start-user.sh --id=13 --image=carher-core:0424-ab-v2` | `docker compose up -d` |
| 必须记住的参数 | ≥ 4 (flags + image tag + memory) | **0** |
| 升级唯一动作 | 重跑全 20 字参数的命令 | 编 `.env` 的 `IMAGE_TAG`，`docker compose up -d` |
| 回滚 | 重跑命令，tag 用旧值 | revert `.env` 一行 |
| Hub / Spoke 切换 | 加/减 `A2A_OUTBOUND=1` env | 编 `compose.yaml` 的 `environment:` 一行 |

### Code ↔ Server 解耦

| 旧 | 新 |
|---|---|
| S1/S3 都是 `/Data/CarHer` 的 git clone，**server = 开发机** | S1/S3 只需要 `/etc/carher/` 放 compose + config + secrets，**不含源码** |
| 新版本：`git pull origin dev` + `build-image.sh` + restart | 新版本：`docker pull <registry>/carher-core:<new-tag>` + `docker compose up -d` |
| image 分发：`docker save \| ssh docker load` 给每台服务器 | image 分发：`docker push` 一次，所有 server `docker pull`（幂等，可审计，可签名） |
| SPOF：只有 admin 容器有 sshpass + `docker save` 能力 | 任何能 `docker pull` 的机器都能部署 |

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

## 5. 日常运维命令速查

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

## 6. 迁移路径（分阶段，不 disrupt 生产）

| Step | 动作 | 影响 | 可回滚性 |
|---|---|---|---|
| 1 | 本地 registry（`registry:2` 容器） + `build-and-push.sh` PoC | 无生产影响 | 直接删 |
| 2 | carher-101 (Mac tester) 用 compose 启动 | 单容器 | 改回 start-user.sh |
| 3 | S1 carher-12（卜弋天 test bot）迁移 | 一个非关键 user | 改回 start-user.sh |
| 4 | 搭 ghcr.io（或自建 S1 registry） | 分发路径切换 | registry 挂不影响已拉过的 image |
| 5 | Phase 2：删 Dockerfile 的 config COPY，build 新 image | image 进一步解耦 | revert commit |
| 6 | 其他所有 her 渐进迁移（一天一个） | 全 fleet | 每台单独回滚 |
| 7 | 服务器 `/Data/CarHer` → `/etc/carher`（删源码） | 服务器干净化 | 重新 git clone 能恢复 |

---

## 7. PoC 验证记录（carher-101, 2026-04-29）

- ✅ `migrate-carher-101.sh` 一键接管（stop start-user.sh 版 + compose up + wait healthy 31s）
- ✅ 升级实验：`.env` IMAGE_TAG 切到 `test-build-hash-101` → recreate 8s → healthy 26s
- ✅ 回滚实验：revert tag → recreate 1s → healthy 28s（volume 保留 185 个 session jsonl）
- ✅ Registry PoC：删本地 image → `docker compose up -d` 从 `localhost:5001` 自动 pull → 31s healthy
- ✅ Image labels：`carher.build.hash=bdf72f8503…`, `carher.openclaw.tag=2026.4.24`
- ✅ `models list` 显示所有 alias 正确解析（gpt-5.5 1M ctx、ds=deepseek-v4-pro）
- ✅ 飞书 bot 正常响应（`Feishu WSClient connected` + `/or-opus` 切换 + 自然对话）

## 8. 已知限制与后续工作

### 已解决
- **Anthropic auth mirror** — compose.yaml 里显式 mirror `ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY`（start-user.sh 在 bash 里做这件事；compose 需要显式声明，否则 bot 回 `Missing API key for provider "anthropic"`）

### 首次启动慢（3-5 分钟，非 bug）

openclaw 2026.4.24+ 引入 **"lazy runtime deps"** 机制：plugin 依赖（`@anthropic-ai/sdk`、`@mariozechner/pi-ai`、`@aws-sdk/*` 等 25+ 包）不在 image 里 bundle，改为首次启动时 npm install 到持久化 volume `/data/.openclaw/plugin-runtime-deps/openclaw-<version>-<hash>/`。

**表现**：
- **首次启动**（新容器、volume 里没有对应 openclaw 版本的 plugin-runtime-deps）= **3-5 分钟**直到 `Feishu WSClient connected`。期间 log 显示 "starting channels and sidecars..." 后没动静，直到 npm install 完成。
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
- **carher-102/103/104 volume state**：Mac 本地 tester 的 feishu 插件在某些 volume state 下启动后不触发 `starting Feishu bot`；需要 A/B 对照 start-user.sh 定位根因（独立任务）
- **生产 fleet 迁移**：S1（carher-12/13/198/199/200）+ S3（carher-14/75）尚未从 start-user.sh 切到 compose

### 设计未覆盖
- **K8s / Nomad**：容器数 <20 时 docker compose 足够；扩到 50+ 时换 orchestrator
- **Secret 管理升级**：secrets.env 目前放 host 文件系统；生产应接 HashiCorp Vault / SOPS / cloud KMS
