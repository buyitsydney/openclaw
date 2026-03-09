# 飞书 Search 架构设计

> 日期：2026-03-09（最后更新：2026-03-09 23:30 UTC+8）
> 状态：**可上线** · 全量回归 47/47 PASS · 新增 `feishu_deep_search` + `feishu_conversation_search` + `memory-bridge` 已验证通过 · 搜索召回仍受飞书服务端索引延迟与漏召回影响

---

## 1. 目标

我们希望为 Her 增加一个新的飞书搜索能力，使它可以像一个“会用飞书搜索的人”那样，帮助用户在自己的飞书内容中找到相关文档。

目标不是简单再加一个工具名，而是明确回答以下问题：

- 飞书里“云盘”“云文档”“Wiki”分别是什么关系
- 飞书公开 API 到底有几种搜索接口
- 哪些接口在真实环境里可用，哪些不能依赖
- Her 应该如何把多种飞书搜索能力统一成一个确定性的 search 工具

本设计文档只描述**架构和边界**，不直接修改实现。

---

## 2. 核心结论

基于本地 Her 和 `docker1` 的真实实验，当前可以得到以下稳定结论：

1. 飞书平台会自动为**云盘文档**和 **Wiki** 做服务端**关键词索引**（标题 + 正文内容），不需要 Her 自己建索引。但这是**分词关键词匹配**，不是语义搜索——自然语言长句查询（如"her之间的文件是怎么共享的"）会返回 0 条结果。
2. 目前对 Her 可稳定依赖的公开搜索能力不是一个统一接口，而是**两套接口**：
   - 云盘文档搜索：`/open-apis/suite/docs-api/search/object`
   - Wiki 搜索：`/open-apis/wiki/v2/nodes/search`
3. 官方文档页对应的统一接口 `search/v2/doc_wiki/search` 在当前真实租户中返回 `code=0` 但 `total=0`，**暂时不能作为成熟能力依赖**。
4. `openclaw` upstream 官方飞书插件**没有**实现通用搜索；当前 Her 已实现的只是 `feishu_minutes` 中的“会议纪要专用搜索”。
5. 因此，Her 的通用飞书搜索能力应该采用：
   - **双路搜索**
   - **应用层统一结果**
   - **按需展开正文**
6. 对 Drive 原始文件（`object_type=file`，如 PDF / DOCX / PPTX / XLSX），当前 Her 已验证可以在**搜索命中后**继续自动读取正文；但“能不能搜到”仍取决于飞书自己的服务端索引，而不是 Her 的读取链路。

---

## 3. 真实实验结论

本次调研在以下两个真实环境完成：

- 本地 Her
- `docker1` (`carher-1`)

### 3.1 云盘文档真值

已确认真实存在的云盘文档：

- 标题：`企业知识在her之间共享`
- 正文：
  - `架构设计：通过openclaw的skills，热加载，在服务器根目录更新后，200+用户自动获得skills`
  - `比如：复杂任务让her分布做，通过md来中转结果`

实验结果：

- 用 `search/object` 搜标题 `企业知识在her之间共享`，命中
- 用 `search/object` 搜正文短语 `md来中转结果`，命中

结论：

- `search/object` 对云盘 docx 具备**关键词全文搜索能力**（标题 + 正文）
- 返回的只是命中文档元数据，不返回正文片段
- bitable 的字段名/数据也被索引，导致关键词搜索噪音较大

### 3.2.1 补充实验（2026-03-08 MVP 后）

| search_key                  | 结果                              | 说明                                      |
| --------------------------- | --------------------------------- | ----------------------------------------- |
| `OpenClaw`                  | 3 条，含「企业知识在her之间共享」 | 标题无 OpenClaw → **正文被索引**          |
| `共享`                      | 32 条                             | 标题匹配 + 正文匹配                       |
| `her之间的文件是怎么共享的` | **0 条**                          | 自然语言长句 → **不支持语义搜索**         |
| `seedance`                  | 1 条                              | 精确标题匹配                              |
| `飞书搜索架构`              | **0 条**                          | Wiki 文档 → **Drive 搜索完全不可见 Wiki** |

