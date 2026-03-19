---
name: feishu-knowledge-search
description: |
  在飞书中搜索任何信息。四层策略：search 首选 → 精读补充 → ask 兜底 → deep_search 最后手段。
  当用户问企业内部问题、搜索文档/Wiki、查找谁说了什么、查群聊/私聊/会议内容时使用。
metadata: { "openclaw": { "emoji": "🔍" } }
---

# 飞书知识搜索

## 铁律：每一步都要输出中间过程

不是只在开头说一句话。**每调用一个工具，都要在调用前和返回后输出中间状态。** 用户必须实时看到你在做什么、拿到了什么。

```
正在搜索飞书知识库（仅群聊消息）...
→ 找到 12 条相关结果，其中 3 条来自 AI组织建设小群
正在精读《VR-CORE-SDK 架构设计》全文...
→ 文档共 3000 字，核心要点是...
```

## feishu_knowledge_qa 参数用法

### 基础用法（搜所有源）

```json
feishu_knowledge_qa(query="老杨对Her安全性有什么担忧")
```

默认 action=search，搜全部源。1-3 秒返回 passages + score。

### 只搜特定源（减少噪音）

```json
// 只搜群聊和私聊
feishu_knowledge_qa(query="振华要求我做什么", sources=["message"])

// 只搜 Wiki 和云文档
feishu_knowledge_qa(query="VR-CORE-SDK架构", sources=["wiki", "space"])

// 只搜妙记听写
feishu_knowledge_qa(query="面向her编程", sources=["minutes"])

// 搜文档 + 群聊（不搜妙记等）
feishu_knowledge_qa(query="降本增收红灯", sources=["space", "wiki", "message"])
```

### 精确控制群聊范围

```json
// 只搜指定群
feishu_knowledge_qa(query="洪源融合体进展", sources=["message"], chat_ids=["oc_xxx"])

// 只搜今天的消息（unix 时间戳，秒）
feishu_knowledge_qa(query="老杨在讨论什么", sources=["message"], time_start=1773849600)

// 指定群 + 时间范围
feishu_knowledge_qa(query="金龙收入策略", sources=["message"], chat_ids=["oc_xxx"], time_start=1773849600, time_end=1773936000)
```

### ask（AI 综合答案，慎用）

```json
// search + 精读都不够时才用 ask
feishu_knowledge_qa(action="ask", query="周哲人负责什么工作")

// 指定模型
feishu_knowledge_qa(action="ask", query="项目风险评估", model_type="doubao")

// 搜互联网
feishu_knowledge_qa(action="ask", query="GTC 2026 黄仁勋演讲要点", knowledge_scope="internet")
```

### sources 可选值

| 值             | 搜索范围                             |
| -------------- | ------------------------------------ |
| `space`        | 云文档（Docx/Sheet/Bitable/PDF/PPT） |
| `wiki`         | 知识库/Wiki                          |
| `message`      | 群聊 + 私聊消息                      |
| `minutes`      | 妙记听写全文                         |
| `comment`      | 文档评论                             |
| `lingo`        | 飞书词典                             |
| `helpdesk_faq` | 服务台 FAQ                           |

不传 `sources` = 搜全部。

## 四层搜索优先级

### P0: feishu_knowledge_qa search（首选！最快！）

- **一切搜索问题先用这个**，包括搜群聊、搜私聊、搜文档、搜妙记
- 语义搜索，理解自然语言
- 1-3 秒返回 passages + score
- **用 `sources` 缩小范围减噪**

### P1: Her 原生工具精读（纵深补充）

search 找到线索后，用原生工具深入：

- `feishu_doc read` → 精读文档全文
- `feishu_group_history` → 拉指定群完整历史
- `feishu_minutes get/transcript` → 读妙记详情和转写
- `feishu_search` → 关键词补充搜索 Wiki/Drive

### P2: feishu_knowledge_qa ask（search + 精读不够时的兜底）

- **不要无脑用 ask！** 只在 search + 精读都做了但仍不够时才尝试
- 20-60 秒，耗时长

### P3: feishu_deep_search（最后手段，慎用）

- 费时间、费 token，仅在前三层都不够时使用

## 标准工作流

```
用户提问
  │
  ├── 第一步：feishu_knowledge_qa search（1-3秒）
  │   ├── 用 sources 缩小范围
  │   ├── 输出中间结果给用户看
  │   └── 大多数问题到这一步就够了
  │
  ├── 第二步（需要深入时）：Her 原生工具精读
  │   ├── feishu_doc read / feishu_group_history / feishu_minutes
  │   ├── 每一步都输出中间结果
  │   └── 大多数深入需求到这一步就够了
  │
  ├── 第三步（前两步不够时）：feishu_knowledge_qa ask
  │   └── search + 精读都做了但仍不够 → 才用 ask
  │
  └── 第四步（最后手段）：feishu_deep_search
```

## 知识问答独占能力

1. **搜索私聊消息** — Her 原生工具无法搜私聊
2. **妙记听写全文语义搜索** — feishu_minutes 只能按标题匹配，知识问答能搜转写正文
3. **跨私聊+群聊+文档统一语义搜索** — 一次调用全覆盖

## Her 原生独占能力

1. **实时群聊完整历史** — feishu_group_history
2. **文档精读全文** — feishu_doc read
3. **妙记详细转写** — feishu_minutes transcript
4. **时间精确过滤** — 知识问答 message 支持 time_range 但其他源不支持

## 场景速查表

| 问题类型                  | 用什么                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| "XX 项目进展？"           | search(sources=["wiki","space","message"]) → 精读                      |
| "XX 是谁？"               | search → 精读                                                          |
| "群里讨论了什么？"        | search(sources=["message"])                                            |
| "今天群里需要处理什么？"  | search(sources=["message"], time_start=今天0点) → 不够时 group_history |
| "XX 在会上说了什么原话？" | search(sources=["minutes"])                                            |
| "XX 制度/流程？"          | search(sources=["wiki","space"]) → feishu_doc read                     |
| "XX 什么时候答应做 XX？"  | search(sources=["message"]) → 不够时 group_history                     |

## 错误处理

| quality 值       | 后续动作                              |
| ---------------- | ------------------------------------- |
| `has_results`    | 直接使用                              |
| `direct_answer`  | 直接使用                              |
| `no_answer`      | 换更具体的问法，或 feishu_deep_search |
| `quota_exceeded` | 直接走 feishu_deep_search             |
| `error`          | 看 suggestion 字段                    |

## OAuth

需要 `search:knowledge_qa:read` scope。工具返回 `user_auth_required` 时，按 `feishu-oauth` 技能处理。
