# Car Her 同事快速上手指南

从零开始，在你自己的 Mac 上搭建完整的 Car Her 系统。

本文档覆盖三个能力：

1. **个人 Her** — 本地运行的实时语音 AI 助手
2. **飞书机器人** — 在飞书客户端里跟 Her 文字聊天
3. **Docker 多用户** — 为厂商演示启动多个隔离的 Her 实例

全程大约 30-60 分钟（取决于网速）。

---

## Part 0: 安装前提软件（一次性）

以下工具只需要安装一次。打开 **终端**（Terminal.app），逐条执行。

> **Ubuntu 用户**：本指南以 macOS 为例。Ubuntu 上把 `brew install` 替换为 `apt install`，Docker Desktop 替换为 Docker Engine（`curl -fsSL https://get.docker.com | sh`），额外安装 `apt install tmux`。其余脚本（`start.sh`、`start-user.sh`、`start-tunnel.sh`）macOS / Ubuntu 通用，无需修改。企业部署详见 [企业部署文档](/her/her-feishu-bot-enterprise-deploy)。

### 0.1 Homebrew（macOS 包管理器）

几乎所有后续工具都通过 Homebrew 安装。如果你之前从没用过命令行安装软件，先装这个。

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

验证：

```bash
brew --version
# 看到 Homebrew 4.x.x 说明成功
```

### 0.2 Node.js 22+（运行后端服务）

Her 的后端是用 TypeScript 写的，需要 Node.js 来运行。

```bash
brew install node@22
```

验证：

```bash
node -v
# 看到 v22.x.x 或更高版本说明成功
```

### 0.3 pnpm（包管理器）

项目用 pnpm 管理依赖，比 npm 快很多。

```bash
npm install -g pnpm
```

验证：

```bash
pnpm -v
# 看到版本号说明成功（如 10.x.x）
```

### 0.4 Python 3（语音代理服务需要）

Her 的实时语音功能有一个 Python 写的代理服务（WebSocket 转发 + Google 认证）。macOS 通常自带 Python 3，先检查：

```bash
python3 --version
# 看到 Python 3.x.x 说明已有
```

如果没有：

```bash
brew install python3
```

安装 Python 依赖（语音代理用到的库）：

```bash
pip3 install websockets google-auth certifi aiohttp requests
```

### 0.5 Docker Desktop（容器化多用户隔离）

Docker 让每个厂商用户跑在独立的"容器"里，互相看不到对方的数据。

1. 打开 https://www.docker.com/products/docker-desktop/
2. 下载 Mac 版（Apple Silicon 或 Intel，根据你的机器选）
3. 安装并启动 Docker Desktop（菜单栏会出现鲸鱼图标）

验证：

```bash
docker --version
# 看到 Docker version 2x.x.x 说明成功

docker info
# 如果报错 "Cannot connect to the Docker daemon"，说明 Docker Desktop 没启动，点菜单栏鲸鱼图标启动它
```

### 0.6 cloudflared（Cloudflare 隧道工具）

cloudflared 让你的本地服务通过 Cloudflare 暴露到公网，这样手机不在同一个 WiFi 也能访问。

```bash
brew install cloudflare/cloudflare/cloudflared
```

验证：

```bash
cloudflared --version
# 看到版本号说明成功
```

### 0.7 Google Cloud CLI（Gemini Live 语音认证）

Her 的实时语音用的是 Google Gemini Live API，需要通过 Google Cloud 认证。

```bash
brew install google-cloud-sdk
```

验证：

```bash
gcloud --version
# 看到 Google Cloud SDK xxx.x.x 说明成功
```

### 0.8 git（版本控制）

macOS 通常自带 git。确认一下：

```bash
git --version
# 看到 git version 2.x.x 说明已有
```

如果没有，安装 Xcode Command Line Tools（系统会自动提示）。

---

## Part 1: 申请 API Key（一次性）

Her 需要两个 API 的认证。这一步只做一次，后续不用重复。

### 1.1 Google Cloud — Gemini Live 实时语音

