# Antitalker 行为监控插件架构

> **2026-05-07 M2 架构升级**：同 turn 防睡 + 闲聊不误报能力已迁移到独立的
> **Stop-Hook Pipeline** rule engine。违规续命逻辑不再走 watchdog/wake，而是走
> pi-agent-core `getFollowUpMessages` 同 turn 续命。详见
> [stop-hook-pipeline-architecture.md](./stop-hook-pipeline-architecture.md)。
>
> 本文档下面的 v8.5 watchdog 章节描述的是历史设计，**已被 M2 取代**。保留
> 仅为追溯 v9.0 → M2 迁移动机。

## 当前版本

- **插件版本**: v8.5 + M2 stop-hook-pipeline · carher-200 已部署
- **规则配置**:
  - 违规检测规则（legacy，保留）: `/data/.openclaw/workspace/.antitalker/rules.yaml`
  - **Stop-hook 规则（新,主力）**: `/data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml`
- **部署方式**: Dockerfile COPY 内置 (`/app/docker/plugins/her-antitalker-poc/`)
- **SKILL 文件**: `/home/cltx/.openclaw/skills/guangshuobulian/SKILL.md` (per-container)
- **状态**: carher-200 M2 已上线 (2026-05-07)，13/198/199 待推

## Hook 架构

antitalker 注册两个 OpenClaw plugin hooks：

| Hook | 触发时机 | ctx 字段 | 职责 |
|------|----------|----------|------|
| `before_message_write` (BMW) | assistant 消息写入前 | `agentId`, `sessionKey` | 写 convToSession 映射、记录 tools |
| `message_sending` (MS) | 消息通过 channel deliver 外发时 | `channelId`, `accountId`, `conversationId`, `sessionKey`(首条), `messageId`, `senderId` | 检测违规、拦截、发卡、wake |

### 关键设计边界

**`message_sending` 只在 channel deliver pipeline 触发。** 以下路径不经过 antitalker：

| Path | 经过 hook? | 说明 |
|------|-----------|------|
| 主 session → 群/私聊消息 | ✅ | 正常外发，必须监控 |
| isolated CLI (no deliver) | ❌ | 消息未发出，不需监控 |
| subagent run mode | ❌ | 内部执行，不面向用户 |
| A2A peer harness | ❌ | agent 间内部通信 |

这是 by design：antitalker 职责是拦截「发给用户的外发消息」，未进 channel deliver 的消息不到用户眼前。

## 核心数据流：多群 Wake 路由 (v8.5)

```
BMW fires (bot 处理群消息)
  │ ctx.sessionKey = "agent:main:feishu:group:oc_24f93..."
  │
  ├─ extract oc_24f93... from sessionKey
  ├─ state.convToSession.set("oc_24f93...", fullSessionKey)
  └─ state.convToSession.set("feishu:oc_24f93...", fullSessionKey)

MS fires (消息外发到同一群)
  │ ctx.conversationId = "oc_24f93..."
  │ ctx.sessionKey = "" (非首条)
  │
  ├─ lookup: state.convToSession.get("oc_24f93...")
  ├─ → 得到正确的 sessionKey
  └─ wakeHer 路由到正确 session
```

### sessionKey 格式

```
agent:main:feishu:group:oc_24f93dcf5e05d025b6cf12a204b1bd8f
└─agent─┘└main┘└feishu┘└group┘└────── conversationId ──────┘
```

## 规则清单

| ID | 规则 | 级别 | 动作 |
|----|------|------|------|
| M1 | ETA 空头承诺 | enforce | 拦截 + 红卡 + wake |
| M2 | 推拍板给主人 | shadow | 仅记录 (未来可能升 enforce) |
| M3 | 承诺即睡 | shadow | 仅记录 |
| prose_only_ending | 纯文字结尾无 tool | enforce | 拦截 + 红卡 + wake |

### 豁免条件

- 消息以 `NO_REPLY` 或 `HEARTBEAT_OK` 开头
- 同 turn 有 substantial tool call (`exec`/`read`/`write`/`edit`/`feishu_doc`/`feishu_sheet`/`feishu_bitable`/`feishu_task_*`/`browser`/`web_fetch`/`feishu_group_history`/`memory_get`)
- Self-report 豁免：wake 后首条纯文字汇报不触发 prose_only_ending 二次拦截

## v8.5 修复清单

1. **BMW→MS convToSession bridge**: BMW 从 sessionKey 提取 `oc_xxx`，写入 convToSession map，MS 通过 conversationId 查到正确 session
2. **stripQuotedContent 扩展**: 增加 markdown table rows、blockquotes、list items 的 strip
3. **prose_only_ending self_report_skip**: wake 后首条纯文字汇报不二次拦截
4. **MS debug logging**: 前 10 次 MS 调用记录完整 ctx 用于诊断

## 相关文件

- 插件代码: `plugins-poc/her-antitalker-poc/index.ts`
- SKILL (Her 运行时): server `/home/cltx/.openclaw/skills/guangshuobulian/SKILL.md`
- 规则 YAML: container `/data/.openclaw/workspace/.antitalker/rules.yaml`
- 单元测试: `/tmp/test-antitalker-wake-routing.ts` (7/7 pass)
