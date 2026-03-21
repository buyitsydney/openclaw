# Her 飞书群聊模式架构设计

## 概述

每个群可以独立设置一种群聊模式。用户通过自然语言让 her 切换模式，立即生效，不需要修改 config，不需要重启 docker。

## 五种群聊模式

### 模式 1：默认模式（default）

**触发方式**：实时，事件驱动
**行为**：只有主人 @her 时才回复。其他人 @her 静默忽略。所有消息 archive。

```
张三（主人）：@her 帮我查一下项目进展     → her 回复 ✅
李四：@her 帮我查一下                     → her 静默 ❌
张三：这个方案不错（没 @）               → her 静默（只 archive）
```

**当前已实现**。

### 模式 2：自动回复主人模式（auto-reply）

**触发方式**：实时，事件驱动
**行为**：主人在群里说话，等同于 @her。her 收到后由 AI 判断是否需要回复——不是每句话都回，只在"适当的时候"回复。非主人消息只 archive。

```
张三（主人）：这个项目进度有点慢         → her 看到，AI 判断需要回复 → 回复
张三（主人）：好的收到                   → her 看到，AI 判断不需要回复 → 静默
李四：@her 帮忙查个东西                  → her 静默 ❌（李四不是主人）
李四：明天开会记得带资料                  → her archive，不回复
```

**龙虾（@larksuite/openclaw-lark）的群聊就是这种模式**：`requireMention: false` + `groupSenderAllowFrom: ["ou_主人"]`。

**技术实现**：gateway.ts 收到群消息时，读 `group-modes/{chat_id}.json`，如果 mode=auto-reply 且 sender 是主人，则跳过 `wasMentioned` 检查，直接把消息交给 agent 处理。agent 自行决定是否回复。

### 模式 3：群聊监控模式（monitor）

**触发方式**：cron 定时轮询（默认每 60 分钟）
**行为**：her 定时拉取群消息，分析后**私聊通知主人**。her 在群里不发任何消息。

```
[每60分钟]
her（私聊主人）：
  👁️ 群聊跟踪报告
  【产品讨论群】5 条新消息
  ⚠️ 李四问你"方案什么时候定？" → 建议回复："周五前确认"
  【技术评审群】无更新
```

**当前已有 skill**（`feishu-group-monitor`），基于 cron + workspace 文件。

### 模式 4：群管家模式（manager）

**触发方式**：cron 定时轮询（默认每 30 分钟）
**行为**：her 定时拉取群消息，批量分析，**在群里回复**需要处理的消息。同时私聊通知主人处理结果。

```
[每30分钟]
her 扫描群消息 →
  李四问"XX 项目文档在哪？" → her 在群里回复："在 Wiki/项目文档 目录下"
  王五问"这个 bug 谁负责？" → her 在群里回复："根据任务分配表，张三负责"
  her（私聊主人）：处理了 2 条群消息，详情如上
```

**约束**：一个群同时只能有一个 her 是管家。其他 her 必须在其他模式。

**当前已有 skill**（`feishu-group-manager`），基于 cron + workspace 文件。

### 模式 5：关闭（disabled）

**行为**：her 不处理该群的任何消息，不 archive。等同于 her 不在这个群。

---

## 多 Her 同群场景推演

### 场景 A：3 人 3 个 her，全部默认模式

```
群成员：张三、李四、王五、herA（张三的）、herB（李四的）、herC（王五的）
所有 her 模式：default
```

| 事件 | herA | herB | herC | 风暴风险 |
|------|------|------|------|---------|
| 张三 @herA "查进度" | ✅ 回复 | archive | archive | 无 |
| 李四 @herB "查文档" | archive | ✅ 回复 | archive | 无 |
| 张三 @herB（别人的） | archive | ❌ 静默（张三不是 herB 主人） | archive | 无 |
| herA 回复了一条消息 | — | archive（bot 消息只 archive） | archive | **无**（isBotSender → archive only） |

### 场景 B：3 人 3 个 her，全部自动回复模式

```
所有 her 模式：auto-reply
```

