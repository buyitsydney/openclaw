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

## 第 2 章 · 当前部署真相（2026-05-08)

**S1 + S3 全部 7 个 bot 已 compose 化 + 升级到 stop-hook-v3-clean 系 image。**

| 位置              | 容器         | 用户         | Bot App ID             | 当前 image（2026-05-08 晨）     |
| ----------------- | ------------ | ------------ | ---------------------- | --------------------------------- |
| S1 (10.68.13.186) | `carher-12`  | test/tester  | `cli_a917fa892ff91bb5` | `stop-hook-v3-clean`              |
| S1 (10.68.13.186) | `carher-13`  | 卜弋天       | `cli_a917e5525178dbb3` | `stop-hook-v3-clean`              |
| S1 (10.68.13.186) | `carher-198` | admin/研究1  | `cli_a96f0bfba3789cd4` | `stop-hook-v3-clean`              |
| S1 (10.68.13.186) | `carher-199` | 研究2        | `cli_a96f043660f99cef` | `stop-hook-v3-clean`              |
| S1 (10.68.13.186) | `carher-200` | 研究3/Nova   | `cli_a96f044b4ef95cc0` | **`2026.5.8-p7b`**（灰度领先）   |
| S3 (10.68.13.188) | `carher-14`  | 刘国现       | `cli_a91569fab9b81bc6` | `stop-hook-v3-clean` (A2A hub 配错,应 spoke) |
| S3 (10.68.13.188) | `carher-75`  | 林森         | `cli_a94a0b73a878dbcb` | `stop-hook-v3-clean` (spoke)      |

**A2A hub 名单**(`a2a-gateway.outbound.enabled=true`):13 / 198 / 199 / 200。其他全 spoke。

**Mac 本地测试容器**（id=101/102/103/104）:`carher-101`=tester, `carher-102`=tester2, `carher-103`=tester3, `carher-104`=tester4。

**行动原则**:`docker/servers.txt` 是手动维护的真相表。

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
docker compose logs carher | grep 'WSClient connected'
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
docker compose logs -f carher | grep 'WSClient connected'
```

### 回滚（改回 .env IMAGE_TAG）

```bash
# 编辑 .env: IMAGE_TAG 改回旧值
cd deploy/carher-N && docker compose up -d
# volume 保留，sessions/memory 不丢
```

---

## 第 6 章 · 自动自检 10 Gate

```bash
scripts/carher-verify.sh --id=N --wait=60
# exit 0 = 全过 / exit 3 = 有 FAIL / exit 2 = 容器不存在
```

| #   | Gate                | 检查内容                             | 失败含义                    |
| --- | ------------------- | ------------------------------------ | --------------------------- |
| 1   | gateway ready       | `[gateway] ready (N plugins...)`     | 容器没起来                  |
| 2   | plugin 数量         | N ≥ 7                                | A+B 缺插件                  |
| 3   | feishu WSClient     | `WSClient connected`                 | token 失效或 appId 错       |
| 4   | A2A peers           | `refreshRegistryPeers found N`, N>0  | Redis 或 A2A 未启用（警告） |
| 5   | acpx runtime        | `acpx runtime backend ready`         | ACP 未启用（警告）          |
| 6   | 无 plugin 契约错误  | 无 `plugin validation/schema failed` | **SDK drift — 立刻回滚**    |
| 7   | bundled feishu 清理 | feishu 残留目录不存在                | Dockerfile rm 不全          |
| 8   | a2a-gateway ioredis | `node_modules/ioredis` 存在          | npm install 失败            |
| 9   | feishu-her 依赖     | `@larksuiteoapi` 存在                | feishu 连不上               |
| 10  | 无严重运行时错误    | 无 `FATAL/uncaughtException/crash`   | 立刻回滚                    |

### Monitor 模板

```bash
docker compose logs -f carher 2>&1 | grep --line-buffered -E \
  "(deliver:|gateway\] ready|WSClient connected|acpx runtime backend ready|refreshRegistryPeers found|Error|FAILED|exception|plugin (validation|schema))"