这个用于 Her 的语音对话功能。Gemini Live 是 Google 的实时语音 AI 模型。

**Step 1: 登录 Google Cloud**

```bash
gcloud auth login
```

会弹出浏览器，用你的 Google 账号登录。

**Step 2: 创建应用默认凭证**

```bash
gcloud auth application-default login
```

又会弹出浏览器，再次授权。这一步会在你的电脑上生成一个凭证文件。

**Step 3: 确认凭证文件存在**

```bash
ls ~/.config/gcloud/application_default_credentials.json
```

如果看到文件路径（没有报错），说明成功。

**Step 4: 启用 Vertex AI API**

1. 打开 https://console.cloud.google.com
2. 在顶部搜索栏搜 "Vertex AI API"
3. 点击进入，点 "启用"（Enable）
4. 如果没有项目，先创建一个（名字随意，如 `my-her`）

> 注意：Google Cloud 有免费额度，Gemini Live 的用量通常在免费范围内。但建议设置一个预算提醒，以防意外费用。

### 1.2 OpenRouter — 后台 AI Agent

Her 有一个"后台大脑"，当语音助手遇到复杂问题时（比如查天气、设提醒），会调用后台 AI（Claude、GPT 等）来处理。OpenRouter 是一个统一的 AI API 入口。

**Step 1: 注册 OpenRouter**

1. 打开 https://openrouter.ai
2. 注册账号（支持 Google/GitHub 登录）
3. 充值一点余额（$5-10 够用很久，Sonnet 模型很便宜）

**Step 2: 创建 API Key**

1. 登录后，进入 https://openrouter.ai/keys
2. 点 "Create Key"
3. 复制生成的 key（以 `sk-or-` 开头）

**Step 3: 设置环境变量（持久化）**

把 API key 写入 shell 配置文件，这样每次打开终端都自动生效：

```bash
echo 'export OPENROUTER_API_KEY=sk-or-你的key粘贴到这里' >> ~/.zshrc
source ~/.zshrc
```

验证：

```bash
echo $OPENROUTER_API_KEY
# 看到 sk-or-... 说明成功
```

---

## Part 2: 拉取代码 + 编译

### 2.1 克隆仓库

```bash
cd ~/Documents    # 或者你喜欢的任何目录
git clone https://github.com/openclaw/openclaw.git
cd openclaw
git checkout dev  # 切换到 dev 分支（Car Her 功能在这个分支上）
```

### 2.2 安装依赖

```bash
pnpm install
```

这一步会下载所有项目依赖，首次可能需要几分钟。

验证：

```bash
# 没有报错、没有红色文字就说明成功
# 最后会看到类似 "dependencies installed" 的提示
```

### 2.3 编译项目

```bash
pnpm build
```

验证：

```bash
# 看到编译完成、没有 ERROR 就说明成功
```

> 注意：如果编译中遇到错误，先确认 Node.js 版本是 22 以上（`node -v`）。

---

## Part 3: 启动个人 Her（本地语音助手）

这一步让你在自己的电脑上跑起来一个完整的 Her，可以通过浏览器语音对话。

### 3.1 初始化 OpenClaw 配置

```bash
pnpm openclaw init
```

这会在 `~/.openclaw/` 目录下创建配置文件。

### 3.2 配置 OpenRouter API Key

```bash
pnpm openclaw config set env.vars.OPENROUTER_API_KEY "$OPENROUTER_API_KEY"
```

这条命令把你的 OpenRouter key 写入 OpenClaw 配置文件，这样后台 agent 就能调用 AI 模型了。

### 3.3 启动 Her

```bash
./start.sh
```

脚本会自动：

1. 进入 tmux 会话 `her`（终端/Cursor 重启后进程不丢失，`tmux attach -t her` 可重新进入）
2. 编译最新代码
3. 启动 Gateway（后端服务）
4. 启动 Live Frontend（语音代理）
5. 打印本地 + 远程访问 URL，以及 cloudflared 隧道状态

看到类似以下输出说明成功：

