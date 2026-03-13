# HER Deep Research 架构设计：飞书知识问答 + Deep Search 融合

> 日期：2026-03-13
> 状态：**架构设计阶段** · 知识问答 API 已验证可用 · OAuth scope 待正式提交 · 额度限制待评估

---

## 1. 背景

HER 目前有两条独立的知识检索路径：

| 路径       | 工具                 | 实现                   | 搜索方式                                                 |
| ---------- | -------------------- | ---------------------- | -------------------------------------------------------- |
| 关键词搜索 | `feishu_search`      | `tools/search.ts`      | 飞书 Drive API + Wiki API，分词关键词匹配                |
| 深度搜索   | `feishu_deep_search` | `tools/deep-search.ts` | 多源聚合（Drive + Wiki + 妙记 + 群归档），多组关键词并行 |

2026-03-12 验证发现飞书开放了第三条路径：**知识问答 API**（`/search/v2/knowledge_qa/`），提供基于 DeepSeek/豆包的 RAG 语义搜索 + 生成式回答能力。

本文档设计如何将知识问答 API 与现有 deep-search 融合，构建 HER 的 **Deep Research** 能力。

---

## 2. 知识问答 API 验证结论

### 2.1 API 端点

| 端点                                         | 方式     | 用途                                     |
| -------------------------------------------- | -------- | ---------------------------------------- |
| `POST /search/v2/knowledge_qa/answer`        | 非流式   | 一次性返回完整回答                       |
| `POST /search/v2/knowledge_qa/stream_answer` | SSE 流式 | 逐步推送 reasoning + answer + references |

### 2.2 认证

- 必须使用 `user_access_token`（不支持 `tenant_access_token`）
- 需要 OAuth scope：`search:knowledge_qa:read`
- 当前 `oauth.ts` 的 `OAUTH_SCOPES` 尚未包含此 scope

### 2.3 请求参数

```ts
{
  query: string,                       // 用户问题（1-1000字符）
  knowledge_scope: "enterprise" | "internet" | "llm" | "hybrid",
  enterprise_knowledge_source?: {      // enterprise/hybrid 模式必填
    space: {
      searchable: boolean,             // true = 搜全部可访问文档
      filter?: {
        doc_tokens: string[]           // 限定范围
      }
    }
  },
  model_type: "doubao" | "deepseek" | "doubao_thinking" | "doubao_auto_thinking",
  enable_image?: boolean,              // 多模态理解
}
```

### 2.4 SSE 响应格式

每行 base64 编码，解码后结构：

```ts
{
  id: string,          // 事件序号
  event: "pending" | "completed" | "failed",
  data: string,        // JSON 字符串，包含：
  // {
  //   answer: string,
  //   reasoning_content: string,
  //   status_code: number,
  //   status_message: string,
  //   references: {
  //     enterprise_refs?: Array<{
  //       title: string,
  //       url: string,
  //       doc_token?: string,
  //       doc_type?: string,
  //     }>
  //   }
  // }
}
```

### 2.5 docker13 实测结果（2026-03-13）

| 测试                      | scope                 | model    | 结果                                  | 耗时 |
| ------------------------- | --------------------- | -------- | ------------------------------------- | ---- |
| "你好"                    | llm                   | deepseek | 成功，纯 LLM 回答                     | ~15s |
| "公司有哪些部门"          | enterprise            | deepseek | 成功，14条参考文档，140个SSE事件      | ~62s |
| "公司有哪些部门"          | enterprise (无filter) | deepseek | `100016` 额度用完                     | ~1s  |
| "HER接入飞书知识空间进度" | enterprise            | deepseek | 成功，14条参考文档，完整回答          | ~62s |
| stream_answer             | enterprise            | deepseek | 成功，`text/event-stream`，base64编码 | ~55s |

### 2.6 已知限制

- **每日免费额度极少**（实测约 2-3 次/天），超额返回 `100016`
- 企业搜索耗时较长（~60秒），偶尔 504 超时
- `user_access_token` 有效期 2 小时，需自动刷新

---

## 3. 核心对比：知识问答 vs deep-search

以 Q1「HER 接入飞书知识空间到了什么程度」为实际对比样本。

### 3.1 信息获取能力

| 维度           | 知识问答 API               | HER deep-search                      |
| -------------- | -------------------------- | ------------------------------------ |
| 信息源数量     | 14 条文档摘要              | 62 条合并结果                        |
| 信息源类型     | 文档/PDF/PPT（纯文档索引） | Wiki + 群聊 + 妙记 + 云盘 + 文档全文 |
| 能否读文档全文 | 否，只读索引摘要片段       | 能，`feishu_doc read` 精读全文       |
| 能否读会议纪要 | 能搜到标题，只取摘要       | 能，`feishu_minutes get` 读完整内容  |
| 能否读群聊记录 | 否                         | 能，通过 `group_archive`             |
| 能否分析截图   | 否                         | 能                                   |

