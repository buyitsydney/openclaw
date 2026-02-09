# 企业全员 Her 部署架构设计

## 背景

基于 Car Her 的成功验证，将 AI 助手从个人使用扩展到企业全员（200+ 人）。
每位员工通过飞书获得专属 AI 助手，拥有独立的对话历史、工作空间和长期记忆，完全隔离。

**最终方案：200 Bot + 200 Docker（每人一个独立 OpenClaw 容器）**

**验证状态 (2026-02-09)：飞书并发测试通过、数据隔离已确认、Webchat 隔离已确认**

---

## 方案探索与最终选择

### 探索过的方案

| 方案 | 结论 | 放弃原因 |
|------|------|---------|
| per-peer 模式 | 不可用 | 仅隔离对话历史，不隔离记忆文件（MEMORY.md 共享），隐私不可接受 |
| 单 Gateway + Multi-Agent + Sandbox | 有重大风险 | 单点故障（200 人全断）、升级必须停机、已知稳定性 bug（GitHub #1997）、非 OpenClaw 设计目标 |
| 4 Bot + 4 Docker（Multi-Agent 分片） | 可行但复杂 | 每容器 50 人仍需 Multi-Agent + Sandbox，配置复杂度高 |
| 1 Bot + 路由代理 | 不推荐 | 路由代理本身是新的单点故障 |

### 最终方案：200 Bot + 200 Docker

```
飞书 Bot-001 (张三) → Docker 容器 001 (标准单用户 OpenClaw)
飞书 Bot-002 (李四) → Docker 容器 002 (标准单用户 OpenClaw)
...
飞书 Bot-200 (王五) → Docker 容器 200 (标准单用户 OpenClaw)
```

**选择理由：**

1. **完全符合 OpenClaw 设计哲学**：OpenClaw 的核心是"1 用户 = 1 实例"。每个容器用默认配置，不需要 Multi-Agent、binding、sandbox 等高级功能。
2. **阿里云验证**：阿里云 OpenClaw 托管服务的底层就是"每用户独立实例"。
3. **最强隔离**：Docker OS 级隔离，独立文件系统、进程空间、网络命名空间。
4. **零单点故障**：1 容器崩只影响 1 人，其他 199 人无感。
5. **滚动升级无影响**：逐个容器重启，每次只影响 1 人 2-3 秒。
6. **每容器配置极简**：标准单用户 OpenClaw + 飞书插件，和个人 Her 的配置几乎相同。
7. **不引入额外复杂度**：不需要 Sandbox（Docker 本身就是隔离）、不需要 Multi-Agent Routing、不需要 binding。
8. **已验证可行**：现有 `start-user.sh` 已在运行多个 Docker 容器，架构相同。

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
    "auth": { "mode": "token", "token": "该员工的随机token" },
    "controlUi": { "dangerouslyDisableDeviceAuth": true },
    "webchatUrl": "http://server:29001?token=该员工的随机token"
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
  "dm": { "policy": "open" },
  "channels": {
    "feishu": { "enabled": true }
  },
  "plugins": {
    "entries": {
      "feishu": {
        "enabled": true,
        "config": {
          "appId": "cli_该员工Bot的AppID",
          "appSecret": "该员工Bot的AppSecret"
        }
      }
    }
  }
}
```

**关键：没有 `agents.list`、没有 `bindings`、没有 `sandbox`。** 就是默认的单用户 OpenClaw 配置加上飞书插件凭证。与个人 Her 的配置结构相同。

> **注意事项**：
> - `nativeSkills: "auto"` 必须配置，否则 AI 只能看到少数无依赖的 skill
> - `controlUi.dangerouslyDisableDeviceAuth: true` 跳过设备配对，允许 token 直接访问 Webchat
> - `webchatUrl` 由 `start-user.sh` 自动生成（含 host + port + token），飞书插件在用户首次消息时发送欢迎链接

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
      - "39001:18789"    # Gateway
    volumes:
      - enterprise-001-data:/data/.openclaw
      - ./config/emp-001.json:/data/.openclaw/openclaw.json:ro
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
    command: ["node", "/app/dist/index.js", "gateway", "run", "--port", "18789", "--force", "--bind", "lan"]

  emp-002:
    image: carher:local
    container_name: enterprise-002
    init: true
    restart: always
    environment:
      HOME: /data
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
    ports:
      - "39002:18789"
    volumes:
      - enterprise-002-data:/data/.openclaw
      - ./config/emp-002.json:/data/.openclaw/openclaw.json:ro
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
    command: ["node", "/app/dist/index.js", "gateway", "run", "--port", "18789", "--force", "--bind", "lan"]

  # ... 由管理脚本自动生成 200 个 service

volumes:
  enterprise-001-data:
  enterprise-002-data:
  # ... 200 个 named volume
```