```
[5/5] 个人 Her 已就绪

═══════════════════════════════════════════════════════════════
  个人 Her — 本地 URL
═══════════════════════════════════════════════════════════════
  Webchat:    http://localhost:18789/?token=xxx
  Desktop UI: http://localhost:8000
  Mobile UI:  http://localhost:8000/mobile.html
═══════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════
  个人 Her — 固定远程 URL（需 cloudflared 隧道运行）
═══════════════════════════════════════════════════════════════
  Mobile:  https://carher.carher.net/mobile.html?proxy=...
  Desktop: https://carher.carher.net?proxy=...
═══════════════════════════════════════════════════════════════
```

> tmux 需要提前安装：macOS `brew install tmux`，Ubuntu `apt install tmux`。如果未安装 tmux，脚本仍可正常运行，但终端关闭后进程会丢失。

### 3.4 在浏览器里体验

- **桌面版**（完整调试界面）：打开 http://localhost:8000
- **手机版**（极简语音界面）：打开 http://localhost:8000/mobile.html

点击麦克风按钮，开始跟 Her 说话。

### 3.5 手机远程访问（可选）

如果你想在手机上体验（不在同一个 WiFi 也行），另开一个终端窗口：

```bash
cd ~/Documents/openclaw    # 进入项目目录
./start-mobile.sh --random
```

会打印一个 `https://xxx.trycloudflare.com/...` 的长 URL，在手机浏览器打开即可。

> 注意：`start.sh` 必须保持运行。`start-mobile.sh` 只是建隧道，不启动服务。

### 停止 Her

在运行 `start.sh` 的终端窗口按 `Ctrl+C`。

---

## Part 4: 接入飞书机器人（可选）

让你在飞书客户端里直接跟 Her 文字聊天，体验跟聊微信一样。

### 4.1 创建飞书自建应用

1. 打开 https://open.feishu.cn（飞书开放平台）
2. 登录你的飞书账号（如果没有飞书账号，先注册一个飞书组织，个人免费）
3. 点 "创建应用" → "自建应用"
4. 填写应用名称（如 "My Her"）和描述
5. 进入应用设置，点左侧 "添加应用能力" → 勾选 **机器人**

### 4.2 获取凭证

在应用设置页面，点左侧 "凭证与基础信息"：

- 复制 **App ID**（以 `cli_` 开头）
- 复制 **App Secret**

### 4.3 添加权限

点左侧 "权限管理" → "API 权限" → 右上角「批量导入/导出权限」→「导入」，粘贴以下 JSON 一键开通所有权限：

```json
{
  "scopes": {
    "tenant": [
      "bitable:app:readonly",
      "board:whiteboard:node:create",
      "board:whiteboard:node:read",
      "cardkit:card:write",
      "contact:contact.base:readonly",
      "docs:doc",
      "docx:document",
      "docx:document.block:convert",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "drive:drive:readonly",
      "im:chat:readonly",
      "im:message",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message:send_as_bot",
      "im:resource",
      "wiki:wiki",
      "wiki:wiki:readonly"
    ],
    "user": []
  }
}
```

点击「下一步，确认新增权限」→ 确认即可。

### 4.4 第一次发布（让 Bot 在飞书客户端可见）

1. 点左侧 "版本管理与发布"
2. 点 "创建版本"，填写版本号和更新说明
3. 提交发布（自建应用通常立即生效，不需要审核）

> 这次发布是为了让 Bot 出现在飞书客户端中。此时 Bot 还不能聊天，正常。

### 4.5 去飞书客户端确认 Bot 存在

1. 打开飞书客户端，搜索你刚创建的 Bot 名称
2. 确认能找到（点开后无法聊天，正常）

### 4.6 配置到 OpenClaw

在终端中执行（把 `cli_xxx` 和 `xxx` 替换成你上面复制的实际值）：

```bash
pnpm openclaw config set channels.feishu.appId "cli_你的AppID"
pnpm openclaw config set channels.feishu.appSecret "你的AppSecret"
```

### 4.7 启动 Her

