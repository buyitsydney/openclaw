# Her 飞书群聊架构设计

状态：**已进入统一 contract 阶段**。截至 2026-03-14，本地 Her + `docker1 tester` 的飞书链路不再允许各处各自猜 sender，也不再允许用户可见文本在 `text` / `post` / `interactive` 三种出站里漂移。

### 当前冻结约束（2026-03-14）

- **唯一 canonical message 层**：`extensions/feishu-her/src/feishu-message.ts`
- **唯一 human 身份信源**：飞书返回的 `open_id` + 群成员/联系人查名结果
- **唯一 current bot 身份信源**：`channels.feishu.name`
- **唯一 peer bot 身份信源**：`channels.feishu.knownBots[app_id]`
- **本地多 bot registry 根信源**：`docker/users.csv`
- **容器运行时生成器**：`start-user.sh` 把 `docker/users.csv` 显式编译进容器 `openclaw.json`
- **本机 Her 运行时同步器**：`start.sh` 把 host `name` 与 `knownBots` 显式同步进 `~/.openclaw/openclaw.json`
- **唯一用户可见文本出站**：`extensions/feishu-her/src/outbound.ts` 的 `sendFeishuUserFacingCard()`
- **禁止事项**：
  - 禁止根据正文风格、Markdown 形态、bot 语气猜 sender
  - 禁止继续依赖 `/im/v1/chats/{chat_id}/members?member_id_type=app_id` 给 bot 补名字；官方接口不返回机器人成员
  - 禁止再让用户可见文本直接走 `text` / `post` 分支

### 说明

- 下面文档里凡是写着“群聊正文必须是 `text/post`”或“interactive 只能做展示层”的段落，都属于**上一阶段结论**；现在已经被“统一 interactive v1 card + patch stream + canonical actor resolver”这个新 contract 覆盖。
- 新 contract 的核心不是“卡片更好看”，而是：**同一条消息在 live inbound、quoted、history、archive、dynamic injection 里必须拥有同一个 sender / mentions / reply / text 解释结果。**

### 状态补充（2026-03-14 夜间 checkpoint：direct outbound 守住 replyTo）

**这轮确认的结果必须和前面几轮分开看**：

- **发送链路 checkpoint 已成立**：`extensions/feishu-her/src/channel.ts` 的 outbound 不再走 upstream gateway `send`，而是改为 `direct`，由 `feishu-her` 自己消费 `replyToId`
- **`message` 工具的飞书引用回复已打通**：最新 R4 验证里，`replyTo="om_x100b5462ddf7fca4c31353bd74ae95e"` 已经能在 History API 中读回正确的 `parent_id/root_id`
- **`<at>` 导致卡片空白`/230099` 这条根因已被压住**：本地 Her 和 `docker1 tester` 的最新一轮日志都没有再出现 `Feishu card stream: stripping <at> tags and retrying` / `sendFinal failed: 230099`

**但这不等于展示层已经全部正确**：

- 当前卡片里用于举例的字面量 `<at user_id="...">name</at>`，仍会显示成 `&#60;at ...&#62;` / `&lt;at ...&gt;`
- 当前卡片里的 Markdown 表格，仍可能以原始 `|---|` 管道文本暴露给用户，而不是人类期望的“表格视觉”
- 这两个问题的性质都属于 **`extensions/feishu-her/src/outbound.ts` 的显示层问题**，不是发送失败，也不是 `replyTo` 再次丢失

**因此当前状态必须严格分层表述**：

- **已修住**：direct outbound、`replyTo -> parent_id/root_id`、`<at>` 不再触发 230099 空白卡片
- **仍待修**：卡片里代码样例 `<at>` 的视觉显示、表格 Markdown 的视觉显示

下面旧章节里凡是写“`message` 工具 `replyTo` 对飞书仍未打通”的地方，都已经过时；之后文档应以上面这个 checkpoint 为准。

### 状态补充（2026-03-15 上午 checkpoint：bot mention patch 已修住，markdown 仍是安全文本）

**这轮新增确认了一个此前没被分层说清楚的事实**：

- 飞书 `interactive` 卡片在 `PATCH /im/v1/messages/{message_id}` 链路里，对 **human mention** 和 **bot mention** 的要求不一样
- human mention 用 `open_id` 可以稳定成功
- peer bot mention 如果把 `app_id` 直接写进 `<at id=...></at>`，飞书会返回 `230099 invalid user resource`
- peer bot mention 必须先从本地 registry（`docker/users.csv` -> `start.sh` / `start-user.sh` -> `knownBotOpenIds`）恢复出 **bot_open_id**，再写入卡片

**因此当前发送层 contract 已更新为**：

- 群里真正 `@人`：使用人的 `open_id`
- 群里真正 `@bot`：使用 bot 的 `open_id`（不是 `app_id`）
- `app_id` 仍然是 bot 的稳定 canonical identity，用于识别“这是谁”；但不能直接拿来作为飞书卡片 `<at>` 的目标 ID

**当前已修住**：

- `extensions/feishu-her/src/outbound.ts` 发送卡片前，会把已知 peer bot 的 `app_id` 确定性映射为 `knownBotOpenIds[open_id] -> app_id` 的反查结果，再写 `<at id=bot_open_id></at>`
- 对未登记 `bot_open_id` 的 peer bot，不再冒险发非法 `<at>`，而是降级成可见纯文本 `@botName`
- 之前那条“`230099` 后直接把整条 `<at>` 删掉再重试”的兜底逻辑已移除，避免再次把真实 mention 静默吞掉

**但当前仍未完全闭环的点也必须写清楚**：

- dynamic injection 的 `[Bot Identity]` 说明块当前主要暴露的是 `app_id`
- `feishu_group_history` / recent messages 虽然内部 actor 结构支持 `rawIds`，但对 bot 的 `open_id` 还没有做到“始终显式暴露给模型”
- 当前用户看到的 Markdown 展示，依然是“飞书卡片安全文本”而不是真正保真 markdown；这属于显示层保守降级，不属于发送失败

**所以 2026-03-15 上午这个 checkpoint 的正确分层是**：

- **已修住**：群里真实 `@bot` 不再因为 `app_id` 走错而被飞书 `PATCH` 拒绝
- **仍待修**：bot `open_id` 在 history / dynamic injection / skill 里的显式暴露，以及 markdown 视觉保真度

