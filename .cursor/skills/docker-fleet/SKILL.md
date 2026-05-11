---
name: docker-fleet
description: Fleet-wide CarHer 运维（S1/S2/S3 所有 docker），包括 carher-openclaw、carher-hermes、carher-dual 当前容器角色。使用 docker compose 管理容器。仅 admin 容器可用（需 sshpass + /data/.openclaw/servers.txt）。
metadata:
  requires:
    bins: ["sshpass", "ssh"]
    env: ["CARHER_ADMIN"]
---

# docker-fleet — Admin 全 fleet 运维 skill

## 谁能用

只有 **admin 容器**（通常 id=198, 身份=研究1，带 `CARHER_ADMIN=1`）有工具链：

- `/usr/bin/sshpass` (apt 装好)
- `/data/.openclaw/servers.txt` (三台服务器凭证)
- env `CARHER_ADMIN=1`

其他 her 没 sshpass 也没 servers.txt，load 这个 skill 会跑不起来。发现不是 admin 就拒绝。

## Fleet 拓扑（2026-05-09 现状）

| 服务器 | IP           | 跑的容器                                                                                                                                | 架构    |
| ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| S1     | 10.68.13.186 | carher-12 (test), hermestest-13 (dual/卜弋天), **carher-198 (admin/研究1)**, hermestest-199 (Hermes/研究2), hermestest-200 (dual/研究3) | compose |
| S2     | 10.68.13.187 | 仅 carher-fallback (nginx)                                                                                                              | —       |
| S3     | 10.68.13.188 | hermestest-14 (dual/刘国现), hermestest-75 (dual/林森), carher-fallback, cloudflared                                                    | compose |

当前 fleet 2026-05-10 已验证到 dev `56ba82d3ee`（runtime code `c6ef7aae6b`）+ image `localhost:5001/carher-core:2026.5.9-p14-a2a-route`;7 个 bot 都应有 R-7 `CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER`、P8 history-fill、Bot Registry/knownBots、A2A S1/S3 路由修复、R-9 `reply-card default`、R-10 compact `footer-status`、R-11 `outbound-card default`。升级时不要假设 git remote 名一致:S1 `/Data/CarHer` 通常用 `carher`,S3 通常用 `origin`。

### 2026-05-11 Hermes / Dual 角色

- `carher-198` = 纯 OpenClaw control，仍在 `/Data/CarHer`。
- `hermestest-199` = 成熟 Hermes baseline，来源 `/Data/hermestest`。
- `hermestest-13` = S1 dual baseline，替代原 `carher-13`，来源 `/Data/hermestest/deploy/carher-13/compose.dual.yaml`。
- `hermestest-14` = S3 dual baseline，替代原 `carher-14`，来源 `/Data/hermestest/deploy/carher-14/compose.dual.yaml`。
- `hermestest-75` = S3 dual baseline，替代原 `carher-75`，来源 `/Data/hermestest/deploy/carher-75/compose.dual.yaml`。
- `hermestest-200` = S1 dual hot-switch candidate，替代原 `carher-200`，来源 `/Data/hermestest/deploy/carher-200/compose.dual.yaml`。
- 原 `carher-13` / `carher-14` / `carher-75` / `carher-200` compose 保留为 rollback；看到这些 `carher-*` 不在 `docker ps` 里不要误判离线，先查对应 `hermestest-*`。
- dual 容器的 active marker 是 `/data/.engine/active`，默认/安全态应为 `openclaw`。OpenClaw HOME=`/data`，Hermes HOME=`/opt/data`，lark-cli user token store 必须双向同步。
- 2026-05-11 已验证 13/14/75 使用同一 `hermestest:dual` image id `sha256:dce47696b6d96f54de54942199ff5bfd7f2e5b2613198e9a88c8b103c61fb448`，14/75 在 Her 产品测试群完成 hot-switch、`/new`、context、knownBots、KQA、ACP、daemon、reset index、A2A 回归。基线文档在 `hermestest/parity/DUAL_BASELINE_20260511.md`。
- 2026-05-11 已重新从 `hermestest` git HEAD `1224dbb` 通过 `git archive` 同步 S1 `/Data/hermestest`，重建 `hermestest:dev`=`sha256:f3729711a3c7137dd87607a25977eb3a517ecfc0ce0b33fae8b085cca3396e2e` 和 `hermestest:dual`=`sha256:24ad6668aebac4f6760db36d7282dbba8dbf27a88f38a3fb59e1677a05db4369`，compose recreate 199/200 后通过 `s1-dual-200-20260511T080356` 与 `s1-feature-20260511T080935`。200 最终安全态是 `openclaw`。

A2A 跨 S1/S3 依赖 `CARHER_SERVER`：S1 必须注册 `S1`,S3 必须注册 `S3`,不能都保持 `local`。`server=local` 会让跨主机 peer 被误判成同机 Docker DNS (`http://carher-N:18800`),表现为 S1 her 找不到 S3 her。检查 Redis `a2a:card:*` 时同时看 `server` 和 `endpoints.lan`。

## SSH helper（每 session 开头设一次）

凭证从 `servers.txt` 动态读取。**绝不在本文件 hardcode 密码**。

