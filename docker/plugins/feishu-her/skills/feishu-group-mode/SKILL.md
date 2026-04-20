---
name: feishu-group-mode
description: |
  飞书群聊模式切换。当用户要求改变 Her 在某个群里的行为时使用。
  触发词："群聊模式"、"开放艾特"、"谁@都可以用"、"恢复默认"、"先别管了"。
  讨论模式必须强匹配"打开讨论模式"或"开启讨论模式"才触发，不要被"讨论一下"、"你们聊聊"等随意表述误触发。
  不要在用户只是问"群里聊了啥"时触发——那是即时查询。
  只在用户明确表达**改变 her 在群里的行为模式**时触发。
metadata: { "openclaw": { "emoji": "⚙️" } }
---

# 飞书群聊模式管理

## 三种模式

| 模式        | 标识         | 谁能触发 | 需要@ | 行为                                             |
| ----------- | ------------ | -------- | ----- | ------------------------------------------------ |
| **🔒主人@** | `owner-at`   | 仅主人   | 要    | 只有主人 @你 才回复（安全默认）                  |
| **👥群@**   | `group-at`   | 任何人   | 要    | 群里任何人 @你 都会回复，不 @ 不动               |
| **🗣️讨论**  | `discussion` | 系统调度 | 不用  | Her 之间单 owner 接力讨论，leader 负责控场与分配 |

## 所有场景及对应操作

### 场景 1：开启讨论模式

人类说"打开讨论模式"或"开启讨论模式"。

```
reset_discussion(
  chat_id="oc_xxx",
  owner_app_id="你自己的 app_id",
  participant_app_ids=["群里已在 discussion 模式的其他 bot 的 app_id"],
  context="人类说的话题"
)
```

- `owner_app_id` 填你自己——你是第一个发言者
- `participant_app_ids` 填你知道的、**已经处于 discussion 模式**的其他 bot
- 不在 discussion 模式的 bot 不能被你拉入，需要它的主人单独告诉它"开启讨论模式"
- **如果多个 bot 同时被 @ 说"打开讨论模式"**：第一个完成 reset 的 bot 成功，其余收到 `already_active=true`——这是正常的，不是错误。收到 `already_active` 的 bot 已自动加入为参与者，直接等待轮次分配即可

### 场景 2：主人要求你临时加入一个已有讨论

人类对你说"开启讨论模式"或"加入讨论"，但群里已有其他 bot 在讨论中。

```
set_group_mode(chat_id="oc_xxx", mode="discussion")
```

**只做这一件事。** 系统 tick timer 会在 10 秒内自动把你注册为参与者，其他 bot 可以在发言中 @ 你把发言权传给你。

**绝对不能做的事：**

- ❌ 不能调 `reset_discussion`（会推翻别人正在进行的讨论）
- ❌ 不能设置话题（话题由发起讨论的 bot 设定）
- ❌ 不能设置 leader（leader 由发起者或人类指定）

### 场景 3：重置讨论（换话题/重新开始）

人类说"换话题"、"重新开始"、"重开一轮"。只有 leader 应该执行。

```
reset_discussion(
  chat_id="oc_xxx",
  owner_app_id="你自己的 app_id",
  context="新话题"
)
```

### 场景 4：只更新话题，不重置讨论

人类说"话题改为xxx"、"只关注预算"。不打断当前发言顺序。

```
set_group_mode(chat_id="oc_xxx", mode="discussion", context="新话题")
```

### 场景 5：正常讨论发言

系统分配 turn 给你时，你正常回复。**不需要调任何工具。**

**传棒规则**：在你的回复末尾 @ 下一个 bot，系统会自动把它调到队列最前面。

```
我的分析结论是xxx。@tester4的her 你从技术角度补充一下。
```

你只需要 @ 对人。系统根据你的 @mention 自动调度下一个 owner。

### 场景 6：结束讨论轮次

人类说"结束讨论"、"收官"、"到此为止"。

```
end_discussion(chat_id="oc_xxx")
```

只需传 chat_id。一个群只有一个活跃讨论，没有歧义。
讨论模式不会关闭——下次人类发消息可以启动新一轮。

### 场景 7：关闭讨论模式

人类说"恢复默认"、"关闭讨论模式"、"别管了"。

```
set_group_mode(chat_id="oc_xxx", mode="owner-at")
```

### 场景 8：指定 leader

人类明确说"你来主导"、"你负责"、"你当 leader"。

```
set_discussion_leader(chat_id="oc_xxx", leader_app_id="你自己的 app_id")
```

只需传 chat_id 和 leader_app_id。不需要 turn_id。
只在讨论模式下有效，其他模式会被拒绝。

## 意图映射速查表

| 人类说                                           | 调什么                                                |
| ------------------------------------------------ | ----------------------------------------------------- |
| "群聊模式"、"开放艾特"                           | `set_group_mode(mode="group-at")`                     |
| "打开/开启讨论模式"                              | `reset_discussion(owner_app_id=自己, context=话题)`   |
| "加入讨论"、主人说"开启讨论模式"（群里已有讨论） | `set_group_mode(mode="discussion")`                   |
| "换话题重来"                                     | `reset_discussion(owner_app_id=自己, context=新话题)` |
| "话题改为xxx"（不重置）                          | `set_group_mode(mode="discussion", context="xxx")`    |
| "结束讨论"、"收官"                               | `end_discussion(chat_id)`                             |
| "恢复默认"、"关闭"                               | `set_group_mode(mode="owner-at")`                     |
| "你来主导"                                       | `set_discussion_leader(leader_app_id=自己)`           |

## 讨论模式行为规则

### leader / chair

1. 负责控场，不必每轮亲自发言。
2. 任何时候只保留一个公开 owner。
3. 需要收官时调用 `end_discussion`。
4. 需要重新开始时调用 `reset_discussion`。

### 当前 owner

1. 你是本轮唯一允许公开发言的人。
2. 发言末尾 @ 下一个 bot 传棒。系统根据你的 @mention 自动调度。
3. 不要同时 @ 多个 bot 传棒（系统只取第一个）。

### 参与者（非当前 owner）

1. 默认旁听，等待系统分配轮次。
2. 不要因为正文里出现你的名字就插话。
3. 人类明确 @ 你时，直接回复人类（不影响讨论轮次）。

### 人类消息

人类消息优先级最高。人类 @ 谁，谁就直接回复，不影响正在进行的讨论轮次。

## 安全铁律

1. 私聊内容不泄露到群聊。
2. owner-at 只响应主人 @。
3. group-at 响应任何 @ 你的人。
4. discussion 模式：服从系统角色分配。
5. 不要主动切换模式，只有人类明确要求时才切换。
6. 在群聊中设置模式时，不提及其他群的信息。
7. **不能替其他 bot 切换模式。** 每个 bot 的模式只能由它自己的主人决定。
