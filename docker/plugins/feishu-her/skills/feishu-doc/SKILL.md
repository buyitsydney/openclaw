---
name: feishu-doc
description: |
  飞书文档和结构化内容编辑。当用户要求读取或编辑飞书 doc/docx、将 markdown 同步到文档、操作 block、插入/删除内容、操作表格/Sheet/Bitable 字段和记录时使用。
metadata: { "openclaw": { "emoji": "📝" } }
---

# 飞书文档编辑

用于飞书文档、Wiki 页面内容、Sheet、Bitable 的内容编辑。

## 解析正确的 Token

- 文档 URL `/docx/ABC123` -> `doc_token=ABC123`
- Wiki URL `/wiki/ABC123` -> 先调用 `feishu_wiki(action="get")`，再用返回的 `obj_token` 操作 `feishu_doc`
- Wiki 的 `node_token` 不是 doc token

## 文档读取和验证

- 用 `feishu_doc(action="read")` 做纯文本快速检查
- 用 `feishu_doc(action="list_blocks")` 查看结构：表格、图片、白板、block 顺序
- 不得在未用 `list_blocks` 验证前声称表格/文档写入已成功
- 涉及表格的验证不要依赖纯 `read`，它会丢结构

## 编辑优先级

默认用最小安全编辑，不要跳到全量重写：

1. `update_block` 带 `find` / `replace_with`
2. `update_block` 带新 `content`
3. `insert_blocks`
4. `delete_block` / `delete_range`
5. `append`
6. `write` 仅当需要替换整个文档时

规则：

- 用户只改一段时不要默认用 `write`
- 用户要全量重写时 `write` 可以

## 同步本地 Markdown

将本地 markdown 文件同步到飞书时：

1. 先解析目标 token
2. 长内容优先用 `source_file`
3. 写入或追加
4. 用 `list_blocks` 验证
5. 报告具体检查项：标题顺序、表格数量、空单元格等

非短文本一律用 `source_file`，不要把大段 markdown 贴进 `content`。

## 创建和删除边界

- `feishu_doc(action="create")` 仍需要明确可见的 `folder_token`
- 不要假设有默认根文件夹
- 文档/Wiki/Bitable 的删除在此插件中通常不可用，不要在创建后承诺回滚

## Sheet 规则

- 必须先调用 `feishu_sheet(action="get_meta")` 获取真实 `sheetId`
- 不要编造 `Sheet1`、`0` 或猜测的 ID
- `append` 范围必须是列范围，如 `sheetId!A:A` 或 `sheetId!A:J`
- 需要真实可访问的 Sheet 链接时用 `feishu_sheet(action="get_share_url")`

## Bitable 规则

- 字段 key 必须与 `feishu_bitable(action="list_fields")` 返回的 `field_name` 完全一致
- 不得翻译或重命名字段 key
- Text 字段传字符串
- SingleSelect 字段传字符串
- DateTime 字段传 unix 毫秒

## 输出规则

- 说明你是改了一个 block、插入了一段、删除了一个范围、还是重写了整个文档
- 如果用 `list_blocks` 做了验证，说明这一点
- 如果只检查了纯文本，不要暗示结构已被验证

如需 block 类型详情或表格限制，读 `references/block-types.md`。
