# Fleet Bootstrap / Recovery Playbook

> **Purpose**: 从空白服务器 (或 IT reset 后的 S1) bootstrap 到 2026-04-23 的"全员已升级 + admin docker 特权"target state。
>
> **State at freeze**: `carher/dev` and `carher/feat/carher-a-b-decouple` HEAD = `b98a7e1223`
>
> **Tag**: `carher-core:0421-ab-v2` (build from this HEAD)

## 1. Target state (what we want)

每台服务器的 target state：

| 服务器 | 容器           | Image                                                | Profile                                    |
| ------ | -------------- | ---------------------------------------------------- | ------------------------------------------ |
| S1     | carher-12      | `carher:0420-ab-v2-src`（或 carher-core:0421-ab-v2） | 普通（test/弋天）                          |
| S1     | carher-13      | `carher-core:0421-ab-v2`                             | **Hub + ACP + 16GB**（卜弋天主 her）       |
| S1     | **carher-198** | `carher-core:0421-ab-v2`                             | **Hub + ACP + 16GB + admin 特权**（研究1） |
| S1     | carher-199     | `carher-core:0421-ab-v2`                             | Hub + ACP（研究2）                         |
| S1     | carher-200     | `carher-core:0421-ab-v2`                             | Hub + ACP（研究3）                         |
| S3     | carher-14      | `carher-core:0421-ab-v2`                             | 普通（刘国现）                             |
| S3     | carher-75      | `carher-core:0421-ab-v2`                             | 普通（林森）                               |

Fleet-wide shared 配置（在 git，`config/` 目录是真源 — 详见 `docs/her/config-architecture`）：

- `config/base.json5` 里 `tools.agentToAgent.enabled=true` + `tools.sessions.visibility="all"`（所有 agent 继承）
- `config/docker.json5` 里 `agents.defaults.model.primary="anthropic/anthropic.claude-opus-4-7"` + Wangsu/OpenRouter model lists
- 过去的 `docker/shared-config.json5` + `docker/carher-config.json` + `docker/user-configs/` 保留为 **deprecated safety net**，运行时不再挂载使用。

## 2. Bootstrap 步骤

### 2.1 Git 代码（任何服务器）

```bash
# 新机器：clone
git clone git@github.com:buyitsydney/CarHer.git /Data/CarHer
cd /Data/CarHer

# 老机器：fetch + reset
cd /Data/CarHer
git fetch origin feat/carher-a-b-decouple
git reset --hard origin/feat/carher-a-b-decouple   # HEAD 应该到 b98a7e1223
git log --oneline -1
# 期望: feat/config-rebuild HEAD (包含 config/ 新 tree + 扁平挂载 compose)
```

### 2.2 Host-local 非 git 文件（手动部署）

这些文件 **gitignored，每台服务器独立**：

```bash
# docker/server.env — API keys, tunnel host, AUTH_HOST
# 内容示例 (S1):
#   ANTHROPIC_BASE_URL=https://litellm.carher.net
#   ANTHROPIC_AUTH_TOKEN=sk-5VnGHyR9WLzbLpvCgdFZEw
#   OPENROUTER_API_KEY=sk-or-v1-...
#   CARHER_AUTH_HOST=s1-u198-auth.carher.net   # S1 上 admin 用 u198 路由
#   CARHER_SERVER=S1
#   CARHER_LAN_IP=10.68.13.186
# 部署: scp 从其他服务器 (或本地 Mac 的 ops 目录) 过来

# docker/users.csv — 用户注册表 (含 Feishu appId/secret)
# 三台独立，但内容保持同步
# 部署: scp 从任一在用服务器过来

# docker/servers.txt — 三台服务器 IP/密码
# 部署: scp 或手填
```

`CARHER_SERVER` 是 A2A 路由的物理主机名，S1/S3 不能都保持 `local`；同机 peer
走 Docker DNS，跨机 peer 走 `CARHER_LAN_IP:CARHER_A2A_PORT`。

