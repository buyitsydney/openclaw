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

## 4. 三个候选方案对比

### 方案 A: her + lark-cli（推荐）

| 维度 | 评估 |
|------|------|
| Tool 覆盖 | **17 域, 200+ 命令, 24 Skills** — 覆盖面最广 |
| 与 her 共存 | **零冲突** — lark-cli 是独立 CLI，不注册 OpenClaw channel |
| 安装复杂度 | `npm install -g @larksuite/cli` + `npx skills add larksuite/cli -y -g` |
| 认证 | `lark-cli auth login` 独立 OAuth，可用 `--as bot` 复用现有 App |
| AI 友好度 | **专为 AI Agent 设计**：错误引导修复、缺权限自动引导、优化 token 消耗 |
| 维护方 | **飞书开放平台团队**（字节跳动官方） |
| 群历史 | `lark-cli im +chat-messages-list` + `+messages-search` |
| 额外能力 | Mail, Slides, Approval, OKR, Attendance, Meetings — feishu-her/openclaw-lark 都没有 |

### 方案 B: her + openclaw-lark

| 维度 | 评估 |
|------|------|
| Tool 覆盖 | ~10 域, 40+ tools — 不如 lark-cli 广 |
| 与 her 共存 | **有风险** — 同为 OpenClaw channel plugin，channel id 可能冲突 |
| 安装复杂度 | `npm install @larksuite/openclaw-lark`，需要配置 plugin manifest |
| 认证 | 自有 OAuth onboarding，需要确认能否与 her 共享 token |
| 维护方 | 字节跳动官方（npm `@larksuite/openclaw-lark` v2026.4.1） |
| 群历史 | `feishu_im_user_get_messages` + `feishu_im_user_search_messages` |

### 方案 C: her + upstream feishu

| 维度 | 评估 |
|------|------|
| Tool 覆盖 | ~5 域, 12 tools — 最少 |
| 与 her 共存 | **冲突** — 同一个 channel id `"feishu"`，不能同时启用 |
| 群历史 | ❌ 不支持 |

**结论: 方案 A (her + lark-cli) 是最佳选择。**

### 4.1 为什么选 lark-cli？

1. **覆盖面碾压**: 17 域 vs openclaw-lark 的 ~10 域 vs upstream feishu 的 ~5 域
2. **零冲突**: 独立 CLI 二进制，不注册 OpenClaw channel，与 feishu-her 完全正交
3. **专为 AI 设计**: 24 个 Skill 文件可直接注册为 OpenClaw skills
4. **认证独立**: `lark-cli auth login` 走自己的 OAuth，不干扰 feishu-her 的 Device Flow
5. **额外 7 个域**: Mail, Slides, Approval, OKR, Attendance, Meetings, Whiteboard — 这些 feishu-her 从未覆盖过

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

### 4.4 从 upstream feishu 移植的关键修复

必须立即移植到 feishu-her 的两个修复（不等架构重构）：

#### 4.4.1 Sequential Queue（防"睡着"）

来源: `extensions/feishu/src/sequential-queue.ts`（16 行）

```typescript
export function createSequentialQueue() {
  const queues = new Map<string, Promise<void>>();
  return (key: string, task: () => Promise<void>): Promise<void> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(key, next);
    const cleanup = () => {
      if (queues.get(key) === next) queues.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  };
}
```

**作用**: 保证同一个 chatId 的消息严格串行处理。当前 feishu-her 的 fire-and-forget 模式导致 queued message 的 dispatch 与 agent run 脱钩。

#### 4.4.2 deliveredFinalTexts（防重复消息）

来源: `extensions/feishu/src/reply-dispatcher.ts:198`

```typescript
const deliveredFinalTexts = new Set<string>();
// ... in deliver callback:
const skipTextForDuplicateFinal =
  info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
// ... after streaming close:
deliveredFinalTexts.add(text);
```

**作用**: Card stream close 已发送 final text 后，防止 non-streaming fallback 再次发送同一段文本。

---

## 5. 迁移路线图

### Phase 0: 紧急修复（1 天）

1. 移植 `createSequentialQueue` 到 feishu-her gateway.ts
2. 移植 `deliveredFinalTexts` 到 feishu-her deliver callback
3. 验证：docker-200 不再 "睡着"，docker-13 不再重复消息

### Phase 1: 安装 lark-cli + 注册 skills（1 天）

1. Docker image 中安装: `npm install -g @larksuite/cli`
2. 注册 skills: `npx skills add larksuite/cli -y -g`
3. 认证: `lark-cli auth login --recommend`（使用现有飞书 App credentials）
4. 验证: AI 可调用 lark-cli skills（如 `lark-cli calendar +agenda`、`lark-cli im +chat-messages-list`）

### Phase 2: 移除 feishu-her 自研 tools（2 天）

1. 删除 feishu-her 的以下 tools（已被 lark-cli 覆盖）：
   - bitable, docx, wiki, drive, sheet, calendar, task
   - chat, chat-history, chat-manage, chat-members, chat-controls
   - chat-tabs, chat-pins, chat-top-notice, chat-capability, chat-api
   - message, message-search, search, deep-search
   - directory, doc-comments, share-url, drive-browse, board, minutes
2. 保留：knowledge_qa, discussion-lifecycle, discussion-leader, group-mode-tool, bot-directory, oauth-direct, task-acceptance-log-check
3. 验证: 所有飞书 API 功能通过 lark-cli skills 正常工作

