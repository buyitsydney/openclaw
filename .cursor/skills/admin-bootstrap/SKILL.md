---
name: admin-bootstrap
description: CarHer fleet 里 "admin her"（carher-198 = 研究1）的启动/恢复流程。admin 是普通 docker 容器，但有额外特权（sshpass/servers.txt/8 运维 skill/cpus=10）用 `bootstrap-admin.sh` 一键装回。Use when user asks 启动 admin / recover admin / 198 断了 / rebuild 198 / admin 缺工具 / fleet ops script 在哪.
---

# CarHer Admin Her 启动 / 恢复 流程

## TL;DR

**admin = carher-198 = 研究1 身份的 docker 容器**，启动**两步**：

```bash
cd /Data/CarHer

# Step 1: 和其他 her 一样用 start-user.sh
CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=16g A2A_ENABLED=1 A2A_OUTBOUND=1 \
  ./start-user.sh --id=198 --image=carher-core:0421-ab-v2

# Step 2: admin 特权 bootstrap (给她装 sshpass + servers.txt + 8 skill + cpus=10)
./bootstrap-admin.sh carher-198
```

Step 2 是 `bootstrap-admin.sh`（repo root），git tracked，每次 admin 容器 rebuild 后执行一次。

## 架构速查

admin 本质是**普通 docker 容器 + 4 层后置 bootstrap 带来的特权**：

| 层 | 资产 | 放哪 | docker rm 后是否丢 |
|---|---|---|---|
| start-user.sh 默认 | image, volume, bind mounts, env (ACP/A2A_OUTBOUND), gateway | docker 标准 | 容器定义重建后自动恢复 |
| bootstrap [1/4] | sshpass + openssh-client | 容器 writable layer | **丢**（每次 rebuild 要 apt install）|
| bootstrap [2/4] | `/data/.openclaw/servers.txt` | volume `carher-198-data` | **保留**（但 script idempotent 每次 cp 一遍）|
| bootstrap [3/4] | 8 admin skills | `/home/cltx/.openclaw/skills/` (host) | **可能丢**（host 目录可能被 rsync 覆盖）|
| bootstrap [4/4] | `cpus=10` | docker HostConfig | **丢**（start-user.sh 不设 cpus）|

## 8 个 admin 专属 skill（bootstrap [3/4] 部署）

```
docker-fleet            fleet-wide docker 运维入口（sshpass + ssh 跨机）
carher-image-upgrade    openclaw 升级流程（改 Dockerfile OPENCLAW_TAG）
carher-enterprise-ops   fleet 部署 + 拓扑 + tag 命名 + CSV
carher-a2a-topology     ACP/A2A 标准配置 (hub/spoke/cpu/mem 配额)
carher-shared-skills    skill 分发机制 (共享/个人/部门层)
cloudflare-tunnel       tunnel 路由
openclaw-gateway        gateway 启动/重启诊断
openclaw-logs           日志查询
```

源文件都在 `.cursor/skills/<name>/SKILL.md`（git tracked）。bootstrap-admin.sh 从这里 cp 到 host。

## 诊断：怎么知道 admin 特权丢了

admin 自己或天哥跑一次 check：

```bash
docker exec carher-198 which sshpass ssh   # 空 = 丢
docker exec carher-198 ls /data/.openclaw/servers.txt   # not exist = 丢
docker exec carher-198 ls /data/.openclaw/skills/docker-fleet/   # not exist = 丢
docker inspect carher-198 --format '{{.HostConfig.NanoCpus}}'   # 0 = 丢 (非 10000000000)
```

**任一项"丢"**，跑 `./bootstrap-admin.sh carher-198` 一键全修。

## 跨机 SSH 凭证

admin 通过 `sshpass -p '<pwd>' ssh cltx@<ip> docker ...` 跨机调 docker。凭证在 `/data/.openclaw/servers.txt`。**她不能把密码贴到飞书消息里**（会被日志/搜索抓）。

三台服务器（2026-04-23 状态）：
- S1 10.68.13.186 (admin 自己的 host)
- S2 10.68.13.187 (仅 carher-fallback)
- S3 10.68.13.188 (carher-14 / 75)

## 相关文档

- `docs/her/fleet-bootstrap.md` — 整个 fleet 从空白 bootstrap 或 IT reset 后 recovery 的 playbook（admin 只是其中 2.6）
- `.cursor/skills/docker-fleet/SKILL.md` — admin 自己日常运维用的 skill
- `.cursor/skills/carher-enterprise-ops/SKILL.md` — fleet 拓扑 + 部署
- `bootstrap-admin.sh` — repo root 的 script 本身

## ⚠️ 给 agent 的注意

- **不要擅自 `docker rm carher-198`**（她是你的运维管家）。如需 rebuild 让天哥发指令
- **改 start-user.sh 加 `--admin` flag 是个好 idea**（把 bootstrap 的 Step 1+2 合并），但属于 repo 侵入改动，需要 `git commit + push + S1/S2/S3 pull`
- admin 的 CPU=10 不是 16（和 docker-13 不同）。用户明确过"fleet 标准 10 cpu"
- admin **自己可以提醒天哥跑 bootstrap**，她的 `TOOLS.md` 里有这段自述
