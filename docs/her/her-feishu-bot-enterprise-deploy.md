# 企业全员 Her 部署架构设计

## 背景

基于 Car Her 的成功验证，将 AI 助手从个人使用扩展到企业全员（200+ 人）。
每位员工通过飞书获得专属 AI 助手，拥有独立的对话历史、工作空间和长期记忆，完全隔离。

**最终方案：200 Bot + 200 Docker（每人一个独立 OpenClaw 容器）**

**验证状态 (2026-02-09)：飞书并发测试通过、数据隔离已确认、Webchat 隔离已确认、自动镜像重建已实现**

---

## 部署前置条件

> **在创建任何飞书 Bot 之前，以下所有条件必须全部就绪。**

### 硬件采购

| 项目 | 最低配置（200 人文字） | 推荐配置（200 人文字 + 语音） |
|------|----------------------|---------------------------|
| 服务器 | 1 台：16 核 CPU、64GB RAM、500GB SSD | 2-4 台：各 8 核 CPU、32GB RAM、500GB SSD |
| 网络 | 公网出口（容器需访问飞书 API + OpenRouter API） | 同左 |
| 操作系统 | Ubuntu 22.04+ / Debian 12+ | 同左 |

> 每容器约 200MB RAM，200 容器合计约 40GB。CPU 负载极低（AI 推理在云端），16 核足够。

### 软件环境（服务器上安装）

| 软件 | 安装命令 | 用途 |
|------|---------|------|
| Docker | `curl -fsSL https://get.docker.com \| sh` | 容器运行环境 |
| Git | `apt install git` | 拉取部署代码 |
| Python 3 | `apt install python3` | 配置生成脚本依赖 |
| cloudflared | `curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \| tee /usr/share/keyrings/cloudflare.gpg && apt install cloudflared` | 远程隧道（可选，仅远程访问时需要） |

### 账号与密钥（P0，必须提前申请）

