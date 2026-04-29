---
name: carher-ops
description: CarHer 统一运维手册：A+B 架构 + 3 层 config + 镜像构建 + 容器启动 + 灰度 + 自检 + 回滚 + CSV 同步 + Admin。Use when the user mentions 董事长, her, docker, 容器, 服务器, server, carher, 健康检查, 重启, restart, 日志, CSV, open_id, owner, pairing, 升级 openclaw, 升级到 xxxx.x.xx 版本, 跟官方发版, 换 base, 换 FROM tag, 回滚 carher-core, 换镜像 tag, or any enterprise deployment operation.
---

# CarHer 统一运维手册

> **本文件是唯一权威**。旧 `carher-enterprise-ops` 和 `carher-image-upgrade` 两个 skill 已废弃删除，内容全部合并于此。

---

## 第 1 章 · 架构真相（A+B 三轴）

CarHer 运行镜像 = **官方 OpenClaw base 镜像（A）** + **自家插件层（B）**，两者独立：

```
carher-core:<TAG>-ab-v2
└── FROM ghcr.io/openclaw/openclaw:${OPENCLAW_TAG}   ← 轴 1，官方每周发版
    + docker/plugins/feishu-her/                      ← 轴 2，自家 channel 插件
    + docker/plugins/a2a-gateway/                     ← 轴 3，自家 A2A 插件
```

**三层 Config（config-rebuild 架构）**：

```
config/base.json5        ← L1: 全局默认（model、tools、admin allowlist）
  ↑ $include
config/docker.json5      ← L2: docker 共享（redis、groups、gateway）
  ↑ $include
config/u{N}.json5        ← L3: per-user 身份（feishu appId/secret/botOpenId）
```

静态 git-tracked 文件，secrets 用 `${VAR}` 占位符，容器启动时由 env var 注入。`start-user.sh` 把 `u{N}.json5` 挂载为 `/data/.openclaw/openclaw.json`，同时挂 `base.json5` 和 `docker.json5`。

完整架构文档：[`docs/her/her-image-architecture.md`](../../docs/her/her-image-architecture.md)

---

## 第 2 章 · 当前部署真相（2026-04-20 大迁移之后）

**只剩 3 个用户的 bot 在服务器上运行；其他历史容器（carher-1..78）全部下线。**

| 位置              | 容器        | 用户        | Bot App ID             |
| ----------------- | ----------- | ----------- | ---------------------- |
| S1 (10.68.13.186) | `carher-12` | 卜弋天 test | `cli_a917fa892ff91bb5` |
| S1 (10.68.13.186) | `carher-13` | 卜弋天      | `cli_a917e5525178dbb3` |
| S3 (10.68.13.188) | `carher-14` | 刘国现      | `cli_a91569fab9b81bc6` |
| S3 (10.68.13.188) | `carher-75` | 林森        | `cli_a94a0b73a878dbcb` |

**已迁出服务器**：董事长（旧 `carher-1`）— 残留 exited 容器不清理；S2 全下线只剩 `carher-fallback`。

**Mac 本地测试容器**（id=101/102/103/104）：`carher-101`=tester, `carher-102`=tester2, `carher-103`=tester3, `carher-104`=tester4。

**行动原则**：不假设任何 carher-1..78 容器存在。`docker/servers.txt` 是手动维护的真相表。

---

## 第 3 章 · 镜像构建（唯一正确方式）

A+B v2 架构下镜像只通过 `docker build -f Dockerfile.carher.v2` 构建。

### 构建命令

```bash
DOCKER_BUILDKIT=1 docker build -f Dockerfile.carher.v2 \
  --build-arg OPENCLAW_TAG=2026.X.Y \
  -t carher-core:<MMDD>-ab-v2 .
```

- BuildKit **必须开**（cache mount 依赖）
- Tag 格式：`carher-core:<日期>-ab-v2`，如 `carher-core:0424-ab-v2`
- **永远不覆盖旧 tag**，至少保留 30 天

### 升级 = 改 1 个字符串

```bash
# 改 Dockerfile.carher.v2 第 9 行
ARG OPENCLAW_TAG=2026.X.OLD  →  ARG OPENCLAW_TAG=2026.X.NEW
```

不 git pull、不 pnpm install、不编译。

### 构建时间预期

| 场景                  | 时间   |
| --------------------- | ------ |
| 冷（首次新 base tag） | ~30min |
| 热（same base 改 B）  | 3-5min |

### 升级前检查

1. 查官方新 tag：`gh release list --repo openclaw/openclaw --limit 10`
2. 读 Release Notes 看 breaking change（关注 `Plugin SDK`、`channel contract`、`feishu`）
3. 预热：`docker pull ghcr.io/openclaw/openclaw:2026.X.Y`
4. Gate 1 — `peerDependencies` 范围（超上界 npm install 会 ERESOLVE 失败）
5. Gate 2 — `ls patches/drift-fix/` 查已知漂移 patch

