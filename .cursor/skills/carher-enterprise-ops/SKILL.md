---
name: carher-enterprise-ops
description: CarHer 企业 Docker 容器运维操作。Use when the user mentions 董事长, her, docker, 容器, 服务器, server, carher, 健康检查, 重启, restart, 日志, CSV, open_id, owner, pairing, or any enterprise deployment operation.
---

# CarHer 企业容器运维

## ⚠️ 当前部署真相（2026-04-20 大迁移之后）

**只剩 3 个用户的 bot 在服务器上运行；其他历史容器（carher-1..78）全部下线。**

| 位置              | 容器        | 用户        | Bot App ID             |
| ----------------- | ----------- | ----------- | ---------------------- |
| S1 (10.68.13.186) | `carher-12` | 卜弋天 test | `cli_a917fa892ff91bb5` |
| S1 (10.68.13.186) | `carher-13` | 卜弋天      | `cli_a917e5525178dbb3` |
| S3 (10.68.13.188) | `carher-14` | 刘国现      | `cli_a91569fab9b81bc6` |
| S3 (10.68.13.188) | `carher-75` | 林森        | `cli_a94a0b73a878dbcb` |

**已迁出服务器**：

- 董事长（`cli_a9054f702c789bd9` / 旧 `carher-1`）— S1 上残留 exited 容器，未经用户指令不清理也不启动
- S2 所有 32 个容器已下线，只剩 `carher-fallback`
- S3 原有 14 容器也只剩上表里的 2 个

**Mac 本地测试容器**（`docker/users.csv` id=101/102/103）：

- `carher-101` = tester
- `carher-102` = tester2
- `carher-103` = tester3
  以及 `carher-3`（董事长身份注册行，不对应实际运行容器）。

**行动原则**：不要假设任何 carher-1..78 容器存在。用户提到某个容器时先 `docker ps -a --filter name=carher-N` 确认实际状态。`docker/servers.txt` 是手动维护的真相表。

**跨服务器 bot open_id 同步铁律**：`feishu_bot_open_id`（CSV 第 10 列）必须在 **所有服务器的 CSV** 上同步。S1/S2/S3 各有独立 CSV 副本。如果只在 S1 更新了 bot A 的 open_id，S2/S3 上的容器就无法识别 bot A。批量获取 open_id 后，必须同步到所有 3 台服务器的 CSV。

## 快速定位流程

### 1. 找到服务器和密码

```bash
# 服务器列表（含 IP、用户名、密码）
cat docker/servers.txt
```

用 `sshpass` 登录：

```bash
sshpass -p 'PASSWORD' ssh -o StrictHostKeyChecking=no USER@IP "COMMAND"
```

### 2. 找到目标容器

每台服务器的用户分配在服务器本地 CSV 中（不在 git 里）：

```bash
# 登录后查看该服务器管理哪些用户
sshpass -p 'PWD' ssh USER@IP "cat /Data/CarHer/docker/users.csv"
```

CSV 格式：`id,姓名,模型,feishu_app_id,feishu_app_secret,feishu_owner_open_id,provider,备注,owner_allow_from`

容器命名：`carher-{id}`（如 id=101 → `carher-101`）

### 3. 确认容器状态

```bash
sshpass -p 'PWD' ssh USER@IP "docker ps --format '{{.Names}} {{.Status}}' | grep carher | sort"
```

## 常用操作

### 健康检查

```bash
# 查看容器日志（最近 N 行）
sshpass -p 'PWD' ssh USER@IP "docker logs carher-N --tail 50"

# 检查飞书连接是否正常（应看到 "Feishu WSClient connected" + "ws client ready"）
sshpass -p 'PWD' ssh USER@IP "docker logs carher-N 2>&1 | grep -E 'WSClient connected|ws client ready'"

# 查看持久化日志文件
sshpass -p 'PWD' ssh USER@IP "docker exec carher-N cat /tmp/openclaw/openclaw-\$(date +%Y-%m-%d).log | tail -50"
```

### 重建容器

**铁律 1：重建前必须确认最近 15 分钟无交互！**

**铁律 2：未经用户同意，严禁擅自批量/并行重启 docker！**

- **全量重启/批量重启必须先向用户报告完整方案（含服务器顺序、容器列表、预计耗时），等用户明确确认后才能执行，绝不允许自作主张**
- 每个容器重建前必须检查活跃状态（15 分钟内有 `deliver:` 消息则跳过）

### 构建与部署分离（必须理解！）

构建和部署是**两个独立步骤**，由不同脚本负责：

