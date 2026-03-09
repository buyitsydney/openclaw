---
name: cron-delivery-guard
description: Guardrail for cron/reminder/report jobs. Use when the user asks to add, edit, debug, or verify a cron, scheduled reminder, daily report, weekly report, heartbeat job, or timed Feishu notification. Triggers on cron, 定时, 提醒, 日报, 周报, 定时任务, 定时提醒, schedule.
metadata: { "openclaw": { "emoji": "⏰" } }
---

# cron-delivery-guard

Use this skill whenever the task is about creating, editing, or validating cron jobs and timed notifications.

## Deterministic Test Trigger

If the latest user message is exactly `cron共享技能测试V1`, reply exactly:

`cron共享技能V1已生效`

Do not add anything else.

## Hard Rules

1. Read existing jobs first.
   - Run `cron list` before proposing or creating a new job.
   - Copy the shape of a known-good job in the same environment instead of inventing fields from memory.

2. For Feishu notification jobs, use isolated agent turns.
   - Set `enabled: true` explicitly.
   - Use `sessionTarget: "isolated"`.
   - Use `payload.kind: "agentTurn"`.
   - Set `delivery.mode: "none"`.
   - Let the agent send the real Feishu message inside the payload flow.

3. Never use `announce` for Feishu notification jobs.
   - No fallback delivery mode.
   - No "maybe announce is enough" shortcuts.

4. Do not rely on defaults.
   - Set `enabled`, `sessionTarget`, `wakeMode`, `payload`, and `delivery` explicitly.

5. Test before formal rollout.
   - First create a one-minute test cron with the same payload and same delivery path as the formal job.
   - Wait for the user to confirm the Feishu message was actually received.
   - Only then create or enable the formal cron.

6. Use absolute time wording in payload text.
   - Say `周日上午9点`, not `明天早上`.

7. Stagger schedules when many jobs exist.
   - Avoid concentrated trigger times that may cause rate limits or backlog.

## Known-Good Pattern

Use this shape for Feishu notification jobs unless the current environment already has a stricter proven variant:

```json
{
  "enabled": true,
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "在这里写让 agent 真正去发飞书通知的任务"
  },
  "delivery": {
    "mode": "none"
  }
}
```

## Verification Checklist

- `cron list` shows the job in the expected state.
- The one-minute test cron was triggered.
- The final Feishu recipient actually received the message.
- The payload wording, channel, and tool path match the formal cron exactly.
