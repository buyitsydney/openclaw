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

| 检查项                | 预期                       | 实际结果                        |
| --------------------- | -------------------------- | ------------------------------- |
| OS 版本               | Ubuntu 22.04+ / Debian 12+ | Ubuntu 22.04.5 LTS (Jammy)      |
| CPU 核数              | ≥ 16 核                    | 16 核                           |
| RAM                   | ≥ 64 GB                    | 62 GB                           |
| 磁盘（根盘）          | ≥ 500 GB SSD               | **39 GB（剩 21G）— 不足！**     |
| 磁盘（扩展 /Data）    | ≥ 500 GB                   | 492GB HDD 已挂载，cltx 可写     |
| sudo 权限             | cltx 可 sudo               | 有（hostname 解析警告，不影响） |
| Docker                | 已安装 / 需安装            | Docker 28.2.2 已安装            |
| Git                   | 已安装 / 需安装            | git 2.34.1 已安装               |
| Python3               | 已安装 / 需安装            | Python 3.10.12 已安装           |
| Node.js               | 已安装 22+ / 需安装        | v22.22.0 已安装                 |
| corepack              | 已启用                     | 0.34.0 已启用（pnpm 可用）      |
| tmux                  | 已安装 / 需安装            | tmux 3.2a 已安装                |
| 公网 - GitHub         | 可访问                     | OK                              |
| 公网 - OpenRouter API | 可访问                     | OK                              |
| 公网 - 飞书 API       | 可访问                     | OK                              |
| 公网 - Google Cloud   | 可访问                     | OK（网络可达，凭证已传输）      |

> **磁盘计划**：根盘仅 39GB，企业将增加 1TB HDD。HDD 对本场景可行（AI 推理在云端，容器运行时是网络密集型非磁盘密集型）。挂载后需将 Docker 数据目录（`/var/lib/docker`）和用户数据迁移到新盘。首个 Her 验证可在根盘先跑（单容器约 2-3GB 含镜像）。
>
> **OpenRouter 企业 Key 验证**：2026-02-24 已在服务器上用企业 Key（Autolink-Her）成功调用 `anthropic/claude-opus-4.6`，确认 IP 无封禁、API 通畅。
>
> **Google Cloud API**：服务器可访问 `us-central1-aiplatform.googleapis.com`（网络通），但凭证文件尚未传输到服务器。

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
- Phase 1 完成：三台服务器环境探测完成
  - 所有服务器: Ubuntu 22.04, 16核, 62GB RAM, Docker 28.2.2
  - /Data 数据盘 492GB 已挂载（三台都有）
  - OpenRouter API 验证通过（企业 Key，IP 无封禁）
  - Google Cloud API 网络可达
- S1 (186) 环境配置完成:
  - [x] /Data 权限修复 (chown cltx:cltx)
  - [x] tmux 安装
  - [x] pnpm 安装
  - [x] Docker Buildx v0.19.3 安装
  - [x] Docker data-root 迁移到 /Data/docker
  - [x] cltx 加入 docker 组
  - [x] 代码打包 scp 到 /Data/CarHer（68MB tarball，非 git clone）
  - [x] git init + commit（start-user.sh 需要 git hash）
  - [x] OpenRouter 企业 Key 配置到 ~/.openclaw/openclaw.json
  - [x] Google Cloud 凭证 scp 到 ~/.config/gcloud/
  - [x] Docker 镜像 carher:local 首次构建成功（约 6 分钟）
- 首批用户表创建（13 人，全 VIP 用 opus）:
  - ID 1: 老杨（董事长，从 Mac 迁移，cli_a9054f702c789bd9）
  - ID 2-11: 李金龙/洪源/郭振华/周哲人/庄乾军/霍百林/徐敏/车联共用/运营部/商文胜
  - ID 12: test（测试用，cli_a917fa892ff91bb5）
  - ID 13: 卜弋天（部署验证，cli_a917e5525178dbb3）
  - 凭证保存: docker/servers.txt（gitignored）
  - users.csv 已上传到 S1
- 容器启动验证:
  - [x] carher-12 (test): opus 模型，Gateway 30s 就绪，飞书 ws 已连接，端口 GW=29111
  - [x] carher-13 (卜弋天): opus 模型，Gateway 29s 就绪，飞书 ws 已连接，端口 GW=29121
  - [x] 内存限制 2GB/容器（start-user.sh 加 --memory=2g）
  - [x] **飞书消息收发验证通过！**（IT 配置长连接 + 发布 Bot 后两个 Bot 都能正常对话）
  - Webchat 访问需带 token: http://10.68.13.186:<PORT>?token=<见 servers.txt:WEBCHAT_TOKEN>
  - WARNING: GEMINI_PROJECT_ID 未配置（语音功能暂不可用，需补 gemini 配置）
- 实测资源占用:
  - 单容器内存: ~560 MiB（2GB 限制内）
  - 单容器 CPU: < 0.01%（空闲时）
  - 单容器进程数: 13
  - 服务器总内存占用: 2.7G / 62G（含系统+Docker 引擎+2 容器）

- S1 VIP 容器批量启动:
  - [x] carher-2 (李金龙): opus, 飞书连通, GW=29011
  - [x] carher-3 (洪源): opus, 飞书连通, GW=29021
  - [x] carher-4 (郭振华): opus, 飞书连通, GW=29031
  - [x] carher-5 (周哲人): opus, 飞书连通, GW=29041
  - users.csv 凭证已逐行核对，与原始数据完全一致