确认结论：

- 飞书索引是**分词关键词匹配**，不是语义搜索
- 自然语言查询会失败，必须用短关键词
- Drive 和 Wiki 索引完全隔离

### 3.2.2 补充实验（2026-03-09 file 读取链路）

本次补充验证覆盖了两条独立链路：

- 本地 Her：搜索 `任职资格管理办法`，命中 Drive `file` 后继续读取 `CL-31-07 任职资格管理办法 A1.pdf`，成功返回正文预览
- `docker1`：同样完成 `feishu_search -> feishu_doc(action="read", doc_type="file")` 的真实链路验证

确认结论：

- 当前 Her 已经不是“只能搜到 file，读不了正文”
- 之前的 404 根因是把 Drive `file` 错误分发到了普通 doc 读取路径；该链路已修正
- 若 `feishu_search` 返回 `0 命中`，优先判断为**飞书索引未命中/未就绪**，而不是 Her 读取失败
- 因此，文档状态应区分：
  - **读取能力**：已打通
  - **搜索召回能力**：仍受飞书平台索引边界约束

### 3.2.3 全量回归（2026-03-09 Knowledge Q&A 四期实现后）

新增工具（`feishu_deep_search`、`feishu_conversation_search`、`memory-bridge`）实现并部署后的全量回归：

**测试环境**：本地 `docker1`（2 个私聊 session + 1 个群聊 @mention）

**结果**：47 项测试 · 47 PASS · 0 FAIL · 0 回退

搜索模块压力测试（8/8）：

| 工具                                   | 测试项                                                       | 结果 |
| -------------------------------------- | ------------------------------------------------------------ | ---- |
| `feishu_search`                        | 关键词"测试方案" → 10 条（Drive 5 + Wiki 5）                 | ✅   |
| `feishu_search(scope=wiki)`            | 关键词"search" → 2 条 Wiki                                   | ✅   |
| `feishu_search(include_bitable)`       | bitable 参数生效                                             | ✅   |
| `feishu_deep_search`                   | 4 组关键词 → 19 raw / 10 merged（Drive+Wiki+Minutes+群归档） | ✅   |
| `feishu_conversation_search(groups)`   | "回归测试" → 群聊归档命中                                    | ✅   |
| `feishu_conversation_search(sessions)` | session 历史搜索正常                                         | ✅   |
| `memory_search`                        | 语义搜索本地记忆 → 8 条                                      | ✅   |
| `feishu_minutes(search)`               | "团队分工" → AI 摘要 + match_sources                         | ✅   |

文档读取压力测试（10/10）：PDF、PPTX、DOCX、ZIP、MP4、Sheet、Bitable 全类型覆盖。

其他模块（29/29）：chat/members/directory/wiki/drive/calendar/minutes/task CRUD 全通。

**已知非代码问题**：群聊 @mention 时触发 "AI service temporarily overloaded"（Claude API 并发限流），非本次代码变更导致。

### 3.2 Wiki 真值

已确认真实存在的 Wiki：

- Space：`示例知识库 / Wiki samples`
- 节点标题：`飞书搜索架构`
- 正文：
  - `一个简单的想法：文档上传云盘或者wiki、飞书自动index，然后通过search api来召回`

实验结果：

- 用 `wiki/v2/nodes/search` 搜标题 `飞书搜索架构`，命中
- 用 `wiki/v2/nodes/search` 搜正文短语 `飞书自动index`，命中
- 用 `wiki/v2/nodes/search` 搜正文短语 `文档上传云盘或者wiki`，命中

结论：

- `wiki/v2/nodes/search` 对 Wiki 节点同样具备**关键词全文搜索能力**
- 返回的只是 Wiki 节点元数据，不返回正文片段
- 同样是分词关键词匹配，不是语义搜索

### 3.3 统一接口候选

已实际调用：

- `POST /open-apis/search/v2/doc_wiki/search`

测试词包括：

