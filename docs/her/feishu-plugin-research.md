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

### 4.4 架构设计（四轴独立 npm 模型）

```
┌─────────────────────────────────────────────────────────────────────┐
│              Docker Image (immutable, ZERO plugins)                   │
│  FROM ghcr.io/openclaw/openclaw:${OPENCLAW_TAG}                      │
│  + python3 + ffmpeg + chromium + fonts  (runtime deps only)          │
│                                                                      │
│  升级: 改 OPENCLAW_TAG → rebuild image                               │
│  频率: 随 OpenClaw 上游发版，通常 2-4 周                               │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  runtime npm install →
                               │  /data/.openclaw/extensions/
┌──────────────────────────────▼──────────────────────────────────────┐
│              Persistent Volume (/data/)                               │
│                                                                      │
│  /data/.openclaw/extensions/                                         │
│  ├── @larksuite/openclaw-lark/   (Channel + 40 Tools)                │
│  │   升级: npm update → restart                                      │
│  ├── @larksuite/cli/             (24 AI Skills, Go binary)           │
│  │   升级: npm update -g → restart                                   │
│  └── @carher/feishu-her/         (纯业务: Discussion, Bot Registry)  │
│      升级: npm update → restart                                      │
│      peerDependencies: { "openclaw": ">=2026.4.24" }                 │
└─────────────────────────────────────────────────────────────────────┘

四条升级轴完全独立，零 CI/CD 耦合:
  轴 1: OPENCLAW_TAG      → rebuild image (不影响任何插件)
  轴 2: openclaw-lark npm  → npm update + restart (不 rebuild image)
  轴 3: lark-cli npm       → npm update + restart (不 rebuild image)
  轴 4: feishu-her npm     → npm update + restart (不 rebuild image)

┌────────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway (runtime)                       │
│                                                                    │
│  ┌──────────────────┐ ┌────────────────┐ ┌─────────────────────┐  │
│  │ openclaw-lark     │ │ lark-cli       │ │ feishu-her          │  │
│  │ (npm package)     │ │ (npm package)  │ │ (npm package)       │  │
│  │                  │ │                │ │                     │  │
│  │ Channel "feishu":│ │ 补全域:         │ │ 独有业务:            │  │
│  │ - CardKit v2 流式│ │ - lark-mail    │ │ - Discussion Mode   │  │
│  │ - abort-detect   │ │ - lark-slides  │ │ - Bot Registry      │  │
│  │ - UnavailableGuard│ │ - lark-approval│ │ - knowledge_qa      │  │
│  │ - FlushController│ │ - lark-okr     │ │ - /voice /quota     │  │
│  │ - ImageResolver  │ │ - lark-vc      │ │ - /summary          │  │
│  │ - tool-use trace │ │ - lark-contact │ │ - Reasoning stream  │  │
│  │ - 20+ msg types  │ │ - ...共24 skill│ │ - OAuth Direct Card │  │
│  │                  │ │                │ │                     │  │
│  │ Tools:           │ │                │ │ channels: []        │  │
│  │ - IM history     │ │                │ │ (无 channel 注册)    │  │
│  │ - bitable/doc    │ │                │ │                     │  │
│  │ - calendar/task  │ │                │ │ Hook 接入:           │  │
│  │ - sheets/drive   │ │                │ │ - before_dispatch   │  │
│  │ - wiki/chat      │ │                │ │ - message_sending   │  │
│  │                  │ │                │ │ - message_sent      │  │
│  │                  │ │                │ │ - message_received  │  │
│  └──────────────────┘ └────────────────┘ └─────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
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

### 4.6 部署模型：全 npm 运行时安装

**核心原则**: Docker 镜像内零插件，所有插件由每个 Her 实例在运行时安装到持久卷。

#### 4.6.1 Dockerfile 变化

```dockerfile
# BEFORE (v2): 插件 COPY + npm install 进镜像
COPY docker/plugins/feishu-her  /app/docker/plugins/feishu-her
RUN cd /app/docker/plugins/feishu-her && npm install --omit=dev

