# 飞书卡片 Markdown 官方语法规范

> 来源：https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags?lang=zh-CN
> 最后更新于 2024-08-20（飞书官方页面标注）
> 本文档采集于 2026-03-13

⚠️ 官方页面注明：**此文档为旧版消息卡片文档**。新版参考"富文本（Markdown）"。
但我们使用的是旧版卡片结构（`elements: [{tag: "markdown", content: "..."}]`），因为新版 Schema 2.0 卡片在 `message.get` 中会降级为"请升级客户端"，不可用于 readback。

---

## 组件 JSON 结构

```json
{
  "tag": "markdown",
  "content": "支持的 Markdown 语法字符串",
  "text_align": "left"
}
```

参数：
| 参数 | 必须 | 类型 | 说明 |
|------|------|------|------|
| `tag` | 是 | String | 固定值：`markdown` |
| `content` | 是 | String | Markdown 内容，仅支持下方列出的语法子集 |
| `text_align` | 否 | String | 对齐方式：`left`（默认）、`center`、`right` |
| `href` | 否 | Object | 差异化跳转，PC/移动端不同链接 |

---

## 支持的语法（完整列表）

官方原文："目前只支持 markdown 语法的子集，详情参见下表。"

### 1. 换行

- 语法：`\n`
- 可用范围：Markdown 组件 + text 元素

### 2. 斜体

- 语法：`*斜体*`
- 可用范围：Markdown 组件 + text 元素

### 3. 加粗

- 语法：`**粗体**` 或 `__粗体__`
- 可用范围：Markdown 组件 + text 元素

### 4. 删除线

- 语法：`~~删除线~~`
- 可用范围：Markdown 组件 + text 元素

### 5. @指定人

- 语法：`<at id=open_id></at>` / `<at id=user_id></at>` / `<at email=test@email.com></at>`
- 可用范围：Markdown 组件 + text 元素
- ⚠️ **自定义机器人仅支持使用 `open_id`、`user_id` @指定人**

### 6. @所有人

- 语法：`<at id=all></at>`
- 可用范围：Markdown 组件 + text 元素
- ⚠️ 需要群主开启权限，否则卡片将发送失败

### 7. 超链接（HTML 格式）

- 语法：`<a href='https://open.feishu.cn'>text</a>`
- 可用范围：Markdown 组件 + text 元素
- ⚠️ 必须包含 schema（HTTP/HTTPS）

### 8. 彩色文本

- 语法：`<font color='green'>绿色文本</font>`
- 可用范围：Markdown 组件 + text 元素
- 支持颜色：`green`（绿）、`red`（红）、`grey`（灰）
- ⚠️ 不支持对链接着色

### 9. 文字链接（Markdown 格式）

- 语法：`[开放平台](https://open.feishu.cn)`
- 可用范围：Markdown 组件 + text 元素
- ⚠️ 必须包含 schema（HTTP/HTTPS）

### 10. 差异化跳转

- 通过 `href` 对象属性实现 PC/iOS/Android 不同跳转
- 可用范围：Markdown 组件 + text 元素

### 11. 图片

- 语法：`![hover_text](image_key)`
- 可用范围：**仅 Markdown 组件**（不支持 text 元素的 lark_md 模式）
- `image_key` 需通过上传图片接口获取
- `---` 需跟在换行符后，且与换行符间有 1 个空格

### 12. 分割线

- 语法：`\n ---\n`
- 可用范围：**仅 Markdown 组件**
- ⚠️ `---` 必须跟在换行符后使用，且与换行符之间有 1 个空格

### 13. 飞书表情

- 语法：`:Emoji Key:`
- 可用范围：Markdown 组件 + text 元素
- Emoji Key 列表参见飞书官方表情文案说明

### 14. 标签（text_tag）

- 语法：`<text_tag color='red'>标签内容</text_tag>`
- 可用范围：Markdown 组件 + text 元素
- 支持颜色：neutral, blue, turquoise, lime, orange, violet, indigo, wathet, green, yellow, red, purple, carmine

### 15. 有序列表

- 语法：`1. 有序列表1`，4 个空格缩进为子列表
- 可用范围：**仅 Markdown 组件**
- ⚠️ **仅在飞书 7.6 及以上版本生效**，低版本显示"升级提示占位图"

### 16. 无序列表

- 语法：`- 无序列表1`，4 个空格缩进为子列表
- 可用范围：**仅 Markdown 组件**
- ⚠️ **仅在飞书 7.6 及以上版本生效**，低版本显示"升级提示占位图"

### 17. 代码块

- 语法：` ```JSON\n{"code": "block"}\n``` `
- 可用范围：**仅 Markdown 组件**
- 支持指定编程语言解析，未指定默认为 Plain Text
- ⚠️ **仅在飞书 7.6 及以上版本生效**，低版本显示"升级提示占位图"

---

## ❌ 不支持的语法（官方列表中完全没有）

以下是标准 Markdown 语法，但飞书卡片 Markdown 组件**不支持**：

