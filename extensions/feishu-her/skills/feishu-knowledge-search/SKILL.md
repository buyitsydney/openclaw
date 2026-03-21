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

每调一个工具，调用前和返回后都输出中间状态。用户不能干等。

## 按场景选工具

### 找消息（群聊/私聊/跨域）

| 场景                   | 工具                                                                                 | 说明                                           |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 语义搜（"谁在担忧XX"） | `knowledge_qa search(sources=["message"])`                                           | 理解意图，直接返回内容片段。仅知识问答用户可用 |
| 关键词搜全域           | `message_search(query="关键词")`                                                     | **全员可用**，覆盖 bot 不在的群 + 私聊         |
| 按人搜                 | `message_search(from_ids=["ou_xxx"])`                                                | 只搜某人发的消息                               |
| 搜 @我的消息           | `message_search(at_chatter_ids=["ou_xxx"])`                                          | 谁在 @我                                       |
| 按时间搜               | `message_search(start_time="2026-03-20T00:00:00+08:00")`                             |                                                |
| 只搜群聊/私聊          | `message_search(chat_type="group_chat")` 或 `"p2p_chat"`                             |                                                |
| 某个群的完整历史       | `group_history(chat_id="oc_xxx", start_time, end_time)`                              | 按时间全拉，不需要关键词                       |
| 私聊内容               | `knowledge_qa search(sources=["message"])` 或 `message_search(chat_type="p2p_chat")` |                                                |

### 找文档/Wiki

| 场景     | 工具                                                             |
| -------- | ---------------------------------------------------------------- |
| 语义搜   | `knowledge_qa search(sources=["wiki","space"])` — 仅知识问答用户 |
| 关键词搜 | `feishu_search` — 全员可用，Drive + Wiki                         |
| 精读全文 | `feishu_doc read(doc_token="xxx")` — 从搜索结果拿 token          |

### 找妙记/会议

| 场景           | 工具                                                            |
| -------------- | --------------------------------------------------------------- |
| 语义搜听写原文 | `knowledge_qa search(sources=["minutes"])` — 能搜到逐字转写内容 |
| 按标题搜       | `feishu_minutes search` — 全员可用                              |
| 读 AI 摘要     | `feishu_minutes get(doc_token="xxx")`                           |
| 读完整转写     | `feishu_minutes transcript(doc_token="xxx")`                    |

### 找人

| 场景   | 工具                                         |
| ------ | -------------------------------------------- |
| 搜员工 | `directory search_users(query="姓名或拼音")` |
| 查部门 | `directory list_departments`                 |

### 兜底

| 场景       | 工具                                               |
| ---------- | -------------------------------------------------- |
| 以上都不够 | `deep_search` — 多源关键词聚合，费 token，最后手段 |

## 组合策略

### 找某个群里谁说了什么

```
1. message_search(query="关键词") → 找到 message_id + chat_id
2. group_history(chat_id, start_time, end_time) → 拉该群完整历史看上下文
```

### 找 bot 不在的群的动态

```
有知识问答: knowledge_qa search → 直接返回内容片段
全员: message_search(query="项目名") → 找到消息 → 内容自动读取
```

### 跨源调研（某话题完整情况）

```
1. knowledge_qa search 或 message_search → 发现相关消息
2. feishu_search → 发现相关文档
3. feishu_doc read → 精读关键文档
4. feishu_minutes transcript → 读会议原文
```

### 晨报

```
有知识问答:
  1. knowledge_qa search("@我的名字 重要 紧急") → 3s 跨全域发现关键群
  2. group_history → 只精读发现的重点群（不用扫全部群）

无知识问答:
  1. message_search(query="@我的名字", at_chatter_ids=["我的open_id"]) → 跨域发现
  2. group_history → 精读重点群
```

## 有/无知识问答

Her 自动判断：看工具列表里有没有 `feishu_knowledge_qa`。

**有知识问答**——语义 + 精准双引擎：

- 语义/模糊/多源 → `knowledge_qa search`
- 精准/按人/按类型 → `message_search`
- 两者按场景选，不是固定先后

**无知识问答**——关键词引擎：

- 消息搜索 → `message_search`（跨域，全员可用）
- 文档搜索 → `feishu_search`
- 以上不够 → `deep_search`

## 三层权限（Her 需要知道的边界）

| 层级  | 范围           | 搜索 | 读内容 | 拉全量历史 |
| ----- | -------------- | :--: | :----: | :--------: |
| 第1层 | Bot 加入的群   |  ✅  |   ✅   |     ✅     |
| 第2层 | Bot 没加入的群 |  ✅  |   ✅   |     ❌     |
| 第3层 | 别人的私聊     |  ✅  |   ❌   |     ❌     |

- `message_search` 和 `knowledge_qa` 能搜全域（三层都能搜到）
- 但读内容受限：第2层可读，第3层不可读
- `group_history` 只能拉第1层的群

## 错误处理

| 错误                   | 含义               | 后续                                             |
| ---------------------- | ------------------ | ------------------------------------------------ |
| 230002 Bot not in chat | bot 不在这个群     | 消息搜到了但读不了全量历史，用搜索结果的内容片段 |
| 230013 No availability | bot 无权读这条消息 | 多为别人的私聊，搜到了但内容读不了               |
| user_auth_required     | OAuth 需要授权     | 按 feishu-oauth 技能处理                         |

## OAuth

`message_search` 需要 `search:message` scope（全员可用）。
`knowledge_qa` 需要 `search:knowledge_qa:read` scope（部分用户）。
工具返回 `user_auth_required` 时，按 `feishu-oauth` 技能处理。