| 脚本             | 职责             | 关键参数                                              |
| ---------------- | ---------------- | ----------------------------------------------------- |
| `build-image.sh` | 构建 Docker 镜像 | `--tag=NAME`, `--branch=BRANCH`, `--force`, `--check` |
| `start-user.sh`  | 启动/管理容器    | `--image=NAME`（默认 `carher:local`）                 |

**`start-user.sh` 永远不构建镜像。** 如果镜像不存在，会报错并提示运行 `build-image.sh`。

同一台服务器的所有容器**共享同一个 `carher:local` 镜像**，所以：

- `build-image.sh` 构建一次，所有容器复用
- **实验隔离**：`build-image.sh --branch=feature/xxx --tag=carher:xxx` 构建实验镜像，`start-user.sh --id=N --image=carher:xxx` 只让指定容器用实验镜像，不影响其他容器

### 批量升级正确流程（两阶段）

**阶段 1：镜像构建（三台服务器并行）**

```bash
# S1、S2、S3 各自构建镜像（并行，约 60-90s）
sshpass -p 'PWD' ssh USER@S1 "cd /Data/CarHer && ./build-image.sh" &
sshpass -p 'PWD' ssh USER@S2 "cd /Data/CarHer && ./build-image.sh" &
sshpass -p 'PWD' ssh USER@S3 "cd /Data/CarHer && ./build-image.sh" &
wait
```

**阶段 2：并行重启所有容器（镜像已就绪）**

```bash
# 1. 批量检查所有待重启容器的 15min 活跃度
for id in 2 3 4 5 ...; do
  LAST=$(docker logs --since=15m carher-$id 2>&1 | grep -c "deliver:")
  if [ "$LAST" -gt 0 ]; then echo "carher-$id: ACTIVE (跳过)"
  else echo "carher-$id: IDLE"; fi
done

# 2. 所有 IDLE 容器并行重启
for id in <IDLE容器列表>; do
  ./start-user.sh --id=$id > /tmp/restart-$id.log 2>&1 &
done
wait

# 3. 批量验证所有容器连接状态
for id in <所有容器>; do
  echo "carher-$id: $(docker logs carher-$id --since=120s 2>&1 | grep -c 'WSClient connected') connections"
done
```

**关键：阶段 2 的并行重启总耗时 ≈ 单个容器启动时间（约 40s），而非 N × 40s！**

**单个容器重启步骤（非批量场景）：**

```bash
# 1. 检查该容器活跃状态（>0 则跳过）
sshpass -p 'PWD' ssh USER@IP "docker logs carher-N --since=15m 2>&1 | grep -c 'deliver:'"

# 2. 确认 0 条消息后重启
sshpass -p 'PWD' ssh USER@IP "cd /Data/CarHer && ./start-user.sh --id=N 2>&1 | tail -5"

# 3. 确认 WSClient connected
sshpass -p 'PWD' ssh USER@IP "docker logs carher-N --since=120s 2>&1 | grep 'WSClient connected'"
```

**实验分支隔离测试（单个容器用不同代码）：**

```bash
# 构建实验镜像（自动创建/清理 worktree）
sshpass -p 'PWD' ssh USER@IP "cd /Data/CarHer && ./build-image.sh --branch=feature/xxx --tag=carher:xxx"

# 只让指定容器用实验镜像
sshpass -p 'PWD' ssh USER@IP "cd /Data/CarHer && ./start-user.sh --id=N --image=carher:xxx"

# 回退：不加 --image 即用回 carher:local
sshpass -p 'PWD' ssh USER@IP "cd /Data/CarHer && ./start-user.sh --id=N"
```

### 代码更新（必须走 git 标准流程！）

```bash
# 1. 本地提交（等用户确认后）
git add <changed-files>
git commit -m "描述"

# 2. 推送到远程
git push --no-verify

# 3. 各服务器 pull + 构建
sshpass -p 'PWD' ssh USER@IP "cd /Data/CarHer && git pull && ./build-image.sh"

# 4. 重启相关容器
sshpass -p 'PWD' ssh USER@IP "cd /Data/CarHer && ./start-user.sh --id=N"
```

**禁止用 scp 或 ssh 直接修改服务器上的代码文件！详见"代码同步铁律"章节。**

### 收集用户 open_id

当 CSV 的 `feishu_owner_open_id` 为空时，用户没有 cron 等高权限工具。

```bash
# 方法1：从 docker logs 搜索（重建后会丢失）
sshpass -p 'PWD' ssh USER@IP "docker logs carher-N 2>&1 | grep 'from=ou_'"

# 方法2：从持久化 session 文件搜索（不会丢失）
sshpass -p 'PWD' ssh USER@IP "docker exec carher-N find /data/.openclaw/agents -name '*.jsonl' -exec grep -oh 'ou_[a-f0-9]*' {} \; | sort -u"
```