### Phase 3: 移除 Group Archive + Memory Bridge（1 天）

1. 删除 `group-archive.ts`, `memory-bridge.ts`, `sent-message-log.ts`
2. 删除 gateway.ts 中 Group Context Injection 代码（~150 行）
3. 保留 Card Text Cache（~80 行，独立 workaround）
4. 验证: AI 可通过 `lark-cli im +chat-messages-list` 获取群历史

### Phase 4: gateway.ts 瘦身（2 天）

1. 用 upstream feishu 的 `createChannelReplyPipeline` 替换自研 deliver 逻辑
2. 用 upstream feishu 的 `FeishuStreamingSession` 替换自研 card stream
3. 保留 Discussion Mode、Bot Registry、Reasoning Stream 等独有逻辑
4. 目标: gateway.ts 从 3,809 行降到 ~1,800 行

---

## 6. 风险与注意事项

### 6.1 lark-cli 与 feishu-her 的认证隔离

- feishu-her 有自己的 OAuth Device Flow + token store（Redis-backed）
- lark-cli 有自己的 `lark-cli auth login` OAuth
- 两者使用同一个飞书 App，但 token 存储独立
- **风险低**: 飞书 App 允许多个 token 并存，不会互相踢
- **需验证**: lark-cli 的 `--as bot` 模式是否可以复用 feishu-her 已有的 App credentials

### 6.2 lark-cli 在 Docker 内的运行

- lark-cli 是 Go 编译的二进制，npm 安装后是 native binary
- Docker image 基于 Node.js alpine，需确认二进制兼容性
- **解法**: 如果 npm 包不含 linux-amd64 binary，可从 GitHub Release 直接下载

### 6.3 Skill 注册方式

- `npx skills add larksuite/cli -y -g` 是 lark-cli 的 skill 注册命令
- 需确认这些 skills 能被 OpenClaw 的 skill 系统识别
- **备选**: 手动将 lark-cli 的 `skills/*/SKILL.md` 文件复制到 OpenClaw skills 目录

### 6.4 Tool 名称迁移

- feishu-her 当前 tool 名: `feishu_bitable`, `feishu_docx`, `feishu_calendar` 等
- lark-cli skill 名: `lark-base`, `lark-doc`, `lark-calendar` 等
- AI 的 prompt/skill 中引用这些名称的地方需要更新
- 建议: 在 shared-skills 里添加 feishu 老名称到 lark-cli 新名称的映射说明

### 6.5 版本兼容

- lark-cli 无 OpenClaw 版本要求（独立 CLI）
- CarHer Docker 当前运行 dev 分支（>= 2026.5.2-dev），Node 22+，**完全满足**

---

## 7. PoC 实验计划

### 实验 1: lark-cli 安装 + 认证测试

**目标**: 验证 lark-cli 能在 Mac 本地 + Docker 内正常运行

**步骤**:
1. 本地 Mac: `npm install -g @larksuite/cli`
2. `lark-cli config init` — 配置 App ID / App Secret
3. `lark-cli auth login --recommend` — OAuth 登录
4. `lark-cli auth status` — 确认认证成功
5. `lark-cli calendar +agenda` — 验证日历查询
6. `lark-cli im +chat-messages-list --chat-id oc_xxx` — 验证群历史读取

### 实验 2: lark-cli Skills 注册到 OpenClaw

**目标**: 验证 lark-cli 的 24 个 skills 能否被 OpenClaw AI 使用

**步骤**:
1. `npx skills add larksuite/cli -y -g`
2. 在 Her bot 对话中让 AI 调用 lark-calendar skill 查日程
3. 让 AI 调用 lark-im skill 拉取群消息历史
4. 确认 AI 输出的工具调用格式是否正确

### 实验 3: Group History 替代验证

**目标**: 验证 `lark-cli im +chat-messages-list` 能否替代 feishu-her 的 Group Archive

**步骤**:
1. 用 lark-cli 拉取一个测试群最近 20 条消息
2. 对比返回数据与 feishu-her 的 group-archive JSONL
3. 确认消息格式（text, @mention, 附件, reply 引用）是否完整
4. 测试 `+messages-search` 关键词搜索

### 实验 4: Sequential Queue 效果验证

**目标**: 验证移植 sequential queue 后 "睡着" bug 是否修复

**步骤**:
1. 在 feishu-her gateway.ts 加入 `createSequentialQueue`
2. 用 docker-200 复现之前的 "连续消息 → 睡着" 场景
3. 确认第二条消息不再 lost

---

## 8. 最终推荐

**方案: feishu-her (瘦身) + lark-cli (24 Skills)**

- **feishu-her 保留**: Channel 传输 + Discussion Mode + Bot Registry + knowledge_qa + Reasoning + Slash Commands + Card Stream
- **lark-cli 新增**: 24 个 AI Agent Skills，覆盖 17 个飞书业务域（IM/doc/base/sheets/calendar/task/mail/wiki/drive/contact/minutes/approval/slides/vc/okr/attendance/whiteboard）
- **移除**: Group Archive, Memory Bridge, 29 个自研 tools, Group Context Injection
- **移植**: Sequential Queue + deliveredFinalTexts（从 upstream feishu）
- **净效果**: feishu-her LOC -72%, 自研 tools -88%, 飞书业务域覆盖 +70%, 消灭 "睡着" + "重复消息" 两大 bug
