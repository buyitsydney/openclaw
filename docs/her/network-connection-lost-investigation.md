# "Network connection lost" 全量调研报告

> 调研时间: 2026-02-27  
> 数据范围: S1/S2/S3 全部 17 个 Docker 容器, 所有持久化 session 文件  
> 调研方法: 遍历 `/data/.openclaw/agents/main/sessions/*.jsonl` 搜索 `Network connection lost`

---

## 一、统计摘要

| 指标 | 数值 |
|------|------|
| 独立 API 错误总数 | **58 次** |
| 受影响用户数 | **7 / 17** (41%) |
| 受影响 session 数 | **11 个** |
| 时间跨度 | 2026-02-25 ~ 2026-02-27 (3 天) |
| 未受影响容器 | carher-1, 4, 5, 7, 8, 12, 14, 15, 16, 17 (10 个) |

**按容器分布:**

| 容器 | 用户 | 服务器 | 错误次数 | 占比 |
|------|------|--------|----------|------|
| carher-9 | 洪源(车联) | S2 | 25 | 43% |
| carher-3 | 洪源 | S1 | 10 | 17% |
| carher-11 | 商文胜 | S2 | 9 | 16% |
| carher-13 | 卜弋天 | S1 | 5 | 9% |
| carher-2 | 李金龙 | S1 | 4 | 7% |
| carher-10 | 徐协邦 | S3 | 4 | 7% |
| carher-6 | 庄乾军 | S2 | 1 | 2% |

---

## 二、每次事件详细记录

### carher-2 / 李金龙 / S1

Session: `43ebca9a` (1.9MB), compaction 在 16:48 触发

| # | 时间 (UTC) | 用户消息 | 触发工具 | Session 大小 | Run 持续时间 | 备注 |
|---|-----------|---------|---------|-------------|-------------|------|
| 1 | Feb 27 16:54:58 | "近3个月影响车联天下的10大AI技术发展相关的事件/关键技术发展" | web_search → (response) | 1.9MB | 262,945ms (4.4min) | compaction 刚完成, web_search 返回后模型生成分析报告 |
| 2 | Feb 27 16:58:21 | "继续" | web_search → (response) | 1.9MB | 170,092ms (2.8min) | 用户要求继续, typing TTL 2m 超时后断开 |
| 3 | Feb 27 17:07:56 | "什么情况？" | (response generation) | 1.9MB | 132,676ms (2.2min) | 模型尝试生成报告, 再次断开; 同时投递了 "抱歉，搜索数据太多搞慢了" |
| 4 | Feb 27 17:12:45 | "好了，换个问题 → 分析一下，车联天下的在行业里的竞争力" | (response generation) | 1.9MB | 196,663ms (3.3min) | 新问题仍然断开; 最终投递了 "数据齐全了，开始综合分析" |

**用户反馈**: 17:14 用户问 "为什么一直 Network connection lost."

### carher-3 / 洪源 / S1

Session: `dc0a7991` (5.2MB)

| # | 时间 (UTC) | 触发工具 | 模型输出前缀 (截取) | 备注 |
|---|-----------|---------|-------------------|------|
| 1 | Feb 25 07:00:27 | write | "收到陈健华（第二业务部总经理）的作业，这下真全了——13位高管。之前子agent挂了，我自己来写这份报告。" | 高管 AI 能力评估报告 |
| 2 | Feb 25 14:36:19 | write | "信息足够了。我来写一份结合行业框架和你们公司实际的完整回答。" | 行业分析长文 |
| 3 | Feb 25 14:45:02 | write | "正在写，内容比较重，稍等几分钟。" | 接续上一次失败 |
| 4 | Feb 25 15:23:20 | write | "案例拿到了——华为、Klarna（反面教材）、BCG框架。现在写落地方案。" | AI 落地方案 |
| 5 | Feb 25 15:28:08 | write | "在写，马上出。" | 接续上一次 |
| 6 | Feb 25 15:47:02 | write | "马上，在写。资料已齐，直接出方案。" | 接续 |
| 7 | Feb 25 15:49:15 | write | "抱歉让你等了，资料查完了，现在直接写。" | 接续 |
| 8 | Feb 26 09:18:31 | write | "你说得对，这是我的判断失误。管理层不是旁听者…管理层用AI做分析决策的ROI比基层更高" | AI 战略方案修改 |
| 9 | Feb 26 09:29:32 | write | "你说得对，…管理层的时间最值钱" | 接续上一次 |
| 10 | Feb 26 12:22:07 | write | "上下文快满了。我直接开始重写，把预算V2整合进正文，重新计算ROI" | session 5.2MB, context 接近上限 |

