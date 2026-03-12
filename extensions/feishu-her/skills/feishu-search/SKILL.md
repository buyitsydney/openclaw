---
name: feishu-search
description: |
  Feishu session recall, private-chat transcript lookup, and cross-chat search. Activate when user asks what was said in private chat / single chat / previous round, asks to review recent Feishu conversations, search group archives, or find past discussions. Triggers on 私聊, 单聊, session, 对话历史, 上一轮, 原话, 回顾, 找以前聊过, 群聊归档, search.
metadata: { "openclaw": { "emoji": "🔎" } }
---

# Feishu Search and Recall

Use this skill for Feishu conversation recall and search tasks. Do not use it for message sending, chat admin, document editing, calendar, or minutes workflows.

## Intent First

Decide the target before picking a tool.

- If the user asks "我们私聊/单聊说了什么", "上一轮我发了什么", "把原话给我", or similar, the target is the main private transcript.
- If the current user asks from a group chat about their own private chat with Her, this is allowed. Do not auto-refuse on privacy grounds.
- If the user asks "我们之前在哪聊过 X" or "帮我找以前提过的关键词", this is a search task, not a transcript-read task.
- If the user asks about one known group timeline, use group history tools, not private-session tools.

## Main Private Transcript

For exact private-chat recall, use this path and do not improvise:

1. Call `sessions_history(sessionKey="main", limit=10, includeTools=false)` first.
2. If the window is too small, increase `limit` on the same `sessionKey`.
3. Only when `main` clearly does not contain the answer, or the user explicitly points to another session, call `sessions_list()` for discovery and then read the target with `sessions_history()`.

### Key Semantics

- `main` is the session-tool alias for the current agent's main direct bucket.
- The canonical full key is typically `agent:main:main`.
- `sessions_list(kinds=["main"])` is a kind filter, not a key lookup.
- Do not use `kinds=["main"]` to "find" the main private session. It can filter the real target out.

## Hard Exclusions

When the target is a private transcript, do not start with any of these:

- `memory_search`
- `memory/*.md` or `MEMORY.md`
- `feishu_conversation_search`
- `feishu_deep_search`
- `feishu_group_history`
- direct transcript-file reads
- `sessions_list(kinds=["main"])`

Those tools can provide hints or summaries, but they are not the source of truth for "what we said in private chat".

## Search Tool Boundaries

- `sessions_history`
  - Use for exact transcript reads from a known session.
- `sessions_list`
  - Use for discovery when the target session is unknown.
- `memory_search`
  - Use for long-term memory, preferences, and summarized history.
  - Do not use as proof of exact transcript wording.
- `feishu_conversation_search`
  - Use for keyword search across archived groups and Her session history.
  - Good for "我们以前在哪聊过 X".
  - Not for "刚才私聊说了什么".
- `feishu_search`
  - Use for short-keyword doc/wiki lookup.
- `feishu_deep_search`
  - Use for broad multi-source research across docs, wiki, minutes, and group archives.
- `feishu_group_history`
  - Use for one known Feishu group chat timeline.

## Research Mode Boundary

Do not enter broad research mode if the target is a private transcript, even if the user says words like:

- 最近
- 昨天
- 回顾
- 总结
- 找一下

If the object being asked about is still "our private chat", read `main` first.

## Output Rules

- Say whether you read a transcript or ran a search.
- When reading a transcript, state the actual `sessionKey` you used.
- Do not claim "no private chat" before reading `main`.
- If the user asks how you checked or where you went wrong, audit your previous tool path first, then re-run the correct path.

## Worked Examples

- "我们私聊说了什么"
  - Read `sessions_history("main")`.
- "昨天单聊聊了啥"
  - Read `sessions_history("main")`, then expand the same session window if needed.
- "帮我回顾最近私聊"
  - Still read `sessions_history("main")` first. Do not jump to `memory_search`.
- "我们以前在哪聊过 KPI"
  - Use `feishu_conversation_search(keyword="KPI")`.
- "看一下 test 群最近说了什么"
  - Use `feishu_group_history`.

If you need more examples or anti-patterns, read `references/session-recall.md`.
