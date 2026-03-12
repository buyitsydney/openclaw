# Feishu Session Recall Examples

Use this file only when you need worked examples for session recall.

## Canonical Example

Question:

`我们私聊说了什么？`

Correct path:

1. `sessions_history(sessionKey="main", includeTools=false)`
2. Expand `limit` on the same `sessionKey` if needed
3. Answer from transcript contents

Wrong path:

1. `memory_search`
2. `feishu_conversation_search`
3. `sessions_list(kinds=["main"])`
4. `feishu_group_history`

## Why `kinds=["main"]` Is Wrong

- `main` in `sessionKey="main"` is the alias for the main direct bucket.
- `main` in `kinds=["main"]` is only a row category.
- The real private transcript may not show up under kind `main`.

## Summary vs Transcript

- `memory_search` can surface summaries, not exact wording.
- `memory/YYYY-MM-DD.md` can tell you what happened that day, not what the transcript literally says.
- `feishu_conversation_search` can show keyword hits, not prove that the main private session said it.

## Allowed Privacy Case

If the same user asks in a group chat:

`我们私聊里刚才说了什么？`

This is not an automatic refusal case. Read the main private transcript first.
