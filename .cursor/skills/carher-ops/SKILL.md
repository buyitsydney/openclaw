---
name: carher-ops
description: CarHer 统一运维手册：A+B 架构 + 3 层 config + compose 部署 + registry 分发 + 灰度 + 自检 + 回滚 + CSV 同步 + Admin。Use when the user mentions 董事长, her, docker, 容器, 服务器, server, carher, 健康检查, 重启, restart, 日志, CSV, open_id, owner, pairing, 升级 openclaw, 升级到 xxxx.x.xx 版本, 跟官方发版, 换 base, 换 FROM tag, 回滚 carher-core, 换镜像 tag, or any enterprise deployment operation.
---

# CarHer 统一运维手册

> **本文件是唯一权威**。

---

## 第 1 章 · 架构真相（A+B 三轴 + compose 部署）

CarHer 运行镜像 = **官方 OpenClaw base 镜像（A）** + **自家插件层（B）**，两者独立：

```
carher-core:<TAG>
└── FROM ghcr.io/openclaw/openclaw:${OPENCLAW_TAG}   ← 轴 1，官方每周发版
    + docker/plugins/feishu-her/                      ← 轴 2，自家 channel 插件
    + docker/plugins/a2a-gateway/                     ← 轴 3，自家 A2A 插件
    + docker/plugins/shadow-daemon/                   ← 轴 B3
```

**三层 Config（git-tracked，100% 运行时 bind mount）**：

```
config/base.json5        ← L1: 全局默认（model、tools、admin allowlist）
  ↑ $include
config/docker.json5      ← L2: docker 共享（redis、groups、gateway、reasoning kill switch）
  ↑ $include
config/u{N}.json5        ← L3: per-user 身份（feishu appId/secret/botOpenId）
```

Image 不含任何 config；config 100% 通过 compose.yaml 的 bind mount 注入。

**部署方式：docker compose + registry 分发**：

```
deploy/carher-{id}/
├── compose.yaml     ← declarative service 定义
├── .env             ← IMAGE_TAG（唯一升级入口，git-tracked）
└── secrets.env      ← gitignored: FEISHU_APP_SECRET 等
```

升级 = 编 `.env` 的 `IMAGE_TAG` → `docker compose up -d`。

完整架构文档：[`docs/her/her-build-deploy-architecture.md`](../../docs/her/her-build-deploy-architecture.md)

---

## 第 2 章 · 当前部署真相（2026-05-09)

**S1 + S3 全部 7 个 bot 已 compose 化。2026-05-09 已验证到 dev `67ffa4069b` + image `localhost:5001/carher-core:2026.5.9-p14-a2a-route`；knownBots/history-fill、A2A registry S1/S3 路由、跨主机 agent-card、S1↔S3 A2A healthcheck 均已通过。**

| 位置              | 容器         | 用户        | Bot App ID             | 当前 image / runtime patch |
| ----------------- | ------------ | ----------- | ---------------------- | -------------------------- |
| S1 (10.68.13.186) | `carher-12`  | test/tester | `cli_a917fa892ff91bb5` | `2026.5.9-p14-a2a-route`   |
| S1 (10.68.13.186) | `carher-13`  | 卜弋天      | `cli_a917e5525178dbb3` | `2026.5.9-p14-a2a-route`   |
| S1 (10.68.13.186) | `carher-198` | admin/研究1 | `cli_a96f0bfba3789cd4` | `2026.5.9-p14-a2a-route`   |
| S1 (10.68.13.186) | `carher-199` | 研究2       | `cli_a96f043660f99cef` | `2026.5.9-p14-a2a-route`   |
| S1 (10.68.13.186) | `carher-200` | 研究3/Nova  | `cli_a96f044b4ef95cc0` | `2026.5.9-p14-a2a-route`   |
| S3 (10.68.13.188) | `carher-14`  | 刘国现      | `cli_a91569fab9b81bc6` | `2026.5.9-p14-a2a-route`   |
| S3 (10.68.13.188) | `carher-75`  | 林森        | `cli_a94a0b73a878dbcb` | `2026.5.9-p14-a2a-route`   |

**A2A hub 名单**(`a2a-gateway.outbound.enabled=true`):13 / 198 / 199 / 200。其他全 spoke。

**Bot Registry / knownBots 真相**:三组件架构下 `openclaw-lark` 是 channel,`feishu-her/gateway.ts` 不一定启动;动态 knownBots 必须由 `docker/plugins/feishu-her/index.ts` 在 plugin register 阶段启动 `initBotRegistry()`。history-fill 注入 group context 时也必须消费 Redis Bot Registry / `account.knownBots`,把 app sender 渲染成 `弋天的her (cli_a917...)`,不能让模型只看到裸 `cli_xxx`。

**A2A Registry 真相**:每台物理服务器必须在 `docker/server.env` / per-user `.env` 里显式设置 `CARHER_SERVER`(`S1`/`S3`) 和 `CARHER_LAN_IP`。如果 S1/S3 都注册成 `server=local`,`a2a-gateway` 会误判跨机 peer 为同机,优先走 Docker DNS `http://carher-N:18800`,导致“S1 的 her 找不到 S3 的 her”。当前代码已在 `docker/plugins/a2a-gateway/src/registry.ts` 加兜底:当 `server=local` 且 peer 有非 loopback LAN endpoint 时优先走 LAN,但正确运维仍是修 `.env` 后 recreate。

**Mac 本地测试容器**（id=101/102/103/104）:`carher-101`=tester, `carher-102`=tester2, `carher-103`=tester3, `carher-104`=tester4。

**行动原则**:`docker/servers.txt` 是手动维护的真相表。S1 `/Data/CarHer` remote 名通常是 `carher`;S3 remote 名通常是 `origin`,不要在 runbook 里写死同一个 remote。

---

## 第 3 章 · 镜像构建 + Registry 分发

### 构建命令（`deploy/build-and-push.sh` 或手动）

```bash
# 方式 1：脚本（推荐）
./deploy/build-and-push.sh                              # → localhost:5001/carher-core:<date>
./deploy/build-and-push.sh --registry=ghcr.io/YOUR_USER # → ghcr.io push

# 方式 2：手动
DOCKER_BUILDKIT=1 docker build -f Dockerfile.carher.v2 \
  --build-arg OPENCLAW_TAG=2026.X.Y \
  --build-arg BUILD_HASH=$(git rev-parse --short HEAD) \
  -t carher-core:<TAG> .
```

- BuildKit **必须开**（cache mount 依赖）
- Image labels 自动注入：`carher.build.hash`、`carher.openclaw.tag`（可追溯）
- **永远不覆盖旧 tag**，至少保留 30 天
- `scripts/freeze-git-info.sh` 在 build 前生成 `/opt/carher/image-info.json`，默认只索引 `HEAD` 最近 200 条 commit。**不要改成 `git log --all` 或无上限历史**；S1/S3 有大量 stale refs/worktree/备份分支，会把发布卡在 Docker build 前。一次性取证才显式传 `CARHER_FREEZE_DEPTH` / `CARHER_FREEZE_SCOPE`。

