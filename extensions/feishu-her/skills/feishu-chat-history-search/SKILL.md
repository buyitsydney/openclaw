---
name: feishu-chat-history-search
description: |
  按关键词跨聊天搜索历史记录（本地群归档 + Her session）。仅当用户有明确搜索意图时使用。
  不用于回忆某个会话的原文，不用于搜索文档/Wiki/妙记（那些用 feishu_search 或 feishu_deep_search）。
metadata: { "openclaw": { "emoji": "🔎" } }
---

# 飞书聊天历史搜索

## 什么时候用

用户明确要按关键词/主题在以前的聊天记录中查找信息。

**不适用的情况**：
- 用户要回忆某个私聊或群聊的原文 → 用 transcript 技能
- 用户要搜索文档、Wiki、妙记等非聊天内容 → 不在此技能范围

## 工具路径

- 使用 `feishu_conversation_search`
- 搜索时使用用户的实际对象或关键词，不要用模糊摘要
- 如果用户的需求涉及文档、Wiki、云盘、妙记等，此技能不适用

## 硬规则

- 不得仅凭搜索命中片段声称知道精确原文
- 不得用 `memory_search` 作为历史查找请求的事实来源

## 输出

- 说明你执行了历史搜索
- 返回匹配到的上下文，不编造原文
- 如果没搜到，说"没搜到"
