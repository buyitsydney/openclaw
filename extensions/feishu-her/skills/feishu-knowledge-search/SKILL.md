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

### 找消息

| 场景                   | 工具                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| 语义搜（"谁在担忧XX"） | `knowledge_qa search(sources=["message"])` — 理解意图，直接返回内容 |
| 关键词搜               | `message_search(query="关键词")` — 全域，含 bot 不在的群            |
| 按人搜                 | `message_search(from_ids=["ou_xxx"])`                               |
| 搜 @我的消息           | `message_search(at_chatter_ids=["ou_xxx"])`                         |
| 按时间搜               | `message_search(start_time="2026-03-20T00:00:00+08:00")`            |
| 只搜群聊/私聊          | `message_search(chat_type="group_chat")` 或 `"p2p_chat"`            |
| 某个群完整历史         | `group_history(chat_id="oc_xxx", start_time, end_time)`             |

### 找文档/Wiki

| 场景     | 工具                                            |
| -------- | ----------------------------------------------- |
| 语义搜   | `knowledge_qa search(sources=["wiki","space"])` |
| 关键词搜 | `feishu_search`                                 |
| 精读全文 | `feishu_doc read(doc_token="xxx")`              |

### 找妙记

| 场景           | 工具                                                      |
| -------------- | --------------------------------------------------------- |
| 语义搜听写全文 | `knowledge_qa search(sources=["minutes"])` — 能搜逐字转写 |
| 按标题搜       | `feishu_minutes search` — 自带 ai_summary，不需要再调 get |
| 读完整转写     | `feishu_minutes transcript(doc_token="xxx")`              |

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
1. message_search(query="关键词") → 找到 message_id + chat_id
2. group_history(chat_id, start_time, end_time) → 拉该群完整上下文
```

### 找 bot 不在的群的动态

```
有知识问答: knowledge_qa search(sources=["message"]) → 直接返回内容片段
全员: message_search(query="项目名") → 找到消息，内容自动读取
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