| 语法                 | 说明                            |
| -------------------- | ------------------------------- |
| `# 标题` / `## 标题` | 标题（heading）— 不支持         |
| `> 引用`             | 块引用（blockquote）— 不支持    |
| `` `行内代码` ``     | 行内代码（inline code）— 不支持 |
| `\| 表格 \| 列 \|`   | 表格（table）— 不支持           |
| `- [ ] 任务`         | 任务列表（task list）— 不支持   |

---

## 特殊字符转义

如果要展示的内容中包含 markdown 语法使用的特殊字符（如 `*`、`~`、`>`、`<`），需要对特殊字符进行 HTML 转义。
转义格式为 `&#实体编号;`。

| 特殊字符 | 转义符   | 描述       |
| -------- | -------- | ---------- |
| (空格)   | `&nbsp;` | 不换行空格 |
| (空格)   | `&ensp;` | 半角空格   |
| (空格)   | `&emsp;` | 全角空格   |
| `>`      | `&#62;`  | 大于号     |
| `<`      | `&#60;`  | 小于号     |
| `~`      | `&sim;`  | 飘号       |
| `-`      | `&#45;`  | 连字符     |
| `!`      | `&#33;`  | 惊叹号     |
| `*`      | `&#42;`  | 星号       |
| `/`      | `&#47;`  | 斜杠       |
| `\`      | `&#92;`  | 反斜杠     |
| `[`      | `&#91;`  | 中括号左   |
| `]`      | `&#93;`  | 中括号右   |
| `(`      | `&#40;`  | 小括号左   |
| `)`      | `&#41;`  | 小括号右   |
| `#`      | `&#35;`  | 井号       |
| `:`      | `&#58;`  | 冒号       |
| `+`      | `&#43;`  | 加号       |
| `"`      | `&#34;`  | 英文引号   |
| `'`      | `&#39;`  | 英文单引号 |
| `` ` ``  | `&#96;`  | 反单引号   |
| `$`      | `&#36;`  | 美金符号   |
| `_`      | `&#95;`  | 下划线     |

---

## 对 Her 代码的影响

基于以上 100% 确定的官方文档，`normalizeFeishuCardMarkdown` 需要做以下调整：