### 升级 = 改 1 个字符串

```bash
# 改 Dockerfile.carher.v2 的 ARG OPENCLAW_TAG
ARG OPENCLAW_TAG=2026.X.OLD  →  ARG OPENCLAW_TAG=2026.X.NEW
```

### Registry 分发（取代 docker save|load）

```bash
# 本地 PoC registry
docker run -d --name carher-registry --restart unless-stopped \
  -p 5001:5000 -v carher-registry-data:/var/lib/registry registry:2

# 生产（ghcr.io）
echo $GH_PAT | docker login ghcr.io -u YOUR_USER --password-stdin
./deploy/build-and-push.sh --registry=ghcr.io/YOUR_USER

# 服务器只需 docker pull，不需要 git clone、不需要源码
docker pull ghcr.io/YOUR_USER/carher-core:2026.4.30
```

### 构建时间预期

| 场景                  | 时间   |
| --------------------- | ------ |
| 冷（首次新 base tag） | ~30min |
| 热（same base 改 B）  | 3-5min |

### 升级前检查

1. 查官方新 tag：`gh release list --repo openclaw/openclaw --limit 10`
2. 读 Release Notes 看 breaking change（关注 `Plugin SDK`、`channel contract`、`feishu`）
3. 预热：`docker pull ghcr.io/openclaw/openclaw:2026.X.Y`
4. Gate 1 — `peerDependencies` 范围
5. Gate 2 — `ls patches/drift-fix/` 查已知漂移 patch

---

## 第 4 章 · 容器部署（docker compose）

### 部署文件结构

每个用户有 `deploy/carher-{id}/` 目录：

```
deploy/carher-13/
├── compose.yaml     ← service 定义（resource limits、bind mounts、env）
├── .env             ← IMAGE_TAG=carher-core:dev-0430-full（唯一升级入口）
└── secrets.env      ← gitignored: FEISHU_APP_SECRET, ANTHROPIC_AUTH_TOKEN 等
```

### Scaffold 新用户

```bash
./deploy/scaffold.sh N    # 从 common/compose.template.yaml + users.csv 生成 deploy/carher-N/
```

### 标准启动

```bash
cd deploy/carher-N
docker compose up -d
```

资源限制（10 CPU + 16GiB RAM）、bind mounts、环境变量全部声明在 compose.yaml 里，无需记忆任何参数。

### 升级到新 image

```bash
# 编辑 .env: IMAGE_TAG=carher-core:<new-tag>
cd deploy/carher-N && docker compose up -d
# compose 检测到 image 变化，自动 recreate，volume 保留
```

### 重启（config 变了）

```bash
cd deploy/carher-N && docker compose up -d --force-recreate
```

### Compose `${VAR}` 替换注意

Compose 的 `${VAR}` 在 **parse 时** 从 shell env / project `.env` 读取，**不从 `env_file:` 指令读取**。`scaffold.sh` 自动从 `docker/server.env` 提取 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`CARHER_LAN_IP` 写入每个用户的 `.env`。

服务器上可用 `deploy/dc.sh` 包装器自动加载 `server.env`：

```bash
cd deploy/carher-N && ../../deploy/dc.sh up -d
```

### A2A Hub 名单（铁律）

**永久 hub 节点(god mode,outbound.enabled=true)**:

- `carher-13`(弋天)
- `carher-198`(admin / 研究1)
- `carher-199`(研究2)
- `carher-200`(研究3)

这 4 个的 `config/u<N>.json5` 必须包含:

```json5
plugins: {
  entries: {
    "a2a-gateway": { config: { outbound: { enabled: true } } },
  },
}
```

### 验证

```bash
docker compose logs carher | grep -E 'WSClient connected|starting WebSocket connection'
docker compose logs carher | grep 'gateway] ready'
docker compose logs carher | grep 'acpx.*ready'
```

### Config bind mount 映射

```yaml
volumes:
  - ../../config/u${USER_ID}.json5:/data/.openclaw/openclaw.json:ro
  - ../../config/base.json5:/data/.openclaw/base.json5:ro
  - ../../config/docker.json5:/data/.openclaw/docker.json5:ro
```

---

## 第 5 章 · 灰度铁律（违反者死）

### 铁律清单

1. **必须用自己的 worktree**：`git worktree add /tmp/xxx-wt origin/dev --detach`
2. **必须用独立分支**，绝不碰服务器的 dev/main
3. **必须用独立 image tag**（如 `carher-core:grey-0430`），绝不碰 `carher:local`
4. **绝不在服务器上 checkout dev**，绝不 `git pull` dev
5. **worktree 必须 symlink server.env 和 users.csv**
6. **三台服务器必须全用 worktree**

### 完整灰度流程

```bash
# 1. 本地 push 分支
git push carher feat/xxx

# 2. 服务器创建持久化 worktree
cd /Data/CarHer
git fetch origin
git worktree add /tmp/xxx-wt origin/feat/xxx --detach

# 3. symlink gitignored 配置
cd /tmp/xxx-wt
ln -sf /Data/CarHer/docker/server.env docker/server.env
ln -sf /Data/CarHer/docker/users.csv docker/users.csv

# 4. 从 worktree 构建镜像
DOCKER_BUILDKIT=1 docker build -f Dockerfile.carher.v2 \
  --build-arg OPENCLAW_TAG=2026.X.Y \
  --build-arg BUILD_HASH=$(git rev-parse --short HEAD) \
  -t carher-core:<TAG> .

# 5. 用 scaffold 生成 compose 目录，或手动编辑 .env
cd deploy/carher-N
# 编辑 .env: IMAGE_TAG=carher-core:<TAG>
docker compose up -d

# 6. 验证
docker compose logs -f carher | grep -E 'WSClient connected|starting WebSocket connection'
```

### 回滚（改回 .env IMAGE_TAG）

```bash
# 编辑 .env: IMAGE_TAG 改回旧值
cd deploy/carher-N && docker compose up -d
# volume 保留，sessions/memory 不丢
```

---

## 第 6 章 · 自动自检 11 Gate

```bash
scripts/carher-verify.sh --id=N --wait=60
# exit 0 = 全过 / exit 3 = 有 FAIL / exit 2 = 容器不存在
```