#### 三台服务器分配方案

| 服务器   | 用户                                                       | 数量                  |
| -------- | ---------------------------------------------------------- | --------------------- |
| S1 (186) | ID 2-5 (金龙/洪源/振华/哲人) + ID 12 (test) + ID 13 (弋天) | 6 运行中              |
| S2 (187) | ID 6,7,8,9,11 (乾军/百林/徐敏/车联/文胜)                   | 待环境就绪            |
| S3 (188) | ID 10 (运营/徐协邦)                                        | 待环境就绪            |
| 最后迁移 | ID 1 (老杨/董事长) → S1                                    | Mac carher-3 数据迁移 |

#### Webchat URL（已运行容器）

所有 URL 格式: `http://10.68.13.186:<PORT>?token=<见 servers.txt:WEBCHAT_TOKEN>`

| ID  | 姓名   | 端口  |
| --- | ------ | ----- |
| 2   | 李金龙 | 29011 |
| 3   | 洪源   | 29021 |
| 4   | 郭振华 | 29031 |
| 5   | 周哲人 | 29041 |
| 12  | test   | 29111 |
| 13  | 卜弋天 | 29121 |

#### Admin Her（原生，非 Docker）

在 S1 上部署了一个原生运行的管理员 Her，用于部署者自己使用，独立于所有 Docker 容器。

| 项目     | 值                                                              |
| -------- | --------------------------------------------------------------- |
| 运行方式 | `nohup node dist/index.js gateway run` (PID 161057)             |
| 模型     | Claude Sonnet 4.6 (openrouter)                                  |
| Webchat  | `http://10.68.13.186:18789/?token=<见 servers.txt:ADMIN_TOKEN>` |
| 端口     | 18789（与 Docker 容器 29xxx 不冲突）                            |
| 配置     | `~/.openclaw/openclaw.json`（`$include` shared-config.json5）   |
| 日志     | `/tmp/admin-her.log`                                            |
| 数据     | `~/.openclaw/`（独立于 Docker named volumes）                   |
| 飞书     | 未绑定（纯 Webchat）                                            |
| 记忆同步 | 已从 Mac 本地 Her 同步 MEMORY/USER/SOUL/IDENTITY + 1060 session |

> 进程通过 `nohup` 后台运行，SSH 断开不影响。服务器重启后需手动启动：
> `cd /Data/CarHer && nohup node dist/index.js gateway run --port 18789 --bind lan > /tmp/admin-her.log 2>&1 &`

#### S1 资源状态（6 Docker + 1 原生，2026-02-24 17:30）

| 指标           | 值                                                                     |
| -------------- | ---------------------------------------------------------------------- |
| RAM 已用       | 4.9 Gi / 62 Gi（8%）                                                   |
| RAM 可用       | 57 Gi                                                                  |
| Gateway 总内存 | 3.3 GB（7 进程，平均 ~470 MB/个）                                      |
| /Data 磁盘     | 8.9 GB / 492 GB（2%）                                                  |
| 根盘           | 17 GB / 39 GB（46%）                                                   |
| 容量预估       | 可稳定运行 **~40-50 容器**（按 500MB 实际 + 2GB 上限 + 12GB 系统预留） |

- S2 (187) 环境配置完成:
  - [x] Node.js v22.14.0 + npm 10.9.2 + pnpm 10.30.2（二进制安装，绕过 apt 依赖冲突）
  - [x] Docker Buildx v0.19.3 已安装
  - [x] Docker data-root 迁移到 /Data/docker
  - [x] 代码部署到 /Data/CarHer + git init
  - [x] OpenRouter 企业 Key 配置到 ~/.openclaw/openclaw.json
  - [x] Google Cloud 凭证配置
  - [x] Docker 镜像 carher:local 构建成功
  - [x] users.csv 已更新（13 企业用户）

- S3 (188) 环境配置完成:
  - [x] Node.js v22.14.0 + npm 10.9.2 + pnpm 10.30.2（二进制安装）
  - [x] Docker Buildx v0.19.3 已安装
  - [x] /Data 权限修复 (chown cltx:cltx)
  - [x] Docker data-root 迁移到 /Data/docker
  - [x] cltx 加入 docker 组
  - [x] 代码部署到 /Data/CarHer + git init
  - [x] OpenRouter 企业 Key 配置到 ~/.openclaw/openclaw.json
  - [x] Google Cloud 凭证配置
  - [x] Docker 镜像 carher:local 构建成功
  - [x] users.csv 已更新（13 企业用户）

- S2 容器批量启动:
  - [x] carher-6 (庄乾军): opus, 飞书连通, GW=29051
  - [x] carher-7 (霍百林): opus, 飞书连通, GW=29061
  - [x] carher-8 (徐敏): opus, 飞书连通, GW=29071
  - [x] carher-9 (洪源/车联): opus, 飞书连通, GW=29081
  - [x] carher-11 (商文胜): opus, 飞书连通, GW=29101

- S3 容器启动:
  - [x] carher-10 (徐协邦/运营): opus, 飞书连通, GW=29091

#### 三台服务器最终状态（2026-02-24 18:22）

