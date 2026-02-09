# 企业全员 Her 部署架构设计

## 背景

基于 Car Her 的成功验证，将 AI 助手从个人使用扩展到企业全员（200+ 人）。
每位员工通过飞书获得专属 AI 助手，拥有独立的对话历史和记忆，完全隔离。

**状态：架构设计 + 核心验证通过 (2026-02-09)**

---

## 已验证的实验结果 (2026-02-09)

在个人 Her 上进行了完整的 per-peer 隔离验证实验，所有测试 100% 可复原（已恢复）。

### 实验 1：per-peer 通道隔离

**操作**：将个人 Her 的 `session.dmScope` 从 `main`（默认）改为 `per-peer`，重启 Gateway。

**结果**：隔离生效。日志证据：

```
飞书消息 → lane=session:agent:main:dm:oc_b3ae51bb264ead025c85913cdee5946a  (sessionId=11efefba)
Telegram → lane=session:agent:main:dm:6825898084                          (sessionId=e30ea6e6)
```

飞书和 Telegram 被路由到不同的 session，AI 在两个通道中互相不知道对方的对话内容。

### 实验 2：identityLinks 跨通道关联

**操作**：在 per-peer 基础上添加 `identityLinks`，将飞书 ID 和 Telegram ID 映射为同一个身份 `tianbu`。

```json
"session": {
  "dmScope": "per-peer",
  "identityLinks": {
    "tianbu": ["feishu:oc_b3ae51bb264ead025c85913cdee5946a", "telegram:6825898084"]
  }
}
```

**结果**：路由合并成功。日志证据：

```
飞书消息   → lane=session:agent:main:dm:tianbu
Telegram  → lane=session:agent:main:dm:tianbu
```

两个通道成功合并到同一个 session。但由于 `tianbu` 是新建的 session（不同于原来的 `agent:main:main`），对话历史为空。这是预期行为——企业场景下每个员工都是新用户，从零开始建立记忆。

### 实验 3：Car Her 语音 session 天然独立

**操作**：在 per-peer 模式下通过语音前端连接。

**结果**：语音使用独立的 session key 前缀 `realtime:xxx`，与飞书/Telegram 的 DM session 天然隔离。

```
语音 → realtime:1770606288850-olq6ng (agent=main)
```

即使在 `dmScope = "main"` 的默认配置下，语音也是独立 session。语音的用户识别来自 workspace 文件（USER.md/MEMORY.md），不依赖 session 路由。

### 实验 4：Webchat 不支持 per-peer

**发现**：Webchat（Control UI）没有用户身份标识机制。所有连接的 `SenderId` 固定为 `"webchat"`，`sessionKey` 由客户端指定（通常为 `agent:main:main`）。200 个浏览器标签页连接同一个 gateway，全部共享同一个 session。

### 实验总结

| 通道 | 有用户身份标识 | per-peer 隔离 | 200 人同时用 | 企业可用性 |
|------|-------------|-------------|------------|-----------|
| 飞书 | 有（open_id，自动） | 生效 | 200 个独立 session | Phase 1 可用 |
| Telegram | 有（user_id，自动） | 生效 | 200 个独立 session | Phase 1 可用 |
| Webchat | 无（固定 "webchat"） | 不生效 | 共享同一个 session | 需改造（Phase 2） |
| 语音 (realtime) | 无用户认证 | 天然独立（realtime:xxx） | 每连接独立，但不知道"谁" | 需改造（Phase 2） |

### 实验 5：dmScope 热加载行为

**发现**：`session.dmScope` 的变更**不能**通过热加载生效。

具体表现：删除 config 中的 `session` 部分后，gateway 日志显示 `config change applied (dynamic reads: ... session)`，但实际消息路由**未改变**——仍然走 `agent:main:dm:tianbu` 而非回到 `agent:main:main`。必须完全重启 gateway 才能使 `dmScope` 变更生效。

```
03:18:03 config change applied (session)  ← 热加载声称成功
03:21:06 lane=session:agent:main:dm:tianbu  ← 但路由未变！仍然走 per-peer
03:30:39 lane=session:agent:main:dm:tianbu  ← 重启前一直如此
```

**结论**：
- `session.identityLinks`：支持热加载（路由映射可动态更新）
- `session.dmScope`：**不支持热加载**，必须重启 gateway

### 关键结论

1. **per-peer 对飞书和 Telegram 开箱即用**，零代码改造
2. **identityLinks 可以关联同一人的多通道身份**，实现跨通道共享记忆
3. **Webchat 和语音需要额外的用户认证层**才能支持多用户
4. **企业 Phase 1 应以飞书为唯一入口**，覆盖 90% 日常需求
5. **个人 Her 保持 `dmScope = "main"` 不变**，企业部署是独立的 OpenClaw 实例
6. **`dmScope` 变更需要重启 gateway**，不能热加载；`identityLinks` 可以热加载

