# 同事复现 Car Her 完整能力指南

本文档面向**同事在自己电脑上通过 `git pull` 复现 Car Her 全部能力**的场景。

## 你将获得的能力

1. **本地 Her** — 实时语音 AI 助手（Gemini Live 语音 + Claude 大脑）
2. **飞书 Her** — 飞书机器人，文字 + 文档 + 画板 + 群聊归档
3. **Docker 多用户** — 随意启动新用户实例，完全隔离

全程约 30-60 分钟。

---

## 关键原则（必读）

### 1. 零冲突保证

每台电脑是完全独立的环境：

- **Docker 容器**在各自电脑上运行，端口、数据、容器名互不影响
- **飞书机器人**各自申请独立的 App，互不干扰
- **API Key** 可共享同一个 OpenRouter/Google Key（费用共摊），不会冲突
- **`docker/users.csv`** 不在 git 里（`.gitignore`），每台电脑各自维护自己的用户列表

### 2. 唯一信源配置架构

```
docker/shared-config.json5        ← 功能配置（所有环境共用，在 git 里）
       ↓ $include
docker/carher-config.json         ← Docker 基础配置（在 git 里，唯一信源）
       ↓ $include                        ↓ $include
~/.openclaw/openclaw.json         /tmp/carher-config-N.json（Docker 容器）
（本地 Her 配置）                 （per-user 临时配置，自动生成）
```

**规则**：

- `docker/carher-config.json` 和 `docker/shared-config.json5` 是唯一信源，**不要改**
- 本地 Her 的个性化配置通过 `pnpm openclaw config set ...` 命令写入 `~/.openclaw/openclaw.json`
- Docker 用户的个性化配置通过 `docker/users.csv` + `start-user.sh` 自动生成

### 3. 绝对不要改的文件

| 文件                                             | 原因                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| `docker/carher-config.json`                      | 所有环境的基础配置，改了会影响所有人           |
| `docker/shared-config.json5`                     | 共享功能配置，改了会影响所有人                 |
| `start.sh` / `start-user.sh` / `start-tunnel.sh` | 部署脚本，已验证通过                           |
| `extensions/feishu-her/` 的代码                  | 飞书插件源码，只在升级 upstream 时由技术人员改 |
| `extensions/realtime/` 的代码                    | 语音插件源码，同上                             |

---

## Step 0: 前提软件安装

需要以下工具（大部分 `brew install` 一键搞定）：

```bash
# macOS
brew install node@22
npm install -g pnpm
brew install python3
pip3 install websockets google-auth certifi aiohttp requests
brew install google-cloud-sdk
brew install cloudflare/cloudflare/cloudflared
# Docker Desktop: https://www.docker.com/products/docker-desktop/ 下载安装
```

验证所有工具：

```bash
node -v          # 需要 v22+
pnpm -v          # 需要 v9+
python3 --version
gcloud --version
cloudflared --version
docker --version
```