| 服务器   | 容器      | 用户         | 状态    |
| -------- | --------- | ------------ | ------- |
| S1 (186) | carher-2  | 李金龙       | Running |
| S1 (186) | carher-3  | 洪源         | Running |
| S1 (186) | carher-4  | 郭振华       | Running |
| S1 (186) | carher-5  | 周哲人       | Running |
| S1 (186) | carher-12 | test         | Running |
| S1 (186) | carher-13 | 卜弋天       | Running |
| S2 (187) | carher-6  | 庄乾军       | Running |
| S2 (187) | carher-7  | 霍百林       | Running |
| S2 (187) | carher-8  | 徐敏         | Running |
| S2 (187) | carher-9  | 洪源(车联)   | Running |
| S2 (187) | carher-11 | 商文胜       | Running |
| S3 (188) | carher-10 | 徐协邦(运营) | Running |

#### Webchat URL 汇总

S1: `http://10.68.13.186:<PORT>?token=<见 servers.txt:WEBCHAT_TOKEN>`

| ID  | 姓名   | GW 端口 | FE 端口 |
| --- | ------ | ------- | ------- |
| 2   | 李金龙 | 29011   | 29013   |
| 3   | 洪源   | 29021   | 29023   |
| 4   | 郭振华 | 29031   | 29033   |
| 5   | 周哲人 | 29041   | 29043   |
| 12  | test   | 29111   | 29113   |
| 13  | 卜弋天 | 29121   | 29123   |

S2: `http://10.68.13.187:<PORT>?token=<见 servers.txt:WEBCHAT_TOKEN>`

| ID  | 姓名       | GW 端口 | FE 端口 |
| --- | ---------- | ------- | ------- |
| 6   | 庄乾军     | 29051   | 29053   |
| 7   | 霍百林     | 29061   | 29063   |
| 8   | 徐敏       | 29071   | 29073   |
| 9   | 洪源(车联) | 29081   | 29083   |
| 11  | 商文胜     | 29101   | 29103   |

S3: `http://10.68.13.188:<PORT>?token=<见 servers.txt:WEBCHAT_TOKEN>`

| ID  | 姓名         | GW 端口 | FE 端口 |
| --- | ------------ | ------- | ------- |
| 10  | 徐协邦(运营) | 29091   | 29093   |

#### Git 同步 + 敏感信息清理（2026-02-24 20:30）

- [x] GitHub Deploy Keys 配置（S1/S2/S3 三台服务器只读 deploy key）
- [x] `docker/servers.txt` 集中管理所有 token（Webchat、Admin、Voice per-container）
- [x] `enterprise-deploy-log.md` 脱敏（真实 token 替换为 `<见 servers.txt>` 引用）
- [x] `compaction-param-sweep-test.md` 脱敏（token 替换为 `<CONTAINER_TOKEN>` 占位符）
- [x] `.gitignore` 新增 `docker/*.bak*`、`._*`、`docker/server.env` 规则
- [x] git rm 误入库的 bak 文件（含飞书 App Secret 的 users.csv.bak）
- [x] S1: git remote → GitHub，`git pull` 对齐到 Mac HEAD
- [x] S2: git 重建（删旧 .git → clone origin/dev），代码同步完成
- [x] S2: 5 容器重启（carher-6~9,11）with `TUNNEL_HOST_PREFIX=s2-` ✅
- [x] S3: git 重建 + 1 容器重启（carher-10）✅

**server.env 机制**（代码统一，配置分离）：

`start-user.sh` 启动时自动 `source docker/server.env`（gitignored），取代之前的 `.bashrc export` hack。各服务器独立配置，Mac 无需该文件。

| 服务器 | `docker/server.env`        |
| ------ | -------------------------- |
| S1     | `TUNNEL_HOST_PREFIX="s1-"` |
| S2     | `TUNNEL_HOST_PREFIX="s2-"` |
| S3     | `TUNNEL_HOST_PREFIX="s3-"` |

端到端验证通过（2026-02-24 20:45）：

| 项目           | S1 (186)       | S2 (187)       | S3 (188)       |
| -------------- | -------------- | -------------- | -------------- |
| git HEAD       | `9f2cdad8c` ✅ | `9f2cdad8c` ✅ | `9f2cdad8c` ✅ |
| server.env     | `s1-` ✅       | `s2-` ✅       | `s3-` ✅       |
| 容器数         | 7 运行 ✅      | 5 运行 ✅      | 1 运行 ✅      |
| --memory=2g    | 2GB ✅         | 2GB ✅         | 2GB ✅         |
| VOICE 域名前缀 | `s1-` ✅       | `s2-` ✅       | `s3-` ✅       |

- [x] ~~S2/S3 容器内存限制统一设为 2GB~~ → 已完成（所有容器 2147483648 bytes = 2GB）

#### 待完成

- [ ] 董事长数据迁移（Phase 5: Mac carher-3 → 企业 carher-1）
- [ ] 飞书 Bot 后台配置"长连接接收事件"（需 IT 管理员操作，所有 13 个 Bot）
- [ ] 飞书 Bot 发布上线（版本管理 → 创建版本 → 申请上线）
- [ ] 68 个权限审批通过
- [ ] 用户首次发消息后获取 ou_xxx open_id，回填 users.csv
- [x] ~~补充 GEMINI_PROJECT_ID 到 ~/.openclaw/openclaw.json（语音功能）~~ → 已完成
- [ ] start-user.sh webchat URL 不显示 token 的 bug 修复
- [ ] Admin Her 配置开机自启（systemd service 或 crontab @reboot）
- [ ] per-container 独立随机 token（当前所有容器共享同一 webchat token）
- [x] ~~其他容器（carher-2~5, 13）重启以启用 voice 和新域名前缀~~ → 已完成（2026-02-24 18:30）
- [ ] S2/S3 cloudflared 部署（复制 S1 方案）
- [x] ~~S2/S3 容器内存限制统一设为 2GB~~ → 已完成（2026-02-24 20:45，git sync 重启时一并生效）

