# Her A2A 互联互通架构设计

> 日期: 2026-03-28 (创建) / 2026-03-29 (本地验证) / 2026-03-31 (线上灰度通过)
> 状态: **Grayscale Verified** — 跨 S1/S2/S3 三台服务器，4 bot 灰度测试通过
> 范围: 3 台服务器、200 个 bot 通过 A2A 协议实现任意互通 + Skills 发现与路由
> 下一步: 全量上线

---

## 0. A2A 的价值与本质分析

### 0.1 A2A 给 Her 带来了什么

**现状（群聊讨论模式）**：所有沟通都在"台前"——人类看得见的飞书群里，bot 一轮一轮排队说话。

**A2A 带来的本质变化：Bot 有了"后台"。**

```
用户: @tester 帮我做个完整的市场分析报告
tester: [收到]
  |-- (A2A 后台) 悄悄问 bot-数据分析: 帮我查一下最新的行业数据
  |-- (A2A 后台) 悄悄问 bot-竞品研究: 主要竞品的最新动态？
  |-- (A2A 后台) 收到两份结果
  +-- [在群里一次性给出完整报告]

用户只看到一条高质量的回复，背后是多个 bot 的协作。
```

|          | 群聊讨论模式           | A2A                                    |
| -------- | ---------------------- | -------------------------------------- |
| 类比     | 开会 -- 所有人轮流发言 | 后台协作 -- 各部门分头干活，汇总后汇报 |
| 沟通方式 | 人类可见的群消息       | 机器对机器，人类看不到                 |
| 速度     | 串行，一个说完下一个   | 并行，同时问多个 bot                   |
| 结果     | 碎片化的多条消息       | 一条综合的高质量回复                   |
| 适合场景 | 头脑风暴、辩论、探讨   | 任务执行、数据收集、协作产出           |

### 0.2 具体能力层面

**Tool 层面**：A2A 让每个 bot 成为其他 bot 的"工具"。Bot-13 有日历权限、Bot-25 有文档权限，董事长的 Bot-1 通过 A2A 调用两者拉数据，自己汇总周报。每个 bot 独有的工具和权限，通过 A2A 变成共享能力池。

**Skill 层面**：某个 bot 被训练了特别好的"数据分析" skill，另一个有"文案撰写" skill。通过 A2A，任何 bot 都可以按需调用这些专长。不再需要每个 bot 都是全能的，可以走"专业化 + 协作"路线。

**对人类用户**：从"@ 多个 bot，看碎片化回复"变成"@ 一个 bot，得到综合结果"。

### 0.3 与群聊讨论模式的结合

两种模式不是替代关系，而是互补：

**场景 1：讨论模式 + A2A 后台支援**

```
用户: @tester @tester3 讨论一下明年的AI战略

[群聊讨论模式启动，轮流发言]
tester: 我觉得应该重点投入 Agent 平台...
  +-- (A2A 后台) 问 bot-数据分析: 当前 Agent 市场规模？
  +-- (A2A 后台) 收到数据，融入下一轮发言

tester3: 同意，补充竞争格局...
  +-- (A2A 后台) 问 bot-竞品研究: 主要竞品最新动态？

[用户看到有理有据的深度讨论，不知道背后还有其他 bot 在支援]
```

**场景 2：群聊触发，A2A 协作执行**

```
用户: @tester 帮我准备季度汇报材料

tester: 收到，我来协调
  |-- (A2A) -> bot-财务: 拉 Q1 财务数据
  |-- (A2A) -> bot-销售: 拉 Q1 销售汇总
  |-- (A2A) -> bot-HR: 拉团队人数变化
  +-- 汇总 -> 群里回复完整方案

[用户只 @ 了一个 bot，得到全公司数据汇总]
```

**一句话：A2A 让 200 个 bot 从"200 个独立个体"变成"一个有 200 个专家的组织"。**

### 0.4 本质差异：飞书群聊 vs A2A 通信（关键！）

**它们不是等价的。** 同一个 Her，同样的 soul 和 memory，在群聊和 A2A 中拥有完全不同的"感知"。

#### 群聊讨论模式中，Bot 知道什么

每个 bot 轮到发言时，系统注入的上下文包括：

| 上下文            | 内容                                             |
| ----------------- | ------------------------------------------------ |
| **20 条群历史**   | 通过飞书 API 拉取最近 20 条群消息，注入 prompt   |
| **角色信息**      | 自己是 leader 还是 participant，当前 owner 是谁  |
| **Turn 状态**     | 当前 turn_id、排队顺序、剩余队列                 |
| **讨论规则**      | "直接输出正文，系统自动发送。严禁调用 message()" |
| **Peer bot 列表** | 群里有哪些其他 bot，它们的 app_id 和 open_id     |
| **人类身份**      | 谁 @ 了谁，发言者是谁                            |

Bot 对整个群的"局势"了如指掌。

#### A2A 中，Bot 知道什么