找到后填入服务器 CSV 的 `feishu_owner_open_id` 列，然后重建容器。

### 编辑服务器 CSV

```bash
# 用 sed 替换（注意用 # 做分隔符，避免和 | 冲突）
sshpass -p 'PWD' ssh USER@IP "sed -i 's#OLD_PATTERN#NEW_PATTERN#' /Data/CarHer/docker/users.csv"

# 验证
sshpass -p 'PWD' ssh USER@IP "grep '^ID,' /Data/CarHer/docker/users.csv"
```

## Owner 机制（影响 cron 等高权限工具）

两种配置方式（CSV 两列）：

| 场景                 | CSV 列                          | 生成配置                  | 效果                     |
| -------------------- | ------------------------------- | ------------------------- | ------------------------ |
| 专属 Bot（1人1bot）  | `feishu_owner_open_id`          | `dm.allowFrom`            | 限制访问 + 识别 Owner    |
| 共享 Bot（多人共用） | `owner_allow_from`（`\|` 分隔） | `commands.ownerAllowFrom` | 不限制访问，仅指定 Owner |

无 Owner → AI 看不到 cron/gateway 等 `ownerOnly` 工具。

## 🚫 代码同步铁律：永远走 git 标准流程

**任何脚本/代码修改同步到服务器，必须严格遵循：**

```
本地修改 → git commit → git push → 服务器 git pull
```

**绝对禁止：**

- `scp` 直接推文件到服务器
- `ssh` + `cat/echo/sed` 直接在服务器上改代码文件
- 任何绕过 git 的文件传输方式

**原因：** 绕过 git 会导致本地和服务器版本不一致，下次 `git pull` 可能冲突覆盖，且没有变更记录可追溯。

**唯一例外：** 服务器本地的 `users.csv`、`servers.txt`（含密钥，不在 git 中）可直接编辑/scp。

### servers.txt 同步

`servers.txt` 是全局真相，修改后（新增用户、修改分布、更新 token）必须同步到所有服务器：

```bash
scp docker/servers.txt cltx@IP:/Data/CarHer/docker/servers.txt
```

验证：4 台机器 `md5sum` 一致。

## 新用户部署 Checklist

每次添加新用户，严格按此清单：

1. 服务器 CSV 添行（10 列）→ `./start-user.sh --id=N`
2. 获取 bot open_id：用 `/bot/v3/info` API（参考下方脚本）→ 回填 CSV 第 10 列 `feishu_bot_open_id`
3. **同步到所有服务器**的 CSV（S1/S2/S3 各有独立副本，缺一不可）
4. 验证容器 config：App ID/Secret、models providers、groups、gateway dangerously\* 配置
5. 确认 WSClient connected
6. 更新本地 Mac `docker/servers.txt` → scp 同步到所有服务器
7. 通知 IT：配置长连接 → 添加事件 `im.message.receive_v1` → 第二次发布
8. 用户首次对话后：从 session 日志提取 open_id → 更新 CSV → 重建（先检查活跃！）→ 验证 `dm.allowFrom`

**新 bot 加入后其他容器如何感知？**

- 群消息历史检测：新 bot 在群里说话后，其他 bot 下一次处理群消息时自动从历史中发现它 ✅
- knownBots config：旧容器的 knownBots 在启动时从 CSV 生成，新 bot 不在其中 → **旧容器需要逐批重启**才能在 knownBots 里看到新 bot
- 未来优化：将 knownBots 改成运行时从共享文件读取，可实现零重启动态更新

**批量获取 bot open_id 脚本（在任一服务器运行）：**

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
            print(f"{row[0]},{row[1]},{app_id},{bot[\"open_id\"]}")
        except Exception as e:
            print(f"{row[0]},{row[1]},{app_id},ERROR:{e}")
'
```

### 群聊 vs 单聊判断

- CSV 备注含"共用"/"运营部" → 群聊，用 `owner_allow_from`
- session unique senders = 1 → 单聊，用 `feishu_owner_open_id`
- session unique senders >> 1 → 群聊或被拉群，需确认

## yitian-her（S1 原生进程，非 Docker）

S1 上有一个 host-native yitian-her（`10.68.13.186` / 弋天自用），**不是 Docker 容器**，而是直接跑在 host 上的 gateway 进程。

### 启动 / 重启

统一用 `./start.sh`（和 Mac 本地 her 是**同一个脚本**），从 S1 的主仓库 `/Data/CarHer/` 跑：

```bash
sshpass -p '<pwd>' ssh cltx@10.68.13.186 \
  "tmux kill-session -t her 2>/dev/null || true; \
   sleep 2; \
   tmux new-session -d -s her 'cd /Data/CarHer && ./start.sh 2>&1 | tee -a ~/logs/yitian-her.log'"