### 实现状态（2026-03-12 早期）

- **群名改名后 prompt 不更新 — 已修复**：`outbound.ts` 中的 `chatNameCache`（进程级 Map）在群改名后不会刷新，导致 prompt 中群名过期。已删除该缓存，每次 inbound 重新调用飞书 API 获取最新群名。本地 her + tester 多轮压力测试验证通过。
- **Skill 拆分 v1**：旧 `feishu/SKILL.md`（1036 行）拆为 8 个独立 skill：`feishu-chat` / `feishu-collab` / `feishu-doc` / `feishu-drive` / `feishu-minutes` / `feishu-perm` / `feishu-search` / `feishu-wiki`

### 实现状态（2026-03-12 Skill 架构重构 v2）

**背景**：v1 拆分后，模型在跨 session 回忆（私聊↔群聊）、关键词搜索、文档搜索三类场景中频繁路由错误。根因是旧 `feishu-search` skill 同时覆盖了聊天记录搜索、文档搜索、私聊回忆、群聊回忆四种意图，模型无法从单一 description 正确判断该用哪个工具。

**变更内容**：

1. **删除旧 skill**：
   - `feishu-search/`（含 `references/session-recall.md`）— 职责过宽，一个 skill 混合了四种意图
   - `feishu/SKILL.md` — 残留的空 symlink

2. **新增 4 个窄职责 skill**：
   - `feishu-dm-transcript` — 读取私聊原文（跨 session 从群聊读私聊 + 私聊内长历史回溯）
   - `feishu-group-transcript` — 读取某个飞书群的对话原文（群聊默认回忆 + 私聊中指定群）
   - `feishu-chat-history-search` — 按关键词跨聊天搜索历史记录（本地群归档 + Her session）
   - `feishu-knowledge-search` — 飞书文档/Wiki/妙记知识搜索（`feishu_search` + `feishu_deep_search`）

3. **所有 skill 描述全量中文化**：description、routing 规则、"适用/不适用"说明全部改为中文，与用户交互语言一致

4. **Skill description 结构化**：每个 skill 的 `description` 字段采用结构化格式，明确列出"何时用"和"不用于"，消除歧义

5. **现有 8 个 skill 更新**：`feishu-chat` / `feishu-collab` / `feishu-doc` / `feishu-drive` / `feishu-minutes` / `feishu-oauth` / `feishu-perm` / `feishu-wiki` 的 description 和内部路由规则同步中文化

**重构后 skill 全景（12 个）**：

| Skill                        | 工具覆盖                              | 职责                   |
| ---------------------------- | ------------------------------------- | ---------------------- |
| `feishu-chat`                | `feishu_chat` 系列                    | 群/聊天管理            |
| `feishu-collab`              | `feishu_task`, `feishu_calendar`      | 协作（任务/日历）      |
| `feishu-doc`                 | `feishu_doc`                          | 文档读写               |
| `feishu-drive`               | `feishu_drive`                        | 云盘操作               |
| `feishu-wiki`                | `feishu_wiki`                         | Wiki 操作              |
| `feishu-minutes`             | `feishu_minutes`                      | 妙记                   |
| `feishu-perm`                | `feishu_perm`                         | 权限管理               |
| `feishu-oauth`               | —                                     | OAuth 授权流程         |
| `feishu-dm-transcript`       | `sessions_history`                    | 私聊原文回忆           |
| `feishu-group-transcript`    | `feishu_group_history`                | 群聊原文回忆           |
| `feishu-chat-history-search` | `feishu_conversation_search`          | 聊天记录关键词搜索     |
| `feishu-knowledge-search`    | `feishu_search`, `feishu_deep_search` | 文档/Wiki/妙记知识搜索 |

**已知遗留**：`feishu_group_history` 返回的图片消息包含本地归档路径（`[local archive: ...]`），但模型在私聊跨群查询时不会主动 `read` 该路径查看图片内容。需在 `feishu-group-transcript` skill 中补充图片处理指导。

### 实现状态（2026-03-12 群聊上下文自动注入：Push+Pull 混合架构）

**背景**：upstream 官方飞书插件使用内存缓冲（`pendingHistory`）在 @mention 时注入群聊上下文，实现"零延迟"感知。本地 `feishu-her` 此前仅依赖 `feishu_group_history` 工具（LLM 主动调用，慢），群聊中 bot 对"刚才发生了什么"几乎无感知。

**方案**：@mention 触发时自动通过 API 拉取最近 20 条消息（含人类 + 所有机器人），注入到 LLM 的 `BodyForAgent` 字段。

**关键实现细节**：

1. **API 拉取而非内存缓冲**：不维护 `chatHistories` Map，每次 @mention 时直接调 `/im/v1/messages` 拉最新 20 条。优势：包含所有 bot 消息（飞书 WebSocket 不推送 bot-to-bot 消息，内存缓冲方案无法捕获）、无状态、重启不丢失
2. **`tenant_access_token`**：无需 user OAuth，降低授权依赖
3. **`BodyForAgent` 注入**：`finalizeInboundContext` 优先使用 `BodyForAgent > CommandBody > RawBody > Body`，必须将注入内容放入 `BodyForAgent` 才能被 LLM 看到（早期 bug：放在 `Body` 中被 `CommandBody` 覆盖）
4. **两层信息架构**：
   - 第一层：自动注入（20 条，零工具调用，~500ms API 延迟）
   - 第二层：`feishu_group_history` 工具（深度历史、图片/文件内容、私聊跨群查询）
5. **Skill 更新**：`feishu-group-transcript/SKILL.md` 描述了两层信息来源和判断流程，指导模型何时用注入内容、何时调工具

**变更文件**：

- `extensions/feishu-her/src/gateway.ts` — 移除 `chatHistories` 缓冲，新增 API 拉取注入
- `extensions/feishu-her/src/tools/chat-history.ts` — 导出 `fetchChatHistory`、`getTenantAccessToken`、`NormalizedMessage`
- `extensions/feishu-her/skills/feishu-group-transcript/SKILL.md` — 更新两层信息来源描述

### 状态补充（2026-03-14：interactive 卡片可读性修复 + im.message.patch 流式方案验证）

