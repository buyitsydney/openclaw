# CarHer 镜像架构：三轴解耦 (A+B)

## 一、背景与动机

CarHer 的运行镜像长期以来是**一体化编译产物**：`Dockerfile.carher` 从 `node:22-bookworm` 起手，`COPY . .` 整个仓库后 `pnpm build:docker` 一把梭，Her 所需的 Feishu 插件、A2A gateway、OpenClaw 核心被编进同一层产物。

这种方式在产品快速迭代期没问题，但随着：

1. **OpenClaw 官方开始频繁发版**（每周 1-2 个 tag），我们需要快速搭车但不想每次都把自家插件重新编译一遍；
2. **feishu-her / a2a-gateway 本身也在独立演进**（bugfix、功能迭代），它们的节奏与 OpenClaw 核心不绑定；
3. **升级/回滚的"可预期性"变差**——一次构建可能同时动了 OpenClaw、feishu-her、a2a-gateway 三个独立模块的代码，出问题不好定位。

于是做了一次架构重构：**把一体化镜像拆成"官方 base + 独立插件"的三轴模型**，每条轴可以独立升级、独立回滚。

内部简称 **A+B 架构**：A = 官方 OpenClaw 镜像（不动），B = CarHer 自有插件（自研、自维护）。

---

## 二、三轴模型

```
┌────────────────────────────────────────────────────────┐
│  carher-core:<TAG>-ab-v2  (最终运行镜像)                │
├────────────────────────────────────────────────────────┤
│  轴 3 (B): docker/plugins/a2a-gateway/                 │
│           - 独立 package.json / 独立 semver            │
│           - 升级 = 重跑 npm install 这一层             │
├────────────────────────────────────────────────────────┤
│  轴 2 (B): docker/plugins/feishu-her/                  │
│           - 独立 package.json / 独立 semver            │
│           - 升级 = 重跑 npm install 这一层             │
├────────────────────────────────────────────────────────┤
│  轴 1 (A): ghcr.io/openclaw/openclaw:${OPENCLAW_TAG}   │
│           - 官方镜像，只改 FROM 的 tag                 │
│           - 含 OpenClaw core + 官方预装插件            │
│           - 我们只在 Dockerfile ARG 里改一个字符串     │
└────────────────────────────────────────────────────────┘
```

### 三条轴的升级口径

| 要升级什么                  | 改哪里                                           | 代价                                       |
| --------------------------- | ------------------------------------------------ | ------------------------------------------ |
| OpenClaw 核心（跟官方发版） | `Dockerfile.carher.v2` 的 `ARG OPENCLAW_TAG=...` | 一个字符串；镜像全量重建（缓存失效）       |
| feishu-her 插件             | `docker/plugins/feishu-her/` 下代码              | 只重跑 `npm install` 层（base 层缓存保留） |
| a2a-gateway 插件            | `docker/plugins/a2a-gateway/` 下代码             | 只重跑 `npm install` 层（base 层缓存保留） |

**设计意图**：让"蹭 OpenClaw 官方发版"变成 1 行改动，同时我们自己插件的迭代节奏完全独立。

---

## 三、Dockerfile.carher.v2 分层策略

```dockerfile
ARG OPENCLAW_TAG=2026.4.14
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_TAG}     # 轴 1

USER root

# 系统依赖（官方镜像没带的）
RUN apt-get update && apt-get install -y \
      python3 python3-pip python3-venv ffmpeg \
      chromium fonts-liberation fonts-noto-cjk fonts-noto-color-emoji

# 官方镜像里自带 bundled feishu（id=feishu），我们用自家 fork（id=feishu-her，
# 但 channel id 也是 feishu），两个冲突，必须把官方那份 3 处残留都清掉：
#   /app/extensions/feishu
#   /app/dist/extensions/feishu
#   /app/dist-runtime/extensions/feishu
RUN rm -rf /app/extensions/feishu /app/dist/extensions/feishu /app/dist-runtime/extensions/feishu

# 轴 2: feishu-her 插件（CarHer fork，独立 semver）
COPY docker/plugins/feishu-her  /app/docker/plugins/feishu-her
RUN cd /app/docker/plugins/feishu-her && npm install --omit=dev --ignore-scripts

# 轴 3: a2a-gateway 插件（独立 semver）
COPY docker/plugins/a2a-gateway /app/docker/plugins/a2a-gateway
RUN cd /app/docker/plugins/a2a-gateway && npm install --omit=dev --ignore-scripts

# CarHer 共享配置（shared / L2 / L3 overlay）
COPY docker/shared-config.json5 /app/docker/shared-config.json5
COPY docker/user-configs        /app/docker/user-configs

# Entrypoint
COPY scripts/carher-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
```