- `企业知识在her之间共享`
- `md来中转结果`
- `飞书搜索架构`
- `飞书自动index`
- `her`
- `搜索`
- `知识库`

结果：

- 所有调用均为 `code=0`
- 但 `total=0`

结论：

- 该接口的官方文档页存在
- 但在当前真实环境中**不可依赖**
- 现阶段不能把它当作“成熟统一搜索接口”

---

## 4. 飞书内容层级关系

这是理解搜索接口的关键。

### 4.1 Drive / 云盘

Drive 是飞书的存储与目录体系，更接近：

- 文件夹
- 文档文件
- Sheet
- Bitable
- 普通文件

用户在“云盘”里看到的是一棵目录树。

### 4.2 云文档

“云文档”不是一个独立于 Drive 的全新系统，更像是：

- 存在于飞书内容系统中的文档对象
- 常见类型包括 `docx`、`sheet`、`bitable`

也就是说：

- 云盘偏**目录和存储视角**
- 云文档偏**文档对象视角**

### 4.3 Wiki

Wiki 是飞书的知识空间体系，更接近：

- `space`
- `node`
- node 背后挂真实内容对象

这些真实对象常常还是：

- `docx`
- `sheet`
- `bitable`

所以 Wiki 不是“另一份完全独立的文档格式”，而是给内容增加了一层**知识组织结构**。

### 4.4 为什么容易混淆

因为同样是一篇内容：

- 放在云盘里，你从 Drive 视角看到的是一个 docx
- 放在 Wiki 里，你从 Wiki 视角看到的是一个 node，node 后面再指向 docx

所以用户感知上像是“一篇文档”，但公开 API 暴露出来的搜索对象并不一样。

---

## 5. 搜索接口矩阵

### 5.1 当前可依赖接口

| 接口                                      | 搜索对象     | 真实表现           | 返回字段风格                                   | 当前可依赖性 |
| ----------------------------------------- | ------------ | ------------------ | ---------------------------------------------- | ------------ |
| `/open-apis/suite/docs-api/search/object` | 云盘文档对象 | 可搜标题，可搜正文 | `docs_token` `docs_type` `title` `owner_id`    | ✅ 可依赖    |
| `/open-apis/wiki/v2/nodes/search`         | Wiki 节点    | 可搜标题，可搜正文 | `node_id` `obj_token` `space_id` `title` `url` | ✅ 可依赖    |

### 5.2 当前不可依赖接口

| 接口                                   | 官方定位             | 真实表现                        | 当前结论    |
| -------------------------------------- | -------------------- | ------------------------------- | ----------- |
| `/open-apis/search/v2/doc_wiki/search` | 看起来像文档统一搜索 | 当前租户中返回 `code=0 total=0` | ❌ 暂不依赖 |

---

## 6. 接口语义差异

### 6.1 `search/object` 在搜什么

它搜到的是**文档对象**，不是 Drive 目录树本身。

因此：

- 它能搜到云盘里的 docx 内容
- 但不代表它能覆盖 Wiki node
- 它更像“文档对象搜索”，不是“Drive 全量统一搜索”

### 6.2 `wiki/v2/nodes/search` 在搜什么

它搜到的是 **Wiki 节点**。

因此：

- 它会返回 node 级信息
- 它能命中 Wiki 中文章正文
- 但返回结构是 Wiki 世界的结构，不是 Drive 世界的结构

### 6.3 是否存在同一个接口同时搜到云盘和 Wiki

当前高置信答案：

- **不能依赖存在**

原因：

- `search/object` 实测只覆盖云盘文档
- `wiki/v2/nodes/search` 实测只覆盖 Wiki
- `search/v2/doc_wiki/search` 当前环境不可用

所以现阶段应视为：

- **没有一个稳定可依赖的单接口能同时搜索云盘和 Wiki**

### 6.4 同一篇内容会不会同时被两个接口搜到

不能假设一定会。

更准确地说：