**背景**：群聊 streaming 一直被禁用（`gateway.ts` line 2053 `if (isGroup) return`），因为 CardKit streaming 卡片 (v2 schema) 通过 `im.message.get` 返回 "请升级至最新版本客户端"，完全不可读。`chat-history.ts` 对所有 interactive 消息硬编码返回 `[interactive card — content degraded]`，不尝试解析。

**关键发现**：

1. **飞书平台对 v1 和 v2 interactive 消息的降级程度完全不同**：
   - v1 内联卡片（`elements` 顶层）：降级为 2D 数组 `[[{tag:"text",text:"..."}, ...]]`，文本内容 ~90% 可恢复（丢失 markdown 格式，保留链接和代码块）
   - v2 CardKit 卡片（`schema:"2.0"`, `body.elements`）：返回 "请升级至最新版本客户端"，0% 可读
2. **`im.message.patch` (PATCH API) 是一个被长期忽视的更新接口**：
   - 频控 5 QPS，**无总次数限制**（区别于 `im.message.update` 的 20-30 次硬限）
   - 对 v1 内联卡片执行就地更新，不显示"已编辑"标签
   - 群聊中使用 `update_multi: true` 实现共享卡片更新
3. **`flattenInteractiveBody`（已存在于 gateway.ts）能解析 v1 降级格式**，但 `chat-history.ts` 的 `normalizeMessage` 从未调用它

**修复内容**：

- `chat-history.ts` 新增 `flattenInteractiveElements()` 函数，在 `normalizeMessage` 的 `case "interactive"` 中尝试解析降级 2D 数组格式
- v1 内联卡片 → 提取标题 + 正文，`coverage: "partial"`
- v2 CardKit 卡片（含 "请升级至最新版本客户端" 占位符）→ 仍回退到 `coverage: "none"`

**实验验证**（docker1 tester，test 群）：

- 通过 `im.message.patch` 发送 v1 内联卡片到 test 群
- 用户 @mention bot，bot 注入 3 条群消息
- bot 回复明确引用了卡片的关键信息（API 名称、5 QPS、无次数限制），确认 `normalizeMessage` 正确解析了 interactive 消息
- 修复前：bot 只能看到 `[interactive card — content degraded by API, cannot recover full text]`

**im.message.patch 流式方案实测数据**：

- 56 patches / 881 chars / 28.6s / 0 failures（有效速率 2.0 patches/s）
- 视觉效果：无打字机动画，但内容在卡片内逐步填充，200ms 刷新间隔可接受
- `im.message.get` 回读：348/364 chars 可提取（~96% 恢复率）

**对文档结论的影响**：

- 原结论 "interactive 只能做展示，不能做唯一信息载体" 需要修正：**v1 内联卡片现在可以被回读**（partial coverage）
- 群聊 streaming 从"不可行"变为"可行"（通过 v1 内联卡片 + im.message.patch）
- 私聊 CardKit streaming (v2) 的引用回读问题仍待解决（见下方 pending）

**Pending**：

- 私聊 CardKit (v2) 卡片在被引用时同样不可读 — 需要统一私聊/群聊为 v1 内联卡片 + im.message.patch 方案
- bot 自己发送的群消息不写入 group-archive（只写 sentMessageLog）— 需要补归档

### 状态补充（2026-03-13）

**本轮已落地并准备继续线上压测的修复**：

1. **ACK 动画前置**：在群聊自动注入、sender 解析、quoted message 拉取之前先打 `Get` reaction，恢复"用户一发消息就看到 bot 在处理"的体验
2. **`@所有人` 文本显示统一**：`gateway.ts`、`chat-history.ts`、`merge-forward.ts` 共用 `formatFeishuAtText()`，`<at user_id="all">所有人</at>` 在历史/引用/展开内容里统一显示为 `@所有人`
3. **群聊自动注入的人名修正**：自动注入的 recent messages 会优先用群成员名，而不是只暴露 `open_id`
4. **群内真正 @ 回复规则补强**：注入上下文时额外提示"本轮正在回复谁、必须用哪个 `<at user_id=\"...\">名字</at>`"，避免把 `@_user_N` 占位符抄回出站消息

**继续线上压测时要盯的已知 follow-up**：

1. **P0 - `message` 工具 `replyTo` 对飞书仍未打通**：当前通用 delivery 层会传 `replyToId`，但 `extensions/feishu-her/src/channel.ts` 的 outbound 发送还没有消费它，所以 `message(action="send", replyTo="om_xxx")` 不能形成飞书 quote reply；而 gateway 内部命令回复走的是 `sendFeishuReply()`，所以 `/opus` 这类群内命令回复是正常的
2. **P1 - `@all` 是否进入 `mentions[]` 仍需继续实测确认**：本轮修的是文本显示层；如果飞书历史 API 天生不把 `@all` 作为独立 mention 返回，那么程序侧不能只依赖 `mentions[]` 判断是否 `@所有人`
3. **P2 - `sender.label` 仍可能退化成 `open_id`**：如果 inbound context 没显式注入 `SenderName`，OpenClaw 的默认 sender label 仍会回退到 `SenderId`，所以新 bot 在没有 `USER.md` 映射时仍可能只看到 `ou_xxx`

### 状态补充（2026-03-14：统一消息模型 / before vs after 推演）

**注意**：本节是接下来重构的**冻结约束**，不是"已经全部上线"的状态描述。目的只有一个：把 `私聊当前消息 / 私聊引用 / 群聊动态注入 / history / quoted / archive / search / memory` 统一成一套消息模型，彻底禁止 sender、reply、附件、footer、归档来源在不同链路里漂移。

#### 为什么必须新增这一层

本轮压测已经证明，当前问题不是一个孤立 bug，而是**消息表示在 4 条链路里长期分叉**：

1. `gateway.ts` 负责 live event、quoted 注入、群聊 recent messages 注入
2. `chat-history.ts` 负责 `/im/v1/messages` 标准化与 archive 补全
3. `merge-forward.ts` 负责另一套 `post` / `interactive` / 附件展开
4. `group-archive.ts` 负责把消息落盘给 `conversation-search` / `deep-search` / `memory-bridge` 消费

当前这几条链路共享的不是一个统一 schema，而是各自先把消息压成不同的 `text`，再零散补一些字段。结果就是：