# AFTER (v3): 镜像内零插件
# 只保留 openclaw base + runtime deps (python3, ffmpeg, chromium, fonts)
# 插件由每个 Her 实例 runtime 安装到 /data/.openclaw/extensions/
```

#### 4.6.2 npm 包发布

| 包名 | 发布者 | 说明 |
|------|--------|------|
| `@larksuite/openclaw-lark` | 字节跳动 | 已在 npm，Channel "feishu" + 40 Tools |
| `@larksuite/cli` | 字节跳动 | 已在 npm，24 AI Skills (Go binary) |
| `@carher/feishu-her` | CarHer 团队 | **新发布**，纯业务插件 (Discussion Mode, Bot Registry, knowledge_qa) |

#### 4.6.3 feishu-her 作为 npm 包

```json
{
  "name": "@carher/feishu-her",
  "version": "1.0.0",
  "peerDependencies": {
    "openclaw": ">=2026.4.24"
  },
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.x",
    "ioredis": "^5.x"
  }
}
```

**peerDependencies 的作用**: npm 在安装 `@carher/feishu-her` 时会检查宿主 openclaw 版本。
如果 openclaw 升级到不兼容版本（比如 Plugin SDK 破坏性变更），npm 会发出警告。
feishu-her 维护者只需更新 peerDependencies 范围并发布新版本。

#### 4.6.4 运行时安装流程

每个 Her 实例启动时（entrypoint 或 Her 自身逻辑）：

```bash
# 1. 安装 channel + tools  (到 /data/.openclaw/extensions/)
npm install --prefix /data/.openclaw/extensions @larksuite/openclaw-lark@latest

# 2. 安装 lark-cli skills  (全局二进制)
npm install -g @larksuite/cli@latest

