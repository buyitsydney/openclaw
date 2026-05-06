# Stop-Hook Pipeline 架构（Her 核心防睡机制）

**版本**: M1 · 2026-05-07 · `carher-core` 镜像 ≥ 2026.5.7-dev-0507-stop-hook-v1
**定位**: Her 同 turn 防睡的根基，取代 v9.0 watchdog fallback 路径

---

## 一句话总结

- pi-agent-core `agent-loop.js` 天然提供 `config.getFollowUpMessages?.()` hook（L125）—— 模型"想停"时必被调用；返回非空 → loop 续命
- OpenClaw 0503 没有往 `AgentLoopConfig` 传这个字段
- 我们**一行 sed 改 `/app/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js` 文件**，让所有 config 自动走 `globalThis.__openclaw_stopHookPipeline` fallback
- 插件只管往 pipeline 注册 hook，pipeline drain 即可续命

---

## 绝对铁律（违反即回滚）

1. **禁止 watchdog**。本模块内不得出现任何轮询、setInterval、markPendingViolation、延后 wake 的 fallback 路径。续命必须发生在 loop 同一轮内，延迟 < 1 秒。
2. **禁止 fallback**。pipeline drain 返回空 = loop 允许退出。不许再弯弯绕绕补救（飞书卡片、兜底 wake、heartbeat 回灌）。用户行为由 pipeline 表达，不由残留路径表达。
3. **禁止 bridge/probe**。不写"运行时扫 dist 找模块"之类的 hack。SDK 契约走 `globalThis.__openclaw_stopHookPipeline` 这一个约定，一进一出。
4. **禁止 prototype mutation**。不 patch Agent.prototype、AgentSession.prototype 或 SDK class 上任何成员。

---

## 核心契约

### pi-agent-core 这一头（SDK 端 · 不动）

`/app/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js` 的主 loop：

```js
while (true) {
  // ...inner loop: 处理 tool calls, 每个 turn 结束收 steering messages...

  // Agent would stop here. Check for follow-up messages.
  const followUpMessages = (await config.getFollowUpMessages?.()) || [];
  if (followUpMessages.length > 0) {
    pendingMessages = followUpMessages;
    continue;  // 续命: 把消息塞进 context, 回 inner loop
  }
  break;  // queue 空 -> 允许退出
}
```

这个 hook **天然在 SDK 里，不需要我们添加**。我们用 faux provider + `runAgentLoop` 跑过 6/6 全绿的契约测试：

```text
✅ H1: getFollowUpMessages 被 loop 主动调用: 实际 3 次
✅ H2: 非空返回会续 loop, 模型被多次调用: faux callCount=3
✅ H3: getFollowUpMessages 调用总数 = 轮次数: 3
✅ H4: 返回空后 loop 正常退出
✅ 最终消息里出现 followup 文本: followup-1 inject 成功
✅ turn_end 发出 3 次: 3
```

契约测试脚本路径：`docker/plugins/her-antitalker-poc/verify-followup-hook.mjs`

### OpenClaw 这一头（今天的 0503 状态）

`/app/dist/selection-*.js` 构造 `queueHandle` 时：

```js
queueHandle = {
  queueMessage: async (text, options) => {
    if (options?.steeringMode) activeSession.agent.steeringMode = options.steeringMode;
    await activeSession.steer(text);     // 只接 steer, 不接 followUp
  },
  isStreaming, isCompacting, cancel, abort,
};
```

`AgentLoopConfig` 构造时**没传 `getFollowUpMessages`**（pi-agent-core Agent 默认会传 `() => this.followUpQueue.drain()`，但 `followUpQueue` 永远空，因为没人调 `agent.followUp(text)`）。

### 我们的 Patch（运行时端）

改 `/app/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js` **一行**：

```diff
-const followUpMessages = (await config.getFollowUpMessages?.()) || [];
+const followUpMessages = (await (config.getFollowUpMessages ?? globalThis.__openclaw_stopHookPipeline)?.()) || [];
```

**效果**：
- 原来有 `getFollowUpMessages` 的 config（Agent 默认的 `followUpQueue.drain`）不受影响
- 原来没有 `getFollowUpMessages` 的 config（OpenClaw 构造的）会自动走 `globalThis.__openclaw_stopHookPipeline`
- 两者不冲突

---

## 运行时对象契约

### `globalThis.__openclaw_stopHookPipeline`

类型：`() => Promise<Array<{ role: "user"; content: string | ContentBlock[] }>>`

**非常严格**：

- 返回**空数组** = 允许 loop 正常退出
- 返回**非空数组** = loop 续命，消息被 inject 到 user role
- 绝对不允许抛错（抛错会让 patched agent-loop 报错，影响 SDK 稳定性）；内部捕获
- 不能阻塞超过 2 秒（SDK 没 timeout 保护，会卡死 loop）
- 不能依赖任何"在 loop 外触发的异步投递" — 所有决策在 drain 函数同步计算完毕

### 注册时机

插件 `onStart` 时挂上 `globalThis.__openclaw_stopHookPipeline = () => pipeline.drain()`。挂一次，存活整个 node 进程。

---

## Pipeline 内部结构

```
docker/plugins/her-antitalker-poc/stop-hook-pipeline.ts
  └─ class StopHookPipeline
        ├─ register(name, fn, priority)   // 插件挂钩
        ├─ evaluate(ctx) / drain()        // 按优先级跑所有 hook, 聚合非空返回
        └─ continuationCount              // 防死循环: 同一 session 连续 N 轮强制续命后放行
```

