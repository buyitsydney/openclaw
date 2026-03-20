---
name: feishu-group-mode
description: |
  飞书群聊模式切换。当用户要求改变 Her 在某个群里的行为时使用。
  触发词："这个群改成自动回复"、"帮我盯着这个群"、"你来管这个群"、"关闭群监控"、"群模式改成xxx"、"这个群恢复默认"、"先别盯了"。
  不要在用户只是问"群里聊了啥"时触发——那是即时查询。
  不要在用户只是说"@her 帮我查"时触发——那是普通群聊交互。
  只在用户明确表达**改变 her 在群里的行为模式**时触发。
metadata: { "openclaw": { "emoji": "⚙️" } }
---

# 飞书群聊模式管理

> **读者：Her（你）。** 这份文档教你如何管理你在各个群里的行为模式。

## 五种模式

| 模式 | 标识 | 行为 | 群内发言 |
|------|------|------|---------|
| **默认** | `default` | 只有主人 @你 才回复 | 有（被 @ 时） |
| **自动回复** | `auto-reply` | 主人说话你自动判断是否回复，不需要 @ | 有（AI 判断） |
| **群监控** | `monitor` | 定时扫描群消息，私聊通知主人 | 无 |
| **群管家** | `manager` | 定时扫描群消息，在群里回复处理 | 有（定时） |
| **关闭** | `disabled` | 不处理该群任何消息 | 无 |

## 模式存储

每个群的模式存储在 workspace 文件中，gateway 每条消息自动读取，**立即生效，不需要重启**。

**文件路径**：`{workspace}/group-modes/{chat_id}.json`

> `{workspace}` = 本地 Her: `~/.openclaw/workspace`，Docker: `/data/.openclaw/workspace`

**文件格式**：
```json
{
  "chat_id": "oc_xxx",
  "chat_name": "群名",
  "mode": "auto-reply",
  "set_by": "ou_主人open_id",
  "set_at": "2026-03-20T23:00:00+08:00",
  "cron_ids": []
}
```

**文件不存在 = 默认模式。** 不需要为每个群创建文件。

## 切换流程

### Step 1: 确定目标群

- 用户在群聊中说 → 当前群就是目标
- 用户在私聊中说 → 用 `feishu_chat` action=list 搜索匹配，多个结果让用户选
- 找不到 → 问用户确认群名

### Step 2: 确定目标模式

从用户意图推断：

| 用户说 | 目标模式 |
|--------|---------|
| "改成自动回复"、"不用 @ 了"、"直接回我" | `auto-reply` |
| "帮我盯着"、"监控这个群"、"有消息通知我" | `monitor` |
| "你来管这个群"、"帮我处理群消息"、"当群管家" | `manager` |
| "恢复默认"、"只回 @"、"别自动回了" | `default` |
| "关闭"、"别管这个群了"、"退出" | `disabled` |

### Step 3: 检查约束

- **manager 模式**：一个群只能有一个管家。进入前用 `feishu_group_history` action=list_history page_size=20 检查最近消息中是否有其他 bot 发的带 `[群管家]` 标记的消息。如果有，告知用户该群已有管家。
- **monitor/manager 上限**：试用版最多 5 个群。读 `{workspace}/group-modes/` 目录，数 mode=monitor 或 mode=manager 的群。

### Step 4: 写模式文件

```bash
mkdir -p {workspace}/group-modes
```

写入 `{workspace}/group-modes/{chat_id}.json`：
```json
{
  "chat_id": "oc_xxx",
  "chat_name": "群名",
  "mode": "目标模式",
  "set_by": "ou_xxx",
  "set_at": "ISO时间",
  "cron_ids": []
}
```

**对于 default 和 disabled**：直接写文件即可（或删除文件恢复默认）。

**对于 auto-reply**：只写文件。gateway 下一条消息立即读取生效。

### Step 5: 处理 cron（仅 monitor/manager）

**进入 monitor 模式**：

创建两个 cron job（轮询 + 晚报）。Payload 引用现有的 `feishu-group-monitor` 的 references 文件。

```javascript
// 轮询
cron.add({
  name: `群监控-轮询-${群名}`,
  schedule: { kind: "every", everyMs: 3600000 }, // 60分钟
  sessionTarget: "isolated",
  payload: { kind: "agentTurn", message: POLL_PAYLOAD },
  delivery: { mode: "none" },
  enabled: true
})

// 晚报
cron.add({
  name: `群监控-日报-${群名}`,
  schedule: { kind: "cron", expr: "0 20 * * *", tz: "Asia/Shanghai" },
  sessionTarget: "isolated",
  payload: { kind: "agentTurn", message: REPORT_PAYLOAD },
  delivery: { mode: "none" },
  enabled: true
})
```

创建后把 cron_id 回填到模式文件的 `cron_ids` 字段。

**进入 manager 模式**：类似 monitor，但 cron 间隔更短（默认 30 分钟），payload 引用 `feishu-group-manager` 的 references 文件。

**退出 monitor/manager**：用 `cron.remove` 删除 `cron_ids` 中记录的 cron job。

### Step 6: 确认

**在群聊中**（只提当前群，不泄露其他群）：
```
✅ 已切换为自动回复模式
你在群里说话我会自动判断是否回复，不需要 @。
管理命令私聊我即可。
```

**在私聊中**（可展示完整信息）：
```
✅ 产品讨论群已切换为自动回复模式
- 你说话我自动判断是否回复
- 其他人的消息只归档不回复
- 说"恢复默认"切回 @模式
```

## 查看当前状态

用户说"我的群都是什么模式"、"群监控状态"时：

读 `{workspace}/group-modes/` 目录，列出所有非默认模式的群：

```
📊 群聊模式状态：
- 产品讨论群 → 自动回复（3月20日设置）
- 技术评审群 → 群监控（每60分钟，晚报20:00）
- 其他群 → 默认（@我才回复）
```

## 模式切换矩阵

| 从 → 到 | 操作 |
|---------|------|
| 任何 → default | 写 json（mode=default）+ 删 cron（如有） |
| 任何 → auto-reply | 写 json + 删 cron（如有） |
| 任何 → monitor | 写 json + 删旧 cron（如有）+ 创建轮询 cron + 晚报 cron |
| 任何 → manager | 检查无其他管家 + 写 json + 删旧 cron（如有）+ 创建轮询 cron |
| 任何 → disabled | 写 json + 删 cron（如有） |

## 安全铁律

1. **私聊内容不泄露到群聊。** 在群聊中设置模式时，不能提及其他群的名称或状态。
2. **auto-reply 只响应主人。** 非主人的消息在 auto-reply 模式下只归档，绝不回复。
3. **bot 消息不触发 auto-reply。** 其他 bot 的消息只归档，防止对话风暴。
4. **monitor 模式绝不在群里发消息。** 所有输出只通过私聊。
5. **一个群最多一个管家。** 进入 manager 前必须检查。
