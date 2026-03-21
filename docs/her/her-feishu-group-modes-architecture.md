# Her 飞书群聊模式架构设计

## 概述

每个群可以独立设置一种群聊模式。用户通过自然语言让 her 切换模式，立即生效，不需要修改 config，不需要重启 docker。

**核心设计**：全部实时 event-driven，不使用 cron 轮询。gateway.ts 根据模式决定哪些消息进入 agent，agent 自己判断怎么处理。

## 四种群聊模式

| 模式     | 标识         | 谁能触发 | 需要@ | 行为                                 |
| -------- | ------------ | -------- | ----- | ------------------------------------ |
| 默认     | `default`    | 仅主人   | 要    | 只有主人 @her 才回复                 |
| 自动回复 | `auto-reply` | 仅主人   | 不用  | 主人说话不用 @，her 自动判断是否回复 |
| 艾特回复 | `at-reply`   | 任何人   | 要    | 群里任何人 @her 都会回复，不 @ 不动  |
| 群聊     | `group`      | 任何人   | 不用  | 群里任何消息都会触发 her             |

### 模式 1：默认模式（default）

**谁的消息进入 agent**：只有主人 @her 的消息
**agent 回复到哪**：群里

```
张三（主人）：@her 帮我查一下项目进展     → agent run → 群里回复 ✅
李四：@her 帮我查一下                     → 静默 ❌（李四不是主人）
张三：这个方案不错（没 @）               → 只 archive ❌
其他 bot 回复                             → 只 archive ❌
```

### 模式 2：自动回复主人模式（auto-reply）

**谁的消息进入 agent**：主人的消息（不需要 @）
**agent 回复到哪**：群里

```
张三（主人）：这个项目进度有点慢         → agent run → AI 判断回复 ✅
张三（主人）：好的收到                   → agent run → AI 判断不回复 ✅
李四：明天开会                           → 只 archive ❌
其他 bot 回复                             → 只 archive ❌
```

### 模式 3：艾特回复模式（at-reply）

**谁的消息进入 agent**：任何人 @her 的消息（不限主人）
**agent 回复到哪**：群里

```
张三（主人）：@her 帮我查项目进展         → agent run → 群里回复 ✅
李四：@her 帮我查个文件                   → agent run → 群里回复 ✅
王五：@herA @herB 你俩对一下             → herA 和 herB 同时醒 ✅
张三：这个方案不错（没 @）               → 只 archive ❌（不 @ 不动）
其他 bot 回复                             → 只 archive ❌
```

**核心场景**：一个群里有多个 bot（每人一个 her），任何人可以 @任何人的 her，跟 @同事一样自然。不 @ 就零消耗。

**注意**：bot 使用的是主人的 OAuth token，非主人触发时也能搜到主人的飞书消息和文档。

### 模式 4：群聊模式（group）

**谁的消息进入 agent**：所有人 + 所有 bot 的消息（除了自己发的）
**agent 回复到哪**：群里或私聊（agent 自己判断）

```
李四问"文档在哪"                         → agent run → 群里回复答案 ✅
王五问"bug 谁负责"                       → agent run → 群里回复 ✅
张三说了敏感内容                         → agent run → 私聊通知主人 ✅
其他 bot 回复了什么                       → agent run → AI 判断（大概率不重复回复）
her 自己发的消息                          → gateway 过滤 ❌（防自循环）
```

---

## gateway.ts 消息过滤逻辑

```
收到群消息 → archive（所有模式都 archive）
  ↓
读 groupMode（从 workspace 文件）
  ↓
├─ default:    isBotSender → return
│              !wasMentioned → return
│              !isOwner → return
│              → 进入 agent
│
├─ auto-reply: isBotSender → return
│              !isOwner → return
│              → 进入 agent（不需要 @）
│
├─ at-reply:   isBotSender → return
│              !wasMentioned → return
│              → 进入 agent（不检查 owner，任何人 @ 都可以）
│
└─ group:      isSelfBot → return（只过滤自己的消息）
│              rateLimitExceeded → return
│              → 进入 agent（所有人 + 其他 bot 的消息都进）
```

**关键区别**：

- `isBotSender`：过滤所有 bot 消息（default / auto-reply / at-reply 用）
- `isSelfBot`：只过滤这个 bot 自己的消息，其他 bot 的消息放行（group 用）
- `isOwner`：检查发送者是否为主人（default / auto-reply 用，at-reply 不检查）

---

## 防风暴设计

### 自循环防护

her 发消息 → 飞书事件推回 → gateway 收到 → `isSelfBot` 检查 → **过滤掉**。

`isSelfBot` 实现：比较 sender 的 app_id 或 open_id 与当前 bot 的 app_id/botOpenId。

### 跨 bot 防护

| 模式       | 风暴风险       | 原因                                                           |
| ---------- | -------------- | -------------------------------------------------------------- |
| default    | 无             | bot 消息全部过滤，只响应主人 @                                 |
| auto-reply | 无             | bot 消息全部过滤，只响应主人                                   |
| at-reply   | 无             | bot 消息全部过滤，只响应人类 @，不 @ 不动                      |
| group      | **有（可控）** | agent 可能在群里回复 → 其他 bot 的 group 模式看到 → 可能也回复 |

### group 模式风暴场景推演

**最坏情况**：群里有 2 个 group 模式（her A 和 her B），200 个 Docker 容器隔离，无法全局限制。

```
00:00  人类问问题
00:05  A 的 agent run 完成 → 群里回复（5 秒 agent run 时间）
00:08  B 的 agent run 完成 → 群里也回复（重复回复）
00:10  A 收到 B 的回复 → agent run → Opus 看到已有人回答 → 大概率不回复
00:13  B 收到 A 的回复 → agent run → Opus 看到已有人回答 → 大概率不回复
       → 自然停止
```

