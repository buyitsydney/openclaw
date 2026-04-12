---
name: always-alive
description: "Always Alive watchdog — 让 Her 永远在线、主动巡检、主动汇报。触发条件：1) 主人说'永远在线'/'always alive'/'启动watchdog' → 首次安装并启动；2) 主人说'关闭永远在线'/'停止watchdog' → 卸载并停止；3) 收到 [WATCHDOG] 系统事件 → 执行巡检流程。"
---

# Always Alive Watchdog

## 安装（主人说"永远在线"时执行）

### Step 1：创建 _watchdog.md
读取本 skill 的 `assets/watchdog-template.md`，原样写入 workspace `_watchdog.md`。

### Step 2：创建 watchdog cron
**必须严格使用以下参数，一个字段都不能改：**

```json
{
  "action": "add",
  "job": {
    "name": "watchdog-smart",
    "schedule": {
      "kind": "every",
      "everyMs": 300000
    },
    "sessionTarget": "main",
    "wakeMode": "now",
    "payload": {
      "kind": "systemEvent",
      "text": "[WATCHDOG] read _watchdog.md and execute."
    }
  }
}
```

**禁止修改任何参数：**
- sessionTarget 必须是 `main`，不是 isolated
- payload.kind 必须是 `systemEvent`，不是 agentTurn
- 不要加 delivery 字段（main 不支持）
- 不要加 timeoutSeconds

### Step 3：用 message tool 告诉主人
`message(action='send', message='永远在线已启动，每5分钟巡检一次。')`

## 卸载（主人说"关闭永远在线"时执行）

1. 删除 watchdog cron：`cron(action='delete', name='watchdog-smart')`
2. 删除 `_watchdog.md`
3. `message(action='send', message='已关闭永远在线。')`

## 巡检（收到 [WATCHDOG] 系统事件 → 读 _watchdog.md 执行）

完整流程见 `references/execution-guide.md`。

**铁律：**
- 每次巡检结束**必须**用 `message(action='send')` 发飞书私聊给主人。session 里的输出主人看不到。
- 绝对禁止跳过任何步骤。
- 绝对禁止 NO_REPLY。