```

- tmux session 名：**`her`**（`start.sh` 第 27 行硬编码）
- 端口：18789
- bind：**lan**（从 `/Data/CarHer/docker/server.env` 的 `OPENCLAW_GATEWAY_BIND=lan` 自动注入，**不用手动传 --bind**）
- 凭据、Feishu bot identity、Anthropic token 全部从 `server.env` + `shared-config.json5` + `~/.openclaw/openclaw.json` 三层 config 合并

### 运行时 config 放哪

| 配置项                                                                | 位置                                      | 是否 git 追踪              |
| --------------------------------------------------------------------- | ----------------------------------------- | -------------------------- |
| bind / auth host / API keys                                           | `/Data/CarHer/docker/server.env`          | ❌ gitignored              |
| 插件默认 config（a2a-gateway enabled 等）                             | `/Data/CarHer/docker/shared-config.json5` | ✅                         |
| ACP enabled / A2A hub（`outbound.enabled=true`）/ sessions.visibility | `/home/cltx/.openclaw/openclaw.json`      | ❌ host-local runtime 文件 |

### 验证

```bash
sshpass -p '<pwd>' ssh cltx@10.68.13.186 \
  "sudo ss -tlnp | grep 18789; \
   grep -E 'outbound\.enabled|Gateway 已启动' ~/logs/yitian-her.log | tail -3"
```

期望看到：`0.0.0.0:18789` + `a2a-gateway: outbound.enabled=true` + `Gateway 已启动`。

### ❌ 不要做

- **不要**用 `start-user.sh` 管理 yitian-her（那是 docker 容器专用）
- **不要**在 `docker/users.csv` 添加 yitian-her 行
- **不要**手动跑 `node dist/index.js gateway run ...`——用 `./start.sh`，它会处理 build、旧进程清理、config 同步
- **不要**在 tmux 外跑 start.sh——它会自动 exec 进 tmux session `her`

## 🚫 灰度测试铁律（违反者死）

在服务器做灰度测试，**必须全部满足以下条件**：

1. **必须用自己的 worktree**：`git worktree add /tmp/xxx-wt origin/feat/xxx --detach`
2. **必须用自己的独立分支**：`feat/xxx`，绝不碰服务器的 dev/main
3. **必须用 worktree 里面的 start-user.sh 启动容器**：`cd /tmp/xxx-wt && ./start-user.sh --image=carher:xxx`
4. **必须用独立的 image tag**：如 `carher:bot-registry`，绝不碰 `carher:local`
5. **绝不在服务器上 checkout dev**，绝不 `git pull` dev，绝不碰 `/Data/CarHer/` 主仓库的分支
6. **worktree 必须 symlink server.env 和 users.csv**：`ln -sf /Data/CarHer/docker/server.env docker/server.env && ln -sf /Data/CarHer/docker/users.csv docker/users.csv`
7. **三台服务器必须全部用 worktree**，不能有的用 worktree 有的用主仓库——否则 config 版本不一致

**注意：`build-image.sh --branch=xxx` 完成后会自动清理临时 worktree（trap EXIT）。所以必须手动创建持久化 worktree，不能只依赖 `--branch` 构建。**

**完整灰度流程：**

```bash
# 1. 本地：push 分支到 remote
git push carher feat/xxx

# 2. 服务器：创建持久化 worktree（--detach 不影响主仓库分支）
cd /Data/CarHer
git fetch origin
git worktree add /tmp/xxx-wt origin/feat/xxx --detach

# 3. worktree 内 symlink 配置（gitignored 文件不在 worktree 里）
cd /tmp/xxx-wt
ln -sf /Data/CarHer/docker/server.env docker/server.env
ln -sf /Data/CarHer/docker/users.csv docker/users.csv

# 4. 从 worktree 构建独立镜像（SCRIPT_DIR 指向 worktree）
./build-image.sh --tag=carher:xxx

# 5. 从 worktree 启动容器
A2A_ENABLED=1 ./start-user.sh --id=N --image=carher:xxx           # spoke
A2A_ENABLED=1 A2A_OUTBOUND=1 ./start-user.sh --id=N --image=carher:xxx  # hub