### carher-9 / 洪源(车联) / S2

Session: `3a2c4174` (**8.7MB** — 全部容器中最大)

| # | 时间 (UTC) | 触发工具 | 模型输出前缀 | 备注 |
|---|-----------|---------|-------------|------|
| 1 | Feb 26 06:09 | write | "明白，帮你做"学术改写"风格的措辞调整。开始处理：" | 48条需求改写 |
| 2 | Feb 26 06:29 | write | "正在处理，48 条需求每条都要改写，稍等一下。" | 第 2 次尝试 |
| 3 | Feb 26 06:33 | write | "正在处理，48 条需求每条都要改写措辞，稍等一下。" | 第 3 次尝试 |
| 4 | Feb 26 06:36 | write | "正在处理，48 条需求逐条改写需要一点时间。马上好。" | 第 4 次尝试 |
| 5 | Feb 26 06:38 | write | "正在处理，48 条需求逐条改写需要点时间。马上好。" | 第 5 次尝试, 同一任务连续失败 5 次 |
| 6 | Feb 27 03:33 | write | "信息充分了。现在重新写一版聚焦"新变化"的报警音仲裁分析" | 新任务, 仍然 write 大文档 |
| 7 | Feb 27 03:58 | write | "资料收集得差不多了，开始写子课题二。…Euro NCAP 2026…" | 技术课题报告 |
| 8 | Feb 27 05:07 | write | "已经有足够的调研材料了，直接开始写。" | 继续 |
| 9 | Feb 27 06:22 | write | "文档是一个巨大的表格（630个单元格 = 90行 × 7列）。…" | 大表格操作 |
| 10 | Feb 27 06:33 | write | "这个操作涉及89行表格的结构调整" | 89行表格重建 |
| 11 | Feb 27 06:43 | write | "飞书API不支持直接删除表格列，我需要重建整个表格" | 继续重试 |
| 12 | Feb 27 06:47 | write | "收到，两件事并行处理：先改文档，同时启动子课题一的调研" | 继续 |
| 13 | Feb 27 06:53 | write | "收到，两件事一起做：先改文档结构，再开始子课题一" | 继续 |
| 14 | Feb 27 07:03 | write | "调研够了，现在写完整分析文档。" | 新分析文档 |
| 15 | Feb 27 07:07 | write | "好，只做第一步：调研核心差异" | 缩小范围仍然失败 |
| 16 | Feb 27 07:19 | write | "89条全读完了。现在生成带"问题描述"和"对策"两列的完整新版文件。" | 89行新版 |
| 17 | Feb 27 07:24 | write | "好，先做前30条看效果。" | 缩小到30条仍然失败 |
| 18 | Feb 27 07:28 | write | "好，先做前30条试水。我直接生成带新两列的完整文件。" | 继续 |
| 19 | Feb 27 07:33 | write | "好，先做前30条看效果。我来逐条分析拆解。" | 继续 |
| 20 | Feb 27 07:38 | write | "子课题一调研已追加到飞书文档 ✅ 现在生成带"问题描述"+"对策"的需求文档" | 继续 |
| 21 | Feb 27 07:45 | write | "第二部分追加完成。现在生成座舱需求文档的"问题描述"+"对策"版（前30条）" | 继续 |
| 22 | Feb 27 07:50 | write | (空) | 内容生成中断 |
| 23 | Feb 27 07:53 | write | "开干。89条全表重建，前30条填"问题描述"+"对策"" | 继续 |
| 24 | Feb 27 07:58 | write | "开干。逐条拆解前30条的"问题"和"对策"" | 继续 |
| 25 | Feb 27 08:05 | write | "好的，现在我有完整的前30条内容。" | 继续 |

