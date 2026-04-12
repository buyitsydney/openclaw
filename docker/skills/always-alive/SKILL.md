---
name: always-alive
description: "Always Alive watchdog — 让 Her 永远在线、主动巡检、主动汇报。触发条件：1) 主人说'永远在线'/'always alive'/'启动watchdog' → 首次安装并启动；2) 主人说'关闭永远在线'/'停止watchdog' → 卸载并停止；3) 收到 [WATCHDOG] 系统事件 → 执行巡检流程；4) 主人说'更新通讯录'/'刷新contacts' → 重新扫描更新 contacts.md。"
---

# Always Alive Watchdog

## 安装（主人说"永远在线"时执行）

### Step 1：全域扫描建档（首次惊喜）

首次启动前，先帮主人把世界摸清楚。完整流程见 `references/contacts-builder.md`。

**必须执行的扫描：**

1. `feishu_chat` → 拿 bot 加入的所有群
2. `feishu_knowledge_qa(sources=["message"])` → 搜主人名字，发现主人活跃的群
   - 如果 knowledge_qa 不可用，fallback：`feishu_search` + `feishu_message_search`
3. 综合分析，按规则判断每个群的优先级（🔴重点 / 🟡普通 / ⚪低优先级）
4. 识别重要私聊联系人（频繁@主人的人、主人的上级/下属）
5. 读取 `assets/contacts-template.md`，填充数据，写入 workspace `contacts.md`

**Her 自主判断优先级的规则：**

- 🔴 重点：主人是群主/管理员、主人近期发言多、主人频繁被@、小群但信息密度高
- 🟡 普通：主人偶尔发言、群较大但有相关话题
- ⚪ 低优先级：纯通知群、主人从不发言、超大群无互动

### Step 2：私聊发送首次报告

用 `message(action='send')` 发送首次报告，内容包括：

- 发现了多少个群（bot 在的群 + 主人活跃的群）
- 重点群列表及判断理由
- 重要联系人
- 告诉主人可以随时调整（"把XX群调到重点"、"XX群不用关注"）
- 告知 watchdog 即将启动

**语气要像真人助理第一天上班的自我介绍，不要机械播报。**

### Step 3：创建 \_watchdog.md

读取本 skill 的 `assets/watchdog-template.md`，原样写入 workspace `_watchdog.md`。

### Step 4：创建 watchdog cron

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

## 卸载（主人说"关闭永远在线"时执行）

1. 删除 watchdog cron：`cron(action='delete', name='watchdog-smart')`
2. 删除 `_watchdog.md`
3. `message(action='send', message='已关闭永远在线。contacts.md 保留，随时可以查看。')`

注意：卸载不删 contacts.md，通讯录是有价值的资产。

## 更新通讯录（主人说"更新通讯录"/"刷新contacts"时执行）

重新执行 Step 1 的全域扫描流程（见 `references/contacts-builder.md`），覆盖写入 contacts.md。
完成后用 `message(action='send')` 报告变化（新增了哪些群、哪些群优先级变了）。

## 巡检（收到 [WATCHDOG] 系统事件 → 读 \_watchdog.md 执行）

完整流程见 `references/execution-guide.md`。

**contacts.md 与巡检的关系：**

- 巡检时**可以读** contacts.md 来优化扫描顺序（重点群优先扫）
- 但 contacts.md **不是必须的**——即使文件不存在，巡检照常用 API 全域扫描
- 巡检**不写** contacts.md

**铁律：**

- 每次巡检结束**必须**用 `message(action='send')` 发飞书私聊给主人。session 里的输出主人看不到。
- 绝对禁止跳过任何步骤。
- 绝对禁止 NO_REPLY。