回到运行 `start.sh` 的终端，按 `Ctrl+C` 停止，然后重新运行：

```bash
./start.sh
```

确认终端日志中出现 `Feishu WSClient connected`，说明服务已连接飞书。

### 4.8 配置事件订阅

1. 回到飞书开放平台 → 你的应用 → 点左侧 "事件与回调"
2. 在"订阅方式"中选择 **"使用 长连接 接收事件"** → **保存**
3. 点 "添加事件" → 搜索 `im.message.receive_v1` → 添加

> 为什么选长连接？因为长连接不需要你有公网 IP 或域名，在你的电脑上直接就能用。
>
> 保存失败？说明 Her 服务未启动，确认终端日志有 `Feishu WSClient connected`。

### 4.9 第二次发布

1. 点左侧 "版本管理与发布"
2. 再次 "创建版本" → 提交发布

> 必须再发布一次！第一次发布不包含事件订阅配置，不发布第二次 Bot 收不到消息。

### 4.10 验证

1. 打开飞书客户端
2. 搜索你的机器人名称，打开私聊
3. 发一条消息，比如 "你好"
4. 如果收到回复，说明飞书通道已接通

> 飞书机器人和语音 Her 共享同一个大脑和记忆 — 你在语音里让 Her 记住的事情，飞书里也知道。

---

## Part 5: Docker 多用户（厂商演示）

当你需要给多个厂商人员同时体验 Her 时，用 Docker 为每个人启动一个完全隔离的实例。每个人有自己独立的记忆和对话历史，互不影响，也不会看到你个人 Her 的数据。

### 5.1 确保 Docker Desktop 已启动

菜单栏看到鲸鱼图标就说明在运行。

### 5.2 构建 Docker 镜像（首次约 5-10 分钟）

```bash
./start-docker.sh
```

这会把整个 Her 系统打包成一个 Docker 镜像。只需要做一次，除非代码有更新。

看到以下输出说明成功：

```
✓ 镜像构建完成

═══════════════════════════════════════════════════════════════
  镜像: carher:local
═══════════════════════════════════════════════════════════════
```

### 5.3 启动用户容器

为每个厂商人员启动一个独立的容器：

```bash
# 启动用户 1（默认 Sonnet 模型 + 远程隧道）
./start-user.sh --id=1

# 启动用户 2（指定用 Opus 模型，更聪明但更贵）
./start-user.sh --id=2 --model=opus

# 启动用户 3（指定用 Haiku 模型，最便宜）
./start-user.sh --id=3 --model=haiku
```

每个用户启动后会打印远程 URL，类似：

```
═══════════════════════════════════════════════════════════════
  User 1 — 远程 URL（随机隧道）
═══════════════════════════════════════════════════════════════

  手机/车机版（推荐）：

  https://xxx.trycloudflare.com/mobile.html?proxy=wss%3A%2F%2F...

  桌面版：

  https://xxx.trycloudflare.com?proxy=wss%3A%2F%2F...
═══════════════════════════════════════════════════════════════
```

**把"手机版"那行 URL 发给对应的厂商人员**，他们在手机浏览器（推荐 Chrome）打开就能体验。

### 5.4 可用的模型快捷名

| 快捷名       | 模型                      | 特点           |
| ------------ | ------------------------- | -------------- |
| `sonnet`     | Claude Sonnet 4.6（默认） | 性价比最高     |
| `opus`       | Claude Opus 4.6           | 最聪明，价格高 |
| `or-sonnet`  | 另一 provider 的 Sonnet   | provider 切换  |
| `or-opus`    | 另一 provider 的 Opus     | provider 切换  |
| `haiku`      | Claude 3.5 Haiku          | 最便宜         |
| `gemini-2.5` | Gemini 2.5 Pro            | Google 模型    |
| `gpt-4o`     | GPT-4o                    | OpenAI 模型    |

### 5.5 管理容器

```bash
# 查看用户 1 的后台日志
./start-user.sh --id=1 --logs

# 停止用户 1
./start-user.sh --id=1 --down

# 停止所有用户容器
./start-user.sh --down
```