---

## 核心架构：共享 Bot + 多用户路由

### 设计原则

```
1 个飞书 Bot → 200+ 员工共用
1 套 OpenClaw 服务 → 按 open_id 自动路由
每个员工 → 独立的 session + 对话历史
零人工干预 → 员工发消息即自动创建 session
```

### 架构图

```
公司全员（200+ 人）
  │
  │ 每人 DM 同一个飞书 Bot
  ↓
飞书开放平台
  │
  │ WebSocket 长连接（1 条）
  │ 每条消息携带发送者 open_id
  ↓
┌─────────────────────────────────────────┐
│            云服务器（1-2 台）              │
│                                         │
│  OpenClaw Gateway                       │
│    │                                    │
│    ├── 飞书插件 ← 收消息，提取 open_id   │
│    │                                    │
│    ├── Agent Router                     │
│    │   dmScope = "per-peer"             │
│    │                                    │
│    │   open_id=ou_aaa → session A       │
│    │   open_id=ou_bbb → session B       │
│    │   open_id=ou_ccc → session C       │
│    │   ...自动创建，无需预配置...          │
│    │                                    │
│    ├── LLM API 调用                     │
│    │   OpenRouter (Claude/GPT/...)      │
│    │                                    │
│    └── 语音代理（可选）                   │
│        Gemini Live via Python proxy     │
│                                         │
│  存储                                    │
│    /data/.openclaw/sessions/            │
│    ├── agent:main:dm:ou_aaa (员工A)     │
│    ├── agent:main:dm:ou_bbb (员工B)     │
│    └── ...                              │
└─────────────────────────────────────────┘
```

### 为什么不需要 200 个飞书 Bot

飞书 Bot 是消息入口，不是隔离单元。隔离发生在 OpenClaw 内部：

| 方案 | 飞书 Bot 数量 | 管理复杂度 | 隔离效果 |
|------|-------------|-----------|---------|
| 每人一个 Bot | 200+ | 极高（每个需审批、发布、维护） | 最强 |
| 每部门一个 Bot | 5-10 | 中等 | 部门间物理隔离 |
| **全公司一个 Bot** | **1** | **最低** | **per-peer 逻辑隔离（已验证可靠）** |

一个 Bot 即可为全公司服务。员工感受到的"专属"来自 AI 独立记住每个人，而非 Bot 本身不同。

---

## open_id 自动路由机制

### 什么是 open_id

`open_id` 是飞书为每个用户自动分配的唯一标识（格式：`ou_xxxxxxxxxxxxxxxx`）。

- **谁分配**：飞书平台，自动生成
- **何时获取**：用户第一次发消息时，飞书在事件中携带
- **是否需要预收集**：不需要，完全自动

### 路由流程

```
员工 A 发消息 "你好"
  ↓
飞书事件：{ from: "ou_aaa", text: "你好" }
  ↓
OpenClaw 飞书插件提取 from = "ou_aaa"
  ↓
session key = "agent:main:dm:ou_aaa"  (dmScope = "per-peer")
  ↓
AI 在 session A 中处理，回复

===

员工 B 发消息 "帮我查下天气"
  ↓
飞书事件：{ from: "ou_bbb", text: "帮我查下天气" }
  ↓
session key = "agent:main:dm:ou_bbb"
  ↓
AI 在 session B 中处理，回复（不知道员工 A 的任何信息）
```

### 员工生命周期管理

| 事件 | IT 操作 | 部署者操作 | OpenClaw 自动行为 |
|------|--------|-----------|-----------------|
| 新员工入职 | 开通飞书账号 | 无 | 首次发消息时自动创建 session |
| 员工日常使用 | 无 | 无 | 按 open_id 路由到对应 session |
| 员工离职 | 注销飞书账号 | 无 | 账号注销后无法发消息，session 自然停用 |
| 清理离职数据 | 无 | 可选：删除对应 session 文件 | - |

**零日常运维**：IT 只需做好飞书账号的正常管理，OpenClaw 侧完全自动。

---

## 数据安全设计

### 隔离层级

```
第 1 层：飞书平台
  └── Bot 可用范围 = 仅本公司员工（外部人员不可见）

第 2 层：OpenClaw 路由
  └── dmScope = "per-peer"
  └── 每个 open_id 独立 session，物理上不可能交叉

第 3 层：存储
  └── 每个 session 独立文件/目录
  └── 对话历史按 session key 分别存储
```

### 安全矩阵