# 3. 安装 feishu-her 业务插件
npm install --prefix /data/.openclaw/extensions @carher/feishu-her@latest
```

OpenClaw 的 `plugins.load.paths` 配置指向 `/data/.openclaw/extensions/node_modules/@larksuite/openclaw-lark` 等路径，
或者直接用 OpenClaw 的 global extensions 发现机制（`~/.openclaw/extensions/`），无需手动配置路径。

#### 4.6.5 四条升级轴对比

| 升级什么 | 操作 | 影响范围 | 需要 rebuild image? | 需要重启? |
|----------|------|----------|:-------------------:|:---------:|
| **OpenClaw core** | 改 `OPENCLAW_TAG` → rebuild + redeploy | 全体 Her | ✅ | ✅ |
| **openclaw-lark** | `npm update @larksuite/openclaw-lark` | 单个 Her | ❌ | ✅ restart |
| **lark-cli** | `npm update -g @larksuite/cli` | 单个 Her | ❌ | ✅ restart |
| **feishu-her** | `npm update @carher/feishu-her` | 单个 Her | ❌ | ✅ restart |

**关键优势**:
- 插件升级不需要 rebuild Docker image → 零 CI/CD 耦合
- 可以逐个 Her 灰度升级（先升 docker199，验证后再升其他）
- openclaw core 升级不影响插件（只要 Plugin SDK 兼容）
- 插件之间互不影响（openclaw-lark 升级不影响 feishu-her）

#### 4.6.6 解决 "openclaw 升级后 her 不可用" 问题

**根因**: 以前 feishu-her 依赖 openclaw 内部 API（gateway.ts, outbound.ts），
上游重构经常破坏这些内部接口。

**npm 方案如何解决**:
1. feishu-her 只依赖 Plugin SDK 公开接口：`api.registerTool()`, `api.registerHook()`, `api.runtime.subagent.run()`
2. Plugin SDK 有版本承诺，不会随意破坏（向后兼容）
3. peerDependencies 声明兼容范围，不兼容时 npm install 会警告
4. 即使 openclaw 升级到不兼容版本，feishu-her 可以 pin 旧版本继续运行，等待适配

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

### 5.3 Hook 可行性深度分析（2026-05-04 验证完毕）

> **结论: ✅ FEASIBLE — OpenClaw Plugin SDK 已有完整 hook 体系，Discussion Mode 可零耦合迁移，不需要 fork/修改 openclaw-lark 源码。**

OpenClaw 插件 hook 系统提供 29 个事件（`src/plugins/hook-types.ts`），其中 6 个直接覆盖 Discussion Mode 全部需求：

#### 5.3.1 Hook 映射表

| Discussion Mode 需求 | Hook 事件 | 类型 | 说明 |
|---|---|---|---|
| **Turn 门控**（压制非轮次 bot） | `before_dispatch` | claiming (first-wins) | 检查 Redis turn state → `{ handled: true }` 压制非 owner bot |
| **出站压制**（取消未授权回复） | `message_sending` | modifying (sequential) | `{ cancel: true }` 取消未授权出站 |
| **入站观测**（跟踪用户消息） | `message_received` | void (fire-and-forget) | 记录 activity，重置 auto-exit 计时器 |
| **出站观测**（跟踪已发消息） | `message_sent` | void (fire-and-forget) | 推进 turn state，通知 Redis pub/sub |
| **合成 turn 注入** | `chat.send` gateway RPC | — | `originatingChannel: "feishu"` 经 gateway dispatch pipeline，openclaw-lark 自动渲染 |
| **回复 dispatch 接管** | `reply_dispatch` | claiming (first-wins) | 高级场景：完全接管某 session 的回复路由 |

#### 5.3.2 合成 Turn 注入方案 (`chat.send` via gateway RPC)

这是 Discussion Mode 迁移的核心机制——替代原来的 `buildDiscussionTurnEvent()` + `handleInboundMessage(fakeEvent)`:

```typescript
// feishu-her timer 触发 → 通过 gateway RPC 注入合成 turn（零 openclaw-lark import）
await callGateway({
  method: "chat.send",
  params: {
    sessionKey: `agent:main:feishu:group:${chatId}`,
    message: "[discussion-turn] ...",
    originatingChannel: "feishu",
    originatingTo: `chat:${chatId}`,
    originatingAccountId: accountId,
    idempotencyKey: crypto.randomUUID(),
  },
});
// gateway 处理完整 dispatch pipeline:
//   → inbound_claim → message_received → before_dispatch → agent inference
//   → message_sending → openclaw-lark CardKit v2 渲染 → message_sent
```

**关键**: `chat.send` 的 `originatingChannel` 字段（`src/gateway/server-methods/chat.ts:1751`）让消息像真实飞书消息一样路由，openclaw-lark 自动处理 CardKit v2 流式渲染。

#### 5.3.3 前置门控方案 (`before_dispatch` hook)

```typescript
api.registerHook("before_dispatch", async (event, ctx) => {
  if (ctx.channelId !== "feishu" || !event.isGroup) return;
  const groupMode = await readGroupMode(event.sessionKey);
  if (groupMode !== "discussion") return;
  const isMyTurn = await isDiscussionTurnOutputAllowed(ctx.conversationId, myBotId);
  if (!isMyTurn) return { handled: true }; // 不是我的轮次 → 静默消费
}, { name: "discussion-turn-gate" });
```

#### 5.3.4 出站门控方案 (`message_sending` hook)

```typescript
api.registerHook("message_sending", async (event, ctx) => {
  if (ctx.channelId !== "feishu") return;
  const isAllowed = await authorizeDiscussionOutbound(ctx.conversationId, myBotId);
  if (!isAllowed) return { cancel: true };
}, { name: "discussion-outbound-gate" });
```

#### 5.3.5 耦合度变化

| 耦合点 | 现状（channel 内） | Hook 方案 | 变化 |
|---|---|---|---|
| H1-H3: `buildDiscussionTurnEvent` + `handleInboundMessage` | 直接构造飞书假消息 + 调用 channel 入站函数 | `chat.send` RPC，无需知道飞书消息格式 | **HARD → ZERO** |
| H4/K3: `canEmitVisibleDiscussionReply` | 在 5 处嵌入 channel 代码 | `before_dispatch` + `message_sending` hook | **HARD → ZERO** |
| H6-H8: `handleDiscussionOutboundMessage` | 在 3 处嵌入 channel 代码 | `message_sent` hook 推进 turn state | **HARD → ZERO** |
| K1-K2: Redis pub/sub + timer | 直接调用 channel 注入 | Timer → `chat.send` RPC | **HOOK → ZERO** |
| discussion-state.ts | 纯 Redis | 不变 | **ZERO** |

**feishu-her 的 openclaw-lark import 数量: 0**

### 5.4 降风险方案: 分阶段迁移

| 阶段 | 做什么 | 风险 |
|------|--------|:----:|
| **Phase 0** | 只删 tools + group-archive，保留 channel 层不动 | **极低** |
| **Phase 1** | 安装 openclaw-lark + lark-cli，feishu-her 保持 channel | **极低** |
| **Phase 2** | 让 openclaw-lark 的 tools 替代 feishu-her 的 tools，验证功能 | **低** |
| **Phase 3** | 将 channel 从 feishu-her 迁移到 openclaw-lark，Discussion Mode 通过 hook 接入 | **中低 ✅** |

**Phase 0-2 是 0 风险的**，可立即执行。**Phase 3 已验证可行** — OpenClaw hook 系统完整覆盖 Discussion Mode 全部需求，不需要深度耦合 openclaw-lark 源码。

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

### 6.4 Discussion Mode injectSyntheticTurn — ✅ 已解决

- ~~这是唯一的高风险技术点~~ → **已通过 `chat.send` gateway RPC 解决**
- 无需 fork/修改 openclaw-lark，无需暴露内部 API
- 合成 turn 通过 `chat.send` + `originatingChannel: "feishu"` 注入 gateway dispatch pipeline
- Turn 门控通过 `before_dispatch` hook 实现，出站压制通过 `message_sending` hook 实现
- 详见 §5.3 Hook 可行性深度分析

---

## 7. 实施计划

### Phase 0: feishu-her 瘦身（已完成 ✅）

1. 删除 29 个自研 feishu_* tools，只保留 knowledge_qa + discussion + bot-directory
2. 删除 group-archive, memory-bridge, sent-message-log
3. feishu-her `channels: []`，不再注册 channel

### Phase 1: Dockerfile v3 — 零插件镜像

1. 从 `Dockerfile.carher.v2` 删除所有 `COPY docker/plugins/...` 和对应 `npm install`
2. 只保留: openclaw base + python3 + ffmpeg + chromium + fonts + live-frontend
3. `plugins.load.paths` 改为指向 `/data/.openclaw/extensions/` 下的 npm 包

### Phase 2: feishu-her npm 发布

1. 将 `docker/plugins/feishu-her/` 重构为标准 npm 包结构
2. 添加 `peerDependencies: { "openclaw": ">=2026.4.24" }`
3. 发布到 npm registry（`@carher/feishu-her`）
4. 验证 `npm install @carher/feishu-her` 后 OpenClaw 能正确发现并加载

### Phase 3: 运行时安装集成

1. entrypoint 或 start-user.sh 中添加运行时 npm install 逻辑
2. 安装三个插件到 `/data/.openclaw/extensions/`
3. 配置 `plugins.load.paths` 或使用 OpenClaw global extensions 发现

### Phase 4: 灰度验证

1. docker199（tester）先部署新镜像 + 运行时安装
2. 验证: channel 收发、Discussion Mode、tools、lark-cli skills
3. 逐步推广到其他 Her 实例

---

## 8. 最终推荐

**方案: 三件套 npm 运行时安装 — 四轴独立升级，零 CI/CD 耦合**

### 架构总结

| 组件 | npm 包 | 职责 | Channel |
|------|--------|------|:-------:|
| **openclaw-lark** | `@larksuite/openclaw-lark` | Channel "feishu" + 40 Tools (CardKit v2, abort-detect, ImageResolver) | ✅ |
| **lark-cli** | `@larksuite/cli` | 24 AI Skills (17 域: mail, slides, approval, OKR, attendance, meetings...) | ❌ |
| **feishu-her** | `@carher/feishu-her` | Discussion Mode, Bot Registry, knowledge_qa, /voice /quota /summary | ❌ |

### 部署模型

- **Docker 镜像**: 纯 openclaw base + runtime deps，**零插件**
- **运行时安装**: 每个 Her 启动时 `npm install` 三个包到持久卷
- **升级**: 任意一个包 `npm update` + restart，不需要 rebuild image
- **灰度**: 逐个 Her 升级，互不影响

### 关键指标

- **feishu-her LOC**: 28,771 → ~3,000 (**-90%**)
- **outbound.ts**: 1,891 行 → **0** (由 openclaw-lark CardKit v2 接管)
- **自研 tools**: 33 → 4 (**-88%**)
- **Channel 层 bug 面**: 5,700 行自研 → **0** (由 openclaw-lark 生产级代码接管)
- **飞书域覆盖**: ~10 → **17** (+70%)
- **消灭 bug**: "睡着"(sequential queue) + "重复消息"(deliveredFinalTexts) — openclaw-lark 都已内置
- **Discussion Mode 耦合**: 8 HARD → **0** (全部通过 Plugin SDK hook + `api.runtime.subagent.run()` 实现)
- **CI/CD 耦合**: 4 组件共享一个 Dockerfile → **4 条独立升级轴**
- **openclaw 升级容灾**: 内部 API 依赖 → **peerDependencies + Plugin SDK 公开接口**
