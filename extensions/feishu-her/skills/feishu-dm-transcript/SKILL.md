---
name: feishu-dm-transcript
description: |
  读取用户与 Her 的私聊原文。
  - 用户在群聊中提到"私聊/单聊/DM" → 跨 session 读取私聊原文
  - 用户在私聊中但需要上下文窗口之外的较早对话 → 用工具读取历史
  不用于群聊原文回忆，不用于关键词搜索。
metadata: { "openclaw": { "emoji": "🔐" } }
---

# 飞书私聊原文回忆

## 什么时候用

1. **主场景：跨 session 访问**——用户在群聊中，想知道自己与 Her 私聊里的内容。这时当前 context 只有群消息，必须用工具跨 session 读取私聊。
2. **次要场景：长对话追溯**——用户在私聊中，但问的是很久之前的对话（已被上下文压缩/截断），当前 context 里找不到。

如果用户在私聊中问的内容在当前 context 里就能找到，**不需要调工具，直接回答**。

## 工具路径

1. 先调用 `sessions_history(sessionKey="main", limit=10, includeTools=false)`
2. 窗口不够则在同一个 `sessionKey` 上增大 `limit`
3. 只有 `main` 确实不含答案、或用户明确指向另一个 session 时，才调用 `sessions_list()` 发现目标，再用 `sessions_history()` 读取

## 硬规则

- 不得以 `memory_search` 开头
- 不得以 `feishu_conversation_search` 开头
- 不得以 `feishu_group_history` 开头
- 不得直接读 transcript 文件
- 不得用 `sessions_list(kinds=["main"])` 来查找私聊

## 关键语义

- `main` 是 agent 主私聊桶的别名
- 完整 key 通常是 `agent:main:main`
- `kinds=["main"]` 是行分类过滤器，不是 key 查找

## 不适用

- 群聊 transcript 回忆 → 用 `feishu-group-transcript`
- 跨聊天关键词搜索 → 用 `feishu-chat-history-search`

## 输出

- 说明你读取了私聊 transcript
- 说明你使用的 `sessionKey`
- 读 `main` 之前不得断定私聊中没有答案

如需工具路径补充说明，读 `references/session-recall.md`。