#### Cloudflare Tunnel（S1，2026-02-24 18:00）

| 项目       | 值                                                              |
| ---------- | --------------------------------------------------------------- |
| 隧道名     | `carher-s1`                                                     |
| 隧道 UUID  | `d18effca-6456-4b6c-b735-94dbbdc83299`                          |
| 运行方式   | 原生 cloudflared + systemd（非 Docker）                         |
| 版本       | cloudflared 2026.2.0                                            |
| 连接数     | 4 QUIC（nrt10, nrt08, nrt15 等日本节点）                        |
| 内存       | 22 MB                                                           |
| 域名前缀   | `s1-`（通过 `TUNNEL_HOST_PREFIX` 环境变量）                     |
| 域名格式   | `s1-uN-fe.carher.net` / `s1-uN-proxy.carher.net`                |
| config.yml | `/etc/cloudflared/config.yml`（ID 1-50 预生成，100 条 ingress） |
| DNS        | 已创建 ID 1-5, 12, 13 + vendor + admin 的 CNAME（共 18 条）     |
| 凭证       | `/etc/cloudflared/d18effca-*.json`（从 Mac cert.pem 派生）      |

> 开机自启：`systemctl enable cloudflared`（已配置）。
> 新增用户时需两步：(1) 在 S1 运行 `cloudflared tunnel route dns carher-s1 s1-uN-fe.carher.net` + proxy，(2) `start-user.sh --id=N`。

验证通过（carher-12 test 容器）：

- `https://s1-u12-fe.carher.net/` → 200 OK
- `https://s1-u12-fe.carher.net/api/realtime/bootstrap?token=<correct>` → Gemini config 完整返回
- `https://s1-u12-fe.carher.net/api/realtime/bootstrap?token=wrong` → 401 Unauthorized
- `/voice` 命令生成的 URL 自动使用 `s1-u12-fe.carher.net` 域名
- `/voice reset` 和 `start-user.sh --id=12 --reset` 均可重置 token

全量容器 Voice 验证通过（2026-02-24 18:30）：

| 容器      | 用户   | Tunnel URL                   | Bootstrap        | 飞书连接    | VOICE 环境变量          |
| --------- | ------ | ---------------------------- | ---------------- | ----------- | ----------------------- |
| carher-2  | 李金龙 | `s1-vendor-fe.carher.net` ✅ | Gemini config ✅ | WSClient ✅ | `s1-vendor-fe/proxy` ✅ |
| carher-3  | 董事长 | `s1-u3-fe.carher.net` ✅     | Gemini config ✅ | WSClient ✅ | `s1-u3-fe/proxy` ✅     |
| carher-4  | 李玮   | `s1-u4-fe.carher.net` ✅     | Gemini config ✅ | WSClient ✅ | `s1-u4-fe/proxy` ✅     |
| carher-5  | 陈亮   | `s1-u5-fe.carher.net` ✅     | Gemini config ✅ | WSClient ✅ | `s1-u5-fe/proxy` ✅     |
| carher-12 | 测试   | `s1-u12-fe.carher.net` ✅    | Gemini config ✅ | WSClient ✅ | `s1-u12-fe/proxy` ✅    |
| carher-13 | 义天   | `s1-u13-fe.carher.net` ✅    | Gemini config ✅ | WSClient ✅ | `s1-u13-fe/proxy` ✅    |

carher-13 实际语音会话测试（2026-02-24 18:25）：

- `/voice` → URL 发送成功
- 会话 1：10:26:01 → 10:26:44（43s，正常断开）
- 会话 2：10:26:47 → 10:28:52（2m5s，正常断开）
- 无错误，资源完全释放

#### Gemini 语音配置

| 项目       | 值                                                                |
| ---------- | ----------------------------------------------------------------- |
| Project ID | `gen-lang-client-0519229117`                                      |
| Model      | `gemini-live-2.5-flash-native-audio`                              |
| 配置位置   | `~/.openclaw/openclaw.json` + `docker/carher-config.json`         |
| 凭证       | `~/.config/gcloud/application_default_credentials.json`（已传输） |

> `start-user.sh` 自动从宿主机 `~/.openclaw/openclaw.json` 读取 Gemini 配置并 bake 到每个容器的 per-user config 中。容器重启后生效。

#### Admin Her 语音状态（2026-02-24 18:40 已开通）

| 项目                       | 状态                                                      |
| -------------------------- | --------------------------------------------------------- |
| Realtime 插件              | ✅ 已启动（port 18790）                                   |
| Bootstrap API              | ✅ 外网可用（完整 Gemini 配置）                           |
| `.voice-token`             | ✅ 见 `servers.txt:VOICE_TOKEN_ADMIN`                     |
| Python WS 代理 (server.py) | ✅ 运行中（8000/8080）                                    |
| Cloudflare 隧道路由        | ✅ `s1-admin-fe.carher.net` / `s1-admin-proxy.carher.net` |
| VOICE 环境变量             | ✅ `VOICE_FE_HOST=s1-admin-fe.carher.net`                 |
| tmux 会话                  | `admin-her`（gateway + server.py）                        |

验证通过：