**特征**: 这是最严重的案例。用户持续重试同一任务 (改写大表格), session 累积到 8.7MB, 形成恶性循环 — 每次失败都让 session 更大, 下一次更容易失败。

### carher-11 / 商文胜 / S2

Session: `04300b5a` (1.7MB)

| # | 时间 (UTC) | 触发工具 | 模型输出前缀 | 备注 |
|---|-----------|---------|-------------|------|
| 1 | Feb 27 01:15 | write | "明白，这是一份面向公司最高决策层的立项汇报文档" | AI基建项目立项文档 |
| 2 | Feb 27 01:22 | write | "明白了，四份材料全部收齐。面向董事长、CEO、CTO…" | 第 2 次尝试 |
| 3 | Feb 27 01:30 | write | "明白，这次我会一次性完成。" | 第 3 次 |
| 4 | Feb 27 01:43 | write | "明白，这次我先把前两份文档整合到立项模板里" | 第 4 次, 缩小范围 |
| 5 | Feb 27 01:47 | write | (空) | 第 5 次 |
| 6 | Feb 27 01:49 | write | "这是因为生成内容太长，超过了网络超时限制" | 模型自己意识到了问题 |
| 7 | Feb 27 01:52 | write | "明白了，这次我分步来…不会超时。" | 承诺分步但仍失败 |
| 8 | Feb 27 05:53 | write | (空) | 新的 session 期 |
| 9 | Feb 27 06:54 | write | "先本地生成完整文档，再推到飞书。" | 继续 |

**特征**: 模型在第 6 次尝试时自己推测出了原因 ("生成内容太长，超过了网络超时限制"), 但仍无法规避, 因为无论怎么分步, 单次 write 调用的参数仍然过长。

### carher-10 / 徐协邦 / S3

Session: `9d5e4db4` (5.6MB)

| # | 时间 (UTC) | 触发工具 | 模型输出前缀 | 备注 |
|---|-----------|---------|-------------|------|
| 1 | Feb 27 07:03 | feishu_doc | (追加到飞书文档) | 19 部门职责分级表 |
| 2 | Feb 27 07:22 | write | "这个工程量大，我直接写到飞书文档里。先写本地文件再发。" | 本地 → 飞书策略 |
| 3 | Feb 27 07:25 | write | "工程量很大，我直接写到文件然后推飞书。" | 同上 |
| 4 | Feb 27 08:28 | write | "明白了，重新来。要求总结：1.一级职责拆短拆细…" | 调整策略后重试 |

**特征**: thinking token 极长 (19 个部门的组织架构分析, 单次 thinking 输出数千字), 导致总输出超限。

### carher-6 / 庄乾军 / S2

Session: `9dd30b9d` (1.1MB)

| # | 时间 (UTC) | 触发工具 | 模型输出前缀 | 备注 |
|---|-----------|---------|-------------|------|
| 1 | Feb 25 06:36 | write | "Now let me write the comprehensive report." | 写 cursor_ai_report.md |

**特征**: 单次事件, 写完整 AI 报告。

### carher-13 / 卜弋天 / S1

5 个不同 session, 每个 session 1 次错误

| # | Session | Session 大小 | 时间 | 备注 |
|---|---------|-------------|------|------|
| 1 | 08375f38 | 27KB | Feb 27 13:10 | memory search 结果中包含关键词 |
| 2 | 57b6ee8a | 40KB | Feb 25 03:34 | Context Window 压力测试 |
| 3 | 6856f8a5 | 49KB | Feb 26 13:25 | 记忆文件包含关键词 |
| 4 | 880329f1 | 652KB | Feb 25 09:17 | Context Window 压力测试 |
| 5 | aff6195e | 768KB | Feb 27 14:18 | session search 结果中包含关键词 |