| 事件 | herA | herB | herC | 风暴风险 |
|------|------|------|------|---------|
| 张三说话（没 @） | ✅ AI 判断回复 | archive（张三不是 herB 主人） | archive | 无 |
| 李四说话（没 @） | archive | ✅ AI 判断回复 | archive | 无 |
| herA 回复 | — | archive（bot 消息只 archive） | archive | **无** |
| herA 和 herB 同时回复 | — | — | archive | **无**（各自只响应自己主人） |

**关键安全机制**：auto-reply 只对**主人的消息**触发 agent。bot 消息（`senderType === "bot"`）永远只 archive，不触发 agent。所以不可能出现 bot-to-bot 对话风暴。

### 场景 C：herA 是管家，herB/herC 是默认模式

```
herA 模式：manager（每 30 分钟轮询）
herB、herC 模式：default（@mention only）
```

| 事件 | herA | herB | herC | 风暴风险 |
|------|------|------|------|---------|
| 李四说"文档在哪" | [cron 轮询时] 在群里回复 | archive | archive | 无 |
| herA 在群里回复了 | — | archive（bot 消息） | archive（bot 消息） | **无** |
| 李四 @herB "帮我查" | archive | ✅ 回复 | archive | 无 |
| herB 回复 | [cron 轮询时] 看到但不重复处理 | — | archive | **无**（cron 轮询有 last_poll_time，不重复） |

### 场景 D：herA 和 herB 都是管家（错误配置）

```
herA 模式：manager
herB 模式：manager
```

| 事件 | herA | herB | 问题 |
|------|------|------|------|
| 李四说"文档在哪" | [cron] 在群里回复答案 A | [cron] 在群里回复答案 B | **重复回复**（不是风暴，但体验差） |

**防护**：进入管家模式时，her 检查 `group-modes/` 目录下该 chat_id 是否已有 manager。**但每个 her 在独立容器中，看不到其他 her 的 workspace 文件。**

**实际防护方案**：管家 her 在群里发的第一条消息带特殊标记（如 `[群管家]` 前缀）。其他 her 进入管家模式前，先读群历史检查是否已有带 `[群管家]` 标记的 bot 消息。如果有，拒绝进入管家模式。

### 场景 E：herA 自动回复 + herB 管家

```
herA 模式：auto-reply（实时响应张三）
herB 模式：manager（cron 轮询处理所有消息）
```

| 事件 | herA | herB |
|------|------|------|
| 张三说"这个方案不错" | ✅ AI 判断回复 | [cron 轮询时] 看到张三消息 + herA 回复 |
| 李四说"文档在哪" | archive | [cron 轮询时] 在群里回复 |
| herA 回复了张三 | — | [cron 轮询时] **看到 herA 回复，识别为 bot 消息，跳过** |
| herB 在群里回复了李四 | archive（bot 消息） | — |

**无风暴**。herA 实时响应主人，herB 定时处理其他人，互不干扰。cron agent 只处理人类消息，跳过 bot 消息。

---

## 防风暴总结

| 防线 | 机制 | 覆盖场景 |
|------|------|---------|
| **防线 1** | `isBotSender → archive only, skip reply`（gateway.ts） | 实时模式（1、2）不会对 bot 消息触发 agent |
| **防线 2** | auto-reply 只对**主人**的消息触发 | 其他人和 bot 的消息不触发 |
| **防线 3** | cron 模式（3、4）有 `last_poll_time`，不重复处理 | 同一条消息不会被处理两次 |
| **防线 4** | cron agent 的 payload 明确指示"跳过 bot 消息" | 管家模式不处理 bot 发的消息 |
| **防线 5** | 一个群只允许一个管家（进入前检查） | 防止重复回复 |

---

## 技术实现

### 核心原则：workspace 文件驱动，零 config 修改

模式切换通过 workspace 文件控制，gateway.ts 每条消息处理时读取文件，不修改 openclaw.json，不重启 gateway。

### 数据存储

```
{workspace}/group-modes/
├── oc_abc123.json     # 每个群一个文件
├── oc_def456.json
└── ...
```

