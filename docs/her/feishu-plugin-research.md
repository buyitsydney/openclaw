# Feishu 插件生态调研 & 架构设计

> 日期: 2026-05-04
> 目标: 调研 4 个 Feishu 工具/插件，评估如何简化 feishu-her，推荐 her + ONE 的组合方案

---

## 1. 四个工具/插件概览

### 1.1 feishu-her（CarHer 自研）

| 属性 | 值 |
|------|---|
| 路径 | `docker/plugins/feishu-her/` |
| 类型 | OpenClaw 本地插件（非 npm） |
| 产线 LOC | ~28,771 行（含 tools） |
| gateway.ts | 3,809 行 |
| outbound.ts | 1,891 行 |
| tools | 33 个飞书 API 工具 |
| 依赖 | `@larksuiteoapi/node-sdk`, Redis, ffmpeg |
| 独有能力 | Discussion Mode, Bot Registry, Group Archive, Memory Bridge, knowledge_qa, CardStream V1/V2, Reasoning Stream, OAuth Device Flow |

### 1.2 extensions/feishu（OpenClaw 上游官方）

| 属性 | 值 |
|------|---|
| 路径 | `extensions/feishu/` |
| 类型 | OpenClaw bundled channel plugin |
| 产线 LOC | ~21,807 行 |
| tools | 12 个：`feishu_bitable_*`(8), `feishu_chat`, `feishu_doc`, `feishu_drive`, `feishu_wiki`, `feishu_perm`, `feishu_app_scopes` |
| 关键架构 | `sequential-queue.ts`（16 行，per-chat 串行队列），`reply-dispatcher.ts`（519 行，deliveredFinalTexts 防重复） |
| 优势 | 与 OpenClaw core 紧密集成，享受上游所有 bug fix，streaming card，typing indicator，thread binding |

### 1.3 larksuite/openclaw-lark（字节跳动官方 OpenClaw 插件）

| 属性 | 值 |
|------|---|
| npm | `@larksuite/openclaw-lark` v2026.4.1 |
| 类型 | OpenClaw channel plugin（npm 安装） |
| License | MIT |
| 最低要求 | OpenClaw >= 2026.2.26, Node >= 22 |
| tools | IM read/write/search, docs, bitable, sheets, calendar, tasks |
| 独有能力 | Interactive Cards（确认按钮），Per-group Skills 绑定，Advanced Group Config，MCP-doc |
| 群历史 | 支持 `feishu_im_user_get_messages`（按 chat_id 拉取），`feishu_im_user_get_thread_messages`（话题回复），`feishu_im_user_search_messages`（关键词搜索） |

### 1.4 larksuite/cli（字节跳动官方飞书 CLI）