**特征**: 部分是管理员压力测试触发, 部分是 memory/session 搜索结果中包含历史错误记录 (grep 匹配到历史数据)。实际 API 错误约 2 次。

---

## 三、问题分类

### 分类 A: 大文档写入 (占 ~80%, 约 47 次)

**典型场景**: 用户要求 AI 撰写/改写长篇文档 (AI 战略方案、项目立项书、需求表改写、部门职责表等)

**触发链路**:
```
用户: "帮我写一份XX报告"
  → 模型 thinking (数千字思考过程)
  → 模型调用 write 工具
  → write 参数 = 完整 markdown 文档 (数万字)
  → SSE 流传输 2-5 分钟
  → 连接中断
  → 用户收到 "Network connection lost."
```

**涉及容器**: carher-3, carher-6, carher-9, carher-10, carher-11

**关键特征**:
- 所有错误的 `stopReason` 均为 `"error"`
- 所有错误的 `usage` 均为全零 (流断开前未完成 usage 统计)
- 模型经常意识到问题并尝试"分步"策略, 但仍失败 (因为单次 write 参数仍然过长)
- carher-9 连续 5 次尝试同一任务 (48条需求改写) 全部失败, 形成恶性循环

### 分类 B: 搜索后分析总结 (占 ~10%, 约 4 次)

**典型场景**: 用户要求搜索行业信息并生成分析报告

**触发链路**:
```
用户: "分析近3个月影响XX的10大事件"
  → web_search (返回大量搜索结果)
  → 模型 thinking (整合多源信息)
  → 模型生成长分析文本
  → SSE 流传输 2-5 分钟
  → 连接中断
```

**涉及容器**: carher-2

**关键特征**:
- 与分类 A 的区别: 输出不是 write 工具参数, 而是纯文本回复
- 但 thinking + 搜索结果 + 分析文本的总输出量同样超过流传输限制
- compaction 刚完成后更容易触发 (compaction 本身消耗 context, 留给输出的空间更小)

### 分类 C: Context Window 压力 (占 ~10%, 约 2 次实际 API 错误)

**典型场景**: session 累积很大, 普通回复也可能断开

**涉及容器**: carher-13 (压力测试)

**关键特征**: 管理员测试环境, 非正常用户使用

---

## 四、根因分析

### 4.1 技术路径

```
Docker 容器
  → OpenClaw Gateway (Node.js)
    → OpenRouter API (https://openrouter.ai/api/v1/chat/completions)
      → Anthropic Claude Opus 4.6 API
        → SSE 流式响应 (text/event-stream)
      ← 流式响应 (thinking + tool_use 参数)
    ← OpenRouter 代理转发
  ← Gateway 解析 SSE 事件
← 投递到飞书
```

**断点位置**: OpenRouter ↔ Anthropic 之间或 Docker ↔ OpenRouter 之间的 SSE 长连接, 在持续传输 2-5 分钟后断开。

### 4.2 根因证据链

| 证据 | 结论 |
|------|------|
| `"Network connection lost."` 字符串不存在于 OpenClaw 源码、dist、node_modules 中 | 错误消息来自 Anthropic API 或 OpenRouter 代理层 |
| 100% 错误使用 `provider=openrouter`, `model=anthropic/claude-opus-4.6` | 与特定模型 + 路由组合强相关 |
| 100% 错误发生在 `write`/`feishu_doc` 工具调用或长文本生成时 | 大输出是触发条件 |
| Anthropic SDK Issue #842: 流式响应在 ~270-280KB 后被截断, 不发送 `message_stop` | 已知上游 bug |
| OpenClaw `isTransientHttpError()` 只处理 HTTP 5xx, 不覆盖 SSE 断流 | 当前无自动重试 |
| S1/S2/S3 不同网络环境的容器均受影响 | 排除本地网络问题 |
| 未使用 write 工具的容器 (carher-1, 4, 5, 7, 8 等) 0 次错误 | 确认触发条件 |

