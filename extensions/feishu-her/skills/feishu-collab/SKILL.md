---
name: feishu-collab
description: |
  Feishu calendar and task collaboration workflows. Activate when user asks to create a meeting, check free/busy, see today's meetings, create or assign tasks, manage tasklists, add members to a list, or update task status/comments/attachments. Triggers on 日历, 建会, 忙闲, 有空吗, 会议邀请, task, tasklist, 待办, 清单, 指派, assignee.
metadata: { "openclaw": { "emoji": "📅" } }
---

# Feishu Calendar and Task Collaboration

Use this skill for calendar scheduling and task/tasklist collaboration. Use `feishu-minutes` for meeting records, summaries, or transcripts.

## Calendar

Use `feishu_calendar` for:

- `get_primary`
- `list_events`
- `create_event`
- `update_event`
- `delete_event`
- `check_freebusy`
- `remove_attendees`

### Scheduling Rules

When the user asks to book a meeting:

1. Create it immediately
2. Include the requester and mentioned people in `attendee_ids`
3. Run `check_freebusy` after creation
4. Report any conflicts clearly

Do not ask unnecessary permission questions first.

### Boundary

- `check_freebusy` shows time conflicts, not other people's event titles
- If the user asks what was said in a meeting, asks for meeting notes, or asks for original quotes, switch to `feishu-minutes`

## Tasks and Tasklists

Use task tools for:

- creating tasks and subtasks
- assigning owners / assignees
- creating shared tasklists
- adding/removing tasklist members
- moving tasks into or out of tasklists
- comments and attachments

### Recommended Flow

- For "派任务给某人", use `feishu_task_create` and pass assignees explicitly with `open_id`
- For shared lists, create the tasklist first, add members, then add tasks into the tasklist
- If the user says they cannot see a task, check whether they are actually in the assignee/member set

### Mental Model

- Task = one work item
- Tasklist = container
- Shared visibility usually depends on membership and assignee configuration

## Output Rules

- Say whether you created a meeting, checked conflicts, created a task, or updated a list
- When reporting a conflict, include who conflicts and the time range
- Do not dump internal permission jargon unless the tool actually returns a permission failure