**`oc_xxx.json` 格式**：
```json
{
  "chat_id": "oc_abc123",
  "chat_name": "产品讨论群",
  "mode": "auto-reply",
  "set_by": "ou_主人open_id",
  "set_at": "2026-03-20T10:00:00+08:00",
  "cron_ids": []
}
```

mode 取值：`"default"` | `"auto-reply"` | `"monitor"` | `"manager"` | `"disabled"`

### gateway.ts 改动

在群消息处理路径（约第 1595 行 `if (!wasMentioned)` 之前）加入模式读取：

```typescript
// ── Group mode: read from workspace file (per-message, no restart needed) ──
const groupMode = readGroupMode(chatId); // reads {workspace}/group-modes/{chatId}.json

if (groupMode === "disabled") {
  return; // 不处理，不 archive
}

if (groupMode === "auto-reply" && isOwner && !isBotSender) {
  // 主人说话，等同于 @her → 跳过 wasMentioned 检查，直接进入 agent
  log?.info(`[${account.accountId}] auto-reply mode: owner ${senderId} in ${chatId}`);
  // fall through to agent processing
} else if (!wasMentioned) {
  log?.info(`[${account.accountId}] group msg not mentioning bot, archived only`);
  return;
}

// monitor 和 manager 模式由 cron 处理，gateway 只 archive（走到这里已经 archive 了）
```

`readGroupMode` 实现：
```typescript
function readGroupMode(chatId: string): string {
  const dir = join(resolveWorkspacePath(), "group-modes");
  const filePath = join(dir, `${chatId}.json`);
  try {
    if (!existsSync(filePath)) return "default";
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return data.mode ?? "default";
  } catch {
    return "default";
  }
}
```

**性能**：每条消息一次 `existsSync` + 可能的 `readFileSync`。文件很小（~200 字节），本地磁盘读取 <1ms。200 个群同时活跃也不会有性能问题。可以加内存缓存 + 5 秒 TTL 进一步优化。

### Skill 设计：feishu-group-mode

一个统一的 skill 管理所有群聊模式的切换。

**触发词**：
- "这个群改成自动回复" / "帮我盯着这个群" / "你来管这个群" / "这个群恢复默认"
- "群模式改成 xxx" / "关闭群监控"

**Skill 执行流程**：

```
用户说"这个群你帮我管"
  ↓
Step 1: 确定目标群（私聊 → 问用户哪个群；群聊 → 当前群）
Step 2: 确定目标模式（从用户意图推断）
Step 3: 检查约束（manager 模式 → 检查是否已有管家）
Step 4: 写 group-modes/{chat_id}.json
Step 5: 如果是 monitor/manager → 创建 cron job
Step 6: 如果从 monitor/manager 切走 → 删除旧 cron job
Step 7: 确认
```

**模式切换矩阵**：

| 从 → 到 | 需要做什么 |
|---------|-----------|
| default → auto-reply | 写 json（mode=auto-reply） |
| default → monitor | 写 json + 创建轮询 cron + 创建晚报 cron |
| default → manager | 检查无其他管家 + 写 json + 创建轮询 cron |
| auto-reply → default | 写 json（mode=default） |
| monitor → default | 写 json + 删除 cron jobs |
| manager → default | 写 json + 删除 cron jobs |
| monitor → manager | 删除旧 cron + 检查无其他管家 + 写 json + 创建新 cron |
| 任何 → disabled | 写 json + 删除 cron jobs（如有） |

### 与现有 skill 的关系

| 现有 skill | 对应模式 | 改动 |
|-----------|---------|------|
| `feishu-group-monitor` | 模式 3（monitor） | **合并**到 `feishu-group-mode` skill 中 |
| `feishu-group-manager` | 模式 4（manager） | **合并**到 `feishu-group-mode` skill 中 |

合并后一个 skill 统一管理五种模式，避免 skill 之间的互斥逻辑分散在多处。

### 用户交互示例