# 6. 验证
docker logs carher-N | grep 'ws client ready'
```

**更新 worktree（有新 commit 时）：**

```bash
cd /tmp/xxx-wt
git fetch origin
git checkout --detach origin/feat/xxx
# 重新 symlink（checkout 可能重置）
ln -sf /Data/CarHer/docker/server.env docker/server.env
ln -sf /Data/CarHer/docker/users.csv docker/users.csv
./build-image.sh --tag=carher:xxx
# 重启需要更新的容器
```

**回滚（用主仓库的 start-user.sh + carher:local）：**

```bash
cd /Data/CarHer && ./start-user.sh --id=N
```

## A2A Hub-Spoke 启动

A2A 通过环境变量控制，有三个级别：

| 级别                | 环境变量                       | 效果                                                            |
| ------------------- | ------------------------------ | --------------------------------------------------------------- |
| **无 A2A**          | (默认)                         | 插件从镜像加载（被动响应 a2a 请求），无 skill                   |
| **Spoke（被动）**   | `A2A_ENABLED=1`                | 安装 a2a 插件 + 通用 skills（不含 ask-other-her），只能被动接收 |
| **Hub（上帝视角）** | `A2A_ENABLED=1 A2A_OUTBOUND=1` | 安装 ask-other-her skill + outbound 权限，可主动调度其他 bot    |

**启动示例：**

```bash
# Spoke（被动接收，大部分容器用这个）
A2A_ENABLED=1 ./start-user.sh --id=N --image=carher:xxx

# Hub（上帝视角，通常只给一个核心容器）
A2A_ENABLED=1 A2A_OUTBOUND=1 ./start-user.sh --id=N --image=carher:xxx

# 无 A2A（插件仍从镜像加载，但无 skill 无 outbound）
./start-user.sh --id=N --image=carher:xxx
```

**注意：**

- `A2A_ENABLED` 和 `A2A_OUTBOUND` 是 `start-user.sh` 的 shell 变量，不传入容器
- 它们控制 skill 复制和 config 注入，在启动时一次性生效
- Hub 容器拥有 ask-other-her skill，可主动通过 a2a 向任何其他 bot 发请求
- Spoke 容器没有 ask-other-her skill，AI 不知道 a2a 存在，只能被动响应

## ACP (Claude Code) 启动

ACP 让 Her 调度 Claude Code 子进程执行代码任务。通过 `CARHER_ACP_ENABLED=1` 按需开启，不影响未开启的容器。

**前提**：server.env 需要有 API 凭证（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`），start-user.sh 自动读取。

```bash
# 开启 ACP（建议 4-8G 内存）
CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=8g ./start-user.sh --id=N --image=carher:xxx

# ACP + A2A Hub（docker-13）
CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=8g A2A_OUTBOUND=1 ./start-user.sh --id=13 --image=carher:xxx

# 无 ACP（默认，零影响）
./start-user.sh --id=N --image=carher:xxx
```

**验证**：`docker logs carher-N | grep "acpx.*ready"`

**已知问题**：

- WebFetch 401：litellm 代理不认 `claude-haiku-4-5-20251001`（带日期后缀），需加别名映射
- `sandbox.enabled: false` 必须设（Docker 内无 bubblewrap），entrypoint 已自动配
- ACP 进程泄漏：监控 `docker exec carher-N ps aux | grep claude | wc -l`

**详细文档**：`docs/her/acp-claude-code-setup.md`

## 安全规则

- **绝不在 skill/文档/git 中写入密码、API Key、飞书 App Secret**
- 密码和密钥仅存在于 `docker/servers.txt`（已 gitignore）和各服务器本地 CSV
- 生产容器操作禁令见 `.cursor/rules/production-containers.mdc`

## 关键文档

| 文档                                           | 内容                                            |
| ---------------------------------------------- | ----------------------------------------------- |
| `docs/her/her-feishu-bot-architecture.md`      | 架构详解（Owner 机制、安全模型、飞书通道）      |
| `docs/her/her-feishu-bot-enterprise-deploy.md` | 部署指南（CSV 字段、步骤、FAQ）                 |
| `docs/her/enterprise-deploy-log.md`            | 部署日志（问题记录、实验结果、待办）            |
| `docker/servers.txt`                           | 服务器凭证（IP、密码、API Key）**本地敏感文件** |
| `docker/users.csv`                             | 本地 Mac 用户表（和服务器独立）                 |
| `start-user.sh`                                | 容器管理脚本（启动、停止、列表）                |
| `.cursor/rules/production-containers.mdc`      | 生产容器操作禁令                                |
| `docs/her/acp-claude-code-setup.md`            | ACP (Claude Code) 开启指南                      |
