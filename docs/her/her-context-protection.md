# Her Context Protection 架构设计

> 日期: 2026-03-17
> 更新: 2026-03-18
> 状态: P0-1 + P0-2 已实施并验证，P1/P2/P3 待实施

## 已完成

### P0-1: feishu_group_history 字段精简 ✅

- 去掉 sender_actor、sender_open_id、sender_id_type、sender_actor_kind、text_parts、mentions_resolved、chat_id（每条重复）
- 效果：每条消息 -60%（~1500 → ~500 字符）
- 覆盖 list_history、list_thread、get_message 三个 action

### P0-2: feishu_group_history [local archive] 副本剥离 ✅

- 对 coverage=full 消息剥离 `[local archive: ...]` 后缀（文本消息的完整副本）
- 对 coverage=partial/none 保留（文件/图片的提取内容是唯一信息源）
- 效果：全文重复消息再降 45%

### 三 bot 验证结论（零功能衰退）

- sender_name、mentions、parent_id/root_id、coverage、attachments 全部正确
- 搜索质量零衰退
- tester/tester2 新消息完全干净

## 背景

Docker13 在执行"扫描所有群聊提取有价值信息"任务时，session 膨胀到 2.1MB / 1.4M 字符，触发 context compaction 超时（10 分钟 × 2 次），导致 Her 卡死 20+ 分钟。

根因：飞书工具没有输出大小限制，任意一个工具都可能返回无限量数据把 context 撑爆。

## 全量工具风险评估

### 危险级（可返回无限量数据，无截断）

| 工具                        | 风险点                                             | 默认输出上限 | 最大理论输出                              | 文件位置                                              |
| --------------------------- | -------------------------------------------------- | ------------ | ----------------------------------------- | ----------------------------------------------------- |
| **feishu_group_history**    | page_size 最大 200，含消息富化、线程展开、附件水合 | 20 条        | 200 条 × 76+ 字段 × 线程回复 = **无上限** | `extensions/feishu-her/src/tools/chat-history.ts:562` |
| **feishu_doc read**         | 读取整篇文档 markdown，无截断                      | 全文         | **无上限**（取决于文档长度）              | `extensions/feishu/src/docx.ts:710-748`               |
| **feishu_doc list_blocks**  | 返回文档所有 block，无分页                         | 全量         | **无上限**                                | `extensions/feishu/src/docx.ts:1184-1195`             |
| **feishu_sheet read_range** | 按范围读取，无单元格数量限制                       | 指定范围     | **无上限**（A1:Z10000）                   | `extensions/feishu-her/src/tools/sheet.ts:285-303`    |

### 高风险（有分页但可累积大量数据）

| 工具                            | 风险点                                         | 默认分页 | 最大分页              | 文件位置                                                |
| ------------------------------- | ---------------------------------------------- | -------- | --------------------- | ------------------------------------------------------- |
| **feishu_deep_search**          | 5 关键词 × 5 结果 × 4 来源 + 全量 archive 搜索 | 5/关键词 | ~100 结果             | `extensions/feishu-her/src/tools/deep-search.ts:119`    |
| **feishu_bitable list_records** | 分页但无总量限制                               | 100 条   | 500 条/页，无页数限制 | `extensions/feishu/src/bitable.ts:461-470`              |
| **feishu_calendar list_events** | 日历事件分页，默认 50                          | 50       | 无上限                | `extensions/feishu-her/src/tools/calendar.ts:142`       |
| **feishu_directory**            | 通讯录分页，默认 50                            | 50       | 无上限                | `extensions/feishu-her/src/tools/directory.ts:144`      |
| **feishu_chat_members**         | 群成员分页                                     | 50       | 无上限                | `extensions/feishu-her/src/tools/chat-members.ts:30-38` |

### 中风险（有限制但需关注）

| 工具                           | 风险点                                | 上限               | 文件位置                                                     |
| ------------------------------ | ------------------------------------- | ------------------ | ------------------------------------------------------------ |
| **feishu_conversation_search** | 内存中加载全量 archive 文件           | 50 结果            | `extensions/feishu-her/src/tools/conversation-search.ts:257` |
| **feishu_minutes**             | 搜索限制 5 结果，但 list 无限制       | 搜索 5 / list 无限 | `extensions/feishu-her/src/tools/minutes.ts:85-88`           |
| **feishu_wiki nodes**          | 节点列表无分页                        | 全量               | `extensions/feishu/src/wiki.ts:20-81`                        |
| **feishu_drive list**          | 文件夹内容，page_token 未暴露给 agent | 全量               | `extensions/feishu/src/drive.ts:33-56`                       |

