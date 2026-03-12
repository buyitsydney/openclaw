---
name: feishu-minutes
description: |
  Feishu meeting minutes, meeting notes, AI summaries, and transcripts. Activate when user asks what a meeting discussed, asks for meeting notes or minutes, wants a transcript, asks who said something in a meeting, or wants to search past meetings by topic. Triggers on 妙记, 会议纪要, 会议记录, minutes, transcript, 原话, 谁说的, 讲了什么, meeting notes.
metadata: { "openclaw": { "emoji": "🎙️" } }
---

# Feishu Minutes

Use this skill for meeting records and post-meeting evidence. Do not route these requests to calendar unless the user only wants schedule information.

## OAuth First

`feishu_minutes` needs the user's OAuth token.

If the tool returns `user_auth_required` and an `auth_url`:

1. Send the link to the user
2. Ask them to complete authorization
3. Retry after authorization succeeds

## Action Boundaries

- `list`
  - use for time-based recall such as "今天都开了哪些会"
- `search`
  - use for topic lookup such as "谁提了 cursor"
- `get`
  - use for one meeting's AI summary/details
- `transcript`
  - use only when the user explicitly wants original wording, evidence, quotes, or exact speaker attribution

Do not jump straight to `transcript` for normal summary requests.

## Mental Model

- `minute`: the formal meeting record object
- AI summary doc: fast summary layer
- transcript doc / transcript text: expensive evidence layer

The tool can return summaries and snippets before you need the full transcript.

## Routing Rules

- If the user asks "今天有什么会" and only cares about schedule, use calendar
- If the user asks "今天的会讲了什么", "会议纪要", "原话是什么", "谁说的", use minutes
- If `search` already provides enough evidence, answer directly without forcing `get` or `transcript`
- If summaries look wrong and context is sufficient, correct them; otherwise escalate to `transcript`

## Output Rules

- Say whether you used `list`, `search`, `get`, or `transcript`
- Be explicit when an answer is based on AI summary vs transcript evidence
- If you upgraded to `transcript`, explain why

If you need the deeper object model or evidence-upgrade rules, read `references/object-model.md`.