| 操作 | 员工本人 | 其他员工 | 服务器管理员 | IT（飞书管理员） |
|------|---------|---------|------------|---------------|
| 与自己的 AI 对话 | 可以 | 不可以 | 不可以 | 不可以 |
| 查看自己的对话历史 | 通过飞书 | 不可以 | 可以（服务器文件） | 不可以 |
| 查看他人的对话历史 | 不可以 | 不可以 | 可以（服务器文件） | 不可以 |
| AI 记住他人的信息 | 不会（session 隔离） | 不会 | - | - |
| 停止/重启服务 | 不可以 | 不可以 | 可以 | 不可以 |

### 注意事项

- **服务器管理员**（部署者）技术上可以读取服务器上的 session 文件。这是所有服务端系统的通用情况（如同 IT 可以读取邮件服务器）。如果需要更强的保护，可以加密 session 文件或使用独立的容器部署。
- **飞书管理员**可以在飞书开放平台查看消息统计（如消息量），但无法查看具体对话内容。
- **不同员工的 AI 不会"串"**：因为 session key 包含 open_id，而 open_id 由飞书全局唯一分配，无法伪造或交叉。

---

## 配置清单

### OpenClaw 服务端配置

```json
{
  "session": {
    "dmScope": "per-peer"
  },
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxxxxxxxxxxxxxxxxx",
      "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxx"
    }
  },
  "dm": {
    "policy": "open"
  },
  "plugins": {
    "entries": {
      "feishu": { "enabled": true }
    }
  }
}
```

关键配置说明：

| 配置项 | 值 | 含义 |
|--------|-----|------|
| `session.dmScope` | `"per-peer"` | 每个飞书用户独立 session |
| `channels.feishu.appId` | IT 提供的 App ID | 飞书 Bot 凭证 |
| `channels.feishu.appSecret` | IT 提供的 App Secret | 飞书 Bot 凭证 |
| `dm.policy` | `"open"` | 允许所有飞书组织内用户使用 |

### 飞书开放平台配置

由 IT 部门完成，详见 [IT 操作清单](/her/feishu-it-guide)。

---

## 各通道企业能力分析（已验证）

### 通道就绪度

| 通道 | 用户身份 | 多用户隔离 | 企业就绪 | 所需改造 |
|------|---------|-----------|---------|---------|
| 飞书 | open_id（自动） | per-peer 自动生效 | Phase 1 可用 | 无 |
| Telegram | user_id（自动） | per-peer 自动生效 | Phase 1 可用 | 无 |
| Webchat | 无（固定 "webchat"） | 不支持 | Phase 2 | 需加用户登录/认证 |
| 语音 (realtime) | 无用户认证 | 连接级隔离，但不识别用户 | Phase 2 | 需加用户认证层 |

### 飞书（Phase 1 首选）

- 公司全员已有飞书账号，天然的用户身份
- `per-peer` + `open_id` = 自动多用户隔离
- WebSocket 长连接模式，无需公网 IP
- 零额外开发

### Webchat（Phase 2 改造）

当前 Webchat 是管理员控制台，所有连接共享 session。企业多用户使用需要：
- 添加用户登录机制（如 SSO / OAuth）
- 登录后分配用户专属的 session key
- 需要前后端开发

### 语音（Phase 2 扩展）

- 语音需要 Google Cloud 凭证（Service Account）
- 每个语音会话消耗独立的 Gemini Live session
- 语音 session 天然独立（`realtime:xxx` 前缀），不与文字 session 交叉
- 200 人同时语音需要 3-5 台服务器做代理池
- 需要加用户认证以识别"谁在说话"
- 建议先部署飞书文字，语音作为后续扩展

### 跨通道共享记忆（identityLinks）

如果同一员工需要在多个通道（如飞书 + Telegram）使用 AI 且共享记忆：

```json
{
  "session": {
    "dmScope": "per-peer",
    "identityLinks": {
      "张三": ["feishu:ou_aaa", "telegram:111111"],
      "李四": ["feishu:ou_bbb", "telegram:222222"]
    }
  }
}
```

- 不同人之间：完全隔离（张三看不到李四的内容）
- 同一人跨通道：完全共享（张三在飞书说的，Telegram 也记得）
- 如果全员只用飞书，不需要 identityLinks（每人只有一个 ID，天然隔离）

---

## 费用估算（200 人规模）

### LLM API 费用（主要成本）

| 项目 | 假设 | 月费用 |
|------|------|--------|
| 飞书文字（Claude Sonnet via OpenRouter） | 每人 50 条/天，$0.005/条 | ~$1,500 |
| 语音（Gemini Live, 20% 活跃） | 40 人 x 30 分/天，$0.04/分 | ~$1,440 |
| 语音（Gemini Live, 50% 活跃） | 100 人 x 30 分/天，$0.04/分 | ~$3,600 |

