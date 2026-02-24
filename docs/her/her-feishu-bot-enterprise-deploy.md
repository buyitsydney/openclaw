# 企业全员 Her 部署架构设计

## 背景

基于 Car Her 的成功验证，将 AI 助手从个人使用扩展到企业全员（200+ 人）。
每位员工通过飞书获得专属 AI 助手，拥有独立的对话历史、工作空间和长期记忆，完全隔离。

**最终方案：200 Bot + 200 Docker（每人一个独立 OpenClaw 容器）**

**验证状态 (2026-02-15)：飞书并发测试通过、数据隔离已确认、Webchat 隔离已确认、自动镜像重建已实现、Web Search (Perplexity) 已验证、Browser Use (Chromium headless) 已验证、Context Window 240K 保护已配置、CardKit 状态 Footer 已实现、Config $include 零分叉架构已验证（本地 + Docker 全环境 0 error）、语音 Gemini Live 已验证（本地 + Docker）**（均为本地 Mac 验证，Ubuntu 企业部署尚未执行）

---

## 部署前置条件

> **在创建任何飞书 Bot 之前，以下所有条件必须全部就绪。**

### 硬件采购

| 项目     | 最低配置（200 人文字）                                                 | 推荐配置（200 人文字 + 语音）            |
| -------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| 服务器   | 1 台：16 核 CPU、64GB RAM、500GB SSD                                   | 2-4 台：各 8 核 CPU、32GB RAM、500GB SSD |
| 网络     | 公网出口（需访问：GitHub、飞书 API、OpenRouter API、Google Cloud API） | 同左                                     |
| 操作系统 | Ubuntu 22.04+ / Debian 12+                                             | 同左                                     |

> 每容器约 300-400MB RAM（含 Chromium headless 浏览器），200 容器合计约 60-80GB。CPU 负载极低（AI 推理在云端），16 核足够。推荐配置选 128GB RAM 以留足余量。

### 软件环境（服务器上安装）

| 软件        | 安装命令                                                                                                                         | 用途                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Docker      | `curl -fsSL https://get.docker.com \| sh`                                                                                        | 容器运行环境                        |
| Git         | `apt install git`                                                                                                                | 拉取部署代码                        |
| Python 3    | `apt install python3`                                                                                                            | 配置生成脚本依赖                    |
| tmux        | `apt install tmux`                                                                                                               | 终端会话持久化（start.sh 自动使用） |
| cloudflared | `curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \| tee /usr/share/keyrings/cloudflare.gpg && apt install cloudflared` | 远程隧道（可选，仅远程访问时需要）  |

### 账号与密钥（P0，必须提前申请）

共需 3 项，全部就绪后才能开始部署。

#### ① OpenRouter API Key（AI 核心依赖，没有它什么都不能用）

