# Antitalker 架构

**更新**: 2026-05-07
**定位**: Her 同 turn 防睡。Plugin 只做事件桥接,所有拦截逻辑在 stop-hook-pipeline。
**完整机制**: [stop-hook-pipeline-architecture.md](./stop-hook-pipeline-architecture.md)

## 一句话

Plugin 订阅 `before_message_write` hook,把每条 assistant/user message 作为事件喂给 stop-hook-pipeline;pipeline 按 `stop-hook-rules.yaml` 的规则在同一个 agent loop turn 内决定是否续命(inject follow-up user message 让 LLM 继续干),延迟 < 1 秒。Plugin 自身是纯事件管道,无业务逻辑。

## Hook 清单

Plugin 注册一个 hook:

| Hook | 行为 |
|---|---|
| `before_message_write` | assistant message → `pipeline.observeAssistantEvent({sessionKey, content})`;user message → `pipeline.markTurnBoundary(sk)` + `pipeline.setLastUserText(sk, txt)` |

Plugin 同时把 `pipeline.drain()` 挂到 `globalThis.__openclaw_stopHookPipeline`,供 patched pi-agent-core `agent-loop.js` 在每个 turn 快要结束时调用。

## 决策流

```
LLM turn 进行中:
  assistant message → BMW → pipeline.observeAssistantEvent
                             (text / tool use 全累积到 per-turn state)
  user message → BMW → pipeline.markTurnBoundary (重置累积)
                    → pipeline.setLastUserText

LLM 尝试退出 turn:
  pi-agent-core agent-loop 调 getFollowUpMessages
  → globalThis.__openclaw_stopHookPipeline()
  → pipeline.drain() 按 priority 跑所有规则
  → 命中 → 返回 [{role:"user", content: rule.message}]
           → loop 继续, LLM 拿到这条 injected message 重新回复
  → 不命中 → 返回 []
           → loop 正常结束
```

## 规则来源 · stop-hook-rules.yaml

Plugin 把 `/data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml` 的规则通过 `installRules(pipeline, file)` 注册到 pipeline。支持 mtime polling (2s) 热加载,改规则无需重启容器。

完整 schema 见 [stop-hook-pipeline-architecture.md](./stop-hook-pipeline-architecture.md)。当前 2 条规则:

| 规则 id | priority | 触发条件 | 动作 |
|---|---|---|---|
| `prose-only-ending` | 30 | 最后一条 assistant text 匹配承诺词 regex(`我来/让我/I'll/Let me/...`) | inject 续命 message |
| `no-toolcall-guard` | 20 | 用户消息 ≥ 10 字(precondition) AND 本 turn 没调任何 substantial tool | inject 续命 message |

Substantial tools 白名单、regex 列表、max_retries、message 文本全部在 yaml 里,不在代码里。

## 版本/部署矩阵

| 组件 | 文件 | 部署方式 |
|---|---|---|
| Plugin 本体 | `docker/plugins/her-antitalker-poc/` | `Dockerfile.carher.v2` COPY 进 image |
| Stop-hook 引擎 | `stop-hook-pipeline.ts` | 同上 |
| 规则数据 | `stop-hook-rules.yaml` | 同上 + 容器启动时 seed 到 `/data/` (entrypoint 逻辑),热加载 |
| agent-loop.js patch | `patch-agent-loop.sh` | 容器启动时 entrypoint 调用 |
| Plugin 运行时配置 | docker.json5 的 `plugins.entries.her-antitalker-poc.enabled=true` | bind mount |

## 测试

`docker/plugins/her-antitalker-poc/smoke-test.mjs` 是本地 off-fleet 测试入口。覆盖:
- pipeline 注册/注销/优先级/counter
- createRuleHook 的 preconditions/fire_when 所有组合
- YAML loader + 热加载
- 实际启动 patched agent-loop.js + faux provider,验证续命链路

部署前必须全绿。

## Plugin 代码边界

`docker/plugins/her-antitalker-poc/index.ts` ≤ 200 行,内容只有:
- Plugin metadata (id/name/version/description)
- BMW hook 注册,转发事件到 pipeline
- stop-hook-rules.yaml 加载 + mtime watcher
- `pipeline.drain()` 绑定到 `globalThis.__openclaw_stopHookPipeline`
- Logger 适配

业务逻辑零。新增/修改规则 → 改 yaml,不改代码。