- 同一条消息，在 live event、history、quoted、archive 里可能拥有不同的 sender 表示
- 同一条消息，在 dynamic injection 和 history tool 里可能看到不同的人名、不同的 mention 展示、不同的 footer 处理
- 同一条消息，一旦写入 archive，就会永久丢失 actor / reply / attachment 结构，下游搜索和记忆会继续放大这个错误

#### 系统里所有"会消费消息"的场景

必须逐个覆盖，不能只看群聊动态注入：

1. 私聊当前入站消息（live event）
2. 私聊引用 / reply
3. 私聊历史读取（session + 飞书消息回读）
4. 群聊当前入站消息（live event）
5. 群聊自动注入 recent messages（dynamic injection）
6. 群聊 history API / `feishu_group_history`
7. 群聊 quoted / thread / parent lookup
8. 群聊本地 archive
9. `conversation-search` / `deep-search` / `memory-bridge`
10. bot 自己发出的 `card` / `text` / `media`，之后再次被 quote、history、archive、search 消费

#### before：哪些能力本来就是对的，after 绝不能回退

- live event 对"当前消息"的原始信息通常最完整。私聊/群聊普通 `text`、`post`、当前消息自己的媒体，大多数时候已经是对的
- history tool 的时间线、`message_id`、`parent_id` / `root_id` / `thread_id` 基础能力大多是对的
- 当前多媒体下载、本地保存、Office/PDF 提取链路是有价值的，after 不能弱化
- `merge_forward` 当前保守禁用虽然能力不强，但口径稳定，after 不应偷偷从旧 archive 复活脏内容
- 群聊 dynamic injection 对普通人类文本聊天已经具备基本可读性，after 只能统一，不允许退化

#### before：为什么明明"大部分是对的"，最后仍然会错

- dynamic injection、history、quoted、archive 四条链路没有共享同一个 message schema
- sender 解析分成 event sender、群成员列表、directory、archive sender 四套口径
- quoted path 只给正文，不给"这是谁的话"
- archive schema 太薄，落盘时就把结构化信息压扁成 `sender + text`
- dynamic injection 与 history tool 的 token、hydration、footer 处理不一致
- bot 自己发出的消息又分散在 `cardTextCache`、`messageTextCache`、group archive、sent log 多套状态里

#### after：必须满足的 3 层严格一致

1. **集合一致**
   - 同一时间窗里，private/group 的 live、dynamic injection、history、quoted lookup、archive hydration 必须看到同一组可见消息
   - 不能一个走 `tenant_access_token`，一个走 `user_access_token`，一个又绕过 archive 补全

2. **表示一致**
   - 同一条消息，无论从 live event、history API、quoted lookup、local archive、cache 进入系统，都必须先归一化成同一个 `FeishuCanonicalMessage`
   - dynamic injection、history tool、quoted context、archive search snippet 只能从这同一个对象渲染，不能自己临时拼字符串

3. **持久化一致**
   - archive / cache 不能只存一坨 `text`
   - 必须把 actor、reply、attachments、footer、provenance 结构化保存，否则 search / memory 仍会看到脏数据

#### 冻结的数据结构（草案）

下面不是实现细节，而是**必须保留的语义集合**。字段名可以微调，但语义不能少：

```ts
type FeishuActorRef = {
  canonicalId: string;
  canonicalIdType: "open_id" | "app_id" | "user_id" | "unknown";
  senderType: string;
  actorKind: "human" | "bot" | "system" | "unknown";
  displayName?: string;
  rawIds: Partial<Record<"open_id" | "user_id" | "union_id" | "app_id", string>>;
  resolutionSource: "event" | "history_api" | "chat_member" | "directory" | "archive" | "cache";
  resolved: boolean;
};

type FeishuMentionRef = {
  key: string;
  actor: FeishuActorRef;
  renderedText: string;
};

type FeishuAttachmentRef = {
  kind: "image" | "file" | "audio" | "video" | "post_image" | "post_media";
  fileKey?: string;
  imageKey?: string;
  fileName?: string;
  localPath?: string;
  extractedText?: string;
  coverage: "full" | "partial" | "none";
};

type FeishuCanonicalMessage = {
  messageId: string;
  chatId: string;
  chatName?: string;
  messageType: string;
  createTimeMs: number;
  sender: FeishuActorRef;
  mentions: FeishuMentionRef[];
  attachments: FeishuAttachmentRef[];
  reply?: {
    parentId?: string;
    rootId?: string;
    threadId?: string;
    quoted?: {
      messageId: string;
      messageType: string;
      sender: FeishuActorRef;
      text: string;
      attachments: FeishuAttachmentRef[];
    };
  };
  text: {
    raw: string;
    normalized: string;
    withoutFooter: string;
    footer?: string;
  };
  coverage: "full" | "partial" | "none";
  provenance: {
    sourcePath: "live_event" | "history_api" | "quoted_lookup" | "local_archive" | "cache";
    tokenMode?: "tenant" | "user";
    archiveHit?: boolean;
    cacheHit?: boolean;
  };
};
```

#### before vs after：关键场景对比