| #   | Gate                       | 检查内容                                                               | 失败含义                        |
| --- | -------------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| 1   | gateway ready              | `[gateway] ready`                                                      | 容器没起来                      |
| 2   | plugin 数量                | N ≥ 7                                                                  | A+B 缺插件                      |
| 3   | feishu websocket           | `WSClient connected` 或 `starting WebSocket connection`                | token 失效或 appId 错           |
| 4   | A2A peers                  | `refreshRegistryPeers found N`, N>0                                    | Redis 或 A2A 未启用（警告）     |
| 5   | acpx runtime               | `acpx runtime backend ready` / `embedded acpx` / `ACP ready`           | ACP 未启用（警告）              |
| 6   | 无 plugin 契约错误         | 无 `plugin validation/schema failed`                                   | **SDK drift — 立刻回滚**        |
| 7   | openclaw-lark channel-only | runtime manifest 中 `contracts.tools=[]` 且 `skills=[]`                | 上游 lark tools/skills 吃上下文 |
| 8   | runtime patch markers      | command-body / history-fill / inbound-meta / reply-card / session-decay marker 全在 | runtime patch 未落地            |
| 9   | a2a-gateway ioredis        | `node_modules/ioredis` 存在                                            | npm install 失败                |
| 10  | feishu-her 依赖            | `@larksuiteoapi` 存在                                                  | feishu 连不上                   |
| 11  | 无严重运行时错误           | 无 `FATAL/uncaughtException/crash`                                     | 立刻回滚                        |

### Monitor 模板

```bash
docker compose logs -f carher 2>&1 | grep --line-buffered -E \
  "(deliver:|gateway\] ready|starting WebSocket connection|WSClient connected|command-body normalize|history-fill|inbound-history metadata|reply-card default|session-decay|acpx runtime backend ready|refreshRegistryPeers found|Error|FAILED|exception|plugin (validation|schema))"
```

### 真人验收（11 gate 之外必做）

请真人在飞书私聊发：`你好。检查下 A2A 和 ACP 状态？`
期望：回复含 `A2A ✅` 和 `ACP` 关键词。

---

## 第 7 章 · 回滚

### 同大版本回滚（秒级）

```bash
# 编辑 deploy/carher-N/.env: IMAGE_TAG=carher-core:<旧 tag>
cd deploy/carher-N && docker compose up -d
# volume 保留，recreate 秒级
```

### 跨 schema 回滚（4.x → 3.x）

```bash
# 1. 注释 config/docker.json5 里新版 only 的 key
# 2. 清持久 config
docker rm -f carher-N
docker run --rm -v carher-N-data:/data alpine rm -f /data/openclaw.json
# 3. 编辑 .env IMAGE_TAG 到旧 tag，compose up -d
cd deploy/carher-N && docker compose up -d
```

**旧 image 至少保留 30 天，不要 `docker rmi`。**

---

## 第 8 章 · CSV / open_id 同步铁律

### 跨服务器同步

`feishu_bot_open_id`（CSV 第 10 列）必须在 **所有服务器的 CSV** 上同步。S1/S2/S3 各有独立副本，缺一不可。

### 批量获取 bot open_id

```bash
python3 -c '
import csv, json, urllib.request
with open("/Data/CarHer/docker/users.csv") as f:
    for row in csv.reader(f):
        if row[0].startswith("#") or not row[3].strip(): continue
        app_id, app_secret = row[3].strip(), row[4].strip()
        try:
            data = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode()
            req = urllib.request.Request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
                data=data, headers={"Content-Type": "application/json"})
            token = json.load(urllib.request.urlopen(req))["tenant_access_token"]
            req2 = urllib.request.Request("https://open.feishu.cn/open-apis/bot/v3/info",
                headers={"Authorization": "Bearer " + token})
            bot = json.load(urllib.request.urlopen(req2))["bot"]
            print(f"{row[0]},{row[1]},{app_id},{bot['open_id']}")
        except Exception as e:
            print(f"{row[0]},{row[1]},{app_id},ERROR:{e}")
'
```

### Owner 机制

| 场景     | CSV 列                 | 生成配置                  |
| -------- | ---------------------- | ------------------------- |
| 专属 Bot | `feishu_owner_open_id` | `dm.allowFrom`            |
| 共享 Bot | `owner_allow_from`     | `commands.ownerAllowFrom` |

无 Owner → AI 看不到 cron/gateway 等 `ownerOnly` 工具。

---

## 第 9 章 · Admin 容器 carher-198

**历史**：裸机 `yitian-her` 已退役（2026-04-23），由 docker `carher-198`（研究1）充任 admin。

### 启动

```bash
cd deploy/carher-198
docker compose up -d
```

compose.yaml 里已声明 ACP、资源限制、A2A hub 配置。admin 特权通过 `bootstrap-admin.sh` 注入。

### bootstrap 内容

| #   | 资产                        | docker rm 后 |
| --- | --------------------------- | ------------ |
| 1   | sshpass + openssh-client    | 丢           |
| 2   | /data/.openclaw/servers.txt | 保留(volume) |
| 3   | admin 运维 skills           | 可能丢       |

### 禁忌

- 不要擅自 `docker rm carher-198`
- 不要再启动裸机 yitian-her（会抢 WebSocket）

---

## 第 10 章 · Runtime / Build-time Patch 体系(2026-05-09+)

carher 对 openclaw / 闭源上游 npm 包打的本地 patch。**修改前必读本章;任何一个 patch section 被误删 → 功能静默失效、用户先察觉、debug 路径很长。**

### 判定规则:runtime vs build-time patch

| 目标文件会被 runtime 覆盖吗?           | 路径                                                                                           | 典型                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| 会(npm install 重写 / bind-mount 覆盖) | **entrypoint runtime patch**(`scripts/carher-entrypoint.sh` 每次 container 启动)               | stripBotMentions / P8 history-fill / reply-card default |
| 不会(image COPY read-only layer)       | **Dockerfile build-time patch**(`scripts/apply-reset-archive-patches.sh`,`RUN` 走 build layer) | (当前无;P7 已撤)                   |

选错方向 = 下次 npm install / image rebuild 时 patch 失效。

### ⚠️ 改 entrypoint.sh 的铁律

- **任何对 `scripts/carher-entrypoint.sh` 的 diff,commit message 必须显式列出所有被 add / remove 的 section header**(本章表格里的 name)。
- Reviewer 必须逐个 section 核对,**只要有一个少了就打回**。
- 教训:`f3d83cfd493`(2026-05-05) 加 a2a-gateway manifest patch 时顺手删了整个 CommandSource section,commit message 只提 a2a-gateway。后来 2026-05-08 尝试恢复才发现 CommandSource 方向在群里根本无效(见 R-7 条目),但这不降低"改 entrypoint 必须列 section diff"这条铁律的重要性。

### 完整 Patch 清单(2026-05-09,9 个 runtime + 1 个 no-op build-time stub)

#### 🔧 R-1:`stripBotMentions` (runtime, entrypoint)