**在群里设置**：
```
张三：@her 你帮我盯着这个群
her：✅ 已开启群聊监控模式
  - 每 60 分钟检查一次
  - 有需要你关注的消息会私聊通知你
  管理命令（私聊我即可）：
  - "改成自动回复模式" — 我在群里直接回应你
  - "改成群管家模式" — 我帮你管群
  - "关闭群监控" — 恢复默认（@我才回复）
```

**在私聊里设置**：
```
张三：帮我管一下产品讨论群
her：你说的是哪个群？找到以下匹配：
  1. 产品讨论群（oc_abc123）
  2. 产品评审群（oc_def456）
张三：第一个
her：✅ 已开启产品讨论群的群管家模式
  - 每 30 分钟扫描并回复群消息
  - 处理结果会私聊通知你
```

**切换模式**：
```
张三：产品讨论群改成自动回复模式
her：✅ 产品讨论群已从"群管家"切换为"自动回复"
  - 已停止定时扫描
  - 你在群里说话我会自动判断是否回复
```

---

## 主人（Owner）定义

### 单人主人（默认）

每个 her 有一个主人，由 `dm.allowFrom` 或 `groups.ownerIds` 定义。

### 多人主人（共享 her）

场景：财务部 10 人共享一个 her。`dm.allowFrom: ["ou_1", "ou_2", ..., "ou_10"]`。

在群聊中：
- **默认模式**：10 个人中任何一个 @her 都会回复
- **自动回复模式**：10 个人中任何一个说话都可能触发回复
- **监控模式**：监控结果发给所有 10 个主人（或只发给设置者）

**注意**：多主人模式下自动回复可能较嘈杂（10 个人的每句话都可能触发）。建议多主人场景用默认模式或监控模式。

---

## Config 字段说明（只用于基础访问控制，不用于模式切换）

### feishu-her 当前字段

| 字段 | 路径 | 用途 |
|------|------|------|
| `dm.policy` | `channels.feishu.dm.policy` | DM 策略（**当前未在代码中检查**） |
| `dm.allowFrom` | `channels.feishu.dm.allowFrom` | DM 白名单 + owner 识别 |
| `groups.enabled` | `channels.feishu.groups.enabled` | 群聊总开关 |
| `groups.archive` | `channels.feishu.groups.archive` | 群消息归档开关 |
| `groups.ownerIds` | `channels.feishu.groups.ownerIds` | 群里的主人 ID（fallback 到 dm.allowFrom） |

### upstream（官方 feishu 插件）字段

| 字段 | 路径 | 用途 |
|------|------|------|
| `dmPolicy` | `channels.feishu.dmPolicy` | DM 策略（默认 pairing） |
| `allowFrom` | `channels.feishu.allowFrom` | DM 白名单 |
| `groupPolicy` | `channels.feishu.groupPolicy` | 群准入策略（open/allowlist/disabled） |
| `groupAllowFrom` | `channels.feishu.groupAllowFrom` | 群 ID 白名单 |
| `groupSenderAllowFrom` | `channels.feishu.groupSenderAllowFrom` | 群内发言人白名单 |
| `requireMention` | `channels.feishu.requireMention` | 是否需要 @bot |
| `groups.oc_xxx.allowFrom` | `channels.feishu.groups.oc_xxx.allowFrom` | per-group 发言人白名单 |
| `groups.oc_xxx.requireMention` | `channels.feishu.groups.oc_xxx.requireMention` | per-group @要求 |

### 字段映射关系

| feishu-her | upstream | 差异 |
|-----------|----------|------|
| `dm.allowFrom` | `allowFrom` | 路径不同（嵌套 vs 顶层） |
| `groups.ownerIds` | `groupSenderAllowFrom` | 功能相同，名称不同 |
| 无 | `dmPolicy` | **feishu-her 缺失** |
| 无 | `groupPolicy` + `groupAllowFrom` | **feishu-her 缺失** |
| 无 | `requireMention`（可配） | **feishu-her 硬编码 true** |

**建议**：不改现有字段名（避免 200 个容器的 config 和 CSV 全部改），只补充缺失的功能。`requireMention` 由 group-modes 文件动态控制（auto-reply 模式等同于 `requireMention=false`），不需要加 config 字段。

---