收到一条 A2A 请求时，bot 只知道：

| 上下文         | 内容                                           |
| -------------- | ---------------------------------------------- |
| **A2A 消息**   | 调用方发来的文本（仅此而已）                   |
| **自己的身份** | 自己的 app_id、名字                            |
| **contextId**  | 如果是同一个 A2A 对话的延续，有 session 上下文 |

**没有群历史、没有角色、没有 turn、没有 peer 感知、不知道人类是谁。**

#### 一张对比表

| 维度           | 群聊讨论模式              | A2A 调用                         |
| -------------- | ------------------------- | -------------------------------- |
| 最近群消息     | 注入 20 条                | 无                               |
| 知道谁在群里   | 知道所有 peer bot         | 不知道                           |
| 知道人类是谁   | 知道（sender resolved）   | 不知道（除非调用方告知）         |
| Turn/角色      | Redis 状态机管控          | 无概念                           |
| 可用工具       | 受限（禁止 message send） | 不受限                           |
| 发言方式       | 输出文本，系统自动广播    | 返回结构化响应                   |
| Memory         | 持久 memory 相同          | 持久 memory 相同                 |
| Soul/人格      | 相同的系统 prompt         | 相同的系统 prompt                |
| Session 上下文 | 群聊 session（持续）      | A2A session（按 contextId 隔离） |
| 输出可见性     | 人类可见                  | 仅调用方可见                     |

#### 核心洞察

**Soul 和 Memory 是一样的，但 Context 完全不同。**

类比：同一个人（soul），同样的知识和记忆（memory），但——

- 在会议室里（群聊）：他看到所有人的表情、听到所有发言、知道会议议程
- 接到一通电话（A2A）：他只听到电话那头说的话，不知道会议室里发生了什么

**这意味着：如果你想让 A2A bot 有效参与群聊讨论，必须主动"桥接"上下文。**

### 0.5 上下文桥接：让 A2A 真正融入群聊

要让一个 bot 通过 A2A 为群聊讨论提供有价值的支援，调用方需要把群聊上下文"打包"进 A2A 请求：

```
群聊 bot (tester):
  收到用户问题: "分析一下竞品"
  ↓
  构建 A2A 请求:
  {
    "message": {
      "role": "user",
      "parts": [{
        "kind": "text",
        "text": "[上下文] 我们正在飞书群里讨论明年AI战略。
                 用户卜弋天问: 分析一下竞品。
                 最近讨论要点: tester3 提到了市场规模在增长...
                 [请求] 请提供主要竞品的最新动态分析。"
      }]
    }
  }
```

**调用方负责决定传递多少上下文**，这是一个设计选择：

| 策略       | 传递内容              | 适合场景                   |
| ---------- | --------------------- | -------------------------- |
| 最小上下文 | 只传具体任务          | 独立任务（查数据、算指标） |
| 摘要上下文 | 传讨论摘要 + 任务     | 需要理解背景的分析         |
| 完整上下文 | 传完整群聊历史 + 任务 | 需要深度理解才能回答的问题 |

### 0.6 三种协作模式总结

```
模式 A: 纯群聊讨论（现有）
  全部 bot 在群里 → 共享上下文 → 串行发言 → 人类全程可见
  适合: 头脑风暴、辩论、需要人类实时参与

模式 B: 纯 A2A 协作（新增）
  一个 bot 编排 → A2A 调用多个专家 bot → 汇总结果
  适合: 任务执行、数据收集、不需要人类看到过程

模式 C: 混合模式（最大价值）
  群聊讨论（台前） + A2A 调用（后台）
  讨论中的 bot 通过 A2A 获取"弹药"，然后在群里输出更高质量的观点
  适合: 需要深度+广度的复杂讨论
```

### 0.7 A2A 网络的根本性风险

A2A 让 200 个 Her 形成一个全互联网络。**每个 Her 的 memory + 历史对话 + 工具权限，本质上是这个人的"数字大脑"。A2A 互联 = 200 个人的大脑互联。**

这是一种极其强大也极其危险的能力。

#### 风险一：级联风暴（系统稳定性）

200 个 bot 全互联 = 40,000 条潜在通信链路。无序调用会导致：

```
用户问 Her-A 一个问题
  -> Her-A 通过 A2A 问 Her-B, Her-C, Her-D
    -> Her-B 不确定, A2A 问 Her-E, Her-F
      -> Her-E 又去问 Her-A (回环!)
      -> Her-F 问 Her-G, Her-H, Her-I...
        -> 指数级扩散 -> 系统瘫痪
```

**必须有的防护机制：**

| 机制         | 说明                                     | 建议值                                     |
| ------------ | ---------------------------------------- | ------------------------------------------ |
| 调用深度限制 | A2A 调用链最大层数                       | maxDepth=2（A 调 B 可以，B 再调 C 就到底） |
| 扇出限制     | 单次请求最多并行调用几个 peer            | maxFanout=3                                |
| 全局并发控制 | 每个 bot 同时处理的 A2A 请求数           | maxInbound=2                               |
| 防回环       | 请求携带调用链 trace，检测到环路立即拒绝 | traceId + callerChain                      |
| 全局超时     | 整条调用链的总超时                       | chainTimeout=60s                           |

