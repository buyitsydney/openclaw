---
name: feishu-collab
description: |
  飞书日历和任务协作。当用户要求建会、查忙闲、查看今天的会议、创建/指派任务、管理任务清单、添加清单成员、或更新任务状态/评论/附件时使用。
metadata: { "openclaw": { "emoji": "📅" } }
---

# 飞书日历与任务协作

用于日历排期和任务/任务清单协作。会议纪要、摘要、原文用 `feishu-minutes`。

## 日历

用 `feishu_calendar`：

- `get_primary`
- `list_events`
- `create_event`
- `update_event`
- `delete_event`
- `check_freebusy`
- `remove_attendees`

### 排期规则

用户要求约会时：

1. 直接创建
2. 在 `attendee_ids` 中包含发起人和提到的人
3. 创建后运行 `check_freebusy`
4. 有冲突时清楚报告

不要先问不必要的权限问题。

### 边界

- `check_freebusy` 显示时间冲突，不是别人的会议标题
- 如果用户问某次会议讲了什么、要会议记录、或要原话引用，切到 `feishu-minutes`

## 任务和任务清单

用任务工具处理：

- 创建任务和子任务
- 指派 owner / assignee
- 创建共享任务清单
- 添加/移除清单成员
- 在清单中添加/移出任务
- 评论和附件

### 推荐流程

- 派任务时用 `feishu_task_create` 并明确传 `open_id` 的 assignee
- 共享清单场景：先创建清单、再加成员、再往清单里加任务
- 用户说看不到某个任务时，检查他是否真的在 assignee/member 中

### 心智模型

- Task = 单个工作项
- Tasklist = 容器
- 可见性通常取决于成员和 assignee 配置

## 输出规则

- 说明你是创建了会议、检查了冲突、创建了任务、还是更新了清单
- 报告冲突时包括冲突方和时间范围
- 不要输出内部权限术语，除非工具确实返回了权限失败
