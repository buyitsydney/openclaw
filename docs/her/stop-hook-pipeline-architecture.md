# Stop-Hook Pipeline 架构

**版本**: 2026-05-07
**定位**: Her 同 turn 防睡框架 — Complex Event Processing 规则引擎,规则全数据化。

## 一句话

pi-agent-core `agent-loop.js` 在每个 turn 快要结束时调 `config.getFollowUpMessages?.()`;如果返回非空 user messages 就 inject 进 context 让 loop continue。Stop-Hook Pipeline 把这条 hook 接到一个 CEP 引擎,引擎按 `stop-hook-rules.yaml` 的规则数据评估要不要续命。整条路径在同一个 agent loop turn 内,延迟 < 1 秒。

## 架构:Complex Event Processing

业界标准 CEP 模式,对标 Drools / Esper / OPA / Flink CEP / OpenTelemetry SDK / LangChain CallbackManager。

三个原则:
1. **应用 emit raw events**(`pipeline.observeAssistantEvent`),不做判断
2. **引擎持有状态**(pipeline 内部 `turnState` Map),外部不碰累积器
3. **规则是数据**(YAML 声明 `observable_sources` + `preconditions` + `fire_when`)

扩展规则 = 加 YAML 条目,不改 `.ts`。

## Pipeline 事件 API

| 方法 | 时机 | 作用 |
|---|---|---|
| `observeAssistantEvent({sessionKey, content})` | BMW hook | 消化 raw content blocks,抽 text + tool names,按 `observable_sources` 从 tool args 抽文本 |
| `markTurnBoundary(sessionKey)` | user message 到达 | 清 per-turn 累积器,bump turnIndex,reset continuation counter |
| `setLastUserText(sessionKey, text)` | user message 到达 | 供 rule preconditions 使用 |
| `pickActiveSessionKey()` | drain 时 | pipeline 自选最近活动 session |
| `buildContext(sessionKey)` | drain 时 | 组装 `StopHookContext` 传给 rules |
| `drain()` | agent-loop `getFollowUpMessages` 被调时 | 跑所有 rules,返回 follow-up messages |

## 核心契约

### pi-agent-core 端 (SDK 不改)

`/app/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js` 主 loop 的 `getFollowUpMessages?.()` 就是契约本身。用 faux provider + `runAgentLoop` 在 `smoke-test.mjs` 里验证。

### agent-loop.js 单点 patch

在 agent-loop.js 原有 `const followUpMessages = (await config.getFollowUpMessages?.()) || []` 这一行改成 wrap 版本:先跑原 hook,空的时候才 fallback 到 `globalThis.__openclaw_stopHookPipeline`。

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

由 `docker/plugins/her-antitalker-poc/patch-agent-loop.sh` 在 entrypoint 幂等 apply(有 backup,安全可回滚)。

### 插件端分层

| 层 | 位置 | 职责 | 改动代价 |
|---|---|---|---|
| 执行器 | `stop-hook-pipeline.ts` | pipeline + `createRuleHook` + YAML loader + mtime watcher | PR + image rebuild |
| 规则 | `stop-hook-rules.yaml` | 所有规则数据 | 改 YAML → 2 秒热加载,无需重启 |

## 规则 YAML Schema

路径:
- 容器内: `/data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml`
- host: `/home/cltx/.openclaw/workspace/.antitalker/stop-hook-rules.yaml`

热加载: mtime polling 2 秒。修改保存后自动 `pipeline.unregisterAll() + installRules()`。