### 低风险（单次操作或有严格限制）

| 工具                             | 说明                        |
| -------------------------------- | --------------------------- |
| feishu_search                    | 严格限制 20 结果，每源 5 条 |
| feishu_message                   | 最多 50 条发送记录          |
| feishu_chat info/manage          | 单条 CRUD                   |
| feishu_chat_controls             | 单条操作                    |
| feishu_chat_tabs/pins/top_notice | 单条操作                    |
| feishu_chat_capability           | 静态状态                    |
| feishu_perm                      | 权限列表，通常很小          |

## Docker13 崩溃复盘

```
用户："去所有群聊中把有价值的信息搜集过来放进炼丹炉"
    ↓
Her 触发 alchemy-furnace skill（workspace/skills/，最高优先级）
    ↓
对 12 个群调用 14 次 feishu_group_history
    （每次可能返回 200 条消息 × 76+ 字段 × 线程回复 × 附件）
    ↓
Session 膨胀到 2.1 MB / 1.4M 字符
    ↓
Context compaction 触发 → 调 Anthropic API 做摘要
    ↓
API 调用本身超时（要摘要的内容太多）
    ↓
embedded run timeout: 600000ms（第一次）
    ↓
系统重试 compaction → 再次超时（第二次）
    ↓
main lane 阻塞 437 秒 → 用户所有消息排队 → Her 卡死 20+ 分钟
```

## 修复方案

### P0-1: feishu_group_history 精简输出字段

**问题本质：** 不是消息太多，是每条消息字段太多。同一信息被 3-4 种方式重复表达。

**Her 实测结论（Docker13 对三人群 10 条消息的逐字段分析）：** 每条消息 ~1500 字符，其中 40-60% 是冗余重复数据。

**去掉的字段（100% 冗余，零信息损失）：**

