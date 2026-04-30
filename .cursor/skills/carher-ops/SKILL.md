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

## 第 2 章 · 当前部署真相（2026-04-30 compose 全面迁移）

**S1 全部 4 个 bot 已迁移到 compose 架构。**

| 位置              | 容器         | 用户         | Bot App ID             | 架构    |
| ----------------- | ------------ | ------------ | ---------------------- | ------- |
| S1 (10.68.13.186) | `carher-13`  | 卜弋天       | `cli_a917e5525178dbb3` | compose |
| S1 (10.68.13.186) | `carher-198` | admin/研究1  | `cli_a96f0bfba3789cd4` | compose |
| S1 (10.68.13.186) | `carher-199` | 研究2        | `cli_a9717259fcb89cd6` | compose |
| S1 (10.68.13.186) | `carher-200` | 研究3        | `cli_a971724b62f89cd8` | compose |
| S3 (10.68.13.188) | `carher-14`  | 刘国现       | `cli_a91569fab9b81bc6` | 待迁移  |
| S3 (10.68.13.188) | `carher-75`  | 林森         | `cli_a94a0b73a878dbcb` | 待迁移  |

**Mac 本地测试容器**（id=101/102/103/104）：`carher-101`=tester, `carher-102`=tester2, `carher-103`=tester3, `carher-104`=tester4。

**行动原则**：`docker/servers.txt` 是手动维护的真相表。

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

## 第 10 章 · 踩坑库

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
