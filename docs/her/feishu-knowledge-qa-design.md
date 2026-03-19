# 飞书知识问答 — 架构设计

> 创建：2026-03-19
> 状态：**Phase 1 实现中**
> 目标：全飞书知识 AI 语义召回（私聊、群聊、Wiki、Drive、会议纪要、邮件、文档评论）

---

## 1. 需求

任何语义问题，全飞书知识都能 AI 召回和总结。包括但不限于：

- 私聊/群聊消息
- Wiki 知识库
- 云文档（Docx、Sheet、Bitable、PDF、PPT、Excel、Word）
- 会议纪要（妙记）
- 邮件
- 文档评论
- 服务台 FAQ
- 飞书词典（Lingo）

这个 tool 可以替代/增强现有的 `feishu_search`、`feishu_deep_search` 的语义搜索能力。

---

## 2. 飞书官方 API（三个端点）

### 2.1 端到端问答（非流式）

| 项       | 值                                                                    |
| -------- | --------------------------------------------------------------------- |
| URL      | `POST https://open.feishu.cn/open-apis/search/v2/knowledge_qa/answer` |
| 认证     | `user_access_token` only（不支持 tenant_access_token）                |
| Scope    | `search:knowledge_qa:read`                                            |
| 频率限制 | 100 次/分钟                                                           |

### 2.2 端到端流式问答（SSE）

| 项       | 值                                                                           |
| -------- | ---------------------------------------------------------------------------- |
| URL      | `POST https://open.feishu.cn/open-apis/search/v2/knowledge_qa/stream_answer` |
| 认证     | `user_access_token` only                                                     |
| Scope    | `search:knowledge_qa:read`                                                   |
| 频率限制 | 100 次/分钟                                                                  |

### 2.3 向量搜索（返回匹配片段，不生成答案）

| 项       | 值                                                                    |
| -------- | --------------------------------------------------------------------- |
| URL      | `POST https://open.feishu.cn/open-apis/search/v2/knowledge_qa/search` |
| 认证     | `user_access_token` only                                              |
| Scope    | `search:knowledge_qa:read`                                            |
| 频率限制 | 100 次/分钟                                                           |

---

## 3. 请求参数（三个端点共用）

```json
{
  "query": "如何申请显示器", // 必填，1-1000 字符
  "knowledge_scope": "enterprise", // 必填：enterprise | internet | llm | hybrid
  "enable_image": false, // 可选，是否启用图片理解
  "model_type": "deepseek", // 必填：doubao | deepseek | doubao_thinking | doubao_auto_thinking
  "enterprise_knowledge_source": {}, // enterprise/hybrid 时必填，见 3.1
  "extra": {
    // 可选
    "locale": "zh-CN",
    "timezone": "Asia/Shanghai"
  }
}
```

### 3.1 `enterprise_knowledge_source` 完整参数

每个子源都有 `searchable`（是否搜索）、`filter`（圈选）、`reject`（排除）三层控制。

#### `space` — 云文档

```json
{
  "space": {
    "searchable": true,
    "filter": {
      "doc_tokens": ["PxYcwxxxx"], // 限定文档 token 列表（最多 100）
      "folder_tokens": ["1234566"] // 限定文件夹 token 列表（最多 100）
    },
    "reject": {
      "doc_tokens": ["PxYcwxxxx"],
      "folder_tokens": ["1234566"]
    }
  }
}
```

#### `wiki` — 知识库/Wiki

```json
{
  "wiki": {
    "searchable": true,
    "filter": {
      "wiki_tokens": ["adfdfd"], // 文档 token 列表（最多 100）
      "node_tokens": ["1234232"], // 节点 token 列表（最多 100）
      "space_ids": ["1234566"] // 空间 ID 列表（最多 100）
    },
    "reject": {
      "wiki_tokens": ["adfdfd"],
      "node_tokens": ["1234232"],
      "space_ids": ["1234566"]
    }
  }
}
```

#### `message` — 消息/聊天记录

```json
{
  "message": {
    "searchable": true,
    "filter": {
      "chat_ids": ["123456"], // 会话列表（最多 100）
      "time_range": {
        "start": 123345, // 开始时间戳，默认 1 年前
        "end": 123456 // 结束时间戳，默认当前
      }
    },
    "reject": {
      "chat_ids": ["123456"],
      "message_ids": ["123456"] // 排除消息 ID（最多 100）
    }
  }
}
```

#### `helpdesk_faq` — 服务台 FAQ