- **Target**:`$LARK_PKG/src/messaging/inbound/parse.js` L102
- **Upstream**:`@larksuite/openclaw-lark`(闭源 npm,不能提 PR)
- **Bug**:硬编码 `stripBotMentions: true` → 多 bot 群 @ 多 bot 时,每个 bot prompt 里自己的 @ 被剥掉 → LLM 判"没被 @" → NO_REPLY → 群装死
- **Fix**:sed `stripBotMentions: true` → `false`
- **Kill switch**:`CARHER_DISABLE_STRIP_BOT_MENTIONS_PATCH=1`
- **log 成功**:`✓ openclaw-lark stripBotMentions → false`

#### 🔧 R-2:`openclaw-lark manifest → channel-only` (runtime, entrypoint)

- **Target**:`$LARK_PKG/openclaw.plugin.json`
- **Reason**:三组件架构下 openclaw-lark 只保留 channel(feishu 消息收发);tools 由 lark-cli 接管,skills 吃 context
- **Fix**:node 改 manifest,`contracts.tools = []` + `skills = []`
- **Kill switch**:无(删 section 即回)
- **log 成功**:`✓ openclaw-lark stripped to channel-only`

#### 🔧 R-3:`feishu-her manifest 加 contracts.tools + activation.onStartup` (runtime, entrypoint)

- **Target**:`/app/docker/plugins/feishu-her/openclaw.plugin.json`
- **Reason**:openclaw 0503 要求 plugin 显式声明 contracts.tools;feishu-her 30 个 tool 名单要对上 index.ts 里的 registerTool 调用
- **Fix**:node 改 manifest,塞 30 个 tool 名 + `activation: {onStartup: true}`
- **Kill switch**:无
- **log 成功**:`✓ contracts.tools (30) + activation.onStartup patched`

#### 🔧 R-4:`shadow-daemon manifest 加 activation.onStartup` (runtime, entrypoint)

- **Target**:`/app/docker/plugins/shadow-daemon/openclaw.plugin.json`
- **Reason**:shadow-daemon 要在 container 启动时就 sync,必须显式 onStartup
- **Fix**:node 改 manifest,`activation: {onStartup: true}`(幂等)
- **Kill switch**:无

#### 🔧 R-5:`patch-agent-loop.sh` — antitalker M1 stop-hook-pipeline (runtime, entrypoint)

- **Target**:`/app/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`
- **Upstream**:`@mariozechner/pi-agent-core`(开源,但 agent-loop 没 extension point)
- **Bug / Reason**:openclaw `AgentLoopConfig` 里 `getFollowUpMessages` hook 在 feishu path 默认 empty,antitalker 同 turn 续命无接入点
- **Fix**:script `/app/docker/plugins/her-antitalker-poc/patch-agent-loop.sh` 插入 `globalThis.__openclaw_stopHookPipeline` fallback
- **Kill switch**:无 env(可临时 `sed -i "2i exit 0" /app/docker/plugins/her-antitalker-poc/patch-agent-loop.sh` + restart + 手 cp `.orig.<ts>` 回 agent-loop.js)
- **log 成功**:`[patch-agent-loop] PATCHED ...` 或 `[patch-agent-loop] SKIP: ... already patched`

#### 🔧 R-6:`P8 proactive 20-msg history fill + metadata` (runtime, entrypoint)

- **Target**:`$LARK_PKG/src/messaging/inbound/dispatch.js`(加 require helper 的一行注入,并把 entry 的 `messageId/messageType/replyToId` 传给 InboundHistory)+ `$LARK_PKG/src/messaging/inbound/carher-history-fill.js`(helper,cp from bind-mount)+ `/app/dist/get-reply-*.js`(旧 dist 若还没从 dev 源码构建,由 `apply-inbound-history-meta.sh` 补渲染)
- **Upstream**:`@larksuite/openclaw-lark`(闭源)
- **Bug**:三组件迁移后 group 历史只走被动 WS event 累积;bot 重启 / 群冷场 > 20 秒 → 被 @ 时 0 条上下文,"失忆"
- **Fix**:被 @ 时(非 `/` 系统命令)优先执行 `lark-cli im +chat-messages-list --chat-id <oc_...> --page-size 20 --sort desc --format json`(默认 user 身份)拉最近消息填 Map;这是 Her 自己做 1:1 审计用的真实群消息视图。lark-cli 不可用时才 fallback 到 `/im/v1/messages?card_msg_content_type=raw_card_content`;补出的 entry 必须把 sender 渲染成 `姓名 (open_id/cli_id)` label,其中 app sender 必须走 Redis Bot Registry / `knownBots` 映射(例如 `弋天的her (cli_a917...)`),不能把裸 `cli_xxx` 注入给模型;并带上 `messageId`/`messageType`/`replyToId`,最终模型看到的 JSON 必须有 `message_id`/`message_type`/`reply_to_id`;interactive/card 不能信任降级 list item, fallback 路径仍需按 `message_id` 拉 canonical message 并解析;仍失败只能注入媒体占位,不能把 `请升级至最新版本客户端，以查看内容` 这类坏文案交给模型
- **事故记忆(2026-05-09)**:旧 helper 只写 `sender=open_id` 且把 interactive/card 保留为 raw JSON,导致 `carher-75` 在群 context 中错认“超过限额非常惨”这句话是谁说的。随后又确认 Her 通过 `lark-cli im +chat-messages-list --format json` 默认 user-token 能看到完整 `<card>` 内容,但 runtime context 注入只拿到 `请升级至最新版本客户端，以查看内容`,且丢了 `reply_to` 链。当天第二个归因事故是新三组件补丁没有消费旧 `feishu-her` 的 `knownBots`/动态 Bot Registry,多 Her 群里 app sender 退化成裸 `cli_a94...` / `cli_a917...`,模型只能靠记忆猜谁是谁。以后改 P8 必须保留 lark-cli primary path + sender label + app sender Registry 映射 + `message_id/message_type/reply_to_id` + converter + placeholder 拦截 + fallback canonical refetch 回归测试。
- **Source**:`scripts/carher-patches/`(bind-mount 成容器 `/carher-patches:ro`)
- **Kill switch**:
  - `CARHER_DISABLE_HISTORY_FILL_PATCH=1` (boot 时完全 skip patch)
  - `CARHER_DISABLE_HISTORY_FILL=1` (patch 在但 helper runtime no-op)
  - `CARHER_DISABLE_INBOUND_HISTORY_META_PATCH=1` (只 skip 旧 dist 的 `message_id`/`reply_to_id` 渲染补丁)
- **log 成功**:`✓ history-fill patch applied (helper + dispatch.js)` + `✓ inbound-history metadata patch applied` + 运行时 `[carher-history-fill] done ... filled 19 via lark-cli in NNNms`

