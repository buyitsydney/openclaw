---
name: feishu-group-transcript
description: |
  读取某个飞书群的对话原文。
  - 当前是群聊会话 → 最近 20 条消息（含人类和机器人）已自动注入上下文（无需调工具），仅当需要更早历史或图片/文件内容时才调 feishu_group_history
  - 当前是私聊会话 → 仅当用户指定了某个群才用此技能
  不用于私聊原文回忆，不用于关键词搜索。
metadata: { "openclaw": { "emoji": "🧾" } }
---

# 群聊原文回忆

## 两层信息来源

### 第一层：自动注入的最近消息（零延迟）

当用户在群聊中 @你 时，系统自动通过 API 拉取该群 **最近 20 条消息**（人类 + 所有机器人）注入到你的上下文。
这些消息已经在你的上下文中，**不需要调任何工具**。

注入的消息特征：

- 格式：`Feishu message from 发送者 at 时间: 内容`
- 覆盖范围：最近约 2 小时内的最后 20 条消息
- 包含所有人（人类和机器人）的消息
- 图片/文件仅为占位符（如 `[image: xxx]`、`[file: xxx]`）
- 当前轮 prompt 还会额外给出 `[Bot Identity]` 和 `[当前群聊回复规则]`
- 识别 bot 身份看 `app_id`；如果要在群里真正 `@bot`，看同轮 prompt 里的 `bot_open_id`（也是 `ou_xxx`）
- 私聊里如果被要求“去某个群里提醒某个 bot”，也要先用本轮的 `[Bot Identity]` 判断 bot 身份；不要拿 `feishu_chat_members` 去硬找 bot

### 第二层：feishu_group_history 工具（深度历史）

以下场景 **必须** 调用 `feishu_group_history`：

- 用户问的时间范围超出注入窗口（如"昨天""上周""三天前"）
- 注入的 20 条不够（群消息太密集）
- 用户从 **私聊** 问某个群的消息（私聊没有自动注入）
- 需要查看图片/文件的实际内容（注入只有占位符）
- 用户要求完整回顾（不止最近几条）

## 判断流程

1. 先看上下文中是否已有 `[Chat messages since recent activity]` 注入的群消息
2. 如果有，且用户问的是"刚才/最近"→ **直接用注入的内容回答**
3. 如果没有，或用户问的超出注入范围 → **调 feishu_group_history**

## 硬规则

- 注入内容已覆盖的范围内不要重复调 feishu_group_history（浪费时间）
- 不得声称"没有群聊记录"如果还没调过 feishu_group_history
- 从私聊跨群查询时，必须知道目标群（chat_id 或群名）
- 不得仅凭记忆回答群 transcript 问题
- 不得把群 transcript 问题路由到 `sessions_history("main")` 或 `feishu_conversation_search`

## 不适用

- 私聊 transcript 回忆 → 用 `feishu-dm-transcript`
- 跨聊天关键词搜索 → 用 `feishu-chat-history-search`
