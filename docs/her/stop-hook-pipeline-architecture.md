# Stop-Hook Pipeline 架构（Her 核心防睡框架）

**版本**: M2 · 2026-05-07
**状态**: ✅ **生产已部署** (carher-200) · 待推其他服务器
**定位**: Her 同 turn 防睡 + 闲聊不误报 · 规则全数据化 · 取代 v9.0 watchdog

## 状态表

| 项 | 状态 |
|---|---|
| 架构设计 | ✅ 定稿（本文档） |
| `stop-hook-pipeline.ts` 执行器 | ✅ 生产运行 |
| `stop-hook-rules.yaml` 规则文件 | ✅ 生产运行 · 2 条规则 |
| `patch-agent-loop.sh` | ✅ 生产容器已应用 · 幂等 · 有 backup |
| `smoke-test.mjs` | ✅ 38/38 绿 (host + 容器内) |
| carher-200 部署 | ✅ 2026-05-07 08:07 上线 |
| carher-13/198/199 部署 | ⏳ 待推 |
| 生产实测 | ✅ 6 轮 drain 行为全部符合设计 (见§生产实证) |

---

## 一句话总结

- pi-agent-core `agent-loop.js` 天然提供 `config.getFollowUpMessages?.()` hook（L125），模型"想停"时必被调用；返回非空 → loop 续命
- OpenClaw 0503 没有往 `AgentLoopConfig` 传这个字段
- 一行 sed 改 `/app/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`，让原 hook 先跑，空了再走 `globalThis.__openclaw_stopHookPipeline` fallback
- 插件挂一个 pipeline 到 globalThis；**所有规则住在 `stop-hook-rules.yaml`**，以数据形式定义 preconditions / fire_when / message

---

## 绝对铁律（违反即回滚）

1. **禁止 watchdog / wake / 事后唤醒**：所有续命发生在 loop 同一轮内，延迟 < 1 秒
2. **禁止 fallback**：pipeline drain 返回空 = loop 允许退出，不再弯弯绕绕补救
3. **禁止 bridge / probe / prototype mutation**：SDK 契约走 `globalThis.__openclaw_stopHookPipeline` 这一个约定
4. **禁止把规则写死在代码里**：规则 = 数据（YAML）。只有**执行器**在代码里（`createRuleHook` 工厂）
5. **禁止闲聊误报**：每条规则必须有 `preconditions` 筛掉闲聊/短消息/系统回环（HEARTBEAT_OK/NO_REPLY）

---

## 核心契约

### SDK 侧（不动）

`/app/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js` 主 loop 的 `getFollowUpMessages` 是**天然契约**。我们用 faux provider + `runAgentLoop` 验过 6/6 全绿，`docker/plugins/her-antitalker-poc/smoke-test.mjs` 每次部署前跑。

### OpenClaw 侧 patch（单点）

`agent-loop.js` L127 的一行：

```diff
- const followUpMessages = (await config.getFollowUpMessages?.()) || [];
+ const followUpMessages = await (async () => {
+   const __orig = config.getFollowUpMessages ? await config.getFollowUpMessages() : [];
+   if (__orig && __orig.length > 0) return __orig;
+   const __gp = globalThis.__openclaw_stopHookPipeline
+             || global.__openclaw_stopHookPipeline
+             || globalThis[Symbol.for('openclaw.stopHookPipeline.v1')];
+   return (__gp ? (await __gp()) || [] : []);
+ })();
```

**重要**：不是 `??` 短路 — 原 hook **先跑**，只有它返回**空**，才走我们的 pipeline。这保留了 SDK 默认行为（`Agent.followUpQueue.drain()`），同时让 OpenClaw 构造的 loop 自动接入我们的规则。

由 `docker/plugins/her-antitalker-poc/patch-agent-loop.sh` 在 entrypoint 自动 apply（幂等、安全、可回滚）。

### 插件侧（框架 + 数据）

| 层 | 位置 | 职责 | 改动代价 |
|---|---|---|---|
| **执行器** | `stop-hook-pipeline.ts` | pipeline + rule engine (`createRuleHook`) + YAML loader + mtime watcher | 改动需 PR + image rebuild |
| **规则** | `stop-hook-rules.yaml` | 所有规则数据 | 改 YAML → 2 秒热加载，无需重启 |