```bash
SERVERS_TXT="${SERVERS_TXT:-/data/.openclaw/servers.txt}"
[ -r "$SERVERS_TXT" ] || SERVERS_TXT="$(git rev-parse --show-toplevel 2>/dev/null)/docker/servers.txt"
[ -r "$SERVERS_TXT" ] || { echo "servers.txt not found"; return 1; }

S1_PW=$(awk '/^10\.68\.13\.186/ {print $3}' "$SERVERS_TXT")
S3_PW=$(awk '/^10\.68\.13\.188/ {print $3}' "$SERVERS_TXT")

s1() { sshpass -p "$S1_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 "$@"; }
s3() { sshpass -p "$S3_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.188 "$@"; }
```

**Shell footgun — do not compress the assignment and SSH into one command.**
This is wrong:

```bash
S1_PW=$(awk '/^10\.68\.13\.186/ {print $3; exit}' docker/servers.txt) sshpass -p "$S1_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 'hostname'
```

In POSIX shells, `$S1_PW` in the same command line is expanded before the
temporary assignment is visible to that argument, so `sshpass` may receive an
empty or stale password and report a fake `Permission denied`. Use two
commands, a semicolon, or the `s1` helper:

```bash
S1_PW=$(awk '/^10\.68\.13\.186/ {print $3; exit}' docker/servers.txt)
sshpass -p "$S1_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 'hostname'

# or
S1_PW=$(awk '/^10\.68\.13\.186/ {print $3; exit}' docker/servers.txt); sshpass -p "$S1_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 'hostname'

# preferred after defining helpers above
s1 'hostname'
```

If the user gives an explicit one-off `sshpass -p '...' ssh ...` command in
chat, run that exact shape instead of re-deriving credentials.

## 核心运维（compose 命令）

OpenClaw fleet compose 目录在 `/Data/CarHer/deploy/carher-{id}/`。Hermes/Dual 实验目录在 `/Data/hermestest/deploy/...`；不要把两者混用。

### 拉最新 dev（严禁直接改服务器代码）

```bash
# S1 通常:
s1 "cd /Data/CarHer && git pull --ff-only carher dev"

# S3 通常:
s3 "cd /Data/CarHer && git pull --ff-only origin dev"
```

如果 remote 名不同,先 `git remote -v`。不要用 `git reset --hard` 当常规升级手段;本地 commit + push 后,服务器只做 fast-forward pull。

### 查某个 her 日志

```bash
s1 "cd /Data/CarHer/deploy/carher-13 && docker compose logs --tail 100 carher"
```

### 停某个 her

```bash
s1 "cd /Data/CarHer/deploy/carher-13 && docker compose down"
```

### 重启某个 her

**轻量 restart**（process hang，config 不变）：

```bash
s1 "docker restart carher-13"
```

**完整 recreate**（config/image 变了）：

```bash
s1 "cd /Data/CarHer/deploy/carher-13 && docker compose up -d --force-recreate"
```

### 升级到新 image

编辑 `.env` 的 `IMAGE_TAG`，然后 `docker compose up -d`：

```bash
s1 "cd /Data/CarHer/deploy/carher-13 && sed -i 's|IMAGE_TAG=.*|IMAGE_TAG=carher-core:dev-0430-full|' .env && docker compose up -d"
# volume carher-13-data / carher-13-home 不动, sessions/memory 保留
```

### 新建 her（scaffold）

```bash
# 本地生成 compose 目录
./deploy/scaffold.sh N
# 提交 + push + 服务器 git pull
# 服务器上启动
s1 "cd /Data/CarHer/deploy/carher-N && docker compose up -d"
```

## 查 image 清单

```bash
s1 "docker images carher-core --format '{{.Repository}}:{{.Tag}} ({{.CreatedSince}})'"
```

## 诊断 workflow（报告 "X 挂了"）

```bash
# 1. 状态一览
s{N} "docker ps -a --format '{{.Names}} {{.Status}}' | grep carher-{id}"

# 2. 错误日志
s{N} "cd /Data/CarHer/deploy/carher-{id} && docker compose logs --tail 50 carher" \
  | grep -iE 'error|fail|exception|Gateway failed|Missing' | tail -20

# 3. exit code
s{N} "docker inspect carher-{id} --format '{{.State.ExitCode}} {{.State.Error}}'"

# 4. 15min 活跃度（决定能否 restart）
s{N} "docker logs carher-{id} --since 15m 2>&1 | grep -c 'deliver:'"

# 5. image 来源
s{N} "docker inspect carher-{id} --format '{{.Image}}' | xargs docker inspect --format 'hash={{index .Config.Labels \"carher.build.hash\"}} openclaw={{index .Config.Labels \"carher.openclaw.tag\"}}'"
```

## 🚫 铁律（违反立刻停 + 回报天哥）

1. **批量操作 > 1 个 > @天哥先确认**。"restart 所有 her" / "升级所有" 绝不擅自做。
2. **绝不 `docker volume rm`**（volume 里有 3 个月 session / memory）。
3. **绝不 `rm -rf` host 文件**（血的教训）。
4. **不直接 ssh 改服务器代码**：走本地 git commit → push → S1/S2/S3 git pull。
5. **15 分钟内有活跃对话的 her 不重启**。检查 `docker logs --since 15m | grep -c 'deliver:'` > 0 就跳过。
6. **不重启自己**（admin 容器）。执行 `docker stop carher-198` = 自杀。需要 restart 自己让天哥外部触发。
7. **改 servers.txt / users.csv 要三台同步**（不在 git 里）。

## 回报格式（发飞书给天哥）

```
[fleet-ops] {动作} carher-{id} on S{1/2/3}
before: {Up 2h / Exited / Restarting}
action: {命令}
after: {Up 20s (healthy) + WSClient connected}
耗时: {s}
```