### 3.2 推理深度

| 维度         | 知识问答 API                     | HER deep-search                             |
| ------------ | -------------------------------- | ------------------------------------------- |
| 推理方式     | 单轮 RAG：搜索 → 摘要拼接 → 生成 | 多轮 Agent：搜索 → 定位 → 精读 → 综合判断   |
| 能否二次深入 | 否，一次性返回                   | 能，先搜后读、递归深挖                      |
| 结论质量     | "未找到答案" + 辅助信息堆砌      | 分层判断（读✅ 写🟡 承载✅ 推进🟡）+ 证据链 |
| 引用精度     | PDF 页码/段落级别                | 文档级别                                    |

### 3.3 运行特征

| 维度       | 知识问答 API           | HER deep-search            |
| ---------- | ---------------------- | -------------------------- |
| 延迟       | ~60秒（单次 API）      | 可能更长（多轮 tool call） |
| 额度       | 受飞书免费额度限制     | 不受限                     |
| token 消耗 | 飞书侧消耗，HER 不付费 | HER 的 LLM token           |
| 搜索方式   | 语义向量搜索           | 分词关键词匹配             |

### 3.4 结论

两者**互补而非替代**：

- 知识问答 API 擅长：快速事实检索、语义搜索、精确引用
- deep-search 擅长：跨源综合、全文精读、多步推理、复杂判断

---

## 4. Deep Research 架构设计

### 4.1 分层架构

```
用户提问
  │
  ├─ 第一层：Knowledge QA 快速预检（~5-60秒）
  │    ├─ 调用 stream_answer API
  │    ├─ 获得 references[] + answer + reasoning
  │    ├─ 判断回答质量（有答案 / 未找到 / 辅助信息）
  │    │
  │    ├─ 如果回答质量足够 → 直接输出（附参考文档链接）
  │    └─ 如果回答不够 → 进入第二层
  │
  ├─ 第二层：Deep Search 深度调研（多轮 tool call）
  │    ├─ 利用第一层的 references 作为搜索种子
  │    ├─ feishu_deep_search（多组关键词，4源并行）
  │    ├─ feishu_doc read（精读关键文档全文）
  │    ├─ feishu_minutes get（读会议纪要）
  │    ├─ memory_search（语义检索本地记忆）
  │    └─ 综合分析 → 分层判断 → 输出
  │
  └─ 输出层：统一展示
       ├─ 回答正文（保留 markdown + 引用标注）
       ├─ 参考文档列表（标题 + 链接，两层来源合并去重）
       └─ 推理过程（可折叠）
```

### 4.2 Knowledge QA 作为搜索种子

知识问答 API 的 `references[]` 可以显著加速 deep-search 的第二层：

```
知识问答返回 14 条 references
  → 提取 doc_token / url
  → 作为 deep-search 的定向搜索目标
  → feishu_doc read 直接精读最相关的 2-3 篇
  → 省去 deep-search 自己用关键词慢慢试探
```

这相当于把知识问答 API 当作一个**高质量的语义检索引擎**，弥补 deep-search 只能做关键词匹配的短板。

### 4.3 回答质量判断逻辑

```ts
type QualityLevel = "direct_answer" | "partial" | "no_answer";

function judgeQuality(response: KnowledgeQAResponse): QualityLevel {
  if (response.status_code !== 0) return "no_answer";

  // 飞书 API 在无答案时返回固定前缀
  if (response.answer.startsWith("抱歉，在可访问的企业知识中未找到答案")) return "partial"; // 有辅助信息但无直接答案

  if (response.answer === "找不到相关信息") return "no_answer";

  // 有实质性答案
  return "direct_answer";
}
```

| 质量等级        | 处理                                     |
| --------------- | ---------------------------------------- |
| `direct_answer` | 直接输出知识问答结果，附参考文档         |
| `partial`       | 输出辅助信息 + 自动触发 deep-search 补充 |
| `no_answer`     | 跳过知识问答结果，直接走 deep-search     |

### 4.4 额度管理策略

免费额度极少（~2-3 次/天），需要智能分配：

