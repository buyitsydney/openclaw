# Bot Registry 动态注册架构

## 概述

替代静态 `knownBots` 配置（每个容器启动时从 CSV 生成 77 个 bot 映射），改为 Redis 动态自注册 + 自动发现。**新增 bot 后无需重启任何容器。**

## 新旧对比

| | 旧方案（knownBots 静态配置） | 新方案（Redis Bot Registry） |
|---|---|---|
| 数据来源 | CSV → start-user.sh → config JSON | 容器启动时自注册到 Redis |
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
  → Redis connected
    → registerSelf(appId, name, botOpenId)     # SETEX + SADD
    → discoverAllBots()                         # SMEMBERS + MGET
    → syncToAccount(account)                    # 原地更新 account.knownBots
  → 每 60s: renewLease()                        # EXPIRE 续期
  → 每 30s: discoverAllBots() + syncToAccount() # 刷新 peer 列表

容器停止
  → destroyBotRegistry()
    → DEL + SREM (best-effort)
    → 即使未执行，120s 后 TTL 自动过期
```

## 核心设计：零消费者改动

`account.knownBots` 是一个 JS 对象引用，所有 8 个文件 45 处消费者通过同一个引用同步读取。`syncToAccount()` 通过 key-by-key 赋值原地修改这个对象的内容（不替换引用），所有消费者自动看到更新。

Node.js 单线程模型保证：迭代 `Object.entries(account.knownBots)` 的消费者不会观察到半更新状态。

**消费者文件（全部零改动）：**
- `gateway.ts` — bot 消息识别、讨论模式名字解析、prompt 构建
- `outbound.ts` — @mention 渲染
- `feishu-message.ts` — bot 名字解析
- `tools/bot-directory.ts` — bot 目录工具
- `tools/chat-members.ts` — 群成员列表
- `discussion-dashboard.ts` — 参与者名字
- `discussion-outbound.ts` — mention→appId 映射
- `accounts.ts` — 类型定义和初始化

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
| `extensions/feishu-her/src/gateway.ts` | +5 行 (init + destroy) |
| `start-user.sh` | 删除 ~79 行 CSV→knownBots 生成 |

## 与 a2a Registry 的关系

Bot Registry 复用了 a2a gateway `registry.ts` 的成熟模式（RegistryManager 生命周期、lease TTL、discovery cache、stale cleanup），但存储不同的数据：

| | a2a Registry | Bot Registry |
|---|---|---|
| 用途 | A2A 跨容器 RPC 路由 | bot 身份识别（名字、openId） |
| Key | `a2a:card:{containerId}` | `her:bot:{appId}` |
| ID 格式 | 容器名 (carher-101) | 飞书 appId (cli_xxx) |
| 数据 | endpoints, skills, server | name, botOpenId |

两套 registry 独立运行，各自维护，互不干扰。

## 灰度测试方案

见下方"线上灰度测试 TODO"。