- 云盘搜索返回的是文档对象视角
- Wiki 搜索返回的是 node 视角
- 某个 Wiki 节点背后可能引用一个 docx
- 但公开 API 没有保证这两个接口一定都能命中、一定都返回、一定同 ID、一定同排序

工程上必须按以下原则处理：

- **先把它们当成两套结果源**
- **只在能 100% 确认同源时再去重**
- **不能靠猜测合并**

---

## 7. Her 的目标能力

Her 需要的不是“再加一个飞书 API wrapper”，而是一个用户可理解、模型可稳定使用的统一搜索能力。

建议目标定义为：

- 用户说“搜一下我飞书里关于 X 的文档”
- Her 自动同时搜索：
  - 云盘文档
  - Wiki
- Her 返回统一结果
- 当用户追问“为什么命中”“具体写了什么”时，再继续读取正文

这里的核心不是模仿飞书 App UI，而是：

- 让 Her 能稳定找到内容
- 让结果结构足够统一
- 让后续推理是确定性的

---

## 8. 推荐方案

### 8.1 总体策略

Her 的飞书搜索能力不应建立在飞书“已经提供成熟统一搜索接口”的假设上，而应采用：

1. 双路搜索
2. 应用层统一
3. 按需展开正文

### 8.2 双路搜索

并行调用：

- Drive 路径：
  - `POST /open-apis/suite/docs-api/search/object`
- Wiki 路径：
  - `POST /open-apis/wiki/v2/nodes/search`

### 8.3 统一结果层

建议把两条结果统一成类似结构：

```ts
type FeishuSearchResult = {
  source: "drive" | "wiki";
  title: string;
  object_type: "docx" | "sheet" | "bitable" | "file" | "unknown";
  drive_doc_token?: string;
  wiki_node_id?: string;
  wiki_space_id?: string;
  obj_token?: string;
  owner_id?: string;
  url?: string;
  why_matched?: "title" | "full_text" | "unknown";
};
```

其中：

- `source` 用来告诉模型和用户这个结果来自哪条搜索链路
- `obj_token` 用来承接后续“读正文”动作
- `why_matched` 先只做确定性标注，不猜测高亮片段

### 8.4 去重原则

只允许在**确定同源**时去重。

例如：

- Wiki 结果携带的 `obj_token`
- 与 Drive 搜索结果里的真实 docx token 能 100% 对上

如果不能确定：

- 不去重
- 宁可保留两条结果，也不要误合并

### 8.5 正文展开策略

搜索接口当前不稳定提供 snippet，因此解释命中原因时，需要按需再读正文：

- `docx`：`docx.rawContent`
- `wiki node`：先取 `obj_token`，再按对象类型读取

升级原则：

- 默认先停在搜索结果层
- 只有用户继续追问或模型需要证据时，再拉正文

---

## 9. 非目标

当前阶段明确不是要实现以下目标：

- 100% 复制飞书 App 搜索体验
- 复刻飞书 App 的排序逻辑
- 获得飞书 App 的 snippet / highlight 展示
- 依赖一个未验证成熟的统一接口
- 声称飞书公开提供了语义搜索 API

---

## 10. 风险边界

### 10.1 能承诺的

- 飞书确实会自动索引云盘文档和 Wiki
- Her 可以通过双路搜索覆盖这两类内容
- 结果可以在应用层统一

### 10.2 不能承诺的

- 不能承诺与飞书 App 搜索完全一致
- 不能承诺所有对象都能被单一接口搜到
- 不能承诺同一篇内容一定会同时出现在 Drive 搜索和 Wiki 搜索中
- 不能承诺公开 API 已提供语义搜索

---

## 11. 与现状实现的关系

当前代码现状如下：

- upstream `extensions/feishu` 没有做通用搜索
- `extensions/feishu-her/src/tools/drive.ts` 没有 search action
- `extensions/feishu-her/src/tools/wiki.ts` 也没有搜索实现
- `extensions/feishu-her/src/tools/minutes.ts` 里已经有一条“基于 `search/object` 的会议纪要专用搜索链路”

因此，推荐后续实现方式是：