### Her 可读 upstream src

Dockerfile 含 `openclaw-src-fetcher` stage，clone 对应 tag 的源码到 `/app/openclaw-src/src/`（只读不参与 runtime）。GitHub 挂了会兜底空目录，不阻塞 build。

---

## 第 4 章 · 容器启动（start-user.sh）

### 资源默认值（铁律 — 2026-04-27 升级）

**所有 her 容器固定 10 CPU + 16GiB RAM**。`start-user.sh` 默认就是这个,不用每次显式传:

```bash
--memory=${CARHER_MEMORY_LIMIT:-16g}
--cpus=${CARHER_CPU_LIMIT:-10}
```

历史上 admin/特殊容器才走 16g+10cpu,其他用默认 2g 跑出过 OOM。统一拉到 10/16 之后,跑大压测/ACP 子进程不再被打爆。

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

其他 her(carher-14 国现, carher-75 林森, carher-12 等)是 spoke,只接收。

### 环境变量控制

| 功能 | 环境变量                                | 说明                     |
| ---- | --------------------------------------- | ------------------------ |
| ACP  | `CARHER_ACP_ENABLED=1`                  | Claude Code 子进程       |
| A2A  | (在 `u<N>.json5` 里 `outbound.enabled`) | Hub 永久标记,见上文      |
| 内存 | `CARHER_MEMORY_LIMIT=<N>g`              | 默认 16g,够 ACP 也够压测 |
| CPU  | `CARHER_CPU_LIMIT=<N>`                  | 默认 10                  |

`A2A_ENABLED` / `A2A_OUTBOUND` 是 start-user.sh 的 print-only flag,实际生效靠 user config json5。

### 标准启动

```bash
# 任何 her(spoke 或 hub 都一样,资源默认 10cpu/16g)
CARHER_ACP_ENABLED=1 ./start-user.sh --id=N --image=carher-core:<TAG>
```

hub 与否由 `config/u<N>.json5` 的 `outbound.enabled` 决定。

### 验证

```bash
docker logs carher-N | grep 'WSClient connected'
docker logs carher-N | grep 'gateway] ready'
docker logs carher-N | grep 'acpx.*ready'
docker inspect carher-N --format 'CPU={{.HostConfig.NanoCpus}} Mem={{.HostConfig.Memory}}'
# 期望:CPU=10000000000  Mem=17179869184
```

### start-user.sh 关键行为

- Line 23: `source "$SCRIPT_DIR/docker/server.env"` — 读取 API keys
- Line 581+: 挂载 `config/u{N}.json5` → `/data/.openclaw/openclaw.json`，同时挂 `base.json5`、`docker.json5`
- Line 584: 注入 `FEISHU_APP_SECRET` 从 CSV
- `start-user.sh` **永远不构建镜像**，镜像不存在会报错

---

## 第 5 章 · 灰度铁律（违反者死）

### 铁律清单

1. **必须用自己的 worktree**：`git worktree add /tmp/xxx-wt origin/dev --detach`
2. **必须用独立分支**，绝不碰服务器的 dev/main
3. **必须用 worktree 里面的 start-user.sh**
4. **必须用独立 image tag**（如 `carher-core:0424-grey`），绝不碰 `carher:local`
5. **绝不在服务器上 checkout dev**，绝不 `git pull` dev
6. **worktree 必须 symlink server.env 和 users.csv**
7. **三台服务器必须全用 worktree**

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

# 4. 从 worktree 构建镜像（A+B 方式！）
DOCKER_BUILDKIT=1 docker build -f Dockerfile.carher.v2 \
  --build-arg OPENCLAW_TAG=2026.X.Y \
  -t carher-core:<TAG> .

# 5. 从 worktree 启动容器
CARHER_ACP_ENABLED=1 A2A_ENABLED=1 ./start-user.sh --id=N --image=carher-core:<TAG>

# 6. 验证
docker logs carher-N | grep 'ws client ready'
```

### 更新 worktree

```bash
cd /tmp/xxx-wt
git fetch origin && git checkout --detach origin/feat/xxx
ln -sf /Data/CarHer/docker/server.env docker/server.env
ln -sf /Data/CarHer/docker/users.csv docker/users.csv
# 重新 build + restart
```

### 回滚（用主仓库 + carher:local）

```bash
cd /Data/CarHer && ./start-user.sh --id=N
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
docker logs -f --since=1s carher-N 2>&1 | grep --line-buffered -E \
  "(deliver:|gateway\] ready|WSClient connected|acpx runtime backend ready|refreshRegistryPeers found|Error|FAILED|exception|plugin (validation|schema))"
