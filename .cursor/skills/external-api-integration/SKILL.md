---
name: external-api-integration
description: Enforces mandatory official documentation lookup before integrating any external API. Use when working with third-party APIs, SDKs, message formats, webhooks, or any external service integration. Applies to Feishu, Telegram, Discord, Slack, WeChat, Xiaomi, Home Assistant, and all other external platforms.
---

# External API Integration Rules

## Core Rule (MANDATORY)

**Before writing ANY code that calls or parses an external API, you MUST:**

1. **Search the web** for the official API documentation of that platform
2. **Fetch and read** the relevant official doc page (use WebFetch)
3. **Confirm** the exact data structure, field names, and format from the official docs
4. **Only then** write the code based on verified official specs

**NEVER guess or assume an API's request/response format from memory or training data.** API formats change frequently and differ between send vs receive, v1 vs v2, etc.

## Common Pitfalls

### Send vs Receive format mismatch

APIs often use **different structures** for sending and receiving the same data type.

Example (Feishu post message):

- **Send**: `{ zh_cn: { title, content: [[...]] } }` (locale-wrapped)
- **Receive**: `{ title, content: [[...]] }` (flat, no locale wrapper)

These look similar but are structurally different. Always verify both directions independently.

### Version differences

- API v1 and v2 may have completely different schemas
- Event subscription payloads may differ from REST API responses
- WebSocket message formats may differ from HTTP callback formats

### Platform-specific quirks

- Feishu: user input with numbered lists auto-converts from `text` to `post` (rich-text) msg_type
- Telegram: markdown formatting in messages has strict escaping rules
- Discord: embed limits, rate limits, and intent requirements

## Verification Checklist

Before committing any external API integration code:

- [ ] Official docs URL was accessed and read (not just searched)
- [ ] Request format verified against official docs
- [ ] Response/event format verified against official docs
- [ ] Error response format verified
- [ ] All field names match official docs exactly (no guessing)
- [ ] Edge cases documented in comments with doc links

## When Debugging External API Issues

1. **First**: fetch the latest official docs for that API endpoint
2. **Second**: compare actual payload (from logs) against official spec
3. **Third**: identify the mismatch
4. **Never** assume the existing code is correct — verify against official docs

## Reference URLs (Quick Access)

- Feishu/Lark: https://open.feishu.cn/document/server-docs/im-v1/message/intro
- Feishu receive message content: https://feishu.apifox.cn/doc-1945309
- Telegram Bot API: https://core.telegram.org/bots/api
- Discord API: https://discord.com/developers/docs
- Slack API: https://api.slack.com/
- Home Assistant API: https://developers.home-assistant.io/docs/api/rest