### 层缓存语义

- 改 `feishu-her` 代码 → 只重跑第 8-9 层及以后，**base 和 apt 不动**
- 改 `a2a-gateway` 代码 → 只重跑第 10-11 层及以后
- 改 `OPENCLAW_TAG` → FROM 层 hash 变了，**所有下游层缓存失效**（这是 Docker BuildKit 的固有行为，不是设计缺陷）

### 已知优化点

当前 Dockerfile 没加 `--mount=type=cache,target=/root/.npm`，导致 base 升级时两个 `npm install` 会重新从网上下载所有依赖包。已实测升级一次耗时 **~855s (14 min)**，加上 npm cache mount 后预期可降到 **3-5 min**。属于下一轮可以优化的小尾巴。

---

## 四、升级与回滚流程

### 升级 OpenClaw 核心（跟官方发版）

```bash
# 1. 改 Dockerfile ARG
#    ARG OPENCLAW_TAG=2026.4.14  →  ARG OPENCLAW_TAG=2026.4.15

# 2. 构建新镜像（起新 tag，不覆盖旧的）
docker build -f Dockerfile.carher.v2 \
  --build-arg OPENCLAW_TAG=2026.4.15 \
  -t carher-core:0415-ab-v2 .

# 3. 灰度：先停一个测试用户，用新镜像起
docker rm -f carher-102
./compose --id=102 --image=carher-core:0415-ab-v2

# 4. 验证：7 plugins ready + A2A peers 发现 + Feishu WSClient connected + 真人发消息
docker logs carher-102 | grep "gateway] ready"

# 5. 全量推广（后续 200 用户） / 或回滚到旧 tag（见下）
```

### 回滚

```bash
docker rm -f carher-102
./compose --id=102 --image=carher-core:0414-ab-v2   # 旧 tag
```

**关键原则**：每次构建都**起独立 tag**，永远不覆盖 `carher-core:latest` / `carher:local`。回滚就是换 tag，不是重新构建旧版本。

### 独立升级某个插件（不动 OpenClaw）

```bash
# 改 docker/plugins/feishu-her/ 下代码后
docker build -f Dockerfile.carher.v2 \
  --build-arg OPENCLAW_TAG=2026.4.14 \
  -t carher-core:0414-feishu-her-v1.2.3 .
```

BuildKit 会命中前 6 层缓存（base + apt），只重跑 feishu-her 那一层。

---

## 五、与旧架构的对比

| 维度                    | 旧 `Dockerfile.carher`                          | 新 `Dockerfile.carher.v2`                                  |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| Base 镜像               | `node:22-bookworm`（通用）                      | `ghcr.io/openclaw/openclaw:<tag>`（官方）                  |
| OpenClaw core           | 仓库源码 `COPY . .` + `pnpm build:docker`       | 官方镜像直接自带                                           |
| feishu-her              | `extensions/feishu`（bundled + pnpm workspace） | `docker/plugins/feishu-her/`（独立 package）               |
| a2a-gateway             | `docker/plugins/a2a-gateway/`（已经是插件形式） | 同前，但 `npm install` 层更严格（失败不忽略）              |
| realtime（Gemini Live） | `extensions/realtime/` 编进镜像                 | **已移除**（CarHer 产品线不再使用）                        |
| 升级 OpenClaw           | 全量 `pnpm install + build:docker`（~5-10 min） | 只改 ARG + 重跑 2 个 npm install 层（~3-5 min 配合 cache） |
| 升级路径可追溯性        | 一次构建可能糅合 3 个模块的代码变化             | 三条轴独立 tag，哪条动了一眼看出                           |
| 官方 plugin 冲突        | 不会（我们的 feishu 就是 bundled）              | 需显式清掉 `/app/{extensions,dist,dist-runtime}/feishu`    |