```

### 真人验收（10 gate 之外必做）

请真人在飞书私聊发：`你好。检查下 A2A 和 ACP 状态？`
期望：回复含 `A2A ✅` 和 `ACP` 关键词。

---

## 第 7 章 · 回滚

### 同大版本回滚（秒级）

```bash
docker rm -f carher-N
CARHER_ACP_ENABLED=1 ./start-user.sh --id=N --image=carher-core:<旧日期>-ab-v2
```

~60-70s 搞定，镜像已在本地。

### 跨 schema 回滚（4.x → 3.x）

```bash
# 1. 注释 shared-config.json5 里新版 only 的 key
# 2. 清持久 config
docker rm -f carher-N
docker run --rm -v carher-N-data:/data alpine rm -f /data/openclaw.json
# 3. 起旧 image
CARHER_ACP_ENABLED=1 ./start-user.sh --id=N --image=carher-core:<老 tag>
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

### 收集用户 open_id

```bash
# 从持久化 session（不丢失）
docker exec carher-N find /data/.openclaw/agents -name '*.jsonl' -exec grep -oh 'ou_[a-f0-9]*' {} \; | sort -u
```

### Owner 机制

| 场景     | CSV 列                 | 生成配置                  |
| -------- | ---------------------- | ------------------------- |
| 专属 Bot | `feishu_owner_open_id` | `dm.allowFrom`            |
| 共享 Bot | `owner_allow_from`     | `commands.ownerAllowFrom` |

无 Owner → AI 看不到 cron/gateway 等 `ownerOnly` 工具。

### servers.txt 同步

修改后同步到所有服务器：`scp docker/servers.txt cltx@IP:/Data/CarHer/docker/servers.txt`，验证 `md5sum` 一致。

---

## 第 9 章 · Admin 容器 carher-198

**历史**：裸机 `yitian-her` 已退役（2026-04-23），由 docker `carher-198`（研究1）充任 admin。

### 启动（两步）

```bash
# Step 1: 和其他 her 一样
CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=16g A2A_ENABLED=1 A2A_OUTBOUND=1 \
  ./start-user.sh --id=198 --image=carher-core:<TAG>

# Step 2: admin 特权 bootstrap
./bootstrap-admin.sh carher-198
```

### bootstrap 内容

| #   | 资产                        | docker rm 后 |
| --- | --------------------------- | ------------ |
| 1   | sshpass + openssh-client    | 丢           |
| 2   | /data/.openclaw/servers.txt | 保留(volume) |
| 3   | admin 运维 skills           | 可能丢       |
| 4   | docker update --cpus=10     | 丢           |

### 诊断

```bash
docker exec carher-198 which sshpass ssh
docker exec carher-198 ls /data/.openclaw/servers.txt
docker exec carher-198 ls /data/.openclaw/skills/docker-fleet
docker inspect carher-198 --format '{{.HostConfig.NanoCpus}}'
```

任一项丢 → `./bootstrap-admin.sh carher-198` 一键全修。

### 禁忌

- 不要擅自 `docker rm carher-198`
- 不要再启动裸机 yitian-her（会抢 WebSocket）
- 不要 cpu 设 16（标准 admin 10 cores）

---

## 第 10 章 · 踩坑库

### 踩坑 1：bundled feishu 残留

```bash
docker run --rm carher-core:<tag> ls /app/extensions/ /app/dist/extensions/ /app/dist-runtime/extensions/ | grep feishu
# 应无输出。有 = Dockerfile rm -rf 不全
```

### 踩坑 2：A2A peers=0

a2a-gateway 的 `ioredis` 依赖缺失。检查 `node_modules/ioredis/`。

### 踩坑 3：ACP 首次 2-3 分钟

冷启动下载 `@agentclientprotocol/claude-agent-acp`，不是卡死。

### 踩坑 4：plugin SDK drift

出现 `TypeError: xxx.yyy is not a function`、`manifest validation failed`、`Cannot find module 'openclaw/plugin-sdk/<x>'` → 立刻回滚 + 补 `patches/drift-fix/` patch。

### 踩坑 5：worktree push 被 hook 挡

`pnpm install` 一次解决，或用户授权 `--no-verify`。

### 踩坑 6：openclaw-src-fetcher clone 失败

3 层 fallback 兜底后 `/app/openclaw-src/src` 可能是空目录，不影响 runtime。

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

### 批量重建禁令

全量/批量重启必须先向用户报告方案，等明确确认后执行。

### 安全规则

绝不在 skill/文档/git 中写密码、API Key、飞书 App Secret。

### 关键文档

| 文档                                           | 内容                   |
| ---------------------------------------------- | ---------------------- |
| `docs/her/her-feishu-bot-architecture.md`      | 架构详解               |
| `docs/her/her-feishu-bot-enterprise-deploy.md` | 部署指南               |
| `docs/her/her-image-architecture.md`           | A+B 镜像架构           |
| `docker/servers.txt`                           | 服务器凭证（本地敏感） |
| `start-user.sh`                                | 容器管理脚本           |
| `scripts/carher-verify.sh`                     | 10 gate 自检           |
| `docs/her/acp-claude-code-setup.md`            | ACP 开启指南           |