> 注意：Phase 1 只启动文字 Gateway，不启动 Python 语音代理。因此用 `command` 覆盖默认的 `carher-entrypoint.sh`（后者会同时启动语音代理）。

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

### 升级/回滚工作流

```bash
# === 拉取上游更新（不影响线上） ===
cd /path/to/CarHer
git pull origin main

# === 重新构建镜像（不影响线上，旧容器继续运行） ===
docker build -f Dockerfile.carher -t carher:v2026.2.10 .
docker tag carher:v2026.2.10 carher:local

# === 滚动重启（每次只影响 1 人 2-3 秒） ===
for i in $(seq 1 200); do
  id=$(printf "emp-%03d" $i)
  docker-compose up -d --no-deps "$id"
  sleep 10  # 等启动完成
  echo "$id 已升级"
done

# === 回滚（秒级，切换镜像 tag） ===
docker tag carher:v旧版本 carher:local
docker-compose up -d --no-deps emp-001  # 回滚单个容器
```

---

## IT 操作流程

### 创建飞书 Bot（一次性，每员工 1 个）

详见 [IT 操作清单](feishu-it-guide.md)。每个 Bot 约 15 分钟创建。

核心步骤（三阶段流程，IT 和部署者配合）：
1. **阶段 A（IT）**：创建自建应用 → 添加"机器人"能力 → 添加权限（`im:message` + `im:message:send_as_bot` + `im:resource`）→ 记录 App ID + App Secret → 交给部署者
2. **阶段 B（部署者）**：在 `docker/users.csv` 登记凭证 → 运行 `start-user.sh` 启动容器 → 确认日志 `Feishu WSClient connected` → 通知 IT
3. **阶段 C（IT）**：事件订阅选"长连接" → 保存 → 添加 `im.message.receive_v1` → 发布应用

> 为什么分三阶段？飞书的"长连接"模式要求 SDK 已在线才能保存配置。必须先启动服务（阶段 B），IT 才能完成事件订阅（阶段 C）。

### 员工生命周期

| 事件 | IT 操作 | 部署者操作 | 对其他员工影响 |
|------|--------|-----------|-------------|
| 新员工入职 | 开通飞书账号 + **创建 1 个飞书 Bot**（15 分钟） | 生成配置 + 启动 1 个容器 | **零影响** |
| 员工日常使用 | 无 | 无 | - |
| 员工离职 | 注销飞书账号 + 删除 Bot | 停止并删除该容器 | **零影响** |
| 清理离职数据 | 无 | 可选：删除容器数据卷 | - |

### 用户管理（已实现）

用户凭证集中管理在 `docker/users.csv`（IT 维护，已加入 .gitignore 不入库）：

```csv
# id, 姓名, 模型, feishu_app_id, feishu_app_secret, 备注
1,张三,sonnet,cli_aaa111,secret111,测试用户
2,厂商A,opus,,,厂商演示（无飞书）
3,王五,sonnet,cli_bbb222,secret222,
```

启动和管理命令：

```bash
./start-user.sh --id=1               # 模型和飞书凭证从 CSV 自动读取
./start-user.sh --id=1 --model=opus  # CLI --model 覆盖 CSV 设置
./start-user.sh --id=1 --down        # 停止容器
./start-user.sh --list               # 列出所有用户和容器状态
./start-user.sh --id=1 --sync-workspace  # 同步 docker/workspace/ 到容器
```

> **Workspace 模板**：`docker/workspace/` 下的文件会在容器启动时自动同步到 `/data/.openclaw/workspace/`。TOOLS.md 模板默认为空（企业员工不需要个人设备配置）。

---

## 各通道能力

| 通道 | 企业就绪 | 说明 |
|------|---------|------|
| 飞书 | **Phase 1 可用** | 每人专属 Bot + 独立容器，天然隔离。已验证 |
| Telegram | Phase 1 可用 | 同飞书，每容器可额外配 Telegram Bot |
| Webchat | **Phase 1 可用** | 每容器有独立 Webchat（各自端口），天然隔离。已验证 |
| 语音 (realtime) | Phase 2 | 需加用户认证 + Google Cloud 凭证 |

---

## 费用估算（200 人规模）

### LLM API 费用（主要成本，占 60-80%）