1. 打开 [openrouter.ai](https://openrouter.ai)，点击右上角 Sign Up，用 Google 或邮箱注册
2. 登录后点击左侧 **Keys** → **Create Key**
3. 复制生成的 key（格式：`sk-or-v1-xxxx`），妥善保管
4. 充值：点击左侧 **Credits** → **Add Credits** → 选择 **Not using Link** → 用**支付宝**支付，先充 **$500** 用于初期测试和部署验证，正式运行按 ~$1,500/月预算

> 一个 key 可供所有 200 个容器共用，不需要每人一个。

#### ② Google Cloud 凭证（语音功能依赖，脚本强制检查）

即使暂时只用文字聊天，启动脚本也会检查此凭证文件是否存在。请提前完成。

**第一步：注册 Google Cloud**

1. 打开 [console.cloud.google.com](https://console.cloud.google.com)
2. 用企业 Google 账号登录（或个人 Gmail）
3. 首次使用会提示创建项目，项目名随意填（如 `carher-prod`）
4. 新账号有 $300 免费额度，足够长期测试

**第二步：记录项目 ID**

1. 在 Google Cloud Console 顶部的项目选择器中，复制当前项目 ID（格式如 `carher-prod` 或 `gen-lang-client-xxx`）
2. 这个项目 ID 后续要配置到 `openclaw.json` 中，语音费用记在这个项目的计费账号下

**第三步：启用 API**

1. 在 Google Cloud Console 顶部搜索栏输入 `Vertex AI API`
2. 点击进入 → 点击 **启用**（Enable）
3. 如果提示需要关联计费账号，按引导绑定信用卡（语音功能产生的费用从这里扣）

**第四步：在服务器上安装 gcloud CLI**

```bash
# Debian/Ubuntu
curl https://sdk.cloud.google.com | bash
# 安装完成后重新打开终端，或执行：
exec -l $SHELL
# 验证安装
gcloud --version
```

**第五步：登录并生成凭证文件**

```bash
# 登录 Google 账号（会打开浏览器，服务器无桌面则用下面的 --no-browser 方式）
gcloud auth application-default login

# 如果服务器没有浏览器（纯命令行服务器），使用远程登录模式：
gcloud auth application-default login --no-browser
# 按提示在本地电脑浏览器打开链接 → 登录 → 复制授权码 → 粘贴回终端
```

**第六步：验证**

```bash
ls ~/.config/gcloud/application_default_credentials.json
# 看到文件存在即成功
```

#### ③ 飞书管理员账号

登录 [飞书管理后台](https://feishu.cn/admin)，确认当前账号有「创建自建应用」权限。后续创建 200 个 Bot 需要此权限。

### 代码部署

```bash
# 1. 克隆仓库
git clone <内部仓库 URL>
cd <仓库目录>

# 2. 设置 OpenRouter API Key（写入 shell 配置，所有终端生效）
echo 'export OPENROUTER_API_KEY=sk-or-v1-你的key' >> ~/.bashrc
source ~/.bashrc

# 3. 首次构建 Docker 镜像（约 5-10 分钟，后续自动检测变更）
./start-user.sh --id=1
# 脚本会自动构建镜像，看到 "✓ 容器已启动" 即成功
# 首次验证后停止容器，进入下一步创建飞书 Bot
./start-user.sh --id=1 --down
```

> **检查清单**：运行 `./start-user.sh --id=1`，如果看到 `✓ Docker 镜像已是最新` + `✓ OpenRouter API key` + `✓ Google Cloud 凭证` + `✓ 容器已启动`，说明环境 100% 就绪。如果任何一项显示 `✗`，根据错误提示排查对应的账号/密钥配置。

### 首次验证（管理员个人 Her）

部署 200 用户容器前，建议先启动管理员自己的 Her 确认基础环境（Node.js、pnpm、AI Key、网络）正确：

```bash
# 1. 启动个人 Her（自动进入 tmux 会话 "her"，终端关闭后进程不丢失）
./start.sh

# 2. 用手机访问本地 URL，验证语音 + 文字功能
#    脚本启动后会打印本地 URL（http://localhost:8000/mobile.html）

# 3. 启动 Cloudflare 隧道（如需远程访问）
./start-tunnel.sh

# 4. 用手机访问远程 URL 验证隧道连通
#    远程 URL 格式：https://carher.carher.net/mobile.html?proxy=...

# 5. 确认一切正常后，再 ./start-user.sh --id=1 启动第一个企业用户容器
```

> 个人 Her 通过 `start.sh` 启动，在 tmux 会话 `her` 中运行，与用户容器（Docker）完全独立。macOS 和 Ubuntu 上操作完全一致。

---

## 方案选择

| 方案                                 | 结论         | 放弃原因                                                                                   |
| ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------ |
| per-peer 模式                        | 不可用       | 仅隔离对话历史，不隔离记忆文件（MEMORY.md 共享），隐私不可接受                             |
| 单 Gateway + Multi-Agent + Sandbox   | 有重大风险   | 单点故障（200 人全断）、升级必须停机、已知稳定性 bug（GitHub #1997）、非 OpenClaw 设计目标 |
| 4 Bot + 4 Docker（Multi-Agent 分片） | 可行但复杂   | 每容器 50 人仍需 Multi-Agent + Sandbox，配置复杂度高                                       |
| **200 Bot + 200 Docker**             | **最终方案** | 完全符合 OpenClaw "1 用户 = 1 实例" 设计哲学，阿里云托管服务底层相同                       |

```
张三的her (飞书 Bot) → Docker 容器 001 (标准单用户 OpenClaw)
李四的her (飞书 Bot) → Docker 容器 002 (标准单用户 OpenClaw)
...
王五的her (飞书 Bot) → Docker 容器 200 (标准单用户 OpenClaw)
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
│   ├── 飞书插件 ← "张三的her" Bot 的 WebSocket 长连接
│   ├── workspace/
│   │   ├── MEMORY.md (张三的专属记忆)
│   │   ├── USER.md   (张三的专属画像)
│   │   └── SOUL.md   (张三的专属人格)
│   └── sessions/ (张三的对话历史)
│
├── Docker 容器 002 (李四)
│   ├── OpenClaw Gateway (标准单用户配置)
│   ├── 飞书插件 ← "李四的her" Bot 的 WebSocket 长连接
│   └── ... (完全独立的文件系统)
│
└── ... 200 个容器，完全物理隔离
```

### 每容器配置

每个容器的配置使用 `$include` 引用共享基础配置，只需写环境特有的覆盖项。以下是 `start-user.sh` 自动生成的 per-user 配置结构：

```json
{
  "$include": "./carher-config.json",
  "agents": {
    "defaults": {
      "model": { "primary": "openrouter/anthropic/claude-sonnet-4.6" },
      "models": {
        "openrouter/anthropic/claude-opus-4.6": { "alias": "opus" },
        "openrouter/anthropic/claude-sonnet-4.6": { "alias": "sonnet" },
        "anthropic/claude-opus-4-6": { "alias": "or-opus" },
        "anthropic/claude-sonnet-4-6": { "alias": "or-sonnet" },
        "openrouter/google/gemini-3.1-pro-preview": { "alias": "gemini" },
        "openrouter/minimax/minimax-m2.5": { "alias": "minimax" },
        "openrouter/z-ai/glm-5": { "alias": "glm" }
      }
    }
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
      "realtime": {
        "config": {
          "gemini": {
            "projectId": "企业的Google Cloud项目ID",
            "model": "gemini-live-2.5-flash-native-audio"
          }
        }
      }
    }
  }
}
```

`$include` 自动引入以下共享配置（来自 `carher-config.json` + `shared-config.json5`）：gateway（bind=lan, auth）、browser（headless Chromium）、tools（web search + Groq STT）、commands、messages（TTS）、models（7 个模型定义：Sonnet 4.6、Opus 4.6、Gemini 3.1 Pro、MiniMax M2.5、GLM-5，双 provider：anthropic + openrouter）、agents（contextTokens 240K, compaction, memorySearch）、plugins（feishu-her 扩展）、channels（飞书基础配置）。

> **注意事项**：
>
> - 上述配置由 `start-user.sh` 从 `docker/users.csv` + `docker/carher-config.json` 自动生成，IT 无需手动编写
> - `dm.allowFrom` 限制只有主人能与 bot 单聊（其他人发消息会被忽略）
> - `groups.enabled` + `groups.archive` 默认启用群聊归档，主人可在私聊让 bot 总结群聊内容
> - `nativeSkills: "auto"` 必须配置，否则 AI 只能看到少数无依赖的 skill
> - `controlUi.dangerouslyDisableDeviceAuth: true` 跳过设备配对，允许 token 直接访问 Webchat
> - `tools.web.search.provider: "perplexity"` 启用 Web 搜索，通过 OpenRouter 调用 Perplexity Sonar，**复用已有的 `OPENROUTER_API_KEY`，不需要额外 API key**
> - `browser.enabled: true` + `headless: true` + `noSandbox: true` 启用容器内 Chromium 无头浏览器，Her 可打开网页、截图、读取 JS 渲染内容。Docker 镜像已内置 Chromium + 中文字体
> - `realtime.config.gemini.projectId` 必须填企业自己的 Google Cloud 项目 ID（前置条件中记录的），语音费用记在该项目下。**不配置则语音请求返回 500 错误，不会 fallback 到他人账号**
> - `realtime.config.gemini.projectId` 和 `model` 均支持热切换：修改 `openclaw.json` 后无需重启服务，下一次语音连接自动使用新值（已验证：本地 + Docker 8 项测试全部通过）
> - 飞书插件在用户发送 `/new` 时自动发送 Webchat URL（从 gateway 配置自动计算，Docker 模式下可通过 `WEBCHAT_URL` 环境变量覆盖）
>
> **Context Window 240K 保护（2026-02-15 新增）**：
>
> - `shared-config.json5` 已预配置 `agents.defaults.contextTokens: 240000` + `compaction.mode: "safeguard"`，限制每个用户的最大上下文窗口为 240K token
> - `models.providers` 定义了 7 个模型（Sonnet 4.6、Opus 4.6、Gemini 3.1 Pro、MiniMax M2.5、GLM-5），双 provider（anthropic 直连 contextWindow: 200000，openrouter contextWindow: 240000），确保 compaction 在接近上限时自动触发
> - **关键**: `contextTokens` 和 `contextWindow` 必须对齐，否则 compaction 不会触发（已实测验证）
> - 每条 AI 回复的飞书卡片底部自动显示模型名 + context 用量 + 压缩次数（CardKit 状态 footer）
> - 这是防止单个用户在长对话中无限消耗 token 导致高额费用的关键保护措施
> - CSV 中 `模型` 列可覆盖默认模型（如 `opus`），上下文窗口限制仍然生效

### Docker 部署

#### 实际部署方式（start-user.sh + docker run）

不使用 docker-compose。每个容器由 `start-user.sh` 直接通过 `docker run` 管理：

```bash
# 启动用户 1 的容器（自动从 CSV 读取飞书凭证，自动构建/更新镜像）
./start-user.sh --id=1 --local

# 停止用户 1
./start-user.sh --id=1 --down

# 查看用户 1 日志
./start-user.sh --id=1 --logs

# 列出所有用户和容器状态
./start-user.sh --list

# 停止所有容器
./start-user.sh --down
```

每个容器的端口自动分配：`base = 29000 + (id-1) * 10`，如用户 1 = 29001（Gateway）、29002（Realtime）、29003（Frontend）、29004（WS Proxy）。

#### 目录结构

```
仓库根目录/
├── start-user.sh               ← 用户容器管理主脚本（启动/停止/日志/列表）
├── Dockerfile.carher            ← Docker 镜像构建文件
├── scripts/
│   └── carher-entrypoint.sh     ← 容器入口脚本
└── docker/
    ├── users.csv                ← 用户注册表（飞书凭证，.gitignore 不入库）
    ├── servers.txt              ← 服务器凭证 + token 集中管理（.gitignore 不入库）
    ├── server.env               ← 服务器本地环境变量（.gitignore 不入库，见下方说明）
    ├── shared-config.json5      ← 共享功能配置（所有环境通用：tools、messages、agent defaults）
    ├── carher-config.json       ← Docker 基础配置（$include shared + Docker 特有覆盖）
    ├── user-configs/            ← start-user.sh 自动生成的 per-user 配置（.gitignore 不入库）
    └── workspace/               ← workspace 模板文件（SOUL.md 等，启动时自动同步到容器）
```

#### 配置架构（单一来源 Single Source of Truth）

所有环境（本地 Her、Docker 200 用户）共享同一套功能配置，通过 OpenClaw 的 `$include` 机制实现零分叉：

```
shared-config.json5          ← 功能配置（tools/messages/agent defaults），Git 管控
       ↓ $include
carher-config.json           ← Docker 基础配置（+ browser/gateway/models 覆盖）
       ↓ $include
per-user.json / openclaw.json ← 每个环境的最终配置（+ secrets/channels 覆盖）
```

**容器内配置文件布局**：`start-user.sh` 将三个配置文件 bind mount 到 `/data/.openclaw/`：

```
/data/.openclaw/
├── openclaw.json          ← per-user 配置（自 docker/user-configs/carher-config-N.json）
├── carher-config.json     ← 基础配置（自 docker/carher-config.json）
└── shared-config.json5    ← 共享配置（自 docker/shared-config.json5）
```

所有 `$include` 使用**相对路径**（如 `"./carher-config.json"`），相对于各自文件所在目录解析。修改 `shared-config.json5` 中的功能配置（如添加 web search、调整 TTS 语音），rebuild 镜像后所有容器自动生效，无需修改 per-user 配置。

#### 服务器本地环境变量（docker/server.env）

每台服务器需要创建 `docker/server.env` 文件（gitignored，不入库），`start-user.sh` 启动时自动 source 该文件。用于存放服务器特有的环境变量，当前唯一变量是 Cloudflare Tunnel 域名前缀：

| 机器     | `docker/server.env` 内容   | 效果                               |
| -------- | -------------------------- | ---------------------------------- |
| Mac 本地 | 不需要（文件不存在即可）   | 域名无前缀：`u3-fe.carher.net`     |
| S1 (186) | `TUNNEL_HOST_PREFIX="s1-"` | 域名加前缀：`s1-u3-fe.carher.net`  |
| S2 (187) | `TUNNEL_HOST_PREFIX="s2-"` | 域名加前缀：`s2-u6-fe.carher.net`  |
| S3 (188) | `TUNNEL_HOST_PREFIX="s3-"` | 域名加前缀：`s3-u10-fe.carher.net` |

**设计原则**：代码统一（`start-user.sh` 入 git），配置分离（`server.env` 不入 git）。Mac 是**代码**的唯一源头（通过 git push/pull 同步）。`users.csv`、`servers.txt`、`server.env` 等含密钥的配置文件 **不入 git**，各服务器独立维护。

> **重要**：realtime 插件的 Gemini 配置（`plugins.entries.realtime.config.gemini`）必须作为 sibling key 写在 per-user 配置主文件中（不能放在被 `$include` 的文件里），因为 realtime 插件的 bootstrap 接口直接用 `JSON.parse()` 读取主配置文件。`start-user.sh` 已自动处理此约束。

### 升级/回滚

```bash
# 拉取最新代码
git pull

# 滚动升级（start-user.sh 自动检测代码变更并重建镜像，每次只影响 1 人 2-3 秒）
for i in $(seq 1 200); do
  ./start-user.sh --id=$i --local
  sleep 10
done

# 跳过镜像重建（仅重启容器，用于配置变更）
./start-user.sh --id=1 --local --no-rebuild

# 回滚：checkout 旧版本代码后重新启动（镜像会自动重建为旧版本）
git checkout v旧版本
./start-user.sh --id=1 --local
```

---

## IT 操作流程

> **重要：角色分工与权限边界**
>
> 飞书开放平台（open.feishu.cn）的开发者后台**按企业组织严格隔离**，外部人员（如第三方部署服务商）无法访问其他企业的后台。因此：
>
> - **IT（企业内部人员）**：负责所有飞书开放平台操作（创建应用、配权限、发布、配事件订阅）—— 即下文的阶段 A 和阶段 C
> - **部署者（可以是外部人员）**：负责服务器操作（编辑 CSV、启动容器、确认连通）—— 即下文的阶段 B
>
> IT 和部署者可以是不同团队甚至不同公司的人，通过安全渠道传递 App ID + App Secret 即可协作。

### 创建飞书 Bot（IT 操作清单）

每个 Bot 约 15-20 分钟。**整个流程需要发布两次**：第一次让 Bot 在飞书客户端可见（同时使 WSClient 长连接能够建立），第二次包含事件订阅配置使 Bot 真正能收发消息。

#### 快速 Checklist（批量创建时看这里）

> 第 2 个 Bot 起就不用看下面的详细步骤了，对照这个表即可。

| #   | 操作                  | 要点                                                         |
| --- | --------------------- | ------------------------------------------------------------ |
| 1   | 创建应用 + 启用机器人 | 命名格式：`{人名}的her`（如：老杨的her），添加「机器人」能力 |
| 2   | 记录凭证              | 复制 App ID + App Secret                                     |
| 3   | 批量导入权限          | 粘贴 JSON 导入 68 个权限                                     |
| 4   | 第一次发布            | 可用范围 = 指定人员，只选一人（见下方说明）                  |
| 5   | 确认 Bot 可见         | 让目标员工搜索 Bot，确认能找到                               |
| 6   | 交给部署者            | 等部署者确认 WSClient connected                              |
| 7a  | 配置订阅方式          | 选「长连接」，保存（需 WSClient 在线）                       |
| 7b  | 添加事件              | 添加 im.message.receive_v1                                   |
| 8   | 第二次发布            | 再次创建版本，发布（沿用第一次可用范围）                     |
| 9   | 验证                  | 给 Bot 发消息，确认 AI 回复                                  |

> **关于可用范围（隔离的核心机制）**：
>
> 每个 Bot 发布时的「可用范围」**必须设为「指定人员」，且只选目标用户一人**。
> 这是飞书平台层面保证 "谁能看到哪个 Bot" 的唯一机制。**绝对不能选「全部员工」**，否则全公司 200 人都能看到并聊天。
>
> - 配对举例：Bot-001 可用范围 = 董事长 → 只有董事长能看到；Bot-002 可用范围 = VP → 只有 VP 能看到
> - 创建 Bot 时不涉及通讯录，通讯录只在发布时设置可用范围时用到
> - 可用范围 + 服务端 `dm.allowFrom` 白名单 = 双重隔离

#### 阶段 A：IT 创建应用 + 首次发布（独立完成，约 10 分钟）

**步骤 1：创建自建应用**

1. 打开 [飞书开放平台](https://open.feishu.cn)，登录管理员账号
2. 点击左上角「创建应用」→「自建应用」
3. 填写应用名称，格式：**`{人名}的her`**（如：老杨的her、金龙的her、哲人的her），描述可留空，点击「创建」

**步骤 2：启用机器人能力**

1. 左侧菜单点击「添加应用能力」→ 找到「机器人」→「添加」

**步骤 3：获取凭证**

1. 左侧菜单点击「凭证与基础信息」
2. 记录 **App ID**（`cli_xxx`）和 **App Secret**（妥善保管）

**步骤 4：批量导入权限**

左侧菜单「权限管理」→「API 权限」→ 右上角「批量导入/导出权限」→ 选择「导入」标签页，粘贴以下 JSON：

```json
{
  "scopes": {
    "tenant": [
      "bitable:app",
      "bitable:app:readonly",
      "board:whiteboard:node:create",
      "board:whiteboard:node:read",
      "cardkit:card:write",
      "contact:contact.base:readonly",
      "docs:doc",
      "docs:document.comment:create",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.comment:write_only",
      "docs:document.content:read",
      "docs:document.media:download",
      "docs:document.media:upload",
      "docs:document.subscription",
      "docs:document.subscription:read",
      "docs:document:copy",
      "docs:document:export",
      "docs:document:import",
      "docs:event.document_deleted:read",
      "docs:event.document_edited:read",
      "docs:event.document_opened:read",
      "docs:event:subscribe",
      "docs:permission.member",
      "docs:permission.member:auth",
      "docs:permission.member:create",
      "docs:permission.member:delete",
      "docs:permission.member:readonly",
      "docs:permission.member:retrieve",
      "docs:permission.member:transfer",
      "docs:permission.member:update",
      "docs:permission.setting",
      "docs:permission.setting:read",
      "docs:permission.setting:readonly",
      "docs:permission.setting:write_only",
      "docx:document",
      "docx:document.block:convert",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "drive:drive",
      "drive:drive.metadata:readonly",
      "drive:drive.search:readonly",
      "drive:drive:readonly",
      "drive:drive:version",
      "drive:drive:version:readonly",
      "drive:export:readonly",
      "drive:file",
      "drive:file.like:readonly",
      "drive:file.meta.sec_label.read_only",
      "drive:file:download",
      "drive:file:readonly",
      "drive:file:upload",
      "drive:file:view_record:readonly",
      "im:chat:readonly",
      "im:message",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message:send_as_bot",
      "im:resource",
      "space:document:delete",
      "space:document:move",
      "space:document:retrieve",
      "space:document:shortcut",
      "wiki:wiki",
      "wiki:wiki:readonly"
    ],
    "user": []
  }
}
```

点击「下一步，确认新增权限」→ 确认即可。已开通的权限不会重复添加。

> **权限分类（共 68 个，全部为 tenant 级别）**：
>
> - **消息基础**（6 个）：`im:message`、`im:message:send_as_bot`、`im:message.group_msg`、`im:message.p2p_msg:readonly`、`im:chat:readonly`、`im:resource` — 消息收发 + 图片 + 群聊归档
> - **卡片流式回复**（1 个）：`cardkit:card:write` — AI 打字机效果
> - **Emoji 表情**（2 个）：`im:message.reactions:read`、`im:message.reactions:write_only` — AI 自动 Get 回应 + 点赞
> - **联系人**（1 个）：`contact:contact.base:readonly` — 获取发送者姓名
> - **文档核心**（6 个）：`docs:doc`、`docx:document`、`docx:document.block:convert`、`docx:document:create`、`docx:document:readonly`、`docx:document:write_only` — 旧版 + 新版文档读写
> - **文档评论**（4 个）：`docs:document.comment:*` — 创建/读取/更新评论
> - **文档内容/媒体/订阅**（5 个）：`docs:document.content:read`、`docs:document.media:download`、`docs:document.media:upload`、`docs:document.subscription`、`docs:document.subscription:read` — 文档内容读取、媒体上传下载、订阅通知
> - **文档复制/导出/导入**（3 个）：`docs:document:copy`、`docs:document:export`、`docs:document:import`
> - **文档事件**（4 个）：`docs:event.document_deleted:read`、`docs:event.document_edited:read`、`docs:event.document_opened:read`、`docs:event:subscribe` — 文档变更事件监听
> - **文档权限管理**（12 个）：`docs:permission.member*`（8 个）+ `docs:permission.setting*`（4 个） — 文档成员权限和权限设置的完整 CRUD
> - **云盘**（14 个）：`drive:drive*`（6 个）+ `drive:export:readonly` + `drive:file*`（7 个） — 云盘读写/搜索/版本、文件上传下载/元数据/查看记录
> - **多维表格**（2 个）：`bitable:app`、`bitable:app:readonly` — 多维表格读写
> - **白板**（2 个）：`board:whiteboard:node:create`、`board:whiteboard:node:read`
> - **Wiki 知识库**（2 个）：`wiki:wiki`、`wiki:wiki:readonly`
> - **空间文档管理**（4 个）：`space:document:delete`、`space:document:move`、`space:document:retrieve`、`space:document:shortcut` — 知识空间内文档的移动/删除/快捷方式

**步骤 5：第一次发布（让 Bot 在飞书客户端可见 + 使长连接可用）**

1. 「应用发布」→「版本管理与发布」→「创建版本」
2. **设置可用范围 →「指定人员」→ 从通讯录选择该 Bot 对应的目标员工（只选一人）**
3. 提交发布

> **可用范围是隔离的核心**：选「指定人员」+ 只选目标用户，确保只有该员工能在飞书客户端找到这个 Bot。其他员工完全搜不到。**绝不能选「全部员工」。**
>
> 这次发布有两个目的：(1) 让 Bot 出现在目标员工的飞书客户端中；(2) 使应用进入已发布状态，后续 WSClient 才能建立长连接（未发布的应用无法建立长连接）。此时 Bot 还不能聊天，这是正常的。
>
> 如果企业有发布审批流程，需等管理员审批通过后再继续下一步。

**步骤 6：去飞书客户端确认 Bot 存在**

1. 让**目标员工**打开飞书客户端，搜索刚创建的 Bot 名称
2. 确认目标员工能找到 Bot（点开后无法聊天，正常）
3. 让**其他员工**搜索同一个 Bot 名称，确认搜不到（验证隔离生效）

**步骤 7：将凭证交给部署者**

通过安全渠道（当面、加密消息）提供 App ID + App Secret，告知部署者先启动服务，完成后通知 IT 继续。

#### 阶段 B：部署者启动服务（IT 等待）

部署者收到 App ID + App Secret 后：

1. 编辑 `docker/users.csv`，新增一行：`N,董事长,sonnet,cli_xxx,secret_xxx,,openrouter,董事长专属Bot`
2. 运行 `./start-user.sh --id=N --local`
3. 确认日志出现 `Feishu WSClient connected` 后通知 IT 继续

#### 阶段 C：IT 配置事件订阅 + 第二次发布（约 5 分钟）

**步骤 8：配置事件订阅（两步操作，有严格顺序）**

**8a. 设置订阅方式（前提：WSClient 长连接已在线）**

1. 回到飞书开放平台 → 你的应用 →「事件与回调」→「事件配置」
2. 编辑订阅方式，选 **"使用 长连接 接收事件"** → **保存**

> 保存失败？说明 WSClient 长连接未建立。让部署者确认容器日志已出现 `Feishu WSClient connected`。常见原因：容器未启动、App ID/App Secret 填错、网络不通。

**8b. 添加事件（前提：8a 已保存成功）**

1. 在「事件配置」页面，点击「添加事件」
2. 搜索 `im.message.receive_v1`（接收消息 v2.0）→ 确认添加

> 飞书官方要求：添加事件之前，必须先配置订阅方式（即 8a）。顺序不可颠倒。

**步骤 9：第二次发布（包含事件订阅配置）**

1. 「应用发布」→「版本管理与发布」→「创建版本」
2. 提交发布（可用范围沿用第一次的设置，无需修改）

> 必须再次发布！飞书官方明确规定：即使权限已开通，添加事件后也需要发布新版本才能使事件订阅生效。不发布第二次，Bot 收不到消息。

**步骤 10：验证**

在飞书搜索机器人名称 → 打开私聊 → 发消息 → 确认 AI 回复。

> 搜索到但没有回复？确认事件订阅已保存 + 已创建第二个版本并发布。

**步骤 11：记录用户 open_id（必须！影响 AI 工具权限）**

> **⚠️ 不可跳过！** 不配置 Owner → 发送者不被识别为 Owner → **cron（定时任务）、gateway（网关管理）等高权限工具被过滤，AI 完全看不到这些工具。**
>
> 源码依据：`cron` 等工具标记 `ownerOnly: true`（`src/agents/tools/cron-tool.ts`），
> 非 Owner 发送者的工具列表被 `applyOwnerOnlyToolPolicy` 过滤（`src/agents/tool-policy.ts`）。
> 详见 [Owner 机制说明](./her-feishu-bot-architecture.md#主人身份识别owner-机制)。

员工第一次给 Bot 发消息后：

1. 部署者查看日志：`./start-user.sh --id=N --logs`，搜索 `from=ou_`，记录完整的 `ou_xxx` 值
2. 编辑 `docker/users.csv`：
   - **专属 Bot**（1人1bot）：将 `ou_xxx` 填入 `feishu_owner_open_id` 列
   - **共享 Bot**（多人共用）：将管理员 open_id 填入 `owner_allow_from` 列（多人用 `|` 分隔）
3. 重启容器：`./start-user.sh --id=N`，Owner 身份即刻生效
4. 验证：让用户发 "列出你所有工具名称"，确认回复中包含 `cron`

#### 飞书 Bot 常见问题

| 问题                                        | 答案                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建应用要付费吗？                          | 不需要，飞书自建应用完全免费                                                                                                                                                                                                                                                                                                             |
| 需要备案域名或公网 IP 吗？                  | 不需要，长连接模式无需网络配置                                                                                                                                                                                                                                                                                                           |
| 外部人员（第三方服务商）能帮我创建 Bot 吗？ | **不能。** 飞书开发者后台按企业隔离，外部人员无法访问你企业的后台。所有飞书平台操作必须由企业内部 IT 完成，外部人员只负责服务器部署                                                                                                                                                                                                      |
| 可用范围能选「全部员工」吗？                | **绝不可以。** 必须选「指定人员」，且只选该 Bot 对应的目标用户一人。否则全公司都能看到并聊天，隐私完全泄露                                                                                                                                                                                                                               |
| 创建 Bot 时需要选通讯录吗？                 | 不需要。创建应用时只填名称和描述，**通讯录只在发布时设置可用范围时用到**                                                                                                                                                                                                                                                                 |
| 200 个 Bot 如何保证配对？                   | 每个 Bot 命名为 `{人名}的her`（如「老杨的her」），发布时可用范围指定该员工一人。只有目标员工能看到对应的 Bot                                                                                                                                                                                                                             |
| 员工会看到其他人的 Bot 吗？                 | 不会。可用范围设为「指定人员」后，其他员工完全搜不到这个 Bot。加上服务端 `dm.allowFrom` 白名单，形成双重隔离                                                                                                                                                                                                                             |
| 为什么事件订阅保存失败？                    | WSClient 长连接未在线。确认容器日志有 `Feishu WSClient connected`。常见原因：容器未启动、凭证错误、网络不通                                                                                                                                                                                                                              |
| 飞书客户端搜不到 Bot？                      | 还没有发布第一个版本，或可用范围未包含你（让目标员工而非 IT 自己去搜）                                                                                                                                                                                                                                                                   |
| 搜索到 Bot 但没有回复？                     | 事件订阅未配置，或配置后没有发布第二个版本                                                                                                                                                                                                                                                                                               |
| 每个应用最多几个长连接？                    | 50 个。但 200 Bot 方案中每个 Bot 是独立应用（各 1 个连接），不受此限制                                                                                                                                                                                                                                                                   |
| 容器重启后 Browser Use 不工作？             | Chrome 的 `SingletonLock` 文件残留（容器重启后 hostname 变化导致）。`carher-entrypoint.sh` 已内置自动清理，确保使用最新镜像。手动修复：`docker exec carher-N rm -f /data/.openclaw/browser/*/user-data/SingletonLock /data/.openclaw/browser/*/user-data/SingletonSocket /data/.openclaw/browser/*/user-data/SingletonCookie` 后重启容器 |

### 员工生命周期

| 事件       | IT 操作                      | 部署者操作               | 对其他员工影响 |
| ---------- | ---------------------------- | ------------------------ | -------------- |
| 新员工入职 | 创建 1 个飞书 Bot（15 分钟） | 生成配置 + 启动 1 个容器 | **零影响**     |
| 员工离职   | 注销飞书账号 + 删除 Bot      | 停止并删除该容器         | **零影响**     |

### 用户管理

用户凭证集中管理在 `docker/users.csv`（已加入 .gitignore 不入库）：

```csv
# id, 姓名, 模型, feishu_app_id, feishu_app_secret, feishu_owner_open_id, provider, 备注, owner_allow_from
1,张三,sonnet,cli_aaa111,secret111,ou_xxx111,openrouter,测试用户,
2,厂商A,opus,,,,anthropic,"厂商演示（无飞书）",
3,王五,sonnet,cli_bbb222,secret222,ou_xxx222,,,
12,测试Bot,sonnet,cli_ccc333,secret333,,openrouter,多人共享,ou_admin1|ou_admin2
```

| 字段                   | 说明                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | 用户编号（1-999）                                                                                                                                         |
| `姓名`                 | 显示名                                                                                                                                                    |
| `模型`                 | AI 模型（留空用默认 sonnet）                                                                                                                              |
| `feishu_app_id`        | 飞书 Bot 的 App ID（留空不启用飞书）                                                                                                                      |
| `feishu_app_secret`    | 飞书 Bot 的 App Secret                                                                                                                                    |
| `feishu_owner_open_id` | 用户的飞书 open_id（`ou_xxx`）。**专属 bot 必填！** 不填则 cron 等高权限工具不可用（见步骤 11）。生成 `dm.allowFrom`（限制只有此人能聊天 + 识别为 Owner） |
| `provider`             | `anthropic` 或 `openrouter`（留空默认 `openrouter`）                                                                                                      |
| `备注`                 | 备注信息                                                                                                                                                  |
| `owner_allow_from`     | 显式指定 Owner（多人用 `\|` 分隔）。生成 `commands.ownerAllowFrom`。**用于共享 bot**：不限制谁能聊天，但指定谁有 cron 等高权限工具。专属 bot 不需要填此列 |

**两列的区别和使用场景：**

| 场景                 | `feishu_owner_open_id` | `owner_allow_from`            | 效果                           |
| -------------------- | ---------------------- | ----------------------------- | ------------------------------ |
| 专属 Bot（1人1bot）  | 填用户 open_id         | 留空                          | 只有该用户能聊天 + 是 Owner    |
| 共享 Bot（多人共用） | 留空                   | 填管理员 open_id（`\|` 分隔） | 所有人能聊天，仅指定人是 Owner |

获取 open_id 的方法：用户给 Bot 发一条消息，从容器日志中找 `from=ou_xxx`。

`start-user.sh` 从 CSV 自动生成完整配置，包括：

- 飞书通道 + 插件启用
- `feishu_owner_open_id` → `dm.allowFrom`（单聊白名单 = Owner 身份 = 高权限工具访问）
- `owner_allow_from` → `commands.ownerAllowFrom`（显式 Owner 声明，优先级高于 `dm.allowFrom`）
- `groups.enabled` + `groups.archive`（群聊归档，默认启用）

> **注意**：`ownerAllowFrom: ["*"]` **不会**让所有人成为 Owner（`*` 触发 allowAll 路径，跳过 Owner 匹配）。必须填具体 open_id。

#### CSV 工作流

CSV 含密钥，已加入 `.gitignore`，**不通过 git 同步**。

**Mac 与服务器的 CSV 是独立的：**

| 位置            | 路径                            | 用途                              |
| --------------- | ------------------------------- | --------------------------------- |
| Mac             | `docker/users.csv`              | 本地开发测试（不同的 Feishu App） |
| S1/S2/S3 服务器 | `/Data/CarHer/docker/users.csv` | 生产部署（企业 Feishu App）       |

> **注意**：Mac 和服务器的 CSV 管理的是完全不同的飞书 App 和环境，不存在"同步"关系。
> 修改生产配置（如填写 open_id）应直接在对应服务器上编辑。

**生产 CSV 编辑流程：**

1. SSH 到服务器，编辑 `/Data/CarHer/docker/users.csv`
2. 运行 `./start-user.sh --id=N` 重建容器（从本地 CSV 读取配置）
3. 如果多台服务器需要相同变更（如 `carher-config.json` 更新），通过 `git pull` 同步代码后各服务器独立重建

```bash
./start-user.sh --id=1               # 模型和飞书凭证从 CSV 自动读取
./start-user.sh --id=1 --model=opus  # CLI --model 覆盖 CSV 设置
./start-user.sh --id=1 --local       # 仅本地访问（不开隧道）
./start-user.sh --id=1 --down        # 停止容器
./start-user.sh --list               # 列出所有用户和容器状态
```

> `start-user.sh` 自动检测代码变更并重建镜像，无需手动操作。`--no-rebuild` 可跳过。

---

## 各通道与工具能力

| 通道/工具       | 状态     | 说明                                                                                                                                                                                                                                                                           |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 飞书            | **可用** | 每人专属 Bot + 独立容器，CardKit 流式卡片回复，已验证                                                                                                                                                                                                                          |
| Webchat         | **可用** | 每容器独立 Webchat（各自端口），已验证                                                                                                                                                                                                                                         |
| Telegram        | 可用     | 同飞书，每容器可额外配 Telegram Bot                                                                                                                                                                                                                                            |
| 语音 (realtime) | **可用** | Gemini Live 原生语音已验证（本地 + Docker）。**安全已修复**：两层防护（Layer 1 端口不暴露 + Layer 2 per-container token 认证），飞书 `/voice` 命令自动生成带 token 的语音 URL。详见 [飞书架构文档 - 安全架构](her-feishu-bot-architecture#安全架构两层防护模型2026-02-15-设计) |
| Web Search      | **可用** | Perplexity Sonar 搜索引擎，复用 OpenRouter API key，已验证                                                                                                                                                                                                                     |
| Browser Use     | **可用** | 容器内 Chromium headless 浏览器，可打开网页/截图/读取 JS 渲染内容，已验证                                                                                                                                                                                                      |
| Web Fetch       | **可用** | HTTP 网页抓取 + 正文提取（纯静态页面），默认启用                                                                                                                                                                                                                               |

---

## 费用估算（200 人规模）

| 项目                                     | 假设                          | 月费用    |
| ---------------------------------------- | ----------------------------- | --------- |
| 飞书文字（Claude Sonnet via OpenRouter） | 每人 50 条/天，$0.005/条      | ~$1,500   |
| 语音（Gemini Live, 20% 活跃）            | 40 人 x 30 分/天，$0.04/分    | ~$1,440   |
| 服务器（仅文字）                         | 1 台 16核 64G 或 4 台 4核 16G | ~$200-500 |

> 每容器约 300-400MB RAM（含 Chromium headless），200 容器约 60-80GB。

| 方案        | 月费用        |
| ----------- | ------------- |
| 仅飞书文字  | ~$1,700-2,000 |
| 飞书 + 语音 | ~$3,000-7,000 |

---

## 总结

| 维度       | 方案                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| 架构       | **200 Bot + 200 Docker**：每人 1 个飞书 Bot + 1 个 Docker 容器                                                     |
| 每容器配置 | **标准单用户 OpenClaw**（默认配置 + 飞书插件 + Perplexity 搜索 + Chromium 浏览器），无 Multi-Agent/binding/sandbox |
| 隔离       | **Docker OS 级**：独立文件系统、进程空间、网络                                                                     |
| 单点故障   | **无**：1 容器崩只影响 1 人                                                                                        |
| 升级       | **滚动升级**：逐容器重启，每次只影响 1 人 2-3 秒                                                                   |
| 代码修改   | **零**（纯配置 + Docker），与上游零冲突                                                                            |
| 飞书 Bot   | IT 手动创建（无 API，~50 小时一次性工作）                                                                          |
| 月费用     | ~$2,000-7,000（取决于模型和语音使用量）                                                                            |
