# Feishu Minutes Object Model

Use this file when a meeting request is ambiguous or when you need to decide whether to stay on summary-level evidence or upgrade to transcript.

## Three Objects

- `minute`
  - metadata object for the meeting record
- AI summary / summary doc
  - best for fast understanding of what was discussed
- transcript
  - best for exact wording, speaker attribution, and evidence

## Escalation Strategy

1. Start with `list` or `search`
2. Use `get` for one meeting's AI summary/details
3. Upgrade to `transcript` only if:
   - the user asks for original wording
   - the user asks who said it
   - summary/snippets are insufficient
   - cross-meeting conflicts require exact verification

## Typical Task Mapping

- `overview`
  - "今天都开了哪些会"
  - use `list`
- `lookup`
  - "谁提了 KPI"
  - use `search`
- `deep-dive`
  - "这场会讲了什么"
  - use `get`
- `evidence`
  - "原话是什么"
  - use `transcript`

## Important Boundary

Meeting notes and schedule are different:

- schedule / time slot / availability -> calendar
- what was discussed / notes / transcript -> minutes
