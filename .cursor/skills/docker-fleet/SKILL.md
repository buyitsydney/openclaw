---
name: docker-fleet
description: Fleet-wide CarHer 运维（S1/S2/S3 所有 docker）。仅 admin 容器可用（需 sshpass + /data/.openclaw/servers.txt）。优先用 start-user.sh 封装命令。
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

## Fleet 拓扑（2026-04-23 现状）

| 服务器 | IP | 跑的容器 |
|---|---|---|
| S1 | 10.68.13.186 | carher-12 (test), carher-13 (卜弋天), **carher-198 (我=admin=研究1)**, carher-199 (研究2), carher-200 (研究3) |
| S2 | 10.68.13.187 | 仅 carher-fallback (nginx) |
| S3 | 10.68.13.188 | carher-14 (刘国现), carher-75 (林森), carher-fallback, cloudflared |

凭证读取:
```bash
awk '/^10\.68/ {print $1, $2, $3}' /data/.openclaw/servers.txt
```

## SSH helper（每 session 开头设一次）

```bash
s1() { sshpass -p 'cxS4p)apmQ7f' ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 "$@"; }
s2() { sshpass -p 'c@oKknm3Lm9f' ssh -o StrictHostKeyChecking=no cltx@10.68.13.187 "$@"; }
s3() { sshpass -p 'f{Zv30fCeqnw' ssh -o StrictHostKeyChecking=no cltx@10.68.13.188 "$@"; }
```

之后所有操作 `s1 "cmd"` / `s2 "cmd"` / `s3 "cmd"`。

## 核心运维（优先 `start-user.sh` 封装）

`start-user.sh` 位置：所有服务器都在 `/Data/CarHer/start-user.sh`。

### 查所有用户 + 容器状态
```bash
s1 "cd /Data/CarHer && ./start-user.sh --list"
s3 "cd /Data/CarHer && ./start-user.sh --list"
```

### 查某个 her 日志
```bash
s1 "cd /Data/CarHer && ./start-user.sh --id=13 --logs"
```

### 停某个 her
```bash
s1 "cd /Data/CarHer && ./start-user.sh --id=13 --down"
```

### 重启某个 her

**轻量 restart**（process hang，config 不变）：
```bash
s1 "docker restart carher-13"
```

**完整 rebuild**（config 变了要重新注入）：
```bash
s1 "cd /Data/CarHer && ./start-user.sh --id=13 --down && \
    CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=16g A2A_ENABLED=1 A2A_OUTBOUND=1 \
    ./start-user.sh --id=13 --image=carher-core:0421-ab-v2"
```

### 升级到新 image（一条命令）

`start-user.sh` 自动 stop + rm 老容器 + docker run 新容器（volume 保留）：

```bash
s1 "cd /Data/CarHer && \
    CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=16g A2A_ENABLED=1 A2A_OUTBOUND=1 \
    ./start-user.sh --id=13 --image=carher-core:0422-ab-v2"
# volume carher-13-data / carher-13-home 不动, 3 个月记忆/memory 保留
```

### 新建 her（新 id，users.csv 已有该行）
```bash
s1 "cd /Data/CarHer && \
    CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=16g A2A_ENABLED=1 A2A_OUTBOUND=1 \
    ./start-user.sh --id={N} --image=carher-core:0421-ab-v2"
```

## 环境变量清单（何时加）

`start-user.sh` 默认 2GB 内存、无 ACP、无 A2A hub。给主 her / admin 要传：

| env | 何时加 |
|---|---|
| `CARHER_ACP_ENABLED=1` | ACP (Claude Code subagent) 能力。主 her、admin 要 |
| `CARHER_MEMORY_LIMIT=16g` | 内存上限。主 her、admin 要 16g |
| `A2A_ENABLED=1` | 加入 A2A mesh（接收任务）。大部分 her 要 |
| `A2A_OUTBOUND=1` | A2A hub 模式（能主动 dispatch）。仅 admin / 卜弋天 主 her |

三级架构（参考 `carher-a2a-topology` skill）：
- 无 A2A（默认）：只响应，无 skill 调用
- Spoke：`A2A_ENABLED=1` 被动接任务
- Hub：`A2A_ENABLED=1 A2A_OUTBOUND=1` 主动调度

## 查 image 清单
```bash
s1 "docker images carher-core --format '{{.Repository}}:{{.Tag}} ({{.CreatedSince}})'"
```

选最新的。`-src` 后缀的是带 openclaw 源码的 image（ACP 需要，Her 能 grep upstream 代码）。

## 诊断 workflow（报告 "X 挂了"）

```bash
# 1. 状态一览
s{N} "docker ps -a --format '{{.Names}} {{.Status}}' | grep carher-{id}"

# 2. 错误日志
s{N} "cd /Data/CarHer && ./start-user.sh --id={id} --logs" \
  | grep -iE 'error|fail|exception|Gateway failed|Missing' | tail -20

# 3. exit code
s{N} "docker inspect carher-{id} --format '{{.State.ExitCode}} {{.State.Error}}'"

# 4. 15min 活跃度（决定能否 restart）
s{N} "docker logs carher-{id} --since 15m 2>&1 | grep -c 'deliver:'"
```

exit code 78 + "Missing config" → 检查 `carher-config-{id}.json` 是不是缺 ACP/plugins 字段。

## 🚫 铁律（违反立刻停 + 回报天哥）

1. **批量操作 > 1 个 > @天哥先确认**。"restart 所有 her" / "升级所有" 绝不擅自做。
2. **绝不 `docker volume rm`**（volume 里有 3 个月 session / memory）。
3. **绝不 `rm -rf` host 文件**（卜弋天 volume 被 `rm -rf /home/cltx/.openclaw/` 删过 2609 session，血的教训）。
4. **不直接改 shared-config.json5**：走本地 git commit → push → S1/S2/S3 git pull。
5. **15 分钟内有活跃对话的 her 不重启**。检查 `docker logs --since 15m | grep -c 'deliver:'` > 0 就跳过。
6. **不重启自己**（admin 容器）。执行 `docker stop carher-198` = 自杀。需要 restart 自己让天哥外部触发。
7. **改 servers.txt / users.csv 要三台同步**（不在 git 里，手动 scp 到三台）。

## 回报格式（发飞书给天哥）

```
[fleet-ops] {动作} carher-{id} on S{1/2/3}
before: {Up 2h / Exited / Restarting}
action: {命令}
after: {Up 20s (healthy) + WSClient connected}
耗时: {s}
```