```

### 真人验收（10 gate 之外必做）

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

## 第 10 章 · Runtime / Build-time Patch 体系(2026-05-08+)

carher 对 openclaw / 闭源上游 npm 包打的本地 patch。**修改前必读本章;任何一个 patch section 被误删 → 功能静默失效、用户先察觉、debug 路径很长。**

### 判定规则:runtime vs build-time patch

| 目标文件会被 runtime 覆盖吗? | 路径 | 典型 |
|---|---|---|
| 会(npm install 重写 / bind-mount 覆盖) | **entrypoint runtime patch**(`scripts/carher-entrypoint.sh` 每次 container 启动) | stripBotMentions / P8 history-fill |
| 不会(image COPY read-only layer) | **Dockerfile build-time patch**(`scripts/apply-reset-archive-patches.sh`,`RUN` 走 build layer) | (当前无;P7 已撤) |

选错方向 = 下次 npm install / image rebuild 时 patch 失效。

### ⚠️ 改 entrypoint.sh 的铁律

- **任何对 `scripts/carher-entrypoint.sh` 的 diff,commit message 必须显式列出所有被 add / remove 的 section header**(本章表格里的 name)。
- Reviewer 必须逐个 section 核对,**只要有一个少了就打回**。
- 教训:`f3d83cfd493`(2026-05-05) 加 a2a-gateway manifest patch 时顺手删了整个 CommandSource section,commit message 只提 a2a-gateway。后来 2026-05-08 尝试恢复才发现 CommandSource 方向在群里根本无效(见 R-7 条目),但这不降低"改 entrypoint 必须列 section diff"这条铁律的重要性。

### 完整 Patch 清单(2026-05-08,共 8 个)

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

#### 🔧 R-6:`P8 proactive 20-msg history fill` (runtime, entrypoint)

- **Target**:`$LARK_PKG/src/messaging/inbound/dispatch.js`(加 require helper 的一行注入)+ `$LARK_PKG/src/messaging/inbound/carher-history-fill.js`(helper,cp from bind-mount)
- **Upstream**:`@larksuite/openclaw-lark`(闭源)
- **Bug**:三组件迁移后 group 历史只走被动 WS event 累积;bot 重启 / 群冷场 > 20 秒 → 被 @ 时 0 条上下文,"失忆"
- **Fix**:被 @ 时(非 `/` 系统命令)调 `/im/v1/messages` 拉最近 20 条填 Map
- **Source**:`scripts/carher-patches/`(bind-mount 成容器 `/carher-patches:ro`)
- **Kill switch**:
  - `CARHER_DISABLE_HISTORY_FILL_PATCH=1` (boot 时完全 skip patch)
  - `CARHER_DISABLE_HISTORY_FILL=1` (patch 在但 helper runtime no-op)
- **log 成功**:`✓ history-fill patch applied (helper + dispatch.js)` + 运行时 `[carher-history-fill] done ... filled 19 in NNNms`

#### 🔧 R-7:`command-body mention normalization` — 群 /new @bot 修复 (runtime, entrypoint)

- **Target**:`$LARK_PKG/src/messaging/inbound/dispatch.js`
- **Source**:`scripts/carher-patches/apply-command-body-normalize.sh`
- **Bug**:`stripBotMentions=false` 修好多 bot @ 后,群命令的 `ctx.content` 保留了 bot mention。`/new @弋天的her` 进入 core 时变成 `CommandBody="/new @弋天的her"`;core 把 mention 当作 `/new <tail>` 的 prompt tail,于是 reset 后继续进 LLM,最终 `NO_REPLY`,看不到 `✅ New session started.`。`/status @bot` 也会因为 mention 后缀造成命令识别不一致/双回复。
- **Fix**:只在 slash-command command surface 归一化:
  - 普通 LLM 输入仍保留 bot mention(不回退 R-1)
  - `CommandBody` 去掉"当前 bot 的地址 mention":`/new @bot` → `/new`,`/status @bot` → `/status`
  - 群里 slash command 如果 mention 了别人但没 mention 当前 bot,当前 bot 直接 ignore,避免多 bot 群误响应
- **Kill switch**:`CARHER_DISABLE_COMMAND_BODY_NORMALIZE_PATCH=1`
- **log 成功**:`✓ command-body normalize patch applied`
- **反例**:不要再打 `CommandSource:native` 或直接 `sendMessageFeishu` ack。前者导致 `/status` 双回复,后者绕过 core reset 语义。

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
# 7 个 R-* runtime patches 都应出现在 entrypoint 启动 log 里
docker logs carher-<id> 2>&1 | grep -E "stripBotMentions|command-body normalize|channel-only|contracts.tools \(30\)|shadow-daemon|history-fill|patch-agent-loop|PATCHED"
# 应看到 7 行 ✓
```

