# Her 飞书群聊架构设计

状态：**已实现并验证**。基于 2026-03-07 `test` 群双 Bot 实测，`feishu_group_history` 工具已上线，群聊正文已切换为 `text/post`。

### 实现状态（2026-03-07）

- `feishu_group_history` 工具：已实现并部署，支持 `list_history` / `list_thread` / `get_message` 三种 action
- 群聊输出格式：Her 在群聊中已切换为 `text/post`（非 interactive 卡片），私聊保持卡片流式输出
- 群聊消息合并：Her 的群聊回复已合并为单条 `post` 消息（不再碎片化）
- page_size 语义：`page_size` 参数表示总消息数上限（默认 20，最大 200），不再是 per-page
- 时间戳：已修复为 human-readable ISO 8601 格式
- 本地归档交叉引用：支持 `file`/`image`/`audio`/`video`/`interactive` 等类型的本地路径补全
- `feishu_wiki` URL 解析：支持传入完整飞书 URL（自动提取 token 和文档类型）
- **tenant_access_token fallback**：当 `user_access_token` 遇到 231204 错误（"b2c/b2b app not support"）时，自动 fallback 到 `tenant_access_token`，已在 carher-13 验证通过

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

### 实现状态（2026-03-12 群聊上下文自动注入 — Push+Pull 混合架构）

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

本文不讨论抽象"群聊能力"，只回答一个更实际的问题：

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

| 能力                                                      | 结果 | 说明                                                                                                                                                                              |
| --------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两边 `user_access_token` 可见 `test` 群                   | 通过 | 两边都能主动拉 `test` 群历史                                                                                                                                                      |
| 一个 Her 发到群里的 bot/app 消息，另一个 Her 是否实时收到 | 失败 | 双边日志和本地群归档都没有这次 probe                                                                                                                                              |
| `text` / `post` 历史回读                                  | 通过 | 双边都能读回正文                                                                                                                                                                  |
| `text` / `post` 里的 @ 用户历史回读                       | 通过 | `mentions` 数组稳定返回，`mentions.id` 会自动翻译为观察者 app 的 `open_id`（飞书标准行为），Her 用 `mentions[i].id == 自己用户 open_id` 即可判断"我的用户被 @"，8/8 测试全部 PASS |
| `quote reply` 历史回读                                    | 通过 | `parent_id` / `root_id` 可回读                                                                                                                                                    |
| `thread reply` 在 `message.list(chat)` 中直接发现         | 失败 | `chat` 维度不会直接列出 thread 内回复本身                                                                                                                                         |
| `thread` 枚举                                             | 通过 | 先从 root 消息拿 `thread_id`，再调用 `message.list(container_id_type=thread)` 可拉到 thread 内消息                                                                                |
| `thread reply` 用 `message.get(message_id)` 回读          | 通过 | 能拿到正文、`parent_id`、`root_id`、`thread_id`                                                                                                                                   |
| `image` 历史回读 + 下载                                   | 通过 | 双边都能下资源                                                                                                                                                                    |
| `file` / `audio` 历史回读                                 | 通过 | 但历史里返回的 `file_key` 与发送时 key 不同                                                                                                                                       |
| `file` / `audio` 下载                                     | 通过 | 必须使用历史回读出来的实际 `file_key`                                                                                                                                             |
| `video` 历史回读                                          | 失败 | `message.list` 中表现为 `nonsupport`                                                                                                                                              |
| `video` 用 `message.get` 回读                             | 失败 | 本轮两边都返回 500                                                                                                                                                                |
| `interactive` 历史回读正文                                | 失败 | 只返回"请升级至最新版本客户端，以查看内容"等降级结构                                                                                                                              |

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