- `https://s1-admin-fe.carher.net/` → 200 OK
- Bootstrap API with token → Gemini config（model、2 tools、2686 chars prompt）
- Bootstrap API with wrong token → 401 Unauthorized
- `https://s1-admin-proxy.carher.net/` → 426（WS 升级预期，隧道路由正确）

语音 URL：`https://s1-admin-fe.carher.net/?token=<见 servers.txt:VOICE_TOKEN_ADMIN>`

> Admin Her 无飞书 bot，语音通过直接 URL 访问。
> 启动脚本：`/tmp/start-admin-her.sh`，tmux session `admin-her`。
> ⚠️ 注意：Admin Her 开机不会自启，需手动 `tmux new-session -d -s admin-her "bash /tmp/start-admin-her.sh"`。

---

## 2026-02-24：Owner 机制发现与修复

### 问题现象

carher-12（测试共享 bot）用户反馈 cron 不可用。AI 回复"没有 cron 工具"，被迫用 `exec` 执行 `openclaw cron list` 作为 fallback（也失败了）。

### 根因分析（两层独立问题）

| 层                      | 问题                                   | 影响                                            | 修复                                                   |
| ----------------------- | -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Layer 1：Device Pairing | `paired.json` 缺少完整 operator scopes | 所有 gateway 工具失败（"pairing required"）     | `docker/fix-device-pairing.js`（已集成 start-user.sh） |
| Layer 2：Owner 身份     | 发送者未被识别为 Owner                 | cron/gateway 等 ownerOnly 工具被过滤，AI 看不到 | `dm.allowFrom` 或 `commands.ownerAllowFrom`            |

Layer 1 在上一轮修复完成。Layer 2 是本次发现的新问题。

### 关键发现

1. `cron` 等工具标记 `ownerOnly: true`，非 Owner 的发送者工具列表会被过滤
2. Owner 身份由 `dm.allowFrom` 或 `commands.ownerAllowFrom` 中的具体 open_id 匹配决定
3. **`["*"]` 不等于所有人是 Owner** — `*` 触发 allowAll 路径，跳过 Owner 匹配
4. CLI `agent` 命令硬编码 `senderIsOwner: true`，因此 CLI 测试无法验证此机制
5. 配置为空 → 所有人都能聊天 → 但无人是 Owner → cron 不可见

### 实验验证（本地 Mac carher-1）

| 测试 | dm.allowFrom | ownerAllowFrom    | AI 行为                                    | 结论                    |
| ---- | ------------ | ----------------- | ------------------------------------------ | ----------------------- |
| A    | 空           | 无                | `Exec: run openclaw cron`（fallback 失败） | 无 Owner → cron 不可见  |
| B    | 空           | `["ou_e5e4e..."]` | `⏰ Cron` 原生工具调用成功                 | ownerAllowFrom 独立生效 |

### 受影响容器清单

| 容器      | 用户         | dm.allowFrom     | 状态        |
| --------- | ------------ | ---------------- | ----------- |
| carher-1  | 董事长(老杨) | `ou_c66285bd...` | ✅ 有 Owner |
| carher-2  | 金龙         | 空               | ❌ 缺 Owner |
| carher-3  | 董事长(迁移) | `ou_286e0c02...` | ✅ 有 Owner |
| carher-4  | 振华         | `ou_c4f9a66b...` | ✅ 有 Owner |
| carher-5  | 哲人         | 空               | ❌ 缺 Owner |
| carher-6  | 乾军         | 空               | ❌ 缺 Owner |
| carher-7  | 百林         | 空               | ❌ 缺 Owner |
| carher-8  | 徐敏         | 空               | ❌ 缺 Owner |
| carher-9  | 车联(洪源)   | 空               | ❌ 缺 Owner |
| carher-10 | 运营(徐协邦) | 空               | ❌ 缺 Owner |
| carher-11 | 文胜         | 空               | ❌ 缺 Owner |
| carher-12 | 测试(共享)   | 空               | ❌ 缺 Owner |
| carher-13 | 弋天         | `ou_b338bb3d...` | ✅ 有 Owner |

### 修复方案

- **专属 Bot（carher-2/5/6/7/8/9/10/11）**：收集每个用户的 open_id → 填入 CSV `feishu_owner_open_id` 列 → 重建容器
- **共享 Bot（carher-12）**：填入 CSV `owner_allow_from` 列（管理员 open_id，`|` 分隔）→ 重建容器
- 收集方法：用户给 bot 发一条消息 → 从日志取 `from=ou_xxx`
- 文档已更新：`her-feishu-bot-architecture.md`（Owner 机制详解）、`her-feishu-bot-enterprise-deploy.md`（步骤 11 + CSV 字段说明 + 共享 bot 配置）

### CSV 工具化改造（2026-02-24 实施）

**问题**：之前共享 bot 需要手动编辑 `openclaw.json` 添加 `commands.ownerAllowFrom`，`start-user.sh` 重建会覆盖手动修改。

**方案**：CSV 新增第 9 列 `owner_allow_from`，`start-user.sh` 自动生成 `commands.ownerAllowFrom`。

**改动文件**：

- `docker/users.csv` — 新增第 9 列 `owner_allow_from`（`|` 分隔多个 open_id）
- `start-user.sh` — 读取第 9 列，非空时生成 `commands.ownerAllowFrom`

**本地 Mac 实验验证（carher-1）**：