---

## 六、插件目录布局

```
<仓库根>/
├── Dockerfile.carher.v2              # 新架构 Dockerfile
├── scripts/
│   └── carher-entrypoint.sh
└── docker/
    ├── plugins/                       # ← 所有 CarHer 自有插件都放这里
    │   ├── feishu-her/                # 轴 2: feishu 插件 fork
    │   │   ├── index.ts
    │   │   ├── openclaw.plugin.json
    │   │   ├── package.json           # 独立 semver
    │   │   └── src/
    │   └── a2a-gateway/               # 轴 3: A2A gateway 插件
    │       ├── index.ts
    │       ├── openclaw.plugin.json
    │       ├── package.json           # 独立 semver
    │       └── ...
    ├── shared-config.json5            # L1 全局共享
    ├── carher-config.json             # L2 Docker 共享
    └── user-configs/
        └── carher-config-<N>.json     # L3 per-user（compose 生成，勿手改）
```

容器内部 OpenClaw 发现这些插件的方式是 `plugins.load.paths`（由 `compose` 注入运行时配置），指向 `/app/docker/plugins/*`。

---

## 七、插件独立演进规则

每个 `docker/plugins/*/package.json` 是**独立的 npm 包**：

- 有自己的 `version`（不跟 OpenClaw core 绑定）
- 有自己的 `dependencies`（不污染根 `package.json`）
- `openclaw` 必须放 `devDependencies`（运行时通过宿主注入，不走 require）

**PR / Review 口径**：

- 改 `docker/plugins/feishu-her/` 的 PR = feishu-her 插件的 PR，改它的 `package.json` 里的 `version`
- 改 `docker/plugins/a2a-gateway/` 的 PR = a2a-gateway 插件的 PR，同上
- 改 `Dockerfile.carher.v2` 的 `ARG OPENCLAW_TAG` 的 PR = "跟官方升级"的 PR
- 三类 PR 应尽量不混在一起

---

## 八、已知权衡与未决项

1. **base 升级缓存失效**：加 npm cache mount 之前，跟官方升级每次 ~14 min。生产要求 <5 min 的话应先补上。
2. **插件 `openclaw.plugin.json` schema 漂移**：如果官方 OpenClaw 升级改了 plugin manifest schema（字段强校验变严），我们自家 fork 可能需要同步更新，属于"蹭官方版本"的隐性成本。
3. **bundled feishu 残留清理**：当前用 `rm -rf` 3 个目录，如果官方哪天再把 bundled feishu 放到第 4 个位置，我们会踩坑。理想方案是 OpenClaw 官方支持 `plugins.disable: ["feishu"]` 机制（已向上游提过建议）。
4. **灰度粒度**：当前 200 用户灰度是 shell for-loop，没有按组/按批的策略。短期内不是瓶颈，但随用户扩张需要。

---

## 九、迁移历史

- **2026-04-14**: worktree `carher-ab-decouple` 起，Dockerfile.carher.v2 + `docker/plugins/` 目录就位
- **2026-04-15**: 三轴独立升级/回滚端到端演练通过（102 用户作为灰度 canary），方案确认可行
- **2026-04-20**: realtime 插件正式移除（产品线不再需要）；本文档作为新架构的 single source of truth

---

## 相关文档

- [`her-feishu-bot-enterprise-deploy.md`](./her-feishu-bot-enterprise-deploy.md) — 部署操作手册（OAuth / Cloudflare / 排障）
- [`config-architecture.md`](./config-architecture.md) — 配置三层（shared / docker / per-user）
- [`her-a2a-architecture.md`](./her-a2a-architecture.md) — A2A gateway 协议
- [`her-feishu-bot-architecture.md`](./her-feishu-bot-architecture.md) — feishu-her 插件设计
