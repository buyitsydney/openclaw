---
name: carher-enterprise-ops
description: CarHer 企业 Docker 容器运维操作。Use when the user mentions 董事长, her, docker, 容器, 服务器, server, carher, 健康检查, 重启, restart, 日志, CSV, open_id, owner, pairing, or any enterprise deployment operation.
---

# CarHer 企业容器运维

## ⚠️ 容器身份映射（Mac 本地 vs 服务器 ID 不同！）

**Mac 本地**（`docker/users.csv`）：

- `carher-1` = **测试容器**（卜弋天个人飞书 `cli_a9031535e3fa9cef`）→ 可随意实验
- `carher-3` = **董事长**（`cli_a9054f702c789bd9`）→ 🚫 禁止操作
- `carher-4` = 浏览器测试

**服务器 S1**（10.68.13.186，CSV 在服务器本地）：

- `carher-1` = **董事长老杨**（`cli_a9054f702c789bd9`）→ 🚫 禁止操作
- `carher-12` = 测试容器（卜弋天）
- `carher-13` = **卜弋天个人**（`cli_a917e5525178dbb3`）

**关键区别**：Mac 的 docker1 是测试，服务器的 docker1 是董事长！ID 不同！

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

容器命名：`carher-{id}`（如 id=1 → `carher-1`）

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

| 脚本 | 职责 | 关键参数 |
|------|------|---------|
| `build-image.sh` | 构建 Docker 镜像 | `--tag=NAME`, `--branch=BRANCH`, `--force`, `--check` |
| `start-user.sh` | 启动/管理容器 | `--image=NAME`（默认 `carher:local`） |

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

1. 服务器 CSV 添行（9 列，末尾逗号）→ `./start-user.sh --id=N`
2. 验证容器 config：App ID/Secret、models providers、groups、gateway dangerously\* 配置
3. 确认 WSClient connected
4. 更新本地 Mac `docker/servers.txt` → scp 同步到所有服务器
5. 通知 IT：配置长连接 → 添加事件 `im.message.receive_v1` → 第二次发布
6. 用户首次对话后：从 session 日志提取 open_id → 更新 CSV → 重建（先检查活跃！）→ 验证 `dm.allowFrom`

### 群聊 vs 单聊判断

- CSV 备注含"共用"/"运营部" → 群聊，用 `owner_allow_from`
- session unique senders = 1 → 单聊，用 `feishu_owner_open_id`
- session unique senders >> 1 → 群聊或被拉群，需确认

## Admin Her（原生进程，非 Docker）

S1 上有一个**原生 Admin Her**，不是 Docker 容器：

- 配置文件：`~/.openclaw/openclaw.json`（S1 上）
- 运行方式：tmux session `admin-her`，`node dist/index.js gateway run --port 18789 --bind lan --force`
- **不要**用 `start-user.sh` 管理，不要在 `users.csv` 中添加 Admin Her 行
- 修改配置后需要重启：先 `tmux kill-session -t admin-her`，再重新创建 tmux session 启动

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
