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

| 内容                                        | 状态 |
| ------------------------------------------- | ---- |
| gateway readGroupMode + auto-reply          | ✅   |
| at-reply 模式                               | ✅   |
| group 模式（isSelfBot + 熔断）              | ✅   |
| feishu-group-mode skill（四种模式）         | ✅   |
| context 字段注入 + hardcoded 安全规则       | ✅   |
| block 重复回复 fix                          | ✅   |
| 灰度部署 docker13/14/42/43/66 + docker1/2/4 | ✅   |

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

### Bot Message Broadcast（Redis 广播）

飞书 `im.message.receive_v1` 不推送 bot 消息给其他 bot。当前 `discussion` 模式不再依赖 10 秒轮询发现 bot 消息，而是发送侧在**真正发出最终群消息后**同步发布 Redis broadcast。

**原理**：

1. bot A 向群里发出最终正文
2. bot A 同时 publish 一份 `{chatId, msgId, senderAppId, content, mentions[]}`
3. 其他 bot 订阅 Redis，几乎实时收到
4. 接收侧只看**显式 mention 元数据**决定是否 inject；没被点名就只 archive，不进 agent

**关键区别**：

- 最近群消息仍会补充进上下文，帮助 AI 理解现场
- 但“是否被唤醒”不再靠轮询猜测，也不靠正文里模糊匹配 bot 名字
- 只有显式 `@` 才算真正交接这一轮

**三层有序控制**：

1. **显式 mention gating（代码层）**
   - human → bot：人类消息只有显式 `@` 到当前 bot，才进入 `processing`
   - bot → bot：Redis broadcast 只有 `mentions[]` 显式包含当前 bot，才允许 inject
2. **active / idle 运行态（Redis 状态）**
   - discussion 房间有 `active` / `idle` 两种运行态
   - `idle` 时不注册参与者、不选 leader、不主动唤醒任何模型
3. **leader 选举（Redis 共享状态）**
   - 只有 active 房间才维护 `participants` / `leader` / `last_activity`
   - explicit turn 被接受后，才会 `activateDiscussionGroup()` 重新激活

**防风暴**：

- 自己发的消息不会再次唤醒自己
- 未被点名的人类消息 / bot broadcast 都只 archive
- auto-exit 后进入 idle，discussion 模式仍保留，但不再偷偷跑模型

---

## 讨论模式（discussion）— 严格显式点名路由

旧 `group` 模式已废弃。当前 `discussion` 模式是“**群里保留讨论态，但只有显式 `@` 才真正唤醒目标 bot**”。

### 核心机制

```
人类：@tester3 你主导讨论 XXX
  ↓
tester3 被显式 @ → activateDiscussionGroup() → 进入 active → 成为 / 保持 leader
  ↓
tester3 开场，并显式 @tester 分配 R1
  ↓
Redis broadcast 几乎实时送达 tester
  ↓
tester 看到 mentions[] 里有自己 → inject → processing → 回复并显式 @tester3
  ↓
tester3 被显式 @ → processing → 推进下一轮
  ↓
... 循环直到 leader 总结

没人显式 @ → 只 archive，不唤醒 → 零额外 token
5 分钟没有被接受的新一轮 → auto-exit → markDiscussionIdle()
  ↓
discussion 模式文件保持不变，但运行态进入 idle
  ↓
下一次有人显式 @ 任一 bot → 重新 activate → 讨论恢复
```

### Leader 选举（Redis 共享状态）

Leader 不由 workspace 文件持久化决定，而是通过 Redis 维护共享运行态：

- **系统默认**：active 房间里，按 `appId` 排序取最小者为 leader
- **人类指定**：Her 调 `set_discussion_leader` 工具更新 Redis
- **参与者租约**：active 房间中，每个 bot 每 10 秒续约一次；30 秒不续约视为离线
- **自动重选**：当前 leader 离线或失效后，从活跃参与者中重新选举

Redis key：

```
discussion:{chatId}:participants  — Sorted Set（score=epoch, member=appId）
discussion:{chatId}:leader        — String（appId）
discussion:{chatId}:last_activity — String（epoch）
discussion:{chatId}:state         — String（active | idle）
```