- 新增一个通用 `feishu_search` 工具
- 独立于 `feishu_minutes`
- 内部并行调用 Drive 搜索和 Wiki 搜索
- 把“会议纪要搜索”保留为独立领域工具，不混进通用 search 中

---

## 12. 实现进度

### 已完成（MVP, 2026-03-08）

| 项目                                  | 状态                                    | 文件                                           |
| ------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `feishu_search` 工具                  | 已实现                                  | `extensions/feishu-her/src/tools/search.ts`    |
| 双路召回（Drive + Wiki）              | 已实现                                  | 同上                                           |
| 统一返回结构（source-tagged）         | 已实现                                  | 同上                                           |
| Drive 结果自动解析链接                | 已实现                                  | 同上 + `share-url.ts`                          |
| 5+5 配额（all scope 下各源最多 5 条） | 已实现                                  | `ALL_SCOPE_SOURCE_QUOTA = 5`                   |
| SKILL.md 文档                         | 已更新                                  | `extensions/feishu-her/skills/feishu/SKILL.md` |
| 单元测试                              | 6/6 通过                                | `search.test.ts`                               |
| docker1 实测                          | 搜索 "search" 命中 Wiki「飞书搜索架构」 | —                                              |

### docker1 实测发现

- Drive search 对英文关键词（如 "search API"）噪音极大，返回大量不相关 bitable
- Wiki search 对简短精确词（如 "search"）命中率更好
- Her 会自动尝试多组关键词（拆分、中英文、缩短），弥补单次召回不准
- 5+5 配额防止 Drive 噪音完全淹没 Wiki 结果

### 后续可选优化

原计划推进顺序（已完成项标 ✅）：

1. ✅ 新增 `feishu_search` 工具
2. ✅ 双路召回（Drive + Wiki）
3. ✅ 统一返回结构
4. 按需正文展开（Her 已通过 `feishu_doc` 自动实现）
5. 后续按实际效果决定：
   - 去重
   - 重排
   - 查询词解释
   - 结果摘要

当前阶段最重要的原则不变：

- **先做确定性召回**
- **不要依赖不可验证的统一接口**
- **不要把“飞书自动索引”误解成“飞书已经给了我们一个成熟统一搜索 API”**

---

## 13. Aily 语义搜索——飞书真正的 RAG 能力（2026-03-08 发现）

### 13.1 背景

docker1 实测发现 `search/object` 只是分词关键词匹配（自然语言长句返回 0 条）。
但飞书 App 内置的「知识问答」bot 能用自然语言精准回答，且附带引用来源。
调查后发现：两者使用的是**完全不同的搜索系统**。

### 13.2 飞书搜索能力全景（官方文档确认）

| 能力              | API                             | 搜索方式                    | 返回内容               | 支持自然语言 |
| ----------------- | ------------------------------- | --------------------------- | ---------------------- | ------------ |
| Drive 文档搜索    | `/suite/docs-api/search/object` | 分词关键词                  | 元数据（标题+token）   | 不支持       |
| Wiki 节点搜索     | `/wiki/v2/nodes/search`         | 分词关键词                  | 元数据（标题+node_id） | 不支持       |
| **Aily 知识问答** | `/aily-v1/data-knowledge/ask`   | **RAG 语义搜索 + LLM 生成** | 生成式回答 + 召回切片  | **支持**     |
| Aily 知识检索     | Aily workflow 节点              | 语义向量检索                | 知识切片列表           | 支持         |

### 13.3 Aily 知识问答技术细节（官方文档）

**数据预处理流程：**

1. 文档内容提取（文本、段落标题、表格、链接）
2. 切片（每片最多 512 token）
3. 建立语义向量索引
4. 自动同步更新（约 15 分钟延迟）

**问答模式（三种）：**

- 使用全部数据问答：自动推导使用什么数据
- 使用指定数据问答：圈选指定知识或分类
- 使用指定场景问答：引用预配置的查询模板

**输出结构：**

