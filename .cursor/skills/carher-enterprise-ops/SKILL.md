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

```bash
sshpass -p 'PWD' ssh USER@IP "cd /Data/CarHer && ./start-user.sh --id=N 2>&1 | tail -5"
```

重建会自动执行：

- 镜像更新（检测代码变更）
- `fix-device-pairing.js`（修复设备配对 scopes）
- 从 CSV 生成 `openclaw.json`（含 Owner 配置）

### 代码更新（必须走 git 标准流程！）

```bash
# 1. 本地提交（等用户确认后）
git add <changed-files>
git commit -m "描述"

# 2. 推送到远程
git push --no-verify

# 3. 各服务器 pull
sshpass -p 'PWD' ssh USER@IP "cd /Data/CarHer && git pull"

# 4. 需要时重建相关容器
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

**唯一例外：** 服务器本地的 `users.csv`（含密钥，不在 git 中）可直接 `sed` 编辑。

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