| 场景                                             | before                                                                               | after（必须做到）                                                                                           | 0 回退要求                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 私聊当前消息                                     | 大多数 `text` / `post` / 当前媒体已基本正确                                          | 仍以 live event 为主，但先归一化成 canonical message                                                        | 不能丢失当前 live path 已有的正文和媒体能力                     |
| 私聊 quoted / reply                              | 常只有 quoted 正文，没有 quoted sender / type / attachments                          | 必须结构化注入 `reply.quoted.sender` / `messageType` / `attachments` / `text.withoutFooter`                 | 不能再靠正文风格猜"这是谁的话"                                  |
| 私聊 history / transcript                        | 时间线基本可用，但 sender / attachment / footer 口径和 live path 不一致              | 与私聊 live / quoted 共享同一 renderer                                                                      | 私聊里看到的 sender、附件摘要、footer 处理必须和 live path 一致 |
| 群聊当前消息                                     | 普通 `text` / `post` 多数可读，但 actor 解析仍可能退化                               | 当前 live event 仍保留为最优原始源，再进入同一 canonical layer                                              | 不能把当前已经可读的人类文本搞坏                                |
| 群聊 dynamic injection                           | 人名、mentions、footer、archive hydration 都是局部修补；与 history 不严格一致        | dynamic injection 与 history 必须共用同一个 repository + renderer                                           | 同一条群消息在 dynamic 和 history 里必须长得一模一样            |
| 群聊 history                                     | 时间线/线程基础能力对，但 sender name 缺失、token/hydration 口径与 dynamic 不同      | 与 dynamic injection 读取同一 canonical message 集合                                                        | 不允许再出现"history 能看到 / dynamic 看不到"的结构性分叉       |
| 私聊消息手工转发到群，再被引用或 @ 两个 bot 分析 | 模型容易把正文像 bot 的内容错判成另一个 bot 说的话                                   | 必须明确区分 `event sender`、`quoted sender`、`original sender`；如果飞书没给原作者字段，就标记为 `unknown` | **绝不允许猜作者**；不做任何"看起来像 tester/Her"的推断         |
| archive / search / memory                        | 只消费 `sender + text`，错误一旦落盘就会持续放大                                     | archive 升级为结构化 schema，search / memory 从 canonical renderer 读取                                     | 不允许 search/memory 比 live/history 拿到更脏的 sender 结果     |
| bot 自己发的 card / media / footer               | `cardTextCache`、`messageTextCache`、archive、sent log 分叉，footer 有时剥离有时保留 | bot 自己的出站消息也必须先归一化，再写 cache / archive                                                      | bot 自己的话在 quote、history、dynamic、search 里必须完全一致   |
| `merge_forward`                                  | 当前统一禁用，虽然保守但稳定                                                         | 继续统一禁用，直到有单独设计                                                                                | 不允许从旧 archive 偷偷恢复旧内容                               |

#### 0 回退 gate（必须写成测试和验收标准）

1. 私聊 live、私聊 quoted、私聊 transcript 共享同一个 parser / actor resolver / renderer
2. 群聊 live、群聊 dynamic injection、群聊 history 共享同一个 parser / actor resolver / renderer
3. 同一条消息从 `live_event`、`history_api`、`quoted_lookup`、`local_archive` 四个入口归一化后，`sender`、`mentions`、`reply`、`attachments`、`text.withoutFooter` 必须一致
4. 不允许根据正文风格、markdown 形态、bot 语气去猜 sender；飞书没有结构化字段时，只能输出 `unknown`
5. 不允许长期保留双口径 archive/cache；必须有版本化 schema，并在切换后只读写新格式

#### 结论：这套方案能否实现

**能实现，但只有在满足下面 4 个条件时才成立**：

1. `gateway.ts`、`chat-history.ts`、`merge-forward.ts` 不再各自定义"什么叫消息"
2. dynamic injection 和 history tool 必须共用同一个 message repository，而不是各自拿 token、各自补 hydration
3. quoted / archive / search / memory 不再直接消费裸 `text`，而是消费 canonical message
4. archive / cache 升级为结构化 v2 schema，并用 parity test 把"严格一致"卡成失败即阻塞

如果只是继续在 `gateway.ts`、`chat-history.ts`、`group-archive.ts` 上逐点补丁，这个目标**实现不了**，以后一定还会出现 sender / quoted / archive / footer 同类错位。

在继续讨论用户场景前，先冻结这一层底层消息约束。下面仍然只回答一个更实际的问题：

`用户在真实飞书群里，问自己的 Her"群里发生了什么、我该关注什么、帮我记住哪句话、帮我总结今天内容"时，新方案到底怎么做，哪些场景能成，哪些场景不能承诺 100%。`

---

## 文档目标

这份文档只聚焦 3 件事：

- 当前飞书群聊在实测层面的真相是什么
- 旧方案为什么在"其他 Her / 其他 bot / 群历史总结"上不可靠
- 新方案在具体用户场景里如何执行，以及每个场景的成败边界

本文不再空谈"理论上有权限就能看到"，一律以本轮实测和用户真实话术为准。

---

## 实测基线

### 本轮实验对象

- `A = 本机 start.sh 跑起来的 Her`
- `B = carher-1`
- 群：`test`
- 群 `chat_id`：`oc_d37eb39f87a3363e490658d47b2315c7`

### 本轮证据文件

- `tmp/feishu-bot-interop/20260307-130353/summary.md`
- `tmp/feishu-bot-interop/20260307-130353/report.json`
- `tmp/feishu-bot-interop/20260307-130353/supplemental-checks.json`

### 本轮发送矩阵

本轮实际发送并验证了以下 18 个 probe：

- `text`
- `post`
- `quote reply`
- `thread reply`
- `image`
- `file`
- `audio`
- `video`
- `interactive`

验证维度不是单点，而是 3 层：

- `实时层`：另一个 Her 是否通过当前 bot 事件链路收到
- `历史层`：两边的 `user_access_token` 是否都能事后从群历史读回
- `内容层`：读回来的正文、附件 key、资源下载是否接近人类看到的内容

### 已确认的实测事实

| 能力                                                      | 结果         | 说明                                                                                                                                                                              |
| --------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两边 `user_access_token` 可见 `test` 群                   | 通过         | 两边都能主动拉 `test` 群历史                                                                                                                                                      |
| 一个 Her 发到群里的 bot/app 消息，另一个 Her 是否实时收到 | 失败         | 双边日志和本地群归档都没有这次 probe                                                                                                                                              |
| `text` / `post` 历史回读                                  | 通过         | 双边都能读回正文                                                                                                                                                                  |
| `text` / `post` 里的 @ 用户历史回读                       | 通过         | `mentions` 数组稳定返回，`mentions.id` 会自动翻译为观察者 app 的 `open_id`（飞书标准行为），Her 用 `mentions[i].id == 自己用户 open_id` 即可判断"我的用户被 @"，8/8 测试全部 PASS |
| `quote reply` 历史回读                                    | 通过         | `parent_id` / `root_id` 可回读                                                                                                                                                    |
| `thread reply` 在 `message.list(chat)` 中直接发现         | 失败         | `chat` 维度不会直接列出 thread 内回复本身                                                                                                                                         |
| `thread` 枚举                                             | 通过         | 先从 root 消息拿 `thread_id`，再调用 `message.list(container_id_type=thread)` 可拉到 thread 内消息                                                                                |
| `thread reply` 用 `message.get(message_id)` 回读          | 通过         | 能拿到正文、`parent_id`、`root_id`、`thread_id`                                                                                                                                   |
| `image` 历史回读 + 下载                                   | 通过         | 双边都能下资源                                                                                                                                                                    |
| `file` / `audio` 历史回读                                 | 通过         | 但历史里返回的 `file_key` 与发送时 key 不同                                                                                                                                       |
| `file` / `audio` 下载                                     | 通过         | 必须使用历史回读出来的实际 `file_key`                                                                                                                                             |
| `video` 历史回读                                          | 失败         | `message.list` 中表现为 `nonsupport`                                                                                                                                              |
| `video` 用 `message.get` 回读                             | 失败         | 本轮两边都返回 500                                                                                                                                                                |
| `interactive` 历史回读正文                                | **部分通过** | v1 内联卡片：降级为 2D 数组但文本 ~90% 可提取（2026-03-14 修复）；v2 CardKit 卡片：仍返回"请升级至最新版本客户端"不可读                                                           |