**任何时候改 `users.csv` / `server.env` / `servers.txt`，必须同步到所有三台服务器**（`md5sum` 验证一致）。

### 2.3 Image build

```bash
cd /Data/CarHer
./build-image.sh                                    # 默认 carher:local
./build-image.sh --tag=carher-core:0421-ab-v2       # 给 fleet 用的 tag
```

build-image.sh 会从 Dockerfile.carher.v2 build。要升级 openclaw base 只需改 `Dockerfile.carher.v2` 里 `OPENCLAW_TAG=2026.4.21` 这个 ARG，再 build。详见 `.cursor/skills/carher-image-upgrade/SKILL.md`。

### 2.4 Skills 部署（host 全员层）

**skill 源在 git（`.cursor/skills/`），但要 cp 到 host 的 `/home/cltx/.openclaw/skills/` 才能被 her 加载。**

```bash
cd /Data/CarHer
# 复制所有运维 skill 到全员层
for s in docker-fleet carher-image-upgrade carher-enterprise-ops carher-a2a-topology \
         carher-shared-skills cloudflare-tunnel openclaw-gateway openclaw-logs; do
  if [ -f ".cursor/skills/$s/SKILL.md" ]; then
    mkdir -p "/home/cltx/.openclaw/skills/$s"
    cp ".cursor/skills/$s/SKILL.md" "/home/cltx/.openclaw/skills/$s/SKILL.md"
    echo "deployed: $s"
  fi
done

# feishu-* 系列 skill（如果 host 还没有）：需要从已部署服务器 rsync 过来或自装
# lark-skill-maker + lark-openapi-explorer: 从已部署服务器 rsync 或自装
```

### 2.5 启动 docker 容器

```bash
cd /Data/CarHer

# carher-12 (test)
CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=16g A2A_ENABLED=1 A2A_OUTBOUND=1 \
  ./compose --id=12 --image=carher-core:0421-ab-v2

# carher-13 (卜弋天 主 her)
CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=16g A2A_ENABLED=1 A2A_OUTBOUND=1 \
  ./compose --id=13 --image=carher-core:0421-ab-v2

# carher-199, 200 (研究2/3)
for id in 199 200; do
  CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=16g A2A_ENABLED=1 A2A_OUTBOUND=1 \
    ./compose --id=$id --image=carher-core:0421-ab-v2
done

# carher-198 (admin = 研究1) — 先普通启动
CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=16g A2A_ENABLED=1 A2A_OUTBOUND=1 \
  ./compose --id=198 --image=carher-core:0421-ab-v2
```

### 2.6 Admin 容器特殊 bootstrap（carher-198）— 用 `bootstrap-admin.sh` 一键化

**admin 需要额外装 sshpass + 拿 servers.txt。在 `compose` 起完后做**：

```bash
# 装 sshpass + ssh client（apt 走容器内 root）
docker exec -u root carher-198 sh -c "apt-get update -qq && apt-get install -y sshpass openssh-client"

# cp servers.txt 进 volume（持久化，容器重启不丢）
docker cp /Data/CarHer/docker/servers.txt carher-198:/data/.openclaw/servers.txt

# 验证
docker exec carher-198 which sshpass ssh
docker exec carher-198 head -3 /data/.openclaw/servers.txt
# admin 现在能跨机 ssh cltx@10.68.13.18{6,7,8} docker ...
```

**这步用 `./bootstrap-admin.sh [carher-198]` 一键做完**（git tracked, 可重复）。每次 admin 容器 rebuild 后执行一次（sshpass 装在 writable layer，`docker rm + run` 会丢）。推荐写 `./bootstrap-admin.sh` 封装这两步（未来工作）。

### 2.7 Cloudflared 路由

`/etc/cloudflared/config.yml` 里 **每台服务器独立**。S1 目前 u13 / u198 路由到对应 docker 端口：