#### 风险二：信息不对称泄漏（隐私）

这是**最根本的风险**，也是架构设计的核心决策点。

场景：

```
你问你的 Her: G700 项目进展如何？
  -> 你的 Her 搜飞书知识库 -> 公开信息
  -> 你的 Her 通过 A2A 问 PM 宏伟的 Her ->
     宏伟的 Her 知道:
       - 宏伟和领导的私聊: "这个项目可能要砍预算"
       - 宏伟的日历: 下周有紧急复盘会
       - 宏伟的记忆: "上次客户会议气氛不好"
     -> 返回的信息深度完全不同
     -> 宏伟的私人信息被泄漏给了你
```

**A2A 的巨大价值和巨大风险是同一枚硬币的两面：信息流动越自由，价值越大，泄漏越严重。**

#### 风险三：Her 的定位（根本性治理问题）

**公司必须回答一个问题：Her 是什么？**

| 定位         | 类比       | A2A 默认行为         | 信息边界                        | 价值 | 风险 |
| ------------ | ---------- | -------------------- | ------------------------------- | ---- | ---- |
| **私有财产** | 个人手机   | 默认拒绝 A2A 查询    | 只有 owner 明确授权的信息才共享 | 低   | 低   |
| **公有财产** | 公司代码库 | 默认回答所有查询     | 无边界                          | 最高 | 最高 |
| **角色资产** | 企业邮箱   | 按组织架构和权限分级 | 同部门自由流通，跨部门需授权    | 高   | 可控 |

**建议采用"角色资产"模型**，类似企业邮箱：

- 属于公司，不是个人私有
- 但有明确的访问权限分级
- 信息流动遵循组织架构

#### 信息分级框架（建议）

每个 Her 的信息分为三层，A2A 查询时按层级返回：

```
Level 0 - 公开信息（任何 Her 可查询）
  - 姓名、部门、职责
  - 公开的项目参与情况
  - 飞书知识库可搜到的内容

Level 1 - 部门内信息（同部门 Her 可查询）
  - 项目的具体进展和细节
  - 工作日程（非私人）
  - 部门内部讨论的结论

Level 2 - 私密信息（仅 Owner 本人的 Her 可用）
  - 与领导的私聊内容
  - 个人评价和反馈
  - 薪资、绩效等敏感数据
  - Owner 明确标记为私密的对话
```

**A2A 请求必须携带调用方身份（bot-id -> owner -> 部门），被调用方根据调用方身份决定返回哪一层信息。**

#### 实现方案（技术层面）

```
Her 收到 A2A 请求时的决策流程:

1. 验证 Bearer Token (基本认证)
2. 识别调用方: 从 Redis Registry 查 caller 的 owner 和 department
3. 匹配信息分级:
   - 同一个 owner -> Level 2 (全部)
   - 同部门 -> Level 1
   - 跨部门 -> Level 0
4. 在 system prompt 中注入访问级别:
   "你正在通过 A2A 回答来自 [销售部 李金龙的Her] 的查询。
    信息分级: Level 1 (部门内)。
    不要透露: 与领导的私聊内容、个人评价、薪资相关信息。"
5. Her 基于 prompt 约束生成回答
```

---

## 1. 背景

### 1.1 需求

200 个 Her bot 分布在 S1/S2/S3 三台内网服务器上（10.68.13.x），需要实现：

- 任意 bot 之间可以发送/接收 A2A 消息
- 动态发现：新增/下线 bot 不需要重新配置其他 bot
- 安全：内网认证，防止未授权访问
- 权限：可控制哪些 bot 可以互相通信

### 1.2 现有基础设施

| 组件             | 状态                      | 说明                                                 |
| ---------------- | ------------------------- | ---------------------------------------------------- |
| a2a-gateway 插件 | 已验证                    | 本地 101/104 测试通过，支持 JSON-RPC + REST + gRPC   |
| 共享 Redis       | 已部署                    | S1:6379，所有服务器可达，已用于 discussion broadcast |
| Docker 网络      | 每服务器独立              | 同服务器 `carher-net` 互通，跨服务器需端口映射       |
| 端口规则         | BASE = 29000 + (ID-1)\*10 | 18789/8000/8080/18891 已映射，**18800 未映射**       |

---

## 2. 行业调研

### 2.1 A2A 官方规范的三种发现机制

| 机制             | 描述                      | 适用场景                   |
| ---------------- | ------------------------- | -------------------------- |
| Well-Known URI   | `/.well-known/agent.json` | 公开 agent，需预知域名     |
| Curated Registry | 中心化注册中心            | 大规模动态发现（**推荐**） |
| Direct Config    | 静态 URL 配置             | 少量 agent，变化少         |

