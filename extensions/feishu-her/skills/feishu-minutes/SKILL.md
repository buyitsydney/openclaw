---
name: feishu-minutes
description: |
  飞书妙记、会议纪要、AI 摘要和原文转写。当用户问某次会议讲了什么、要会议纪要或 AI 摘要、要原话转写、要查谁说了什么、或要按主题搜索以前的会议时使用。
metadata: { "openclaw": { "emoji": "🎙️" } }
---

# 飞书妙记

用于会议记录和会后证据。不要把这些请求路由到日历，除非用户只关心日程安排。

## OAuth 前置

`feishu_minutes` 需要用户 OAuth。工具返回 `user_auth_required` 时，按 `feishu-oauth` 技能的流程处理。

## 操作边界

- `list` — 用于基于时间的回忆（默认 30 天）
- `search` — 用于按主题查找
- `get` — 用于获取某次会议的 AI 摘要/详情。**传 `doc_token` 效果最好**；只传 `minute_token` 时工具会自动尝试查找对应 doc_token
- `transcript` — 获取完整转写。支持 `minute_token` 或 `doc_token`

普通摘要请求不要直接跳到 `transcript`。

## 心智模型

- `minute`：正式会议记录对象
- AI 摘要文档：快速摘要层
- Transcript 文档/文本：昂贵的证据层

工具可以在你需要完整 transcript 之前就返回摘要和片段。

## 路由规则

- 用户只关心日程安排时用日历
- 用户问会议讲了什么、要纪要、原话、谁说的时用妙记
- 如果 `search` 已提供足够证据，直接回答，不要强制调 `get` 或 `transcript`
- 摘要看起来有误且上下文充足时自行修正，否则升级到 `transcript`
- `list` 返回的结果中看 `has_ai_summary` 字段：为 `false` 时该妙记没有 AI 摘要文档，`get` 无法获取摘要，需要直接用 `transcript` 获取内容
- 调用 `get`/`transcript` 时，优先传 `doc_token`（从 `list` 结果获取），比只传 `minute_token` 更可靠

## 输出规则

- 说明你用了 `list`、`search`、`get` 还是 `transcript`
- 明确标注回答依据是 AI 摘要还是 transcript 证据
- 如果升级到了 `transcript`，解释原因

如需更深的对象模型或证据升级规则，读 `references/object-model.md`。