### 现已注册的 hook

| name | priority | 检测 | 返回 |
|---|---|---|---|
| `no-toolcall-guard` | 20 | 本轮 `toolsBySessionKey[sk]` 无 substantial tool（非 message/cron/sessions_yield） | YAML 配置的续命消息 |
| `antitalker:prose-only` | 10 | 文本含承诺词（"我来"/"let me"）且无 tool call | 固定续命模板 |

### Dead-loop 保护

`continuationCount` 达到 `maxContinuationTurns`（默认 3） → 本 session 放行一次，重置。保证恶性情况下 loop 最多被硬续命 3 轮。

---

## 为什么不能用 watchdog fallback（血的教训）

v9.0 曾经走 BMW 同步 mark + 5s watchdog + heartbeat wake 的路径。问题：

| 维度 | watchdog 路径 | pipeline 路径 |
|---|---|---|
| 触发点 | assistant 消息已经写完（turn 已结束） | turn 即将结束那一刻 |
| 延迟 | ~30 min（heartbeat 间隔） | < 1 秒（同 loop 内 continue） |
| 中断当前消息 | 不能，只能起新 turn | 原 loop 直接续 |
| 飞书卡片 | 必须配（作为通知） | 不需要 |
| 死循环风险 | 极高（wake → 新 turn → 再 BMW → 再 watchdog） | 有 counter 保护 |
| 架构冗余 | 违规检测 + audit 群 + 红卡 + heartbeat 的一整套 | 单向 pipeline.drain |

watchdog 是"事后罚款"，pipeline 是"同轮拦下"。**同一任务同时用两套 = 回到 watchdog 的语义**，因此 M1 之后**不再有 watchdog fallback**。

---

## Deployment（生产落地）

### Patch 脚本

`docker/plugins/her-antitalker-poc/patch-agent-loop.sh`：

```bash
#!/bin/bash
# In-place patch pi-agent-core agent-loop.js: add globalThis fallback for getFollowUpMessages
set -euo pipefail
TARGET="/app/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js"
MARKER="globalThis.__openclaw_stopHookPipeline"
[[ ! -f "$TARGET" ]] && { echo "SKIP: $TARGET not found"; exit 0; }
grep -q "$MARKER" "$TARGET" && { echo "SKIP: already patched"; exit 0; }
cp "$TARGET" "${TARGET}.orig.$(date +%s)"
sed -i 's|const followUpMessages = (await config\.getFollowUpMessages?\.()) || \[\];|const followUpMessages = (await (config.getFollowUpMessages ?? globalThis.__openclaw_stopHookPipeline)?.()) || [];|' "$TARGET"
grep -q "$MARKER" "$TARGET" && echo "PATCHED $TARGET" || { echo "FAILED"; exit 1; }
```

特性：
- **幂等**：已 patched 的文件 skip
- **可回滚**：原文件保留 `.orig.<timestamp>` 备份
- **版本无关**：pattern 匹配失败就失败，不会损坏文件

### 触发时机

1. 镜像构建时（Dockerfile 最后一条 RUN）— 推荐
2. 容器启动时（entrypoint 脚本开头）— 次选，允许 npm install 后也能恢复

### 版本升级时的风险

- npm install / pi-agent-core 升级会覆盖 `agent-loop.js` → patch 丢失
- **对策**：在启动 entrypoint 无条件跑 patch-agent-loop.sh，幂等保障每次启动后 patch 都存在
- **警戒**：SDK 升级若改了 L125 附近的 `const followUpMessages = ...` 表达式，sed pattern 会失配 → patch 不生效 → sent 回旧行为（Her 会重新装死）。这是可接受退化（不造成崩溃），但需要 CI check 兜底

### CI 检查

- 单元测试：`stop-hook-pipeline.integration.test.ts` — 拷贝生产 agent-loop.js 到 /tmp，应用 patch，验证 `globalThis.__openclaw_stopHookPipeline` 被调用
- 镜像测试：构建后跑 `node -e "..."` 验证 `globalThis` 注册路径生效

---

## 验证实录（2026-05-07）

### 契约验证（SDK 端）

脚本：`/tmp/verify-test.mjs` · 在 carher-200 0503 生产容器内跑：
```
✅ H1-H6 全绿 · exit 0
faux.callCount=3 · turnEnds=3
```

### In-place patch 验证（PoC）

脚本：`/tmp/tg-poc-clean.mjs` · 在 carher-200 0503 生产容器内跑：

```
A. 原版 runAgentLoop, 不传 hook:   faux.callCount=1  pipelineCalls=0 ✅ 一轮停
B. Patched agent-loop.js:          faux.callCount=3  pipelineCalls=3 ✅ 续命 2 轮
```

增量 = 2 轮续命，**global fallback 100% 生效**。

---

## 不得做的事（任务约束）

- ❌ 不用 `agent-followup-bridge.ts` 那种 probe dist 的 hack（已删）
- ❌ 不用 `markPendingViolation` 作为 guard 的 fallback（已删）
- ❌ 不用 prototype mutation 去 patch Agent / AgentSession
- ❌ 不写任何 "bridge 不 active 就走 watchdog" 的分支
- ❌ 不在 loop 内访问生产 node_modules 外的任何异步队列（所有决策在 drain 内同步计算）