| # | 项目 | 获取方式 | 说明 |
|---|------|---------|------|
| 1 | **OpenRouter API Key** | 注册 [openrouter.ai](https://openrouter.ai) → Keys → Create Key | **最核心依赖，没有它 AI 完全不能工作。** 一个 key 可供所有 200 容器共用。充值建议：先充 $50 测试，正式运行按 ~$1,500/月预算 |
| 2 | **Google Cloud 凭证** | 注册 Google Cloud → 启用 Vertex AI API → `gcloud auth application-default login` | 语音功能（Gemini Live）依赖。即使暂时只用文字，脚本也需要此凭证文件存在（`~/.config/gcloud/application_default_credentials.json`） |
| 3 | **飞书管理员账号** | 企业飞书管理后台 → 确认有「创建自建应用」权限 | 后续创建 200 个 Bot 需要此权限 |

### 代码部署

```bash
# 1. 克隆仓库
git clone https://github.com/your-org/carher.git
cd carher

# 2. 设置 OpenRouter API Key（写入 shell 配置，所有终端生效）
echo 'export OPENROUTER_API_KEY=sk-or-v1-你的key' >> ~/.bashrc
source ~/.bashrc

# 3. 设置 Google Cloud 凭证（按提示在浏览器登录）
gcloud auth application-default login

# 4. 首次构建 Docker 镜像（约 5-10 分钟，后续自动检测变更）
./start-user.sh --id=1 --local
# 脚本会自动构建镜像，看到 "✓ 容器已启动" 即成功
# 首次启动后 Ctrl+C 停止，进入下一步创建飞书 Bot
./start-user.sh --id=1 --down
```

> **检查清单**：运行 `./start-user.sh --id=1 --local`，如果看到 `✓ Docker 镜像已是最新` + `✓ OpenRouter API key` + `✓ Google Cloud 凭证` + `✓ 容器已启动`，说明环境 100% 就绪。

---

## 方案选择

| 方案 | 结论 | 放弃原因 |
|------|------|---------|
| per-peer 模式 | 不可用 | 仅隔离对话历史，不隔离记忆文件（MEMORY.md 共享），隐私不可接受 |
| 单 Gateway + Multi-Agent + Sandbox | 有重大风险 | 单点故障（200 人全断）、升级必须停机、已知稳定性 bug（GitHub #1997）、非 OpenClaw 设计目标 |
| 4 Bot + 4 Docker（Multi-Agent 分片） | 可行但复杂 | 每容器 50 人仍需 Multi-Agent + Sandbox，配置复杂度高 |
| **200 Bot + 200 Docker** | **最终方案** | 完全符合 OpenClaw "1 用户 = 1 实例" 设计哲学，阿里云托管服务底层相同 |

```
飞书 Bot-001 (张三) → Docker 容器 001 (标准单用户 OpenClaw)
飞书 Bot-002 (李四) → Docker 容器 002 (标准单用户 OpenClaw)
...
飞书 Bot-200 (王五) → Docker 容器 200 (标准单用户 OpenClaw)
```

**核心优势**：Docker OS 级隔离、零单点故障（1 容器崩只影响 1 人）、滚动升级（每次只影响 1 人 2-3 秒）、每容器配置极简（标准单用户 OpenClaw + 飞书插件）、不需要 Sandbox/Multi-Agent/binding。

**唯一代价**：IT 手动创建 200 个飞书 Bot（~50 小时，5 人 IT 团队 2 个工作日）。飞书没有 API 创建 Bot，这是不可避免的。

---

## 架构详情

### 整体架构图

```
公司全员（200+ 人）
  │
  │ 每人 DM 自己的专属飞书 Bot
  ↓
飞书开放平台
  │
  │ 200 条独立 WebSocket 长连接
  ↓
云服务器集群
├── Docker 容器 001 (张三)
│   ├── OpenClaw Gateway (标准单用户配置)
│   ├── 飞书插件 ← Bot-001 的 WebSocket 长连接
│   ├── workspace/
│   │   ├── MEMORY.md (张三的专属记忆)
│   │   ├── USER.md   (张三的专属画像)
│   │   └── SOUL.md   (张三的专属人格)
│   └── sessions/ (张三的对话历史)
│
├── Docker 容器 002 (李四)
│   ├── OpenClaw Gateway (标准单用户配置)
│   ├── 飞书插件 ← Bot-002 的 WebSocket 长连接
│   └── ... (完全独立的文件系统)
│
└── ... 200 个容器，完全物理隔离
```

### 每容器配置

每个容器的配置极简，就是标准的**单用户 OpenClaw + 飞书插件**：

```json
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "lan",
    "auth": { "mode": "token", "token": "carher-container-token" },
    "controlUi": { "dangerouslyDisableDeviceAuth": true }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "openrouter/anthropic/claude-sonnet-4" }
    }
  },
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": false
  },
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_该员工Bot的AppID",
      "appSecret": "该员工Bot的AppSecret",
      "dm": {
        "allowFrom": ["ou_该员工的open_id"]
      },
      "groups": {
        "enabled": true,
        "archive": true
      }
    }
  },
  "plugins": {
    "entries": {
      "feishu": { "enabled": true }
    }
  }
}
```

> **注意事项**：
> - 上述配置由 `start-user.sh` 从 `docker/users.csv` 自动生成，IT 无需手动编写
> - `dm.allowFrom` 限制只有主人能与 bot 单聊（其他人发消息会被忽略）
> - `groups.enabled` + `groups.archive` 默认启用群聊归档，主人可在私聊让 bot 总结群聊内容
> - `nativeSkills: "auto"` 必须配置，否则 AI 只能看到少数无依赖的 skill
> - `controlUi.dangerouslyDisableDeviceAuth: true` 跳过设备配对，允许 token 直接访问 Webchat
> - 飞书插件在用户发送 `/new` 时自动发送 Webchat URL（从 gateway 配置自动计算，Docker 模式下可通过 `WEBCHAT_URL` 环境变量覆盖）

### Docker 部署

#### docker-compose.yml 模板

```yaml
# 每个员工一个 service，共用同一个镜像
services:
  emp-001:
    image: carher:local
    container_name: enterprise-001
    init: true
    restart: always
    environment:
      HOME: /data
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
    ports:
      - "39001:18789"    # Gateway / Webchat
    volumes:
      - enterprise-001-data:/data/.openclaw
      - ./config/emp-001.json:/data/.openclaw/openclaw.json:ro
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
    # 无需指定 command，Dockerfile 默认 CMD=["/entrypoint.sh"]

  # ... 由 start-user.sh 自动管理，无需手写 docker-compose

volumes:
  enterprise-001-data:
  # ... 200 个 named volume
```

#### 目录结构

```
enterprise-deploy/
├── docker-compose.yml          ← 200 个 service 定义（脚本生成）
├── config/
│   ├── emp-001.json            ← 张三的配置（含 Bot-001 凭证）
│   ├── emp-002.json            ← 李四的配置（含 Bot-002 凭证）
│   └── ...
└── scripts/
    ├── generate-compose.sh     ← 生成 docker-compose.yml
    ├── add-employee.sh         ← 入职：创建配置 + 启动容器
    └── remove-employee.sh      ← 离职：停止容器 + 归档数据
```

### 升级/回滚

```bash
# 重新构建镜像（不影响线上，旧容器继续运行）
docker build -f Dockerfile.carher -t carher:v2026.2.10 .
docker tag carher:v2026.2.10 carher:local

# 滚动重启（每次只影响 1 人 2-3 秒）
for i in $(seq 1 200); do
  id=$(printf "emp-%03d" $i)
  docker-compose up -d --no-deps "$id"
  sleep 10
done

# 回滚（秒级，切换镜像 tag）
docker tag carher:v旧版本 carher:local
docker-compose up -d --no-deps emp-001
```

---

## IT 操作流程

### 创建飞书 Bot（IT 操作清单）

每个 Bot 约 15-20 分钟。**整个流程分三个阶段，IT 和部署者需要配合完成。** 飞书的"长连接"模式要求服务端先启动，IT 才能保存事件订阅配置。

#### 快速 Checklist（批量创建时看这里）

> 第 2 个 Bot 起就不用看下面的详细步骤了，对照这个表即可。

| # | 操作 | 要点 |
|---|------|------|
| 1 | 创建自建应用 + 启用机器人 | open.feishu.cn → 创建应用 → 添加「机器人」能力 |
| 2 | 记录凭证 | 凭证与基础信息 → 复制 App ID + App Secret |
| 3 | 开通 7 个权限 | 权限管理 → 搜索开通：`im:message`、`im:message:send_as_bot`、`im:resource`、`im:message.group_msg`、`im:message.p2p_msg:readonly`、`im:chat:readonly`、`cardkit:card:write` |
| 4 | 交给部署者，等通知 | 部署者启动容器，确认 `Feishu WSClient connected` 后通知你 |
| 5 | 配置事件订阅 | 事件与回调 → 订阅方式选「长连接」→ 保存 → 添加 `im.message.receive_v1` |
| 6 | 发布 | 版本管理 → 创建版本 → 设置可用范围 → 发布 |

#### 阶段 A：IT 创建应用（独立完成，约 10 分钟）

**步骤 1：创建自建应用**

1. 打开 [飞书开放平台](https://open.feishu.cn)，登录管理员账号
2. 点击左上角「创建应用」→「自建应用」
3. 填写应用名称和描述，点击「创建」

**步骤 2：启用机器人能力**

1. 左侧菜单点击「添加应用能力」→ 找到「机器人」→「添加」

**步骤 3：获取凭证**

1. 左侧菜单点击「凭证与基础信息」
2. 记录 **App ID**（`cli_xxx`）和 **App Secret**（妥善保管）

**步骤 4：添加权限**

左侧菜单「权限管理」→「API 权限」，搜索并开通以下 7 个权限：

| 搜索关键词 | 权限名称 | 用途 |
|-----------|---------|------|
| `im:message` | 获取与发送单聊、群组消息 | 接收用户消息 |
| `im:message:send_as_bot` | 以应用的身份发消息 | 机器人回复 |
| `im:resource` | 获取与上传图片或文件资源 | 收发图片 |
| `im:message.group_msg` | 获取群组中所有消息（敏感权限） | 群聊归档（接收所有群消息） |
| `im:message.p2p_msg:readonly` | 读取用户发给机器人的单聊消息 | 单聊消息读取 |
| `im:chat:readonly` | 获取群组信息 | 获取群名（归档索引用） |
| `cardkit:card:write` | 创建与更新卡片 | AI 流式回复（打字机效果） |

> 群聊归档默认启用。Her 静默监听群消息并归档到本地，主人可在私聊中随时让 Her 总结群聊内容。

**步骤 5：将凭证交给部署者**

通过安全渠道（当面、加密消息）提供 App ID + App Secret，告知部署者先启动服务，完成后通知 IT 继续。

#### 阶段 B：部署者启动服务（IT 等待）

部署者收到 App ID + App Secret 后：

1. 编辑 `docker/users.csv`，新增一行：`N,董事长,sonnet,cli_xxx,secret_xxx,,董事长专属Bot`
2. 运行 `./start-user.sh --id=N --local`
3. 确认日志出现 `Feishu WSClient connected` 后通知 IT 继续

#### 阶段 C：IT 配置事件订阅 + 发布（约 5 分钟）

**步骤 6：配置事件订阅**

1. 飞书开放平台 → 你的应用 →「事件与回调」→「事件配置」
2. 订阅方式选 **"使用 长连接 接收事件"** → **保存**
3. 添加事件：搜索 `im.message.receive_v1`（接收消息 v2.0）→ 添加

> 保存失败 = 服务未启动。让部署者确认 `Feishu WSClient connected` 已出现。

**步骤 7：发布**

1. 「应用发布」→「版本管理与发布」→「创建版本」
2. 设置可用范围（建议先选指定人员测试）→ 提交发布

**步骤 8：验证**

在飞书搜索机器人名称 → 打开私聊 → 发消息 → 确认 AI 回复。

> 搜索到但没有对话框？确认事件订阅已保存 + 已创建新版本并发布。

**步骤 9：记录用户 open_id（用于单聊白名单和群聊主人识别）**

员工第一次给 Bot 发消息后：

1. 部署者查看日志：`./start-user.sh --id=N --logs`，搜索 `from=ou_`，记录完整的 `ou_xxx` 值
2. 编辑 `docker/users.csv`，将 `ou_xxx` 填入该用户行的 `feishu_owner_open_id` 列
3. 重启容器：`./start-user.sh --id=N --local`，白名单即刻生效

#### 飞书 Bot 常见问题

| 问题 | 答案 |
|------|------|
| 创建应用要付费吗？ | 不需要，飞书自建应用完全免费 |
| 需要备案域名或公网 IP 吗？ | 不需要，长连接模式无需网络配置 |
| 为什么事件订阅保存失败？ | 服务端未启动，确认日志有 `Feishu WSClient connected` |
| 搜索到机器人但没有对话框？ | 事件订阅未配置或未包含在已发布版本中 |

### 员工生命周期

| 事件 | IT 操作 | 部署者操作 | 对其他员工影响 |
|------|--------|-----------|-------------|
| 新员工入职 | 创建 1 个飞书 Bot（15 分钟） | 生成配置 + 启动 1 个容器 | **零影响** |
| 员工离职 | 注销飞书账号 + 删除 Bot | 停止并删除该容器 | **零影响** |

### 用户管理

用户凭证集中管理在 `docker/users.csv`（已加入 .gitignore 不入库）：

```csv
# id, 姓名, 模型, feishu_app_id, feishu_app_secret, feishu_owner_open_id, 备注
1,张三,sonnet,cli_aaa111,secret111,ou_xxx111,测试用户
2,厂商A,opus,,,,"厂商演示（无飞书）"
3,王五,sonnet,cli_bbb222,secret222,ou_xxx222,
```

| 字段 | 说明 |
|------|------|
| `id` | 用户编号（1-999） |
| `姓名` | 显示名 |
| `模型` | AI 模型（留空用默认 sonnet） |
| `feishu_app_id` | 飞书 Bot 的 App ID（留空不启用飞书） |
| `feishu_app_secret` | 飞书 Bot 的 App Secret |
| `feishu_owner_open_id` | 用户的飞书 open_id（`ou_xxx`），用于单聊白名单 + 群聊主人识别 |
| `备注` | 备注信息 |

`feishu_owner_open_id` 获取方法：用户给 Bot 发一条消息，从容器日志中找 `from=ou_xxx`。

`start-user.sh` 从 CSV 自动生成完整配置，包括：
- 飞书通道 + 插件启用
- `dm.allowFrom`（单聊白名单 = 主人身份）
- `groups.enabled` + `groups.archive`（群聊归档，默认启用）

```bash
./start-user.sh --id=1               # 模型和飞书凭证从 CSV 自动读取
./start-user.sh --id=1 --model=opus  # CLI --model 覆盖 CSV 设置
./start-user.sh --id=1 --local       # 仅本地访问（不开隧道）
./start-user.sh --id=1 --down        # 停止容器
./start-user.sh --list               # 列出所有用户和容器状态
```

> `start-user.sh` 自动检测代码变更并重建镜像，无需手动操作。`--no-rebuild` 可跳过。

---

## 各通道能力

| 通道 | 状态 | 说明 |
|------|------|------|
| 飞书 | **可用** | 每人专属 Bot + 独立容器，已验证 |
| Webchat | **可用** | 每容器独立 Webchat（各自端口），已验证 |
| Telegram | 可用 | 同飞书，每容器可额外配 Telegram Bot |
| 语音 (realtime) | 待开发 | 需加用户认证；Google Cloud 凭证已在前置条件中配置 |

---

## 费用估算（200 人规模）

| 项目 | 假设 | 月费用 |
|------|------|--------|
| 飞书文字（Claude Sonnet via OpenRouter） | 每人 50 条/天，$0.005/条 | ~$1,500 |
| 语音（Gemini Live, 20% 活跃） | 40 人 x 30 分/天，$0.04/分 | ~$1,440 |
| 服务器（仅文字） | 1 台 16核 64G 或 4 台 4核 16G | ~$200-500 |

> 每容器约 200MB RAM，200 容器约 40GB。降低成本：选更便宜的模型（Haiku/Flash）或设每日用量上限。

| 方案 | 月费用 |
|------|--------|
| 仅飞书文字 | ~$1,700-2,000 |
| 飞书 + 语音 | ~$3,000-7,000 |

---

## 总结

| 维度 | 方案 |
|------|------|
| 架构 | **200 Bot + 200 Docker**：每人 1 个飞书 Bot + 1 个 Docker 容器 |
| 每容器配置 | **标准单用户 OpenClaw**（默认配置 + 飞书插件凭证），无 Multi-Agent/binding/sandbox |
| 隔离 | **Docker OS 级**：独立文件系统、进程空间、网络 |
| 单点故障 | **无**：1 容器崩只影响 1 人 |
| 升级 | **滚动升级**：逐容器重启，每次只影响 1 人 2-3 秒 |
| 代码修改 | **零**（纯配置 + Docker），与上游零冲突 |
| 飞书 Bot | IT 手动创建（无 API，~50 小时一次性工作） |
| 月费用 | ~$2,000-7,000（取决于模型和语音使用量） |