### 升级 openclaw 新版本 / 改 entrypoint.sh 的 SOP

1. **改 entrypoint.sh 前**:读本章。Diff 之后逐 section 核对。commit message 列出 add / remove 哪些 section header。
2. **新 image build**:grep build log 找 `OK` / `SKIP`(只 B-* patches 有)
3. **新 image 启动**:跑上面的自检 grep,7 个 R-* patch 全中才算 ship
4. SKIP 本身不破坏 image(idempotent + safe degrade),但功能静默缺失,**用户察觉不到**
5. 任一 patch 的 anchor 失效 → 不要 ship。先读上游新代码,更新 anchor,重新 build

---

## 第 11 章 · Antitalker 管理(stop-hook-pipeline CEP)

Antitalker 是 carher 的"同 turn 防睡 / 光说不练拦截"。数据驱动,规则全在 YAML。

### 关键文件

| 位置 | 作用 |
|---|---|
| `/data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml` | **runtime 规则**(可热加载) |
| `/app/docker/plugins/her-antitalker-poc/stop-hook-rules.yaml` | **image 里的 seed 源**(默认 `enabled: false`,2026-05-07 之后) |
| `docker/plugins/her-antitalker-poc/` | plugin 代码(stop-hook-pipeline.ts + index.ts) |

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

### 场景 A:升级已有 bot 到**现成 image**(不 rebuild)

```bash
# 本地 Mac
git push carher dev                                      # 确保最新 config 已推

# 服务器 (S1 例)
ssh cltx@10.68.13.186
cd /Data/CarHer
git fetch carher dev && git reset --hard carher/dev      # 拿最新 config / template / entrypoint

cd deploy
./scaffold.sh <id>                                        # 重生成 compose.yaml (保护 .env/secrets.env)

cd carher-<id>
# 编辑 .env:改 IMAGE_TAG 到目标 tag
sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=<new-tag>|" .env

# S3 跨服务器: .env 还要有 REDIS_URL=redis://10.68.13.186:6379 (scaffold 默认无,per-deploy 加)
grep -q "^REDIS_URL=" .env || echo "REDIS_URL=redis://10.68.13.186:6379" >> .env

docker compose down && docker compose up -d
sleep 75
docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}" | grep carher-<id>
```

### 场景 B:rebuild 新 image 再升级

```bash
# 1. 本地 commit + push dev
git add ... && git commit -m "..." && git push carher dev

# 2. S1 (唯一 build 机) 拉代码 + build
ssh cltx@10.68.13.186
cd /Data/CarHer
git fetch carher dev && git reset --hard carher/dev
export CARHER_FREEZE_DEPTH=200   # 避免 freeze-git-info 在老 repo 耗时过长
./deploy/build-and-push.sh --no-push --tag-suffix=<suffix>
# 例:./deploy/build-and-push.sh --no-push --tag-suffix=p7b → localhost:5001/carher-core:<date>-p7b

# 3. 验证 image 里 patch marker
docker run --rm --entrypoint sh <img-tag> -c "
  grep -c carher_P7_outer /app/dist/server.impl-*.js
  grep -c carher_P7_inner /app/dist/server-startup-memory-*.js
  grep -c stripBotMentions /entrypoint.sh
  grep '^enabled:' /app/docker/plugins/her-antitalker-poc/stop-hook-rules.yaml
"

# 4. 灰度 1 台 (推荐 200 或 12 test bot)
# (同场景 A 的 .env 改 IMAGE_TAG → compose up)

# 5. 验证运行时 patch + 功能
docker exec carher-<id> sh -c "
  grep -c carher_P7_outer /app/dist/server.impl-*.js   # expect 1
  grep -c carher_P7_inner /app/dist/server-startup-memory-*.js  # expect 1
"
docker logs carher-<id> | grep -E "memory startup|qmd memory startup initialization failed"
# 期望: 无 "initialization failed" 错

# 6. 功能验证:主人飞书 @ bot 做 /new + "回忆刚才" 测试 memory_search sources=sessions
#    (用 python sqlite3 查 chunks 表验证索引增长 — 见第 10 章 P7 验证)

# 7. OK 了再推 fleet
# 逐台重复场景 A,把 IMAGE_TAG 改到新 tag
```

### S3 升级特别注意

