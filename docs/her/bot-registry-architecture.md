# Bot Registry 动态注册架构

## 概述

替代静态 `knownBots` 配置（每个容器启动时从 CSV 生成 77 个 bot 映射），改为 Redis 动态自注册 + 自动发现。**新增 bot 后无需重启任何容器。**

## 新旧对比

| | 旧方案（knownBots 静态配置） | 新方案（Redis Bot Registry） |
|---|---|---|
| 数据来源 | CSV → compose → config JSON | 容器启动时自注册到 Redis |
| 新 bot 感知 | 重启所有容器 | 30 秒内自动发现 |
| 维护成本 | CSV 双 map 手动同步 (knownBots + knownBotOpenIds) | 零维护，自动注册/过期 |
| 数据一致性 | 77 vs 70 条不一致（7 个 bot 缺 openId） | 每个容器注册自己的完整信息 |
| Redis 依赖 | 无 | 是（讨论模式已依赖 Redis） |

## Redis Key 设计

```
her:bot:{appId}     JSON { appId, name, botOpenId, registeredAt }   TTL 120s
her:bot:index       SET of all registered appIds
```

**Key 前缀 `her:bot:` 与 a2a 的 `a2a:card:` / `a2a:index` 互不冲突。**

## 生命周期

```
容器启动
  → feishu-her/index.ts register()              # 三组件架构下仍会执行
    → initBotRegistry(primaryAccount)
      → Redis connected
        → registerSelf(appId, name, botOpenId)  # SETEX + SADD
        → discoverAllBots()                     # SMEMBERS + MGET
        → syncToAccount(account)                # 原地更新 account.knownBots
  → 每 60s: renewLease()                        # EXPIRE 续期
  → 每 30s: discoverAllBots() + syncToAccount() # 刷新 peer 列表

容器停止
  → destroyBotRegistry()
    → DEL + SREM (best-effort)
    → 即使未执行，120s 后 TTL 自动过期
```

## 核心设计：旧消费者零改动，新三组件补丁必须显式接入

`account.knownBots` 是一个 JS 对象引用，所有 8 个文件 45 处消费者通过同一个引用同步读取。`syncToAccount()` 通过 key-by-key 赋值原地修改这个对象的内容（不替换引用），所有消费者自动看到更新。

Node.js 单线程模型保证：迭代 `Object.entries(account.knownBots)` 的消费者不会观察到半更新状态。

**feishu-her 内部消费者文件（全部零改动）：**
- `gateway.ts` — bot 消息识别、讨论模式名字解析、prompt 构建
- `outbound.ts` — @mention 渲染
- `feishu-message.ts` — bot 名字解析
- `tools/bot-directory.ts` — bot 目录工具
- `tools/chat-members.ts` — 群成员列表
- `discussion-dashboard.ts` — 参与者名字
- `discussion-outbound.ts` — mention→appId 映射
- `accounts.ts` — 类型定义和初始化

**三组件运行时补丁消费者（必须显式接入）：**
- `scripts/carher-patches/history-fill-helper.js` — 新架构下 group history 由 `openclaw-lark` 注入，不再经过 `feishu-her/gateway.ts` 的 prompt 构建路径；因此 helper 必须直接从 Redis Bot Registry / `account.knownBots` 解析 app sender，把 `cli_a917...` 渲染成 `弋天的her (cli_a917...)`。这不是展示细节，而是归因正确性：多 Her 群里裸 `cli_xxx` 会让模型把国现、林森、弋天的 Her 说过的话互相认错。

**回归要求：**
- lark-cli primary path：当 `sender.sender_type=app` 且 lark-cli 未给 `sender.name` 时，必须从 Bot Registry 补名。
- raw API fallback：当 `sender.id` 是 appId 时，必须从 `account.knownBots` / Bot Registry 补名。
- 模型视角不能出现需要心算的裸 app id，例如只看到 `cli_a94a0b73a878dbcb`。

## 容错

| 场景 | 行为 |
|------|------|
| Redis 启动时不可用 | 日志警告，bot discovery 禁用；容器只有自己的身份 |
| Redis 运行中断连 | 保留最后一次成功的缓存 (stale cache)；ioredis 自动重连 |
| 容器意外停止 | 120s 后 TTL 过期，其他容器下次 discover 自动清理 |
| Redis 数据损坏 | JSON 解析失败的 entry 跳过，不影响其他 bot |

## 文件清单

| 文件 | 变更 |
|------|------|
| `extensions/feishu-her/src/bot-registry.ts` | 新增 ~210 行 |
| `docker/plugins/feishu-her/index.ts` | 三组件架构启动点；注册 tools/hooks 时启动 Bot Registry |
| `extensions/feishu-her/src/gateway.ts` | 旧 channel 启动点；保留 init + destroy，避免回退旧架构时丢 registry |
| `compose` | 删除 ~79 行 CSV→knownBots 生成 |

## 与 a2a Registry 的关系

Bot Registry 复用了 a2a gateway `registry.ts` 的成熟模式（RegistryManager 生命周期、lease TTL、discovery cache、stale cleanup），但存储不同的数据：

| | a2a Registry | Bot Registry |
|---|---|---|
| 用途 | A2A 跨容器 RPC 路由 | bot 身份识别（名字、openId） |
| Key | `a2a:card:{containerId}` | `her:bot:{appId}` |
| ID 格式 | 容器名 (carher-101) | 飞书 appId (cli_xxx) |
| 数据 | endpoints, skills, server | name, botOpenId |

两套 registry 独立运行，各自维护，互不干扰。

## 灰度测试结果（2026-04-04）

### 灰度规模

7 个容器，跨 3 台服务器（S1/S2/S3），1 个 hub + 6 个 spoke。

### 验证通过的项目

- Redis `her:bot:index`: 8 bots，跨服务器自动发现 ✅
- Lease 续期（TTL 在 60-120s 间跳动）✅
- 消费者零改动，群聊 bot 识别正常 ✅
- A2A hub-spoke：hub 容器有 ask-other-her skill，其他 spoke 无 ✅
- 服务器 dev 分支未被触碰 ✅
- 独立 worktree (`/tmp/bot-registry-wt/`) + 独立镜像 (`carher:bot-registry`) ✅

### 已知限制（灰度期间）

- 灰度容器只能看到彼此的 bot 名字（7 个），旧镜像的 70 个 bot 不在 Redis 中
- `detectGroupBots()` 依赖 knownBots 做名字解析，群里旧镜像 bot 的名字无法显示
- 全量部署后（77 个容器全部自注册）这些限制自动消除

### 灰度操作规范

**铁律：必须用独立 worktree + 独立分支 + 独立镜像**

```bash
# 服务器上创建 worktree（不碰主仓库 dev）
git worktree add /tmp/bot-registry-wt origin/feat/dynamic-bot-registry
cd /tmp/bot-registry-wt
ln -sf /Data/CarHer/docker/server.env docker/server.env
ln -sf /Data/CarHer/docker/users.csv docker/users.csv

# 构建独立镜像（不碰 carher:local）
./build-image.sh --tag=carher:bot-registry

# 启动 spoke（被动接收 a2a）
A2A_ENABLED=1 ./compose --id=N --image=carher:bot-registry

# 启动 hub（主动发送 a2a）
A2A_ENABLED=1 A2A_OUTBOUND=1 ./compose --id=N --image=carher:bot-registry

# 回滚（用主仓库的 compose + carher:local）
cd /Data/CarHer && ./compose --id=N
```
