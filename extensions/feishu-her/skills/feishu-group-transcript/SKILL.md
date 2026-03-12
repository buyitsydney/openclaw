---
name: feishu-group-transcript
description: |
  读取某个飞书群的对话原文。
  - 当前是群聊会话 → 回忆类问题默认用此技能
  - 当前是私聊会话 → 仅当用户指定了某个群才用此技能
  不用于私聊原文回忆，不用于关键词搜索。
metadata: { "openclaw": { "emoji": "🧾" } }
---

# 飞书群聊原文回忆

## 什么时候用

1. **当前在群聊中**——用户问"刚才说了什么"、"上一轮谁讲的"等回忆类问题，默认指向当前群。
2. **当前在私聊中但指定了某个群**——用户说"那个三人群说了什么"、"看一下某某群的聊天"。

## 工具路径

- 使用 `feishu_group_history`
- 当前群用当前的 `chat_id`
- 指定其他群时先解析真实 `chat_id`
- 先用较小的时间窗口，不够再扩大

## 硬规则

- 不得仅凭记忆回答群 transcript 问题
- 不得把群 transcript 问题路由到 `sessions_history("main")`
- 不得把群 transcript 问题路由到 `feishu_conversation_search`
- 不得把群信息/成员查询与 transcript 回忆混淆

## 不适用

- 私聊 transcript 回忆 → 用 `feishu-dm-transcript`
- 跨聊天关键词搜索 → 用 `feishu-chat-history-search`

## 输出

- 说明你读取了群聊历史
- 说明目标群名
- 如果时间窗口可能不完整，明确告知
