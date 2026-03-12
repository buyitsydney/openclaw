# Feishu Skill Operational Notes

This note keeps rollout and migration details out of the active agent prompt.

## Why This Exists

The active Feishu skills should contain routing rules and tool semantics, not regression logs or deployment-era reminders. Keep the operational notes here so they do not bloat prompt context.

## Capability Checks

- For current chat-management capability status, use `feishu_chat_capability(action="status")`
- Do not hardcode old rollout matrices into active skills

## Enterprise Migration Pitfall

- `99992361 open_id cross app` usually means an old app's `open_id` is still being reused
- After switching apps, update the matching owner/open-id configuration and restart the instance

## Directory Behavior Reminder

- Enterprise Feishu typically returns richer directory fields
- Personal Feishu may only return `open_id` + status
- If you need names and the user is already in a group, prefer group-member lookup

## 2026-03-12: chatNameCache 移除 & Skill 拆分

### Bug Fix: 群名改名后 prompt 不更新

- **根因**: `outbound.ts` 中的 `chatNameCache`（进程级 Map）缓存了群名，改名后不会刷新，`/new` 也无法清除。
- **修复**: 删除 `chatNameCache`，每次 inbound 时调用 Feishu API 获取最新群名。
- **影响范围**: 仅 `getFeishuChatName()`，不涉及 session 路由或 transcript 存储。
- **验证**: 本地 her + tester 多轮私聊/群聊压力测试通过，群名改名后下一条消息 prompt 立即反映新名。

### Skill 拆分

旧 `extensions/feishu-her/skills/feishu/SKILL.md`（1036 行）拆为 8 个独立 skill：
`feishu-chat` / `feishu-collab` / `feishu-doc` / `feishu-drive` / `feishu-minutes` / `feishu-perm` / `feishu-search` / `feishu-wiki`

### 已知预存问题（非本次引入）

- tester `agent:main:main` 的 `origin` 元数据有时被 upstream session 管理覆写为群 chat_id，属于 `src/` 上游行为，不影响实际路由和 transcript 隔离。

## Rollout Checklist

1. Restart the gateway after skill changes
2. Verify the new skill names appear in the runtime skill list
3. Smoke-test trigger phrases for:
   - private transcript recall
   - group/message operations
   - doc editing
   - drive upload
   - calendar/task
   - minutes
4. Start with single-account verification before wider rollout