**即使 Opus 判断失误互相回复**：每轮 5-7 秒（agent run），1 分钟最多 8-10 条。不是毫秒级死循环。

### 熔断机制

gateway.ts 加滑动窗口速率限制：

```typescript
// 如果这个 bot 在这个群里 60 秒内已经发了 5 条消息，停止转发
const recentReplies = getRecentReplyCount(chatId, 60_000);
if (recentReplies >= 5) {
  log?.warn(`rate limit: ${recentReplies} replies in 60s, skipping`);
  // 私聊通知主人
  notifyOwner(`⚠️ 群管家在 ${群名} 1 分钟内回复了 5 次，已自动暂停`);
  return;
}
```

**自动恢复**：滑动窗口，60 秒后旧计数滑出，自动恢复。不需要手动重置。

### 四层止损

| 层  | 机制                        | 速度                   |
| --- | --------------------------- | ---------------------- |
| 1   | `isSelfBot` 过滤自己的消息  | 即时（代码保证）       |
| 2   | 滑动窗口熔断（60 秒 5 条）  | 即时（代码保证）       |
| 3   | 用户 @her "恢复默认"        | 秒级（写文件立即生效） |
| 4   | 重启容器回退 `carher:local` | 分钟级（最后手段）     |

---

## 多 Her 同群场景推演

### 场景 A：3 人 3 个 her，全部 auto-reply

| 事件      | herA         | herB                      | herC       | 风暴 |
| --------- | ------------ | ------------------------- | ---------- | ---- |
| 张三说话  | ✅ agent run | 只 archive                | 只 archive | 无   |
| herA 回复 | —            | 只 archive（isBotSender） | 只 archive | 无   |

auto-reply 过滤所有 bot 消息，只响应各自主人。**零风暴风险。**

### 场景 B：6 人 6 个 her，全部 at-reply（核心企业场景）

| 事件                    | herA                    | herB          | herC-F                     |
| ----------------------- | ----------------------- | ------------- | -------------------------- |
| 丽花 @herA 查文件       | agent run → 群里回复 ✅ | archived only | archived only              |
| 国现 @herB @herC 对一下 | archived only           | agent run ✅  | herC run ✅，其他 archived |
| 天哥"今天天气" (没@)    | archived only           | archived only | 全部 archived only         |

**零风暴，零浪费**。不 @ 就不醒，@ 谁就谁醒。

### 场景 C：herA group + herB group（最坏情况）

| 事件       | herA                                         | herB                                         |
| ---------- | -------------------------------------------- | -------------------------------------------- |
| 人类问问题 | agent run → 群里回复                         | agent run → 群里回复（重复）                 |
| herA 回复  | isSelfBot → 过滤                             | agent run → Opus 看到已有回复 → 大概率不重复 |
| herB 回复  | agent run → Opus 看到已有回复 → 大概率不重复 | isSelfBot → 过滤                             |

**最坏结果**：偶尔重复回复（2 条而不是 1 条）。不是风暴。熔断兜底。

---

## 技术实现

### workspace 文件驱动

```
{workspace}/group-modes/
├── oc_abc123.json
└── oc_def456.json
```

```json
{
  "chat_id": "oc_abc123",
  "chat_name": "产品讨论群",
  "mode": "auto-reply",
  "set_by": "ou_xxx",
  "set_at": "2026-03-21T10:00:00+08:00"
}
```

不再需要 `cron_ids` 字段（不使用 cron）。

### gateway.ts 改动要点

1. 加 `isSelfBot` 判断（当前 bot 的 app_id）
2. `readGroupMode` 读 workspace 文件（已实现）
3. at-reply 分支：跟 default 一样但去掉 owner 检查
4. group 用 `isSelfBot` 替代 `isBotSender` + 滑动窗口熔断

### Skill 简化

不再需要教 her 创建 cron。skill 只需要：

1. 确定目标群
2. 确定目标模式
3. 写 group-modes 文件
4. 确认

---

## 实现状态

| 内容                                 | 状态            |
| ------------------------------------ | --------------- |
| gateway readGroupMode + auto-reply   | ✅ 已实现并验证 |
| at-reply 模式（任何人 @ 都回复）     | ✅ 已实现并验证 |
| group 模式实时化（isSelfBot + 熔断） | ✅ 已实现并验证 |
| feishu-group-mode skill（四种模式）  | ✅ 已实现并验证 |
| context 字段注入到 agent prompt      | ✅ 已实现并验证 |
| 灰度部署 docker13/14/42/43           | ✅ 已部署       |

### 已验证（2026-03-21）

- default 模式：主人 @mention only ✅
- auto-reply 模式：主人不 @ 也触发 ✅
- at-reply 模式：任何人 @ 都回复，不 @ 不动 ✅
- at-reply 多 bot 同时 @：@tester @tester2 → 两个同时醒，各自独立回复 ✅
- group 模式：所有消息进 agent，Opus 自己判断回复到群里还是私聊主人 ✅
- 模式切换（自然语言 → 写文件 → 立即生效）✅
- context 字段动态更新（用户自定义行为提示）✅
- context 注入到 agent prompt ✅
- isSelfBot 过滤（防自循环）✅
- 滑动窗口熔断（60 秒 5 条，自动恢复）✅
- message target 参数正确 ✅
- 注入攻击防护（Opus 正确识别并忽略）✅
- 灰度部署：docker13(S1) + docker14(S3) + docker42/43(S2) ✅

### 已知限制

- 飞书 `im.message.receive_v1` 不推送 bot 消息给其他 bot
- bot 消息通过注入的群历史上下文（20 条）可见，延迟到下一次人类消息触发
- 99% 场景是人类驱动，此限制影响极小
