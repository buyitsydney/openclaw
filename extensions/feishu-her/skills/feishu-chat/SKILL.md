---
name: feishu-chat
description: |
  飞书即时聊天操作：发消息、回复、@提醒、查看群信息或成员、管理员/置顶/顶部公告/Tab、撤回已发 Bot 消息、发送图片/语音/文件。当用户要在聊天中执行动作时使用。不用于回忆以前说过什么。
metadata: { "openclaw": { "emoji": "💬" } }
---

# 飞书聊天操作

仅用于聊天界面和消息投递。不用于私聊原文回忆、群 transcript 回忆、聊天归档搜索、文档编辑、云盘上传状态机、日历、妙记。

## 先获取真实 ID

操作前先确认需要的 ID：

- 群 `chat_id`: `oc_xxx`
- 消息 `message_id`: `om_xxx`
- 用户 `open_id`: `ou_xxx`
- 机器人真正用于 `@` 的 `bot_open_id`: 也是 `ou_xxx`
- `member_id_type`: 默认 `open_id`

硬规则：

- 不得编造 `chat_id` 或 `open_id`
- 缺少必需 ID 时先查找或询问
- 绝对不要把 `app_id` / `cli_xxx` 直接填进 `<at user_id="...">`
- 不得假装不支持的操作已成功

## 工具表

- `feishu_chat` — `list/get/members`
- `feishu_chat_manage` — `create/get/update/delete/update_owner`
- `feishu_chat_members` — `list/add/remove/is_in_chat/add_managers`
- `feishu_chat_controls` — `get_moderation/get_menu_tree`
- `feishu_chat_tabs` — `add/delete`
- `feishu_chat_pins` — `pin/unpin`
- `feishu_chat_top_notice` — `put/delete`
- `feishu_chat_capability` — `status`
- `feishu_directory` — 组织/用户查找
- `message` — 发送消息和附件
- `feishu_message` — 撤回已发消息

## 发消息

```text
message(action="send", channel="feishu", target="oc_xxx|ou_xxx", message="...")
```

- `oc_xxx` 发到群
- `ou_xxx` 发到个人
- `media` 用绝对路径
- 超过 30 MB 的文件不走聊天附件，路由到 `feishu-drive`

## @提醒

使用飞书 `<at>` 标签，不要用纯文本 `@名字`。

```text
<at user_id="ou_xxx">姓名</at>
```

流程：

1. **@人**：从 `feishu_chat_members` 或 `feishu_directory` 获取真实 `open_id`
2. **@bot**：优先使用当前上下文里 `[Bot Identity]` / `[当前群聊回复规则]` 给出的 `bot_open_id`
3. `bot_open_id` 也是 `ou_xxx`；`app_id` / `cli_xxx` 只用于识别 bot 身份，不可直接拿来 `@`
4. 用 `<at ...>` 组装最终消息
5. @所有人用 `<at user_id="all">所有人</at>`

绝对规则：

- `@人` / `@bot` 最终都必须写成 `<at user_id="ou_xxx">名字</at>`
- 如果你只知道某个 bot 的 `app_id`，但不知道它的 `bot_open_id`，不要瞎填 `<at>`；先使用上下文里已给出的映射，或退化成普通文本 `@名字`
- 从私聊被要求“去另一个群里 @bot”时，也先看本轮上下文里的 `[Bot Identity]`；不要因为当前会话是私聊就假设拿不到 bot 的 `open_id`
- `feishu_chat_members` 默认只适合找人类成员，不要把它当成 bot 名录

## 群管理规则

- "顶部公告/强提醒" 对应 `feishu_chat_top_notice`，不是 pins
- 只有用户明确说消息置顶/取消置顶时才用 `feishu_chat_pins`
- 需要能力矩阵或想解释限制时调用 `feishu_chat_capability(action="status")`

## 消息撤回

用 `feishu_message` 撤回 24 小时内 Bot 发出的消息。

- 用户回复了那条消息时，从群聊元数据 `reply_to_id` 或私聊 `Replied message` 提取 `message_id`
- 没有引用目标时，先用 `feishu_message(action="list_sent")` 查找最近消息

确认要简短。没有确认目标不要批量撤回。

## 图片、语音和排队消息

- 除非日志或工具输出明确显示图片下载失败，否则不要说看不到图片
- 直接图片、引用图片、post 嵌入图片、图片文件都是合法的视觉输入
- 语音/音频会自动转写，不要手动调用 TTS
- `merge_forward` 已禁用，视为不可用
- 输入包含 `[Queued messages while agent was busy]` 时，把每个 `Queued #n` 当作独立 turn 按顺序回答

## 联系人和名字

- **按姓名找人**：优先用 `feishu_directory(action="search_users", query="张三")` — 直接按关键词搜索全公司通讯录，返回 name + open_id + department_ids（需 OAuth）
- 需要真实显示名且目标在群内时，也可用 `feishu_chat_members(action="list")`
- 组织架构浏览用 `feishu_directory(action="list_departments")` 再 `list_users`
- 个人版飞书中 `list_users`/`get_user` 可能只返回 `open_id` + 状态（平台限制）
- 找到 open_id 后可直接：发消息（`message` 工具）、拉会（`feishu_calendar` create_event + attendee_ids）、派任务（`feishu_task`）

## 从聊天中分享文档

分享文档/Wiki 链接到聊天：

1. 用 `feishu_wiki(action="resolve_url")` 或 `feishu_sheet(action="get_share_url")` 解析真实分享 URL
2. 用 `message(action="send", ...)` 发送

不要手工拼飞书分享链接。