### 关于 @ mention "漂移"的澄清

早期验证中曾误判"mentions.id 会随观察者漂移、不可靠"。根因已查清：

- 飞书 `open_id` 是 app-scoped 的：同一个自然人在不同 app 下有不同 `open_id`
- 历史回读时，飞书 API 会自动把 `mentions.id` 翻译成当前观察者 app 的 `open_id`
- 这不是数据损坏，而是飞书的标准行为
- 早期测试用的两个 `user_access_token` 都对应同一个自然人（卜弋天），只是 app 不同所以 `open_id` 不同
- 修正后用 4 种发送方式（docker text/post、local text/post）× 2 种观察者做交叉验证，**8/8 全部 PASS**
- 结论：**Her 用 `mentions[i].id == 自己用户 open_id` 可以 100% 判断"我的用户是否被 @ 了"**

### 这组事实意味着什么

可以直接下 3 个结论：

1. `不能依赖 bot 对 bot 的实时收群消息`
2. `必须改成查询时主动拉群历史`
3. `即便主动拉历史，也必须按"chat 主线 + thread 二阶段补拉"执行，而且仍不是所有消息类型都能 100% 还原`

---

## 旧方案为什么不够

旧方案的主要问题不是"没权限"，而是"真相源选错了"。

### 旧方案的问题 1：依赖被动归档

现有 `feishu-her` 的群聊归档建立在 bot 收到入站消息之后再写本地文件。

这条链路对"其他 Her / 其他 bot 在群里发的话"不可靠，因为本轮实测已经证明：

- `A` 发到群里的 bot/app 消息，`B` 没有通过当前事件链路实时收到
- 反过来也一样

因此，`本地 messages.jsonl` 不能再被视为"群里全量事实"。

### 旧方案的问题 2：把 interactive 当正文

本轮已经确认：

- `interactive` 在 `message.list` 和 `message.get` 里都会降级
- 拿不到完整正文
- 拿到的是占位图 + 提示文案，而不是人类实际看到的可读内容

因此，任何把"真实语义"只写进 `interactive` 的设计，都会直接破坏后续的检索、总结、记忆、关注点提取。

### 旧方案的问题 3：把"上面那句话"交给 AI 猜

用户说"记住上面那句话"，如果没有明确引用目标消息，那么：

- 上面到底指哪一句
- 是主群主线消息还是 thread 里的话
- 是文本、卡片、视频还是文件说明

都不确定。

这种场景如果继续靠猜，不会有 100%。

---

## 新方案总览

新方案的核心不是"让两个 bot 互相实时看到"，而是：

`在用户发起查询/命令时，由 Her 以用户身份主动回拉群历史，再基于确定性规则做理解与回答。`

### 新方案的统一执行链路

1. 用户发起一个明确问题或命令
2. Her 确定目标群和时间范围
3. Her 使用用户 token 主动拉群历史
4. Her 对可支持的消息类型做标准化
5. Her 对不可完全支持的消息类型显式标记 coverage 缺口
6. Her 输出结果时附带 coverage 说明，而不是假装"已经看到了全部"

### 新方案的事实源

从现在开始，群聊问题的事实源应该分成两类：

- `查询时主动回拉的群历史`：主事实源
- `本地群归档`：辅助缓存，只能加速，不能当真相

### 新方案的强约束

要想让群聊能力真正接近 100%，必须把产品规则收紧，而不是继续允许任意消息形态自由生长。

必须遵守：

- 群聊正文只允许 `text` / `post` 承载核心语义
- `interactive` 只能做展示，不能做唯一信息载体
- 文件、音频、视频如果需要后续被总结，必须同时发一条 `text` / `post` 摘要
- "记住这句话 / 解释这句话 / 处理这句话"类需求，必须要求用户`回复/引用`目标消息
- "总结今天所有信息"类需求，回答里必须带 coverage 说明

---

## 新方案的消息规范

### 规范 1：聊天层只负责可回拉语义

聊天消息的职责不是"好看"，而是：

- 可读
- 可搜
- 可回拉
- 可总结
- 可引用

因此，推荐结构是：

- 群里发一条短 `text` / `post`
- 如果需要漂亮排版或长文，附一个飞书文档链接

### 规范 2：附件不是语义本体

对于图片、文件、音频、视频，Her 不能假设"附件本身就足够表达语义"。

每次发送这类内容时，都应该同时发送一条摘要性 `text` / `post`，至少包含：

- 这是什么
- 为什么用户要关注
- 和当前话题的关系

### 规范 3：引用是精确定位的唯一主路径

凡是用户说：

- "记住上面那句话"
- "解释刚才那条"
- "把那条转成待办"
- "把刚才他说的记下来"

都必须要求用户用`回复/引用`来绑定目标消息。

没有引用，就没有 100%。

---

## 场景总表