| 策略       | 说明                                                             |
| ---------- | ---------------------------------------------------------------- |
| 按需触发   | 只在用户明确要求"搜企业知识"或问题涉及企业内部信息时调用         |
| 额度感知   | 收到 `100016` 后标记当日额度用完，后续请求直接走 deep-search     |
| scope 降级 | 额度用完时，可尝试 `llm` scope（纯大模型，不搜企业知识）作为兜底 |
| 缓存       | 同一 session 内相同 query 不重复调用                             |

```ts
let dailyQuotaExhausted = false;
let lastQuotaResetDate = "";

function isQuotaAvailable(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (lastQuotaResetDate !== today) {
    dailyQuotaExhausted = false;
    lastQuotaResetDate = today;
  }
  return !dailyQuotaExhausted;
}
```

---

## 5. 工具设计

### 5.1 新增 `feishu_knowledge_qa` 工具

```ts
// tools/knowledge-qa.ts

const KnowledgeQASchema = Type.Object({
  query: Type.String({
    description: "用户的自然语言问题（1-1000字符）",
  }),
  knowledge_scope: Type.Optional(
    Type.String({
      description:
        "知识范围。enterprise=企业知识，internet=联网搜索，" +
        "llm=纯大模型，hybrid=企业+互联网。默认enterprise",
    }),
  ),
  model_type: Type.Optional(
    Type.String({
      description:
        "大模型。deepseek=DeepSeek-R1，doubao=豆包，" +
        "doubao_thinking=豆包思考，doubao_auto_thinking=豆包自动。默认deepseek",
    }),
  ),
});
```

### 5.2 输出格式设计

```ts
type KnowledgeQAToolResult = {
  answer: string;
  reasoning_summary?: string; // reasoning 压缩摘要（不暴露完整推理链）
  references: Array<{
    title: string;
    url: string;
    source_type?: string; // doc / sheet / pdf / pptx / minutes
  }>;
  quality: "direct_answer" | "partial" | "no_answer";
  quota_remaining?: boolean; // 额度是否还有
  hint: string; // 给 agent 的后续行动建议
};
```

### 5.3 SKILL.md 设计

```markdown
# 飞书知识问答（Deep Research）

## 两层搜索策略

| 层       | 工具                                 | 何时用                       |
| -------- | ------------------------------------ | ---------------------------- |
| 快速预检 | feishu_knowledge_qa                  | 用户问企业内部信息时优先调用 |
| 深度调研 | feishu_deep_search + feishu_doc read | 知识问答不够时补充           |

## 使用规则

- 用户问企业内部问题 → 先 feishu_knowledge_qa
- 知识问答返回"未找到"或辅助信息不够 → 继续 feishu_deep_search
- 知识问答额度用完 → 直接走 feishu_deep_search
- 知识问答的 references 可作为 deep_search 的搜索种子
```

---

## 6. 展示方案

### 6.1 对用户的展示（飞书消息）

**场景 A：知识问答直接回答**

```
🔍 飞书知识问答

公司目前有以下一级部门：
1. 技术中心（下设8个院）
2. 制造中心
3. ...

📎 参考文档：
• 各一级&二级部门负责人名单
• 组织架构调整通知
• ...
```

**场景 B：知识问答不够，deep-search 补充**

```
🔍 飞书知识问答：找到部分相关信息
📋 正在深度调研，精读关键文档...

━━━━━━━━━━━━━

HER 接入飞书知识空间的进度如下：

1. 读权限 🟢 已完成
   2026-03-10 起读权限已统一覆盖...

2. 写权限 🟡 方案已打通
   ...

📎 参考文档（共 18 条，来自知识问答 + 深度搜索）：
• 如何让 Her 访问你的飞书知识库和云盘
• HER信息、安全及飞书升级会议纪要 3/10
• ...
```

### 6.2 对 Agent 的展示（tool result）

```json
{
  "knowledge_qa": {
    "quality": "partial",
    "answer": "抱歉，在可访问的企业知识中未找到答案...",
    "references": [
      { "title": "Car Her 方案全文.pdf", "url": "..." },
      { "title": "飞书合作专题会议", "url": "..." }
    ]
  },
  "deep_search": {
    "total_merged": 62,
    "results": [...]
  },
  "doc_reads": [
    { "title": "如何让Her访问你的飞书知识库和云盘", "key_finding": "3/10读权限已统一" },
    { "title": "Her部署待办任务", "key_finding": "飞书权限管理🟡进行中" }
  ],
  "synthesis": "分层判断：读✅ 写🟡 承载✅ 推进🟡"
}
```

---

## 7. 实现计划

### Phase 1：OAuth scope + 基础工具（可立即开始）