```json
{
  "helpdesk_faq": {
    "searchable": true,
    "filter": {
      "helpdesk_ids": ["1233455"] // 服务台列表（最多 100）
    }
  }
}
```

#### `lingo` — 飞书词典

```json
{
  "lingo": {
    "searchable": true
  }
}
```

#### `comment` — 文档评论

```json
{
  "comment": {
    "wiki_searchable": true, // 知识库文档评论
    "space_searchable": true // 云文档评论
  }
}
```

#### `minutes` — 妙记

```json
{
  "minutes": {
    "searchable": true
  }
}
```

#### `mail` — 邮件

```json
{
  "mail": {
    "searchable": true
  }
}
```

### 3.2 `knowledge_scope` 选项

| 值           | 含义            | 数据源                                          |
| ------------ | --------------- | ----------------------------------------------- |
| `enterprise` | 企业内知识      | 按 `enterprise_knowledge_source` 圈选的所有子源 |
| `internet`   | 联网搜索        | 互联网                                          |
| `llm`        | 仅大模型        | 无数据源，纯 LLM 回答                           |
| `hybrid`     | 企业+互联网融合 | enterprise_knowledge_source + 互联网            |

### 3.3 `model_type` 选项

| 值                     | 说明                 |
| ---------------------- | -------------------- |
| `doubao`               | 豆包大模型           |
| `deepseek`             | DeepSeek-R1 大模型   |
| `doubao_thinking`      | 豆包思考模型         |
| `doubao_auto_thinking` | 豆包自动选择最佳模型 |

### 3.4 多模态能力（`enable_image`）

| 资料类型                | 支持图片/画板 |
| ----------------------- | :-----------: |
| 文档                    |      ✅       |
| 电子表格                |      ✅       |
| 多维表格                |      ✅       |
| 文件 Word/PPT/PDF/Excel |      ✅       |
| 消息                    |      ✅       |
| 文档评论                |      ✅       |
| 邮件                    |      ✅       |
| 服务台 FAQ              |      ❌       |
| Lingo 词典              |      ❌       |
| 妙记                    |      ❌       |
| 互联网内容              |      ❌       |

---

## 4. 响应格式

### 4.1 非流式响应（`/answer`）

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "answer": "**步骤指引**[[1]](https://xxxx)\n1. 点击...",
    "reasoning_content": "好的，我将回答...",
    "status_code": 0,
    "status_message": "ok",
    "references": {
      "enterprise_refs": [
        {
          "id": "6946843325487912356",
          "source_type": 1,
          "title": "IT 服务台-申请显示器",
          "content": "申请显示器的详细步骤为...",
          "url": "https://example.passage.link"
        }
      ],
      "internet_refs": [
        {
          "title": "网页标题",
          "summary": "网页摘要",
          "url": "https://..."
        }
      ]
    }
  }
}
```

### 4.2 流式响应（`/stream_answer`，SSE）

基于 HTTP SSE 协议，相比非流式增加 `id`、`event` 字段：

```json
{
  "code": 0,
  "msg": "success",
  "id": 1,                              // 流式数据包序号（递增）
  "event": "pending",                    // pending=输出中，finished=完成，failed=失败
  "data": {
    "answer": "xxxxx",                   // 答案内容（增量/累积）
    "reasoning_content": "xxxxxx",       // 思考过程
    "references": {
      "enterprise_refs": [...],
      "internet_refs": [...]
    },
    "status_code": 0,
    "status_message": ""
  }
}
```

### 4.3 向量搜索响应（`/search`）

返回匹配的知识片段（passages），不生成 AI 答案：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "passages": [
      {
        "id": "6946843325487912356",
        "source_type": 1,
        "title": "IT 服务台-申请显示器",
        "content": "片段内容...",
        "url": "https://..."
      }
    ]
  }
}
```

### 4.4 `source_type` 枚举

| 值  | 来源类型       |
| --- | -------------- |
| 1   | 服务台 FAQ     |
| 2   | Wiki 文档      |
| 3   | 云文档         |
| 5   | Lingo 飞书词典 |
| 6   | 消息           |
| 7   | 文档评论       |
| 8   | 妙记           |
| 9   | 邮件           |

### 4.5 答案中的特殊格式

- 引用标注：`[[referenceIndex]](URL)`
- 图片：`<qa_image>image_token</qa_image>`（需通过答案图片下载 API 获取实际图片）

---

## 5. 错误码

