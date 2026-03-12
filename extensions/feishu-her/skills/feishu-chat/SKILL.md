---
name: feishu-chat
description: |
  Feishu messaging, groups, members, mentions, message recall, images, voice, and file sending. Activate when user asks to send a message, reply in a group, @mention someone, manage members/admins/tabs/notices/pins, inspect a group, recall a sent message, or handle image/audio/chat attachments. Triggers on 群聊, 发消息, 提醒某人, @某人, 成员, 管理员, 置顶, 顶部公告, 撤回, 图片, 语音, 文件发送.
metadata: { "openclaw": { "emoji": "💬" } }
---

# Feishu Chat Operations

Use this skill for chat surfaces and message delivery. Do not use it for transcript recall, doc editing, drive upload state machines, calendar, or minutes.

## Collect Real IDs First

Before mutating anything, gather the exact IDs you need:

- `chat_id` for groups: `oc_xxx`
- `message_id` for message-level operations: `om_xxx`
- user `open_id`: `ou_xxx`
- `member_id_type`: default to `open_id` unless the tool requires something else

Hard rules:

- Do not invent `chat_id` or `open_id`.
- If a required ID is missing, ask or look it up first.
- Do not pretend an unsupported action succeeded.

## Tool Map

- `feishu_chat`
  - `list/get/members`
- `feishu_chat_manage`
  - `create/get/update/delete/update_owner`
- `feishu_chat_members`
  - `list/add/remove/is_in_chat/add_managers`
- `feishu_chat_controls`
  - `get_moderation/get_menu_tree`
- `feishu_chat_tabs`
  - `add/delete`
- `feishu_chat_pins`
  - `pin/unpin`
- `feishu_chat_top_notice`
  - `put/delete`
- `feishu_chat_capability`
  - `status`
- `feishu_directory`
  - org/user lookup
- `message`
  - send messages and attachments
- `feishu_message`
  - recall sent messages

## Message Sending

Send normal text or media with:

```text
message(action="send", channel="feishu", target="oc_xxx|ou_xxx", message="...")
```

- Use `oc_xxx` for groups.
- Use `ou_xxx` for direct delivery.
- Use absolute file paths for `media`.
- If the file is over 30 MB, do not send it as chat media. Route to `feishu-drive`.

## Mentions

Use Feishu `<at>` tags, not plain-text `@名字`.

```text
<at user_id="ou_xxx">姓名</at>
```

Workflow:

1. Get the real `open_id` from `feishu_chat_members` or `feishu_directory`.
2. Compose the final message using `<at ...>`.
3. For everyone, use `<at user_id="all">所有人</at>`.

## Chat Admin Rules

- "顶部公告/强提醒" means `feishu_chat_top_notice`, not pins.
- Only use `feishu_chat_pins` when the user explicitly means message pin/unpin.
- When you need a capability matrix or want to explain a limitation, call `feishu_chat_capability(action="status")`.

## Message Recall

Use `feishu_message` to recall bot messages sent in the last 24 hours.

- If the user replied to the message, extract `message_id` from:
  - group chat metadata `reply_to_id`, or
  - the first line of `Replied message` in direct chat
- If there is no quoted target, use `feishu_message(action="list_sent")` to find the recent message first.

Keep confirmations short. Do not batch-recall without a confirmed target.

## Images, Voice, and Queued Messages

- Do not say "I cannot see the image" unless logs or tool output explicitly show an image-download failure.
- Direct images, quoted images, post-embedded images, and image files are all valid vision inputs.
- Voice/audio is auto-transcribed. Do not manually call TTS.
- `merge_forward` is disabled; treat it as unavailable and do not promise expansion.
- When the input contains `[Queued messages while agent was busy]`, treat each `Queued #n` as a separate user turn and answer in order.

## Contacts and Names

- In personal Feishu, `feishu_directory` may only return `open_id` + status.
- If you need real display names and the target is in a group, prefer `feishu_chat_members(action="list")`.
- For org lookup, use `feishu_directory(action="list_departments")` then `list_users`.

## Document Sharing from Chat

To share a doc/wiki link into chat:

1. Resolve the real share URL with `feishu_wiki(action="resolve_url")` or `feishu_sheet(action="get_share_url")`.
2. Send that URL with `message(action="send", ...)`.

Never hand-build Feishu share links.