### 5.6 注意事项

- **每个用户需要一个单独的终端窗口**来运行（因为隧道需要保持在前台）。按 `Ctrl+C` 只会关闭隧道，容器继续运行。
- **同时运行的用户数有限制**：Cloudflare 免费隧道大约支持 ~10 条（每个用户需要 3 条隧道），所以同时约 3 个远程用户。
- **代码更新后重建镜像**：`./start-docker.sh --rebuild`，然后重新启动用户容器。
- **重启某个用户**：直接再次运行 `./start-user.sh --id=N`，脚本会自动清理旧容器并用最新配置启动。

---

## Part 6: 常见问题排查

### "gcloud auth" 过期了

Google Cloud 凭证大约每隔几个月会过期。如果 Her 的语音功能报认证错误，重新运行：

```bash
gcloud auth application-default login
```

重新登录后，重启 Her（`Ctrl+C` 再 `./start.sh`）。

### 端口被占用

如果看到类似 "address already in use" 的错误：

```bash
# 查看谁占用了端口（以 18789 为例）
lsof -i :18789

# 强制释放
kill -9 $(lsof -t -i :18789)
```

`start.sh` 通常会自动处理端口冲突，但如果手动启动过其他服务可能需要手动释放。

### Docker 镜像需要更新

当代码有更新（`git pull`）后：

```bash
# 重新构建镜像（加 --rebuild 跳过缓存）
./start-docker.sh --rebuild

# 然后重新启动用户容器
./start-user.sh --id=1
```

### 隧道建不起来

Cloudflare 免费隧道有数量限制（单 IP 约 10 条）。如果超出限制：

1. 关闭不用的用户隧道（在对应终端按 `Ctrl+C`）
2. 等几分钟让 Cloudflare 释放名额
3. 重试

### OpenRouter 余额不足

后台 AI 调用会消耗 OpenRouter 余额。到 https://openrouter.ai 查看余额并充值。

Sonnet 模型很便宜（约 $3/百万 token），日常使用 $5 能用很久。Opus 贵约 10 倍，演示时注意。

### start.sh 编译失败

确认以下版本：

```bash
node -v    # 需要 v22 以上
pnpm -v    # 需要 v9 以上
```

如果版本不对：

```bash
brew upgrade node
npm install -g pnpm@latest
```

### 飞书机器人没反应

1. 确认 `start.sh` 正在运行，终端日志有 `Feishu WSClient connected`
2. 确认飞书应用已**发布两次**（第一次让 Bot 可见，第二次包含事件订阅）
3. 确认事件订阅选了"长连接"模式（不是 Webhook），且添加了 `im.message.receive_v1`
4. 重新检查 `appId` 和 `appSecret` 是否正确

### 手机浏览器听不到声音

- 推荐使用 **Chrome** 浏览器（Safari 对 WebSocket 音频兼容性较差）
- 确保手机不在静音模式
- 页面加载后可能需要点一下屏幕（浏览器安全策略要求用户交互后才能播放音频）

---

## 快速命令速查表

| 目标                           | 命令                                    |
| ------------------------------ | --------------------------------------- |
| 启动个人 Her                   | `./start.sh`                            |
| 手机远程访问个人 Her           | `./start-mobile.sh --random`            |
| 构建 Docker 镜像               | `./start-docker.sh`                     |
| 启动厂商用户 1                 | `./start-user.sh --id=1`                |
| 启动用户 2（Opus 模型）        | `./start-user.sh --id=2 --model=opus`   |
| 查看用户 1 日志                | `./start-user.sh --id=1 --logs`         |
| 停止用户 1                     | `./start-user.sh --id=1 --down`         |
| 停止所有用户容器               | `./start-user.sh --down`                |
| 重建 Docker 镜像（代码更新后） | `./start-docker.sh --rebuild`           |
| 刷新 Google Cloud 凭证         | `gcloud auth application-default login` |
| 停止个人 Her                   | 在 start.sh 终端按 `Ctrl+C`             |