### workspace 文件

```json
{
  "chat_id": "oc_xxx",
  "chat_name": "群名",
  "mode": "discussion",
  "context": "3轮讨论，话题：XXX",
  "set_by": "ou_xxx",
  "set_at": "ISO时间"
}
```

**禁止写 `leader_app_id`**。leader 和运行态都由 Redis 管理。

### context 注入

当前注入给 Her 的不是“硬控制脚本”，而是技术事实：

> "讨论模式。bot 之间通过 Redis 广播几乎实时看到彼此消息，但只有显式 `@` 才代表真正唤醒。没有显式点到你时不要发群消息。系统空闲时不会主动唤醒你。"

leader / participant 的差异仍会被注入，但重点已经从“轮询 + heartbeat”切换成“显式点名交接”。

### 实现状态（2026-03-26 当前 worktree）

| 内容                                           | 状态            |
| ---------------------------------------------- | --------------- |
| bot -> bot broadcast 只认显式 mention 元数据   | ✅ 已实现并验证 |
| human -> bot 只在显式 `@` 时进入 processing    | ✅ 已实现并验证 |
| discussion active / idle 运行态                | ✅ 已实现并验证 |
| auto-exit 进入 idle（mode 不切回 group-at）    | ✅ 已实现并验证 |
| idle 时不再 heartbeat / 不再主动唤醒模型       | ✅ 已实现并验证 |
| set_discussion_leader 切换后禁止额外公开交接   | ✅ 已实现并验证 |
| 技术机制 skill 文案更新（解释显式 `@` 的原因） | ✅ 已实现并验证 |
| mention routing / idle 相关回归测试            | ✅ 已实现并验证 |

### 已验证场景（2026-03-26，本地 tester101/102/103）

- human 显式 `@` 单个 bot，只唤醒目标 bot ✅
- bot 显式 `@` peer bot，只 inject 被点名者 ✅
- 未被点名的人类消息 / bot 消息只 archive，不白跑 agent ✅
- auto-exit 后 discussion 保持，但运行态进入 idle ✅
- idle 房间不会靠 heartbeat 再次偷跑模型 ✅
- 下一次显式 `@` 能重新激活 discussion ✅

### 状态补充（2026-03-26：strict mention + idle checkpoint）

**这轮已经修住的，是“路由层确定性”；还没修完的，是“用户体感稳定性”。**

已完成：

1. **strict explicit @ routing**
   - human / bot 两条入口现在都只认显式 `@`
   - 未被点名的消息统一 archive only，不再进入 agent

2. **discussion auto-exit 改为 idle**
   - 5 分钟无活动后只把 Redis 运行态切成 `idle`
   - 不再把群模式切回别的模式，连续讨论体验保留

3. **移除 heartbeat 模型唤醒**
   - tick 现在只做 leader 选举、租约维护、idle 同步
   - 不再有“30 秒唤醒 leader 看看要不要说话”的隐性 token 消耗

4. **leader handoff 更干净**
   - 切 leader 后，旧 leader 本轮直接结束
   - 不再额外往群里发一条公开 handoff

**但本轮本地测试也明确暴露了两个尚未修复的上线阻塞点**：

1. **silent turn / ghost card**
   - 显式 `@` 成功进入 processing 后，模型仍可能最终不给可见正文
   - 这时会出现占位卡被清理的现象，用户体感像“发了一条又撤回”

2. **体感延迟仍偏高**
   - 单轮从被点名到最终可见正文，常见仍在 20 到 33 秒
   - 如果目标 bot 当时已有 session lane 在跑，还会再叠加数秒到十几秒排队

**上线判断（截至 2026-03-26 晚）**：

- 适合：测试群灰度、继续打闭环
- 不适合：直接当作稳定版正式上线

### 已知限制 & 风险

- 飞书仍然不会把 bot 消息直接推给其他 bot；discussion 依赖 Redis 广播链路
- 只要一个 turn 被真正接受，就仍然会消耗一整轮模型推理；strict routing 解决的是“误唤醒”，不是“零成本对话”
- 当前主要用户态风险不是硬死锁，而是**静默回合**和**高延迟误判成卡死**