#### 🔧 R-7:`command-body mention normalization` — 群 /new @bot 修复 (runtime, entrypoint)

- **Target**:`$LARK_PKG/src/messaging/inbound/dispatch.js`
- **Source**:`scripts/carher-patches/apply-command-body-normalize.sh`
- **Marker**:`CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER`。看到旧 `CARHER_COMMAND_BODY_NORMALIZE_PATCH_MARKER` 或 `NONE` 都视为未升级。
- **Bug**:`stripBotMentions=false` 修好多 bot @ 后,群命令的 `ctx.content` 保留了 bot mention。`/new @弋天的her` 进入 core 时变成 `CommandBody="/new @弋天的her"`;core 把 mention 当作 `/new <tail>` 的 prompt tail,于是 reset 后继续进 LLM,最终 `NO_REPLY`,看不到 `✅ New session started.`。`@bot /new` 还会因为 slash 不在首位而直接进 agent。`/new @bot1 @bot2` 如果只剥当前 bot mention,另一个 mention 仍会成为 tail。
- **Fix**:只在 slash-command command surface 归一化:
  - 普通 LLM 输入仍保留 bot mention(不回退 R-1)
  - `CommandBody` 去掉命令面里的地址 mention:`/new @bot` → `/new`,`@bot /new` → `/new`,`/new @bot1 @bot2` → `/new`
  - 群里 slash command 如果 mention 了别人但没 mention 当前 bot,当前 bot 直接 ignore,避免多 bot 群误响应
- **V1→V2 upgrade**:脚本如果发现 V1 marker,会从 `${dispatch}.bak.command-body-normalize` 恢复原始 dispatch.js 后重打 V2。不要手删 backup;否则已经打过 V1 的持久化 volume 无法自动升级。
- **Kill switch**:`CARHER_DISABLE_COMMAND_BODY_NORMALIZE_PATCH=1`
- **log 成功**:`✓ command-body normalize patch applied`
- **反例**:不要再打 `CommandSource:native` 或直接 `sendMessageFeishu` ack。前者导致 `/status` 双回复,后者绕过 core reset 语义。

#### 🔧 R-8:`temporalDecay session-reset path parser` (runtime, entrypoint)

- **Target**:`/app/dist/manager-<hash>.js`(entrypoint glob 找含 `applyTemporalDecayToHybridResults` 的 dist 文件)
- **Source**:`scripts/carher-patches/apply-session-decay.sh`
- **Marker**:`CARHER_SESSION_DECAY_PATCH_MARKER`
- **Bug**:openclaw 2026.5.3 的 `extractTimestamp` 对 session 路径走 `fs.stat` fallback;chunks DB 存的 path = `sessions/main/<id>.jsonl[.reset.<ISO>.Z]`,实际文件在 `<agentDir>/sessions/<id>...`,**多了一层 `main/`**,fs.stat ENOENT → 返回 null → decay 全跳过。结果:打开 `temporalDecay.enabled=true` 反而把 `memory/YYYY-MM-DD.md` 精华笔记压下去,session-archive 噪音原地不动 — 召回更糟。
- **Fix**:在 `extractTimestamp` 里 `if (fromPath) return fromPath;` 之后,加 `parseSessionResetDateFromPath` 直接从 `.reset.YYYY-MM-DDTHH-MM-SS.<ms>Z` 文件名解析时间。完全 bypass fs.stat,所以 workspaceDir 错位也无所谓。覆盖率:baseline 13 上 76% session-archive 命中里有 71%(.reset 后缀的)被修好,剩下 5% 是 live `.jsonl`,继续走原 fs.stat fallback。
- **Kill switch**:`CARHER_DISABLE_SESSION_DECAY_PATCH=1`
- **log 成功**:`✓ session-decay patch applied`
- **配套 config**:还需要 `agents.defaults.memorySearch.query.hybrid.temporalDecay = {enabled:true, halfLifeDays:7}`(13 灰度在 `config/u13.json5`,验证后 promote 到 `config/docker.json5`)
- **upstream**:同 fix 已在 `extensions/memory-core/src/memory/temporal-decay.ts` 提交 + 6 个测试,可作为 openclaw/openclaw PR

#### 🔧 R-9:`reply-card default` — 普通群回复统一 interactive card (runtime, entrypoint)

- **Target**:`$LARK_PKG/src/card/reply-mode.js`
- **Source**:`scripts/carher-patches/apply-reply-card-default.sh`
- **Marker**:`CARHER_REPLY_CARD_DEFAULT_PATCH_MARKER`
- **Bug**:旧 `feishu-her` 的 user-facing text 会走 Feishu interactive card;三组件迁移后 channel 改由 `@larksuite/openclaw-lark` 负责。上游 static group mode 的 `shouldUseCard(text)` 只在 markdown table / fenced code block 时返回 true,普通短回复落成 `msg_type=post`,导致同一个 Her 一会儿发漂亮 card、一会儿发丑文本。
- **Fix**:把 `shouldUseCard(text)` 改成“任意非空文本默认 card”,但保留 `FEISHU_CARD_TABLE_LIMIT` 保护:如果 markdown table 数超过上游卡片限制,仍返回 false 走 post fallback,避免大表格发不出去。
- **Kill switch**:`CARHER_DISABLE_REPLY_CARD_DEFAULT_PATCH=1`
- **log 成功**:`✓ reply-card default patch applied`
- **E2E**:用 `lark-cli im +chat-messages-list --format json` 查触发消息后的 bot 回复,普通短回复也应是 `msg_type=interactive`。

#### 🔧 B-1(历史,当前 no-op):`apply-reset-archive-patches.sh`

