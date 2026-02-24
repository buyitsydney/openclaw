# 企业 Her 部署实录

> 部署开始日期：2026-02-24
> 目标：3 台企业服务器部署 200+ Her，先在 186 上验证个人 Her，再迁移董事长 carher-3

---

## 服务器资源

| 编号 | IP           | 用户名 | 用途（规划）                      |
| ---- | ------------ | ------ | --------------------------------- |
| S1   | 10.68.13.186 | cltx   | 首批部署（个人验证 + 董事长迁移） |
| S2   | 10.68.13.187 | cltx   | 后续扩展                          |
| S3   | 10.68.13.188 | cltx   | 后续扩展                          |

> 凭证保存在 `docker/servers.txt`（gitignored），密码不记录在此文档中。

---

## Phase 0: 凭证保存

- [x] `docker/servers.txt` 已创建（gitignored）
- [x] `.gitignore` 已添加 `docker/servers.txt`

## Phase 1: SSH 连接 + 环境探测（S1: 10.68.13.186）

需要确认的项目：

| 检查项                | 预期                       | 实际结果 |
| --------------------- | -------------------------- | -------- |
| OS 版本               | Ubuntu 22.04+ / Debian 12+ |          |
| CPU 核数              | ≥ 16 核                    |          |
| RAM                   | ≥ 64 GB                    |          |
| 磁盘                  | ≥ 500 GB SSD               |          |
| sudo 权限             | cltx 可 sudo               |          |
| Docker                | 已安装 / 需安装            |          |
| Git                   | 已安装 / 需安装            |          |
| Python3               | 已安装 / 需安装            |          |
| Node.js               | 已安装 22+ / 需安装        |          |
| tmux                  | 已安装 / 需安装            |          |
| 公网 - GitHub         | 可访问                     |          |
| 公网 - OpenRouter API | 可访问                     |          |
| 公网 - 飞书 API       | 可访问                     |          |
| 公网 - Google Cloud   | 可访问                     |          |

## Phase 2: 安装必备软件

个人 Her 原生运行 + Docker 容器部署，需要以下软件：

```bash
# Node.js 22+（个人 Her 原生运行）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs

# corepack → pnpm
sudo corepack enable

# Docker（用户容器运行环境）
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker cltx

# 其他工具
sudo apt install -y git python3 tmux
```

## Phase 3: 拉取代码 + 配置密钥

```bash
# 克隆仓库
git clone https://github.com/buyitsydney/CarHer.git
cd CarHer
git checkout dev

# 安装依赖
pnpm install

# 构建
pnpm build
```

密钥传输（从 Mac scp 到服务器）：

```bash
# OpenRouter API Key — 写入服务器 openclaw 配置
mkdir -p ~/.openclaw
# 创建 openclaw.json（含 env.vars.OPENROUTER_API_KEY 等）

# Google Cloud 凭证
scp ~/.config/gcloud/application_default_credentials.json cltx@10.68.13.186:~/.config/gcloud/
```

## Phase 4: 个人 Her 原生验证

```bash
./start.sh
```

验证清单：

- [ ] Gateway 启动成功
- [ ] Webchat 可通过 VPN 访问（`http://10.68.13.186:8000`）
- [ ] 文字对话正常（→ OpenRouter 网络通）
- [ ] 语音测试（→ Google Cloud 网络通）

## Phase 5: 董事长数据迁移（Mac → 企业服务器）

### 5a. Mac 上导出 carher-3 数据卷

```bash
# 不停容器，只读快照导出
docker run --rm \
  -v carher-3-data:/source:ro \
  -v /tmp:/backup \
  alpine tar czf /backup/carher-3-data.tar.gz -C /source .
```

### 5b. 传输到企业服务器

```bash
scp /tmp/carher-3-data.tar.gz cltx@10.68.13.186:/tmp/
```

### 5c. 服务器上创建 Docker 卷并导入

```bash
docker volume create carher-3-data
docker run --rm \
  -v carher-3-data:/target \
  -v /tmp:/backup \
  alpine sh -c 'cd /target && tar xzf /backup/carher-3-data.tar.gz'
```

### 5d. 准备 users.csv

从 Mac 的 `docker/users.csv` 复制董事长行到服务器的 `docker/users.csv`。

## Phase 6: 切换（停 Mac → 启服务器）

**操作顺序**（最小化停机）：

1. 确认服务器一切就绪（数据导入、Docker 镜像构建完成）
2. **停止 Mac carher-3**（需明确许可）
3. 立即在服务器启动：`./start-user.sh --id=3`
4. 确认 `Feishu WSClient connected`
5. 董事长飞书发消息 → AI 回复 → 迁移完成

> 飞书 Bot 无需 IT 改任何配置。App ID / App Secret 不变，WSClient 从新服务器主动连接飞书平台。

**回滚方案**：Mac 上的 carher-3 数据卷不删除，迁移失败可立即在 Mac 重启恢复。

---

## 部署日志

### 2026-02-24

- Phase 0 完成：服务器凭证已保存

<!-- 后续操作记录追加在这里 -->