| 测试   | feishu_owner_open_id | owner_allow_from | dm.allowFrom    | ownerAllowFrom  | AI 有 cron？              | 结论                    |
| ------ | -------------------- | ---------------- | --------------- | --------------- | ------------------------- | ----------------------- |
| Case A | `ou_e5e4e...`        | 空               | `[ou_e5e4e...]` | 不生成          | ✅ `⏰ Cron` 工具调用成功 | dm.allowFrom 识别 Owner |
| Case B | 空                   | `ou_e5e4e...`    | 不生成          | `[ou_e5e4e...]` | ✅ `cron.add` 被调用      | ownerAllowFrom 独立生效 |
| Case C | 空                   | 空               | 不生成          | 不生成          | ❌ "没有 cron tool"       | 无 Owner → cron 被过滤  |

**向后兼容性**：旧 CSV（8列）+ 新 `start-user.sh` → 第 9 列为空 → 不生成 ownerAllowFrom → 行为不变。

### 待办

- [ ] 收集 9 个缺 Owner 容器的用户 open_id
- [ ] 服务器 CSV 填入 open_id 并重建容器
- [ ] carher-12 在服务器 CSV 填入 `owner_allow_from` 并重建

### 部署步骤

1. Mac push 代码到 dev（`start-user.sh` + 文档）
2. S1/S2/S3 `git pull` 获取新的 `start-user.sh`
3. 各服务器手动编辑 CSV，添加第 9 列 `owner_allow_from`（专属 bot 留空，共享 bot 填管理员 open_id）
4. 收集缺失的用户 open_id → 填入 CSV `feishu_owner_open_id` 列
5. `./start-user.sh --id=N` 重建受影响的容器

---

## 2026-02-25：Compaction 不触发 — P0 Bug 修复

### 问题现象

服务器所有 Docker 容器的 AI 对话永远不触发 compaction（context 压缩），无论对话多长。本地 Mac 正常。

### Root Cause（已 100% 实验确认）

`carher-config.json` 中 `anthropic` provider 定义了 `models` 但**缺少 `apiKey`**。

SDK 的 `ModelRegistry.validateConfig()` 要求：**有 models 就必须有 apiKey**。缺少时直接 throw，导致**整个 models.json 的自定义模型全部被丢弃**（静默失败，仅在 `registry.getError()` 可见）。

后果链：

1. `carher-config.json` 中配置的 `contextWindow: 240000` 全部被忽略
2. SDK 回退到内置模型数据库（opus contextWindow=196608）
3. compaction threshold = 196608 - 16384 = **180,224 tokens**
4. 正常对话几万 tokens 永远到不了 180K → compaction 永远不触发

### 修复

在 `anthropic` provider 加 dummy `apiKey`:

```json
"anthropic": {
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "sk-ant-not-used-on-server",
  "models": [...]
}
```

- 服务器所有人走 openrouter，dummy key 永远不会被调用
- 本地 Mac 有真 key 在 auth.json，可直联 anthropic（省钱）
- 所有模型 contextWindow 统一为 200000

### 快速诊断方法

如果怀疑 compaction 不工作，在容器内执行：

```bash
docker exec carher-N node -e "
const { ModelRegistry } = require('/app/node_modules/@mariozechner/pi-coding-agent/dist/core/model-registry.js');
const { AuthStorage } = require('/app/node_modules/@mariozechner/pi-coding-agent/dist/core/auth-storage.js');
const auth = new AuthStorage('/data/.openclaw/agents/main/agent/auth.json');
const registry = new ModelRegistry(auth, '/data/.openclaw/agents/main/agent/models.json');
console.log('loadError:', registry.getError() ?? 'NONE');
const m = registry.find('openrouter', 'anthropic/claude-opus-4.6');
console.log('opus contextWindow:', m?.contextWindow);
"
```

- `loadError: NONE` = 正常
- `loadError: Failed to load models.json: ...` = **models.json 被丢弃，compaction 用的是内置值！**
- `opus contextWindow: 200000` = 正确
- `opus contextWindow: 196608` = 用了内置值，配置没生效

### 教训

1. **SDK 的 models.json 加载失败是静默的** — 不会 crash，不会有明显日志，只能通过 `registry.getError()` 查到
2. **`anthropic` provider 如果定义了 models，必须有 apiKey** — 即使服务器不走 anthropic 直联
3. **`contextTokens` 和 `contextWindow` 是两个独立的值** — `contextTokens` 只影响 OpenClaw 层（/status 显示），`contextWindow` 才影响 SDK 的 compaction 判断
4. **所有模型的 contextWindow 必须统一设为 200000** — 不能用实际模型的原始窗口大小（如 gemini 1M、minimax 80K），否则 compaction 阈值不一致

### 实验证据

| 环境                      | loadError                                  | opus contextWindow | compaction threshold | 实际 tokens      | 结果           |
| ------------------------- | ------------------------------------------ | ------------------ | -------------------- | ---------------- | -------------- |
| Mac docker1（修复前）     | NONE                                       | 200000             | 183616               | 16677 (18K test) | ✅ 3次 compact |
| 服务器 docker13（修复前） | `Provider anthropic: "apiKey" is required` | 196608 (内置)      | 180224               | 22979            | ❌ 0次         |
| 服务器 docker13（修复后） | NONE                                       | 18000 (18K test)   | 14000                | 20079            | ✅ 1次 compact |

---

## 2026-02-25 飞书日历工具 (feishu_calendar)

### 概述