```
data
  processData    # 过程数据
  sqlData        # 数据分析结果（如有）
  chart          # 图表（如有）
  chunks         # 召回的知识切片
  result         # 生成式问答结果
  hasAnswer      # 是否有答案（布尔）
```

### 13.4 API 可用性（官方文档确认）

- 需要 `tenant_access_token`（应用身份调用）
- 在发布配置中勾选"支持使用应用身份调用 API 和 SDK"即可，无需审批
- 自建应用可用，但需先在 Aily 平台创建知识库并配置数据源
- 数据源可以是飞书文档、Wiki、云盘文件等

### 13.5 对 Her 的意义

如果接入 Aily 知识问答，Her 可以：

- 直接接受用户自然语言提问（如"her之间的文件是怎么共享的"）
- 获得生成式回答 + 引用来源
- 不需要 Her 自己做关键词拆分和多轮搜索

**架构升级路径：**

- Aily 知识问答作为**主路径**（语义搜索 + RAG）
- 当前 `feishu_search`（关键词搜索）作为**fallback**
- 两者互补：Aily 处理自然语言，`feishu_search` 处理精确标题/token 查找

### 13.6 docker1 实验结果（2026-03-09）

#### 实验环境

- 飞书 Bot 应用 `cli_a92c99d102b8dbca`（自建应用，已有 OAuth、Drive/Wiki 搜索权限）
- `tenant_access_token`：正常获取
- `user_access_token`：已过期（oauth 刷新未做）

#### 实验结果

| 测试                               | 端点                                                       | 结果                    | 结论                                        |
| ---------------------------------- | ---------------------------------------------------------- | ----------------------- | ------------------------------------------- |
| data-knowledge/ask（5 种路径变体） | `POST /open-apis/aily/v1/data_knowledge/ask` 等            | **全部 404**            | 端点需要 Aily app_id，不是全局端点          |
| data-knowledge/ask（带 app_id）    | `POST /open-apis/aily/v1/apps/cli_xxx/data_knowledges/ask` | **404**                 | Feishu Bot `cli_` ID 不是 Aily app ID       |
| Aily apps 列表                     | `GET /open-apis/aily/v1/apps`                              | **99991672 权限不足**   | 需要 `aily:app:read` scope                  |
| Aily session 创建                  | `POST /open-apis/aily/v1/apps/cli_xxx/sessions`            | **99991663 token 无效** | Aily session API 不接受 Bot 的 tenant_token |
| aily.feishu.cn 域名                | 多条路径                                                   | **302 重定向到 Web UI** | 不是 API 域名                               |

#### 关键结论

1. **Aily API 基础设施确认存在**：`/aily/v1/apps` 返回 JSON 错误（不是 404），说明接口注册了
2. **我们的飞书 Bot 不是 Aily 应用**：`cli_` 开头的 app*id 是飞书开放平台应用，不是 Aily 应用（`spring*` 开头）
3. **data-knowledge/ask 需要 Aily 应用上下文**：没有有效的 Aily app_id，端点直接 404
4. **Session API 需要 Aily 级别的认证**：tenant_token 无法用于 Aily session 操作

#### 要使用 Aily 知识问答，需要以下步骤

1. 登录 Aily 智能伙伴创建平台（`apaas.feishu.cn/ai/projects`）
2. 创建一个新的 Aily 应用
3. 在 Aily 应用中配置知识数据源（关联 Wiki 空间、云盘文件等）
4. 在渠道管理 → 开放能力中勾选"支持使用应用身份调用 API 和 SDK"
5. 获取 Aily 应用 ID（`spring_xxx` 格式）
6. 将 Aily 应用关联到我们的飞书 Bot 应用（或用 Bot 的 tenant_token 调用）
7. 调用 `data-knowledge/ask` 或 session-based API

#### 待解决

- [ ] 在 Aily 平台创建应用并配置知识源
- [ ] 确认 Aily app_id 获取方式
- [ ] 确认 tenant_token 认证方式（需要 Aily 应用关联后测试）
- [ ] 评估知识源自动同步的延迟和覆盖范围