1. **REDIS_URL 必须显式加**(scaffold.sh 基于 template default `redis://carher-redis:6379` docker DNS,S3 解析不到 → EAI_AGAIN 无限 restart)
2. **/data/.openclaw/plugin-runtime-deps/** 首次 cold start 会 lazy npm install 25+ 依赖,3-5 分钟才 healthy(`start_period: 300s` 保护)
3. S3 从来不 build image,只 pull via `docker save | ssh docker load` 或 registry

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

### 踩坑 1：bundled feishu 残留

```bash
docker run --rm carher-core:<tag> ls /app/extensions/ /app/dist/extensions/ /app/dist-runtime/extensions/ | grep feishu
# 应无输出。有 = Dockerfile rm -rf 不全
```

### 踩坑 2：A2A peers=0

a2a-gateway 的 `ioredis` 依赖缺失。检查 `node_modules/ioredis/`。

### 踩坑 3：首次启动慢 3-5 分钟

openclaw 的 "lazy runtime deps" 机制：首次启动时 npm install 25+ 个 plugin 依赖到 volume。compose.yaml 的 `healthcheck.start_period=300s` 给足时间。第二次起 < 10 秒。

### 踩坑 4：plugin SDK drift

出现 `TypeError: xxx.yyy is not a function`、`manifest validation failed` → 立刻回滚 + 补 `patches/drift-fix/` patch。

### 踩坑 5：compose `${VAR}` 替换为空

compose 的 `${VAR}` 在 parse 时从 `.env` / shell env 读取，不从 `env_file:` 读取。确保 `.env` 里有 `ANTHROPIC_AUTH_TOKEN`、`CARHER_LAN_IP` 等变量。

### 踩坑 6：openclaw-src-fetcher clone 失败

3 层 fallback 兜底后 `/app/openclaw-src/src` 可能是空目录，不影响 runtime。

### 踩坑 7:`apply-reset-archive-patches.sh` 静默 SKIP 后 PR #76666 fix 丢失

**症状**:image build 成功,`memory_search sources=["sessions"]` 返回空或仅有老数据,`/reset` / `/new` 产生的 `.jsonl.reset.<iso>` 不进 chunks。

**根因**:openclaw upstream refactor 了 `/app/dist/*.js` 结构,本地 patch script 的 anchor 找不到,全部 **SKIP**(idempotent 设计,build 不 fail)。

**检查**:
```bash
docker run --rm --entrypoint sh <new-image> -c "
  grep -c carher_P7_outer /app/dist/server.impl-*.js
  grep -c carher_P7_inner /app/dist/server-startup-memory-*.js
"
# 两个都 0 = SKIP 了,patch 没打上
```

**修复**:grep build log 里 `p7_outer ... OK` / `p7_inner ... OK`,任一是 `SKIP` 就去 `/app/dist/` 读当前源码,更新 `scripts/apply-reset-archive-patches.sh` 的 anchor。

### 踩坑 8:P7-inner 只 patch 1 行 → `resolved.qmd.update` crash

**症状**:
```
[gateway] qmd memory startup initialization failed:
  TypeError: Cannot read properties of undefined (reading 'update')
```

**根因**:P7-inner 如果只 patch `if (resolved.backend !== "qmd" || !resolved.qmd) continue;` 这一行,builtin backend 过了这 gate 之后,**紧接着下一行** `if (!shouldRunQmdStartupBootSync(resolved.qmd)) continue;` 里会访问 `resolved.qmd.update` → builtin 的 `resolved.qmd=undefined` → crash。

**修法**:P7-inner 的 anchor **必须吃下这 2 行**,用 `_isBuiltinSessionsPreload` flag 同时跳过 qmd gate + qmd boot-sync check,让 builtin 直接走到 `getActiveMemorySearchManager`。

### 踩坑 9:S3 bot scaffold 后 EAI_AGAIN 无限 restart(缺 REDIS_URL)

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

### 踩坑 10:antitalker `enable=false` 升级后不生效(volume 里老 yaml 残留)

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

| 文档                                           | 内容               |
| ---------------------------------------------- | ------------------ |
| `docs/her/her-build-deploy-architecture.md`    | Build/Deploy 架构  |
| `docs/her/her-image-architecture.md`           | A+B 镜像架构       |
| `docs/her/her-feishu-bot-architecture.md`      | 飞书 bot 架构      |
| `deploy/README.md`                             | compose 部署指南   |
| `docker/servers.txt`                           | 服务器凭证（敏感） |
| `scripts/carher-verify.sh`                     | 10 gate 自检       |
| `docs/her/acp-claude-code-setup.md`            | ACP 开启指南       |