- **原用途**:P7(PR #76666)— `MemoryIndexManager` lazy-load 下 /reset archive race 窗口
- **当前状态**:`d6139a2e61c` **已 revert 成 no-op stub**。理由:P7-inner 让 builtin backend cold start 同步扫 files 表 × stat × hash compare → 22s event loop stall(13 实测),10× 慢于 upstream benchmark 数据
- **替代方案**:cron 定期 `openclaw memory index --force` 补 race window
- **文件位置**:`scripts/apply-reset-archive-patches.sh`(文件保留作为 stub + 记忆)
- **何时可再启用**:upstream 有异步版的 fix 后

#### 🔧 已被 upstream 覆盖(不再 patch)

- **patch4 memory-core archiveMarker**:openclaw 2026.5.3 新增 `session-transcript-hit-*.js` 原生 support 归档 stem 解析 → 老 patch 已从 apply-reset-archive-patches.sh 删除

### Patch 完整性自检(新 image / entrypoint diff 后必跑)

```bash
# R-* runtime patches 都应出现在 entrypoint 启动 log 里
docker logs carher-<id> 2>&1 | grep -E "stripBotMentions|command-body normalize|channel-only|contracts.tools \(30\)|shadow-daemon|history-fill|inbound-history metadata|reply-card default|patch-agent-loop|session-decay|PATCHED"
# 应看到每个相关 patch 的 ✓/PATCHED 成功记录

# R-7 必须是 V2 marker；R-6 metadata 两端 marker 都必须在
docker exec carher-<id> sh -lc '
  p=/data/.openclaw/extensions/node_modules/@larksuite/openclaw-lark/src/messaging/inbound/dispatch.js
  grep -n "CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER" "$p"
  grep -n "carherStripMentionsForCommandBody" "$p"
  grep -n "CARHER_HISTORY_META_PATCH_MARKER" "$p"
  grep -n "CARHER_INBOUND_HISTORY_META_PATCH_MARKER" /app/dist/get-reply-*.js
'
```

### 升级 openclaw 新版本 / 改 entrypoint.sh 的 SOP

1. **改 entrypoint.sh 前**:读本章。Diff 之后逐 section 核对。commit message 列出 add / remove 哪些 section header。
2. **新 image build**:grep build log 找 `OK` / `SKIP`(只 B-\* patches 有)。当前 B-1 是 no-op stub,不要期待 P7 marker。
3. **runtime patch 改动**:即使 image tag 不变,也必须服务器 `git pull --ff-only <remote> dev` + `docker compose up -d --force-recreate`,因为 entrypoint/patch dir 是 bind mount。
4. **新容器启动**:跑上面的自检 grep,9 个 R-\* patch 全中才算 ship;R-7 必须是 V2 marker。
5. **命令 smoke**:飞书群里测 `/new @bot`,`@bot /new`,`/new @bot1 @bot2`,`/status @bot`;期望 log 是 `detected system command` + `system command dispatched (delivered=true)`,不能有命令消息 `dispatching to agent`。
6. SKIP 本身不破坏 image(idempotent + safe degrade),但功能静默缺失,**用户察觉不到**。
7. 任一 patch 的 anchor 失效 → 不要 ship。先读上游新代码,更新 anchor,重新 build。

---

## 第 11 章 · Antitalker 管理(stop-hook-pipeline CEP)

Antitalker 是 carher 的"同 turn 防睡 / 光说不练拦截"。数据驱动,规则全在 YAML。

### 关键文件

| 位置                                                          | 作用                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `/data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml`  | **runtime 规则**(可热加载)                                    |
| `/app/docker/plugins/her-antitalker-poc/stop-hook-rules.yaml` | **image 里的 seed 源**(默认 `enabled: false`,2026-05-07 之后) |
| `docker/plugins/her-antitalker-poc/`                          | plugin 代码(stop-hook-pipeline.ts + index.ts)                 |

### Seed 行为(Entrypoint)

`scripts/carher-entrypoint.sh` 首次启动时:

```bash
[ ! -f "/data/.../.antitalker/stop-hook-rules.yaml" ] && cp image:/app/... → volume
```

**不覆盖已存在的 yaml**,保护主人手改。

### Default `enabled: false` 的含义(2026-05-07 起)

- 新容器 cold start + 空 volume → seed 到的 yaml 是 `enabled: false` → antitalker 默认**不拦截**,`installed=[]`
- 主人通过 `antitalker` skill 说"开启防睡" → Her 自己 edit yaml 改 true → 热加载 2 秒生效
- **已有 volume 里旧 yaml `enabled: true` 仍然保留** → 要让旧容器用新默认:先 `mv stop-hook-rules.yaml stop-hook-rules.yaml.pre-<TS>` 再 restart,让 entrypoint re-seed

### 验证 antitalker 状态

```bash
# yaml 当前设置
docker exec carher-N grep -E "^enabled:" /data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml

# plugin runtime ready log
docker logs carher-N | grep "\[antitalker\]" | tail -3
# 正常 log:
# [antitalker] stop-hook rules loaded · enabled=false · installed=[] · skipped=[prose-only-ending,no-toolcall-guard]
# [antitalker] ready · stop-hook-pipeline bound · hooks=[]
```

### 主人触发词 → antitalker skill

主人飞书说: "开启防睡" / "关闭防睡" / "antitalker 状态" / "加一条防睡规则" / "光说不练拦截" → `antitalker` skill 触发 → Her 读/改 yaml → 2 秒热加载生效。

完整架构: `docs/her/antitalker-architecture.md` / `docs/her/stop-hook-pipeline-architecture.md`

---

## 第 12 章 · 标准升级流程(正规 CI/CD, 0 hack)

### 场景 A:升级已有 bot 到**现成 image 或最新 runtime patch**(不 rebuild)

```bash
# 本地 Mac
node --test scripts/carher-patches/*.test.mjs            # 改 patch 时必跑
bash -n scripts/carher-entrypoint.sh
git push carher dev                                      # 确保最新 config / entrypoint / patch 已推

# 服务器:先确认 remote 名,不要假设 S1/S3 一样
ssh cltx@10.68.13.186
cd /Data/CarHer
git remote -v                                            # S1 通常 carher;S3 通常 origin
git status --short -- scripts/carher-entrypoint.sh scripts/carher-patches .cursor/skills/carher-ops/SKILL.md
git pull --ff-only <remote> dev                          # 拿最新 config / template / entrypoint / patches

# 如果升级 image,编辑 .env;如果只是 runtime patch,跳过 sed,IMAGE_TAG 保持不变
cd deploy/carher-<id>
sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=<new-tag>|" .env

# S3 跨服务器: .env 还要有 REDIS_URL=redis://10.68.13.186:6379 (scaffold 默认无,per-deploy 加)
grep -q "^REDIS_URL=" .env || echo "REDIS_URL=redis://10.68.13.186:6379" >> .env

# 15min 活跃度 >0 就停手,除非天哥明确说实验环境可重启
docker logs carher-<id> --since 15m 2>&1 | grep -c 'deliver:'

# runtime patch / entrypoint / compose / config 变更都 force-recreate
../../deploy/dc.sh up -d --force-recreate
sleep 75
docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}" | grep carher-<id>

# 运行时 patch 自检
docker logs carher-<id> 2>&1 | grep -E "stripBotMentions|command-body normalize|channel-only|contracts.tools \(30\)|shadow-daemon|history-fill|inbound-history metadata|reply-card default|patch-agent-loop|session-decay|PATCHED"
docker exec carher-<id> sh -lc '
  p=/data/.openclaw/extensions/node_modules/@larksuite/openclaw-lark/src/messaging/inbound/dispatch.js
  grep -n "CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER" "$p"
  grep -n "CARHER_HISTORY_FILL_PATCH_MARKER" "$p"
  grep -n "CARHER_HISTORY_META_PATCH_MARKER" "$p"
  grep -n "CARHER_INBOUND_HISTORY_META_PATCH_MARKER" /app/dist/get-reply-*.js
'
```

**禁止**:`git reset --hard`、直接 SSH 改服务器代码、直接改容器内 npm package。正规路径永远是本地 commit → push → server `git pull --ff-only` → compose recreate。

### 场景 B:rebuild 新 image 再升级

```bash
# 1. 本地 commit + push dev
scripts/committer "..." <files...>
git push carher dev

# 2. S1 (唯一 build 机) 拉代码 + build
ssh cltx@10.68.13.186
cd /Data/CarHer
git pull --ff-only carher dev
export CARHER_FREEZE_DEPTH=200   # 避免 freeze-git-info 在老 repo 耗时过长
./deploy/build-and-push.sh --no-push --tag-suffix=<suffix>
# 例:./deploy/build-and-push.sh --no-push --tag-suffix=p7b → localhost:5001/carher-core:<date>-p7b

# 3. 验证 image 里 patch marker
docker run --rm --entrypoint sh <img-tag> -c "
  grep -c stripBotMentions /entrypoint.sh
  grep -c command-body /entrypoint.sh
  grep '^enabled:' /app/docker/plugins/her-antitalker-poc/stop-hook-rules.yaml
"

# 4. 灰度 1 台 (推荐 200 或 12 test bot)
# (同场景 A 的 .env 改 IMAGE_TAG → compose up)

# 5. 验证运行时 patch + 功能
docker logs carher-<id> 2>&1 | grep -E "stripBotMentions|command-body normalize|channel-only|contracts.tools \(30\)|shadow-daemon|history-fill|inbound-history metadata|reply-card default|patch-agent-loop|session-decay|PATCHED"
docker exec carher-<id> sh -lc '
  p=/data/.openclaw/extensions/node_modules/@larksuite/openclaw-lark/src/messaging/inbound/dispatch.js
  grep -n "CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER" "$p"
  grep -n "CARHER_HISTORY_FILL_PATCH_MARKER" "$p"
  grep -n "CARHER_HISTORY_META_PATCH_MARKER" "$p"
  grep -n "CARHER_INBOUND_HISTORY_META_PATCH_MARKER" /app/dist/get-reply-*.js
'

# 6. 功能验证:主人飞书群里测 /new @bot, @bot /new, /new @bot1 @bot2, /status @bot
#    log 期望 detected system command + delivered=true;不应进 dispatching to agent

# 7. OK 了再推 fleet
# 逐台重复场景 A,把 IMAGE_TAG 改到新 tag
```

### S3 升级特别注意

1. **REDIS_URL 必须显式加**(scaffold.sh 基于 template default `redis://carher-redis:6379` docker DNS,S3 解析不到 → EAI_AGAIN 无限 restart)
2. **CARHER_SERVER 必须是 S3,不能是 local**。A2A registry 需要它区分同机 Docker DNS 和跨机 LAN endpoint。
3. **CARHER_LAN_IP 必须是 10.68.13.188**。否则 S1/S3 跨机 A2A 会发布 loopback/错误地址。
4. **/data/.openclaw/plugin-runtime-deps/** 首次 cold start 会 lazy npm install 25+ 依赖,3-5 分钟才 healthy(`start_period: 300s` 保护)
5. S3 从来不 build image,只 pull via `docker save | ssh docker load` 或 registry

### 清 antitalker 旧 yaml 让新默认生效(可选)

```bash
# 在升级前做,让 cold start 时 entrypoint re-seed 新版 enabled=false
docker exec carher-<id> sh -c "
  cd /data/.openclaw/workspace/.antitalker 2>/dev/null && \
  [ -f stop-hook-rules.yaml ] && \
  mv stop-hook-rules.yaml stop-hook-rules.yaml.pre-upgrade-$(date +%Y%m%d-%H%M%S)
"
# 然后走 compose down/up 即可
```

---

## 第 13 章 · 踩坑库

### 踩坑 1：bundled feishu 残留检查已过时

```bash
docker run --rm carher-core:<tag> ls /app/extensions/ /app/dist/extensions/ /app/dist-runtime/extensions/ | grep feishu
# 2026-05-09 当前 image 允许保留 bundled feishu 源/manifest 残留。
# 真正的运行态判断不是目录是否存在,而是 openclaw-lark 是否 channel-only,
# 以及 gateway 是否只启用 feishu-her / openclaw-lark channel 路径。
```

### 踩坑 2：A2A peers=0

a2a-gateway 的 `ioredis` 依赖缺失。检查 `node_modules/ioredis/`。

### 踩坑 3：首次启动慢 3-5 分钟

openclaw 的 "lazy runtime deps" 机制：首次启动时 npm install 25+ 个 plugin 依赖到 volume。compose.yaml 的 `healthcheck.start_period=300s` 给足时间。第二次起 < 10 秒。

### 踩坑 4：plugin SDK drift

出现 `TypeError: xxx.yyy is not a function`、`manifest validation failed` → 立刻回滚 + 补 `patches/drift-fix/` patch。

### 踩坑 5：compose `${VAR}` 替换为空 / A2A `server=local`

compose 的 `${VAR}` 在 parse 时从 `.env` / shell env 读取，不从 `env_file:` 读取。确保 `.env` 里有 `ANTHROPIC_AUTH_TOKEN`、`CARHER_SERVER`、`CARHER_LAN_IP` 等变量。

**A2A 事故复盘(2026-05-09)**:S1/S3 容器都注册成 `server=local`,Redis `a2a:card:*` 里 S3 peer 虽有 `lan=http://10.68.13.188:29746/...`,但旧 discovery 因 `card.server === selfServer` 选择了 Docker DNS `http://carher-75:18800/...`。Docker DNS 不跨主机,所以 S1 的 Her 找不到 S3 的 Her。修复包含两层:

1. `deploy/scaffold.sh` 从 `docker/server.env` 镜像 `CARHER_SERVER` 到每个 `deploy/carher-N/.env`,老 `.env` 缺失时追加。
2. `docker/plugins/a2a-gateway/src/registry.ts` 把 `local` 视为非路由 server 名;只在 S1/S3 这类 concrete server 完全相等时走 Docker DNS,否则优先走非 loopback LAN endpoint。

现场检查:

```bash
docker exec carher-200 node -e '
const Redis=require("ioredis");
(async()=>{
  const r=new Redis(process.env.REDIS_URL);
  const ids=await r.smembers("a2a:index");
  for (const id of ids.sort()) {
    const c=JSON.parse(await r.get("a2a:card:"+id));
    console.log(id, c.server, c.endpoints);
  }
  r.disconnect();
})().catch(e=>{console.error(e);process.exit(1)})
'
```

期望:S1 bot 是 `server=S1`,S3 bot 是 `server=S3`;如果仍是 `local`,修 `deploy/carher-N/.env` 后 `docker compose up -d --force-recreate`。

### 踩坑 6：openclaw-src-fetcher clone 失败

3 层 fallback 兜底后 `/app/openclaw-src/src` 可能是空目录，不影响 runtime。

### 踩坑 7:`apply-reset-archive-patches.sh` 已是 no-op,不要再按 P7 marker 验证

**症状**:升级 runbook 仍在 grep `carher_P7_outer` / `carher_P7_inner`,然后误判新 image 没打 patch。

**根因**:P7 / PR #76666 相关 build-time patch 已在 `d6139a2e61c` revert 成 no-op stub。当前 active patch 面是第 10 章的 9 个 runtime patches,不是 P7 marker。

**检查**:

```bash
docker logs carher-<id> 2>&1 | grep -E "stripBotMentions|command-body normalize|channel-only|contracts.tools \(30\)|shadow-daemon|history-fill|inbound-history metadata|reply-card default|patch-agent-loop|session-decay|PATCHED"
docker exec carher-<id> sh -lc '
  p=/data/.openclaw/extensions/node_modules/@larksuite/openclaw-lark/src/messaging/inbound/dispatch.js
  grep -n "CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER" "$p"
  grep -n "CARHER_HISTORY_FILL_PATCH_MARKER" "$p"
  grep -n "CARHER_HISTORY_META_PATCH_MARKER" "$p"
  grep -n "CARHER_INBOUND_HISTORY_META_PATCH_MARKER" /app/dist/get-reply-*.js
'
```

**修复**:不要恢复 P7 marker 检查。只在 upstream 给出异步、低 stall 的 memory fix 后,再重新设计 build-time patch。

### 踩坑 8:command-body V1 看似 patched,但 `/new` 仍有漏网形态

**症状**:`/new @bot` 正常,但 `@bot /new` 进 agent,或者 `/new @bot1 @bot2` 有 bot `delivered=false`。

**根因**:V1 只处理 slash 在最前、且只剥当前 bot mention。多 mention 或 mention 在命令前会漏掉。

**检查 / 修法**:容器内必须是 `CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER`;如果是旧 `CARHER_COMMAND_BODY_NORMALIZE_PATCH_MARKER` 或 `NONE`,服务器拉最新 dev 后 `docker compose up -d --force-recreate`。

### 踩坑 9:`openclaw-lark` contracts.tools 警告不是升级失败

**症状**:启动日志里刷出多行:

```text
plugin must declare contracts.tools before registering agent tools (plugin=openclaw-lark)
```

**原因**:R-2 会把 `openclaw-lark` manifest 改成 channel-only (`contracts.tools=[]`,`skills=[]`),但上游 runtime 仍会尝试注册它自带的 tool。OpenClaw 会打警告,但 channel-only gate 会阻止这些 tools 进入可用面。

**判断**:只看目录或这条 warning 会误判。正确判断是跑:

```bash
scripts/carher-verify.sh --id=<N> --wait=60
```

只要 Gate 7 `openclaw-lark channel-only` 和 Gate 8 `runtime patch markers` 全绿,这条 warning 是已知兼容噪音,不是回滚条件。

### 踩坑 10:S3 bot scaffold 后 EAI_AGAIN 无限 restart(缺 REDIS_URL)

**症状**:S3 升级 bot 后持续 restart,log 狂刷:

```
[plugins] [discussion-state] Redis error: Error: getaddrinfo EAI_AGAIN carher-redis
```

**根因**:S3 没有 `carher-redis` 容器(redis 只在 S1 跑)。scaffold template 默认 `REDIS_URL=${REDIS_URL:-redis://carher-redis:6379}` 用的是 docker internal DNS,S3 解析不到。

**修法**:S3 每个 bot 的 `deploy/carher-<id>/.env` 必须显式加:

```
REDIS_URL=redis://10.68.13.186:6379
```

scaffold `.env` 只在不存在时创建,已存在时保护。所以升级 S3 老 bot 时,第一次 scaffold 后手工加这行就锁死了。

### 踩坑 11:antitalker `enable=false` 升级后不生效(volume 里老 yaml 残留)

**症状**:升 p7+ image(里面 seed 源默认 `enabled: false`)的 bot,实际 runtime 仍然 `enabled=true` 跑着防睡。

**根因**:entrypoint seed 逻辑是 `[ ! -f "$DST" ] && cp`,**不覆盖**。老 volume 里的 `stop-hook-rules.yaml` 是 `enabled: true` 时期 seed 的,保留着。

**修法**:cold start 前主动 mv 老文件让 entrypoint re-seed:

```bash
docker exec carher-<id> sh -c "
  cd /data/.openclaw/workspace/.antitalker 2>/dev/null &&
  [ -f stop-hook-rules.yaml ] &&
  mv stop-hook-rules.yaml stop-hook-rules.yaml.pre-upgrade-$(date +%Y%m%d-%H%M%S)
"
docker compose down && docker compose up -d
```

---

## 附录 · 快速定位

### 找服务器和密码

```bash
cat docker/servers.txt
sshpass -p 'PASSWORD' ssh -o StrictHostKeyChecking=no USER@IP "COMMAND"
```

### 代码同步铁律

```
本地修改 → git commit → git push → 服务器 git pull
```

**绝对禁止** scp/ssh 直接改服务器代码。唯一例外：`users.csv`、`servers.txt`（不在 git）。

### 铁律：重建前 15 分钟无交互

```bash
docker logs carher-N --since=15m 2>&1 | grep -c "deliver:"
# > 0 就等
```

### 日常运维命令速查

```bash
# 启动
cd deploy/carher-N && docker compose up -d

# 升级
# 编辑 .env IMAGE_TAG → docker compose up -d

# 回滚
# .env IMAGE_TAG 改回旧值 → docker compose up -d

# 日志
cd deploy/carher-N && docker compose logs -f carher

# 停止
cd deploy/carher-N && docker compose down   # keeps volumes

# 诊断 image 来源
docker inspect carher-N --format '{{.Image}}' \
  | xargs docker inspect --format 'hash={{index .Config.Labels "carher.build.hash"}} openclaw={{index .Config.Labels "carher.openclaw.tag"}}'
```

### 关键文档

| 文档                                        | 内容               |
| ------------------------------------------- | ------------------ |
| `docs/her/her-build-deploy-architecture.md` | Build/Deploy 架构  |
| `docs/her/her-image-architecture.md`        | A+B 镜像架构       |
| `docs/her/her-feishu-bot-architecture.md`   | 飞书 bot 架构      |
| `deploy/README.md`                          | compose 部署指南   |
| `docker/servers.txt`                        | 服务器凭证（敏感） |
| `scripts/carher-verify.sh`                  | 11 gate 自检       |
| `docs/her/acp-claude-code-setup.md`         | ACP 开启指南       |