| 属性 | 值 |
|------|---|
| GitHub | [larksuite/cli](https://github.com/larksuite/cli) |
| npm | `@larksuite/cli` |
| 类型 | 独立 CLI 工具 + AI Agent Skills |
| License | MIT |
| 语言 | Go（编译为单二进制） |
| 业务域 | **17 个**: IM, Doc, Base, Sheets, Slides, Calendar, Mail, Tasks, Wiki, Contact, Meetings, Attendance, Approval, OKR, Drive, Minutes, Whiteboard |
| 命令数 | **200+** 精选命令（封装 2500+ 飞书 API） |
| AI Skills | **24 个**: lark-im, lark-calendar, lark-doc, lark-drive, lark-base, lark-sheets, lark-slides, lark-task, lark-mail, lark-contact, lark-wiki, lark-event, lark-vc, lark-minutes, lark-whiteboard, lark-approval, lark-attendance, lark-okr, lark-markdown, lark-openapi-explorer, lark-skill-maker, lark-shared, lark-workflow-meeting-summary, lark-workflow-standup-report |
| 安装 | `npm install -g @larksuite/cli` + `npx skills add larksuite/cli -y -g` |
| 认证 | `lark-cli auth login`（OAuth），支持 `--as user` / `--as bot` 身份切换 |
| 三层命令 | Shortcuts (`+agenda`)、API Commands (`calendars list`)、Raw API (`api GET /open-apis/...`) |

**核心优势**:
- 飞书开放平台团队官方维护，2026.3.28 开源，上线即 1000+ Star
- 专为 AI Agent 设计：出错时告诉 AI 怎么修复，缺权限自动引导补授权，优化 token 消耗
- 24 个 Skill 可直接注册为 OpenClaw skills，无需写代码
- 覆盖面最广（17 域 vs feishu-her 的 ~10 域 vs upstream feishu 的 ~5 域）

---

## 2. 功能对比矩阵

### 2.1 Channel 基础能力

| 能力 | feishu-her | upstream feishu | openclaw-lark | lark-cli | 评估 |
|------|:----------:|:---------------:|:-------------:|:--------:|------|
| WebSocket 长连接 | ✅ | ✅ | ✅ | N/A (CLI) | lark-cli 是工具不是 channel |
| 消息去重 | ✅ 500条内存 | ✅ core dedup | ✅ | N/A | — |
| **Sequential Queue** | ❌ 无 | ✅ 16行 | ❓ | N/A | **feishu-her 致命缺陷**，导致 "睡着" |
| **deliveredFinalTexts** | ❌ 无 | ✅ 519行 | ❓ | N/A | **feishu-her 致命缺陷**，导致重复消息 |
| Card Streaming | ✅ V1+V2 | ✅ streaming-card | ✅ | N/A | — |
| Typing Indicator | ✅ ACK emoji | ✅ reaction | ❓ | N/A | — |
| Thread/Topic 支持 | 部分 | ✅ thread-bindings | ✅ | N/A | — |
| 多媒体 | ✅ 最丰富 | ✅ | ✅ | ✅ 下载 | — |
| Markdown→Card 转换 | ✅ 自研 | ✅ SDK共享 | ✅ | N/A | — |

### 2.2 飞书 API Tools

| Tool | feishu-her | upstream feishu | openclaw-lark | lark-cli |
|------|:----------:|:---------------:|:-------------:|:--------:|
| Bitable (多维表格) | ✅ | ✅ 8个 | ✅ | ✅ lark-base |
| Doc (云文档) CRUD | ✅ | ✅ feishu_doc | ✅ | ✅ lark-doc |
| Wiki (知识库) | ✅ | ✅ feishu_wiki | ✅ | ✅ lark-wiki |
| Drive (云盘) | ✅ | ✅ feishu_drive | ✅ | ✅ lark-drive |
| Sheet (电子表格) | ✅ | ❌ | ✅ | ✅ lark-sheets |
| Calendar (日历) | ✅ | ❌ | ✅ | ✅ lark-calendar |
| Task (任务) | ✅ | ❌ | ✅ | ✅ lark-task |
| Chat (群管理) | ✅ 6个 | ✅ feishu_chat | ✅ | ✅ lark-im |
| IM History (群历史) | ✅ chat-history | ❌ | ✅ | ✅ `+chat-messages-list` |
| Message Search | ✅ | ❌ | ✅ | ✅ `+messages-search` |
| Directory (通讯录) | ✅ | ❌ | ❌ | ✅ lark-contact |
| Minutes (会议纪要) | ✅ | ❌ | ❌ | ✅ lark-minutes |
| Mail (邮箱) | ❌ | ❌ | ❌ | ✅ lark-mail |
| Slides (幻灯片) | ❌ | ❌ | ❌ | ✅ lark-slides |
| Approval (审批) | ❌ | ❌ | ❌ | ✅ lark-approval |
| OKR | ❌ | ❌ | ❌ | ✅ lark-okr |
| Attendance (考勤) | ❌ | ❌ | ❌ | ✅ lark-attendance |
| Meetings (会议) | ❌ | ❌ | ❌ | ✅ lark-vc |
| Whiteboard (白板) | ✅ | ❌ | ❌ | ✅ lark-whiteboard |
| Permission (权限) | ❌ | ✅ feishu_perm | ✅ | 部分 |
| **knowledge_qa** | ✅ 独有 | ❌ | ❌ | ❌ |
| **deep_search** | ✅ 独有 | ❌ | ❌ | ❌ |
| **覆盖域总数** | ~10 | ~5 | ~10 | **17** |

### 2.3 feishu-her 独有能力（无法被替代的）

| 能力 | 行数 | 可被替代？ | 评估 |
|------|-----:|:----------:|------|
| **Discussion Mode（多机器人讨论）** | ~1500 | ❌ | Redis 分布式 leader election + turn scheduling，完全独创 |
| **Bot Registry（动态发现）** | ~200 | ❌ | Redis self-register，零重启发现对等 bot |
| **knowledge_qa (飞书 AI 搜索)** | ~570 | ❌ | 飞书 `/search/v2/knowledge_qa/` SSE 接口，非标 API |
| **OAuth Device Flow + Direct Card** | ~150 | 部分 | 上游有 OAuth，但 feishu-her 的 card 直投方式独特 |
| **Group Archive + Memory Bridge** | ~600 | 部分 | openclaw-lark 可在线拉历史，但 feishu-her 的 JSONL 离线存储有断网容灾价值 |
| **Reasoning Stream** | ~100 | ❌ | fleet kill switch + 思维链实时预览 |
| **Group Context Injection (20条)** | ~150 | 部分 | 可用 openclaw-lark 的 IM history API 替代 |
| **Slash commands (/voice, /quota, /summary)** | ~200 | ❌ | 业务特定 |
| **Card Text Cache** | ~80 | ❌ | V2 card readback degraded 的 workaround |

---

## 3. Group History 必要性评估

### 3.1 feishu-her 的 Group Archive 做了什么？

1. **JSONL 离线存档**: 每个群一个 `.jsonl` 文件，记录所有消息（人+机器人）
2. **Quoted Message Fallback**: 飞书 API 拉引用消息失败时，从本地 archive 找
3. **Memory Bridge**: 把 archive 写入 `workspace/memory/feishu-groups/` 供 `memory_search`
4. **Binary Attachment Archive**: 下载音频/图片/文件到本地

### 3.2 替代方案

| 场景 | 用 archive 的理由 | 替代方案 |
|------|-------------------|---------|
| AI 需要看群上下文 | 注入最近 20 条 | **lark-cli** `lark-cli im +chat-messages-list --chat-id oc_xxx` 实时拉取 |
| 引用消息找不到 | 本地 fallback | **飞书 API 直接拉取**，极少数情况才失败（权限/删除） |
| memory_search 需要群内容 | memory bridge 写入 | **AI 主动调用 lark-cli** `+messages-search` 按需搜索 |
| 断网容灾 | 离线可用 | Docker 环境不存在断网场景 |

### 3.3 结论：**Group Archive 可以移除**

- 飞书 API 已经提供完整的群消息历史读取能力
- lark-cli 的 `+chat-messages-list` + `+messages-search` 覆盖了所有查询场景
- Memory Bridge 只是把飞书云端数据再复制一份到本地——多此一举
- **唯一保留理由**: Card Text Cache（V2 card readback degraded），这个 ~80 行的 workaround 可以独立保留，不依赖 archive

---

## 4. Channel 层深度对比：openclaw-lark vs upstream feishu

feishu-her 的 channel 层（gateway.ts 3809 行 + outbound.ts 1891 行）是 bug 最密集的部分。**替换 channel 层才是真正的瘦身**，只删 tools 治标不治本。

### 4.1 openclaw-lark vs upstream feishu Channel 层

| 维度 | upstream feishu | openclaw-lark | 赢家 |
|------|:-:|:-:|:-:|
| Card Streaming 状态机 | Boolean flag（isActive） | **7 阶段验证状态机** (idle→creating→streaming→completed/aborted/terminated/creation_failed) | **openclaw-lark** |
| CardKit 版本 | v1 | **v2 + IM fallback** | **openclaw-lark** |
| 新消息中断旧流式 | 无 | **abort-detect.ts 主动中断 + 显示部分内容** | **openclaw-lark** |
| 工具调用显示 | 无 | **tool-use trace（步骤、耗时、标题后缀）** | **openclaw-lark** |
| 卡片内图片渲染 | 无（raw markdown） | **ImageResolver 异步上传飞书 IM + img_key** | **openclaw-lark** |
| 表格溢出处理 | 无（静默失败） | **检测 230099/11310, 降级 + 清理** | **openclaw-lark** |
| 频率限制 | 无 | **230020 静默跳帧** | **openclaw-lark** |
| 流式节流 | 100ms 硬编码 | **FlushController: CardKit=100ms, IM=1500ms, long-gap 批量优化** | **openclaw-lark** |
| 消息撤回处理 | 每次发送检测 | **UnavailableGuard 状态机 + 主动终止** | **openclaw-lark** |
| 卡片 Footer | Agent + Model | **Agent + Model + Tokens + Cache命中 + 耗时** | **openclaw-lark** |
| Reasoning 显示 | blockquote 格式 | **阶段指示器 + 耗时 + 分区** | **openclaw-lark** |
| 消息类型解析 | ~8 种 | **20+ 种**（calendar, todo, vote, sticker, location, hongbao 等） | **openclaw-lark** |
| 消息去重持久化 | **24h 磁盘+内存双层** | 仅内存（重启丢失） | **upstream** |
| Typing 防重复推送 | **跳过已存在 reaction** | 不确定 | **upstream** |
| Thread Bindings | **SDK SessionBindingAdapter** | 仅 queue 级别 | **upstream** |
| 测试覆盖 | **32 文件, ~18k 行, e2e** | 20 文件, 无 lifecycle 测试 | **upstream** |

**结论：openclaw-lark 的 channel 层全面领先**，尤其是 UI 相关（流式卡片、工具追踪、图片渲染、中断显示）。upstream feishu 优于去重持久化和测试覆盖——这两项可以移植。

### 4.2 三件套方案（推荐）

| 组件 | 职责 | channel 注册 |
|------|------|:---:|
| **openclaw-lark** | Channel 层（CardKit v2 流式、abort-detect、UnavailableGuard、消息收发）+ 40+ tools | ✅ `"feishu"` |
| **lark-cli** | 补全 openclaw-lark 没有的域（mail, slides, approval, OKR, attendance, meetings, 共 24 skills） | 无（独立 CLI） |
| **feishu-her → 无 channel 纯业务插件** | Discussion Mode, Bot Registry, knowledge_qa, /voice /quota /summary, Reasoning stream | ❌ 删除 channel |

### 4.3 为什么是三件套而不是两件套？

1. **openclaw-lark 管 channel + 基础 tools**: 解决 channel 层 bug 密集问题，CardKit v2 流式、abort-detect、图片渲染等都是生产级
2. **lark-cli 补全 API 覆盖**: openclaw-lark 覆盖 ~10 域，lark-cli 补齐 mail/slides/approval/OKR/attendance/meetings/whiteboard，合计 17 域
3. **feishu-her 只保留独有业务逻辑**: Discussion Mode、Bot Registry、knowledge_qa 等完全独创的能力，无替代品
4. **feishu-her 的 outbound.ts 整个删除**: 这是 1891 行 bug 最多的代码，全部由 openclaw-lark 接管

### 4.2 架构设计

```
┌──────────────────────────────────────────────────────────────────────┐
│                         OpenClaw Gateway                              │
│                                                                      │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐  │
│  │     feishu-her (瘦身版)       │  │     lark-cli (24 Skills)      │  │
│  │                              │  │                              │  │
│  │  Channel 层 (保留):          │  │  注册为 OpenClaw skills:     │  │
│  │  - WebSocket transport       │  │  - lark-im (消息/群管理)     │  │
│  │  - Sequential Queue ←PORT   │  │  - lark-calendar (日历)      │  │
│  │  - deliveredFinalTexts ←PORT │  │  - lark-doc (云文档)         │  │
│  │  - Card Stream V1/V2        │  │  - lark-base (多维表格)       │  │
│  │  - ACK emoji reaction       │  │  - lark-sheets (电子表格)     │  │
│  │  - Group Mode dispatch      │  │  - lark-task (任务)           │  │
│  │  - Reasoning stream          │  │  - lark-mail (邮箱)          │  │
│  │                              │  │  - lark-wiki (知识库)         │  │
│  │  独有业务 (保留):             │  │  - lark-drive (云盘)         │  │
│  │  - Discussion Mode           │  │  - lark-contact (通讯录)     │  │
│  │  - Bot Registry              │  │  - lark-minutes (会议纪要)   │  │
│  │  - knowledge_qa              │  │  - lark-approval (审批)      │  │
│  │  - /voice, /quota, /summary  │  │  - lark-slides (幻灯片)      │  │
│  │  - OAuth Direct Card         │  │  - lark-vc (会议)            │  │
│  │                              │  │  - lark-okr                  │  │
│  │  删除:                        │  │  - lark-attendance (考勤)    │  │
│  │  - ❌ group-archive.ts       │  │  - lark-whiteboard           │  │
│  │  - ❌ memory-bridge.ts       │  │  - ...等 24 个               │  │
│  │  - ❌ sent-message-log.ts    │  │                              │  │
│  │  - ❌ 29 个自研 feishu_* tools│  │  认证: lark-cli auth login  │  │
│  │  - ❌ Group Context Injection │  │  (独立 OAuth, 不干扰 her)    │  │
│  └──────────────────────────────┘  └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.3 瘦身目标

| 指标 | 当前 | 目标 | 变化 |
|------|-----:|-----:|------|
| gateway.ts | 3,809 行 | ~1,800 行 | -53% |
| outbound.ts | 1,891 行 | ~1,200 行 | -37% |
| tools/*.ts | ~15,000 行 | ~800 行（仅 knowledge_qa + discussion + bot-directory） | -95% |
| 总 LOC | ~28,771 | ~8,000 | **-72%** |
| 自研 tools 数量 | 33 | 4 | -88% |
| 飞书业务域覆盖 | ~10 | **17**（lark-cli 补齐） | +70% |

### 4.4 架构设计

```
┌────────────────────────────────────────────────────────────────────────┐
│                          OpenClaw Gateway                              │
│                                                                        │
│  ┌─────────────────────┐ ┌──────────────────┐ ┌────────────────────┐  │
│  │  openclaw-lark       │ │  lark-cli        │ │  feishu-her (瘦身)  │  │
│  │  (Channel + Tools)   │ │  (24 Skills)     │ │  (纯业务, 无channel)│  │
│  │                     │ │                  │ │                    │  │
│  │  Channel 层:        │ │  补全域:          │ │  独有业务:          │  │
│  │  - CardKit v2 流式   │ │  - lark-mail     │ │  - Discussion Mode │  │
│  │  - abort-detect     │ │  - lark-slides   │ │  - Bot Registry    │  │
│  │  - UnavailableGuard │ │  - lark-approval │ │  - knowledge_qa    │  │
│  │  - FlushController  │ │  - lark-okr      │ │  - /voice /quota   │  │
│  │  - ImageResolver    │ │  - lark-attendance│ │  - /summary        │  │
│  │  - tool-use trace   │ │  - lark-vc       │ │  - Reasoning stream│  │
│  │  - 20+ msg types    │ │  - lark-whiteboard│ │  - OAuth Direct    │  │
│  │                     │ │  - ...           │ │                    │  │
│  │  Tools:             │ │  已有 on docker13 │ │  删除:              │  │
│  │  - IM history/search│ │                  │ │  - ❌ outbound.ts   │  │
│  │  - bitable/doc/wiki │ │                  │ │  - ❌ gateway 收发  │  │
│  │  - calendar/task    │ │                  │ │  - ❌ card stream   │  │
│  │  - sheets/drive/chat│ │                  │ │  - ❌ 29 个 tools   │  │
│  │                     │ │                  │ │  - ❌ group-archive │  │
│  └─────────────────────┘ └──────────────────┘ │  - ❌ memory-bridge │  │
│                                               └────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.5 瘦身目标

| 指标 | 当前 | 目标 | 变化 |
|------|-----:|-----:|------|
| gateway.ts | 3,809 行 | ~600 行（Discussion + Bot Registry + slash commands） | **-84%** |
| outbound.ts | 1,891 行 | **0（整个删除）** | **-100%** |
| tools/*.ts | ~15,000 行 | ~800 行（knowledge_qa + discussion + bot-directory） | -95% |
| 总 LOC | ~28,771 | ~3,000 | **-90%** |
| Channel 层 bug 面 | 5,700 行自研 | **0（由 openclaw-lark 接管）** | **-100%** |
| 飞书业务域覆盖 | ~10 | **17**（openclaw-lark + lark-cli 合计） | +70% |

---

## 5. Discussion Mode 耦合度分析

**这是本方案最大的技术风险。** Discussion Mode 深度耦合 feishu-her 的 channel 层。

### 5.1 耦合点分类

#### HARD 耦合（直接调用 channel 收发函数，必须重新实现）

| # | 位置 | 调用 | 说明 |
|---|------|------|------|
| H1 | `gateway.ts:1076-1097` | `buildDiscussionTurnEvent()` | 构造飞书格式的假 inbound 消息（message_id, chat_id, sender_id 等），注入 `handleInboundMessage()` |
| H2 | `gateway.ts:1151-1161` | `handleInboundMessage(fakeEvent)` | fast-path: Redis broadcast 触发时立即注入假消息 |
| H3 | `gateway.ts:1226-1236` | `handleInboundMessage(fakeEvent)` | tick-timer: 10 秒轮询后注入假消息 |
| H4 | `gateway.ts:3030-3046` | `createFeishuCardStream()` | `canEmitVisibleDiscussionReply()` 决定是否创建卡片流 |
| H5 | `gateway.ts:3101-3131` | `deleteFeishuMessage()` | Discussion 发现 stale turn 时删除幽灵卡片 |
| H6 | `gateway.ts:3477-3488` | `handleDiscussionOutboundMessage()` | 卡片 finalize 后推进 Redis turn state |
| H7 | `gateway.ts:3787-3800` | `handleDiscussionOutboundMessage()` | 每条文本发送后推进 turn state |
| H8 | `gateway.ts:3743-3754` | `handleDiscussionOutboundMessage()` | 媒体发送后推进 turn state |

#### HOOK 耦合（需要拦截 inbound/outbound 流程）

| # | 位置 | 行为 | 说明 |
|---|------|------|------|
| K1 | `gateway.ts:1099-1161` | Redis pub/sub → inject | 监听 peer bot 消息，fast-path 注入 turn |
| K2 | `gateway.ts:1171-1241` | 10s timer → inject | 轮询 Redis，注入 assigned turn |
| K3 | `gateway.ts:2988-3006` | outbound 前置门控 | `canEmitVisibleDiscussionReply()` 在 5 个点拦截发送 |
| K4 | `gateway.ts:3492-3503` | dispatch 完成后 hook | 静默 dispatch（无可见输出）时推进 turn |

#### SOFT 耦合（读取标识符/配置，可泛化）

| # | 位置 | 依赖 | 说明 |
|---|------|------|------|
| S1 | `gateway.ts:1302-1305` | `appId`, `botOpenId`, `knownBotOpenIds` | 飞书特定 ID 格式（`cli_xxx`, `ou_xxx`） |
| S2 | `gateway.ts:2321-2468` | `chatId` (`oc_xxx`), mentions | 飞书格式的 @mention 解析 |
| S3 | `discussion-outbound.ts:37-42` | `chatId.startsWith("oc_")` | 硬编码飞书群 ID 前缀 |

#### 完全可移植（零 channel 依赖）

- **`discussion-state.ts`** — 纯 Redis 状态机，零 channel import
- **`discussion-lifecycle.ts`** — 工具定义，只调用 `discussion-state.ts`
- **`discussion-leader.ts`** — 工具定义，只调用 `discussion-state.ts`

### 5.2 Discussion Mode 最小抽象接口

```typescript
interface DiscussionChannelInterface {
  // H1/H2/H3/K1/K2: 注入假 inbound 消息触发 bot 回复
  injectSyntheticTurn(chatId: string, turn: DiscussionTurnState): Promise<void>

  // H4/K3: outbound 前置门控
  canSendVisibleReply(chatId: string, turnId: string): Promise<boolean>

  // H5: 清理幽灵卡片
  deletePendingCard(chatId: string, messageId: string): Promise<void>

  // H6/H7/H8: 消息发送后回调
  onMessageSent(chatId: string, messageId: string, text: string): Promise<void>

  // K4: dispatch 完成后回调
  onTurnCompleted(chatId: string, hadVisibleOutput: boolean): Promise<void>

  // S3: 判断是否为群聊
  isGroupChat(chatId: string): boolean
}
```

### 5.3 可行性评估

| 问题 | 评估 |
|------|------|
| `injectSyntheticTurn` 能否实现？ | **最大难点**。需要构造 openclaw-lark 格式的假 inbound 事件并注入其 channel pipeline。需要 openclaw-lark 暴露 hook 或 feishu-her 直接调用 openclaw-lark 的内部 API |
| `canSendVisibleReply` 能否拦截？ | **可行**。OpenClaw plugin SDK 有 `onReplyStart`/`deliver` callback，可以在 deliver 层加 gate |
| `onMessageSent` 能否 hook？ | **可行**。openclaw-lark 的 deliver callback 完成后可以 emit 事件 |
| 两个插件能否共存？ | **可行但需改造**: feishu-her 删除 `"channels": ["feishu"]`，改为 `"channels": []`，只注册 tools + hooks |

**结论: Discussion Mode 拆分技术上可行，但 `injectSyntheticTurn` 需要 openclaw-lark 配合暴露内部 hook。** 这不是 0 风险 — 如果 openclaw-lark 的 inbound pipeline 不支持外部注入，Discussion Mode 无法独立运行。

### 5.4 降风险方案: 分阶段迁移

| 阶段 | 做什么 | 风险 |
|------|--------|:----:|
| **Phase 0** | 只删 tools + group-archive，保留 channel 层不动 | **极低** |
| **Phase 1** | 安装 openclaw-lark + lark-cli，feishu-her 保持 channel | **极低** |
| **Phase 2** | 让 openclaw-lark 的 tools 替代 feishu-her 的 tools，验证功能 | **低** |
| **Phase 3** | 将 feishu-her 的 channel 迁移到 openclaw-lark，Discussion Mode 通过 hook 接入 | **高** |

**Phase 0-2 是 0 风险的**，可以立即执行。Phase 3 需要深入 openclaw-lark 源码确认 hook 可行性。

---

## 6. 风险与注意事项

### 6.1 OpenClaw channel 唯一约束

- `src/plugins/registry.ts:470`: `channel already registered: ${id}` — 同一 channel 只能一个插件注册
- feishu-her 和 openclaw-lark 都注册 `"feishu"` channel
- **Phase 0-2 解法**: 不安装 openclaw-lark 的 channel，只用其 tools（如果支持）
- **Phase 3 解法**: feishu-her 改为 `"channels": []`，openclaw-lark 管 channel

### 6.2 openclaw-lark 去重无持久化

- openclaw-lark 的消息去重仅内存，重启后丢失
- upstream feishu 有 24h 磁盘双层去重
- **解法**: 从 upstream 移植 `dedup.ts` 到 openclaw-lark 或 feishu-her

### 6.3 lark-cli 认证独立

- lark-cli 有自己的 `lark-cli auth login` OAuth
- 与 feishu-her / openclaw-lark 的 token 完全独立
- **风险低**: 飞书 App 允许多个 token 并存

### 6.4 Discussion Mode injectSyntheticTurn

- 这是唯一的 **高风险** 技术点
- 需要 openclaw-lark 暴露 channel inbound 注入 API
- **备选**: fork openclaw-lark 加入 hook，或在 feishu-her 中保留一个极简的 inbound injector

---

## 7. PoC 实验计划

### 实验 1: openclaw-lark 安装 + channel 共存测试

**目标**: 验证 openclaw-lark 能否与 feishu-her 共存（只用 tools，不注册 channel）

**步骤**:
1. 在 docker-199 安装 `@larksuite/openclaw-lark`
2. 确认是否支持只注册 tools 不注册 channel
3. 如果不支持，确认修改 manifest 的可行性

### 实验 2: lark-cli Skills 功能验证

**目标**: 验证 lark-cli 的 24 个 skills 在 Docker 内正常工作

**步骤**:
1. docker-199 已安装 lark-cli（docker13 也有）
2. 让 AI 调用 lark-calendar 查日程、lark-im 拉群历史
3. 确认输出格式和工具调用是否正确

### 实验 3: feishu-her tools 删除验证

**目标**: 验证删除 feishu-her 自研 tools 后，openclaw-lark + lark-cli 能完全覆盖

**步骤**:
1. 在 docker-199 的 feishu-her 中注释掉 `registerAllFeishuTools(api)` 调用
2. 只保留 knowledge_qa + discussion + bot-directory 的注册
3. 让 AI 使用 openclaw-lark/lark-cli 完成: 查文档、读日历、搜消息、查多维表格
4. 对比与之前 feishu-her tools 的结果差异

### 实验 4: Group History API 替代验证

**目标**: 验证 `lark-cli im +chat-messages-list` 能替代 Group Archive

**步骤**:
1. 用 lark-cli 拉取测试群最近 20 条消息
2. 对比返回数据与 feishu-her 的 group-archive JSONL
3. 确认消息格式 (text, @mention, 附件, reply) 是否完整

---

## 8. 最终推荐

**方案: 三件套 — openclaw-lark (Channel+Tools) + lark-cli (24 Skills) + feishu-her (纯业务)**

### 分阶段执行

| 阶段 | 内容 | 风险 | 效果 |
|------|------|:----:|------|
| **Phase 0** | 删除 feishu-her 的 29 个自研 tools + group-archive + memory-bridge，保留 channel | 极低 | LOC -72%, 消除 tools 重复 |
| **Phase 1** | 安装 openclaw-lark (tools only) + lark-cli skills | 极低 | 飞书域覆盖 17 域 |
| **Phase 2** | 验证 openclaw-lark + lark-cli 完全覆盖删除的 tools | 低 | 功能验证 |
| **Phase 3** | 将 channel 从 feishu-her 迁移到 openclaw-lark，feishu-her 变为无 channel 插件 | **高** | outbound.ts -100%, channel bug 归零 |

### 关键指标

- **feishu-her LOC**: 28,771 → ~3,000 (**-90%**)
- **outbound.ts**: 1,891 行 → **0** (由 openclaw-lark CardKit v2 接管)
- **自研 tools**: 33 → 4 (**-88%**)
- **Channel 层 bug 面**: 5,700 行自研 → **0** (由 openclaw-lark 生产级代码接管)
- **飞书域覆盖**: ~10 → **17** (+70%)
- **消灭 bug**: "睡着"(sequential queue) + "重复消息"(deliveredFinalTexts) — openclaw-lark 都已内置