1. **标题（`#`）→ 不支持** → 需转换为 `**加粗**`（模拟标题视觉效果）
2. **表格（`| ... |`）→ 不支持** → 需转换为加粗表头 + 无序列表形式
3. **引用（`>`）→ 不支持** → `>` 是特殊字符，单独使用会被吞掉；需转换为其他可视形式
4. **行内代码（`` ` ``）→ 不支持** → 反引号是特殊字符 `&#96;`，需评估是否转义或保留
5. **代码块（` ``` `）→ 支持**（飞书 7.6+）→ 保留原样
6. **加粗/斜体/删除线/链接/列表 → 支持** → 直接透传

---

## 新版文档（富文本 Markdown）

> 来源：https://open.feishu.cn/document/feishu-cards/card-components/content-components/rich-text
> 最后更新于 2025-04-08

新版文档与旧版的核心区别：

### JSON 1.0 vs JSON 2.0 的关键差异

| 特性                  | JSON 1.0（我们在用的） | JSON 2.0               |
| --------------------- | ---------------------- | ---------------------- |
| 标题 `# heading`      | ❌ 不支持              | ✅ 支持（ATX heading） |
| 引用 `> quote`        | ❌ 不支持              | ✅ 支持                |
| 行内引用              | ❌ 不支持              | ✅ 支持                |
| 表格 `\| ... \|`      | ❌ 不支持              | ✅ 支持                |
| 数字角标              | ❌ 不支持              | ✅ 支持                |
| 行内代码 `` `code` `` | ❌ 不支持              | ❓ 未明确说明          |
| SetextHeading         | N/A                    | ❌ 不支持              |
| CodeBlock ` ``` `     | ✅ 支持（飞书7.6+）    | ❌ 不支持（JSON 2.0）  |
| HTMLBlock             | N/A                    | ❌ 不支持              |

官方原文：

> - "卡片 JSON 1.0 结构仅支持 Markdown 语法的子集，详情参见下表。"
> - "卡片 JSON 2.0 结构支持除 `SetextHeading`、`CodeBlock` 和 `HTMLBlock` 外所有标准的 Markdown 语法，以及部分 HTML 语法。"
> - "富文本组件中的**标题、引用、行内引用、表格、数字角标**等语法仅支持在 JSON 2.0 结构的富文本组件中使用。"

### 为什么我们不能用 JSON 2.0

JSON 2.0 使用 `schema: "2.0"` 卡片结构。经过实际测试（2026-03 实验），JSON 2.0 卡片在 `message.get` API 回读时会降级为"请升级客户端查看此消息"，完全无法用于聊天历史回读。因此我们**必须使用 JSON 1.0**。

### JSON 1.0 新版文档确认的完整支持语法

与旧版文档基本一致，新增以下：

- **换行**：新版推荐 `<br />` 或 `<br>`（JSON 构建时也可用 `\n`）
- **可点击的电话号码**：`[文案](tel://电话号码)` — 仅移动端生效
- **含图标的链接**：`<link icon='chat_outlined' url='https://...' />` — 飞书 7.12+
- **人员**：`<person id='user_id' show_name=true show_avatar=true style='capsule' />`
- **彩色文本**：新版支持 RGBA 自定义颜色

### 新版字段：`text_size`

新版文档增加了 `text_size` 字段：

- `heading-0`: 特大标题 (30px)
- `heading-1`: 一级标题 (24px)
- `heading-2`: 二级标题 (20px)
- `heading-3`: 三级标题 (18px)
- `heading-4`: 四级标题 (16px)
- `heading`: 标题 (16px)
- `normal`: 正文 (14px) — 默认
- `notation`: 辅助信息 (12px)
- `xxxx-large` ~ `x-small`: 30px ~ 10px

**注意**：`text_size` 是整个 markdown 组件的字号，不是 markdown 语法中的 `#` heading。它控制的是整个组件里所有文本的基础大小。

---

## 最终结论：Her 代码的转换策略

基于 100% 确定的飞书官方文档，在 JSON 1.0 结构下：

### 必须转换的语法

| 标准 Markdown    | 飞书不支持 | 转换策略                                                           |
| ---------------- | ---------- | ------------------------------------------------------------------ |
| `# 标题`         | ❌         | → `**标题**`（加粗模拟）                                           |
| `## 二级标题`    | ❌         | → `**二级标题**`（加粗模拟）                                       |
| `> 引用`         | ❌         | → `｜引用内容`（全角竖线前缀）或直接去掉 `>`                       |
| `` `行内代码` `` | ❌         | → 保留反引号原样显示（用户可识别）                                 |
| `\| 表格 \|`     | ❌         | → 方案 A：独立表格组件（见下方）；方案 B：加粗表头 + 列表 fallback |

### 直接透传的语法

| 语法                     | 说明                     |
| ------------------------ | ------------------------ |
| `**粗体**`               | ✅ 原样透传              |
| `*斜体*`                 | ✅ 原样透传              |
| `~~删除线~~`             | ✅ 原样透传              |
| `[链接](url)`            | ✅ 原样透传              |
| `- 列表项` / `1. 列表项` | ✅ 原样透传（飞书 7.6+） |
| ` ```代码块``` `         | ✅ 原样透传（飞书 7.6+） |
| `<at id=open_id></at>`   | ✅ 原样透传              |
| `<font color>`           | ✅ 原样透传              |
| `![img](key)`            | ✅ 原样透传              |
| `\n ---\n`               | ✅ 原样透传              |

---

## 独立表格组件（`tag: "table"`）

> 来源：https://open.feishu.cn/document/feishu-cards/card-components/content-components/table
> 最后更新于 2025-01-02

飞书提供了独立的表格组件，这是**真正的表格渲染**，不是 markdown 语法。

### 关键约束

- 需要飞书客户端 **V7.4+**（低版本显示"请升级客户端"）
- **只能放在卡片根节点 `elements` 数组下**，不能嵌套在其他组件内
- 表格组件不支持内嵌其它组件
- 单张卡片最多 5 个表格组件

### JSON 结构示例

```json
{
  "tag": "table",
  "page_size": 5,
  "row_height": "low",
  "header_style": {
    "text_align": "left",
    "text_size": "normal",
    "background_style": "none",
    "text_color": "grey",
    "bold": true,
    "lines": 1
  },
  "columns": [
    {
      "name": "col1",
      "display_name": "列名1",
      "data_type": "text",
      "width": "auto"
    },
    {
      "name": "col2",
      "display_name": "列名2",
      "data_type": "text"
    }
  ],
  "rows": [
    { "col1": "值1", "col2": "值2" },
    { "col1": "值3", "col2": "值4" }
  ]
}
```

### 列数据类型

- `text`: 普通文本
- `lark_md`: 支持 lark_md 格式
- `number`: 数字（支持 format.symbol, format.precision, format.separator）
- `options`: 选项标签
- `persons`: 人员列表
- `date`: 日期（支持 date_format）
- `markdown`: Markdown 文本

### 对 Her 的适用性分析

**方案 A — 独立表格组件（复杂但视觉最佳）**：

- 需要在 AI 输出中检测 markdown 表格
- 将表格提取为独立的 `{tag: "table"}` 元素
- 表格前后的文本分别放在各自的 `{tag: "markdown"}` 元素中
- 卡片 `elements` 数组变为：`[markdown_before, table, markdown_after]`
- ⚠️ 问题：streaming 过程中 `im.message.patch` 需要替换整个 `elements` 数组，表格可能在流的中间出现
- ⚠️ 问题：增加了卡片 JSON 的复杂度

**方案 B — 加粗表头 + 列表 fallback（简单但视觉一般）**：

- 在 markdown 组件内将 `| col1 | col2 |` 转换为 `**col1** | **col2**` + `- val1 | val2`
- 不需要改变卡片结构
- 对 streaming 无影响
- 视觉效果不如真实表格，但能传达信息

**当前选择：方案 B**（优先保证 streaming 稳定性，后续可升级到方案 A）