为 feishu-her 插件新增 `feishu_calendar` 工具，支持 10 个 action：

| Action                | 说明                           | 状态        |
| --------------------- | ------------------------------ | ----------- |
| `get_primary`         | 获取 bot 自身的主日历          | ✅ 已验证   |
| `list_calendars`      | 列出 bot 可访问的所有日历      | ✅ 已验证   |
| `search_calendars`    | 搜索公开日历/用户主日历        | ✅ 已验证   |
| `subscribe_calendar`  | 订阅公开/共享日历              | ✅ 代码完成 |
| `list_events`         | 列出日程（支持时间范围过滤）   | ✅ 已验证   |
| `get_event`           | 获取单个日程详情               | ✅ 已验证   |
| `create_event`        | 创建日程                       | ✅ 已验证   |
| `update_event`        | 修改日程 + 追加参会人          | ✅ 已验证   |
| `delete_event`        | 删除日程                       | ✅ 已验证   |
| `check_freebusy`      | 查询任意同组织用户的忙闲       | ✅ 已验证   |
| `list_rooms`          | 列出企业会议室（自动过滤禁用） | ✅ 已验证   |
| `check_room_freebusy` | 查询会议室忙闲状态             | ✅ 已验证   |

**会议室预定**：`create_event` 和 `update_event` 支持 `room_ids` 参数。飞书 API 要求两步：先创建事件，再通过 attendees API 以 `type: "resource"` 添加会议室。代码已封装为一步操作。

**vchat**：`list_events` 和 `get_event` 返回 `vchat`（视频会议链接）和 `meeting_rooms` 字段。

**已知行为**：事件用 user_access_token 创建时 organizer 是用户本人，飞书不会给 organizer 发日历通知。其他参会人正常收到通知。

### 已知限制（瑕疵）

**核心问题：bot 使用 `tenant_access_token`（应用身份），只能操作 bot 自己的日历，无法读取用户的个人日历事件详情。**

- `check_freebusy` 可以查到用户的忙闲时间段（如 14:00-14:30 忙），但看不到日程标题/描述/参与者
- 飞书 UI 的「日历共享」功能是面向人的，bot app 在搜索里找不到，通过群组绕行也不会授予 API 访问权
- `list_calendars` / `search_calendars` / `subscribe_calendar` 只能发现和订阅**公开**日历

### TODO：实现 user_access_token OAuth 授权流程

飞书官方文档确认：用 `user_access_token` 调用日历 API = 用户身份，用户对自己日历是 `owner`，**100% 能看到所有日程详情**。

实现步骤：

1. 飞书开发者后台 → 安全设置 → 配置重定向 URL（callback）
2. 在 feishu-her 插件中建 OAuth 回调端点（需公网可达，可用 Cloudflare tunnel）
3. bot 发送授权链接 → 用户点击一次 → 获取 `user_access_token`
4. 存储 token + `refresh_token`，每 2h 自动刷新
5. calendar.ts 改为：有 user_token 时用它调 API，没有时降级用 freebusy

优先级：P1（当前 freebusy 可用，不阻塞基本功能）

### 修复记录

- 飞书 `list_events` API 的 `page_size` 最小值为 50（官方未在文档中说明），传小于 50 会返回 400 错误
- 飞书 `freebusy` API 的时间参数要求 RFC 3339 格式（如 `2026-02-25T14:00:00Z`），不接受 Unix timestamp
- 改进了 Axios 错误处理，提取飞书 API 的 `code`、`msg`、`field_violations` 详细信息
- **[2026-02-25] 修复日历参会人不可见问题**：`create_event` 加 `attendee_ability: "can_see_others"`（默认 `none` 导致参会人互相看不到）；`addAttendees` 加 `need_notification: true`（确保参会人收到日历通知）

### 文件变更

- `extensions/feishu-her/src/tools/calendar.ts` — 新建，日历工具完整实现
- `extensions/feishu-her/src/tools/index.ts` — +3 行，注册日历工具

- **[2026-02-25] 增强 `update_event` 支持追加参会人**：`updateEvent` 新增 `attendee_ids` 参数，调用 `addAttendees` 给已有事件补加参会人并发送通知；修复了之前 AI 调用 `update_event` 传 `attendee_ids` 被静默忽略的问题
- **[2026-02-25] 验证通过**：本地 docker1 (Sonnet) 端到端验证 `update_event` + `attendee_ids` 成功追加参会人；本地 Her (Opus) 验证 `create_event` + `attendee_ids` 一步建会邀请成功
- **[2026-02-25] 新增 `remove_attendees` action**：通过 `calendarEventAttendee.batchDelete` 批量删除参会人，支持按 open_id 移除并发送通知。本地 Her + docker1 均验证通过
- **[2026-02-25] SKILL.md 新增建会流程规则**：① 立即创建（必须传 attendee_ids）→ ② 建完后 check_freebusy → ③ 告知冲突（用户可忽略）。Opus 100% 遵循，Sonnet 忽略忙闲检查步骤

---

## Cloudflare 隧道架构

### 概览

每台服务器一个 Cloudflare Named Tunnel，通过 systemd 自启动。

| 服务器 | IP           | 隧道名    | 隧道 UUID                            | 预分配用户 |
| ------ | ------------ | --------- | ------------------------------------ | ---------- |
| S1     | 10.68.13.186 | carher-s1 | d18effca-6456-4b6c-b735-94dbbdc83299 | User 1-50  |
| S2     | 10.68.13.187 | carher-s2 | d4180094-9f8a-4693-99ee-721412df1b4e | User 1-50  |
| S3     | 10.68.13.188 | carher-s3 | 750fb00c-6572-4d7c-bed4-60c1a9c3107f | User 1-50  |