---

## 规则 YAML Schema（source of truth）

路径：
- 容器内：`/data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml`
- host：`/home/cltx/.openclaw/workspace/.antitalker/stop-hook-rules.yaml`

热加载：mtime polling（2 秒）。改文件保存后自动 `pipeline.unregisterAll() + installRules()`。

```yaml
enabled: true                 # 全局 kill switch
max_continuation_turns: 3     # pipeline 级死循环上限（单 session）

rules:
  - id: <unique-id>
    enabled: true
    priority: 20              # 高优先级先跑；任一 hook fire 即终止

    # ── Preconditions: ALL 必须通过,否则此 rule 直接跳过（不进 fire_when）──
    preconditions:
      min_user_message_length: 10               # 用户消息 < 10 字 → 跳过（闲聊过滤）
      min_assistant_text_length: 20             # Her 回复 < 20 字 → 跳过
      user_text_matches_any:                    # 用户消息必须 match 至少一条 regex
        - '帮我|检查|修|写|查'
      assistant_text_skip_if_matches_any:       # Her 回复 match 任一就跳过
        - '^HEARTBEAT_OK'
        - '^NO_REPLY'

    # ── Fire conditions: ANY 命中即 fire ──
    fire_when:
      no_tool_call: true                        # 本 turn 零 tool call
      no_substantial_tool: true                 # 本 turn 没调白名单 tool（优先级高于 no_tool_call）
      text_matches_any:                         # 回复 match 任一 regex
        - '我(?:来|去|先|现在|马上|立刻)'
        - "\\bI'?ll\\b"

    substantial_tools:                          # 白名单（仅 no_substantial_tool=true 时用）
      - exec
      - read
      - write
      - edit

    max_retries: 1                              # 本 rule 单 session 连续续命上限
    message: "⚠️ 规则说明 / 给 LLM 的提示..."
```

### 扩展规则的工作流

添加新规则 / 修关键词 / 调 threshold / 扩白名单：

1. 改 `/data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml`
2. 等 2 秒
3. 看 `docker logs carher-200 --tail 20` 里 `stop-hook rules loaded · installed=[...]` 已更新
4. 发消息验证

**不改代码、不重启、不 rebuild**。

---

## 当前部署的规则

### 1. `no-toolcall-guard`（priority 20，主力）

用户布置任务，Her 不调任何实质性 tool 就想停 → 续命。

- 闲聊过滤：`min_user_message_length: 10`（"hi"/"嗨"/"?" 等短消息直接跳过）
- 系统回环过滤：`assistant_text_skip_if_matches_any: [^HEARTBEAT_OK, ^NO_REPLY]`
- 白名单：`exec / read / write / edit / feishu_doc / feishu_sheet / feishu_bitable`
- `message_send / cron / sessions_yield / memory_search / wait` 不算实质 tool

### 2. `prose-only-ending`（priority 10，兜底）

Her 回复里有承诺词（"我来/让我/I'll/Let me"）但一个 tool 都没调 → 续命。

比 no-toolcall-guard 更严格：除了"没 tool"，还要求文本出现承诺语。

---

## Dead-loop 保护

两层：

1. **rule 级** `max_retries`：单 rule 对单 session 连续 fire 上限
2. **pipeline 级** `max_continuation_turns`（默认 3）：所有 rule 加总的硬上限

`resetContinuationCount(sessionKey)` 在新 user 消息到达时自动触发（由 `before_message_write` user-capture hook 调）。

---

## 为什么不能用 watchdog fallback（血的教训）

v9.0 曾经走 BMW 同步 mark + 5s watchdog + heartbeat wake。对比：

| 维度 | watchdog | stop-hook-pipeline |
|---|---|---|
| 触发点 | assistant 消息已写完（turn 结束） | turn 即将结束那一刻 |
| 延迟 | ~30min（heartbeat 间隔） | < 1 秒（同 loop 内 continue） |
| 中断当前 turn | 不能，只能起新 turn | 原 loop 直接续 |
| 语义 | 事后罚款 | 同轮拦下 |
| 死循环风险 | 极高 | 有 counter |

**M1 之后不再有 watchdog fallback**。

---

## Deployment

### 镜像构建时 vs 启动时