| 场景                                       | 旧方案         | 新方案                              | 当前结论                          |
| ------------------------------------------ | -------------- | ----------------------------------- | --------------------------------- |
| 1. 私聊问"test 群里该关注什么最新消息"     | 不可靠         | 查询时主动拉群历史 + @ mention      | `主路径可行（@ 已验证 8/8 PASS）` |
| 2. 群里说"记住上面那句话"                  | 靠猜，不可靠   | 必须引用目标消息                    | `引用 text/post/thread 时可行`    |
| 3. 群里说"总结今天内容，包括所有信息"      | 假完整         | 主动拉历史 + coverage 声明          | `不能承诺 100%`                   |
| 4. 私聊问"今天哪些群里有人点名我/要我处理" | 基本做不到     | 多群主动扫描 + @ mention + 正文语义 | `主路径可行（@ 已验证 8/8 PASS）` |
| 5. 群里回复某条消息后让 Her 处理它         | 不稳定         | `message.get(parent_id)` 主路径     | `可行，但受消息类型限制`          |
| 6. 其他 Her 要给用户"好看"的结果           | 易破坏可回拉性 | 群里短摘要 + 文档承载长内容         | `推荐，且最稳`                    |

---

## 场景 1

### 用户话术

`用户私聊 Her：我在 test 群里面应该关注什么最新消息？包括其他人的 Her 艾特了我的话！`

### 用户真正想要的结果

用户不是要一份空泛摘要，而是要：

- 最近有哪些新信息
- 哪些信息和我有关
- 哪些信息需要我行动
- 其他人的 Her 有没有点名我、催我、交给我任务

### 新方案如何执行

1. Her 识别目标群为 `test`
2. 如果用户没给时间范围，默认取`今天 00:00 到现在`
3. Her 使用用户 token 主动拉 `test` 群历史
4. Her 对以下消息类型做标准化：
   - `text`
   - `post`
   - `quote reply`
   - `image`
   - `file`
   - `audio`
5. Her 从可回拉正文里抽取"值得关注"的信号：
   - 飞书 `@` mention（`mentions[i].id == 自己用户 open_id` → 被点名）
   - 明确交付动作
   - 风险、阻塞、审批、截止时间
   - 文件/音频附带的文字摘要
6. Her 输出时按"需要行动 / 需要知晓 / 可忽略"分层
7. Her 在结果末尾附 coverage 说明

### 当前能做到什么

- 如果其他人的 Her 发的是 `text` / `post`，而且正文里写清楚了要用户关注什么，这个场景有机会做成
- 如果信息是图片、文件、音频，但同时配了文字摘要，这个场景也有机会做成
- 如果其他人的 Her 在 `text/post` 正文里明确写出"请谁处理 / 谁是 owner / 谁需要关注"，这个信号可被稳定提取
- 飞书 `@` 是可靠的 attention 信号（8/8 PASS）：Her 用 `mentions[i].id == 自己用户 open_id` 即可 100% 判断"我的用户被 @ 了"

### 当前做不到什么

- 如果其他人的 Her 把语义只写在 `interactive` 卡片里，这个场景做不到 100%
- 如果"点名用户"的关键信息只存在于 `interactive` 或视频里，这个场景做不到 100%

### 这个场景的真实结论

`这是一个主路径可行的场景。飞书 @ 已验证可靠，结合 text/post 正文语义，Her 可以准确识别"其他 Her 艾特了我的话"。`

只有 `interactive` 内的语义仍然不能承诺 100%。

---

## 场景 2

### 用户话术

`用户在群里面艾特自己的 Her：请你记住上面那句话。`

### 用户真正想要的结果

用户想让 Her 精确锁定某一句话，并把它变成后续可追溯的记忆。

### 新方案如何执行

新方案必须把这个场景改写成：

`用户回复/引用目标消息，再 @ 自己的 Her：请你记住这句话。`

执行链路：

1. Her 从当前消息里读取 `parent_id`
2. Her 调用 `message.get(parent_id)`
3. Her 读取被引用消息的标准化正文
4. Her 存储结构化记忆，至少包含：
   - `chat_id`
   - `message_id`
   - `parent_id`
   - `root_id`
   - `sender`
   - `msg_type`
   - `normalized_text`
   - `stored_at`
5. Her 回复用户："我记住的是哪一句"

### 当前能做到什么

- 引用目标如果是 `text` / `post`，可以
- 引用目标如果是 `quote reply`，可以
- 引用目标如果是 `thread reply`，也可以，因为本轮实测已经证明 `message.get(message_id)` 能回读 thread reply

### 当前做不到什么

- 如果用户不引用，只说"上面那句话"，不能承诺 100%
- 如果被引用目标是 `interactive`，拿不到完整正文，不能承诺 100%
- 如果被引用目标是视频消息，当前也不能承诺 100%

### 这个场景的真实结论

`这个场景不是"AI 理解能力"问题，而是"是否有引用目标消息"问题。`

只要产品把"引用后再说记住"做成硬规则，这个场景就能从"不可靠"变成"主路径可行"。

---

## 场景 3

### 用户话术

`用户在群里面艾特自己的 Her：请你总结今天的内容，给我一份报告。包括所有信息。`

### 用户真正想要的结果

用户要的是：

- 今天群里发生了什么
- 谁说了什么关键话
- 有哪些文件、图片、音频、视频
- 有哪些结论、任务、风险、待办
- 而且不希望漏掉"其他 Her 说的内容"

### 新方案如何执行

1. Her 以用户 token 主动拉今天的群历史
2. Her 先做 coverage 分层，而不是直接开始写摘要
3. Her 把消息划分为：
   - 可完整读取
   - 可部分读取
   - 当前无法完整读取
4. Her 只对"可完整读取"部分做强结论
5. Her 对"可部分读取"部分单独列成附件清单或风险清单
6. Her 输出报告时必须显式写出 coverage

推荐的报告结构：

- 今日重点
- 待处理事项
- 附件与证据
- 未完全覆盖部分

### 当前能做到什么

本轮实测支持较好的部分：

- `text`
- `post`
- `quote reply`
- `image`
- `file`
- `audio`

### 当前做不到什么

以下部分当前不能承诺"包括所有信息"：

- `interactive`：正文降级
- `video`：历史表现不人类等价
- `thread reply`：不能只靠 `message.list(chat)` 单阶段拉取，必须做 `chat -> thread` 二阶段补拉

### 这个场景的真实结论

`如果用户坚持"包括所有信息"，当前不能诚实地回答"可以 100%"。`

新方案下，正确做法不是假装完整，而是：

- 给出一份尽量完整的报告
- 同时声明哪些部分已覆盖，哪些部分没法 100% 覆盖