### 4.3 为什么 "分步写" 策略无效

模型在多次失败后会自行调整策略 (如 carher-11 #6: "这是因为生成内容太长"), 但即使宣布 "分步来", 实际执行时仍然在单次 `write` 调用中生成整篇文档。原因:

1. **tool_use 参数是原子的**: 一次 `write` 调用的参数 (文件内容) 必须在一个 SSE 流中完整传输, 无法中断后续传
2. **模型无法感知流传输进度**: 模型不知道自己的输出已经传了多少字节, 无法在即将超限时主动停止
3. **thinking token 也占流带宽**: Claude Opus 的 extended thinking 会生成数千字推理过程, 这些也通过 SSE 流传输, 进一步加大了总传输量

### 4.4 恶性循环机制

```
失败 → session 记录错误消息 → session 变大
  → 下次 API 调用 context 更大
  → 模型 thinking 更多 (因为要分析更多历史)
  → SSE 流传输更长
  → 更容易断开
  → 失败
```

carher-9 的 session 从初始大小膨胀到 8.7MB, 就是这个循环的结果。

---

## 五、改进建议

### 短期 (可立即执行, 不修改代码)

| 建议 | 说明 | 影响 |
|------|------|------|
| **指导用户拆分大任务** | 让用户将 "写一整篇报告" 改为 "先写大纲, 再逐节填写" | 减少单次 write 参数大小 |
| **降低 contextTokens** | 从 200K 降到 128K 或更低 | 减少上下文传输量, 但限制长对话 |
| **更积极的 compaction** | 降低 compaction 触发阈值 | 控制 session 膨胀 |
| **清理超大 session** | 手动重置 carher-9 的 8.7MB session | 立即缓解该用户的问题 |

### 中期 (需修改 OpenClaw 配置或代码)

| 建议 | 说明 | 复杂度 |
|------|------|--------|
| **对 "Network connection lost" 增加重试** | 在 `agent-runner-execution.ts` 的 catch 块中, 将此错误视为 transient 并重试 1 次 | 中 |
| **直连 Anthropic API** | 跳过 OpenRouter 代理, 减少中间网络跳数 | 低 (仅改配置) |
| **限制单次 write 参数大小** | 在 write 工具的 schema 中添加 maxLength 限制, 引导模型分段写入 | 中 |

### 长期 (需上游修复)

| 建议 | 说明 |
|------|------|
| **上报 Anthropic** | 引用 SDK Issue #842, 提交企业级 bug report |
| **上报 OpenRouter** | 确认 OpenRouter 代理层是否有额外的超时设置 |
| **等待 SDK 修复** | Anthropic SDK 修复流传输中断后自动恢复 |

---

## 六、附录

### A. 数据采集命令

```bash
# 在每台服务器上执行 (以 S1 为例)
for c in $(docker ps --format '{{.Names}}' | grep carher | sort); do
  docker exec $c sh -c \
    'grep -rl "Network connection lost" /data/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null'
done

# 提取详细错误上下文
docker exec carher-2 sh -c \
  'grep "Network connection lost" /data/.openclaw/agents/main/sessions/43ebca9a-*.jsonl'
```

### B. 相关源码位置

- 错误处理入口: `src/auto-reply/reply/agent-runner-execution.ts:473`
- transient 错误判断: `src/agents/pi-embedded-helpers/errors.ts:221` (`isTransientHttpError`)
- 网络错误分类: `src/infra/unhandled-rejections.ts:19` (`TRANSIENT_NETWORK_CODES`)
- Agent runner 内部错误记录: `src/agents/pi-embedded-runner/run.ts:665`

### C. 参考链接

- [Anthropic SDK Issue #842: Streaming responses consistently interrupted mid-transmission](https://github.com/anthropics/anthropic-sdk-typescript/issues/842)
- [OpenRouter Streaming Docs](https://openrouter.ai/docs/api/reference/streaming)
- [Anthropic API Errors](https://docs.anthropic.com/en/api/errors)