> A2A 规范明确指出："The A2A specification currently does not define a standard registry API."
> 但社区已有多个实现（Nacos、FastAPI reference、A2ABaseAI/A2ARegistry）。

### 2.2 行业最佳实践

**Registry 模式**（主流共识）：

- Agent 启动时向 registry 自注册（POST Agent Card）
- 其他 agent 按需查询 registry 发现 peer
- TTL/heartbeat 机制自动清理下线 agent
- 代表实现：Nacos（阿里，最成熟）、Google Cloud Agent Registry

**Solo.io 三层架构**（企业级参考）：

1. Agent Registry — Agent Card 的 CRUD 存储
2. Agent Naming Service (ANS) — 按能力/技能语义搜索
3. Agent Gateway — 名称解析 + 安全 + 可观测

**我们的选择**：取 Registry 模式的核心（自注册 + TTL），用已有 Redis 实现，不引入额外服务。

### 2.3 参考资料

- [A2A Agent Discovery (official spec)](https://a2a-protocol.org/latest/topics/agent-discovery/)
- [A2A Registry API Proposal — GitHub Discussion #741](https://github.com/a2aproject/A2A/discussions/741)
- [Nacos A2A Agent Registry](https://nacos.io/en/docs/latest/manual/user/ai/agent-registry/)
- [Solo.io: Agent Discovery, Naming, and Resolution](https://www.solo.io/blog/agent-discovery-naming-and-resolution---the-missing-pieces-to-a2a)
- [A2A Mesh Extension Proposal — Issue #499](https://github.com/a2aproject/A2A/issues/499)

---

## 3. 架构设计

### 3.1 总体方案：Redis Registry + 自注册

```
┌─────────────────────────────────────────────────────────────────┐
│                     Shared Redis (S1:6379)                       │
│                                                                 │
│  a2a:registry:{bot-id} = Agent Card JSON   (TTL 120s)          │
│  a2a:registry:index    = SET of bot-ids                         │
│                                                                 │
│  Bot 启动 → 写入 Agent Card → 每 60s 续约                       │
│  Bot 下线 → TTL 过期自动清除                                     │
│  Bot 查询 → SMEMBERS index → 按需 GET card                      │
└─────────────────────────────────────────────────────────────────┘
        ↑               ↑               ↑
   S1 (70 bots)    S2 (70 bots)    S3 (60 bots)
   10.68.13.186    10.68.13.187    10.68.13.188

每个 Bot:
  1. 启动时注册自己的 Agent Card 到 Redis
  2. 需要通信时从 Redis 查询目标 bot 的地址
  3. 直接调用目标 bot 的 A2A 端点（同服务器走 Docker DNS，跨服务器走内网 IP:Port）
```

### 3.2 为什么选 Redis 而非其他方案

| 方案               | 优点                                 | 缺点                                  |
| ------------------ | ------------------------------------ | ------------------------------------- |
| **Redis Registry** | 零新增服务、亚毫秒查询、TTL 天然支持 | 需在 a2a 插件中加 ~200 行注册逻辑     |
| 静态 Peers 配置    | 不需要 registry                      | 200 bot 配置爆炸，增删 bot 要全量重配 |
| Nacos              | 最成熟的 A2A registry                | 需部署 Java 服务，运维成本高          |
| mDNS               | 零配置                               | Docker bridge 不支持跨主机 multicast  |
| Consul/etcd        | 功能强大                             | 额外组件，过重                        |

### 3.3 网络通信

#### 端口映射

在 `start-user.sh` 中新增 a2a 端口映射：

```
PORT_A2A = BASE + 6
映射: -p ${SERVER_INTERNAL_IP}:${PORT_A2A}:18800
```

绑定内网 IP（非 0.0.0.0），仅内网可达。

#### 地址解析策略

Bot 注册时写入两个地址，调用方按优先级选择：

```json
{
  "id": "carher-13",
  "name": "卜弋天的Her",
  "server": "S1",
  "endpoints": {
    "docker": "http://carher-13:18800",
    "lan": "http://10.68.13.186:29126"
  },
  "skills": [{ "id": "chat", "name": "chat" }],
  "registeredAt": "2026-03-28T09:00:00Z"
}
```

调用方逻辑：

1. 如果目标 bot 在同一服务器 → 用 `docker` 地址（Docker DNS，零延迟）
2. 如果目标 bot 在其他服务器 → 用 `lan` 地址（内网 IP + 映射端口）

调用方自己知道自己在哪台服务器（通过环境变量 `CARHER_SERVER`）。

### 3.4 安全设计

#### 认证：共享 Bearer Token

```
所有 bot 共享一个 A2A_TOKEN（存在 servers.txt，注入容器环境变量）
↓
inbound: 验证请求携带正确 token
outbound: 自动附加 token 到请求头
```

**为什么共享 token 足够**：

- a2a 端口只绑定内网 IP，公网不可达
- Cloudflare tunnel 不转发 a2a 端口
- 所有 bot 都是我们管控的，不存在"不受信任的 agent"
- 后续可升级为 per-bot token + rotation（插件已支持 `tokens[]` 数组）

#### 端口安全

```
-p 10.68.13.186:29126:18800    (绑定内网 IP)
而非
-p 29126:18800                  (绑定 0.0.0.0)
```

### 3.5 权限设计

#### Phase 1：全开放（初期）

所有 bot 可以互相通信，无限制。

#### Phase 2：标签隔离（按需）

利用 Agent Card 的 `skills` 和 `tags` 字段 + registry 查询过滤：

```
查询: GET a2a:registry:* WHERE tags CONTAINS "dept-sales"
结果: 只返回销售部门的 bot 列表
```

#### Phase 3：ACL 控制（如需）

在 registry 中增加 `allowedCallers` 字段：

```json
{
  "id": "carher-1",
  "allowedCallers": ["carher-12", "carher-13"],
  "deniedCallers": []
}
```

a2a 插件在收到请求时校验调用方 ID。

---

## 4. 实施计划

### Phase 1：基础设施（1-2 天）

| 步骤 | 内容                                                         | 改动                         |
| ---- | ------------------------------------------------------------ | ---------------------------- |
| 1    | `start-user.sh` 增加 a2a 端口映射                            | `start-user.sh`              |
| 2    | `start-user.sh` 注入 `A2A_TOKEN` 和 `CARHER_SERVER` 环境变量 | `start-user.sh`              |
| 3    | a2a 插件烧入 Docker 镜像                                     | `Dockerfile`                 |
| 4    | `shared-config.json5` 加 a2a 默认配置                        | `docker/shared-config.json5` |

### Phase 2：Registry 功能（2-3 天）

| 步骤 | 内容                                     | 改动                          |
| ---- | ---------------------------------------- | ----------------------------- |
| 5    | a2a 插件增加 Redis 自注册逻辑            | `a2a-gateway/src/registry.ts` |
| 6    | a2a 插件增加 Redis peer 发现             | `a2a-gateway/src/registry.ts` |
| 7    | a2a 插件启动时注册、定时续约、关闭时注销 | `a2a-gateway/index.ts`        |

### Phase 3：灰度上线

| 步骤 | 内容                               |
| ---- | ---------------------------------- |
| 8    | 本地 101/104 验证 Redis registry   |
| 9    | S1 测试容器 carher-12 验证跨服务器 |
| 10   | S1 全量上线 → S2 → S3 分批滚动     |

---

## 5. Registry API 设计（Redis 实现）

### 数据结构

```
Key: a2a:card:{bot-id}           Value: Agent Card JSON    TTL: 120s
Key: a2a:index                   Value: SET of bot-ids     (无 TTL，按需清理)
Key: a2a:server:{server-name}    Value: SET of bot-ids     (按服务器分组)
```

### 操作

| 操作         | Redis 命令                                                                               | 触发时机     |
| ------------ | ---------------------------------------------------------------------------------------- | ------------ |
| 注册         | `SET a2a:card:{id} {json} EX 120` + `SADD a2a:index {id}` + `SADD a2a:server:{srv} {id}` | Bot 启动     |
| 续约         | `EXPIRE a2a:card:{id} 120`                                                               | 每 60 秒     |
| 注销         | `DEL a2a:card:{id}` + `SREM a2a:index {id}` + `SREM a2a:server:{srv} {id}`               | Bot 关闭     |
| 发现全部     | `SMEMBERS a2a:index` → `MGET a2a:card:{id1} a2a:card:{id2} ...`                          | 按需         |
| 发现同服务器 | `SMEMBERS a2a:server:{srv}`                                                              | 优化本地发现 |
| 发现单个     | `GET a2a:card:{id}`                                                                      | 点对点调用   |

### Agent Card 格式

```json
{
  "id": "carher-13",
  "name": "卜弋天的Her",
  "protocolVersion": "0.3.0",
  "server": "S1",
  "endpoints": {
    "docker": "http://carher-13:18800/a2a/jsonrpc",
    "lan": "http://10.68.13.186:29126/a2a/jsonrpc"
  },
  "skills": [
    { "id": "chat", "name": "通用对话" },
    { "id": "feishu-tools", "name": "飞书工具" }
  ],
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "registeredAt": "2026-03-28T09:00:00Z"
}
```

---

## 6. 架构图

```
                    ┌─────────────────────────┐
                    │   Redis (S1:6379)        │
                    │                         │
                    │  a2a:card:*   (TTL=120s)│
                    │  a2a:index    (bot SET) │
                    │  a2a:server:* (分组)    │
                    └────────┬────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
    ┌─────────▼──────┐ ┌────▼───────┐ ┌───▼────────────┐
    │  S1 (70 bots)  │ │ S2 (70)    │ │ S3 (60 bots)   │
    │ 10.68.13.186   │ │ .187       │ │ .188           │
    │                │ │            │ │                │
    │ carher-net     │ │ carher-net │ │ carher-net     │
    │ ┌───┐ ┌───┐   │ │ ┌───┐     │ │ ┌───┐         │
    │ │ 1 │↔│13 │   │ │ │ 6 │     │ │ │51 │         │
    │ └───┘ └───┘   │ │ └───┘     │ │ └───┘         │
    │   Docker DNS   │ │           │ │               │
    │   :18800 直连  │ │           │ │               │
    └───────┬────────┘ └─────┬─────┘ └──────┬────────┘
            │                │               │
            └────── 内网 10.68.13.x ─────────┘
              跨服务器: IP:Port (Bearer Token)

    Bot 间通信流程:
    ① Bot-13 想调用 Bot-51
    ② 查 Redis: GET a2a:card:carher-51
    ③ Bot-51 在 S3 → 用 lan 端点: http://10.68.13.188:29506/a2a/jsonrpc
    ④ 附上 Bearer Token → 发送 message/send
    ⑤ Bot-51 收到请求，验证 Token，处理并返回
```

---

## 7. 对比：原方案 vs 新方案

| 维度          | 原方案（静态 Peers）           | 新方案（Redis Registry）           |
| ------------- | ------------------------------ | ---------------------------------- |
| 新增/删除 bot | 重新生成 200 份配置 + 全量重启 | 零操作，自动注册/注销              |
| 配置文件数    | 200 个 peer JSON 文件          | 0 个（全在 Redis）                 |
| Bot 下线检测  | circuit breaker（被动）        | TTL 过期自动清理（主动）           |
| 跨服务器发现  | 预生成的 IP:Port 列表          | 实时查 Redis                       |
| 额外服务      | 无                             | 无（复用现有 Redis）               |
| 代码改动      | generate-a2a-peers.sh 脚本     | a2a 插件增加 ~200 行 registry 逻辑 |
| 运维复杂度    | 中（每次变更要跑脚本）         | 低（自动化）                       |

---

## 8. 风险与缓解

| 风险                 | 影响            | 缓解措施                                   |
| -------------------- | --------------- | ------------------------------------------ |
| Redis 不可用         | 无法发现新 peer | 本地缓存最近的 peer 列表，降级到缓存       |
| TTL 过期漏续约       | Bot 被误判下线  | 续约间隔 (60s) 远小于 TTL (120s)，双倍余量 |
| 共享 Token 泄漏      | 未授权访问      | 端口只绑内网 IP + 定期轮换 token           |
| 200 bot 同时查 Redis | Redis 压力      | 本地缓存 + 查询间隔限制（每 30s 刷新一次） |

---

## 9. A2A 工作机制详解

### 9.1 Her 如何知道自己能调 A2A？

**文档驱动，不是自动发现。** a2a-gateway 插件不注册原生的"发消息"工具。Her 通过 TOOLS.md 或 SKILL 描述学习 A2A 能力：

```
TOOLS.md 告诉 Her:
  "你可以通过 A2A 联系 tester2，执行:
   node /path/to/a2a-send.mjs --peer-url http://carher-102:18800 --message '...'"
↓
Her 收到用户请求后，判断需要咨询其他 bot
↓
Her 调用 exec 工具执行 a2a-send.mjs 脚本
↓
脚本发 JSON-RPC 请求到目标 bot 的 :18800
↓
返回目标 bot 的回答
```

### 9.2 被调用方如何感知 A2A 请求？

**不是 pub/sub，是同步 gateway RPC。** 完整调用链：

```
HTTP 请求到达 Her B 的 :18800 (a2a-gateway 插件)
  → 插件通过 WebSocket 连接本地 gateway (:18789)
  → 发送 "agent" RPC: { message: "...", sessionKey: "agent:default:a2a:{contextId}" }
  → gateway 创建/恢复 agent session（和收到飞书 DM 一样的流程）
  → Her B 的 agent 正常运行，生成回复
  → 回复返回给 a2a-gateway 插件
  → 插件通过 HTTP 响应返回给调用方
```

**对 Her B 来说，A2A 请求 = 收到一条来自特殊 session 的私信。**

### 9.3 三种通信方式对比

| 维度          | 飞书群聊             | Discussion pub/sub     | A2A                  |
| ------------- | -------------------- | ---------------------- | -------------------- |
| 触发          | 飞书 webhook 推送    | Redis pub/sub 广播     | HTTP JSON-RPC 直调   |
| Her 感知      | "群里有人说话了"     | "有 bot 发言了"        | "有人给我发了条私信" |
| Session       | 群聊 session（持续） | 同一个群聊 session     | 独立 A2A session     |
| 上下文        | 注入 20 条群历史     | 注入群历史 + turn 状态 | 只有调用方发来的文本 |
| 同步性        | 异步（webhook）      | 异步（pub/sub）        | 同步等待响应         |
| 对 Her 的影响 | 占用群聊 session     | 占用群聊 session       | 新建独立 session     |

---

## 10. 本地实验记录

### 10.1 实验环境

- tester (carher-101): a2a-gateway 已运行，HTTP :18800
- tester2 (carher-102): a2a-gateway 已运行，HTTP :18800
- 网络: 同一 Docker network (carher-net)，可通过容器名直连

### 10.2 基础验证（已通过）

```bash
# 101 -> 102 直接调用
docker exec carher-101 node /data/.openclaw/plugins/a2a-gateway/skill/scripts/a2a-send.mjs \
  --peer-url http://carher-102:18800 \
  --message "ping from tester (101), what is your name?"
# 结果: "我是 tester，1号测试 AI"  ← 102 正常回复

# 101 -> 104 (之前修复了 device identity mismatch)
# 结果: "Hey. I just came online..." ← 正常
```

### 10.3 Agent 自主 A2A 实验（已完成）

**方案演进**: TOOLS.md + exec 脚本方式被弃用。改为原生工具注册 (`a2a_send`)，agent 自动在工具列表中看到并使用。

### 10.4 完整压力测试（2026-03-29，已通过）

**环境**: 4 个 bot (101-104)，2 个飞书群并行，镜像 `carher:a2a-test` (基于 dev 最新)

**测试内容**: bot 自主设计 A2A 压测方案，包括：

- T1 单跳 ping-pong
- T2 链式传递 (A→B→C)
- T3 超时测试 (35s 长任务)
- T4 并发写回 (同时发 4 个 A2A)
- T5 双向并发

**结果**:

| Bot           | A2A Tasks | 完成   | 失败  | 错误  | 并发峰值 |
| ------------- | --------- | ------ | ----- | ----- | -------- |
| 101 (tester)  | 14        | 14     | 0     | 0     | 2        |
| 102 (tester2) | 16        | 16     | 0     | 0     | 2        |
| 103 (tester3) | 20        | 20     | 0     | 0     | 4        |
| 104 (tester4) | 19        | 19     | 0     | 0     | 2        |
| **总计**      | **69**    | **69** | **0** | **0** | —        |

**100% 成功率，零失败，零错误。**

**修复的问题**:

1. Agent Card `url` 用 `localhost` 导致 A2A 打回自己 → 改为用容器 hostname
2. `a2a_send(peer='?')` 返回空 → registry cache 未刷新，改为每次调用前 await 刷新
3. 插件 node_modules 缺失 → start-user.sh 自动 `npm install --omit=dev`
4. device identity mismatch → 重新生成 device.json（公钥和 deviceId 不匹配）

**结论**: 本地验证通过，可以灰度上线。

### 10.5 线上灰度测试（2026-03-31，已通过）

**环境**: 4 bot 跨 3 台服务器（S1/S2/S3），镜像 `carher:release-312`，分支 `release/v2026.3.12-plus`

| Bot | ID | 服务器 | 用户 |
|-----|-----|--------|------|
| carher-13 | 13 | S1 (10.68.13.186) | 卜弋天 |
| carher-14 | 14 | S3 (10.68.13.188) | 刘国现 |
| carher-66 | 66 | S2 (10.68.13.187) | 白羽 |
| carher-75 | 75 | S3 (10.68.13.188) | 林森 |

**验证结果**:

| 维度 | 结果 |
|------|------|
| 跨服务器 A2A 通信 | ✅ S1→S3, S1→S2 全通 |
| Redis Registry 自注册 | ✅ 4/4 注册 |
| 跨服务器 Peer 发现 | ✅ 每个 bot 发现 3 peers |
| LAN 端点路由 | ✅ 跨服务器走 LAN IP:Port |
| Owner OAuth 权限 | ✅ A2A session 使用 owner 的 user_access_token |
| 日历完整信息（标题/参会人/会议室） | ✅ 林森、白羽完整返回 |
| Known Bots | ✅ 77 entries |
| Discussion Mode 兼容 | ✅ 不影响群聊讨论 |

**修复的关键问题**:

1. **Agent Card URL 用 localhost** → 改为 LAN IP（`CARHER_LAN_IP:CARHER_A2A_PORT`）
2. **refreshRegistryPeers 总用 Docker 端点** → 改为用 registry 已选路的 agentCardUrl
3. **registryManager/ownerAccountId 多实例 null** → 提升到模块级别变量
4. **A2A session 没有 OAuth 权限感知** → 注入 extraSystemPrompt 告知 bot 拥有 owner 的完整 OAuth 权限
5. **插件文件 ownership 被 Docker 安全检查拒绝** → git pull 后 chown root
6. **seed participants 不清理历史** → 加 DEL before ZADD

**部署流程（已验证）**:
```bash
# 每台服务器一次性操作
cd /Data/CarHer
git checkout release/v2026.3.12-plus  # 或 git pull
sudo chown -R root:root docker/plugins/a2a-gateway/  # npm install 后
./start-user.sh --id=N --image=carher:release-312
```

---

## 11. Her 社交网络 — 能力发现与 A2A 协作

> 日期: 2026-03-31 (创建) / 2026-04-01 (灰度验证通过)
> 状态: **灰度运行中** — S1 carher-13 + S3 carher-75 已开启
> 方案: Skill 驱动 + 飞书 Bitable 能力目录 + A2A_ENABLED 开关

### 11.1 实际落地方案

**不写搜索代码。** Her 已经有 `feishu_search` + `feishu_bitable` + `a2a_send` 三个工具。只需要一个 skill 文件教会 her 怎么组合使用它们。

```
用户: "帮我找个财务的her问问报销政策"
  ↓
Her 读取 her-social-network skill → 知道要搜 "autolink-her-table"
  ↓
feishu_search({ query: "autolink-her-table", include_bitable: true })
  → 找到飞书多维表格
  ↓
feishu_bitable({ action: "list_records", ... })
  → 读取所有 her 的能力目录
  ↓
匹配 "财务" → 找到 "财务管理的Her (刘本)"
  ↓
a2a_send({ peer: "财务管理的Her", message: "请问最新的报销政策是什么？" })
  → 刘本的 Her 用刘本的 OAuth 权限查文档并回复
  ↓
Her → 用户: 综合回复
```

### 11.2 组件

#### 能力目录: autolink-her-table

飞书多维表格，人工维护，全员可读。

| 列 | 类型 | 说明 |
|----|------|------|
| bot_id | Text | carher-13 |
| bot_name | Text | 弋天的her（必须和 A2A peer name 一致） |
| owner_name | Text | 卜弋天 |
| department | Text | 技术中心 |
| skills_summary | Text | 自然语言能力描述 |
| tags | Text | 逗号分隔标签 |
| app_id | Text | cli_a917e5525178dbb3 |

**bot_name = A2A peer name。** 全系统只有一个名字，格式为"X的her"。`start-user.sh` 自动追加"的her"后缀。

#### Skill 文件: her-social-network

路径: `docker/skills/her-social-network/SKILL.md`

A2A 开启时自动合并到容器的 skills 目录，A2A 关闭时不可见。Skill 教 her 三步操作:
1. `feishu_search({ query: "autolink-her-table", include_bitable: true })`
2. `feishu_bitable({ action: "list_records", ... })`
3. `a2a_send({ peer: "<bot_name>", message: "..." })`

#### A2A_ENABLED 开关

`start-user.sh` 通过环境变量控制 per-container 开关：

```bash
# 开启 A2A（加载插件 + 合并 skill）
A2A_ENABLED=1 ./start-user.sh --id=13

# 默认关闭（无插件、无 skill、无 A2A 工具）
./start-user.sh --id=4
```

开关控制两件事：
- **插件**: 是否挂载 `docker/plugins/a2a-gateway/` → 决定有无 `a2a_send` 工具
- **Skill**: 是否将 `docker/skills/` 合并到 skills 目录 → 决定 her 能否看到社交网络 skill

关闭时：容器看不到 A2A 相关的任何 tool 和 skill，和没有 A2A 功能的容器完全一样。

#### findPeer 增强

`a2a-gateway/index.ts` 的 `findPeer` 同时匹配 peer name 和 card.id：
```typescript
const findPeer = (name: string): PeerConfig | undefined => {
  const lower = name.toLowerCase();
  return getEffectivePeers().find(
    (p) => p.name.toLowerCase() === lower || (p as any).card?.id?.toLowerCase() === lower,
  );
};
```

### 11.3 服务器部署架构

```
/Data/CarHer/          ← 主 repo, dev 分支, 无 A2A
  └─ 73 个生产容器从这里启动（./start-user.sh --id=N）

/Data/CarHer-grayscale/ ← worktree, release/v2026.3.12-plus 分支, 有 A2A
  └─ 4 个灰度容器从这里启动（A2A_ENABLED=1 ./start-user.sh --id=N）
```

灰度容器和生产容器完全隔离。主 repo 无 A2A 插件、无 A2A 配置。任何生产容器重启不受影响。

### 11.4 灰度状态

| 容器 | 服务器 | A2A | 验证结果 |
|------|--------|-----|---------|
| carher-13 | S1 | ON | ✅ A2A 通信正常 |
| carher-75 | S3 | ON | ✅ A2A 通信正常 |
| carher-66 | S2 | OFF | ✅ 无 A2A，无 skill，隔离正确 |
| carher-14 | S3 | OFF | ✅ 无 A2A，无 skill，隔离正确 |

### 11.5 下一步

| 优先级 | 任务 |
|--------|------|
| P0 | 能力目录灌入全部 77 个 bot 的数据（当前只有 4 条） |
| P1 | tags 标准化分类体系 |
| P2 | 全量上线 — 所有容器开启 A2A |
| P3 | Skills 自动生成（从通讯录/文档空间/交互历史推断） |
