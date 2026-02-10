---
name: feishu-group-archive
description: Read and summarize Feishu group chat archives. Use when the user asks about group chats, group messages, what was discussed in a group, summarize a group, or mentions a Feishu group name. Triggers on keywords like 群聊, 群消息, 群里聊了什么, 总结群, group chat, group archive.
metadata: { "openclaw": { "emoji": "💬", "requires": { "bins": ["jq"] } } }
---

# Feishu Group Archive

Read archived Feishu group chat messages stored locally.

## Location

```
~/.openclaw/feishu-groups/
├── index.json                         # Group index: chatId -> { name, lastMessage }
├── <chatId>/
│   └── messages.jsonl                 # One JSON object per line
```

## Index Format

```json
{
  "oc_abc123": { "name": "产品讨论群", "lastMessage": "2026-02-10T15:30:00Z" },
  "oc_def456": { "name": "技术架构群", "lastMessage": "2026-02-10T14:20:00Z" }
}
```

## Message Format (JSONL)

Each line in `messages.jsonl`:

```json
{"ts":1707235200,"sender":"张三","senderId":"ou_xxx","text":"明天开会记得带材料","msgId":"om_xxx"}
```

Fields: `ts` (unix epoch seconds), `sender` (name or open_id), `senderId` (open_id), `text`, `msgId`.

## Common Queries

### List all archived groups

```bash
jq '.' ~/.openclaw/feishu-groups/index.json
```

### Read recent messages from a group

Find chatId from index first, then:

```bash
tail -50 ~/.openclaw/feishu-groups/<chatId>/messages.jsonl | jq -r '"[\(.ts | todate)] \(.sender): \(.text)"'
```

### Today's messages

```bash
TODAY=$(date +%Y-%m-%d)
jq -r "select((.ts | todate) | startswith(\"$TODAY\")) | \"[\(.ts | todate)] \(.sender): \(.text)\"" ~/.openclaw/feishu-groups/<chatId>/messages.jsonl
```

### Search for keyword

```bash
jq -r "select(.text | test(\"keyword\"; \"i\")) | \"[\(.ts | todate)] \(.sender): \(.text)\"" ~/.openclaw/feishu-groups/<chatId>/messages.jsonl
```

### Count messages per sender

```bash
jq -r '.sender' ~/.openclaw/feishu-groups/<chatId>/messages.jsonl | sort | uniq -c | sort -rn
```

## Workflow

1. Read `index.json` to find the chatId matching the user's group name
2. Read the corresponding `messages.jsonl` file
3. Summarize or filter as requested
4. Reply in the user's language (typically Chinese)

## Tips

- If `sender` is an open_id (starts with `ou_`), the display name was unavailable at archive time
- Messages are appended chronologically; newest at the bottom
- Large files: use `tail` to read recent messages, `jq` to filter by date or keyword
- The user may refer to groups by partial name — match flexibly against index