### 端口规则

每个用户 N 的端口基址 = `29000 + (N-1) * 10`：

| 用途     | 端口偏移 | 容器端口 | 域名后缀       |
| -------- | -------- | -------- | -------------- |
| Gateway  | +1       | 18789    | （无外部域名） |
| Realtime | +2       | —        | （内部）       |
| Frontend | +3       | 8000     | `-fe`          |
| WS Proxy | +4       | 8080     | `-proxy`       |
| OAuth    | +5       | 18891    | `-auth`        |

域名格式：`sN-uID-{fe,proxy,auth}.carher.net`

示例：S3 上 User 14 → `s3-u14-fe.carher.net` (port 29133), `s3-u14-auth.carher.net` (port 29135)

### 关键文件位置

| 文件            | 路径                                      |
| --------------- | ----------------------------------------- |
| 隧道配置        | `/etc/cloudflared/config.yml`             |
| 隧道凭证        | `/etc/cloudflared/<uuid>.json`            |
| Cloudflare 证书 | `/etc/cloudflared/cert.pem`               |
| systemd 服务    | `/etc/systemd/system/cloudflared.service` |

### 新增用户流程

当前状态下，S1/S2/S3 三台服务器的 `fe` / `proxy` / `auth` 域名路由和 DNS 都已经预分配到 User 1-50。

这意味着：**日常新增用户不需要再修改 Cloudflare ingress，也不需要再注册 DNS。**

当需要在某台服务器上新增一个 CarHer 用户时：

#### 1. 确定用户 ID 和目标服务器

```bash
# 查看当前各服务器的容器
ssh cltx@10.68.13.186 "docker ps --format '{{.Names}}' | grep carher"
ssh cltx@10.68.13.187 "docker ps --format '{{.Names}}' | grep carher"
ssh cltx@10.68.13.188 "docker ps --format '{{.Names}}' | grep carher"
```

#### 2. 确认隧道服务正常

```bash
ssh cltx@10.68.13.186 "sudo systemctl is-active cloudflared"
ssh cltx@10.68.13.187 "sudo systemctl is-active cloudflared"
ssh cltx@10.68.13.188 "sudo systemctl is-active cloudflared"
```

正常应返回 `active`。如果某台服务器的 `cloudflared` 不在运行，再单独重启该台服务。

#### 3. 启动容器

```bash
cd /Data/CarHer
./start-user.sh --id=N
```

`start-user.sh` 会根据 `TP` 环境变量自动计算域名前缀（`s1-`/`s2-`/`s3-`），并将 `NAMED_AUTH_HOST` 注入容器配置。

#### 4. 验证

```bash
# 隧道可达
curl -s -o /dev/null -w "%{http_code}" https://sX-uN-auth.carher.net/feishu/oauth/callback
# 期望 400（OAuth 服务正常但缺参数）

curl -s -o /dev/null -w "%{http_code}" https://sX-uN-fe.carher.net/
# 期望 200
```

#### 5. 飞书 App 配置

在飞书开发者后台，该用户的企业自建应用 → 安全设置 → 重定向 URL，添加：

```
https://sX-uN-auth.carher.net/feishu/oauth/callback
```

#### 完整命令速查（一步新增 S2 User 44 的例子）

```bash
# 确认 S2 隧道在线
ssh cltx@10.68.13.187 "sudo systemctl is-active cloudflared"

# 启动容器
ssh cltx@10.68.13.187 "cd /Data/CarHer && TP=s2- ./start-user.sh --id=44"

# 验证
curl -sw "%{http_code}" https://s2-u44-auth.carher.net/feishu/oauth/callback
```

> 只有在新增第 51 个用户、扩新服务器，或重做 Cloudflare 隧道时，才需要重新编辑 `/etc/cloudflared/config.yml` 和注册 DNS。

### 隧道运维

```bash
# 查看隧道状态
sudo systemctl status cloudflared

# 查看隧道日志
sudo journalctl -u cloudflared -f

# 列出所有隧道
cloudflared tunnel list

# 重启（配置变更后）
sudo systemctl restart cloudflared
```

### 2026-03-08

- 完成 **跨 Session Recall** 的确定性离线验证（未修改线上容器、未污染真实会话数据）
- 验证方式：
  - 固定 session 夹具
  - 旧/新代码分别回放
  - 每轮独立 `stateDir`
  - 每轮独立 sqlite index
- 结论：
  - 旧逻辑只索引 `*.jsonl`，不会索引 `.jsonl.reset.*`
  - `/new` 后跨 session recall：旧方案 `0/6`，新方案 `6/6`
  - 长时间不 `/new` 的单 session 场景：旧新方案均 `6/6`
- 同日只读巡检 S1：
  - `carher-1` 与 `carher-13` 都开启了 `memorySearch.sources=["memory","sessions"]`
  - 两者都未启用 `session-memory` hook
  - 说明线上问题核心是 `.reset` archive 没进入 `sessions` 索引，而不是 hook 没开
- 详细实验设计、量化结果、风险与成本推演，见 `docs/her/memory-search-architecture.md` 的「跨 Session Recall 验证（2026-03-08）」章节

<!-- 后续操作记录追加在这里 -->