- **推荐**：`Dockerfile.carher.v2` 最后一条 `RUN` 跑 patch（持久到 image layer）
- **必需**：`scripts/carher-entrypoint.sh` 启动前再跑一次（幂等，防止 npm install / SDK 升级覆盖后 patch 丢失）

### SDK 升级风险

- `npm install @mariozechner/pi-agent-core@new` 会覆盖 `agent-loop.js` → patch 丢
- 对策：entrypoint 无条件跑 patch-agent-loop.sh，幂等保障
- 警戒：SDK 改了 L125 附近的表达式 → sed pattern 失配 → patch 跳过（不破坏文件）→ Her 回退到"装死"行为（可接受退化，不造成崩溃）

### CI 检查

- `smoke-test.mjs`：38 case 全绿 = 部署可过
  - patch-agent-loop.sh（幂等/skip/backup）
  - StopHookPipeline 框架（register/evaluate/counter/priority）
  - createRuleHook 规则引擎（preconditions/fire_when/regex/disabled）
  - loadStopHookRules + installRules（YAML → hooks）
  - watchRulesFile（mtime 热加载）
  - E2E（真实 pi-agent-core + faux + globalThis drain）

---

## 生产实证

### M1 契约验证（2026-05-07）

在 carher-200 0503 生产容器内 `runAgentLoop` + faux provider：
```
✅ getFollowUpMessages 被 loop 主动调 3 次
✅ 非空返回续 loop, faux callCount=3
✅ 返回空后 loop 正常退出
```

### M1 in-place patch 生产生效（2026-05-07）

```
07:41:43  pipeline drain CALLED seq=1
07:41:43  pipeline drain seq=1 → 1 msgs      (续命)
07:41:47  Her 被迫再调 exec
07:41:49  pipeline drain seq=2 → 0 msgs      (放行)
```

### M2 闲聊误报修复（2026-05-07 08:08）

```
"hi" → preconditions 阻止 no-toolcall-guard（min_user_message_length=10）→ drain 0 msgs
真任务 "帮我修 bug" + 无 tool → drain 1 msg → 续命
真任务 + exec → no_substantial_tool=false → drain 0 msgs
```

### M2 六轮生产 drain 行为表（2026-05-07 08:08–08:12，carher-200 真实飞书 p2p 会话）

| seq | tools | userLen | asstLen | 结果 | 判定 |
|---|---|---|---|---|---|
| 1 | `[]` | 20 | 5 | 1 msg · 续命 | 真任务无 tool → no-toolcall-guard fire |
| 2 | `[message]` | 266 | 8 | 0 msg · 放行 | Her 回 `NO_REPLY` → `^NO_REPLY` precondition skip |
| 3 | `[exec]` | 4 | 28 | 0 msg · 放行 | 闲聊短消息 → `min_user_message_length: 10` 挡住 |
| 4 | `[message]` | 2 | 8 | 0 msg · 放行 | 更短闲聊 + NO_REPLY 双挡 |
| 5 | `[]` | 10 | 63 | 1 msg · 续命 | 飞书纯文字回复不会送达用户 → 正确拦截 |
| 6 | `[message]` | 266 | 8 | 0 msg · 放行 | Her 改走 message send 后 NO_REPLY 收尾 |

**结论**：6/6 次 drain 全部行为正确。零 hack。规则 = 数据。

### 关于 seq=5 的 "拦截" 澄清

Her 回了 63 字纯文字但没走 `message send` tool → 在飞书 channel 里消息不会真正送达用户 → pipeline 正确识别为"还没完成任务"强制续命 → Her 第二轮用 `message send` 发出 → 用户收到回复。

这**不是误报**：飞书 session 的合法终态是"调过 message send tool"，不是"模型内部生成了文字"。规则设计吻合 channel 语义。

---

## 不得做的事

- ❌ 把新规则加到 `stop-hook-pipeline.ts` 代码里（应该加到 YAML）
- ❌ 把正则 `/我来/` 之类硬编码到 .ts 里（规则 = 数据）
- ❌ 给 no-toolcall-guard 加 fallback wake / markPendingViolation 分支
- ❌ 用 `agent-followup-bridge.ts` 之类 dist probe（早已删）
- ❌ 不加 `preconditions` 就直接 fire → 闲聊必误报