> 详细说明见 [getting-started.md Part 0](/her/getting-started#part-0-安装前提软件一次性)

---

## Step 1: 拉取代码

```bash
# 克隆仓库（如果还没有）
git clone https://github.com/buyitsydney/CarHer.git openclaw
cd openclaw

# 切换到 dev 分支（主力开发分支）
git checkout dev
git pull

# 安装依赖 + 编译
pnpm install
pnpm build
```

---

## Step 2: 配置 API Key

### 2.1 OpenRouter Key（后台 AI 大脑）

你会通过飞书收到 OpenRouter API Key（格式 `sk-or-v1-...`）。

```bash
# 写入环境变量（永久生效）
echo 'export OPENROUTER_API_KEY=sk-or-v1-你收到的key' >> ~/.zshrc
source ~/.zshrc

# 写入 OpenClaw 配置
pnpm openclaw config set env.vars.OPENROUTER_API_KEY "$OPENROUTER_API_KEY"
```

### 2.2 Google Cloud 凭证（语音功能，可选）

> **不需要语音功能？跳过这一整节。** 本地 Her（`start.sh`）不依赖 Google 凭证，没有也能正常启动，只是语音功能不可用。
>
> **但如果要用 Docker 多用户**（`start-user.sh`），当前脚本会强制检查 ADC 文件，没有就 `exit 1` 退不过去。解决办法见下方"Docker 跳过 Google 检查"。

语音功能用 Google Gemini Live API，需要两样东西：

**A. ADC 凭证文件**

ADC（Application Default Credentials）是 Google Cloud 的标准认证文件，每个人必须用自己的 Google 账号生成（里面绑定了个人 refresh_token，不能共用）：

```bash
brew install google-cloud-sdk       # 安装 gcloud CLI
gcloud auth login                    # 登录 Google 账号（弹浏览器）
gcloud auth application-default login  # 生成 ADC 文件（再弹一次授权）
```

执行后自动生成 `~/.config/gcloud/application_default_credentials.json`。

> **前提**：你的 Google 账号需要有 Gemini 项目的访问权限。让管理员在 [Google Cloud Console IAM](https://console.cloud.google.com/iam-admin/iam) 页面把你加为项目成员（Editor 角色）。

**B. Gemini 项目 ID**（写入 OpenClaw 配置）

```bash
pnpm openclaw config set plugins.entries.realtime.config.gemini.projectId "收到的project-id"
pnpm openclaw config set plugins.entries.realtime.config.gemini.model "gemini-live-2.5-flash-native-audio"
```

**Docker 跳过 Google 检查（不需要语音时）**

如果你不需要语音功能但想用 Docker 多用户，需要创建一个空的 ADC 占位文件让脚本通过检查：

```bash
mkdir -p ~/.config/gcloud
echo '{}' > ~/.config/gcloud/application_default_credentials.json
```

> 这样 `start-user.sh` 不会 exit 1。容器启动后语音功能不可用（因为凭证无效），但飞书、文字聊天、Web UI 全部正常。

---

## Step 3: 初始化本地 Her

```bash
# 初始化 OpenClaw（创建 ~/.openclaw/ 目录和基础配置）
pnpm openclaw init

# 配置本地 Her 使用 docker/carher-config.json 作为基础（唯一信源）
# 这一步让你的本地配置通过 $include 继承基础配置
pnpm openclaw config set '$include' './docker/carher-config.json' --cwd "$(pwd)"
```

> **重要**：`$include` 的路径是相对于仓库根目录的。OpenClaw 会自动 deep merge 基础配置和你的本地覆盖。

---

## Step 4: 启动本地 Her

```bash
./start.sh
```

启动后会看到：

```
═══════════════════════════════════════════════════════════════
  Gateway:  http://localhost:18789
  Realtime: http://localhost:18790 (WebSocket: ws://localhost:18790/ws)
  Live UI:  http://localhost:8000 (Proxy WS: ws://localhost:8080)
═══════════════════════════════════════════════════════════════
```

### 验证本地 Her

1. **Web UI**：打开 `http://localhost:18789/?token=你的token`（终端输出里有完整 URL）
2. **语音**：打开 `http://localhost:8000/mobile.html?proxy=ws://localhost:8080&...`（终端输出里有完整 URL）
3. **检查日志**：
   - `Feishu WSClient connected` — 飞书连接成功
   - `[realtime] Server listening on port 18790` — 语音服务就绪
   - `listening on ws://0.0.0.0:18789` — Gateway 就绪

---

## Step 5: 接入你自己的飞书机器人

> 每个同事必须用**自己的飞书账号**创建独立的飞书应用，不能共用。

### 5.1 创建飞书自建应用

1. 打开 https://open.feishu.cn → 创建应用 → 企业自建应用
2. 填写名称（如"Her-你的名字"）→ 确定

### 5.2 获取凭证

在应用的"凭证与基础信息"页面，复制：

- **App ID**（格式 `cli_xxx`）
- **App Secret**（一长串字符）

### 5.3 添加权限

在"权限管理"页面，搜索并添加以下权限：

| 权限                                | 用途                 |
| ----------------------------------- | -------------------- |
| `im:message:send_as_bot`            | 以机器人身份发消息   |
| `im:message`                        | 获取与发送消息       |
| `im:message.group_at_msg`           | 群聊@消息            |
| `im:message.group_at_msg:readonly`  | 读取群聊@消息        |
| `im:message.p2p_msg`                | 私聊消息             |
| `im:message.p2p_msg:readonly`       | 读取私聊消息         |
| `im:resource`                       | 获取消息中的资源文件 |
| `contact:user.employee_id:readonly` | 读取用户 ID          |

如果需要飞书文档/多维表格/知识库工具，额外添加：

| 权限                               | 用途       |
| ---------------------------------- | ---------- |
| `docs:doc:readonly`                | 读取文档   |
| `wiki:wiki:readonly`               | 读取知识库 |
| `drive:drive:readonly`             | 读取云盘   |
| `bitable:bitable`                  | 多维表格   |
| `im:chat:readonly`                 | 群聊列表   |
| `contact:department.base:readonly` | 部门通讯录 |
| `contact:user.base:readonly`       | 用户通讯录 |

### 5.4 启用机器人能力

在"应用能力"页面，添加"机器人"能力。

### 5.5 第一次发布

版本管理与发布 → 创建版本 → 提交发布。

### 5.6 配置事件订阅

1. 事件与回调 → 订阅方式 → 选择**"使用长连接接收事件"** → 保存
2. 添加事件 → 搜索 `im.message.receive_v1` → 添加

### 5.7 第二次发布

再次创建版本 → 提交发布（包含事件订阅配置）。

### 5.8 写入 OpenClaw 配置

```bash
pnpm openclaw config set channels.feishu.appId "cli_你的AppID"
pnpm openclaw config set channels.feishu.appSecret "你的AppSecret"
```

### 5.9 重启本地 Her

```bash
# 在 start.sh 终端按 Ctrl+C，然后重新启动
./start.sh
```

确认日志出现 `Feishu WSClient connected`，然后在飞书里给你的机器人发消息测试。

---

## Step 6: Docker 多用户

### 6.1 构建 Docker 镜像

```bash
./start-docker.sh
```

首次约 5-10 分钟。看到 `✓ 镜像构建完成` 说明成功。

### 6.2 创建你的 `docker/users.csv`

这个文件不在 git 里，你需要自己创建：

```bash
cat > docker/users.csv << 'EOF'
id,name,model,feishu_app_id,feishu_app_secret,feishu_owner_open_id,provider,note
EOF
```

格式说明：

- `id`：用户编号（1-999），**你电脑上的 ID 只要不和自己重复就行**，不同电脑之间不会冲突
- `name`：用户名称（仅标注用）
- `model`：模型选择（留空用默认 sonnet）
- `feishu_app_id`：飞书 App ID（如果这个用户需要飞书机器人）
- `feishu_app_secret`：飞书 App Secret
- `feishu_owner_open_id`：飞书用户 open_id（可选，用于 DM 白名单）
- `provider`：`anthropic` 或 `openrouter`（留空默认 `openrouter`）
- `note`：备注

**示例**：

```csv
id,name,model,feishu_app_id,feishu_app_secret,feishu_owner_open_id,provider,note
1,我的测试,sonnet,cli_xxx,secret_xxx,ou_xxx,anthropic,我自己的测试用户
2,同事A演示,opus,,,,,无飞书的演示用户
```

### 6.3 启动用户容器

```bash
# 启动用户 1
./start-user.sh --id=1

# 启动用户 2（指定模型）
./start-user.sh --id=2 --model=opus
```

### 6.4 端口分配（自动，无需手动配置）

| 用户 ID | Gateway           | Frontend | WS Proxy |
| ------- | ----------------- | -------- | -------- |
| 1       | 29001             | 29003    | 29004    |
| 2       | 29011             | 29013    | 29014    |
| 3       | 29021             | 29023    | 29024    |
| 4       | 29031             | 29033    | 29034    |
| N       | 29000+(N-1)\*10+1 | +3       | +4       |

每个用户有 10 个端口的间隔，绝对不会冲突。

### 6.5 管理命令

```bash
./start-user.sh --id=1 --logs   # 查看日志
./start-user.sh --id=1 --down   # 停止用户
./start-user.sh --down           # 停止所有用户
```

---

## Step 7: 远程访问（可选）

如果需要从手机/外网访问，需要配置 Cloudflare 隧道。

### 方案 A：随机隧道（最简单，URL 每次变）

`start-user.sh` 启动 Docker 用户时会自动创建随机隧道，终端输出里有 URL。

### 方案 B：固定隧道（需要自己的域名）

1. 注册 Cloudflare 账号 + 添加域名
2. 登录 cloudflared：

```bash
cloudflared tunnel login
cloudflared tunnel create 你的隧道名
```

3. 创建 `~/.cloudflared/config.yml`，参考格式：

```yaml
tunnel: 你的隧道ID
credentials-file: /Users/你的用户名/.cloudflared/你的隧道ID.json

ingress:
  - hostname: her.你的域名.com
    service: http://localhost:8000
  - hostname: proxy.你的域名.com
    service: http://localhost:8080
  - service: http_status:404
```

4. 启动隧道：`./start-tunnel.sh`

---

## 完整验证清单

在设置完成后，逐项检查：

```
本地 Her:
- [ ] ./start.sh 启动成功
- [ ] 日志显示 "listening on ws://0.0.0.0:18789"
- [ ] 日志显示 "[realtime] Server listening on port 18790"
- [ ] http://localhost:8000 能打开语音页面
- [ ] http://localhost:18789/?token=xxx 能打开 Web UI
- [ ] 语音页面点击后能对话（测试 Gemini Live 连接）

飞书 Her:
- [ ] 日志显示 "Feishu WSClient connected"
- [ ] 飞书私聊发消息能收到回复
- [ ] 飞书文档读取正常（发文档链接测试）

Docker 多用户:
- [ ] ./start-docker.sh 镜像构建成功
- [ ] ./start-user.sh --id=101 启动成功
- [ ] docker logs carher-101 无 error/fatal
- [ ] docker logs carher-101 显示 "Feishu WSClient connected"（如有飞书配置）
- [ ] 用户之间数据完全隔离
```

---

## 常见问题

### Q: `pnpm build` 报错

确认 Node.js 版本 v22+，pnpm v9+：

```bash
node -v && pnpm -v
```

### Q: 语音功能报 Google 认证错误

重新设置 Google Cloud 凭证：

```bash
gcloud auth application-default login
# 或重新复制凭证文件到 ~/.config/gcloud/application_default_credentials.json
```

### Q: 飞书机器人没反应

1. 确认 `start.sh` 正在运行，日志有 `Feishu WSClient connected`
2. 确认飞书应用已**发布两次**（第一次让 Bot 可见，第二次包含事件订阅）
3. 确认事件订阅选了"长连接"模式，添加了 `im.message.receive_v1`
4. 检查 `appId` 和 `appSecret` 是否正确

### Q: Docker 容器启动失败

```bash
# 查看日志
docker logs carher-101

# 常见原因：
# 1. Docker Desktop 没启动
# 2. 镜像没构建（先运行 ./build-image.sh）
# 3. 端口被占用（lsof -i :29001）
```

### Q: git pull 后代码更新了

```bash
pnpm install          # 重新安装依赖
pnpm build            # 重新编译
./start.sh            # 重启本地 Her
./start-docker.sh     # 重建 Docker 镜像（如果需要）
./start-user.sh --id=N  # 重启 Docker 用户（自动检测镜像变化）
```

### Q: 不同电脑的 Docker 用户 ID 会冲突吗

**不会**。Docker 容器、端口、数据卷都是本地的，不同电脑上用相同的 ID（如都用 `--id=1`）完全没问题。冲突只会发生在同一台电脑上使用相同 ID。

---

## 文件清单：哪些在 git 里，哪些不在

| 文件                         | 在 git 里 | 说明                                            |
| ---------------------------- | --------- | ----------------------------------------------- |
| `docker/carher-config.json`  | ✅        | 基础配置（唯一信源），不要改                    |
| `docker/shared-config.json5` | ✅        | 共享功能配置，不要改                            |
| `docker/users.csv`           | ❌        | 每台电脑自己维护用户列表                        |
| `docker/workspace/`          | ❌        | 工作区模板（可选）                              |
| `~/.openclaw/openclaw.json`  | ❌        | 本地配置（`pnpm openclaw config set` 自动生成） |
| `~/.config/gcloud/`          | ❌        | Google Cloud 凭证                               |
| `~/.cloudflared/`            | ❌        | Cloudflare 隧道凭证                             |
| `start.sh` / `start-user.sh` | ✅        | 启动脚本，不要改                                |
| `extensions/feishu-her/`     | ✅        | 飞书插件代码，不要改                            |
| `extensions/realtime/`       | ✅        | 语音插件代码，不要改                            |