| HTTP 状态 | 错误码  | 描述                         | 说明                                             |
| --------- | ------- | ---------------------------- | ------------------------------------------------ |
| 400       | 1270001 | param is invalid             | 参数非法（query 长度、filter/reject 数组长度等） |
| 500       | 1270002 | rate or quota exceed limit   | 频率/额度超限                                    |
| 500       | 1270003 | input or output is forbidden | 涉及敏感内容                                     |
| 500       | 1270006 | internal error               | 内部错误，需重试                                 |

---

## 6. 工具设计

### 6.1 tool schema

```typescript
const FeishuKnowledgeQASchema = Type.Object({
  action: stringEnum(["ask", "search"], {
    description:
      "ask: AI 问答（返回 AI 生成的答案 + 参考来源）。" +
      "search: 向量搜索（返回匹配的知识片段，不生成答案）。",
  }),
  query: Type.String({
    description: "自然语言问题（1-1000 字符）",
  }),
  knowledge_scope: Type.Optional(
    stringEnum(["enterprise", "internet", "llm", "hybrid"], {
      description:
        "知识范围。enterprise=企业知识（默认），internet=联网搜索，llm=纯大模型，hybrid=企业+互联网融合",
    }),
  ),
  model_type: Type.Optional(
    stringEnum(["deepseek", "doubao", "doubao_thinking", "doubao_auto_thinking"], {
      description: "大模型。默认 deepseek",
    }),
  ),
});
```

### 6.2 默认行为

- `action`: `ask`（AI 问答）
- `knowledge_scope`: `enterprise`
- `model_type`: `deepseek`
- `enterprise_knowledge_source`: **全部开启**（space + wiki + message + minutes + comment + mail + lingo + helpdesk_faq）— Her 的需求是"全飞书知识都能召回"

### 6.3 输出格式

```typescript
type KnowledgeQAResult = {
  answer?: string; // AI 答案（ask 模式）
  reasoning_content?: string; // 思考过程
  passages?: Array<{
    // 知识片段（search 模式）
    title: string;
    content: string;
    url: string;
    source_type: number;
    source_label: string; // "wiki" | "cloud_doc" | "message" | "minutes" | ...
  }>;
  references?: Array<{
    // 参考来源（ask 模式）
    title: string;
    url: string;
    source_type: number;
    source_label: string;
  }>;
  quality: "direct_answer" | "partial" | "no_answer" | "quota_exceeded";
};
```

---

## 7. 与现有工具的关系

| 工具                      | 定位             | 数据源                                                                   | 搜索方式        |
| ------------------------- | ---------------- | ------------------------------------------------------------------------ | --------------- |
| `feishu_search`           | 轻量精确搜索     | Drive + Wiki                                                             | 关键词匹配      |
| `feishu_deep_search`      | 多源广度搜索     | Drive + Wiki + 妙记 + 群归档                                             | 多组关键词并行  |
| **`feishu_knowledge_qa`** | **全源语义问答** | **space + wiki + message + minutes + mail + comment + lingo + helpdesk** | **AI 语义 RAG** |

`feishu_knowledge_qa` 的数据源覆盖面最广（8 种），且是语义搜索而非关键词匹配。可以作为"企业内部问题"的首选工具。

---

## 8. 实现计划

### Phase 1：基础工具

- [ ] `oauth.ts` 启用 `search:knowledge_qa:read` scope
- [ ] 新建 `extensions/feishu-her/src/tools/knowledge-qa.ts`
- [ ] 实现 `ask` action（非流式 `/answer`）
- [ ] 实现 `search` action（向量搜索 `/search`）
- [ ] 注册到 `tools/index.ts`
- [ ] 新建 `skills/feishu-knowledge-qa/SKILL.md`
- [ ] carher-101 本地测试

### Phase 2：流式 + 额度管理

- [ ] 实现 SSE 流式 `/stream_answer`（长查询场景，避免超时）
- [ ] 额度感知（1270002 → 标记当日用完 → 降级到 deep_search）
- [ ] session 级缓存（同 query 不重复调用）

### Phase 3：Deep Research 融合

- [ ] knowledge_qa references → deep_search 搜索种子
- [ ] 质量判断自动路由
- [ ] 与 `feishu_minutes`、`feishu_doc read` 联动精读

---

## 9. 已知限制

- **每日免费额度有限**（实测约 2-3 次/天），超额返回 `1270002`
- 企业搜索耗时较长（5-62 秒），偶尔超时
- 必须 `user_access_token`（不支持 tenant_access_token）
- `knowledge_scope=enterprise` 时 `enterprise_knowledge_source` 必填
- 答案质量依赖飞书 RAG 系统，非 100% 准确
