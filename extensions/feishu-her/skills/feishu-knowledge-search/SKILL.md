---
name: feishu-search
description: |
  飞书搜索——找消息、找文档、找妙记、找人。统一入口，按场景选工具。
  覆盖：群聊、私聊（含 bot 不在的群）、Wiki、Drive、妙记听写、文档评论。
  当用户要搜索任何飞书内容、回忆聊天记录、查找文档、搜会议内容时使用。
metadata: { "openclaw": { "emoji": "🔍" } }
---

# 飞书搜索

## 铁律

1. 每调一个工具，调用前和返回后都输出中间状态。用户不能干等。
2. 搜索结果是片段/摘要，不是精确原文，不得声称知道原话。

## 硬性规则（不可违反）

- **找消息** → `message_search` 或 `knowledge_qa search(sources=["message"])`。禁止用 `deep_search` 搜消息。
- **找文档/Wiki** → `feishu_search` 或 `knowledge_qa search(sources=["wiki","space"])`。禁止用 `deep_search` 搜文档。
- **找妙记** → `feishu_minutes search` 或 `knowledge_qa search(sources=["minutes"])`。`feishu_minutes search` 自带 `ai_summary`，不需要再调 `get`。
- **找人** → `directory search_users`。
- **`deep_search`** → 仅当无知识问答且以上工具返回 0 结果时才作为最后手段。

## 快速判断：你有没有 `feishu_knowledge_qa`？

看你的工具列表。如果有 → 你有**语义+精准双引擎**，按场景选。如果没有 → 你只有**精准引擎**，走"无知识问答"路径。

---

## 有知识问答时

### 核心原则：knowledge_qa 是默认首选

`knowledge_qa` 用 user token 搜索，能搜到 bot 不在的群、私聊、跨租户内容，且无 403 权限问题。`message_search` 用 tenant token，跨群搜索经常遇到权限墙（403/230013）。

**搜任何内容，先用 knowledge_qa，再用其他工具补充精确过滤。**

### 找消息

**默认路径**：先 knowledge_qa → 再 message_search 补充

| 优先级        | 工具                                                | 适用场景                                                             |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| **1（首选）** | `knowledge_qa search(sources=["message"])`          | 任何消息搜索的默认入口。语义+关键词都行，能搜私聊和跨群，无 403      |
| 2（补充）     | `message_search(from_ids/chat_type/at_chatter_ids)` | 需要按发送人、群类型、@对象精确过滤时（knowledge_qa 不支持这些参数） |
| 3（精读）     | `group_history(chat_id, start_time, end_time)`      | 需要某个群的完整时间线上下文                                         |

**不要先用 message_search 再 fallback 到 knowledge_qa。反过来。**

### 找文档/Wiki

| 优先级        | 工具                                            | 适用场景                         |
| ------------- | ----------------------------------------------- | -------------------------------- |
| **1（首选）** | `knowledge_qa search(sources=["wiki","space"])` | 语义搜文档内容，能搜正文不只标题 |
| 2（补充）     | `feishu_search`                                 | 按标题关键词精确匹配             |
| 3（精读）     | `feishu_doc read(doc_token="xxx")`              | 读取完整文档内容                 |

### 找妙记

| 优先级        | 工具                                         | 适用场景                   |
| ------------- | -------------------------------------------- | -------------------------- |
| **1（首选）** | `knowledge_qa search(sources=["minutes"])`   | 能搜逐字转写原文，不只标题 |
| 2（补充）     | `feishu_minutes search`                      | 按标题搜，自带 ai_summary  |
| 3（精读）     | `feishu_minutes transcript(doc_token="xxx")` | 读完整转写原文             |

### 跨源综合

| 场景                 | 工具                                        |
| -------------------- | ------------------------------------------- |
| 一次搜消息+文档+妙记 | `knowledge_qa search`（全源，不传 sources） |

---

## 无知识问答时

### 找消息

| 场景           | 工具                                                       |
| -------------- | ---------------------------------------------------------- |
| 关键词搜全域   | `message_search(query="关键词")` — 含 bot 不在的群         |
| 按人/时间/类型 | `message_search` 的 from_ids / start_time / chat_type 参数 |
| 某个群完整历史 | `group_history(chat_id="oc_xxx")`                          |

### 找文档/Wiki

| 场景     | 工具                               |
| -------- | ---------------------------------- |
| 关键词搜 | `feishu_search`                    |
| 精读全文 | `feishu_doc read(doc_token="xxx")` |

### 找妙记

| 场景       | 工具                                         |
| ---------- | -------------------------------------------- |
| 按标题搜   | `feishu_minutes search` — 自带 ai_summary    |
| 读完整转写 | `feishu_minutes transcript(doc_token="xxx")` |

### 兜底

| 场景              | 工具                                     |
| ----------------- | ---------------------------------------- |
| 以上都返回 0 结果 | `deep_search` — 多源关键词聚合，费 token |

---

## 找人

| 场景                | 工具                                   |
| ------------------- | -------------------------------------- |
| 搜员工（姓名/拼音） | `directory search_users(query="姓名")` |
| 查部门              | `directory list_departments`           |

## 组合策略

### 找某个群里谁说了什么

```
1. knowledge_qa search(sources=["message"], query="关键词") → 首选，直接返回内容
2. 如需精确过滤: message_search(query="关键词") → 找到 chat_id
3. group_history(chat_id, start_time, end_time) → 拉该群完整上下文
```

### 找 bot 不在的群/私聊的内容

```
knowledge_qa search(sources=["message"]) → 首选！能搜私聊、跨群，无 403
message_search → 补充，但跨群可能 403
注意: bot 不在的群无法用 group_history 拉全量历史
```

### 晨报

```
有知识问答:
  1. knowledge_qa search("@我的名字 重要 紧急") → 3s 跨全域发现关键群
  2. group_history → 只精读发现的重点群

无知识问答:
  1. message_search(query="@我的名字", at_chatter_ids=["我的open_id"]) → 跨域发现
  2. group_history → 精读重点群
```

### 跨源调研

```
有知识问答:
  1. knowledge_qa search → 发现相关消息+文档+妙记
  2. feishu_doc read → 精读关键文档
  3. feishu_minutes transcript → 读会议原文

无知识问答:
  1. message_search + feishu_search → 分别搜消息和文档
  2. 精读同上
```

## 三层权限

| 层级  | 范围           | 搜索 | 读内容 | 拉全量历史 |
| ----- | -------------- | :--: | :----: | :--------: |
| 第1层 | Bot 加入的群   |  ✅  |   ✅   |     ✅     |
| 第2层 | Bot 没加入的群 |  ✅  |   ✅   |     ❌     |
| 第3层 | 别人的私聊     |  ✅  |   ❌   |     ❌     |

## 错误处理

| 错误                   | 含义       | 后续                                   |
| ---------------------- | ---------- | -------------------------------------- |
| 230002 Bot not in chat | bot 不在群 | 搜到了但拉不了全量历史，用搜索结果内容 |
| 230013 No availability | 无权读消息 | 多为别人私聊，搜到了但内容读不了       |
| user_auth_required     | 需要 OAuth | 按 feishu-oauth 技能处理               |

## 注意事项

- `message_search` 的 `message_type` 参数过滤的是消息**格式**（file/image/media），不是内容。纯图片消息没有可搜索文本。
- 用户的 open_id 从消息的 sender_id 元数据获取。
- `message_search` 需要 `search:message` scope（全员可用）。
- `knowledge_qa` 需要 `search:knowledge_qa:read` scope（部分用户）。