| 字段                    | 去掉理由                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sender_actor`          | 嵌套对象，每个子字段都和外层重复（canonicalId=sender_id, displayName=sender_name 等）。最大浪费源，每条 ~200 tokens |
| `sender_open_id`        | = sender_id，完全相同                                                                                               |
| `sender_id_type`        | 永远是 open_id                                                                                                      |
| `sender_actor_kind`     | = sender_type（user→human, app→bot）                                                                                |
| `chat_id`（每条重复）   | 调用者传入的参数，不需要每条回传。在顶层返回一次即可                                                                |
| `text_parts.raw`        | = text                                                                                                              |
| `text_parts.normalized` | = text（几乎总是）                                                                                                  |
| `mentions_resolved`     | = mentions 的臃肿版，多了 renderedText 和又一个嵌套 actor 对象                                                      |

**保留的字段：**

- message_id, msg_type, sender_id, sender_type, sender_name
- create_time_human, text, text_parts.withoutFooter（仅 bot 消息时保留）
- has_thread, thread_id, parent_id, root_id
- coverage, mentions, attachments, file_name, file_key, image_key

**效果：** 每条消息从 ~1500 字符降到 ~500-600 字符（降 60%）。180 条消息从 270K 降到 ~100K。

**文件：** `extensions/feishu-her/src/tools/chat-history.ts`

- 改 `normalizeMessage()` 函数（:159），不再填充冗余字段
- 改输出序列化，去掉 `sender_actor`、`mentions_resolved`、`text_parts.raw/normalized`
- `chat_id` 移到顶层返回对象，不在每条消息里重复

### P0-2: feishu_group_history — `[local archive]` 重复内容剥离

**三个 bot 一致发现的最大膨胀源。** 与 P0-1 的字段精简是不同的问题。

bot 消息的 `text` 字段末尾包含 `[local archive: 完整 markdown 副本]`，导致同一内容出现两次。

- 实测：200 条消息中 archive 重复占 **45%（~100K chars）**
- 一条 800 字的回复变成 1600 字
- 剥离 `[local archive: ...]` 后缀可减少 30-50% 数据量

**修复方式：** 在 `compactMessageForOutput()` 中，如果 text 以 `[local archive:` 开头的标记结尾，截取掉。

**文件：** `extensions/feishu-her/src/tools/chat-history.ts` — 在 P0-1 新增的 `compactMessageForOutput` 函数中处理。

### P0-3: feishu_group_history — text_without_footer 冗余

当 `text_without_footer` 存在时，它和 `text` 95% 内容相同（仅差一行 footer）。当前 P0-1 的实现中已经只在 `withoutFooter !== text` 时才输出，这个问题已部分解决。但 `text` 本身仍然包含 footer + archive 后缀。

建议：当 `text_without_footer` 存在时，输出 `text_without_footer` 作为 `text`，不输出原始 text。

### P0-4: feishu_doc read 加输出截断

当前返回完整文档 markdown，无截断。大文档可能 100K+ 字符。

修复：加 maxChars 参数（默认 50000），超过在段落边界截断并附提示。

**文件：** `extensions/feishu/src/docx.ts:710-748`

### P0-3: feishu_doc list_blocks 加分页

当前返回文档所有 block，无分页。大文档可能数千个 block。

修复：加 page_size（默认 50）和 page_token 参数。

**文件：** `extensions/feishu/src/docx.ts:1184-1195`

### P1-1: feishu_sheet read_range 加单元格限制

修复：限制最大 1000 单元格/次，超过报错要求缩小范围。

**文件：** `extensions/feishu-her/src/tools/sheet.ts:285-303`

### P1-2: feishu_deep_search 加总输出上限

修复：总输出截断 30000 字符。

**文件：** `extensions/feishu-her/src/tools/deep-search.ts:119`

### P1-3: feishu_minutes list 加结果数限制 — 已部分实施

- 默认时间窗口从 7 天改为 30 天（Phase 8, 2026-03-18）
- 新增 `has_ai_summary` 字段，AI 可据此跳过无摘要的妙记，减少无意义的 `get` 调用
- max_results 参数待实施

**文件：** `extensions/feishu-her/src/tools/minutes.ts`

### P2: ~~全局 tool 输出保护层~~ → 调查结论：OpenClaw 已有但未生效

**深度调查结论（2026-03-18）：**

OpenClaw 已有 5 层 tool 输出保护，但对 LLM 对话实际生效的只有 session 持久化时的 400K cap：

| 层                                                   | 限制            | 实际状态                                                     |
| ---------------------------------------------------- | --------------- | ------------------------------------------------------------ |
| sanitizeToolResult (8K/block)                        | 事件系统截断    | **不作用于 LLM 对话** — Pi Agent 内部拿到的是完整 raw result |
| capToolResultSize (400K)                             | session 持久化  | **生效但阈值太高** — docker13 的 393K 刚好没触发             |
| truncateOversizedToolResultsInMessages (30% context) | 发送 LLM 前截断 | **函数存在但从未被调用！** 只在测试里引用                    |
| tool-result-context-guard                            | 运行时 guard    | 依赖 compaction 成功，compaction 本身可能超时                |
| truncateOversizedToolResultsInSession                | 事后修复        | 事后补救，已经来不及                                         |

**关键发现：LLM 对话里没有任何实时的大小限制。** Tool execute() 返回多大，Pi Agent 就吃多大。

**结论：P0-1/P0-2 在 tool execute() 层面的精简是目前唯一真正有效的保护。** 不能依赖框架层截断，每个高风险工具必须在 execute() 返回之前自己做保护。

**文件参考：**

- `src/agents/pi-embedded-subscribe.tools.ts:9` — TOOL_RESULT_MAX_CHARS = 8000（仅事件，不作用于对话）
- `src/agents/session-tool-result-guard.ts:9` — HARD_MAX = 400K（session 持久化）
- `src/agents/pi-embedded-runner/tool-result-truncation.ts:340` — truncateOversizedToolResultsInMessages（已实现未调用）

### P3: compaction 超时保护

当前 compaction 调 API 做摘要，内容太多时 API 本身超时导致 run 超时。

- compaction 前检查 context 大小，超过阈值直接丢弃最旧的 tool 结果
- 这是 OpenClaw 核心代码改动，需要评估