| 项目 | 假设 | 月费用 |
|------|------|--------|
| 飞书文字（Claude Sonnet via OpenRouter） | 每人 50 条/天，$0.005/条 | ~$1,500 |
| 语音（Gemini Live, 20% 活跃） | 40 人 x 30 分/天，$0.04/分 | ~$1,440 |

### 服务器费用

| 配置 | 规格 | 月费用 |
|------|------|--------|
| 仅飞书文字 | 1 台 16核 64G 或 4 台 4核 16G | ~$200-500 |
| 飞书 + 语音 | 多台分布式 | ~$500-2,500 |

> 每容器约 200MB RAM，200 容器约 40GB。降低成本：选更便宜的模型（Haiku/Flash）或设每日用量上限。

### 总计

| 方案 | 月费用 |
|------|--------|
| 仅飞书文字 | ~$1,700-2,000 |
| 飞书 + 语音 | ~$3,000-7,000 |

---

## 测试验证方案

### 零影响保证

测试利用现有 carher-1 或 carher-3 容器（非厂商，可自由操作），**不影响**：
- 个人 Her（start.sh，端口 18789）
- carher-2（厂商用户，不动）
- carher-4（保持不动）
- 源代码（不做任何修改）

### 测试步骤

**Step 1**：创建 1 个测试飞书 Bot（模拟 IT 操作）
- 在 https://open.feishu.cn/app 创建新的自建应用
- 添加机器人能力 + 事件订阅
- 记录 App ID + App Secret

**Step 2**：创建测试配置文件
```bash
cat > /tmp/enterprise-feishu-test.json << 'EOF'
{
  "gateway": { "port": 18789, "mode": "local", "bind": "lan",
    "auth": { "mode": "token", "token": "enterprise-test-token" }
  },
  "agents": { "defaults": { "model": { "primary": "openrouter/anthropic/claude-sonnet-4" } } },
  "dm": { "policy": "open" },
  "channels": { "feishu": { "enabled": true } },
  "plugins": { "entries": { "feishu": { "enabled": true,
    "config": { "appId": "测试Bot的AppID", "appSecret": "测试Bot的AppSecret" }
  } } }
}
EOF
```

**Step 3**：停止 carher-1 并用飞书配置重启
```bash
# 停止 carher-1（非厂商，安全）
./start-user.sh --id=1 --down

# 用飞书测试配置启动（复用 carher-1 的端口）
docker run -d \
  --name carher-1 \
  --init \
  -e HOME=/data \
  -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  -p 29001:18789 \
  -v carher-1-feishu-test:/data/.openclaw \
  -v /tmp/enterprise-feishu-test.json:/data/.openclaw/openclaw.json:ro \
  carher:local \
  node /app/dist/index.js gateway run --port 18789 --force --bind lan
```

**Step 4**：验证
- 在飞书中搜索并添加测试 Bot
- 发送"你好"
- 确认 AI 正常回复
- 查看日志：`docker logs carher-1`

**Step 5**：确认其他环境无影响
- 从飞书给**个人 Her Bot**发消息 → 正常回复
- `docker ps` 确认 carher-2/4/user1 正常运行

**Step 6**：恢复
```bash
# 停止测试容器
docker stop carher-1 && docker rm carher-1

# 清理测试数据卷
docker volume rm carher-1-feishu-test

# 恢复原始 carher-1
./start-user.sh --id=1 --random
```

### 已完成的验证（2026-02-09）

以下测试全部通过，方案 C 的核心技术路径已确认可行：

| 验证项 | 结果 | 详情 |
|--------|------|------|
| 飞书 Bot 在 Docker 容器正常工作 | PASS | carher-1 连接飞书 WSClient，收发消息无错误 |
| 数据卷隔离 | PASS | 每容器独立 Docker named volume，互不可见 |
| 端口隔离 | PASS | 每容器映射到不同主机端口，无冲突 |
| 飞书路由隔离 | PASS | 不同 Bot、不同 chat ID、消息各走各的通道 |
| 并发测试 | PASS | 本地 Her 和 carher-1 同时收消息（间隔 7 秒），各自独立处理，0 错误 |
| Webchat 隔离 | PASS | 每容器独立 webchat，Mac webchat 看不到 Docker 容器的对话 |
| nativeSkills 加载 | PASS | 配置 `nativeSkills: "auto"` 后，4 个无依赖 skill 正常注入 AI prompt |
| 镜像重建后 skill 更新 | PASS | 重建镜像后新增 skill（twitter-monitor）立即可用 |

### Webchat 端口分配（每容器独立）

Webchat（OpenClaw Control UI）与 Gateway 共用同一端口（容器内 18789）。每个容器的 Webchat URL：

