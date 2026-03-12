---
name: feishu-doc
description: |
  Feishu document and structured content editing. Activate when user asks to read or edit a Feishu doc/docx, sync markdown into a doc, change blocks, insert content, delete a range, work with tables, sheets, or bitable fields/records. Triggers on 文档, docx, block, markdown 同步, insert_blocks, delete_range, sheet, spreadsheet, bitable, 多维表格.
metadata: { "openclaw": { "emoji": "📝" } }
---

# Feishu Doc Editing

Use this skill for content editing inside Feishu docs, wiki-backed docs, sheets, and bitable tables.

## Resolve the Right Token

- Doc URL `/docx/ABC123` -> `doc_token=ABC123`
- Wiki URL `/wiki/ABC123` -> call `feishu_wiki(action="get")`, then use the returned `obj_token` with `feishu_doc`
- Wiki `node_token` is not a doc token

## Document Read and Verify

- Use `feishu_doc(action="read")` for plain text and quick inspection.
- Use `feishu_doc(action="list_blocks")` when structure matters: tables, images, whiteboards, block order.
- Do not claim a table/doc write succeeded until you verify with `list_blocks`.
- For table-heavy verification, do not rely on plain `read`; it drops structure.

## Editing Priority

Default to the smallest safe edit. Do not jump to full rewrite.

1. `update_block` with `find` / `replace_with`
2. `update_block` with new `content`
3. `insert_blocks`
4. `delete_block` / `delete_range`
5. `append`
6. `write` only when the whole document should be replaced

Rule:

- If the user wants one section changed, do not default to `write`.
- If the user wants a full rewrite, `write` is fine.

## Sync Local Markdown

When syncing a local markdown file into Feishu:

1. Resolve the target token first
2. Prefer `source_file` for long content
3. Write or append
4. Verify with `list_blocks`
5. Report concrete checks such as heading order, table count, or empty cells

Use `source_file` for anything non-trivial. Avoid pasting long markdown into `content`.

## Create and Delete Boundaries

- `feishu_doc(action="create")` still requires an explicit visible `folder_token`
- Do not assume a default root folder
- Docs/Wiki/Bitable deletes are not generally available through this plugin; do not promise rollback after create

## Sheet Rules

- Always call `feishu_sheet(action="get_meta")` first and use the real `sheetId`
- Do not invent `Sheet1`, `0`, or guessed IDs
- `append` ranges must be column ranges such as `sheetId!A:A` or `sheetId!A:J`
- Use `feishu_sheet(action="get_share_url")` when you need a real accessible sheet link

## Bitable Rules

- Field keys must exactly match `field_name` from `feishu_bitable(action="list_fields")`
- Do not translate or rename field keys
- Text fields take strings
- SingleSelect fields take strings
- DateTime fields take unix milliseconds

## Output Rules

- State whether you changed one block, inserted a section, deleted a range, or rewrote the whole document
- If you verified with `list_blocks`, say so
- If you only inspected plain text, do not imply structure was verified

If you need block-type details or table limitations, read `references/block-types.md`.
