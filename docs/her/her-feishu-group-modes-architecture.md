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

1. `readGroupMode` 读 workspace 文件（支持 `oc_xxx.json` 和 `feishu:oc_xxx.json` 两种格式）
2. 四种模式的消息过滤：default（owner+@）、auto-reply（owner）、at-reply（anyone+@）、group（all except self）
3. `isSelfBot` 判断防自循环（group 模式用）
4. 滑动窗口熔断（group 模式 60 秒 5 条）
5. 每种非 default 模式注入 hardcoded 安全规则 + 用户 context
6. 群聊 block 类型中间输出积累（防 block+final 产生重复消息）

### context 注入机制

gateway 在 agent prompt 中注入两层信息：

**不可编辑（hardcoded per mode）：**
- auto-reply: "只响应主人的消息"
- at-reply: "任何人@你都回复。注意：你使用主人的权限，搜索结果可能包含主人的私人信息，不要泄露"
- group: "自己判断群里回复还是私聊主人。不要在群里泄露主人的私聊内容"

**可编辑（用户通过 her 更新 context 字段）：**
- 用户说"只关注股票" → context 写入 → 注入 `主人指示: 只关注股票`
- 用户说"不用特别关注" → context 清空

### Skill 设计

不需要 cron。skill 只需要：写 group-modes 文件（mode + context），立即生效。

---

## 实现状态

| 内容 | 状态 |
|------|------|
| gateway readGroupMode + auto-reply | ✅ |
| at-reply 模式 | ✅ |
| group 模式（isSelfBot + 熔断） | ✅ |
| feishu-group-mode skill（四种模式） | ✅ |
| context 字段注入 + hardcoded 安全规则 | ✅ |
| block 重复回复 fix | ✅ |
| 灰度部署 docker13/14/42/43/66 + docker1/2/4 | ✅ |

### 测试记录（2026-03-21，本地 carher-1 tester + carher-101 tester2）

**模式切换：**
- default → auto-reply → at-reply → group → default 全流程 ✅
- 自然语言切换（"自动回复"/"开放艾特"/"群聊模式"/"恢复默认"）✅
- 写 group-modes 文件 + context 字段 ✅
- 下一条消息立即生效 ✅

**四种模式行为：**
- default：主人 @才回复，非主人 @静默 ✅
- auto-reply：主人不 @也触发，非主人不触发 ✅
- at-reply：任何人 @都回复 ✅
- group：所有人消息触发 agent，agent 自己判断回复方式 ✅

**context 注入：**
- hardcoded 安全规则正确注入（per mode 不同） ✅
- 用户自定义 context 动态更新 ✅
- 切换模式时 context 可保留或清空 ✅
- agent 能看到注入的 mode + context + target 信息 ✅

**安全：**
- isSelfBot 过滤（自己发的消息不触发自己）✅
- 滑动窗口熔断 ✅
- 注入攻击防护 ✅
- 非主人 auto-reply 不触发 ✅

**搜索工具全面回归（R31）：**
- tester: 6 个搜索工具全通过 ✅
- tester2: 审计报告 2189 chars ✅

### 已知问题

1. **并发 agent run 竞态**：快速连发两条 @bot 消息（<1 秒间隔）可能产生两个 card stream、两条回复。这是 OpenClaw session 路由层面的问题，非群模式 bug。单条消息不再重复（block fix 生效）。
2. **her 误解模式名**：部分 her 把"群聊模式"理解成"默认模式"导致切换失败。已通过更新 skill 描述（四种模式表格 + 意图映射表）改善。
3. **切换后当前消息用旧 context**：her 在 agent run 中写文件，当前 run 的 context 注入已完成。下一条消息才生效。正常竞态。

### 已知限制

- 飞书 `im.message.receive_v1` 不推送 bot 消息给其他 bot
- bot 消息通过注入的群历史上下文（20 条）可见，延迟到下一次人类消息触发
- 99% 场景是人类驱动，此限制影响极小
