---
name: feishu-knowledge-search
description: |
  在飞书文档、Wiki、妙记、群归档中按关键词搜索知识内容。
  - 搜文档/Wiki → 用 feishu_search
  - 跨文档+Wiki+妙记+群归档全源搜索 → 用 feishu_deep_search
  不用于回忆某个会话的原文（那些用 transcript 技能），不用于纯聊天记录搜索（那个用 feishu-chat-history-search）。
metadata: { "openclaw": { "emoji": "🔍" } }
---

# 飞书知识搜索

搜索飞书中的文档、Wiki、妙记等知识内容。与 `feishu-chat-history-search` 的区别：这里搜的是**文档/知识**，那个搜的是**聊天记录**。

## 两个工具的分工

| 工具 | 搜索范围 | 特点 |
|---|---|---|
| `feishu_search` | Drive 文档 + Wiki 节点 | 轻量、按标题/内容匹配 |
| `feishu_deep_search` | Drive + Wiki + 妙记 + 群归档 | 全源聚合、适合大范围查找 |

## 什么时候用哪个

- 用户要找某个已知类型的文档/Wiki → `feishu_search`
- 用户不确定信息在哪里，想全面搜一遍 → `feishu_deep_search`
- 用户只要搜聊天记录 → 不在此技能范围，用 `feishu-chat-history-search`

## OAuth

两个工具都需要用户 OAuth。工具返回 `user_auth_required` 时，按 `feishu-oauth` 技能处理。

## 硬规则

- 不得用此技能的工具来回答"私聊说了什么"或"群里刚才说了什么"
- 搜索结果是摘要/片段，不是精确原文，不得声称知道原话
- 关键词要用用户的实际搜索对象，不要用模糊重述

## 输出

- 说明你用了 `feishu_search` 还是 `feishu_deep_search`
- 返回搜索结果和来源标记
- 如果没搜到，说"没搜到"