```
carher-1: http://localhost:29001?token=carher-container-token  (Gateway/Webchat)
carher-2: http://localhost:29011?token=carher-container-token  (Gateway/Webchat)
carher-3: http://localhost:29021?token=carher-container-token  (Gateway/Webchat)
carher-N: 端口公式: 29000 + (N-1)*10 + 1
```

> **注意**：Webchat 需要 token 认证。`start-user.sh` 会自动生成带 token 的完整 URL（`gateway.webchatUrl`），并通过飞书欢迎消息推送给用户。

**需要的配置**（已加入 `docker/carher-config.json`）：
- `gateway.controlUi.dangerouslyDisableDeviceAuth: true` — 跳过设备配对，token 认证即可
- `gateway.webchatUrl` — 由 `start-user.sh` 自动注入，飞书插件在首次对话时发送给用户

> Mac 上的 Webchat 只连接本地 Her（port 18789），看不到任何 Docker 容器的对话——这是隔离正确的表现。

### 端口完整映射

| 端口偏移 | 用途 | 容器内端口 | carher-1 主机端口 |
|----------|------|-----------|------------------|
| +1 | Gateway / Webchat | 18789 | 29001 |
| +2 | Realtime WebSocket | 18790 | 29002 |
| +3 | CarHer 语音前端 | 8000 | 29003 |
| +4 | WS Proxy | 8080 | 29004 |

---

## 部署代码来源

### CarHer Fork vs 官方 npm

飞书插件（`extensions/feishu/`）和实时语音插件（`extensions/realtime/`）是自主开发的代码，**不在官方 OpenClaw npm 包中**。

```
git remote -v
  origin   https://github.com/openclaw/openclaw       ← 官方仓库
  carher   https://github.com/buyitsydney/CarHer.git   ← 自有 fork

git log --oneline origin/main -- extensions/feishu/    → 空（官方没有）
git log --oneline origin/main -- extensions/realtime/  → 空（官方没有）
```

自有代码清单（相比 origin/main 新增 67 个文件，+15,785 行）：

| 类别 | 文件 | 说明 |
|------|------|------|
| 飞书插件 | `extensions/feishu/` | 飞书 WebSocket 长连接通道 |
| 语音插件 | `extensions/realtime/` | Gemini Live 语音 + Python 代理 + 前端 |
| 部署脚本 | `start.sh`, `start-docker.sh`, `start-user.sh` | 启动和容器管理 |
| Docker | `Dockerfile.carher`, `scripts/carher-entrypoint.sh` | 容器化 |
| 文档 | `docs/her/` | 架构、指南、成本分析 |

### 部署方式

**企业部署使用 Docker 镜像**。在云服务器上：

```bash
git clone https://github.com/buyitsydney/CarHer.git
cd CarHer
docker build -f Dockerfile.carher -t carher:local .
# 然后用 docker-compose 启动 200 个容器
```

### 与上游保持同步

CarHer fork 定期从 origin/main 拉取更新。自有代码全部在独立目录中，与上游代码**零冲突**，可安全 `git pull origin main`。

---

## 分阶段落地

### Phase 0：当前状态（已完成并验证）

- 个人 Mac 运行 Her（start.sh）
- Docker 容器隔离厂商用户（start-user.sh）
- 支持 < 10 人
- 飞书 Bot 在 Docker 容器中已验证可用
- 并发消息处理已验证通过
- 数据/端口/飞书路由/Webchat 隔离已全部确认

### Phase 1：企业飞书文字助手

- 目标：全员通过飞书使用 AI 助手，每人独立容器
- 工作量：IT 创建 Bot ~6 工作日 + 技术部署 2-3 天
- 步骤：
  1. IT 创建 200 个飞书 Bot（可分 2 周完成，每个 15 分钟）
  2. 采购云服务器（16核 64G 或多台小机器）
  3. 从 CarHer 仓库构建 Docker 镜像
  4. 编写管理脚本，生成 200 份配置 + docker-compose.yml
  5. `docker-compose up -d` 启动全部容器
  6. IT 通知每位员工添加自己的专属 Bot

### Phase 2：多通道 + 语音

- 目标：语音能力
- 步骤：在每个容器中额外启动 Python Gemini Live 代理，添加用户认证

### Phase 3：生产化

- 管理脚本 CLI 化（自动化入职/离职）
- 监控和告警
- 自动备份
- 多台服务器分布式部署

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
| 设计一致性 | **完全符合 OpenClaw "1 用户 = 1 实例"**，与阿里云方案一致 |
| 月费用 | ~$2,000-7,000（取决于模型和语音使用量） |
| 与个人 Her | 完全独立，互不影响 |