```yaml
enabled: true                 # 全局 kill switch
max_continuation_turns: 3     # pipeline 级死循环上限(单 session)

# observable_sources:声明哪些 tool args 算 "user-visible text"
# pipeline 自动从这些 tool 的 args 抽文本累积到 lastAssistantText
observable_sources:
  outbound_message_tools: [message_send, feishu_send, feishu_send_markdown]
  outbound_message_text_fields: [text, content, body]

rules:
  - id: <unique-id>
    enabled: true
    priority: 20              # 高优先级先跑;任一 hook fire 即终止

    # Preconditions: ALL 必须通过,否则此 rule 直接跳过(不进 fire_when)
    preconditions:
      min_user_message_length: 10               # 用户消息 < 10 字 → 跳过
      min_assistant_text_length: 20             # 回复 < 20 字 → 跳过
      user_text_matches_any:                    # 用户消息必须 match 至少一条 regex
        - '帮我|检查|修|写|查'
      assistant_text_skip_if_matches_any:       # 回复 match 任一就跳过
        - '^HEARTBEAT_OK'
        - '^NO_REPLY'

    # Fire conditions: ANY 命中即 fire
    fire_when:
      no_tool_call: true                        # 本 turn 零 tool call
      no_substantial_tool: true                 # 本 turn 没调白名单 tool
      text_matches_any:
        - '我(?:来|去|先|现在|马上|立刻)'
        - "\\bI'?ll\\b"

    substantial_tools:                          # 仅 no_substantial_tool=true 时用
      - exec
      - read
      - write
      - edit

    max_retries: 1                              # 本 rule 单 session 连续续命上限
    message: "⚠️ 规则说明 / 给 LLM 的提示..."
```

### 扩展规则的工作流

添加新规则 / 修关键词 / 调 threshold / 扩白名单:
1. 改 `/data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml`
2. 等 2 秒
3. `docker logs <container> --tail 20` 看到 `stop-hook rules loaded · installed=[...]` 已更新
4. 发消息验证

不改代码、不重启、不 rebuild。

## 当前规则

### prose-only-ending (priority 30)

Her 回复包含承诺词("我来/让我/I'll/Let me")但没调 substantial tool 就想停 → 续命。

关键配置:
- `text_matches_any`: 承诺词 regex 列表
- `preconditions.min_user_message_length: 10` — 闲聊过滤
- `preconditions.assistant_text_skip_if_matches_any`: `[^HEARTBEAT_OK, ^NO_REPLY]` — 系统回环过滤

### no-toolcall-guard (priority 20)

用户布置任务,Her 不调任何实质性 tool 就想停 → 续命。

关键配置:
- `fire_when.no_substantial_tool: true`
- `substantial_tools`: `[exec, read, write, edit, feishu_doc, feishu_sheet, feishu_bitable]`
- `preconditions.min_user_message_length: 10` — 闲聊过滤

## Dead-loop 保护

两层:
1. **Rule 级** `max_retries`:单 rule 对单 session 连续 fire 上限
2. **Pipeline 级** `max_continuation_turns`(默认 3):所有 rule 加总的硬上限

`resetContinuationCount(sessionKey)` 在新 user 消息到达时由 `markTurnBoundary` 自动触发。

## 部署

### 镜像

- `Dockerfile.carher.v2` COPY plugin 目录进 image
- `scripts/carher-entrypoint.sh` 启动时 seed `stop-hook-rules.yaml` 到 `/data/`(如果不存在),然后跑 `patch-agent-loop.sh`(幂等)

### SDK 升级兼容

- `npm install pi-agent-core@new` 会覆盖 agent-loop.js → patch 丢 → entrypoint 下次启动重新 apply(幂等保障)
- SDK 改了 hook 位置表达式 → sed 失配 → patch 跳过(不破坏文件)→ pipeline 不生效但不崩

### 测试

`docker/plugins/her-antitalker-poc/smoke-test.mjs` 是部署 gate。覆盖:
- `patch-agent-loop.sh` 幂等 / skip / backup
- `StopHookPipeline` 框架(register/evaluate/counter/priority)
- `createRuleHook` 规则引擎(preconditions/fire_when/regex/disabled)
- `loadStopHookRules` + `installRules`(YAML → hooks)
- `watchRulesFile` 热加载
- E2E: 真实 pi-agent-core + faux provider + globalThis drain

## 约束

- 新规则必须加到 YAML,不能硬编码到 `stop-hook-pipeline.ts`
- Regex 必须数据化,不能在 `.ts` 里写 `new RegExp(...)`
- 每条规则必须声明 `preconditions`(至少一条过滤闲聊/系统回环)
- Pipeline drain 不能调网络 / 不能 await 超过几十 ms,所有判定基于已累积的 state