也就是说，这个场景的答案必须从：

`我已经总结了全部`

改成：

`我已经完整覆盖 text/post/quote/image/file/audio，以及已发现 root.thread_id 的 thread；interactive、video 仍有缺口。`

---

## 场景 4

### 用户话术

`用户私聊 Her：今天哪些群里有人点名我、需要我处理、或者其他 Her 交给我事情了？`

### 为什么这个场景重要

这比"总结所有群"更贴近真实办公场景。

用户真正关心的是：

- 我今天有哪些必须处理的事
- 哪些群里有人明确找我
- 哪些其他 Her 已经把事情抛给我

### 新方案如何执行

1. Her 先确定群集合
2. 对每个群做时间窗口内的主动历史拉取
3. 按 attention 信号排序：
   - 飞书 `@` mention（`mentions[i].id == 自己用户 open_id`）
   - 明确 owner
   - 明确 deadline
   - 明确 action item
4. 输出跨群优先级列表

### 当前能做到什么

- 对 `text/post` 中写得足够清楚的任务交办，可以部分做到
- 对正文里显式写出 owner / action item / deadline 的消息，可以稳定提取 attention 信号
- 飞书 `@` 是可靠的 attention 信号（8/8 PASS）：Her 用 `mentions[i].id == 自己用户 open_id` 即可精确判断"我的用户被 @ 了"

### 当前做不到什么

- 如果"点名用户"的关键语义在 `interactive` 里，不能 100%

### 这个场景的真实结论

`这是高价值场景，且主路径可行。飞书 @ 已验证可靠（8/8 PASS），Her 可精确判断"我的用户被 @ 了"。结合正文语义，可以稳定提取跨群 attention 信号。`

---

## 场景 5

### 用户话术

`用户在群里回复某条其他人或其他 Her 的消息，再 @ 自己的 Her：把这条记成待办 / 发我私聊 / 解释这条是什么意思。`

### 新方案如何执行

1. 用户必须回复目标消息
2. Her 用 `parent_id -> message.get(parent_id)` 回读目标
3. Her 将目标消息标准化
4. Her 执行后续动作：
   - 转待办
   - 私聊回传
   - 解释上下文
   - 记忆固化

### 当前结论

这是新方案里最稳的交互模式之一。

因为它不需要 Her 先"看懂整个群"，只需要：

- 定位 1 条明确目标消息
- 精确取回
- 再做处理

### 失败边界

- 目标消息若是 `interactive`，仍然有正文降级问题
- 目标消息若是视频，仍然不是人类等价

---

## 场景 6

### 用户话术

`其他 Her 需要在群里给用户一个更好看的结果，怎么办？`

### 新方案如何执行

推荐拆成两层：

- 群聊里只发短 `text/post` 摘要
- 长内容、图标、结构化展示放飞书文档

推荐格式：

1. 群里发一句简短结论
2. 群里发 2 到 5 条关键点
3. 最后附飞书文档链接

### 为什么这是正解

这样做同时满足：

- 群聊消息可被历史接口回拉
- Her 以后还能总结这些消息
- 文档里依然可以追求展示效果

### 这个场景的真实结论

`群聊层先追求可回拉、可总结；文档层再追求好看。`

这比"把所有内容都塞进 interactive 卡片"稳定得多。

---

## 新方案的产品约束

为了让上述场景尽量成立，产品层必须明确宣布以下规则：

### 规则 1：群聊正文一律 `text/post`

任何需要被未来总结、检索、记忆、提取关注点的信息，都必须在 `text/post` 里有完整语义。

### 规则 2：interactive 不是事实源

如果还要保留 `interactive`：

- 它只能是展示层
- 不能做唯一语义承载
- 必须同步一份 `text/post`

### 规则 3：附件必须配摘要

图片、文件、音频、视频都必须配一条简短摘要。

### 规则 4：@ mention 是可靠的 attention 信号

飞书 `@` 已验证可靠（8/8 PASS）。历史回读的 `mentions` 数组会自动把 `open_id` 翻译为观察者 app 命名空间，Her 用 `mentions[i].id == 自己用户 open_id` 即可精确判断"我的用户被 @ 了"。

在正文里额外写出责任人/动作归属仍然推荐（让 AI 理解语义更精确），但 `@` 本身已经是稳定的结构化 attention 信号。

### 规则 5：引用是强约束

凡是"这句话 / 上面那条 / 刚才那句"类需求，都必须要求用户回复目标消息。

### 规则 6：总结必须附 coverage

Her 不允许再输出看起来完整、实际上有盲区的报告。

---

## 当前还缺的专项验证

为了把方案从"有条件可行"推进到"可上线产品化"，还需要补以下专项验证：

1. ~~`mentions.id` 漂移问题~~ **已解决**：飞书 `open_id` 是 app-scoped，历史回读会自动翻译为观察者 app 的 `open_id`，这是标准行为。Her 用 `mentions[i].id == 自己用户 open_id` 即可判断"我的用户被 @ 了"。8/8 测试全部通过
2. `thread/topic` 已在 `text` / `post` 根消息上验证可枚举，仍需补更多根消息类型和大规模分页边界
3. 视频消息是否存在比当前 `message.list` / `message.get` 更接近人类视图的读取方式
4. "跨多个群找今天我该关注什么"在真实群规模下的性能与输出格式

---

## 最终结论

这份设计的关键结论可以浓缩成 7 句话：

1. `两个 Her 在同一个群里，不能依赖 bot 实时互相收消息。`
2. `群聊问题必须改成查询时主动拉历史。`
3. `text/post 是唯一可靠的群聊语义载体。`
4. `interactive 只能做展示，不能做唯一正文。`
5. `thread 不是绝对盲区；要完整覆盖 thread，必须走"chat 主线 + thread 二阶段补拉"。`
6. `飞书 @ 是可靠的 attention 信号（8/8 PASS）；Her 可以 100% 判断"我的用户是否被 @ 了"。`
7. `"总结今天所有信息"当前仍不能承诺 100%；interactive 和 video 仍有主缺口。`

换句话说：

`新方案的目标不是假装 Her 已经拥有 100% 群聊全知能力，而是在实测边界内，把可行场景做成确定性主路径，把不可行边界明确暴露给用户。`