## 实现状态

| Phase | 内容 | 状态 | 验证 |
|-------|------|------|------|
| **Phase 1** | gateway.ts 加 `readGroupMode` + auto-reply 路径 | ✅ 已完成 | carher-101 验证通过 |
| **Phase 2** | `feishu-group-mode` skill（自然语言切换模式） | ✅ 已完成 | carher-101 验证通过 |
| **Phase 3** | 全量验证五种模式 | 🟡 进行中 | default/auto-reply/恢复 default 已通过，monitor/manager/disabled 待测 |

### 已验证场景（2026-03-20，carher-101 tester2）

| 测试 | 操作 | 结果 |
|------|------|------|
| 默认模式（无文件） | 群里不 @tester2 说话 | ✅ 只 archive 不回复 |
| 切换 auto-reply | @tester2 "改成自动回复" | ✅ her 写文件 + 回复确认 |
| auto-reply 生效 | 群里不 @ 直接说话 | ✅ tester2 自动回复"能收到！" |
| 切回默认 | "恢复默认" | ✅ her 删文件 + 回复确认 |
| 默认模式恢复 | 群里不 @ 说话 | ✅ 只 archive 不回复 |

### 关键 log 证据

```
15:18:49 deliver: "当前这个群是默认模式（default）——只有被 @ 时我才回复"
15:19:17 deliver: "✅ 已切换为自动回复模式"
15:19:19 auto-reply mode: owner ou_7ec6c... in oc_d37eb..., processing
15:19:31 deliver: "能收到！自动回复模式已生效"
15:19:48 deliver: "✅ 已恢复默认模式，现在需要 @ 我才会回复"
```

### 第二轮验证（2026-03-20，carher-101 tester2）

| 测试 | 操作 | 结果 |
|------|------|------|
| monitor 切换 | @tester2 "帮我盯着这个群" | ✅ cron job created，"✅ 监控模式已启动！每1分钟轮询" |
| monitor gateway 行为 | 群里多条消息不 @ | ✅ 全部 `archived only`（不触发 agent） |
| monitor 关闭 | "关闭监控" | ✅ cron job disabled，"✅ 群监控已关闭，恢复默认" |
| manager 切换 | "切换群管家模式" | ✅ "先检查有没有其他管家→没有→✅ 群管家模式已启动！" |
| manager cron 调整 | "改成每1分钟" | ✅ cron job updated × 2 |
| manager gateway 行为 | 群里多条消息不 @ | ✅ 全部 `archived only`（cron 处理） |

### Cron Payload v2 优化（2026-03-21，基于 tester2 对比实验）

实验对比了 skill 版 cron 和用户手动版 cron，结论：

| 维度 | Skill v1 | v2 增强版 |
|------|----------|----------|
| 扫描覆盖 | 单群 | 多群合并扫描 |
| 效率 | 多次轮询重复扫描（5次 × 45K = 224K tokens） | 一次到位（38K tokens） |
| 处理深度 | 监控只报告不处理 | **先处理再汇报**（用工具查文档/搜知识库） |
| 状态管理 | 计数器文件 + 模式文件（复杂） | deleteAfterRun（简洁） |
| 输出结构 | 文本摘要 | 结构化：📌需回复 → 📋需关注 → 🔧已执行 → 💬话题摘要 |

**已将 v2 改进写入**：
- `~/.openclaw/skills/feishu-group-monitor/references/poll-guide.md`
- `~/.openclaw/skills/feishu-group-manager/references/poll-guide.md`

### 已知问题

- [ ] **cron agent 无法读取群历史中的图片**：gateway 下载图片时用 UUID 命名（`82bfcbdc-...jpg`），但 cron agent 通过 `feishu_group_history` 拿到的是 `image_key`（`img_v3_...`）。image_key → 本地路径的映射在 cron 独立 session 中丢失。这是 cron 图片读取的独立 issue，不是 group-modes 的 bug。

### 待验证

- [ ] disabled 模式：完全不处理
- [ ] 非主人在 auto-reply 模式下不触发回复
- [ ] 多 her 同群不风暴