```yaml
# S1 (端口号来自 compose 按 id 分配: {29000 + id*10 + offset})
- hostname: s1-u13-fe.carher.net
  service: http://localhost:29123 # docker-13 fe (8000 map)
- hostname: s1-u13-proxy.carher.net
  service: http://localhost:29124 # docker-13 proxy (8080 map)
- hostname: s1-u13-auth.carher.net
  service: http://localhost:29125 # docker-13 auth (18891 map)

- hostname: s1-u198-fe.carher.net
  service: http://localhost:30973 # carher-198 fe
- hostname: s1-u198-proxy.carher.net
  service: http://localhost:30974
- hostname: s1-u198-auth.carher.net
  service: http://localhost:30975
```

查实际映射：`docker port carher-{N}`。

Restart cloudflared：`sudo systemctl restart cloudflared`。

### 2.8 Fleet 资源配额（可选，docker update 即生效）

主 her 和 admin 可以提到 16 CPU：

```bash
docker update --cpus=16 carher-13 carher-198
```

## 3. Recovery after S1 硬盘 reset (IT 恢复 4am 镜像后)

S1 回到 2026-04-23 04:00 的状态（今天所有改动消失，但 3 个月 session 数据恢复）。步骤：

```bash
# 1. Git: fetch + reset 到 config-rebuild HEAD (把新 config/ 树 + compose 的扁平挂载改动拉回来)
cd /Data/CarHer
git fetch origin feat/carher-a-b-decouple
git reset --hard origin/feat/carher-a-b-decouple

# 2. 按 2.4 部署 skills 到全员层
# 3. 按 2.5 用新 compose env 起 5 个 docker (会 docker rm + run 新定义覆盖老容器; volume 保留)
# 4. 按 2.6 admin 容器 bootstrap (sshpass + servers.txt)
# 5. 按 2.7 restart cloudflared 如有端口变化
```

**关键 volume 保留**：`carher-N-data` / `carher-N-home` 不动，3 个月 session + memory + workspace 全都在。

## 4. 验证 checklist

```bash
# 容器全起
docker ps --format "{{.Names}} {{.Status}}" | grep carher

# 各 her feishu 连接 + outbound + ACP
for c in carher-12 carher-13 carher-198 carher-199 carher-200; do
  echo "=== $c ==="
  docker logs $c --since 3m 2>&1 | grep -E "ACP ready|outbound\.enabled|WSClient connected|ws client ready" | tail -5
done

# config 来自 /data/.openclaw/openclaw.json (= config/u{N}.json5 bind mount) + /data/.openclaw/{base,docker}.json5
docker exec carher-13 grep -A1 "agentToAgent" /data/.openclaw/base.json5 | tail -3
# 期望看到 enabled: true

# sessions 在 base 里也能看
docker exec carher-13 grep -A1 '"sessions"' /data/.openclaw/base.json5 | tail -3
# 期望: "visibility": "all"

# admin 特权
docker exec carher-198 which sshpass
docker exec carher-198 sshpass -p 'cxS4p)apmQ7f' ssh -o StrictHostKeyChecking=no \
  cltx@10.68.13.186 "docker ps --format '{{.Names}}' | head -5"
```

## 5. Known gaps（仍要手工的）

- **admin bootstrap 已写成 script** ✅ (2.6 `./bootstrap-admin.sh [carher-198]`，git tracked，rebuild admin 必跑)
- **skills 部署没自动**：2.4 靠 cp。建议未来在 `start.sh` / `compose` 加 hook 自动同步 `.cursor/skills/` → host
- **`docker-fleet/SKILL.md` 加进 `.cursor/skills/`** ✅

## 6. Tag 约定

- `carher-core:{date}-ab-v2` — 不带 openclaw src 的 runtime 镜像（更小）
- `carher:{date}-ab-v2-src` — 带 openclaw src（ACP 要读源码时用）
- 新版本 bump 对应 `Dockerfile.carher.v2` 里 `OPENCLAW_TAG` ARG。详见 `.cursor/skills/carher-image-upgrade/SKILL.md`。