### 服务器费用

| 配置 | 规格 | 月费用 |
|------|------|--------|
| 仅飞书文字 | 1 台 4核 16G | ~$150-300 |
| 飞书 + 少量语音 | 2 台 8核 32G | ~$400-800 |
| 飞书 + 大量语音 | 3-5 台 8核 32G | ~$1,000-2,500 |

### 其他费用

| 项目 | 费用 |
|------|------|
| 飞书开放平台 | 免费 |
| 域名 | ~$10/年 |
| SSL 证书 | 免费（Let's Encrypt） |

### 总计

| 方案 | 月费用 |
|------|--------|
| 仅飞书文字（基础） | ~$1,700-2,000 |
| 飞书 + 语音（20% 活跃） | ~$3,000-4,500 |
| 飞书 + 语音（50% 活跃） | ~$5,000-7,000 |

> **注意**：LLM API 费用占总成本的 60-80%。降低成本的最有效方法是选择更便宜的模型（如 Gemini Flash、Claude Haiku）或设置每人每日用量上限。

---

## 分阶段落地路径

### Phase 0：当前状态（已完成）

- 个人 Mac 运行
- Docker 容器隔离厂商用户
- 支持 < 10 人

### Phase 1：企业文字助手（建议首先实施）

- 目标：全员通过飞书使用 AI 助手
- 工作量：1-2 天
- 步骤：
  1. IT 创建 1 个飞书 Bot（15 分钟，参考 IT 操作清单）
  2. 部署 OpenClaw 到 1 台云服务器
  3. 配置 `dmScope = "per-peer"` + 飞书凭证
  4. 测试验证
  5. 通知全员搜索 Bot 开始使用

### Phase 2：多通道 + 语音

- 目标：Webchat 多用户支持、语音能力、跨通道记忆
- 工作量：2-4 周
- 步骤：
  1. Webchat 添加用户登录机制（SSO/OAuth）
  2. 语音前端添加用户认证
  3. 配置 Google Cloud Service Account
  4. 部署语音代理服务
  5. 配置 identityLinks 关联多通道身份（如需）
  6. 优化 per-user MEMORY 隔离

### Phase 3：生产化

- 目标：高可用、监控、自动化
- 工作量：1-2 月
- 步骤：
  1. 迁移到 Kubernetes 集群
  2. 添加监控和告警
  3. 自动扩缩容
  4. Web 管理面板
  5. 用量统计和计费

---

## 与现有方案的关系

### 个人 Her vs 企业部署

个人 Her 和企业部署是**完全独立的 OpenClaw 实例**，互不影响：

```
你的 Mac（不变）
├── 个人 Her (start.sh)
│   └── dmScope = "main"（跨通道共享记忆，飞书/Telegram/Webchat/语音统一）
│
└── Docker 容器 (start-user.sh)
    └── 各自独立的 OpenClaw 实例（厂商演示用）

云服务器（新建）
└── 企业 OpenClaw
    └── dmScope = "per-peer"（员工间自动隔离）
    └── 1 个共享飞书 Bot → 200+ 独立 session
```

### Docker 方案 vs 企业方案

| 维度 | Docker 容器方案 | 企业共享 Bot 方案 |
|------|---------------|-----------------|
| 适用场景 | 厂商演示、VIP 用户 | 公司全员 |
| 隔离方式 | 容器级物理隔离 | session 级逻辑隔离 |
| 每用户成本 | 高（独立进程+端口） | 低（共享进程） |
| 飞书 Bot | 每容器一个（需单独创建） | 全公司共享一个 |
| 适合规模 | < 10 人 | 200+ 人 |
| 运维复杂度 | 中（管理多容器） | 低（一个服务） |

两种方案可以并行运行，互不冲突。

---

## 总结

| 维度 | 方案 |
|------|------|
| 飞书 Bot | 1 个共享 Bot，IT 创建（一次性） |
| 用户隔离 | dmScope = "per-peer"，按 open_id 自动路由（已验证） |
| 通道就绪 | 飞书/Telegram 开箱即用；Webchat/语音需 Phase 2 改造 |
| 跨通道记忆 | identityLinks 可关联同一人的多通道身份（已验证） |
| 服务器 | 1-2 台云 VM（Phase 1），K8s 集群（Phase 3） |
| 日常运维 | IT 管飞书账号，部署者管服务器，无需管路由 |
| 安全保障 | 飞书可用范围 + session 隔离 + 存储分离 |
| 个人 Her | 保持 dmScope = "main" 不变，与企业部署完全独立 |
| 月费用 | ~$2,000-7,000（取决于模型和语音使用量） |