| 项目           | 文件                                  | 说明                                         |
| -------------- | ------------------------------------- | -------------------------------------------- |
| 加 OAuth scope | `oauth.ts`                            | `OAUTH_SCOPES` 加 `search:knowledge_qa:read` |
| 新建工具       | `tools/knowledge-qa.ts`               | 实现 `feishu_knowledge_qa`，支持流式/非流式  |
| 注册工具       | `gateway.ts`                          | 在 tool 注册链路中加入 knowledge-qa          |
| SKILL.md       | `skills/feishu-knowledge-qa/SKILL.md` | 使用指南                                     |
| 单元测试       | `tools/knowledge-qa.test.ts`          | SSE 解析、质量判断、额度管理                 |

### Phase 2：Deep Research 融合（Phase 1 部署验证后）

| 项目             | 说明                                                           |
| ---------------- | -------------------------------------------------------------- |
| 搜索种子传递     | knowledge_qa 的 references → deep_search 的目标文档            |
| 质量判断自动路由 | direct_answer → 直接回复；partial/no_answer → 触发 deep-search |
| 额度感知降级     | 100016 → 标记当日用完，后续走 deep-search                      |
| session 级缓存   | 同 session 同 query 不重复调用                                 |

### Phase 3：规模化（需飞书升级额度后）

| 项目         | 说明                                                   |
| ------------ | ------------------------------------------------------ |
| 企业额度升级 | 联系飞书采购 AI 额度包                                 |
| 多用户隔离   | 每个用户的 knowledge_qa 调用用自己的 user_access_token |
| 监控         | 额度消耗监控、API 延迟监控、质量评分                   |

---

## 8. OAuth scope 变更

当前 `oauth.ts` 的 `OAUTH_SCOPES`（65行）需要新增：

```diff
  // ── Search ──
  "search:docs:read",
  "search:message",
+ "search:knowledge_qa:read",
```

变更影响：

- 用户需要重新授权一次（旧 token 没有此 scope）
- `getValidUserToken` 已有 scope drift 检测，会自动提示重新授权
- 不影响现有工具的权限

---

## 9. 与现有架构的关系

```
┌─────────────────────────────────────────────────────┐
│                    HER Agent                         │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ feishu_     │  │ feishu_deep_ │  │ feishu_    │  │
│  │ search      │  │ search       │  │ knowledge  │  │
│  │             │  │              │  │ _qa        │  │
│  │ 关键词搜索  │  │ 多源聚合     │  │ 语义RAG    │  │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘  │
│         │                │                │          │
│    Drive API        Drive API        knowledge_qa   │
│    Wiki API         Wiki API         /stream_answer  │
│                     Minutes API                      │
│                     群归档                            │
│         │                │                │          │
│         └────────────────┼────────────────┘          │
│                          │                           │
│                  ┌───────▼────────┐                  │
│                  │  feishu_doc    │                  │
│                  │  read / get    │                  │
│                  │  精读全文      │                  │
│                  └───────┬────────┘                  │
│                          │                           │
│                  ┌───────▼────────┐                  │
│                  │  Agent 综合    │                  │
│                  │  推理 & 判断   │                  │
│                  └────────────────┘                  │
└─────────────────────────────────────────────────────┘
```

三个搜索工具的定位：

| 工具                  | 定位         | 适合场景                             |
| --------------------- | ------------ | ------------------------------------ |
| `feishu_search`       | 轻量精确搜索 | 找已知标题的文档、精确关键词查找     |
| `feishu_deep_search`  | 多源广度搜索 | 不确定信息在哪里，需要全面搜一遍     |
| `feishu_knowledge_qa` | 语义深度问答 | 企业知识问答、需要 AI 分析的复合问题 |

---

## 10. 风险与边界

### 10.1 能承诺的

- 知识问答 API 在有额度时可以提供语义搜索 + RAG 回答
- 与 deep-search 融合后，HER 的企业知识检索能力覆盖面完整
- 三个搜索工具互补，agent 可按场景智能选择

### 10.2 不能承诺的

- 不能承诺知识问答 API 的免费额度够日常使用（实测仅 2-3 次/天）
- 不能承诺知识问答的回答一定准确（依赖飞书 RAG 质量）
- 不能承诺 enterprise 模式一定比 deep-search 结论更好（对比实验显示，复杂进度判断类问题 deep-search 优于知识问答）
- 不能承诺 API 延迟稳定（实测 5-62 秒不等，偶现 504）

### 10.3 额度是最大瓶颈

当前免费额度（~2-3次/天）远不够生产使用。在飞书额度升级之前，知识问答只能作为**锦上添花的预检层**，不能作为主力搜索路径。deep-search 仍然是 HER 企业知识检索的主干。
